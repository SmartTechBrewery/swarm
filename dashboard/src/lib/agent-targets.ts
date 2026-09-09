/**
 * Pure helpers for a phase's ordered list of agent model targets (issue #345):
 * projecting a stored `AgentConfig` onto the editable list, the add/remove/
 * reorder/patch mutations the phase-detail screen drives, the one-target-per-CLI
 * rule `AgentConfigSchema` enforces server-side, and the dirty-check/clean the
 * shared Save uses. Kept out of the route component so they can be unit-tested
 * (mirroring `dashboard/src/lib/pipeline-enabled.ts`).
 *
 * A target is `{ cli, model, reasoning }` and its **position is its priority** —
 * index 0 is the phase's preferred target. Only that one is dispatched today;
 * falling back to a lower-priority target when its CLI is unavailable is a later
 * change (issue #346), so the screen labels the ordering rather than implying
 * every entry runs.
 */

import type { AgentConfig, AgentTarget } from '../../../src/config/schema.js';
import type { AgentCli } from '../../../src/harness/agent-cli.js';
import {
	AGENT_MODELS,
	capabilityFor,
	isAntigravityModelValue,
	normalizeModelSelection,
	reasoningChoicesFor,
} from '../../../src/harness/models.js';

/**
 * The agent CLIs a target may name, in the order the selectors offer them.
 * Spelled out rather than imported from `src/harness/agent-cli.ts`, whose module
 * pulls in the node-only process harness — the route already takes only its
 * `AgentCli` *type* for the same reason.
 */
export const AGENT_CLIS = ['claude', 'antigravity', 'codex'] as const satisfies readonly AgentCli[];

/** Display labels for the agent CLIs, used in the selectors and the phase-row summary. */
export const CLI_LABELS: Record<AgentCli, string> = {
	claude: 'Claude',
	antigravity: 'Antigravity',
	codex: 'Codex',
};

/** Separator between targets in the one-line phase summary — reads as "then". */
const PRIORITY_SEPARATOR = ' ▸ ';

export function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The user-facing label for a model id (its capability label, or the id itself). */
export function modelLabel(cli: AgentCli, model: string): string {
	return capabilityFor(cli, model)?.label ?? model;
}

/**
 * A stored target normalized for display: a legacy combined antigravity model
 * string (`"Gemini 3.6 Flash (High)"`) becomes its logical id + reasoning so the
 * Model and Reasoning selectors render the right selections, and a model the
 * provider has retired reads as the live replacement it will actually launch on
 * (issue #892) rather than as an empty Model selector. Other values pass through
 * untouched.
 *
 * A target that omits `cli` while naming an antigravity model reads as
 * antigravity, mirroring the pin `AgentTargetSchema` applies on parse — without
 * it the CLI selector would show nothing chosen and the Model selector would be
 * disabled, for a phase the worker in fact runs on antigravity.
 */
function normalizeTarget(target: AgentTarget): AgentTarget {
	if (!target.model) return { ...target };
	const cli = target.cli ?? (isAntigravityModelValue(target.model) ? 'antigravity' : undefined);
	const { model, reasoning } = normalizeModelSelection(cli, target.model);
	return { ...target, cli, model, reasoning: target.reasoning ?? reasoning };
}

/** Whether a target selects anything at all — an untouched row selects nothing. */
function isSetTarget(target: AgentTarget): boolean {
	return Boolean(target.cli || target.model || target.reasoning);
}

/**
 * Project a stored per-phase config onto the editable target list. A config
 * written before `targets` existed carries its single selection in the top-level
 * `cli`/`model`/`reasoning` mirror instead; it reads as a one-element list, the
 * same migration `AgentConfigSchema` performs on parse.
 */
export function toTargetList(config: AgentConfig | undefined): AgentTarget[] {
	if (!config) return [];
	const stored = config.targets ?? [
		{ cli: config.cli, model: config.model, reasoning: config.reasoning },
	];
	return stored.filter(isSetTarget).map(normalizeTarget);
}

/**
 * The CLIs row `index` may select: every CLI no *other* row already claims, so a
 * phase names each CLI at most once (mirroring the schema's `targets` refine).
 */
export function availableClisFor(targets: AgentTarget[], index: number): AgentCli[] {
	const taken = new Set(targets.filter((_, i) => i !== index).map((target) => target.cli));
	return AGENT_CLIS.filter((cli) => !taken.has(cli));
}

/** The CLI a newly added target would take, or `undefined` when all are used. */
export function nextAvailableCli(targets: AgentTarget[]): AgentCli | undefined {
	return AGENT_CLIS.find((cli) => !targets.some((target) => target.cli === cli));
}

/** Whether another target can still be added (i.e. some CLI is unused). */
export function canAddTarget(targets: AgentTarget[]): boolean {
	return nextAvailableCli(targets) !== undefined;
}

/**
 * Append a target on the first unused CLI, at the lowest priority. Its model and
 * reasoning stay unset, meaning "that CLI's default model" — the same fallback an
 * unset selection has always had. A no-op once every CLI is used.
 */
