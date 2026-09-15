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

import type { AgentCli } from '../../../src/harness/agent-cli.js';
import {
	capabilityFor,
	MODEL_CAPABILITIES,
	normalizeModelSelection,
	type ReasoningLevel,
} from '../../../src/harness/models.js';
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
 *
 * Each kind keeps the verb its untouched label uses, because an override changes
 * only *which agent runs*, never what the server does around it: a `continue` still
 * continues from the checkpoint, and a `recheck` still has its protected worktree
 * re-verified before the phase starts. `resume` is the one kind that loses its verb
 * — an override really does abandon the session — so it reads as a plain retry.
 */
export function recoveryOverrideSubmitLabel(kind: RetryActionKind): string {
	if (kind === 'continue') return 'Continue with these settings';
	if (kind === 'recheck') return 'Recheck with these settings';
	return 'Retry with these settings';
}

/**
 * The agent selection the Recover popup's override fields hold — the run's own
 * engine/model/reasoning as the fields seed them, or the operator's edit of it.
 * `reasoning` is `''` when the model exposes no choice or the operator left it on
 * the CLI's default, which is how the selects represent "send nothing".
 */
export interface OverrideSelection {
	cli: AgentCli;
	model: string;
	reasoning: ReasoningLevel | '';
}

/**
 * The model a CLI's Model select pre-selects when the popup has nothing else to
 * go on — stated per CLI, and only where the catalogue's own order doesn't
 * already state it (issue #994).
 *
 * The popup used to take `MODEL_CAPABILITIES[cli][0]`, which made list order do
 * double duty: it is the order the Model dropdown *offers*, and it was also the
 * pre-selection. `CLAUDE_CAPABILITIES` leads with Fable, so picking `claude` in
 * the Agent CLI field snapped the Model field to Fable — while every claude-run
 * phase in this installation's agent config is `claude/opus`. An operator who
 * didn't notice re-ran the phase on a model they never chose.
 *
 * The codex and antigravity catalogues are ordered newest-first *on purpose*
 * (see their comments in `src/harness/models.ts`), so their first entry really
 * is the preference and they state nothing here — a newer model landing at the
 * top of either list should keep moving their default with it. Claude's order
 * carries no such meaning, so it is the one entry.
 *
 * Deliberately **not** `DEFAULT_MODEL_PER_CLI`, which is the coded fallback every
 * unconfigured *phase* inherits (`claude: 'sonnet'`) — a much wider decision the
 * two are not being unified on. This is the Recover popup's pre-selection alone;
 * every model in the catalogue stays selectable.
 */
const PREFERRED_OVERRIDE_MODEL: Partial<Record<AgentCli, string>> = {
	claude: 'opus',
};

/**
 * The Model select's pre-selection for `cli` — its stated preference, or the
 * first model its catalogue lists when it states none.
 *
 * A stated preference the live catalogue no longer offers falls back the same
 * way rather than arming a selection the dropdown can't render; the unit test
 * asserts every stated preference is a real catalogue entry, so a retirement
 * fails there instead of degrading quietly here.
 */
export function defaultOverrideModel(cli: AgentCli): string {
	const preferred = PREFERRED_OVERRIDE_MODEL[cli];
	if (preferred && capabilityFor(cli, preferred)) return preferred;
	return MODEL_CAPABILITIES[cli][0].id;
}

/** The run fields the override fields seed from — the `RunRow` subset they read. */
export interface OverrideSeedRun {
	engine: string | null;
	model: string | null;
	reasoning: string | null;
}

/** Whether a stored `engine` names a CLI the model catalogue knows. */
function isAgentCli(engine: string | null): engine is AgentCli {
	return engine !== null && Object.hasOwn(MODEL_CAPABILITIES, engine);
}

/**
 * What the popup's three override fields hold before the operator touches them:
 * the run's own engine/model/reasoning, decomposing a legacy combined antigravity
 * model string into the logical id (+ reasoning) the dropdowns now speak
 * (issue #180).
 *
 * A model the live catalogue doesn't recognise — a run that stored none, or one
 * whose model has since been retired — is the same "pick a model with nothing to
 * go on" case as a CLI switch, so it lands on {@link defaultOverrideModel} rather
 * than on the first listed entry (issue #994). A run that *does* name a
 * recognised model still seeds from that model: this changes the default, not the
 * seed.
 */
export function seedOverrideSelection(run: OverrideSeedRun): OverrideSelection {
	const cli = isAgentCli(run.engine) ? run.engine : 'claude';
	const normalized = run.model ? normalizeModelSelection(cli, run.model) : undefined;
	const model =
		normalized?.model && capabilityFor(cli, normalized.model)
			? normalized.model
			: defaultOverrideModel(cli);
	return {
		cli,
		model,
		reasoning: (run.reasoning ?? normalized?.reasoning ?? '') as ReasoningLevel | '',
	};
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
 * whose stored model is not in the live catalogue seeds its CLI's default
 * ({@link seedOverrideSelection}), and an operator who did not touch that field
 * asked for nothing.
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
