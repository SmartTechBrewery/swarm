/**
 * The agent-less executor for a `worker-update` dispatch (issue #972) — the
 * durable queued unit that carries an operator's self-update request to the
 * machine it names.
 *
 * Modelled on `./merge-automation.ts`, the existing precedent for a dispatch
 * that carries no webhook event, resolves no trigger, provisions no worktree,
 * takes no project slot, and settles itself against the claimed dispatch record.
 * All this one does is ask the control plane — the side holding worker sockets —
 * to push the frame, and record what came of that.
 *
 * **Nothing is preempted.** It resolves no trigger, claims no task, takes no
 * project slot and touches no run but its own, so a phase already executing is
 * never cancelled, deferred or failed to make room for an update. That holds
 * because nothing was added, not because something checks.
 *
 * **The wait for an offline machine is unbounded, and that is a deliberate
 * divergence worth stating.** A `not-connected` push reschedules the dispatch
 * under the `worker-eligibility` wait reason — whose documented meaning ("some
 * worker cleared every structural check and is merely busy or offline, so time
 * alone clears the wait") is exactly right here — but every *other* row carrying
 * that reason spends a capped budget (`MAX_ELIGIBILITY_RECHECKS`, ~7 days) on the
 * way through `deferWorkerIneligible`. This executor never reaches that gate: it
 * calls `scheduleDispatchRetry` directly, from a branch that returns well before
 * `processJob` resolves a project or a trigger, so its attempt counter only ever
 * counts. That is intended — AC 5 says a request for a machine that is offline is
 * still there when the machine returns, the request itself lives on the `workers`
 * row, and re-targeting is the operator's cancel — but it does mean a queue row
 * labelled with a reason the rest of the system treats as expiring. The run's own
 * 6h `timeout_ms` and `failStaleRunningRuns` remain the only clock on the
 * *record*, and `settleWorkerUpdateRun` is deliberately unguarded on run status so
 * a machine answering later still corrects it (issue #971).
 */

import {
	completeDispatch,
	type DispatchRow,
	scheduleDispatchRetry,
} from '../db/repositories/dispatchesRepository.js';
import { publishDispatchWakeUp } from '../dispatch/dispatcher.js';
import { logger } from '../lib/logger.js';
import type { WorkerUpdateJob } from '../queue/jobs.js';
import type { WorkerUpdatePushResult } from '../router/worker-update-dispatch.js';

/**
 * How long a dispatch waits before re-offering the frame to a machine that was
 * not connected. A coded constant, like merge automation's own backoff: the
 * *primary* wake is the machine's reconnection
 * (`promoteWorkerUpdateDispatchForWorker`), and this is only the timed backstop
 * under it — for a machine that reconnects to a different router, or whose
 * socket-open hook lost its promotion to a crash window. Sized like
 * `ELIGIBILITY_RECHECK_INTERVAL_MS`, the cadence every other availability wait
 * re-checks on.
 */
export const WORKER_UPDATE_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

/** What a settled `worker-update` dispatch reports back to the consumer. */
export interface WorkerUpdateSettledOutcome {
	status: 'worker-update-settled';
	result: WorkerUpdatePushResult;
	workerId: string;
}

/**
 * The one collaborator this executor has: pushing a frame at a live socket. The
 * control plane supplies the real one (`pushPendingWorkerUpdate`,
 * `src/router/worker-update-dispatch.ts`), which is also where the row is re-read
 * and matched against the request this dispatch was created for.
 */
export interface WorkerUpdateDispatchCapabilities {
	push: (workerId: string, requestId: string) => Promise<WorkerUpdatePushResult>;
}

/**
 * Deliver one update request and settle its dispatch. Three branches, one per
 * push result:
 *
 * - `pushed` → `completed` with `worker-update-pushed`. The frame reached the
 *   machine; what it does with it is the daemon's, and the `runs` row (issue
 *   #971) is where that outcome lands.
 * - `superseded` → `completed` with `superseded`. The row moved on — a re-target,
 *   or a report already recorded — so there is nothing left to deliver.
 * - `not-connected` → `retry-scheduled` on `worker-eligibility`, with a wake-up
 *   republished for it. The request is still there when the machine returns, and
 *   the record saying why it could not be dispatched is a dispatch row carrying a
 *   wait reason — the same place every other undispatchable unit's is.
 */
export async function processWorkerUpdateDispatch(
	dispatch: DispatchRow,
	job: WorkerUpdateJob,
	capabilities: WorkerUpdateDispatchCapabilities,
): Promise<WorkerUpdateSettledOutcome> {
	const settled = (result: WorkerUpdatePushResult): WorkerUpdateSettledOutcome => ({
		status: 'worker-update-settled',
		result,
		workerId: job.workerId,
	});
	const result = await capabilities.push(job.workerId, job.requestId);

	if (result === 'pushed') {
		logger.info('Worker update: delivered the request to its machine', {
			dispatchId: dispatch.id,
			workerId: job.workerId,
			requestId: job.requestId,
			target: job.target,
		});
		await completeDispatch(dispatch.id, 'worker-update-pushed');
		return settled('pushed');
	}

	if (result === 'superseded') {
		logger.info('Worker update: the request this dispatch carried is no longer outstanding', {
			dispatchId: dispatch.id,
			workerId: job.workerId,
			requestId: job.requestId,
		});
		await completeDispatch(dispatch.id, 'superseded');
		return settled('superseded');
	}

	const lastError =
		`Machine '${job.workerId}' is not connected to the control plane, so the update to ` +
		`'${job.target}' could not be handed to it. The request is still outstanding and is ` +
		`delivered the moment the machine reconnects.`;
	const updated = await scheduleDispatchRetry(dispatch.id, {
		jobPayload: job,
		availableAt: new Date(Date.now() + WORKER_UPDATE_RECHECK_INTERVAL_MS),
		waitReason: 'worker-eligibility',
		attempt: dispatch.attempt + 1,
		runId: dispatch.runId ?? undefined,
		lastError,
	});
	if (!updated) {
		// Cancelled or re-targeted between the push and here — whoever settled it wins.
		logger.info('Worker update: the dispatch settled elsewhere before its retry was scheduled', {
			dispatchId: dispatch.id,
			workerId: job.workerId,
		});
		return settled('not-connected');
	}
	await publishDispatchWakeUp(updated);
	logger.info('Worker update: the machine is offline — the request waits for it to return', {
		dispatchId: dispatch.id,
		workerId: job.workerId,
		requestId: job.requestId,
		attempt: updated.attempt,
		availableAt: updated.availableAt.toISOString(),
	});
	return settled('not-connected');
}
