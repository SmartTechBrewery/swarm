/**
 * Worker-side transport-backed {@link ScmDeliveryProvider} (ADR-002 §2). A
 * federated worker (one that does not hold the per-project reviewer PAT) uses
 * this provider so the two metadata-only SCM delivery calls — `submitReview`,
 * `postComment` — travel up the transport to the control-plane delivery API
 * (`../router/worker-delivery.ts`), which performs the GitHub write under the
 * reviewer PAT. Only metadata (a verdict + a comment body + the PR number)
 * crosses the wire; the repository tree never does (ai/RULES.md §1). The wire
 * mechanics — URL join, bearer header, protocol stamp, error contract — live in
 * the shared client (`../transport/delivery-client.ts`).
 *
 * Everything that carries source or must be attributed to the operator's own
 * GitHub account — `commitIdentity`, `findPullRequest`, `createPullRequest`,
 * `pushBranch` — delegates verbatim to a `localDelegate` (the worker's own
 * in-process provider, built from the operator's token). That keeps
 * respond-to-review working: it still commits and pushes locally with the
 * operator's identity, and only the PR comment rides the transport. A DB-free
 * remote worker composes the same way, passing the operator-token delivery
 * provider it already built as the delegate
 * (`../transport/assignment-execution.ts`).
 *
 * A non-2xx or unparseable response **throws**, so the phase's existing
 * `DeliveryDeferredError` retry path (`../pipeline/review.ts`,
 * `../pipeline/respond-to-review.ts`) preserves the worktree and retries. The
 * server-side writes are marker-idempotent, so a retried transport call cannot
 * double-post a review or comment.
 */

import { type DeliveryClientOptions, postDelivery } from '../transport/delivery-client.js';
import {
	PostCommentDeliveryResponseSchema,
	SubmitReviewDeliveryResponseSchema,
} from '../transport/protocol.js';
import type { ScmDeliveryProvider } from './delivery.js';

export type { FetchLike } from '../transport/delivery-client.js';

export interface TransportScmDeliveryOptions extends DeliveryClientOptions {
	/** The project id, sent so the server resolves the right reviewer PAT + enrollment. */
	projectId: string;
	/** The worker's in-process provider, handling every source-carrying / attribution op. */
	localDelegate: ScmDeliveryProvider;
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
