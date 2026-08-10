/**
 * Pure view-logic for the unified "Recover" control (issue #593), split out of
 * the run-detail route the same way `./run-retry.ts` and `./run-reset.ts` are —
 * so it can be unit-tested without a rendered component (the dashboard package
 * tests helpers only by default — no jsdom; see `dashboard/vitest.config.ts`).
 *
 * An errored run used to expose "Retry now" and "Reset & restart" as two live
 * buttons operating on the same row, so both could be submitted while the first
 * was still unresolved — two competing recovery requests, and no way to tell
 * which one was in flight. This module states the *choices* an errored run has
 * and the one label the single control carries, so the route can render one
 * button whose pending state covers every choice at once.
 *
 * It owns no eligibility rule of its own: `canRetryRun`/`retryActionKind` and
 * `canResetRun` already mirror the server's guards, and the labels already exist
 * for the side-by-side buttons the non-error states keep. Composing them here is
 * what keeps the unified control and those buttons from drifting apart.
 */

import { canResetRun, resetButtonLabel } from './run-reset.js';
import {
	canRetryRun,
	type RetryActionKind,
	retryActionKind,
	retryButtonLabel,
} from './run-retry.js';

/** The run fields the choice rules read — the subset of `RunRow` they share. */
export interface RecoverableRunState {
	status: string;
	agentSessionId: string | null;
	recovery?: { state?: 'preserved' | 'recovered' | 'blocked' } | null;
}

/** Which recovery choices a run currently offers. */
export interface RecoveryChoices {
	/** The retry-family choice and the kind that names it, or null when retry isn't eligible. */
	retry: RetryActionKind | null;
	/** Whether "Reset & restart" is eligible. */
	reset: boolean;
}

/** Which choice the operator has just submitted from this browser, if any. */
export type RecoveryPending = 'retry' | 'reset' | null;

/**
 * The recovery choices the run offers, composed from the existing per-action
 * rules rather than from a status list of its own — so a status the server
 * starts or stops accepting changes both the unified control and the
 * side-by-side buttons at once.
 */
export function recoveryChoices(run: RecoverableRunState): RecoveryChoices {
	return {
		retry: canRetryRun(run.status)
			? retryActionKind(run.status, run.agentSessionId, run.recovery)
			: null,
		reset: canResetRun(run.status),
	};
}

/** Whether any recovery choice exists — the control renders nothing when false. */
export function canRecoverRun(choices: RecoveryChoices): boolean {
	return choices.retry !== null || choices.reset;
}

/**
 * The single control's label.
 *
 * `requestOutstanding` — the durable, run-scoped fact that a restart has been
 * accepted and hasn't taken effect (issue #561) — wins over the local `pending`,
 * exactly as it does for the Terminate and Reset buttons: the mutation's own
 * `isPending` covers only the HTTP round-trip, while the accepted request
 * outlives it, and only the durable fact is visible to a second viewer or after
 * a reload. Both recovery choices record the same `manual-retry` wait, so one
 * accepted request blocks the alternate choice too — which is the whole point of
 * consolidating them behind one control.
 *
 * The in-flight copy is delegated rather than re-declared, so the pending label
 * an operator sees here reads identically to the one the deferred/checkpointed
 * buttons show for the same action.
 */
export function recoverButtonLabel(
	choices: RecoveryChoices,
	pending: RecoveryPending,
	requestOutstanding = false,
): string {
	if (requestOutstanding) return resetButtonLabel(false, true);
	if (pending === 'reset') return resetButtonLabel(true);
	if (pending === 'retry' && choices.retry) return retryButtonLabel(choices.retry, true);
	return 'Recover';
}

/**
 * The override form's submit label inside the Recover popup. Deliberately *not*
 * `retryOverrideActionLabel`'s "Retry Now": in this popup that would sit beside
 * the plain "Retry now" choice as two buttons differing only by capitalization —
 * ambiguous for an operator, and indistinguishable by accessible name.
 */
export function recoveryOverrideSubmitLabel(kind: RetryActionKind): string {
	return kind === 'continue' ? 'Continue with these settings' : 'Retry with these settings';
}
