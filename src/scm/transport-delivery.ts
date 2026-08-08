/**
 * Worker-side transport-backed {@link ScmDeliveryProvider} (ADR-004 §2). A worker
 * does not hold the per-project reviewer PAT, so the two metadata-only SCM
 * delivery calls — `submitReview`, `postComment` — travel up the transport to the
 * control-plane delivery API (`../router/worker-delivery.ts`), which performs the
 * GitHub write under the persona this composite names: the per-project reviewer
 * PAT for a Review's verdict and comment, the implementer for a Respond-to-review
 * reply. Only metadata (a verdict + a comment body + the PR number) crosses the
 * wire; the repository tree never does (ai/RULES.md §1). The wire mechanics — URL
 * join, bearer header, protocol stamp, error contract — live in the shared client
 * (`../transport/delivery-client.ts`).
 *
 * **This one stayed a composite when its PM counterpart stopped being one**
 * (issue #553 deleted `createTransportPmDeliveryProvider`), and the reason is the
 * credential split rather than which worker is running. `localDelegate` here is
 * the **operator-credential** provider — `SCMProvider.operatorDeliveryProvider`,
 * built from the worker operator's own token (ADR-003 §2) — not an in-process,
 * DB-backed one. Everything that carries source or must be attributed to that
 * account (`commitIdentity`, `findPullRequest`, `createPullRequest`,
 * `pushBranch`) has to run where the checkout is, under a token the control plane
 * never sees; everything the *project's* reviewer/implementer persona must sign
 * for has to run where that credential is. The pair is what expresses that split,
 * so it survives having exactly one caller
 * (`../transport/assignment-execution.ts`). The PM side had no such split — a
 * board write has no local half at all — so its delegate was only ever the
 * DB-holding worker's in-process provider, and it retired with that worker.
 *
 * A non-2xx or unparseable response **throws**, so the phase's existing
 * `DeliveryDeferredError` retry path (`../pipeline/review.ts`,
 * `../pipeline/respond-to-review.ts`) preserves the worktree and retries. The
 * server-side writes are marker-idempotent, so a retried transport call cannot
 * double-post a review or comment.
 */

import { type DeliveryClientOptions, postDelivery } from '../transport/delivery-client.js';
import {
	type DeliveryPersona,
	PostCommentDeliveryResponseSchema,
	SubmitReviewDeliveryResponseSchema,
} from '../transport/protocol.js';
import type { ScmDeliveryProvider } from './delivery.js';

export type { FetchLike } from '../transport/delivery-client.js';

export interface TransportScmDeliveryOptions extends DeliveryClientOptions {
	/** The project id, sent so the server resolves the right reviewer PAT + enrollment. */
	projectId: string;
	/**
	 * Which persona the control plane authors this composite's PR comment as — the
	 * same persona its `localDelegate` was built for, so a Respond-to-review reply
	 * is the implementer's rather than the reviewer answering itself (issue #444).
	 * Required, not defaulted, so every construction site states the identity its
	 * phase runs under instead of leaving the server to infer one.
	 */
	persona: DeliveryPersona;
	/**
	 * The worker's operator-credential provider, handling every source-carrying /
	 * attribution op under the operator's own account.
	 */
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
		// No persona on the review frame: only the Review phase submits a review,
		// and it is always the reviewer's.
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
					persona: options.persona,
				},
				(value) => PostCommentDeliveryResponseSchema.parse(value).commentId,
			),
	};
}
