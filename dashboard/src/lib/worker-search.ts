/**
 * The workers roster's text filter (issue #897). `workers.list` returns the whole
 * roster the viewer may see in one response, so narrowing it is a pure function
 * over rows the browser already holds — no new query shape, and no server round
 * trip per keystroke.
 *
 * Kept side-effect-free in `lib/` so it unit-tests in the node environment,
 * matching the other `dashboard/src/lib/*.test.ts` helpers.
 */

import type { WorkerRow } from '@/types/workers.js';

/**
 * The fields a query is matched against: the machine's own name plus the two
 * facts an operator uses to tell one machine from another when the names are
 * similar — who owns it (both the display name and the identifier the Owner cell
 * shows on hover) and which repository it checked out.
 *
 * Matched field-by-field rather than against one joined string, so a query never
 * matches across a boundary between two unrelated facts.
 */
function searchableFields(worker: WorkerRow): (string | null | undefined)[] {
	return [
		worker.displayName,
		worker.owner?.displayName,
		worker.owner?.identifier,
		worker.repository,
	];
}

/** Case-insensitive substring match; an empty (or whitespace-only) query matches everything. */
export function workerMatchesSearch(worker: WorkerRow, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (needle === '') return true;
	return searchableFields(worker).some((field) => field?.toLowerCase().includes(needle) ?? false);
}

/**
 * The rows a query leaves visible, in the order they were given — the roster's
 * order is the server's (a project's configured dispatch preference, issue #750),
 * and filtering never re-sorts it.
 *
 * An empty query returns the same array, so clearing the input restores the
 * caller's own list rather than a copy of it.
 */
export function filterWorkersBySearch(workers: WorkerRow[], query: string): WorkerRow[] {
	if (query.trim() === '') return workers;
	return workers.filter((worker) => workerMatchesSearch(worker, query));
}
