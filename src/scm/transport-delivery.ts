/**
 * Worker-side transport-backed {@link ScmDeliveryProvider} (ADR-002 §2). A
 * federated worker (one that does not hold the per-project reviewer PAT) uses
 * this provider so the two metadata-only SCM delivery calls — `submitReview`,
 * `postComment` — travel up the transport to the control-plane delivery API
 * (`../router/worker-delivery.ts`), which performs the GitHub write under the
 * reviewer PAT. Only metadata (a verdict + a comment body + the PR number)
 * crosses the wire; the repository tree never does (ai/RULES.md §1).
 *
 * Everything that carries source or must be attributed to the operator's own
 * GitHub account — `commitIdentity`, `findPullRequest`, `createPullRequest`,
 * `pushBranch` — delegates verbatim to a `localDelegate` (the worker's own
 * in-process provider, built from the operator's token). That keeps
 * respond-to-review working: it still commits and pushes locally with the
 * operator's identity, and only the PR comment rides the transport.
 *
 * A non-2xx or unparseable response **throws**, so the phase's existing
 * `DeliveryDeferredError` retry path (`../pipeline/review.ts`,
 * `../pipeline/respond-to-review.ts`) preserves the worktree and retries. The
 * server-side writes are marker-idempotent, so a retried transport call cannot
 * double-post a review or comment.
 */

import {
	PostCommentDeliveryResponseSchema,
	SubmitReviewDeliveryResponseSchema,
	TRANSPORT_PROTOCOL_VERSION,
} from '../transport/protocol.js';
import type { ScmDeliveryProvider } from './delivery.js';

/** The `fetch` surface this module uses — injectable so tests drive it without a network. */
export type FetchLike = (
	input: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
	},
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface TransportScmDeliveryOptions {
	/** Base URL of the control-plane delivery API, e.g. `https://swarm.example`. */
	controlPlaneUrl: string;
	/** Raw registered-worker credential (sent as `Authorization: Bearer`). */
	workerCredential: string;
	/** The project id, sent so the server resolves the right reviewer PAT + enrollment. */
	projectId: string;
	/** The worker's in-process provider, handling every source-carrying / attribution op. */
	localDelegate: ScmDeliveryProvider;
	/** Override `fetch` in tests; defaults to the global. */
	fetchImpl?: FetchLike;
}

/** Join the control-plane base URL with a delivery path, tolerating a trailing slash. */
function deliveryUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * POST a delivery request to the control plane and return the parsed response
 * body. Throws on a non-2xx status or a body that does not match `schema`, so
 * the caller's deferral/retry path can preserve the worktree and retry against
 * the idempotent server write.
 */
async function postDelivery<T>(
	options: TransportScmDeliveryOptions,
	path: string,
	body: Record<string, unknown>,
	parse: (value: unknown) => T,
): Promise<T> {
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
	const response = await fetchImpl(deliveryUrl(options.controlPlaneUrl, path), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${options.workerCredential}`,
		},
		body: JSON.stringify({ ...body, protocolVersion: TRANSPORT_PROTOCOL_VERSION }),
	});
	if (!response.ok)
		throw new Error(`Control-plane delivery ${path} failed with status ${response.status}`);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(
			`Control-plane delivery ${path} returned an unparseable response: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return parse(payload);
}

/**
 * Build a transport-backed delivery provider. Metadata ops POST to the control
 * plane; every source-carrying / attribution op delegates to `localDelegate`.
 */
export function createTransportScmDeliveryProvider(
	options: TransportScmDeliveryOptions,
): ScmDeliveryProvider {
	const { localDelegate } = options;
	return {
		commitIdentity: localDelegate.commitIdentity,
		findPullRequest: (branch) => localDelegate.findPullRequest(branch),
		createPullRequest: (input) => localDelegate.createPullRequest(input),
		pushBranch: (cwd, branch, expectedSha) => localDelegate.pushBranch(cwd, branch, expectedSha),
		submitReview: (input) =>
			postDelivery(
				options,
				'/worker/delivery/review',
				{
					projectId: options.projectId,
					prNumber: input.prNumber,
					verdict: input.verdict,
					body: input.body,
					deliveryId: input.deliveryId,
				},
				(value) => SubmitReviewDeliveryResponseSchema.parse(value).reviewId,
			),
		postComment: (input) =>
			postDelivery(
				options,
				'/worker/delivery/pr-comment',
				{
					projectId: options.projectId,
					prNumber: input.prNumber,
					body: input.body,
					deliveryId: input.deliveryId,
				},
				(value) => PostCommentDeliveryResponseSchema.parse(value).commentId,
			),
	};
}
