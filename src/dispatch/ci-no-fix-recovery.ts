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
 * routing back to Respond-to-CI. Every other gate — closed-PR, work-item origin,
 * draft/fork, mergeability/conflicts, the PR+SHA dispatch dedup, the durable
 * review-verdict reservation — still applies unchanged; this module only ever
 * constructs the trigger *input*.
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
 *  - one Review per head — the PR+SHA dispatch dedup plus the durable
 *    review-verdict ledger reservation the handler still takes;
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
	releaseReviewDispatch,
} from '../triggers/review-dispatch-dedup.js';
import { createAndPublishDispatch, deliveryDedupKey } from './dispatcher.js';

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
 * The PR+SHA review-dispatch claim is released **first**. The Respond-to-CI
 * dispatch that just finished took that claim under a five-minute TTL and a
 * CI-fix run typically finishes well inside it, so the recovery would otherwise
 * be dropped by the handler's own dedup as a duplicate. Releasing is exactly the
 * documented "abandoned before any review was submitted" case — a `no-fix` run
 * posts an explanatory comment, never a formal review, so no review exists for
 * this head to duplicate — and `src/worker/consumer.ts` already releases this
 * same key for a `respond-to-ci` trigger on its automation-label skip.
 */
export async function scheduleCiNoFixRecovery({
	project,
	prNumber,
	prBranch,
	headSha,
}: CiNoFixRecoveryInput): Promise<void> {
	await releaseReviewDispatch(buildReviewDispatchKey(project.repo, prNumber, headSha));

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
