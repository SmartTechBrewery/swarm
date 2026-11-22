/**
 * The adjudicated red approved head (issue #1128) — what SWARM does with a head
 * its own Review approved, with merge automation on, whose checks are red and
 * whose red SWARM's own Respond-to-CI agent already judged **not** to be the pull
 * request's fault (a settled `no-fix`, `./ci-no-fix-recovery.ts`).
 *
 * Before this existed that head had nowhere to go. Merge automation refuses a red
 * head (issue #1124) and leaves it to Respond-to-CI; Respond-to-CI already
 * declined; the `no-fix` hand-back's Review met a slot already `submitted` and
 * dropped as a same-head retry. The card sat in **In review** with nothing
 * scheduled and nothing said. So SWARM now re-runs the failed checks itself
 * through `SCMProvider.rerunFailedChecks` — up to {@link MAX_APPROVED_HEAD_RERUNS}
 * times, spaced by a growing delay ({@link APPROVED_HEAD_RERUN_GAPS_MS}: the
 * requests land at about 0, +15 and +45 minutes, issue #1463), because an
 * environmental failure (a runner image, a flaky service) often needs longer to
 * clear than one immediate re-run gives it:
 *
 *  - if they pass, the green `checks` event re-arms the merge (issue #1128 phase
 *    1, `rearmMergeAutomationForGreenHead`), which re-reads the checks and merges
 *    — no merge ever happens here, so merge automation still never merges a red
 *    or pending head;
 *  - if they fail again before the last re-run, the head waits for the next one
 *    (`rerun-waiting`); the `pr-review` trigger re-reads it when it falls due, on
 *    the coalesced recheck that does not draw the CI-wait budget;
 *  - if a re-run fails **differently** from the failure the `no-fix` verdict was
 *    made on (issue #1474) — a different, concrete failed step where the provider
 *    reports steps (GitHub today) — the verdict no longer covers it, and the
 *    `pr-review` trigger sends the head back to Respond-to-CI once
 *    (`failure-changed`). The verdict's failure is recorded as each check's latest
 *    attempt and first failed step when the first re-run is requested, before it
 *    runs; a re-run failing the same way, or with no failed step at all (a lost
 *    runner), keeps the re-runs. Until that re-routed Respond-to-CI answers, the
 *    head is its fix's: a `pr-review` red answers `failure-changed` again (the
 *    PR+SHA claim and fix-attempt cap dedupe the dispatch), and every other caller
 *    `failure-rerouted` — no re-run, no notice. A `no-fix` answer (the `reverdict`
 *    recovery) puts the head back on the re-runs and the notice; a `fixed` one
 *    pushes a new head;
 *  - if the last re-run fails too, or the provider cannot re-run them at all,
 *    SWARM hands the head to the operator once, naming the runner each failed
 *    attempt ran on where the provider reports it (issue #1468), and the attempt
 *    the verdict was made on beside what the latest one failed on (issue #1474)
 *    — so does a head
 *    with no operator to re-run them as,
 *    since the re-run is a write made for the pull request's author with the stored
 *    credential of the operator whose worker produced it (issue #1249). The
 *    hand-off is one durable `failed` Respond-to-CI run (the
 *    `recordAbandonedCiFix` precedent, issue #838) and one idempotent comment on
 *    the pull request through the delivery seam (the base-blocked notice's
 *    precedent, issue #873).
 *
 * {@link recoverAdjudicatedApprovedHead} is the one policy both call sites share:
 * the `pr-review` trigger (a red event, or the `no-fix` hand-back, meeting an
 * approved head — `src/triggers/handlers/review.ts`) and merge automation (a
 * Review that approved an adjudicated red head, then the merge refusing it —
 * `src/worker/merge-automation.ts`). Whichever reaches the head first spends the
 * attempt that is due; the other finds it spent.
 *
 * **Bounded by construction**, so a check that stays red cannot spin:
 *  - at most {@link MAX_APPROVED_HEAD_RERUNS} re-runs per approved head —
 *    `review_verdicts.checks_rerun_attempts`, spent by a compare-and-swap
 *    conditional update on the count ({@link claimApprovedHeadChecksRerun}), so
 *    concurrent callers that read the same count spend that attempt once;
 *  - spaced — an attempt is not claimed before its gap from the previous request
 *    (`review_verdicts.checks_rerun_at`) has passed;
 *  - one operator notice per head — `review_verdicts.operator_notified_at`, the
 *    same way ({@link claimApprovedHeadOperatorNotice});
 *  - at most two `no-fix` recoveries per head — that module's own dedup key, which
 *    is also how "adjudicated" is answered durably (`hasCiNoFixRecovery`), plus
 *    one `reverdict` key a head sent back to Respond-to-CI may use once;
 *  - one re-route to Respond-to-CI per adjudicated approved head, and only for a
 *    re-run that failed differently (issue #1474) —
 *    `review_verdicts.failure_change_routed_at`, claimed conditionally
 *    ({@link claimApprovedHeadFailureChangeRoute}). The stamp marks the re-route
 *    owed or in flight until the re-routed run answers `no-fix` (the `reverdict`
 *    recovery, `hasCiNoFixReverdictRecovery`): until then a `pr-review` red is
 *    answered `failure-changed` again without a second claim, so a deferred or
 *    retried dispatch still reaches Respond-to-CI, and its PR+SHA claim and the
 *    per-PR `MAX_FIX_ATTEMPTS` — which every such dispatch spends — dedupe and
 *    bound it. Otherwise the `pr-review` trigger resolves such a head's red to
 *    this policy before it takes any dispatch claim or fix attempt;
 *  - one recorded verdict failure per head — `review_verdicts.adjudicated_failure`,
 *    written once ({@link recordApprovedHeadAdjudicatedFailure});
 *  - one green re-arm per (approving run, head) — phase 1's own dedup key;
 *  - no re-run or notice for a check failing on several pull requests at once
 *    (issue #1464, `./shared-check-failure.ts`): while that check's episode
 *    stands, the head answers `shared-failure` and the one shared report speaks
 *    for it. A pull request failing on its own keeps the per-head policy.
 *
 * Lives under `src/dispatch/` for the reason `./base-branch-health.ts` and
 * `./ci-no-fix-recovery.ts` do: it is not scheduled by a phase (ai/RULES.md §2).
 */

