/**
 * The red updated head (issue #1433) — what SWARM does first with a red on a head
 * that merge automation brought up to date with its base for an approved pull
 * request (`advanceOntoUpdatedHead`, issue #874).
 *
 * Such a red is often environmental rather than the combination's: in
 * `under-control-platform#2210` backend integration tests failed on a pull request
 * that only touched `apps/web/**`, and one manual re-run turned the head green.
 * Sending that red straight to Respond-to-CI spends an agent run (and, when the
 * agent declines, the operator's attention) on a failure nobody caused. So before
 * the `pr-review` trigger dispatches Respond-to-CI for such a head, SWARM re-runs
 * the failed checks itself, **once**, through `SCMProvider.rerunFailedChecks`:
 *
 *  - if they pass, the green path continues as for any green head — a merge
 *    still waiting on the head is woken (issue #1173), and otherwise the head is
 *    reviewed and merged; nothing is merged here;
 *  - if they fail again, or the re-run cannot be made (`unsupported`,
 *    `nothing-to-rerun`, `provider-error`, or no operator to re-run them as —
 *    the re-run is a write made for the pull request's author with the stored
 *    credential of the operator whose worker produced it, issue #1249), the red
 *    goes on to Respond-to-CI exactly as before, whose own bounds and give-up
 *    record a visible `failed` run.
 *
 * Distinct from the adjudicated approved head (`./approved-head-checks-rerun.ts`,
 * issue #1128), which re-runs a head SWARM *reviewed* after its CI agent declined
 * the red, and hands it to the operator rather than back to Respond-to-CI. This
 * one applies only to a head the approving Review did **not** review — one its
 * merge automation produced — and keeps its bound on that run's own row.
 *
 * **Bounded by construction**: one re-run per (approving Review run, head) —
 * `runs.review_merge_checks_rerun_head_sha`, claimed by a conditional update
 * ({@link claimUpdatedHeadChecksRerun}). Every later red on the head finds it
 * spent and goes to Respond-to-CI; a later base update onto a fresh head gets a
 * re-run of its own.
 *
 * Lives under `src/dispatch/` for the reason `./approved-head-checks-rerun.ts`
 * does: it is not scheduled by a phase (ai/RULES.md §2).
 */

import type { ProjectConfig } from '../config/schema.js';
import {
	claimUpdatedHeadChecksRerun,
	findUpdatedHeadReviewRun,
	type UpdatedHeadReviewRun,
} from '../db/repositories/runsRepository.js';
import {
	attributedToOperator,
	PullRequestOperatorUnavailableError,
	runAsPullRequestOperator,
} from '../identity/pull-request-operator.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { RerunFailedChecksOutcome, SCMProvider } from '../scm/types.js';
import {
	buildReviewDispatchKey,
	releaseReviewDispatch,
} from '../triggers/review-dispatch-dedup.js';
import { RERUN_SETTLE_MS } from './approved-head-checks-rerun.js';

/**
 * What {@link rerunUpdatedHeadOnce} did:
 *  - `rerun-requested` — this call spent the head's one re-run and the provider
 *    accepted it; the re-run's own `checks` event decides what happens next, so
 *    nothing is dispatched for this red;
 *  - `rerun-settling` — the re-run was spent within {@link RERUN_SETTLE_MS}, so a
 *    red read now may still be the state from before it;
 *  - `spent` — the re-run was spent earlier and the head is still red: the red
 *    is Respond-to-CI's;
 *  - `rerun-refused` — this call spent the re-run but it could not be made (the
 *    reason is logged): the red is Respond-to-CI's;
 *  - `not-applicable` — merge automation is off, the head is not one merge
 *    automation produced for an approval, or the bound could not be read: the red
 *    keeps its ordinary routing.
 */
export type UpdatedHeadRerunOutcome =
	| 'rerun-requested'
	| 'rerun-settling'
	| 'spent'
	| 'rerun-refused'
	| 'not-applicable';

export interface RerunUpdatedHeadOnceInput {
	project: ProjectConfig;
	/** The one write the policy makes through the provider. */
	scm: Pick<SCMProvider, 'rerunFailedChecks'>;
	prNumber: string;
	/** The red head. */
	headSha: string;
	/** The checks the head's latest read reports failing — for the log. */
	failedChecks: string[];
}

