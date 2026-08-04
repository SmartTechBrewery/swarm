/**
 * Follow-up Review scheduling — the reliable hand-off from a `fixed`
 * Respond-to-review response to exactly one Review run on the newly pushed
 * commit (issue #241). Injected into `runRespondToReviewPhase`
 * (`src/pipeline/respond-to-review.ts`) as a typed operation with a real
 * GitHub/queue-backed default, overridden in tests.
 *
 * The default builds a synthetic `checks`-kind {@link ScmEvent} for the new head
 * SHA and enqueues it exactly like a real webhook
 * (`src/queue/producer.ts`'s `enqueueJob`), so it re-enters the *same*
 * `pr-review` trigger handler (`src/triggers/handlers/review.ts`) a real
 * completed check suite would: the aggregate-check decision (review / respond-
 * to-ci / bounded recheck), the work-item origin gate, the PR+SHA dispatch dedup,
 * and the durable review-verdict ledger reservation all apply unchanged — this
 * module only ever constructs the trigger *input*, never touches those
 * decisions itself.
 *
 * The dispatch dedup key is a deterministic hash of (project, PR, new head
 * SHA), not a random id — the dispatch layer treats a dedup-key conflict as
 * "already recorded" (issue #284), so a queueing crash-and-retry (this call
 * fails and `runRespondToReviewPhase` reraises it as a `DeliveryDeferredError`,
 * or a worker restart mid-delivery) re-issues the identical identity instead
 * of a second dispatch.
 */

import type { ProjectConfig } from '@/config/schema.js';
import { createAndPublishDispatch, deliveryDedupKey } from '@/dispatch/dispatcher.js';
import { requireProjectSCMProvider } from '@/integrations/scm/registry.js';
import { deliveryIdentity } from '@/scm/delivery.js';
import type { ScmEvent } from '@/scm/events.js';

export interface FollowUpReviewInput {
	project: ProjectConfig;
	/** The PR the fixed response pushed to. */
	prNumber: string;
	/** The PR's head branch — carried so a routed Respond-to-CI has a branch to check out. */
	prBranch: string;
	/** The newly pushed commit SHA the follow-up Review must cover. */
	headSha: string;
}

/** Signature of the follow-up-scheduling operation `runRespondToReviewPhase` injects (overridden in tests). */
export type ScheduleFollowUpReview = (input: FollowUpReviewInput) => Promise<void>;

/**
 * Deterministic dispatch identity for a follow-up Review — one per
 * (project, PR, new head SHA), so retrying this enqueue (a transient blip, a
 * worker restart before the delivery checkpoint is written) can never
 * duplicate the dispatch. Exported for tests that assert dedup across repeated
 * calls.
 */
export function followUpReviewDeliveryId(
	project: ProjectConfig,
	prNumber: string,
	headSha: string,
): string {
	return deliveryIdentity(['respond-to-review-followup', project.repo, prNumber, headSha]);
}

/**
 * Production default — enqueues a synthetic `checks` `completed` event for the new
 * head SHA, carrying the same PR number/branch/repo data a real webhook would.
 * `getAggregateCheckStatus` (called inside the `pr-review` handler) queries live
 * provider state for this SHA, so a synthetic dispatch behaves identically to a
 * real one whether or not the new commit's checks have finished yet — an
 * incomplete suite defers to the handler's own bounded recheck rather than
 * anything special-cased here.
 *
 * `providerId` is resolved via {@link requireProjectSCMProvider} from the project's
 * registered runtime-ready SCM provider.
 */
export const scheduleFollowUpReviewDefault: ScheduleFollowUpReview = async ({
	project,
	prNumber,
	prBranch,
	headSha,
}) => {
	const provider = requireProjectSCMProvider(project);
	const event: ScmEvent = {
		kind: 'checks',
		action: 'completed',
		repoFullName: project.repo,
		workItemId: prNumber,
		isCommentEvent: false,
		headSha,
		prBranch,
	};
	const deliveryId = followUpReviewDeliveryId(project, prNumber, headSha);
	await createAndPublishDispatch({
		projectId: project.id,
		jobPayload: {
			type: 'scm',
			providerId: provider.type,
			projectId: project.id,
			deliveryId,
			event,
		},
		dedupKey: deliveryDedupKey(deliveryId),
		source: 'synthetic',
	});
};