import type { ProjectConfig } from '../config/schema.js';
import {
	type ApprovedHeadSlot,
	claimApprovedHeadChecksRerun,
	claimApprovedHeadFailureChangeRoute,
	claimApprovedHeadOperatorNotice,
	getApprovedHeadSlot,
	type ReviewVerdictKey,
	recordApprovedHeadAdjudicatedFailure,
} from '../db/repositories/reviewVerdictsRepository.js';
import { createFailedRun } from '../db/repositories/runsRepository.js';
import type { AdjudicatedFailureSignature } from '../db/schema/reviewVerdicts.js';
import {
	attributedToOperator,
	PullRequestOperatorUnavailableError,
	runAsPullRequestOperator,
} from '../identity/pull-request-operator.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { SwarmJob } from '../queue/jobs.js';
import { deliveryIdentity } from '../scm/delivery.js';
import { SWARM_GENERATED_FOOTER } from '../scm/swarm-origin.js';
import type { CheckAttemptRunner, RerunFailedChecksOutcome, SCMProvider } from '../scm/types.js';
import {
	buildReviewDispatchKey,
	releaseReviewDispatch,
} from '../triggers/review-dispatch-dedup.js';
import { operatorHandoffDiagnosis } from '../worker/failure-diagnosis.js';
import { hasCiNoFixReverdictRecovery } from './ci-no-fix-recovery.js';
import { noteAdjudicatedCheckFailures } from './shared-check-failure.js';

/**
 * How long after the re-run was requested a red read is still taken to be the
 * pre-re-run state rather than its verdict. A provider's checks API lags its own
 * re-run (the old failed conclusion can still be reported for a moment after the
 * re-run was accepted), and a `checks` event delivered late reads that state too;
 * handing the head to the operator off such a read would report a re-run that
 * never had the chance to run. Coded rather than configured: it is a provider-lag
 * guard, not an operator dial. Exported for tests.
 */
export const RERUN_SETTLE_MS = 2 * 60 * 1000;

/**
 * How long a caller waits before re-reading a head this policy answered
 * `rerun-settling` on: the whole settle window plus a margin, so the re-read lands
 * past {@link RERUN_SETTLE_MS} of the stamp however early in the window the
 * settling read came, and is decided off the re-run's own verdict (green, or
 * `needs-operator`) rather than settling again. The `pr-review` trigger waits it
 * out on a coalesced recheck that does **not** draw the CI-wait budget
 * (`reviewChecksWaitMinutes`): that budget is sized for checks still running, and
 * a short one would run out inside the window and end the head as an abandoned
 * Review instead of the operator notice.
 */
export const RERUN_SETTLE_RECHECK_DELAY_MS = RERUN_SETTLE_MS + 15_000;

/**
 * The wait before each automatic re-run of an adjudicated red approved head
 * (issue #1463), indexed by the re-runs already spent and measured from the
 * previous re-run's request (`review_verdicts.checks_rerun_at`, the only durable
 * instant): the first is immediate, and the requests land at about 0, +15 and +45
 * minutes. A re-run whose CI takes longer than the next gap is followed as soon as
 * its red arrives — the spacing exists to let transient state clear, and that much
 * time has passed anyway. Coded rather than configured, on {@link RERUN_SETTLE_MS}'s
 * precedent.
 */
export const APPROVED_HEAD_RERUN_GAPS_MS = [0, 15 * 60 * 1000, 30 * 60 * 1000] as const;

/**
 * How many times SWARM re-runs an adjudicated red approved head's failed checks
 * before handing it to the operator (issue #1463). Derived from
 * {@link APPROVED_HEAD_RERUN_GAPS_MS}, so the schedule and the bound cannot
 * disagree.
 */
export const MAX_APPROVED_HEAD_RERUNS = APPROVED_HEAD_RERUN_GAPS_MS.length;

/**
 * How far past a re-run's due instant a caller re-reads a `rerun-waiting` head —
 * the {@link RERUN_SETTLE_RECHECK_DELAY_MS} margin, so the re-read never lands a
 * moment before the attempt falls due and waits again.
 */