export function addTarget(targets: AgentTarget[]): AgentTarget[] {
	const cli = nextAvailableCli(targets);
	return cli ? [...targets, { cli }] : targets;
}

export function removeTarget(targets: AgentTarget[], index: number): AgentTarget[] {
	return targets.filter((_, i) => i !== index);
}

/** Move one target one position up or down, changing its priority. */
export function moveTarget(
	targets: AgentTarget[],
	index: number,
	direction: 'up' | 'down',
): AgentTarget[] {
	const swapWith = direction === 'up' ? index - 1 : index + 1;
	if (index < 0 || index >= targets.length || swapWith < 0 || swapWith >= targets.length) {
		return targets;
	}
	const next = [...targets];
	[next[index], next[swapWith]] = [next[swapWith] as AgentTarget, next[index] as AgentTarget];
	return next;
}

/** Whether a target's reasoning level is still one its `(cli, model)` supports. */
function keepsReasoning(target: AgentTarget): boolean {
	if (!target.reasoning || !target.cli || !target.model) return false;
	return (reasoningChoicesFor(target.cli, target.model) as readonly string[]).includes(
		target.reasoning,
	);
}

/**
 * Apply one selector's change to a target, re-resolving the fields that depend on
 * it. The patch carries exactly the field that changed: a new `cli` drops a model
 * its catalog doesn't offer and always clears reasoning (a level is model-specific,
 * issue #180), and a new `model` keeps reasoning only when that model still
 * supports it. Out-of-range indexes are a no-op.
 */
export function patchTarget(
	targets: AgentTarget[],
	index: number,
	patch: Partial<AgentTarget>,
): AgentTarget[] {
	const current = targets[index];
	if (!current) return targets;
	const next: AgentTarget = { ...current, ...patch };
	if ('cli' in patch) {
		if (next.model && (!next.cli || !AGENT_MODELS[next.cli].includes(next.model))) {
			next.model = undefined;
		}
		next.reasoning = undefined;
	} else if ('model' in patch && !keepsReasoning(next)) {
		next.reasoning = undefined;
	}
	return targets.map((target, i) => (i === index ? next : target));
}

/**
 * The list as it should be persisted: rows that select nothing are dropped, and a
 * reasoning level without a model to validate it against goes with it (the schema
 * rejects one, and a stale level must not reach the server).
 */
export function cleanTargets(targets: AgentTarget[]): AgentTarget[] {
	return targets.filter(isSetTarget).map((target) => ({
		cli: target.cli,
		model: target.model,
		reasoning: target.model ? target.reasoning : undefined,
	}));
}

/**
 * A stable React key for a target row. The CLI identifies a row across reorders
 * (so the moved row keeps DOM identity and focus) and is unique — except in the
 * invalid duplicate-CLI state the screen renders an error for, where the repeat
 * is disambiguated by how many rows above it already claim that CLI.
 */
export function targetKey(targets: AgentTarget[], index: number): string {
	const cli = targets[index]?.cli ?? 'unset';
	const earlier = targets
		.slice(0, index)
		.filter((target) => (target.cli ?? 'unset') === cli).length;
	return earlier === 0 ? cli : `${cli}-${earlier}`;
}

/** Whether two targets select the same CLI — the state the schema's refine rejects. */
export function hasDuplicateCli(targets: AgentTarget[]): boolean {
	const clis = targets.map((target) => target.cli);
	return new Set(clis).size !== clis.length;
}

/**
 * Whether the locally-edited target list differs from the stored config —
 * position included, since order is priority. The stored side is projected
 * through {@link toTargetList} so a legacy single selection compares against the
 * one-element list the form shows for it, rather than reading as a change.
 */
export function areTargetsDirty(local: AgentTarget[], stored: AgentConfig | undefined): boolean {
	const localTargets = cleanTargets(local);
	const storedTargets = cleanTargets(toTargetList(stored));
	if (localTargets.length !== storedTargets.length) return true;
	return localTargets.some((target, i) => {
		const other = storedTargets[i];
		return (
			(target.cli ?? '') !== (other?.cli ?? '') ||
			(target.model ?? '') !== (other?.model ?? '') ||
			(target.reasoning ?? '') !== (other?.reasoning ?? '')
		);
	});
}

/** One target as a compact string — e.g. `Claude · Sonnet · High`. */
export function describeTarget(target: AgentTarget): string {
	const parts: string[] = [];
	if (target.cli) parts.push(CLI_LABELS[target.cli]);
	if (target.model) parts.push(target.cli ? modelLabel(target.cli, target.model) : target.model);
	if (target.reasoning) parts.push(capitalize(target.reasoning));
	return parts.join(' · ');
}

/**
 * The whole list as one line for the phase summary row, in priority order — e.g.
 * `Claude · Sonnet · High ▸ Codex · GPT-5.6 Terra`. Empty when nothing is set.
 */
export function summarizeTargets(targets: AgentTarget[]): string {
	return targets
		.map(describeTarget)
		.filter((text) => text.length > 0)
		.join(PRIORITY_SEPARATOR);
}
