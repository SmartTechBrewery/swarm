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
 * The label the Recover popup's retry choice carries once the operator has edited
 * the override fields. Deliberately *not* `retryOverrideActionLabel`'s "Retry Now":
 * that would differ from the untouched label only by capitalization — ambiguous for
 * an operator, and indistinguishable by accessible name.
 */
export function recoveryOverrideSubmitLabel(kind: RetryActionKind): string {
	return kind === 'continue' ? 'Continue with these settings' : 'Retry with these settings';
}

/**
 * The agent selection the Recover popup's override fields hold — the run's own
 * engine/model/reasoning as the fields seed them, or the operator's edit of it.
 * `reasoning` is `''` when the model exposes no choice or the operator left it on
 * the CLI's default, which is how the selects represent "send nothing".
 */
export interface OverrideSelection {
	cli: string;
	model: string;
	reasoning: string;
}

/**
 * Whether the operator actually moved the override fields off the run's own
 * settings.
 *
 * This is what decides whether the popup's retry submits overrides at all, and it
 * has to stay a *comparison* rather than "the fields have a value": they always
 * do, because they seed from the run. Sending them unconditionally would turn
 * every plain retry into an override — and an override is never a no-op
 * server-side, since `runs.retryNow` reads one as "start fresh", abandoning the
 * session resume or preserved-checkout adoption the plain choice exists to
 * perform.
 *
 * The seed is the baseline rather than the run row's raw `engine`/`model`: a run
 * whose stored model is not in the live catalogue seeds the first listed one, and
 * an operator who did not touch that field asked for nothing.
 */
export function overrideSelectionChanged(
	seeded: OverrideSelection,
	selected: OverrideSelection,
): boolean {
	return (
		seeded.cli !== selected.cli ||
		seeded.model !== selected.model ||
		seeded.reasoning !== selected.reasoning
	);
}

/**
 * The Recover popup's single retry label (issue #989). The popup used to carry two
 * retry buttons — a prominent plain one above the override fields and a quiet
 * "Retry with these settings" below them — so an operator who changed the Model
 * select and then clicked the obvious button re-ran the phase on exactly the model
 * it had just failed on, with nothing saying the selection had been dropped.
 *
 * There is one button now, and this is how it says which of the two it currently
 * is: the run's own server semantics while the fields are untouched, and the
 * override submit the moment one is edited.
 */
export function recoveryRetryChoiceLabel(kind: RetryActionKind, selectionChanged: boolean): string {
	return selectionChanged ? recoveryOverrideSubmitLabel(kind) : retryButtonLabel(kind, false);
}