export const RERUN_DUE_RECHECK_MARGIN_MS = 15_000;

/** The two durable facts the spacing reads off an approved head's slot. */
type RerunSchedule = Pick<ApprovedHeadSlot, 'checksRerunAt' | 'checksRerunAttempts'>;

/**
 * When this approved head's next automatic re-run falls due, or `null` once every
 * one is spent. The first is due at once (the epoch); a later one its gap after
 * the previous request — or at once when, defensively, a spent attempt carries no
 * stamp to measure from.
 */
export function nextApprovedHeadRerunDueAt(slot: RerunSchedule): Date | null {
	const attempts = slot.checksRerunAttempts;
	if (attempts >= MAX_APPROVED_HEAD_RERUNS) return null;
	if (attempts === 0 || !slot.checksRerunAt) return new Date(0);
	return new Date(slot.checksRerunAt.getTime() + APPROVED_HEAD_RERUN_GAPS_MS[attempts]);
}

/**
 * Whether SWARM is still acting on this approved head's red through its automatic
 * re-runs at `now` — read by Resolve problem's red-head leg (issue #1459), so the
 * sweep and this policy cannot disagree about it: the latest re-run is still
 * inside {@link RERUN_SETTLE_MS}, or a re-run is spent, another is still to come,
 * the operator has not been handed the head, and the next is not yet past its due
 * instant by more than {@link RERUN_SETTLE_RECHECK_DELAY_MS} — the grace the
 * `pr-review` trigger's scheduled re-read needs to fire and spend it. Past that
 * grace the head no longer counts as acted on, so a lost re-read cannot hide a
 * red head from the sweep for good.
 */
export function approvedHeadRerunInFlight(
	slot: RerunSchedule & Pick<ApprovedHeadSlot, 'operatorNotifiedAt'>,
	now: Date,
): boolean {
	const at = slot.checksRerunAt;
	if (slot.checksRerunAttempts > 0 && at && now.getTime() - at.getTime() < RERUN_SETTLE_MS) {
		return true;
	}
	if (slot.checksRerunAttempts < 1 || slot.operatorNotifiedAt) return false;
	const dueAt = nextApprovedHeadRerunDueAt(slot);
	return dueAt !== null && now.getTime() < dueAt.getTime() + RERUN_SETTLE_RECHECK_DELAY_MS;
}

/**
 * What {@link recoverAdjudicatedApprovedHead} did:
 *  - `rerun-requested` — this call spent the attempt that was due and the
 *    provider accepted it; the re-run's own `checks` event decides what happens
 *    next;
 *  - `rerun-settling` — a re-run was requested within {@link RERUN_SETTLE_MS} (or
 *    another caller spent this attempt a moment ago), so a red read now may still
 *    be the state from before it;
 *  - `rerun-waiting` — a re-run failed again, and the next one is not due yet;
 *  - `needs-operator` — the last re-run failed again, or one could not be made;
 *    the once-only notice has been written (or already was);
 *  - `shared-failure` — every failing check fails on several approved pull
 *    requests at once and that shared failure is reported once (issue #1464):
 *    no re-run, no per-head notice or comment, nothing to re-read;
 *  - `failure-changed` — a re-run failed in a different step from the failure
 *    the `no-fix` verdict was made on, and this call claimed the head's one
 *    re-route, or that re-route is still owed — the re-routed Respond-to-CI has
 *    not answered yet (issue #1474): the caller dispatches Respond-to-CI for it,
 *    through the PR+SHA claim that dedupes a repeat. Only answered to a caller
 *    that set {@link RecoverAdjudicatedApprovedHeadInput.routeChangedFailure};
 *  - `failure-rerouted` — the same owed or in-flight re-route, met by a caller
 *    that cannot dispatch Respond-to-CI: nothing is re-run or noticed, and
 *    nothing re-read — the re-routed run's answer decides what happens next;
 *  - `not-applicable` — merge automation is off for the repository, or the head
 *    has no submitted approval, so the policy does not apply.
 */
export type AdjudicatedApprovedHeadOutcome =
	| 'rerun-requested'
	| 'rerun-settling'
	| 'rerun-waiting'
	| 'needs-operator'
	| 'shared-failure'
	| 'failure-changed'
	| 'failure-rerouted'
	| 'not-applicable';

/** {@link recoverAdjudicatedApprovedHead}'s answer: what it did, and when to look again. */
export interface AdjudicatedApprovedHeadDecision {
	outcome: AdjudicatedApprovedHeadOutcome;
	/**
	 * Set on `rerun-settling` and `rerun-waiting`: how long the caller waits before
	 * re-reading the head, so the re-read is decided off the re-run's verdict, or
	 * spends the attempt that has fallen due.
	 */
	recheckAfterMs?: number;
}

