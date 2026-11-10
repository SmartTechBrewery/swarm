/**
 * Human-readable display labels for the pipeline phases, used to build the
 * scannable `Phase <state> - <label>` lifecycle log lines — phase **started** /
 * **finished** / **failed** / **stopped** — that a human greps the worker log
 * for. Kept in one place so the phase orchestrators (which log "started" /
 * "finished") and the worker consumer (which logs "failed" / "stopped" from a
 * dynamic `trigger.phase`) render the exact same label for a given phase.
 */

import type { TriggerPhase } from '../triggers/types.js';

export const PHASE_LABELS: Record<TriggerPhase, string> = {
	planning: 'Planning',
	implementation: 'Implementation',
	review: 'Review',
	'respond-to-review': 'Respond-to-review',
	'respond-to-ci': 'Respond-to-CI',
	'resolve-conflicts': 'Resolve-conflicts',
	'resolve-problem': 'Resolve problem',
};

/** The display label for a pipeline phase (e.g. `implementation` → `Implementation`). */
export function phaseLabel(phase: TriggerPhase): string {
	return PHASE_LABELS[phase];
}
