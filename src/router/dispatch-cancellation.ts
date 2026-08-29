/**
 * Control-plane delivery of a user termination to the worker actually running the
 * run (issue #549). The dashboard's Terminate action records the run id in the
 * durable Redis marker and publishes it (`../queue/cancellation.ts`); the only
 * subscriber used to be the in-process BullMQ executor, which a transport-
 * dispatched run never reached — so such a run kept working until its own
 * wall-clock timeout, and a DB-free worker could not have read the marker even if
 * it had been told to look. (That executor is gone entirely since issue #553; this
 * bridge is now the only delivery path there is.)
 *
 * This module is the bridge: a cancellation names a *run*, the transport addresses
 * a *worker* and a *dispatch*, so it resolves one to the other through the
 * dispatcher's own registration (`./dispatch-results.ts`) and pushes a
 * `task-cancel` frame down that worker's socket (`./worker-connections.ts`). The
 * worker aborts the in-flight agent and settles the dispatch terminal-`failed`
 * with `cancelled: true`, which `./dispatcher.ts` turns back into a
 * `RunTerminatedError` for the shared settle path — and since issue #724 it
 * answers the same way when the phase is *no longer* executing there, which is why
 * the frame carries the phase and task the registration recorded: a terminal
 * result frame requires both.
 *
 * Best-effort by design, exactly as the notification it rides is: a run this
 * router is not executing (queued, deferred, already settled, or dispatched from
 * another router) resolves to nothing and the push is skipped. The durable marker
 * remains the source of truth for *whether* a run was cancelled — `processJob`
 * reads it when the phase fails — so a missed push costs promptness, never
 * correctness.
 *
 * Best-effort still, but no longer unbounded (issue #827). A failed push alone is
 * ambiguous — the socket may have blipped and the worker may reconnect and report —
 * so that case keeps waiting out the phase's own agent timeout. A failed push to a
 * worker with **no active `worker_sessions` row** is strictly more information than
 * "haven't heard back yet": the phase cannot be executing there, and nothing was
 * ever going to settle the run. Such a run is settled after
 * `SWARM_OFFLINE_WORKER_CANCEL_TIMEOUT_MS` (default 1 minute) instead. Live repro
 * that prompted it: 2026-08-29, `rover` task 5's `planning` phase on worker
 * `jacek_tp_rover`, whose transport session had been released minutes before the
 * Terminate — the marker and origin were recorded, the push failed, and the run row
 * stayed `running` until it was settled by hand in Postgres.
 */

import { getLiveSessionForWorker } from '../identity/worker-session-service.js';
import { optionalEnv } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { RUN_CANCELLED_MESSAGE, subscribeToRunCancellations } from '../queue/cancellation.js';
import {
	failDispatchResultWait,
	type RunDispatchTarget,
	resolveDispatchTargetForRun,
} from './dispatch-results.js';
import { sendToWorker } from './worker-connections.js';

/**
 * The `reason` carried on the pushed frame. It is for the daemon's log only — the
 * run's terminal message is the control plane's own neutral `RUN_CANCELLED_MESSAGE`
 * (issue #305), applied when the worker's `cancelled` result comes back — so it
 * names no actor and asserts no origin.
 */
const CANCEL_FRAME_REASON = 'a cancellation was requested for this run';

/**
 * Default wait before a terminated run whose worker holds no live session at all is
 * settled here rather than at the phase's own agent timeout (issue #827). A minute
 * is long enough for a worker that is merely mid-reconnect to re-handshake — which
 * ends the wait through the superseded-claim reap instead — and short enough that a
 * run nothing can possibly report on does not sit `running` for tens of minutes.
 */
export const DEFAULT_OFFLINE_WORKER_CANCEL_TIMEOUT_MS = 60_000;

/** Resolve that wait from the environment, mirroring the sibling dispatch timeouts. */
export function resolveOfflineWorkerCancelTimeoutMs(
	raw = optionalEnv(
		'SWARM_OFFLINE_WORKER_CANCEL_TIMEOUT_MS',
		String(DEFAULT_OFFLINE_WORKER_CANCEL_TIMEOUT_MS),
	),
): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(
			`SWARM_OFFLINE_WORKER_CANCEL_TIMEOUT_MS must be a positive integer, got '${raw}'`,
		);
	}
	return value;
}

/** Resolved once (validates the env var at load), like the sibling dispatch timeouts. */
const OFFLINE_WORKER_CANCEL_TIMEOUT_MS = resolveOfflineWorkerCancelTimeoutMs();

