/**
 * Fan the per-worker self-update request out to a **set** of machines and report
 * what became of each one (issue #921) — the control-plane policy
 * `workers.requestUpdateForMine` and `workers.requestUpdateForInstallation` (issue
 * #922) both program against, sitting beside the other `src/api/` helper modules
 * (`./worker-access.ts`, `./scm-verification.ts`) rather than inside a router.
 *
 * Nothing about the per-worker lifecycle moves here: each machine that is asked
 * gets the same row write (`requestWorkerUpdate`), the same `swarm:worker-update`
 * publish, the same `worker-update` frame and the same daemon decision layer
 * issue #933 built. What is new is *which* machines are asked in one action, and
 * a vocabulary for the ones that are deliberately not.
 *
 * **One machine's state is never allowed to refuse the whole call.**
 * `workers.requestUpdate` throws `CONFLICT` for a machine still in the dispatch
 * pool, which is right for a call about one machine and wrong for a fleet action:
 * one un-drained machine out of twelve would abort the request and tell the
 * operator nothing about the other eleven. So this module throws for no machine's
 * state — every machine gets a {@link WorkerUpdateFanoutDisposition}, and the call
 * succeeds.
 *
 * **Re-running the fan-out is the readout.** A machine that has already answered
 * for this same target is returned as `answered` rather than sent back through an
 * apply it has already done, and a machine with an outstanding request for this
 * same target keeps its existing `requestId` — so no second push is made and the
 * daemon's own dedup is never relied on to paper over a duplicate the control
 * plane could have avoided. A pending request for a *different* target is
 * overwritten and reported as `requested`: that is `requestUpdate`'s documented
 * re-issue semantics, and it is the one an operator moving a fleet to `target`
 * wants, since a stale request for some other build must not survive the fleet
 * action. Retrying one machine that reported `failed` stays
 * `swarm workers update <worker-id> <ref>`, which overwrites unconditionally.
 *
 * **The draining precondition is enforced by the write, not by the snapshot.** A
 * fleet action reads its machines once and then writes to them one at a time, so the
 * `drainingSince` on the list it was handed is stale the moment another session runs
 * `swarm workers undrain`. The eligibility test therefore lives in
 * `requestWorkerUpdate`'s own `WHERE` (issue #921), which declines the write and
 * reports `in-pool` — the same single boundary `workers.requestUpdate` refuses on —
 * so a machine returned to the dispatch pool mid-fan-out is reported rather than
 * queued for a restart it is no longer drained for. The snapshot check kept here is
 * an optimisation: it saves a pointless write and session lookup for a machine that
 * was already in the pool when the list was read.
 *
 * **Authorization is the caller's**, which is why this takes an already-resolved
 * worker list rather than a user id: every other worker mutation makes that
 * decision in the router, and the administrator-facing selection issue #922 decided
 * on is a different *selection* over this same fan-out rather than a second copy of
 * it. That is exactly how `workers.requestUpdateForInstallation` is built — it hands
 * over `listAllWorkers()` where the owner-scoped caller hands over
 * `listWorkersForOwner`, and nothing here knows or cares which it was given.
 *
 * `requestedByUserId` travels separately from that list for the same reason (issue
 * #922): it is *who asked*, not *what was asked of*, and once those two can name
 * different people the row has to record the asker rather than let a reader infer it
 * from the machine's owner. It is threaded through to the durable write, so every
 * disposition that records a request records who it was for.
 *
 * Waves, staging, halting and the drain/undrain automation around them are
 * deliberately **not** here — they are phases 2 and 3 of issue #921, with their own
 * durable state. This module asks, once, and reports.
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { Worker, WorkerUpdateState } from '../identity/worker.js';
import { requestWorkerUpdate } from '../identity/worker-service.js';
import { getLiveSessionForWorker } from '../identity/worker-session-service.js';
import type { WorkerUpdateStatus } from '../lib/build-identity.js';
import { publishWorkerUpdateRequest } from '../queue/worker-updates.js';

/**
 * What became of one machine in a fan-out. Two of the five record a request
 * (`requested`, `queued-offline`); the other three name a state that was left
 * exactly as it was:
 *
 * - `requested` — recorded, and the machine has a live session, so the push is on
 *   its way.
 * - `queued-offline` — recorded; no live session, so the router states it again on
 *   the machine's next connection (`resendPendingWorkerUpdateToWorker`).
 * - `in-pool` — skipped: the machine is not draining, so asking it would give it
 *   new work while it waits to restart. The remedy is `swarm workers drain <id>`,
 *   exactly as `requestUpdate`'s own refusal names it.
 * - `already-asked` — an unanswered request for **this same target** is already
 *   outstanding; left as it is, request id and all.
 * - `answered` — the machine already reported an outcome for **this exact
 *   target**; the outcome is returned rather than the machine re-asked.
 */
