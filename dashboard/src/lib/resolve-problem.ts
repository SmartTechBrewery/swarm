import {
	DEFAULT_RESOLVE_PROBLEM_MAX_WRITE_ACTIONS,
	RESOLVE_PROBLEM_MAX_WRITE_ACTIONS_LIMIT,
} from '../../../src/config/resolve-problem.js';
import type { PipelineConfig } from '../../../src/config/schema.js';

export { DEFAULT_RESOLVE_PROBLEM_MAX_WRITE_ACTIONS, RESOLVE_PROBLEM_MAX_WRITE_ACTIONS_LIMIT };

const INVALID_MESSAGE = `Enter a whole number from 1 to ${RESOLVE_PROBLEM_MAX_WRITE_ACTIONS_LIMIT}, or leave it blank for the default.`;

/**
 * The Resolve problem screen's "Write actions per run" text for the stored cap
 * (`pipeline.resolveProblem.maxWriteActions`, issue #1384) — blank when it is unset.
 */
export function toMaxWriteActionsInput(pipeline: PipelineConfig | undefined): string {
	const stored = pipeline?.resolveProblem?.maxWriteActions;
	return stored != null ? String(stored) : '';
}

/**
 * Read the field: a whole number from 1 to the schema's limit, or `null` for blank —
 * which saves as a cleared value, i.e. back to the default.
 */
export function parseMaxWriteActionsInput(
	input: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
	const trimmed = input.trim();
	if (trimmed === '') return { ok: true, value: null };
	const value = Number(trimmed);
	if (!/^\d+$/.test(trimmed) || value < 1 || value > RESOLVE_PROBLEM_MAX_WRITE_ACTIONS_LIMIT) {
		return { ok: false, error: INVALID_MESSAGE };
	}
	return { ok: true, value };
}

/**
 * The field text to re-seed from a freshly loaded project, or `undefined` to leave
 * the field alone: re-seeded on the first load and whenever the *stored cap* moved,
 * so another `pipeline` write (the phase's own Enabled toggle) keeps an unsaved edit.
 */
export function maxWriteActionsInputToSync(
	previous: PipelineConfig | undefined,
	next: PipelineConfig | undefined,
	firstLoad: boolean,
): string | undefined {
	const stored = toMaxWriteActionsInput(next);
	return firstLoad || stored !== toMaxWriteActionsInput(previous) ? stored : undefined;
}

/** Whether the field differs from the stored cap. Raw text, so an invalid entry is still an edit. */
export function isMaxWriteActionsDirty(
	input: string,
	pipeline: PipelineConfig | undefined,
): boolean {
	return input.trim() !== toMaxWriteActionsInput(pipeline);
}

/**
 * The `pipeline` patch that saves the field alongside the Agents tab's Save Changes,
 * or `undefined` when the field is unchanged or invalid. `maxWriteActions: null`
 * clears a stored cap; `projects.update` merges the patch, so `enabled` is untouched.
 */
export function toMaxWriteActionsPatch(
	input: string,
	pipeline: PipelineConfig | undefined,
): { resolveProblem: { maxWriteActions: number | null } } | undefined {
	if (!isMaxWriteActionsDirty(input, pipeline)) return undefined;
	const parsed = parseMaxWriteActionsInput(input);
	if (!parsed.ok) return undefined;
	return { resolveProblem: { maxWriteActions: parsed.value } };
}