export interface RecoverAdjudicatedApprovedHeadInput {
	project: ProjectConfig;
	/**
	 * The two writes the policy makes through the provider — the re-run, and the
	 * notice — and the reads it adds: where each failed attempt ran, whether
	 * another pull request failing the same check is still open (issue #1464), and
	 * the base head a shared check failure opens against (issue #1471).
	 */
	scm: Pick<
		SCMProvider,
		| 'rerunFailedChecks'
		| 'deliveryProvider'
		| 'describeFailedCheckAttempts'
		| 'getPullRequest'
		| 'getBranchHead'
	>;
	prNumber: string;
	/** The approved head whose red was adjudicated. */
	headSha: string;
	/** The checks the head's latest read reports failing — named in the notice. */
	failedChecks: string[];
	/**
	 * The payload a dashboard "Retry now" on the notice's `failed` run rebuilds its
	 * dispatch from — the `pr-review` trigger passes its own event. Omitted, the
	 * run is a record only.
	 */
	jobPayload?: SwarmJob;
	/**
	 * Set by the one caller that can dispatch Respond-to-CI — the `pr-review`
	 * trigger's ordinary red (issue #1474): a re-run that failed differently from
	 * the verdict's failure then answers `failure-changed` instead of spending a
	 * re-run or the notice. Every other caller leaves it unset, so none can claim
	 * the head's one re-route without dispatching anything.
	 */
	routeChangedFailure?: boolean;
}

const NOT_APPLICABLE: AdjudicatedApprovedHeadDecision = { outcome: 'not-applicable' };
const NEEDS_OPERATOR: AdjudicatedApprovedHeadDecision = { outcome: 'needs-operator' };
const SHARED_FAILURE: AdjudicatedApprovedHeadDecision = { outcome: 'shared-failure' };
const FAILURE_CHANGED: AdjudicatedApprovedHeadDecision = { outcome: 'failure-changed' };
const FAILURE_REROUTED: AdjudicatedApprovedHeadDecision = { outcome: 'failure-rerouted' };
const SETTLING: AdjudicatedApprovedHeadDecision = {
	outcome: 'rerun-settling',
	recheckAfterMs: RERUN_SETTLE_RECHECK_DELAY_MS,
};

/**
 * Apply the adjudicated-approved-head policy to one red read. See the module
 * header for the bounds. Reads the head's slot, then — only when an attempt is
 * due — spends it by a compare-and-swap on the count it read, so a concurrent
 * caller that read the same count loses the claim and settles instead. Never
 * throws: a database error answers `not-applicable` (logged), which leaves each
 * caller on its pre-#1128 behaviour rather than spending a re-run or a notice it
 * could not record — the `pr-review` trigger routes the red on to the base-branch
 * attribution and Respond-to-CI, and merge automation refuses the red head as
 * before.
 */
export async function recoverAdjudicatedApprovedHead(
	input: RecoverAdjudicatedApprovedHeadInput,
): Promise<AdjudicatedApprovedHeadDecision> {
	const { project, prNumber, headSha } = input;
	if (project.autoMerge !== true) return NOT_APPLICABLE;
	const key: ReviewVerdictKey = {
		projectId: project.id,
		repository: project.repo,
		prNumber,
		headSha,
	};

	let slot: ApprovedHeadSlot | undefined;
	try {
		slot = await getApprovedHeadSlot(key);
	} catch (err) {
		logger.error('approved head: could not read its checks re-runs — leaving it', {
			prNumber,
			headSha,
			error: describeError(err),
		});
		return NOT_APPLICABLE;
	}
	if (!slot) return NOT_APPLICABLE;
	// Already handed off: every later red finds the notice written and writes nothing.
	if (slot.operatorNotifiedAt) return NEEDS_OPERATOR;
	// The head's changed failure is with Respond-to-CI (issue #1474): no re-run,
	// notice or shared-failure stand-down may land under that fix.
	const pendingReroute = await answerPendingReroute(input, slot);
	if (pendingReroute) return pendingReroute;
	if (await isSharedFailure(input)) return SHARED_FAILURE;

	const attempts = slot.checksRerunAttempts;
	const now = Date.now();
	if (attempts > 0 && slot.checksRerunAt) {
		const sinceRerunMs = now - slot.checksRerunAt.getTime();
		if (sinceRerunMs < RERUN_SETTLE_MS) {
			logger.debug('approved head: re-run requested moments ago — letting it settle', {
				prNumber,
				headSha,
				attempt: attempts,
				sinceRerunMs,
			});
			return SETTLING;
		}
	}

	const rerouted = await routeChangedFailure(input, key, slot);
	if (rerouted) return rerouted;

	const dueAt = nextApprovedHeadRerunDueAt(slot);
	if (!dueAt) {
		await handToOperator(input, key, slot.adjudicatedFailure, exhaustedReruns());
		return NEEDS_OPERATOR;
	}
	if (now < dueAt.getTime()) {
		logger.info('approved head: re-run failed again — waiting for the next one', {
			prNumber,
			headSha,
			nextAttempt: attempts + 1,
			maxAttempts: MAX_APPROVED_HEAD_RERUNS,
			dueAt: dueAt.toISOString(),
		});
		return {
			outcome: 'rerun-waiting',
			recheckAfterMs: dueAt.getTime() - now + RERUN_DUE_RECHECK_MARGIN_MS,
		};
	}

	let claimed: boolean;
	try {
		claimed = await claimApprovedHeadChecksRerun(key, attempts, MAX_APPROVED_HEAD_RERUNS);
	} catch (err) {
		logger.error('approved head: could not claim its checks re-run — leaving it', {
			prNumber,
			headSha,
			error: describeError(err),
		});
		return NOT_APPLICABLE;
	}
	if (!claimed) {
		// Another caller that read the same count spent this attempt moments ago.
		logger.debug('approved head: this re-run was just spent by another caller', {
			prNumber,
			headSha,
			attempt: attempts + 1,
		});
		return SETTLING;
	}
	return requestRerun(input, key, slot.adjudicatedFailure, attempts + 1);
}

