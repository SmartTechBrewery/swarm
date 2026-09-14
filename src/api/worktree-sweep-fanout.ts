/**
 * Fan the per-machine abandoned-worktree sweep request out to a **set** of
 * machines and report what became of each one (issue #956) — the fleet half of
 * issue #951, sitting beside `./worker-update-fanout.ts` and modelled on it.
 *
 * Nothing about the per-machine lifecycle moves here: each machine that is asked
 * gets the same row write (`requestWorktreeSweep`), the same `swarm:worktree-sweep`
 * publish, the same `worktree-sweep` frame and the same daemon handler issue #955
 * built. What is new is *which* machines are asked in one action.
 *
 * Two properties are carried over from the update fan-out verbatim, because they
 * are what make a fleet action usable at all:
 *
 * **One machine's state is never allowed to refuse the whole call.** Every machine
 * gets a {@link WorktreeSweepFanoutDisposition} and the call succeeds, so a failure
 * on one machine does not fail the sweep for the other eleven — which matters more
 * here than it does for an update, since the caller is a timer nobody is watching
 * (`./maintenance.ts`) rather than an operator reading a report.
 *
 * **Input order is preserved** and nothing here sorts: the caller hands over the
 * order its own read produced, and a report that re-ordered it would not line up
 * with the list it is read against.
 *
 * The dispositions reduce to three, because this request has neither of the two
 * things an update's five turn on — there is no drain precondition to refuse for
 * (a sweep disturbs no in-flight run, which is why `workers.requestWorktreeSweep`
 * has no `in-pool`), and no target, so there is no "already answered *for this
 * target*" to report.
 *
 * **Authorization is the caller's**, which is why this takes an already-resolved
 * worker list rather than a user id — the same shape `fanOutWorkerUpdate` takes, for
 * the same reason. Here the caller is the maintenance loop, which passes
 * `listAllWorkers()`.
 *
 * Waves, staging and halting are deliberately absent. Issue #951 states outright
 * that `./worker-update-rollout.ts` is more than this needs: a sweep has no bad-build
 * risk to stage against and takes no machine out of the dispatch pool, so there is
 * nothing for a wave to bound.
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { Worker, WorkerWorktreeSweepState } from '../identity/worker.js';
import { requestWorktreeSweep } from '../identity/worker-service.js';
import { getLiveSessionForWorker } from '../identity/worker-session-service.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { publishWorktreeSweepRequest } from '../queue/worker-sweeps.js';

/**
 * What became of one machine in a fan-out. Two of the three record a fresh
 * request; the third names a request that was left exactly as it was:
 *
 * - `requested` — recorded, and the machine has a live session, so the push is on
 *   its way.
 * - `queued-offline` — recorded; no live session, so the router states it again on
 *   the machine's next connection (`resendPendingWorktreeSweepToWorker`). This is
 *   the disposition that makes "a machine offline when the signal goes out is not
 *   skipped forever" true: the request is durable on the row.
 * - `already-asked` — an unanswered request is already outstanding; left as it is,
 *   request id and all. Overwriting it would mint a new request id for a sweep the
 *   machine may be running right now, defeating the daemon's own dedup, and would
 *   ask a machine that has been offline for a fortnight to sweep twice over.
 */
export const WORKTREE_SWEEP_FANOUT_DISPOSITIONS = [
	'requested',
	'queued-offline',
	'already-asked',
] as const;
export const WorktreeSweepFanoutDispositionSchema = z.enum(WORKTREE_SWEEP_FANOUT_DISPOSITIONS);
export type WorktreeSweepFanoutDisposition = z.infer<typeof WorktreeSweepFanoutDispositionSchema>;

/** One machine's line in a fan-out's report. */
export interface WorktreeSweepFanoutEntry {
	workerId: string;
	displayName: string;
	disposition: WorktreeSweepFanoutDisposition;
	/**
	 * The row's sweep state after the fan-out — the outstanding request, and the last
	 * outcome the machine reported, whichever disposition it got. Asking does not
	 * erase that outcome (`../db/repositories/workersRepository.ts`), which is why
	 * this needs no `lastReportedStatus` twin of the kind `WorkerUpdateFanoutEntry`
	 * carries: the update fan-out annotates the pre-request answer precisely because
	 * its own write destroys it, and here the post-write state already holds it.
	 * `null` only for a row nothing could be read back from, which the write below
	 * makes unreachable for the two recording dispositions.
	 */
	worktreeSweep: WorkerWorktreeSweepState | null;
}

/**
 * Ask every machine in `workers` to sweep its abandoned worktrees, and report one
 * entry per machine.
 *
 * Sequential rather than `Promise.all`, on the update fan-out's stated reason: a
 * fan-out across a fleet is a handful of row writes plus a publish each, and
 * serialising them keeps the Redis publishes — and so the router's pushes — in a
 * predictable order in the log.
 *
 * A machine whose write or publish **throws** is logged and left out of the report
 * rather than given a fourth disposition: the three above each name a durable state
 * the row is now in, and a machine whose write failed is in none of them. It is the
 * same treatment a machine deregistered mid-fan-out gets, and for the same reason —
 * there is nothing to say about it that the row would bear out. Leaving it out is
 * what keeps one machine's failure from costing the rest of the fleet its sweep.
 */
export async function fanOutWorktreeSweep(workers: Worker[]): Promise<WorktreeSweepFanoutEntry[]> {
	const entries: WorktreeSweepFanoutEntry[] = [];
	for (const worker of workers) {
		// The outstanding marker, read off the caller's snapshot: `requestId` is
		// non-null exactly while a request is unanswered (`recordWorktreeSweepReport`
		// clears it), so a machine carrying one is asked nothing further.
		if (worker.worktreeSweep?.requestId) {
			entries.push({
				workerId: worker.id,
				displayName: worker.displayName,
				disposition: 'already-asked',
				worktreeSweep: worker.worktreeSweep,
			});
			continue;
		}

		try {
			// One request id per machine, never one shared across the fan-out: a request
			// id names one request to one machine, and `recordWorktreeSweepReport`'s
			// `(worker_id, worktree_sweep_request_id)` match depends on that staying true.
			const requestId = randomUUID();
			const updated = await requestWorktreeSweep(worker.id, requestId);
			// Deregistered between the caller's read and this write. Left out of the
			// report rather than given a disposition: there is no machine left to say
			// anything about.
			if (!updated) continue;
			// Connectivity is `getLiveSessionForWorker` — the same definition the rosters
			// and the dispatch gate read, never `isWorkerConnected`, whose map is local to
			// one router process and answers nothing from the API server. It decides only
			// the *word* reported: the request is recorded and published either way, so a
			// machine that goes offline between this read and the push loses nothing.
			const live = await getLiveSessionForWorker(worker.id);
			// After the durable write and never guarded: `publishWorktreeSweepRequest`
			// swallows its own failures by contract, because the request lives on the row
			// and a router that misses the notification pushes it the moment the machine
			// next connects.
			await publishWorktreeSweepRequest(worker.id);
			entries.push({
				workerId: updated.id,
				displayName: updated.displayName,
				disposition: live ? 'requested' : 'queued-offline',
				worktreeSweep: updated.worktreeSweep,
			});
		} catch (err) {
			logger.error('worktree sweep fan-out: could not ask a machine to sweep', {
				workerId: worker.id,
				error: describeError(err),
			});
		}
	}
	return entries;
}