export const WORKER_UPDATE_FANOUT_DISPOSITIONS = [
	'requested',
	'queued-offline',
	'in-pool',
	'already-asked',
	'answered',
] as const;
export const WorkerUpdateFanoutDispositionSchema = z.enum(WORKER_UPDATE_FANOUT_DISPOSITIONS);
export type WorkerUpdateFanoutDisposition = z.infer<typeof WorkerUpdateFanoutDispositionSchema>;

/** One machine's line in a fan-out's report. */
export interface WorkerUpdateFanoutEntry {
	workerId: string;
	displayName: string;
	disposition: WorkerUpdateFanoutDisposition;
	/**
	 * The outcome this machine had last reported **before** this fan-out (issue
	 * #922), or `null` when it had never answered one.
	 *
	 * It exists because asking a machine *destroys* the previous answer: a recorded
	 * request resets `update_status` to NULL, so {@link WorkerUpdateFanoutEntry.update}
	 * below carries no outcome for any machine that was just asked. The one an
	 * operator most needs to keep is `declined` — the machine's own statement that its
	 * host has not set `SWARM_WORKER_SELF_UPDATE`, which is the only place an opt-out
	 * is visible from the control plane at all — so a report that dropped it would
	 * leave an installation administrator unable to say which owners have opted out.
	 *
	 * It is a *report* annotation and deliberately not a disposition: a machine that
	 * declined is still asked again, because its owner may have opted in since, and
	 * the answer to that arrives later on the machine's own route.
	 */
	lastReportedStatus: WorkerUpdateStatus | null;
	/**
	 * The row's update state **after** the fan-out — the target, and the outcome
	 * when one is recorded. `null` for a machine nobody has ever asked, which is what
	 * a never-drained `in-pool` row says; an `in-pool` machine that was asked on some
	 * earlier drain still carries that older request's state here.
	 */
	update: WorkerUpdateState | null;
}

/**
 * Ask every machine in `workers` that is eligible for it to move to `target`, and
 * report one entry per machine.
 *
 * Input order is preserved and nothing here sorts: the caller hands over the order
 * its own read produced (`listWorkersForOwner`, which is what `swarm workers list
 * <me>` already prints), and a report that re-ordered it would not line up with the
 * list the operator read it against.
 *
 * Sequential rather than `Promise.all`: a fan-out across a fleet is a handful of row
 * writes plus a publish each, and serialising them keeps the Redis publishes — and
 * so the router's pushes — in a predictable order in the log.
 */