/**
 * A head whose changed failure was re-routed to Respond-to-CI (issue #1474) and
 * whose re-routed run has not answered `no-fix` yet — the `reverdict` recovery
 * records that answer the moment it is handed back, before its Review runs. The
 * stamp is written when the route is claimed, before Respond-to-CI is dispatched,
 * let alone run, so a dispatch deferred (concurrency, rate limit) and re-evaluated
 * from the top, or a sibling suite's red while the fix runs, must not find the
 * head back on the re-run policy. The caller that can dispatch is answered
 * `failure-changed` again, with no second claim: the PR+SHA claim makes a
 * continuation reuse its own and a sibling collide with the running fix, and the
 * per-PR fix-attempt cap bounds the rest. Every other caller is answered
 * `failure-rerouted`. A failed read is taken as "not answered yet", the side that
 * never spends a re-run or the notice under a running fix. `null` — no re-route
 * stamped, or the re-routed run already answered — carries on with the policy.
 */
async function answerPendingReroute(
	input: RecoverAdjudicatedApprovedHeadInput,
	slot: ApprovedHeadSlot,
): Promise<AdjudicatedApprovedHeadDecision | null> {
	if (!slot.failureChangeRoutedAt) return null;
	const { project, prNumber, headSha } = input;
	try {
		if (await hasCiNoFixReverdictRecovery(project, prNumber, headSha)) return null;
	} catch (err) {
		logger.error('approved head: could not read whether its re-routed CI fix answered', {
			prNumber,
			headSha,
			error: describeError(err),
		});
	}
	const routedAt = slot.failureChangeRoutedAt.toISOString();
	if (input.routeChangedFailure === true) {
		logger.info('approved head: its changed failure is still owed to Respond-to-CI', {
			prNumber,
			headSha,
			routedAt,
		});
		return FAILURE_CHANGED;
	}
	logger.info('approved head: its changed failure is with Respond-to-CI — standing by', {
		prNumber,
		headSha,
		routedAt,
	});
	return FAILURE_REROUTED;
}

/**
 * Whether this re-run's red is a different failure from the one the `no-fix`
 * verdict was made on (issue #1474) — and if so, claim the head's one re-route to
 * Respond-to-CI. Asked only for a caller that set `routeChangedFailure`, about a
 * red that is a re-run's verdict, on a head with a recorded verdict failure and
 * no re-route yet (a stamped head reaches here only once the re-routed run
 * answered `no-fix`, {@link answerPendingReroute}). `null` carries on with the re-run policy: none of that holds,
 * the failure is the same, the provider read failed or gave no signature, or the
 * claim could not be written. A lost claim settles: the caller that won it
 * dispatches.
 */
async function routeChangedFailure(
	input: RecoverAdjudicatedApprovedHeadInput,
	key: ReviewVerdictKey,
	slot: ApprovedHeadSlot,
): Promise<AdjudicatedApprovedHeadDecision | null> {
	const adjudicated = slot.adjudicatedFailure;
	if (
		input.routeChangedFailure !== true ||
		slot.checksRerunAttempts === 0 ||
		!adjudicated ||
		slot.failureChangeRoutedAt
	) {
		return null;
	}
	const { prNumber, headSha } = input;
	const attempts = await readFailedAttempts(input);
	const latest = attempts ? failureSignatureOf(attempts, input.failedChecks) : null;
	if (!latest || !failureMateriallyChanged(adjudicated, latest)) return null;
	let claimed: boolean;
	try {
		claimed = await claimApprovedHeadFailureChangeRoute(key);
	} catch (err) {
		logger.error('approved head: could not claim the re-route of a changed failure', {
			prNumber,
			headSha,
			error: describeError(err),
		});
		return null;
	}
	if (!claimed) {
		logger.debug('approved head: a changed failure was just re-routed by another caller', {
			prNumber,
			headSha,
		});
		return SETTLING;
	}
	logger.info(
		"approved head: a re-run failed differently from the CI agent's verdict — re-routing",
		{
			prNumber,
			headSha,
			adjudicatedFailure: adjudicated,
			latestFailure: latest,
		},
	);
	return FAILURE_CHANGED;
}

/**
 * Record the failure the `no-fix` verdict was made on (issue #1474), read before
 * the first re-run is requested — no re-run has happened yet, so each check's
 * latest attempt is the one SWARM's CI agent judged. Best-effort: a provider that
 * reports no steps, a read that fails or a write that fails records nothing, and
 * the head keeps the re-run-then-notice policy.
 */
