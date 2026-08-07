/**
 * Poll cadence for the Runs list. The list must keep polling even when no run is
 * currently `running`, because each pipeline phase is a *separate* run row
 * (src/worker/consumer.ts creates one row per phase): a phase transition inserts
 * a brand-new `running` row that a poll-only-while-running loop would never pick
 * up (issue #123). So we poll fast while a run is active and on a slower baseline
 * otherwise — never stopping entirely.
 */
export const RUNS_ACTIVE_REFETCH_MS = 2_000;
export const RUNS_IDLE_REFETCH_MS = 5_000;

/**
 * Row shape we depend on — just the status field. Kept structural so callers can
 * pass the tRPC list payload directly.
 */
interface RunStatusRow {
	status: string;
}

/**
 * Chooses the Runs-list poll interval from the currently-loaded page. Returns a
 * positive number in ALL cases (never `false`/0), so a phase transition surfaces
 * within at most `RUNS_IDLE_REFETCH_MS`.
 */
export function runsListRefetchInterval(data?: { data?: RunStatusRow[] } | null): number {
	const hasRunning = data?.data?.some((run) => run.status === 'running') ?? false;
	return hasRunning ? RUNS_ACTIVE_REFETCH_MS : RUNS_IDLE_REFETCH_MS;
}

/**
 * Poll cadence for the Queued section (issue #238). Same never-stop-polling
 * contract as {@link runsListRefetchInterval}: poll fast while work is queued so
 * a picked-up job disappears promptly, and keep polling on the idle baseline when
 * the queue is empty so newly-enqueued work still surfaces without a manual
 * refresh. Returns a positive number in all cases (never `false`/0). Kept
 * structural on `length` so the queue half of the `runs.queued` payload
 * (`data.items`) can be passed straight through — the board dispatches it reports
 * as starting no phase (issue #570) are not pending work and don't set the pace.
 */
export function queuedListRefetchInterval(items?: { length: number } | null): number {
	const hasQueued = (items?.length ?? 0) > 0;
	return hasQueued ? RUNS_ACTIVE_REFETCH_MS : RUNS_IDLE_REFETCH_MS;
}
