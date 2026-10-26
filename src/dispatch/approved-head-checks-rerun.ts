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
 * scheduled and nothing said. So SWARM now re-runs the failed checks itself,
 * **once**, through `SCMProvider.rerunFailedChecks`:
 *
 *  - if they pass, the green `checks` event re-arms the merge (issue #1128 phase
 *    1, `rearmMergeAutomationForGreenHead`), which re-reads the checks and merges
 *    — no merge ever happens here, so merge automation still never merges a red
 *    or pending head;
 *  - if they fail again, or the provider cannot re-run them, SWARM hands the head
 *    to the operator once: one durable `failed` Respond-to-CI run (the
 *    `recordAbandonedCiFix` precedent, issue #838) and one idempotent comment on
 *    the pull request through the delivery seam (the base-blocked notice's
 *    precedent, issue #873).
 *
 * {@link recoverAdjudicatedApprovedHead} is the one policy both call sites share:
 * the `pr-review` trigger (a red event, or the `no-fix` hand-back, meeting an
 * approved head — `src/triggers/handlers/review.ts`) and merge automation (a
 * Review that approved an adjudicated red head, then the merge refusing it —
 * `src/worker/merge-automation.ts`). Whichever reaches the head first spends the
 * re-run; the other finds it spent.
 *
 * **Bounded by construction**, so a check that stays red cannot spin:
 *  - one re-run per approved head — `review_verdicts.checks_rerun_at`, claimed by
 *    a conditional update ({@link claimApprovedHeadChecksRerun});
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
	claimApprovedHeadChecksRerun,
	claimApprovedHeadOperatorNotice,
	getApprovedHeadSlot,
	type ReviewVerdictKey,
} from '../db/repositories/reviewVerdictsRepository.js';
import { createFailedRun } from '../db/repositories/runsRepository.js';
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
 * What {@link recoverAdjudicatedApprovedHead} did:
 *  - `rerun-requested` — this call spent the head's one re-run and the provider
 *    accepted it; the re-run's own `checks` event decides what happens next;
 *  - `rerun-settling` — the re-run was requested within {@link RERUN_SETTLE_MS},
 *    so a red read now may still be the state from before it;
 *  - `needs-operator` — the re-run failed again, or could not be made; the
 *    once-only notice has been written (or already was);
 *  - `not-applicable` — merge automation is off for the repository, or the head
 *    has no submitted approval, so the policy does not apply.
 */
export type AdjudicatedApprovedHeadOutcome =
	| 'rerun-requested'
	| 'rerun-settling'
	| 'needs-operator'
	| 'not-applicable';

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

/**
 * Apply the adjudicated-approved-head policy to one red read. See the module
 * header for the bounds. Never throws: a database error answers `not-applicable`
 * (logged), which leaves each caller on its pre-#1128 behaviour rather than
 * spending a re-run or a notice it could not record.
 */
export async function recoverAdjudicatedApprovedHead(
	input: RecoverAdjudicatedApprovedHeadInput,
): Promise<AdjudicatedApprovedHeadOutcome> {
	const { project, prNumber, headSha } = input;
	if (project.autoMerge !== true) return 'not-applicable';
	const key: ReviewVerdictKey = {
		projectId: project.id,
		repository: project.repo,
		prNumber,
		headSha,
	};

	let claimed: boolean;
	let checksRerunAt: Date | null = null;
	try {
		claimed = await claimApprovedHeadChecksRerun(key);
		if (!claimed) {
			const slot = await getApprovedHeadSlot(key);
			if (!slot) return 'not-applicable';
			checksRerunAt = slot.checksRerunAt;
		}
	} catch (err) {
		logger.error('approved head: could not read or claim its checks re-run — leaving it', {
			prNumber,
			headSha,
			error: describeError(err),
		});
		return 'not-applicable';
	}

	if (claimed) return requestRerun(input, key);

	// The claim lost to an earlier caller, so the re-run is spent. A stamp is always
	// present on a spent re-run; a null one would be a slot approved between the
	// two reads, which is the first call's to make, not this one's.
	if (!checksRerunAt) return 'not-applicable';
	const sinceRerunMs = Date.now() - checksRerunAt.getTime();
	if (sinceRerunMs < RERUN_SETTLE_MS) {
		logger.debug('approved head: re-run requested moments ago — letting it settle', {
			prNumber,
			headSha,
			sinceRerunMs,
		});
		return 'rerun-settling';
	}
	await handToOperator(input, key, 'SWARM re-ran the failing checks once, and they failed again.');
	return 'needs-operator';
}

/** Spend the head's one re-run — the claim is already taken — and act on the provider's answer. */
async function requestRerun(
	input: RecoverAdjudicatedApprovedHeadInput,
	key: ReviewVerdictKey,
): Promise<AdjudicatedApprovedHeadOutcome> {
	const { project, scm, prNumber, headSha } = input;
	let outcome: RerunFailedChecksOutcome;
	try {
		outcome = await scm.rerunFailedChecks(project, headSha, 'implementer');
	} catch (err) {
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
			failedChecks: input.failedChecks,
			rerunChecks: outcome.checks,
		});
		return 'rerun-requested';
	}

	await handToOperator(
		input,
		key,
		`SWARM could not re-run the failing checks: ${describeRerunRefusal(outcome)}.`,
	);
	return 'needs-operator';
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
	logger.warn('approved head: red after its one re-run — handing it to the operator', {
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
		const delivery = await scm.deliveryProvider(project, 'implementer');
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
