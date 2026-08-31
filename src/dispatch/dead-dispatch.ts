/**
 * "Did the work this dispatch was created for actually happen?" — the one policy
 * judgement two recovery paths both have to make, kept in one place so they
 * cannot drift apart (the same shared-gate reasoning `ai/ARCHITECTURE.md`
 * records for the work-item origin gate, issue #836).
 *
 * Extracted from `./force-re-review.ts` (issue #511), where it was module-private,
 * once `./unreviewed-pr-recovery.ts` (issue #862) needed the identical judgement:
 * both bound their retries by "this attempt is already spent" and neither may
 * accept a dispatch's *terminal* state as proof that the phase behind it ran.
 */

import {
	ACTIVE_DISPATCH_STATES,
	type DispatchRow,
} from '../db/repositories/dispatchesRepository.js';

/**
 * Whether a dispatch's outcome means the work it was created for never actually
 * happened. A non-terminal dispatch is never dead — it may yet succeed, and
 * retrying past one still in flight would race the attempt already running. A
 * `completed` dispatch is dead unless its outcome is `phase-succeeded`: every
 * other completion (`no-trigger`, `skipped-not-eligible`, `skipped-duplicate`,
 * `skipped-pr-in-flight`, `superseded`) means the trigger refused the event or
 * the worker decided against a run, not that a phase actually started.
 *
 * `DispatchOutcome` also names merge-automation-only completions (`merged`,
 * `merge-not-eligible`, …), which this would likewise call dead. That's outside
 * what either caller's dispatches can ever record — neither creates one with
 * `phase: 'merge-automation'` — so it's a harmless breadth mismatch, not a bug:
 * the check is scoped to "is this a real outcome", and no path reaching here
 * ever produces a merge one.
 */
export function isDeadDispatch(dispatch: Pick<DispatchRow, 'state' | 'outcome'>): boolean {
	if (ACTIVE_DISPATCH_STATES.includes(dispatch.state as (typeof ACTIVE_DISPATCH_STATES)[number])) {
		return false;
	}
	if (dispatch.state === 'completed') return dispatch.outcome !== 'phase-succeeded';
	// 'cancelled' or 'failed'.
	return true;
}
