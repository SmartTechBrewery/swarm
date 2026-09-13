/**
 * SWARM pipeline phases and the PM-status → phase mapping — provider-agnostic,
 * so the trigger and dispatch code never branch on a concrete PM provider
 * (ai/CODING_STANDARDS.md "Module shape for a provider").
 *
 * Only two of the pipeline phases (ai/ARCHITECTURE.md "Pipeline phases") are
 * entered by a *board status change*: Planning (item → "Planning") and
 * Implementation (item → "ToDo" — a human reviews the plan Planning posted,
 * then moves the item here to greenlight it; the phase itself reports back to
 * "In progress" once it picks the task up, but that move is a status report,
 * not a trigger). The rest — Review, Respond-to-review,
 * and Respond-to-CI — are driven by SCM events (a PR opening / a check suite
 * completing / a review being submitted), not by the PM board, so they have no
 * entry in this map. That asymmetry is intentional: this map is exactly the set
 * of statuses whose transition should fire a PM `status-changed` trigger.
 *
 * Keys are the canonical SWARM pipeline status keys (the same ones the config's
 * `statusOptions` map and `ListWorkItemsFilter.status` use — `src/pm/types.ts`),
 * not a provider's opaque option IDs. Mapping a provider's option ID to one of
 * these keys is the adapter's job (each provider owns that translation).
 */

/** A pipeline phase that a board status change can trigger. */
export type PipelinePhase = 'planning' | 'implementation';

/**
 * The canonical SWARM pipeline status keys — the single source of truth for the
 * string keys a project's `statusOptions` map (`config-schema.ts`),
 * `ListWorkItemsFilter.status` (`src/pm/types.ts`), and `PM_STATUS_TO_PHASE`
 * below all speak in. They mirror the board's Status options one-for-one
 * (ai/RULES.md §5: Backlog, Planning, ToDo, In progress, In review, Done) so a
 * config authored against the board can't drift from the map that reads it.
 *
 * These are *canonical keys*, not a closed set the config must match exactly:
 * `statusOptions` stays an open record (a board may add or omit options), and
 * the adapter translates a board option ID to one of these keys. Keeping them
 * here, referenced by the config-schema doc and the test factory, is what keeps
 * the key spelling from diverging (the drift that once silently disabled the
 * Planning trigger).
 */
export const PM_STATUS_KEYS = [
	'backlog',
	'planning',
	'todo',
	'inProgress',
	'inReview',
	'done',
] as const;

/** A canonical SWARM pipeline status key (one of {@link PM_STATUS_KEYS}). */
export type PmStatusKey = (typeof PM_STATUS_KEYS)[number];

/**
 * Canonical pipeline status key → the phase entering that status triggers.
 * A status key absent here (`backlog`, `inProgress`, `inReview`, `done`) is a
 * valid board status that simply doesn't start a PM-driven phase — notably
 * `inProgress`, which the Implementation phase itself moves an item *to* as a
 * status report, not a trigger; entering it manually doesn't (re-)start
 * anything. Typed against {@link PmStatusKey} so a mis-spelled key (e.g. the
 * old `ready`) fails to compile rather than silently never matching.
 */
export const PM_STATUS_TO_PHASE: Readonly<Partial<Record<PmStatusKey, PipelinePhase>>> = {
	planning: 'planning',
	todo: 'implementation',
};

/**
 * The pipeline phase a canonical status key triggers, or `undefined` when the
 * status doesn't start a PM-driven phase — a "not applicable" lookup, not an
 * error (ai/CODING_STANDARDS.md "Error handling").
 */
export function resolvePipelinePhaseForStatusKey(statusKey: string): PipelinePhase | undefined {
	// `statusKey` is an arbitrary string resolved from a board option ID, so the
	// lookup is intentionally widened past `PmStatusKey` — an unrecognized key is
	// a valid "not applicable" miss (returns `undefined`), not a type error.
	return (PM_STATUS_TO_PHASE as Readonly<Record<string, PipelinePhase>>)[statusKey];
}

/**
 * Every phase a board status can start — the runtime list behind
 * {@link PM_STATUS_TO_PHASE}'s values, which {@link PipelinePhase} is the type
 * of. Exists because a *query* needs the set as data (issue #909): the board
 * move that retires a card's stale queued phase must ask the dispatch table for
 * board-driven rows only, so an SCM-driven phase sharing the task id — a
 * `review` keyed on `task-<pr>` — is never swept up by a card's move.
 *
 * Typed `satisfies readonly PipelinePhase[]` so adding a board-driven phase to
 * the map above without adding it here fails to compile rather than silently
 * leaving the new phase un-retirable.
 */
export const BOARD_DRIVEN_PHASES = [
	'planning',
	'implementation',
] as const satisfies readonly PipelinePhase[];

/**
 * Statuses a *phase* writes about itself rather than an operator asking for one.
 * Implementation reports `inProgress` when it picks the task up (see
 * {@link PM_STATUS_TO_PHASE}'s own note), so a board event observing that status
 * says nothing about which phase is wanted — and must never retire a queued
 * phase (issue #909), in particular not the reporting phase's own deferred
 * retry, which resumes from the very event that observes In progress.
 *
 * Deliberately *not* the complement of {@link PM_STATUS_TO_PHASE}: `backlog`,
 * `inReview` and `done` also start no phase, but each of them is an operator
 * instruction — "stop working on this" — and retires a queued phase like any
 * other move.
 */
export const PM_PHASE_REPORTED_STATUS_KEYS = [
	'inProgress',
] as const satisfies readonly PmStatusKey[];

/**
 * Whether a status key is one a phase reports about itself
 * ({@link PM_PHASE_REPORTED_STATUS_KEYS}). Widened past {@link PmStatusKey} for
 * the same reason {@link resolvePipelinePhaseForStatusKey} is: the key comes
 * from an opaque board option, so an unrecognized or absent one is a valid miss
 * — and answers `false`, because it is not a phase's own report.
 */
export function isPhaseReportedStatusKey(statusKey: string | undefined): boolean {
	return (PM_PHASE_REPORTED_STATUS_KEYS as readonly string[]).includes(statusKey ?? '');
}
