import { ALL_TRIGGER_PHASES } from '../../../src/triggers/types.js';

/**
 * The one display order for pipeline phases (issue #548). It is the pipeline's own
 * order — {@link ALL_TRIGGER_PHASES}, derived from `TRIGGER_PHASE_KEYS`
 * (`src/triggers/types.ts`) — stated nowhere else, so adding a seventh phase to the
 * vocabulary orders it on every screen at once instead of asking each list to be
 * re-sorted.
 *
 * Sorting happens at the render boundary because arrival order is not a display
 * contract: a same-host worker declares `ALL_TRIGGER_PHASES` while a remote DB-free
 * daemon declares `[...SUPPORTED_DB_FREE_PHASES]` — a `Set` written for the
 * readability of its own doc comment — and `workers.supported_phases` stores
 * whichever of the two it was handed. Two machines must not make the same screen
 * read differently.
 */

/** Each known phase's position in the pipeline's own order. */
const CANONICAL_POSITION = new Map<string, number>(
	ALL_TRIGGER_PHASES.map((phase, index) => [phase, index]),
);

/**
 * Anything outside the phase vocabulary ranks after every known phase rather than
 * being dropped: the read models mirror the vocabulary as plain strings
 * (`types/workers.ts`), so a daemon from a newer build can legitimately declare a
 * phase this dashboard has never heard of, and hiding it would misreport the
 * machine.
 */
function positionOf(phase: string): number {
	return CANONICAL_POSITION.get(phase) ?? ALL_TRIGGER_PHASES.length;
}

/**
 * The given phases in canonical order — a **sort**, not a projection over the whole
 * vocabulary: a worker declaring a subset (the version-skew case of issue #467)
 * comes back as that subset in canonical relative order, with nothing inserted for
 * the phases it does not declare. Contrast `enrollmentPhaseOptions`
 * (`./worker-enrollment-phases.ts`), which deliberately offers every phase.
 *
 * Takes `readonly string[]` and copies before sorting, so a React prop or a frozen
 * vocabulary can be passed straight in. Unknown values keep their arrival order
 * relative to each other (`Array.prototype.sort` is stable).
 */
export function sortPipelinePhases<T extends string>(phases: readonly T[]): T[] {
	return [...phases].sort((a, b) => positionOf(a) - positionOf(b));
}