export async function fanOutWorkerUpdate(
	workers: Worker[],
	target: string,
	requestedByUserId: string,
): Promise<WorkerUpdateFanoutEntry[]> {
	const entries: WorkerUpdateFanoutEntry[] = [];
	for (const worker of workers) {
		// Read off the caller's snapshot, before the write below can reset it (issue
		// #922) — see the field's own comment for why the pre-request answer is the one
		// an operator needs kept.
		const lastReportedStatus = worker.update?.status ?? null;
		const skipped = dispositionWithoutAsking(worker, target);
		if (skipped) {
			entries.push({
				workerId: worker.id,
				displayName: worker.displayName,
				disposition: skipped,
				lastReportedStatus,
				update: worker.update,
			});
			continue;
		}

		// One request id per machine, never one shared across the fan-out: a request id
		// names one request to one machine, and `recordWorkerUpdateReport`'s
		// `(worker_id, update_request_id)` match depends on that reading staying true.
		const requestId = randomUUID();
		const result = await requestWorkerUpdate(worker.id, requestId, target, requestedByUserId);
		// The machine was deregistered between the caller's read and this write. It is
		// left out of the report rather than given a disposition: there is no machine
		// left to say anything about, and the operator's own list no longer carries it
		// either.
		if (result.outcome === 'not-found') continue;
		// Undrained between the caller's read and this write — `swarm workers undrain`
		// from another session, say. The write's own `draining_since IS NOT NULL`
		// predicate declined it, so nothing was recorded and nothing is published, and
		// the machine is reported exactly as the snapshot check above reports one that
		// was already in the pool when the list was read. This is why the check above is
		// an optimisation rather than the guarantee: a fleet action reads its machines
		// once and then writes to them one at a time, so every machine after the first
		// is being decided on a snapshot that a concurrent undrain can have invalidated.
		if (result.outcome === 'in-pool') {
			entries.push({
				workerId: result.worker.id,
				displayName: result.worker.displayName,
				disposition: 'in-pool',
				lastReportedStatus,
				update: result.worker.update,
			});
			continue;
		}
		const updated = result.worker;
		// Connectivity is `getLiveSessionForWorker` — the same definition the rosters
		// and the dispatch gate read, never `isWorkerConnected`, whose map is local to
		// one router process and answers nothing at all from the API server. It decides
		// only the *word* reported: the request is recorded and published either way, so
		// a machine that goes offline between this read and the push loses nothing. Read
		// after the write, so a machine that was not asked costs no session lookup.
		const live = await getLiveSessionForWorker(worker.id);
		// After the durable write and never guarded: `publishWorkerUpdateRequest` swallows
		// its own failures by contract, because the request lives on the row and a router
		// that misses the notification pushes it the moment the machine next connects.
		await publishWorkerUpdateRequest(worker.id);
		entries.push({
			workerId: updated.id,
			displayName: updated.displayName,
			disposition: live ? 'requested' : 'queued-offline',
			lastReportedStatus,
			update: updated.update,
		});
	}
	return entries;
}

/**
 * The disposition of a machine that is **not** asked on the strength of the caller's
 * own snapshot, or `undefined` when it is asked.
 *
 * The draining check is issue #933's precondition, unrelaxed: the daemon waits for
 * its in-flight phases to finish before it applies anything, and only draining
 * stops new work being dispatched into that wait. It is repeated here only to skip
 * the write and the session lookup for a machine already known to be in the pool —
 * the *enforcing* copy is the `draining_since IS NOT NULL` predicate on
 * `requestWorkerUpdate`'s own `WHERE`, which is the only one a concurrent undrain
 * cannot get in front of. The other two turn on the row
 * already naming this exact target — `requestId` is the outstanding marker
 * (`recordWorkerUpdateReport` clears it), so a non-null one is a request nobody has
 * answered and a reported `status` beside a null one is an answer already given.
 * A row naming any *other* target says nothing about this one and is overwritten.
 */
function dispositionWithoutAsking(
	worker: Worker,
	target: string,
): WorkerUpdateFanoutDisposition | undefined {
	if (!worker.drainingSince) return 'in-pool';
	const current = worker.update;
	if (!current || current.target !== target) return undefined;
	if (current.requestId) return 'already-asked';
	if (current.status) return 'answered';
	return undefined;
}
