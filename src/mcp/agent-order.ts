/**
 * The pure half of the operator MCP server's phase-agent reorder tools (issue
 * #1349): naming a phase's `targets`, permuting them by those names, and telling
 * whether a recorded order is still a permutation of the current list.
 *
 * Nothing here may add, drop or edit a target — a reorder changes which target a
 * worker prefers, never what the phase may run on — so every function either
 * returns the *same* target objects in another order or refuses with the reason.
 */

import type { AgentTarget } from '../config/schema.js';

/**
 * A target as an audit row recorded it — read back from JSON, so only its
 * identifying strings are relied on.
 */
export interface RecordedTarget {
	cli?: string;
	model?: string;
	reasoning?: string;
}

/**
 * A target's name in an order: `<cli>/<model>` (`claude/opus`), or the CLI alone
 * when the target names no model. A target that names no CLI runs on the phase's
 * coded default and is named `default/<model>`. Unique within a phase, because a
 * phase names each CLI at most once (`AgentConfigSchema`).
 */
export function targetKey(target: RecordedTarget): string {
	const cli = target.cli ?? 'default';
	return target.model ? `${cli}/${target.model}` : cli;
}

/** Whether `entry` names `target`: its full {@link targetKey}, or its CLI alone. */
function names(entry: string, target: AgentTarget): boolean {
	return entry === targetKey(target) || (target.cli !== undefined && entry === target.cli);
}

export type ReorderResult = { ok: true; targets: AgentTarget[] } | { ok: false; reason: string };

/**
 * `targets` in the order `order` names them. Each entry is a {@link targetKey} or a
 * bare CLI, and `order` must name every current target exactly once — anything
 * that is not a permutation (an unknown name, a repeat, a missing target) is
 * refused with the current names, so the caller can correct it.
 */
export function reorderTargets(
	targets: readonly AgentTarget[],
	order: readonly string[],
): ReorderResult {
	const current = targets.map(targetKey).join(', ');
	if (targets.length === 0) {
		return { ok: false, reason: 'The phase has no targets to reorder.' };
	}
	const picked: number[] = [];
	for (const entry of order) {
		const index = targets.findIndex((target) => names(entry, target));
		if (index === -1) {
			return {
				ok: false,
				reason: `"${entry}" names none of the phase's targets (${current}).`,
			};
		}
		if (picked.includes(index)) {
			return {
				ok: false,
				reason: `"${entry}" names a target the order already placed (${targetKey(
					targets[index] as AgentTarget,
				)}).`,
			};
		}
		picked.push(index);
	}
	if (picked.length !== targets.length) {
		const missing = targets.filter((_, index) => !picked.includes(index)).map(targetKey);
		return {
			ok: false,
			reason: `The order must name every target exactly once; it leaves out ${missing.join(', ')}.`,
		};
	}
	return { ok: true, targets: picked.map((index) => targets[index] as AgentTarget) };
}

/** A target's full identity — CLI, model and reasoning — for comparing two lists. */
function identity(target: RecordedTarget): string {
	return JSON.stringify([target.cli ?? null, target.model ?? null, target.reasoning ?? null]);
}

/**
 * `current` in the order `recorded` lists them, when `recorded` is exactly a
 * permutation of `current` — the same targets, compared by CLI, model *and*
 * reasoning, each once. Anything else means the targets were edited since the
 * order was recorded, and re-applying it would silently undo that edit, so it is
 * refused.
 */
export function restoreOrder(
	current: readonly AgentTarget[],
	recorded: readonly RecordedTarget[],
): ReorderResult {
	const left = current.map(identity);
	const right = recorded.map(identity);
	const sortedRight = [...right].sort();
	const sameSet =
		left.length === right.length &&
		[...left].sort().every((value, index) => value === sortedRight[index]);
	if (!sameSet) {
		return {
			ok: false,
			reason:
				`The phase's targets changed since that order was recorded (now ${current
					.map(targetKey)
					.join(', ')}; recorded ${recorded.map(targetKey).join(', ')}), so it is no ` +
				'longer a permutation of them. Reorder them with `phase_agents_reorder` instead.',
		};
	}
	return {
		ok: true,
		targets: right.map((value) => current[left.indexOf(value)] as AgentTarget),
	};
}