/**
 * Apply the updated-head re-run policy to one red read. See the module header for
 * the bound. Never throws: a database error answers `not-applicable` (logged), so
 * the caller routes the red to Respond-to-CI rather than spending a re-run it
 * could not record.
 */
export async function rerunUpdatedHeadOnce(
	input: RerunUpdatedHeadOnceInput,
): Promise<UpdatedHeadRerunOutcome> {
	const { project, prNumber, headSha } = input;
	if (project.autoMerge !== true) return 'not-applicable';

	const key = { projectId: project.id, repository: project.repo, prNumber, headSha };
	let runId: string;
	let run: UpdatedHeadReviewRun | undefined;
	let claimed: boolean;
	try {
		run = await findUpdatedHeadReviewRun(key);
		if (!run) return 'not-applicable';
		runId = run.id;
		claimed = await claimUpdatedHeadChecksRerun(runId, headSha);
		// A lost claim is spent on this head by an earlier caller; re-read the stamp
		// it left, since the row read above may predate it.
		if (!claimed) run = await findUpdatedHeadReviewRun(key);
	} catch (err) {
		logger.error('updated head: could not read or claim its checks re-run — leaving it', {
			prNumber,
			headSha,
			error: describeError(err),
		});
		return 'not-applicable';
	}

	if (claimed) return requestRerun(input, runId);

	// A spent re-run always carries its stamp; a missing row is a generation that
	// moved off this head between the two reads, which is no longer this policy's.
	if (!run || run.checksRerunHeadSha !== headSha || !run.checksRerunAt) return 'not-applicable';
	const sinceRerunMs = Date.now() - run.checksRerunAt.getTime();
	if (sinceRerunMs < RERUN_SETTLE_MS) {
		logger.debug('updated head: re-run requested moments ago — letting it settle', {
			prNumber,
			headSha,
			sinceRerunMs,
		});
		return 'rerun-settling';
	}
	logger.info('updated head: red after its one re-run — handing it to Respond-to-CI', {
		prNumber,
		headSha,
		failedChecks: input.failedChecks,
	});
	return 'spent';
}

/** Spend the head's one re-run — the claim is already taken — and act on the provider's answer. */
async function requestRerun(
	input: RerunUpdatedHeadOnceInput,
	runId: string,
): Promise<UpdatedHeadRerunOutcome> {
	const { project, scm, prNumber, headSha, failedChecks } = input;
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
		const reason =
			err instanceof PullRequestOperatorUnavailableError
				? err.message
				: // The contract never throws; this keeps a provider that does from escaping.
					`the source-control provider failed (${describeError(err)})`;
		return refused(input, runId, reason);
	}

	if (outcome.status !== 'requested') return refused(input, runId, describeRerunRefusal(outcome));

	// The re-run's own `checks completed` must be *decided*: merge automation holds
	// this head's PR+SHA claim for its whole lease (`claimUpdatedHeadReviewSlot`),
	// and a green re-run arriving on it would be dropped as a duplicate, leaving
	// the approved pull request with nothing to review or merge it.
	await releaseReviewDispatch(buildReviewDispatchKey(project.repo, prNumber, headSha));
	logger.info('updated head: re-ran the failed checks once before Respond-to-CI', {
		prNumber,
		headSha,
		runId,
		failedChecks,
		rerunChecks: outcome.checks,
	});
	return 'rerun-requested';
}

function refused(
	input: RerunUpdatedHeadOnceInput,
	runId: string,
	reason: string,
): UpdatedHeadRerunOutcome {
	logger.warn(
		'updated head: could not re-run the failed checks — handing the red to Respond-to-CI',
		{
			prNumber: input.prNumber,
			headSha: input.headSha,
			runId,
			failedChecks: input.failedChecks,
			reason,
		},
	);
	return 'rerun-refused';
}

function describeRerunRefusal(
	outcome: Exclude<RerunFailedChecksOutcome, { status: 'requested' }>,
): string {
	if (outcome.status === 'nothing-to-rerun')
		return 'the source-control provider reported no failed check it could re-run';
	return `the source-control provider answered ${outcome.status} (${outcome.message})`;
}