async function recordAdjudicatedFailure(
	input: RecoverAdjudicatedApprovedHeadInput,
	key: ReviewVerdictKey,
): Promise<AdjudicatedFailureSignature | null> {
	const { prNumber, headSha } = input;
	const attempts = await readFailedAttempts(input);
	const signature = attempts ? failureSignatureOf(attempts, input.failedChecks) : null;
	if (!signature) return null;
	try {
		await recordApprovedHeadAdjudicatedFailure(key, signature);
	} catch (err) {
		logger.error("approved head: could not record the CI agent's adjudicated failure", {
			prNumber,
			headSha,
			error: describeError(err),
		});
		return null;
	}
	return signature;
}

/**
 * Whether every failing check on this head fails on several approved pull
 * requests at once (issue #1464) — recorded, detected and reported once by
 * `noteAdjudicatedCheckFailures`. Fails open: an error leaves the head on the
 * per-head policy, so a database fault can never silence it.
 */
async function isSharedFailure(input: RecoverAdjudicatedApprovedHeadInput): Promise<boolean> {
	const { prNumber, headSha, failedChecks } = input;
	if (failedChecks.length === 0) return false;
	let shared: Set<string>;
	try {
		shared = await noteAdjudicatedCheckFailures(input);
	} catch (err) {
		logger.error('approved head: could not check for a shared check failure — per-head policy', {
			prNumber,
			headSha,
			error: describeError(err),
		});
		return false;
	}
	if (!failedChecks.every((check) => shared.has(check))) return false;
	logger.info('approved head: its failing checks fail on several pull requests — standing down', {
		prNumber,
		headSha,
		failedChecks,
	});
	return true;
}

/** The hand-off's account of the re-runs when every one of them failed. */
function exhaustedReruns(): string {
	const spanMinutes = Math.round(
		APPROVED_HEAD_RERUN_GAPS_MS.reduce((total, gap) => total + gap, 0) / 60_000,
	);
	return (
		`SWARM re-ran the failing checks ${MAX_APPROVED_HEAD_RERUNS} times over at least ` +
		`${spanMinutes} minutes, and they failed every time.`
	);
}

/** The hand-off's account of a re-run that could not be made, naming the ones before it. */
function couldNotRerun(attempt: number, reason: string): string {
	if (attempt <= 1) return `SWARM could not re-run the failing checks: ${reason}.`;
	const spent = attempt - 1;
	return (
		`SWARM re-ran the failing checks ${spent === 1 ? 'once' : `${spent} times`} and they ` +
		`failed again, then could not re-run them again: ${reason}.`
	);
}

/**
 * Make re-run `attempt` — its claim is already taken — and act on the provider's
 * answer. A re-run the provider refuses, or one with no operator to make it as,
 * hands the head off at once, on any attempt: waiting would only fail the same way.
 */
async function requestRerun(
	input: RecoverAdjudicatedApprovedHeadInput,
	key: ReviewVerdictKey,
	recorded: AdjudicatedFailureSignature | null,
	attempt: number,
): Promise<AdjudicatedApprovedHeadDecision> {
	const { project, scm, prNumber, headSha } = input;
	// Before the first re-run runs: the latest attempts are still the verdict's.
	const adjudicated =
		attempt === 1 ? (recorded ?? (await recordAdjudicatedFailure(input, key))) : recorded;
	let outcome: RerunFailedChecksOutcome;
	try {
		// A write made for the pull request's author, so it runs as the operator whose
		// worker produced it (issue #1249).
		outcome = await runAsPullRequestOperator(project, prNumber, async (operator) => {
			const answer = await scm.rerunFailedChecks(project, headSha, 'implementer');
			return answer.status === 'provider-error'
				? { ...answer, message: attributedToOperator(answer.message, operator) }
				: answer;
		});
	} catch (err) {
		if (err instanceof PullRequestOperatorUnavailableError) {
			await handToOperator(input, key, adjudicated, couldNotRerun(attempt, err.message));
			return NEEDS_OPERATOR;
		}
		// The contract never throws; this keeps a provider that does from escaping.
		outcome = { status: 'provider-error', message: describeError(err) };
	}

	if (outcome.status === 'requested') {
		// The re-run's own `checks completed` must be *decided*: the `no-fix`
		// recovery hands its PR+SHA claim over and holds it, and a Review holds one
		// too, so a green re-run arriving on a held claim would be dropped as a
		// duplicate and the merge never re-armed.
		await releaseReviewDispatch(buildReviewDispatchKey(project.repo, prNumber, headSha));
		logger.info("approved head: re-ran the checks SWARM's CI agent judged unrelated", {
			prNumber,
			headSha,
			attempt,
			maxAttempts: MAX_APPROVED_HEAD_RERUNS,
			failedChecks: input.failedChecks,
			rerunChecks: outcome.checks,
		});
		return { outcome: 'rerun-requested' };
	}

	await handToOperator(
		input,
		key,
		adjudicated,
		couldNotRerun(attempt, describeRerunRefusal(outcome)),
	);
	return NEEDS_OPERATOR;
}

function describeRerunRefusal(
	outcome: Exclude<RerunFailedChecksOutcome, { status: 'requested' }>,
): string {
	if (outcome.status === 'nothing-to-rerun')
		return 'the source-control provider reported no failed check it could re-run';
	return `the source-control provider answered ${outcome.status} (${outcome.message})`;
}