/**
 * Bound the wait for a termination that could not be pushed, but only once the
 * worker is *confirmed* to hold no live session (issue #827).
 *
 * The settle rides the seam this router already owns for a wait whose outcome can
 * no longer arrive (`failDispatchResultWait`, issue #719): the synthetic terminal
 * frame carries `cancelled: true`, so `adaptResultToPhaseRun` raises a
 * `RunTerminatedError` and the run settles down the *same* path a worker-reported
 * cancellation does — `failed`, the neutral reason, the recorded origin, a
 * `user-terminated` diagnosis — releasing the parked BullMQ job and every capacity
 * the dispatch holds along with the rows. No new settle path and no new policy.
 *
 * The timer needs neither cancelling nor a re-check. A real result arriving first
 * consumes the registration, so the late timer finds nothing and is a silent no-op;
 * a worker that reconnects inside the minute must re-acquire its session, which
 * bumps the fencing token and ends the wait through the handshake's own superseded-
 * claim reap. (The one path left — the same dispatch record being re-pushed inside
 * the minute — is only reachable for a run the user has already terminated, whose
 * fresh push `pushAndAwaitResult`'s post-push marker read cancels anyway.)
 */
async function settleWhenWorkerHoldsNoSession(
	runId: string,
	target: RunDispatchTarget,
): Promise<void> {
	let live: unknown;
	try {
		live = await getLiveSessionForWorker(target.workerId);
	} catch (err) {
		// Fail safe into today's behaviour: an unreadable session is not proof of
		// absence, and the lease/agent-timeout window is still the backstop.
		logger.warn(
			'run cancellation: could not read the worker session — leaving the wait to the lease window',
			{ runId, workerId: target.workerId, error: describeError(err) },
		);
		return;
	}
	if (live) {
		// The push missed a worker that is still leased — it may reconnect and report,
		// and only it knows whether the phase is still executing there. Unchanged.
		logger.debug('run cancellation: the worker still holds a live session — leaving the wait', {
			runId,
			dispatchId: target.dispatchId,
			workerId: target.workerId,
		});
		return;
	}
	logger.warn(
		'run cancellation: the worker holds no live session — settling the run if it does not report',
		{
			runId,
			dispatchId: target.dispatchId,
			workerId: target.workerId,
			timeoutMs: OFFLINE_WORKER_CANCEL_TIMEOUT_MS,
		},
	);
	const timer = setTimeout(() => {
		// `RUN_CANCELLED_MESSAGE` verbatim: this *is* the user's termination, so the run
		// records the same neutral terminal message every other cancellation does
		// (issue #305). Why it settled early is a log line, not the run's message.
		if (failDispatchResultWait(target.dispatchId, RUN_CANCELLED_MESSAGE, { cancelled: true })) {
			logger.warn('run cancellation: settled a terminated run whose worker never reported', {
				runId,
				dispatchId: target.dispatchId,
				workerId: target.workerId,
			});
		}
	}, OFFLINE_WORKER_CANCEL_TIMEOUT_MS);
	// A pending wait must never hold the process open at shutdown.
	timer.unref();
}

/**
 * Push a `task-cancel` to the worker executing `runId` for this router, if any.
 * Returns whether a frame was actually sent; `false` covers both "not executing
 * here" and "its socket dropped", neither of which is an error — the dispatch is
 * then settled by the durable state as it would have been before this existed, or,
 * when the worker is confirmed session-less, by the bounded wait above.
 */
export function cancelRunOnWorker(runId: string): boolean {
	const target = resolveDispatchTargetForRun(runId);
	if (!target) {
		logger.debug('run cancellation: no dispatch executing here for that run — nothing to push', {
			runId,
		});
		return false;
	}
	const sent = sendToWorker(target.workerId, {
		type: 'task-cancel',
		dispatchId: target.dispatchId,
		runId,
		reason: CANCEL_FRAME_REASON,
		// What the worker needs to *answer* a cancel it cannot apply (issue #724) — a
		// terminal result frame names its phase and task. Taken from what this router
		// recorded when it pushed the assignment, never from anything the worker says.
		phase: target.phase,
		taskId: target.taskId,
	});
	if (!sent) {
		logger.warn('run cancellation: could not push task-cancel — the worker is not connected', {
			runId,
			dispatchId: target.dispatchId,
			workerId: target.workerId,
		});
		// Fired and forgotten so this stays synchronous for the Redis subscriber below.
		void settleWhenWorkerHoldsNoSession(runId, target);
		return false;
	}
	logger.info('run cancellation: pushed task-cancel to the executing worker', {
		runId,
		dispatchId: target.dispatchId,
		workerId: target.workerId,
	});
	return true;
}

/**
 * Subscribe to user-initiated run terminations and forward each to the worker
 * running it. Started with the control-plane dispatch consumer and closed with it
 * (`./dispatcher.ts`), so the subscription exists exactly while this router is the
 * side dispatching work.
 */
export function subscribeDispatchCancellations(): { close: () => Promise<void> } {
	return subscribeToRunCancellations((runId) => {
		cancelRunOnWorker(runId);
	});
}
