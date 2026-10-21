/**
 * Azure DevOps' CI vocabulary — Azure Pipelines build `status`/`result` and Git
 * commit-status `state` — shared by every half that has to agree on it: webhook
 * ingress (`./webhook.ts`, phase 3/6, for `build.complete`) and the aggregate check
 * read (`./pull-requests.ts`, phase 4/6). Both a normalized event's
 * `checkConclusion` and an API read's conclusion end up in the *same* exact-match
 * consumers — the queue read model keys on `failure` (`src/queue/queued-runs.ts`)
 * and `src/triggers/handlers/aggregate-check-decision.ts` classifies the rest — so a
 * second spelling of one result would split one build into two answers. This is the
 * role `../gitlab/pipelines.ts` plays for GitLab.
 *
 * Every SHA Azure reports — `lastMergeSourceCommit.commitId`, a build's
 * `sourceVersion` / `triggerInfo['pr.sourceSha']`, a commit-status read — is the full
 * 40-character spelling, so, as on GitLab, there is no abbreviation invariant here.
 */

import type { CheckRunState } from '../../../scm/types.js';

/**
 * Build `result` → the neutral conclusion. `partiallySucceeded` — a build some
 * task of which was allowed to fail — is `neutral`: finished, and not a failure
 * Respond-to-CI could act on. `none` is absent on purpose: Azure documents it as
 * "no result", not an outcome, so — like any result this table does not know — it
 * has no conclusion (see {@link buildCheckRun}).
 */
const BUILD_RESULT_CONCLUSIONS: Readonly<Record<string, string>> = {
	succeeded: 'success',
	partiallySucceeded: 'neutral',
	failed: 'failure',
	canceled: 'cancelled',
};

/**
 * Build `status` → the neutral check status. Anything unlisted — including a
 * status this table has never seen — is `in_progress`, so the aggregate decision
 * defers and re-reads rather than judging a build it doesn't understand.
 */
const BUILD_CHECK_STATUSES: Readonly<Record<string, CheckRunState['status']>> = {
	notStarted: 'queued',
	postponed: 'queued',
	inProgress: 'in_progress',
	cancelling: 'in_progress',
	completed: 'completed',
};

/**
 * Commit-status `state` → the neutral conclusion, for the states that are final.
 * `pending` and `notSet` are absent on purpose: they mean the external CI has not
 * reported a verdict yet, so they map to an in-progress check (see
 * {@link commitStatusCheckRun}).
 */
const COMMIT_STATUS_CONCLUSIONS: Readonly<Record<string, string>> = {
	succeeded: 'success',
	partiallySucceeded: 'neutral',
	failed: 'failure',
	error: 'failure',
	notApplicable: 'skipped',
};

/**
 * The neutral conclusion a build `result` means, or `undefined` when it carries no
 * verdict — `none`, or a result this table does not know.
 */
export function buildResultConclusion(result: string): string | undefined {
	return BUILD_RESULT_CONCLUSIONS[result];
}

/**
 * One Azure Pipelines build as a neutral {@link CheckRunState}. A build is
 * `completed` only once it is finished *and* its `result` is a verdict: a finished
 * build whose result is absent, `none`, or unrecognized is an in-progress check,
 * so the aggregate decision defers and re-reads rather than reading a build that
 * reported nothing as green.
 */
export function buildCheckRun(name: string, status?: string, result?: string): CheckRunState {
	const checkStatus = (status && BUILD_CHECK_STATUSES[status]) || 'in_progress';
	const conclusion = result === undefined ? undefined : buildResultConclusion(result);
	if (checkStatus !== 'completed' || conclusion === undefined) {
		return {
			name,
			status: checkStatus === 'completed' ? 'in_progress' : checkStatus,
			conclusion: null,
		};
	}
	return { name, status: 'completed', conclusion };
}

/**
 * One Git commit status as a neutral {@link CheckRunState}. A commit status has a
 * single `state` where a build splits `status` from `result`, so a state with no
 * final conclusion — `pending`, `notSet`, or one this table does not know — is an
 * in-progress check, which makes the aggregate decision defer.
 */
export function commitStatusCheckRun(name: string, state?: string): CheckRunState {
	const conclusion = state === undefined ? undefined : COMMIT_STATUS_CONCLUSIONS[state];
	if (conclusion === undefined) return { name, status: 'in_progress', conclusion: null };
	return { name, status: 'completed', conclusion };
}