/**
 * The once-only operator notice: a durable `failed` Respond-to-CI run and a
 * pull-request comment, gated by {@link claimApprovedHeadOperatorNotice} so every
 * later red event on the head finds it already written. Both writes are
 * best-effort and log their own failures, on `recordAbandonedCiFix`'s posture.
 */
async function handToOperator(
	input: RecoverAdjudicatedApprovedHeadInput,
	key: ReviewVerdictKey,
	adjudicated: AdjudicatedFailureSignature | null,
	rerun: string,
): Promise<void> {
	const { project, scm, prNumber, headSha, failedChecks } = input;
	const context = { prNumber, headSha, failedChecks };
	try {
		if (!(await claimApprovedHeadOperatorNotice(key))) {
			logger.debug('approved head: operator already notified for this head', context);
			return;
		}
	} catch (err) {
		logger.error('approved head: could not claim the operator notice', {
			...context,
			error: describeError(err),
		});
		return;
	}
	// Read only once the claim is won, so it is made once per head.
	const attempts = (await readFailedAttempts(input)) ?? [];
	const verdict = describeVerdictAgainstLatest(adjudicated, attempts, failedChecks);
	const runners = summarizeAttemptRunners(attempts, failedChecks);
	logger.warn('approved head: red after its re-runs — handing it to the operator', {
		...context,
		rerun,
		...(verdict ? { verdict } : {}),
		...(runners ? { runners } : {}),
	});
	const account = [rerun, verdict, runners].filter(Boolean).join(' ');

	const checks = failedChecks.length > 0 ? failedChecks.join(', ') : 'none named';
	try {
		await createFailedRun({
			projectId: project.id,
			repository: project.repo,
			taskId: `${prNumber}-ci`,
			phase: 'respond-to-ci',
			prNumber,
			...(input.jobPayload ? { jobPayload: input.jobPayload } : {}),
			// The durable marker that this run is a deliberate hand-off, so Resolve
			// problem never attempts it (issue #1462).
			failureDiagnosis: operatorHandoffDiagnosis({
				kind: 'approved-head-needs-operator',
				prNumber,
				headSha,
				failedChecks,
			}),
			error:
				`Approved head needs the operator: PR #${prNumber} at ${headSha} is approved, but its ` +
				`checks are red (${checks}). SWARM's CI agent judged the failure unrelated to this ` +
				`pull request. ${account} Re-run the checks — SWARM merges this head once they pass — ` +
				'or push a fix, which gets its own review.',
		});
	} catch (err) {
		logger.error('approved head: failed to record the operator notice run', {
			...context,
			error: describeError(err),
		});
	}

	try {
		const delivery = await scm.deliveryProvider(project, 'reviewer');
		await delivery.postComment({
			prNumber: Number(prNumber),
			body: operatorNoticeBody(headSha, failedChecks, account),
			deliveryId: deliveryIdentity([
				'approved-head-needs-operator',
				project.repo,
				prNumber,
				headSha,
			]),
		});
	} catch (err) {
		logger.error('approved head: failed to post the operator notice', {
			...context,
			error: describeError(err),
		});
	}
}

/**
 * Every failed attempt of the head's failing checks — where each ran, and the step
 * it failed in — a provider read that never blocks the policy: a throw answers
 * `null`, and the caller carries on without it.
 */
async function readFailedAttempts(
	input: RecoverAdjudicatedApprovedHeadInput,
): Promise<CheckAttemptRunner[] | null> {
	const { project, scm, prNumber, headSha } = input;
	try {
		return await scm.describeFailedCheckAttempts(project, headSha);
	} catch (err) {
		// The contract never throws; this keeps a provider that does from blocking the policy.
		logger.warn('approved head: could not read the failed attempts of its checks', {
			prNumber,
			headSha,
			error: describeError(err),
		});
		return null;
	}
}

/**
 * A failure signature (issue #1474): the **latest** attempt of each failing check
 * — of the checks in `failedChecks`, or of every check when it names none — and
 * the first step it failed in. `null` when no kept attempt reports a step at all
 * (`failedStep` omitted), which is how a provider without step data gives no
 * signature. Exported for tests.
 */
export function failureSignatureOf(
	attempts: readonly CheckAttemptRunner[],
	failedChecks: readonly string[],
): AdjudicatedFailureSignature | null {
	const named =
		failedChecks.length > 0
			? attempts.filter((attempt) => failedChecks.includes(attempt.check))
			: attempts;
	const latest = new Map<string, CheckAttemptRunner>();
	for (const attempt of named) {
		const kept = latest.get(attempt.check);
		// A later attempt wins; on a tie (two jobs of one name), a concrete step does.
		if (
			!kept ||
			attempt.attempt > kept.attempt ||
			(attempt.attempt === kept.attempt && typeof kept.failedStep !== 'string')
		) {
			latest.set(attempt.check, attempt);
		}
	}
	const kept = [...latest.values()];
	if (!kept.some((attempt) => attempt.failedStep !== undefined)) return null;
	return kept.map(({ check, attempt, failedStep }) => ({
		check,
		attempt,
		failedStep: failedStep ?? null,
	}));
}

