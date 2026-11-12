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

/**
 * The only conclusions a completed check passes with (issue #1429). An allow-list,
 * not a list of failures: a deny-list read `cancelled` — a job that hit its
 * `timeout-minutes` on an overloaded runner, or was cancelled by hand — as green,
 * and so would any conclusion a provider adds later (`stale`, `startup_failure`,
 * an unmapped value) or a completed check that reports none. A head is green only
 * when every check it has completed with one of these.
 */
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(['success', 'neutral', 'skipped']);

/** Whether a check conclusion counts as passed — {@link PASSING_CONCLUSIONS}. */
export function isPassingConclusion(conclusion: string | null | undefined): boolean {
	return conclusion != null && PASSING_CONCLUSIONS.has(conclusion);
}

export type AggregateCheckDecision =
	| { action: 'defer'; incompleteChecks: string[]; message: string }
	| {
			action: 'respond-to-ci';
			/** The failed checks' names — what base-branch attribution and the re-run policy compare. */
			failedChecks: string[];
			/** The same checks with their conclusion, `"<name> (<conclusion>)"` — for messages only. */
			failedCheckDetails: string[];
	  }
	| { action: 'review'; basis: 'checks-passed' | 'no-checks' };

/**
 * Decide what to do with a PR's aggregate CI state:
 *
 *  - `defer`  — some check hasn't reached `completed`. The caller schedules a
 *    coalesced re-check so a stale checks API (which can lag the webhook that
 *    woke us) is re-queried rather than trusted once.
 *  - `respond-to-ci` — every check completed and at least one did not pass:
 *    any conclusion outside {@link PASSING_CONCLUSIONS} — `failure`, `timed_out`,
 *    `action_required`, `cancelled`, `stale`, an unknown value, or none at all —
 *    is a failed check (issue #1429). Routes the PR to the Respond-to-CI phase
 *    (`src/pipeline/respond-to-ci.ts`), which runs the implementer to fix the
 *    build — mirroring Cascade's respond-to-ci agent. `failedChecks` names the
 *    failing runs; `failedCheckDetails` adds each one's conclusion for messages.
 *  - `review` — every check completed and every one passed. A zero-check result
 *    defers under the default `required` policy: the provider's checks API can
 *    temporarily return no runs just after a new commit, and treating that as
 *    green would bypass CI. A repository with no CI at all opts into `if-present`
 *    (`repositories[].reviewChecks`, `src/config/schema.ts`), where a zero-check
 *    result reviews immediately instead — see the `policy` parameter (issue #274).
 *    `basis` says which of the two it was: every check passed, or there were none.
 *
 * Zero checks means zero check **runs** — `totalCount` counts runs, not suites —
 * so a head whose only check suite has no runs, or carries a suite the provider's
 * read does not list at all (an Xcode Cloud suite stuck in `queued` on GitHub,
 * issue #1107), is a zero-check head. That is decided here once, so the
 * `updated`, `opened` and `checks` paths of the `pr-review` handler, the unreviewed-PR
 * sweep, base-branch health and merge automation can never classify the same head
 * differently; `basis` lets the `updated` path act on the zero-check case alone
 * without re-testing `totalCount` itself.
 */
export function decideAggregateCheckOutcome(
	checkStatus: AggregateCheckStatus,
	prNumber: string,
	policy: ReviewChecksPolicy = 'required',
): AggregateCheckDecision {
	if (checkStatus.totalCount === 0) {
		if (policy === 'if-present') return { action: 'review', basis: 'no-checks' };
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

	const failed = checkStatus.checkRuns.filter((cr) => !isPassingConclusion(cr.conclusion));
	if (failed.length > 0) {
		return {
			action: 'respond-to-ci',
			failedChecks: failed.map((cr) => cr.name),
			failedCheckDetails: failed.map((cr) => `${cr.name} (${cr.conclusion ?? 'no conclusion'})`),
		};
	}

	return { action: 'review', basis: 'checks-passed' };
}
