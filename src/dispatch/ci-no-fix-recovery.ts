/**
 * `no-fix` recovery — the hand-back from a Respond-to-CI run that concluded the
 * red check is not the pull request's fault to exactly one Review run on the
 * same head (issue #841).
 *
 * Before this existed, `no-fix` was a dead end. The phase pushes nothing, so no
 * new `check_suite` event is ever produced, and the `pr-review` trigger only
 * re-enters on a `checks` event whose aggregate state is green — so the pull
 * request sat in **In review** indefinitely (observed live on
 * `SmartTechBrewery/rover` PR #92, unblocked only by a manual empty commit).
 *
 * {@link scheduleCiNoFixRecovery} enqueues one synthetic `checks`/`completed`
 * {@link ScmEvent} for the same (project, PR, head SHA), exactly as
 * `src/pipeline/follow-up-review.ts` does for a `fixed` Respond-to-review, so it
 * re-enters the *same* `pr-review` handler a real completed check suite would.
 * The one difference is the `ciNoFixRecovery: true` marker on the job payload:
 * the aggregate check state for that head is still red (nothing re-ran it), and
 * the marker is what tells the handler that this particular red was already
 * adjudicated by SWARM's own CI agent, so it dispatches Review instead of
 * routing back to Respond-to-CI — and that it already owns the PR+SHA dispatch
 * claim this module hands over to it (see {@link scheduleCiNoFixRecovery}).
 * Every other gate — closed-PR, work-item origin, draft/fork,
 * mergeability/conflicts, the `state-pending` defer, the durable review-verdict
 * reservation — still applies unchanged; apart from that one claim, this module
 * only ever constructs the trigger *input*.
 *
 * It lives under `src/dispatch/` rather than beside the follow-up Review because
 * it is scheduled at the composition root (`src/worker/consumer.ts`'s
 * `phase-succeeded` settle) rather than by a phase, which is where queue work
 * belongs (ai/RULES.md §2) — the same reason `force-re-review.ts` lives here.
 *
 * **Bounded by construction**, so a check that stays red cannot spin:
 *  - one recovery per (project, PR, head SHA) — the deterministic dedup key
 *    below, which the dispatch layer treats as "already recorded" on a conflict
 *    (issue #284), no matter how often the enqueue is retried;
 *  - one Review per head — the PR+SHA dispatch claim this recovery *keeps* (see
 *    {@link scheduleCiNoFixRecovery}) plus the durable review-verdict ledger
 *    reservation the handler still takes;
 *  - if that Review requests changes, Respond-to-review pushes a new head → a
 *    fresh `checks` event → still red → Respond-to-CI, which spends one of the
 *    per-PR `MAX_FIX_ATTEMPTS` (`src/triggers/respond-to-ci-attempts.ts`). At the
 *    cap the cycle stops and the durable give-up run plus pull-request comment
 *    (issue #838) are what an operator finds.
 */

import type { ProjectConfig } from '../config/schema.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { deliveryIdentity } from '../scm/delivery.js';
import type { ScmEvent } from '../scm/events.js';
import {
	buildReviewDispatchKey,
	refreshReviewDispatchClaim,
} from '../triggers/review-dispatch-dedup.js';
import { createAndPublishDispatch, deliveryDedupKey } from './dispatcher.js';

/**
 * TTL the PR+SHA dispatch claim is re-established for while a recovery is in
 * flight — long enough to outlast the `pr-review` handler's own `state-pending`
 * recheck chain (`MAX_CHECK_RECHECKS` × `RECHECK_DELAY_MS` = 20 × 30s,
 * `src/triggers/handlers/review.ts`) plus margin, so a recovery that has to wait
 * out a lagging checks or mergeability read still holds the slot when it finally
 * decides. Sized here rather than imported from the handler to keep this
 * composition-root module off that module's graph.
 */
const RECOVERY_CLAIM_TTL_SEC = 12 * 60;

export interface CiNoFixRecoveryInput {
	project: ProjectConfig;
	/** The pull request whose red check the CI agent declined to fix. */
	prNumber: string;
	/** The PR's head branch — carried so the re-entered handler has the same data a real webhook would. */
	prBranch: string;
	/** The head commit the adjudicated checks ran against. */
	headSha: string;
}

/**
 * Deterministic dispatch identity for a `no-fix` recovery — one per
 * (project, PR, head SHA), so retrying this enqueue can never duplicate the
 * dispatch. Its own `respond-to-ci-no-fix` prefix keeps it from ever colliding
 * with a follow-up Review (`followUpReviewDeliveryId`) for the same head.
 * Exported for tests that assert dedup across repeated calls.
 */
export function ciNoFixRecoveryDeliveryId(
	project: ProjectConfig,
	prNumber: string,
	headSha: string,
): string {
	return deliveryIdentity(['respond-to-ci-no-fix', project.repo, prNumber, headSha]);
}

/**
 * Enqueue the single recovery dispatch for one `no-fix` run. See the module
 * header for why it is bounded.
 *
 * The PR+SHA review-dispatch claim is **handed over, not handed back**. The
 * Respond-to-CI dispatch that just finished took that claim, and the recovery
 * needs the slot itself — but *releasing* it would open a window in which any
 * other completed-check event for this same head could take it instead. That is
 * a real event, not a theoretical one: the aggregate decision waits for every
 * suite to complete (`aggregate-check-decision.ts`), so a PR with two CI suites
 * can have one suite's webhook decide the aggregate while the other's is still
 * in flight — and a delayed sibling arriving on a freed slot carries no
 * `ciNoFixRecovery` marker, so it would route the already-adjudicated red back
 * to Respond-to-CI, spend a second fix attempt, and leave this recovery to fail
 * its own claim and settle `no-trigger`. Its deterministic delivery id then
 * absorbs the second run's recovery as an already-recorded repeat, and the
 * promised Review never happens — the exact dead end this module exists to
 * remove.
 *
 * So the claim is **refreshed** ({@link refreshReviewDispatchClaim}, the same
 * hold the pending-continuation path uses — `retainContinuationDispatchClaim`,
 * `src/worker/consumer.ts`) rather than deleted: it stays held across the
 * enqueue, no ordinary event can take it, and the synthetic job's own
 * `ciNoFixRecovery` marker is what tells `pr-review` to *reuse* the held claim
 * instead of re-claiming and dropping itself as a duplicate. Refreshing (a plain
 * `SET … EX`, no `NX`) also re-establishes the claim if the CI-fix run outlived
 * its original five-minute TTL, which a long agent run readily does.
 */
export async function scheduleCiNoFixRecovery({
	project,
	prNumber,
	prBranch,
	headSha,
}: CiNoFixRecoveryInput): Promise<void> {
	await refreshReviewDispatchClaim(
		buildReviewDispatchKey(project.repo, prNumber, headSha),
		RECOVERY_CLAIM_TTL_SEC,
	);

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
	const deliveryId = ciNoFixRecoveryDeliveryId(project, prNumber, headSha);
	await createAndPublishDispatch({
		projectId: project.id,
		jobPayload: {
			type: 'scm',
			providerId: provider.type,
			projectId: project.id,
			deliveryId,
			ciNoFixRecovery: true,
			event,
		},
		dedupKey: deliveryDedupKey(deliveryId),
		source: 'synthetic',
	});
}
