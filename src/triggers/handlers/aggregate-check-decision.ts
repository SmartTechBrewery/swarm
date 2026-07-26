/**
 * The aggregate-check-state decision for the `pr-review` handler
 * (`src/triggers/handlers/review.ts`), ported from Cascade's
 * `check-suite-decision.ts`.
 *
 * A provider fires one check-completion event per CI workflow, so no single event
 * knows whether CI as a whole is done. Given the aggregate state of *every* check
 * on the head SHA (`SCMProvider.getAggregateCheckStatus`), this decides the one
 * thing the handler needs: review now (all passed), respond-to-ci (a check
 * failed), or defer and re-check later (some check still running). It is a pure
 * function of the aggregate — the draft/fork/ownership gates live in the handler —
 * so it unit-tests without any provider or queue plumbing.
 */

import type { ReviewChecksPolicy } from '../../config/schema.js';
import type { AggregateCheckStatus } from '../../scm/types.js';

/** Conclusions that count as a failed check — a commit with any of these is not reviewable. */
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required']);

export type AggregateCheckDecision =
	| { action: 'defer'; incompleteChecks: string[]; message: string }
	| { action: 'respond-to-ci'; failedChecks: string[] }
	| { action: 'review' };

/**
 * Decide what to do with a PR's aggregate CI state:
 *
 *  - `defer`  — some check hasn't reached `completed`. The caller schedules a
 *    coalesced re-check so a stale checks API (which can lag the webhook that
 *    woke us) is re-queried rather than trusted once.
 *  - `respond-to-ci` — every check completed and at least one failed. Routes
 *    the PR to the Respond-to-CI phase (`src/pipeline/respond-to-ci.ts`), which
 *    runs the implementer to fix the build — mirroring Cascade's respond-to-ci
 *    agent. `failedChecks` names the failing runs for the handler's log line.
 *  - `review` — every check completed and none failed. A zero-check result
 *    defers under the default `required` policy: the provider's checks API can
 *    temporarily return no runs just after a new commit, and treating that as
 *    green would bypass CI. Projects with no CI at all opt into `if-present`
 *    (`pipeline.review.checks`, `src/config/schema.ts`), where a zero-check
 *    result reviews immediately instead — see the `policy` parameter (issue #274).
 */
export function decideAggregateCheckOutcome(
	checkStatus: AggregateCheckStatus,
	prNumber: string,
	policy: ReviewChecksPolicy = 'required',
): AggregateCheckDecision {
	if (checkStatus.totalCount === 0) {
		if (policy === 'if-present') return { action: 'review' };
		return {
			action: 'defer',
			incompleteChecks: [],
			message: `PR #${prNumber}: no checks are registered yet`,
		};
	}

	const incompleteChecks = checkStatus.checkRuns
		.filter((cr) => cr.status !== 'completed')
		.map((cr) => cr.name);
	if (incompleteChecks.length > 0) {
		return {
			action: 'defer',
			incompleteChecks,
			message: `PR #${prNumber}: ${incompleteChecks.length}/${checkStatus.totalCount} checks still running (${incompleteChecks.join(', ')})`,
		};
	}

	const failedChecks = checkStatus.checkRuns
		.filter((cr) => cr.conclusion !== null && FAILURE_CONCLUSIONS.has(cr.conclusion))
		.map((cr) => cr.name);
	if (failedChecks.length > 0) {
		return { action: 'respond-to-ci', failedChecks };
	}

	return { action: 'review' };
}
