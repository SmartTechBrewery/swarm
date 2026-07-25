/**
 * Worker-side transport-backed {@link ScheduleFollowUpReview} (ADR-003 §2) — the
 * queueing half of the DB-free Respond-to-review phase, sibling to the
 * review-verdict ledger client (`./review-ledger-delivery.ts`).
 *
 * A `fixed` response owes the commit it just pushed exactly one follow-up Review
 * (issue #241), and the default scheduler
 * (`../pipeline/follow-up-review.ts`) delivers it by writing a dispatch row and
 * enqueueing a synthetic `check_suite` job — a `DATABASE_URL` and a `REDIS_URL` a
 * federated worker does not have. Skipping it is not an option: the fix would sit
 * on the PR unreviewed until a human noticed. So the call travels up the transport
 * to the control plane, which owns both (`../router/worker-delivery.ts`), and only
 * the PR coordinates cross the wire — never the repository tree (ai/RULES.md §1).
 *
 * Unlike the metadata-delivery clients, no credential is involved here: what stays
 * server-side is the dispatch store and the queue. `project` is resolved
 * server-side from the **authenticated** enrollment, so the `projectId` this client
 * sends is an authorization input rather than a target the worker gets to choose,
 * and the `project` the phase passes is deliberately not sent at all.
 *
 * A non-2xx or unparseable response **throws**, exactly as a failed enqueue would,
 * so the phase's existing handling applies unchanged: the throw happens before the
 * `followUpEnqueued` checkpoint is written, surfaces as a `DeliveryDeferredError`,
 * and the resumed retry re-schedules. The scheduler's dispatch identity is a
 * deterministic hash of (project, PR, new head), so that retry cannot duplicate
 * the follow-up.
 */

import type { ScheduleFollowUpReview } from '../pipeline/follow-up-review.js';
import { type DeliveryClientOptions, postDelivery } from './delivery-client.js';
import { FollowUpReviewDeliveryResponseSchema } from './protocol.js';

export interface TransportFollowUpReviewOptions extends DeliveryClientOptions {
	/** The project id, sent so the server authorizes this worker and scopes the dispatch. */
	projectId: string;
}

/**
 * Build a transport-backed follow-up-Review scheduler. POSTs to the control
 * plane's `/worker/delivery/follow-up-review` route, which performs the same
 * `scheduleFollowUpReviewDefault` enqueue the local host worker runs in-process.
 */
export function createTransportFollowUpReviewScheduler(
	options: TransportFollowUpReviewOptions,
): ScheduleFollowUpReview {
	// `project` is intentionally unused: the server derives it from the
	// authenticated enrollment, so a worker cannot schedule into another project.
	return ({ prNumber, prBranch, headSha }) =>
		postDelivery(
			options,
			'/worker/delivery/follow-up-review',
			{ projectId: options.projectId, prNumber, prBranch, headSha },
			(value) => {
				FollowUpReviewDeliveryResponseSchema.parse(value);
			},
		);
}
