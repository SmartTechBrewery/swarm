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
 *  - if the last re-run fails too, or the provider cannot re-run them at all,
 *    SWARM hands the head to the operator once — so does a head with no operator
 *    to re-run them as,
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
 *  - one `no-fix` recovery per head — that module's own dedup key, which is also
 *    how "adjudicated" is answered durably (`hasCiNoFixRecovery`);
 *  - no Respond-to-CI re-dispatch on an adjudicated approved head — the
 *    `pr-review` trigger resolves such a head's red to this policy before it
 *    takes any dispatch claim or fix attempt;
 *  - one green re-arm per (approving run, head) — phase 1's own dedup key.
 *
 * Lives under `src/dispatch/` for the reason `./base-branch-health.ts` and
 * `./ci-no-fix-recovery.ts` do: it is not scheduled by a phase (ai/RULES.md §2).
 */

import type { ProjectConfig } from '../config/schema.js';
import {
	type ApprovedHeadSlot,
	claimApprovedHeadChecksRerun,
	claimApprovedHeadOperatorNotice,
	getApprovedHeadSlot,
	type ReviewVerdictKey,
} from '../db/repositories/reviewVerdictsRepository.js';
import { createFailedRun } from '../db/repositories/runsRepository.js';
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
import type { RerunFailedChecksOutcome, SCMProvider } from '../scm/types.js';
import {
	buildReviewDispatchKey,
	releaseReviewDispatch,
} from '../triggers/review-dispatch-dedup.js';
import { operatorHandoffDiagnosis } from '../worker/failure-diagnosis.js';

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
 *  - `not-applicable` — merge automation is off for the repository, or the head
 *    has no submitted approval, so the policy does not apply.
 */
export type AdjudicatedApprovedHeadOutcome =
	| 'rerun-requested'
	| 'rerun-settling'
	| 'rerun-waiting'
	| 'needs-operator'
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
	/** The two writes the policy makes through the provider: the re-run, and the notice. */
	scm: Pick<SCMProvider, 'rerunFailedChecks' | 'deliveryProvider'>;
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
}

const NOT_APPLICABLE: AdjudicatedApprovedHeadDecision = { outcome: 'not-applicable' };
const NEEDS_OPERATOR: AdjudicatedApprovedHeadDecision = { outcome: 'needs-operator' };
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

	const dueAt = nextApprovedHeadRerunDueAt(slot);
	if (!dueAt) {
		await handToOperator(input, key, exhaustedReruns());
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
	return requestRerun(input, key, attempts + 1);
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
	attempt: number,
): Promise<AdjudicatedApprovedHeadDecision> {
	const { project, scm, prNumber, headSha } = input;
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
			await handToOperator(input, key, couldNotRerun(attempt, err.message));
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

	await handToOperator(input, key, couldNotRerun(attempt, describeRerunRefusal(outcome)));
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
	logger.warn('approved head: red after its re-runs — handing it to the operator', {
		...context,
		rerun,
	});

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
				`pull request. ${rerun} Re-run the checks — SWARM merges this head once they pass — ` +
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
			body: operatorNoticeBody(headSha, failedChecks, rerun),
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
