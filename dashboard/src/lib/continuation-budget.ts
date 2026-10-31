import type { PipelineConfig } from '../../../src/config/schema.js';
import { DEFAULT_MAX_CONTINUATIONS } from '../../../src/pipeline/continuation-budget.js';
import type { ProjectPhase } from './project-nav.js';

export { DEFAULT_MAX_CONTINUATIONS };

/**
 * The phases a checkpoint continuation can resume (issue #1259): the ones whose
 * prompt keeps a checkpoint because they edit a worktree
 * (`src/pipeline/prompts/checkpoint.ts`). Planning and Review write none, so the
 * continuation budget never extends them.
 */
export const CHECKPOINT_PHASES = [
	'implementationUnplanned',
	'implementation',
	'respondToReview',
	'respondToCi',
	'resolveConflicts',
] as const satisfies readonly ProjectPhase[];

const INVALID_MESSAGE = 'Enter a whole number of 1 or more, or leave it blank for the default.';

/** The Pipeline tab's field text for the stored budget — blank when it is unset. */
export function toMaxContinuationsInput(pipeline: PipelineConfig | undefined): string {
	return pipeline?.maxContinuations != null ? String(pipeline.maxContinuations) : '';
}

/**
 * Read the field: a positive integer, or `null` for blank — which saves as a
 * cleared value, i.e. back to {@link DEFAULT_MAX_CONTINUATIONS}.
 */
export function parseMaxContinuationsInput(
	input: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
	const trimmed = input.trim();
	if (trimmed === '') return { ok: true, value: null };
	if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) return { ok: false, error: INVALID_MESSAGE };
	return { ok: true, value: Number(trimmed) };
}

/**
 * The budget the field currently describes — what the worker would apply if it
 * were saved. An invalid entry describes nothing, so the stored value stands.
 */
export function effectiveMaxContinuations(input: string, stored: number | undefined): number {
	const parsed = parseMaxContinuationsInput(input);
	if (!parsed.ok) return stored ?? DEFAULT_MAX_CONTINUATIONS;
	return parsed.value ?? DEFAULT_MAX_CONTINUATIONS;
}

/**
 * Roughly the longest one phase may run: its first attempt plus one more per
 * continuation, each bounded by the same timeout. Approximate on purpose — a
 * native session resume or a usage-limit stop spends none of the budget.
 */
export function maxPhaseRunMinutes(timeoutMinutes: number, continuations: number): number {
	return timeoutMinutes * (1 + continuations);
}

/** `45 min`, `1 h 30 min`, `3 h` — the run-time column's unit. */
export function formatMinutes(minutes: number): string {
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours === 0) return `${rest} min`;
	return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