/**
 * Whether `latest` is a different failure from the `adjudicated` one (issue
 * #1474): some check's attempt is newer than the one the verdict was made on (or
 * the check was not failing then) and failed in a concrete step other than the
 * verdict's. The same step failing again is the same failure, and so is a re-run
 * in which no step failed (a lost runner says nothing new about the code).
 * Exported for tests.
 */
export function failureMateriallyChanged(
	adjudicated: AdjudicatedFailureSignature,
	latest: AdjudicatedFailureSignature,
): boolean {
	return latest.some(({ check, attempt, failedStep }) => {
		if (typeof failedStep !== 'string') return false;
		const judged = adjudicated.find((entry) => entry.check === check);
		if (!judged) return true;
		return attempt > judged.attempt && failedStep !== judged.failedStep;
	});
}

/**
 * The operator notice's account of the attempt SWARM's CI agent judged against
 * the latest one (issue #1474), so a stale diagnosis is visible: per check the
 * verdict covered, the attempt it was made on and what that attempt failed in,
 * then the latest attempt and what it failed in. `null` when either side is
 * unknown — no recorded verdict failure, or a provider that reports no steps —
 * and the notice goes out without it. Exported for tests.
 */
export function describeVerdictAgainstLatest(
	adjudicated: AdjudicatedFailureSignature | null,
	attempts: readonly CheckAttemptRunner[],
	failedChecks: readonly string[],
): string | null {
	if (!adjudicated || adjudicated.length === 0) return null;
	const latest = failureSignatureOf(attempts, failedChecks);
	if (!latest) return null;
	const sentences = adjudicated.flatMap((judged) => {
		const now = latest.find((entry) => entry.check === judged.check);
		if (!now) return [];
		const verdict =
			`SWARM's CI agent made its judgement on attempt ${judged.attempt} of \`${judged.check}\`, ` +
			`where ${judgedStep(judged.failedStep)}`;
		if (now.attempt <= judged.attempt) return [`${verdict}, and that is still its latest attempt.`];
		return [`${verdict}; the latest attempt, ${now.attempt}, ${latestStep(now.failedStep)}.`];
	});
	return sentences.length > 0 ? sentences.join(' ') : null;
}

function judgedStep(failedStep: string | null): string {
	return failedStep === null
		? 'no step reported a failure (the job produced no result)'
		: `step \`${failedStep}\` failed`;
}

function latestStep(failedStep: string | null): string {
	return failedStep === null
		? 'had no step report a failure (the job produced no result)'
		: `failed in step \`${failedStep}\``;
}

/**
 * The operator notice's account of the runner each failed attempt ran on (issue
 * #1468), so an operator can tell a broken runner from a broken check: every
 * attempt of the checks in `failedChecks` (all of them when it names none), grouped
 * by check, oldest attempt first, and — when more than one attempt ran and every
 * one ran on the same runner — that said plainly. `null` when no attempt names a
 * runner, which is how a provider that reports none drops the account altogether.
 */
export function summarizeAttemptRunners(
	attempts: readonly CheckAttemptRunner[],
	failedChecks: readonly string[],
): string | null {
	const named =
		failedChecks.length > 0
			? attempts.filter((attempt) => failedChecks.includes(attempt.check))
			: [...attempts];
	if (!named.some((attempt) => attempt.runner !== null)) return null;

	const checkOrder =
		failedChecks.length > 0 ? failedChecks : [...new Set(named.map((attempt) => attempt.check))];
	const ordered = [...named].sort(
		(a, b) => checkOrder.indexOf(a.check) - checkOrder.indexOf(b.check) || a.attempt - b.attempt,
	);
	const list = ordered
		.map(
			({ check, attempt, runner }) =>
				`\`${check}\` — attempt ${attempt}: ${runner === null ? 'runner not reported' : `\`${runner}\``}`,
		)
		.join('; ');
	const runners = new Set(ordered.map((attempt) => attempt.runner));
	const [onlyRunner] = runners;
	const allOnOne =
		ordered.length > 1 && runners.size === 1 && onlyRunner
			? ` All ${ordered.length} attempts ran on one runner, \`${onlyRunner}\`.`
			: '';
	return `The failed attempts ran on: ${list}.${allOnOne}`;
}

function operatorNoticeBody(headSha: string, failedChecks: string[], rerun: string): string {
	const checks =
		failedChecks.length > 0 ? failedChecks.map((name) => `\`${name}\``).join(', ') : 'its checks';
	return [
		'## ⚠️ This approved pull request needs you',
		'',
		`SWARM approved head \`${headSha}\`, but ${checks} fail on it. SWARM's CI agent`,
		"judged the failure unrelated to this pull request's changes, so it pushed no fix.",
		rerun,
		'',
		'SWARM will not re-run these checks again or merge a red head. Either re-run the',
		'failing checks — once they pass, SWARM merges this head — or push a fix, which',
		'gets its own review before it can merge.',
		'',
		'---',
		// Load-bearing: ingress drops an inbound comment carrying this signature, so
		// the notice cannot wake a trigger.
		SWARM_GENERATED_FOOTER,
	].join('\n');
}
