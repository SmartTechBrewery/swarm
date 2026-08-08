/**
 * Pure view-logic for the **preserved-checkout pin** (issue #567), split out of
 * the run-detail route so it can be unit-tested without a rendered component (the
 * dashboard package tests helpers only — no jsdom; see `dashboard/vitest.config.ts`).
 *
 * A run whose checkout was preserved on one machine can only be continued there:
 * a Tier 2 checkpoint, a resumable agent session, and a delivery sidecar all live
 * in that machine's `.swarm-workspaces`, with no server-side copy. So when that
 * machine is busy or offline, the dispatch waits — with **no timeout**, because
 * every alternative silently discards the earlier attempt's work.
 *
 * That makes naming the machine a requirement rather than a nicety: an unbounded
 * wait with no explanation is indistinguishable from a wedged run, and the whole
 * point of the pin is that the operator, not a timer, decides to give the work up.
 */

import type { RunPreservedWorker } from '@/types/runs.js';

/** How to refer to the machine: its display name, or its id when the row is gone. */
export function preservedWorkerLabel(preserved: RunPreservedWorker): string {
	return preserved.workerName ?? preserved.workerId;
}

/**
 * The run-detail callout for a run pinned to a machine, or `null` when there is
 * nothing to say — no record at all, or a run that is no longer waiting on one.
 *
 * Three shapes:
 * - **waiting** (a retry-pending run) — the unbounded wait, so it names the
 *   machine, says the wait does not expire, and names the action that ends it.
 * - **preserved but not waiting** — the run is running or settled; the pin is
 *   still recorded, so state the machine without implying a wait.
 * - **abandoned** — the record an operator's restart left behind, which is what
 *   makes "this run started over instead of continuing" visible after the fact.
 */
export function describePreservedWorker(
	preserved: RunPreservedWorker | null | undefined,
	status: string,
): { title: string; body: string } | null {
	if (!preserved) return null;
	const machine = preservedWorkerLabel(preserved);
	if (preserved.state === 'abandoned') {
		return {
			title: 'Preserved work was discarded',
			body: `This run was restarted from scratch instead of continuing the work preserved on ${machine}. That earlier attempt's checkpoint, session and checkout were given up deliberately and are not part of this run.`,
		};
	}
	if (status === 'deferred' || status === 'checkpointed') {
		return {
			title: `Waiting for ${machine}`,
			body: `This run continues work preserved on ${machine}, so it can only run there — no other worker can pick it up, however free it is. The wait does not time out and nothing is started over elsewhere. Use "Reset & restart" to give the preserved work up and restart this phase on any worker; that works even while ${machine} is offline.`,
		};
	}
	return {
		title: `Preserved on ${machine}`,
		body: `This run's checkout is preserved on ${machine}. Continuing it runs there and nowhere else.`,
	};
}
