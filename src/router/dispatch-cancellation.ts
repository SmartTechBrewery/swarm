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
 * Best-effort still, but no longer unbounded (issue #827). A failed push on its own
 * is ambiguous — the socket may merely have blipped — so that case keeps waiting out
 * the phase's own agent timeout. The absence of a live `worker_sessions` row does
 * *not* disambiguate it: this control plane releases a worker's session on **every**
 * `/worker/stream` close (`./worker-transport.ts`), while a phase runs independently
 * of the heartbeat loop and so routinely outlives the session it was pushed on
 * (`../transport/worker-client.ts`, issue #718). What does carry information is
 * **silence**: the retained session row survives release, and its `lastHeartbeatAt`
 * is the worker's *last seen*. A daemon that is up heartbeats every third of the
 * TTL and climbs a reconnect ladder capped at a jittered 30s, so a worker that has
 * said nothing for longer than {@link offlineSilenceMs} is one nothing was going to
 * settle this run for, and it is settled `SWARM_OFFLINE_WORKER_CANCEL_TIMEOUT_MS`
 * later instead. That remains a **heuristic about liveness, not proof the phase
 * stopped** — which is why the same test is re-run when the timer fires, and why a
 * worker that comes back inside the wait is handed the cancellation (issue #724's
 * path) rather than settled behind its back. Live repro that prompted it:
 * 2026-08-29, `rover` task 5's `planning` phase on worker `jacek_tp_rover`, whose
 * transport session had been released minutes before the Terminate — the marker and
 * origin were recorded, the push failed, and the run row stayed `running` until it
 * was settled by hand in Postgres.
 */

import {
	getLiveSessionForWorker,
	getRetainedSessionForWorker,
	resolveHeartbeatTtlMs,
} from '../identity/worker-session-service.js';
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
 * Default wait before a terminated run whose worker has gone silent is settled here
 * rather than at the phase's own agent timeout (issue #827). A minute is long enough
 * for a worker that is merely mid-reconnect to re-handshake — which is re-checked
 * when the timer fires, so it takes the cancellation instead of the settle — and
 * short enough that a run nothing is going to report on does not sit `running` for
 * tens of minutes.
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
 * Floor on how long a worker must have been silent before its missing live session
 * reads as *gone* rather than as a socket that simply closed. A daemon that is up
 * heartbeats every `heartbeatTtlMs / 3` (`heartbeatCadenceMs`) and, if its socket
 * drops, reconnects on a ladder capped at a jittered 30s
 * (`DEFAULT_BACKOFF.maxMs`) — both in `../transport/worker-client.ts`. Two minutes
 * clears the wider of those by 4x, so an ordinary blip never qualifies.
 */
const OFFLINE_SILENCE_FLOOR_MS = 120_000;

/**
 * The silence that makes a worker *probably gone*: twice the configured heartbeat
 * TTL — the window `getLiveSessionForWorker` itself measures liveness over — but
 * never below {@link OFFLINE_SILENCE_FLOOR_MS}, so shortening the TTL cannot shrink
 * this below the reconnect ladder and start settling live phases.
 */
function offlineSilenceMs(heartbeatTtlMs: number): number {
	return Math.max(2 * heartbeatTtlMs, OFFLINE_SILENCE_FLOOR_MS);
}

/**
 * Whether the worker has been silent long enough that nothing is going to report
 * this dispatch's result (issue #827).
 *
 * Deliberately *not* "has no live session": `releaseSession` runs on every
 * `/worker/stream` close (`./worker-transport.ts`), so `getLiveSessionForWorker`
 * answers `undefined` the instant a socket drops — for a worker whose phase is
 * still executing just as much as for a dead one. The retained row is what
 * distinguishes them: it survives release precisely so `lastHeartbeatAt` can be
 * read as *last seen* (`getRetainedSessionForWorker`), and only a worker silent
 * past {@link offlineSilenceMs} qualifies. A worker that never handshook here at
 * all has no silence to measure and never qualifies either.
 *
 * This is a liveness heuristic, not proof the phase stopped — so it is re-run
 * before anything is settled, and it fails *safe*: an unreadable row throws to the
 * caller, which leaves the wait to the lease window exactly as before.
 */
async function isWorkerConfirmedSilent(workerId: string): Promise<boolean> {
	const ttlMs = resolveHeartbeatTtlMs();
	if (await getLiveSessionForWorker(workerId, ttlMs)) return false;
	const retained = await getRetainedSessionForWorker(workerId);
	if (!retained) return false;
	return Date.now() - retained.lastHeartbeatAt.getTime() >= offlineSilenceMs(ttlMs);
}

/**
 * Bound the wait for a termination that could not be pushed, but only for a worker
 * that has gone silent (issue #827).
 *
 * The settle rides the seam this router already owns for a wait whose outcome can
 * no longer arrive (`failDispatchResultWait`, issue #719): the synthetic terminal
 * frame carries `cancelled: true`, so `adaptResultToPhaseRun` raises a
 * `RunTerminatedError` and the run settles down the *same* path a worker-reported
 * cancellation does — `failed`, the neutral reason, the recorded origin, a
 * `user-terminated` diagnosis — releasing the parked BullMQ job and every capacity
 * the dispatch holds along with the rows. No new settle path and no new policy.
 *
 * The timer is never cancelled; {@link settleIfStillSilent} decides on the facts as
 * they stand when it fires instead.
 */
async function settleWhenWorkerStaysSilent(
	runId: string,
	target: RunDispatchTarget,
): Promise<void> {
	let silent: boolean;
	try {
		silent = await isWorkerConfirmedSilent(target.workerId);
	} catch (err) {
		// Fail safe into today's behaviour: an unreadable session is not evidence of
		// anything, and the lease/agent-timeout window is still the backstop.
		logger.warn(
			'run cancellation: could not read the worker session — leaving the wait to the lease window',
			{ runId, workerId: target.workerId, error: describeError(err) },
		);
		return;
	}
	if (!silent) {
		// The push missed a worker that is still heartbeating (or was, moments ago): it
		// may reconnect and report, and only it knows whether the phase is still
		// executing there. Unchanged.
		logger.debug('run cancellation: the worker is not silent — leaving the wait', {
			runId,
			dispatchId: target.dispatchId,
			workerId: target.workerId,
		});
		return;
	}
	logger.warn(
		'run cancellation: the worker has gone silent — settling the run if it stays that way',
		{
			runId,
			dispatchId: target.dispatchId,
			workerId: target.workerId,
			timeoutMs: OFFLINE_WORKER_CANCEL_TIMEOUT_MS,
		},
	);
	const timer = setTimeout(() => {
		void settleIfStillSilent(runId, target);
	}, OFFLINE_WORKER_CANCEL_TIMEOUT_MS);
	// A pending wait must never hold the process open at shutdown.
	timer.unref();
}

/**
 * The armed wait, firing. Re-runs the whole test rather than trusting the one taken
 * a minute ago — the wait was armed on a *heuristic*, and the two things that can
 * have changed since are exactly the two that must not be settled through.
 *
 * A worker that came back is handed the cancellation instead: it is the only party
 * that knows whether the phase is still executing there, and since issue #724 it
 * answers either way — aborting the assignment, or re-reporting the real terminal
 * result it held (issue #718). And because `scheduleDispatchRetry` reuses a dispatch
 * id across attempts, the settle is gated on the run still resolving to *this*
 * registration, so a later attempt's waiter can never be ended by an older wait.
 */
async function settleIfStillSilent(runId: string, target: RunDispatchTarget): Promise<void> {
	let silent: boolean;
	try {
		silent = await isWorkerConfirmedSilent(target.workerId);
	} catch (err) {
		logger.warn(
			'run cancellation: could not re-read the worker session — leaving the wait to the lease window',
			{ runId, workerId: target.workerId, error: describeError(err) },
		);
		return;
	}
	if (!silent) {
		logger.info('run cancellation: the worker returned inside the wait — re-pushing the cancel', {
			runId,
			dispatchId: target.dispatchId,
			workerId: target.workerId,
		});
		cancelRunOnWorker(runId);
		return;
	}
	const current = resolveDispatchTargetForRun(runId);
	if (current?.dispatchId !== target.dispatchId) {
		logger.info('run cancellation: the wait this bounded is gone — nothing to settle', {
			runId,
			dispatchId: target.dispatchId,
			workerId: target.workerId,
		});
		return;
	}
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
}

/**
 * Push a `task-cancel` to the worker executing `runId` for this router, if any.
 * Returns whether a frame was actually sent; `false` covers both "not executing
 * here" and "its socket dropped", neither of which is an error — the dispatch is
 * then settled by the durable state as it would have been before this existed, or,
 * when the worker is confirmed silent, by the bounded wait above.
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
		void settleWhenWorkerStaysSilent(runId, target);
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
