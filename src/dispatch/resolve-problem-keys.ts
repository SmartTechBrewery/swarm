/**
 * The dedup identities of Resolve problem dispatches (issues #1395, #1425) — pure,
 * so the WIP read model (`../queue/wip-usage.ts`) can name the dispatch a holder's
 * attempt is queued under without importing the phase's database half
 * (`./resolve-problem.ts`, which re-exports both).
 */

/**
 * The dedup identity of a Resolve problem dispatch: the failed run, never the task
 * — the attempt is about that one run, and a second request for it is the same
 * attempt.
 */
export function resolveProblemDedupKey(failedRunId: string): string {
	return `resolve-problem:${failedRunId}`;
}

/**
 * The dedup identity of a ticket attempt on a stuck ticket that never ran (issue
 * #1425): the slot itself — project, repository, task and the instant it opened —
 * so a re-opened slot is a new situation and the same slot never gets a second
 * attempt. A ticket that has run is keyed on its latest run instead
 * ({@link resolveProblemDedupKey}).
 */
export function resolveProblemTicketDedupKey(slot: {
	projectId: string;
	repository: string;
	taskId: string;
	slotOpenedAt: string;
}): string {
	return `resolve-problem:slot:${slot.projectId}:${slot.repository}:${slot.taskId}:${Date.parse(slot.slotOpenedAt)}`;
}
