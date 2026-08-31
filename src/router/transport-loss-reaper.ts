/**
 * Settle the dispatches an orphaned worker was holding, on the strength of the
 * transport signal rather than the phase-timeout lease (issue #859).
 *
 * The router already knows, within seconds, that a worker's `/worker/stream` has
 * dropped: `onWorkerTransportLost` fires on the close and records the interruption
 * against every dispatch awaited on that worker (`./dispatch-results.ts`,
 * issue #723). Until now the only thing done with that knowledge was one note in
 * each run's output stream. If the worker never came back, the dispatch stayed
 * `running` until the control plane's own result wait gave up at the phase's budget
 * plus the margin, or the 5-minute reconciler reached its expired lease — 34-38
 * minutes in the incident that prompted this. All of it wasted: the orphan holds the
 * PR-scoped hold (issue #850), its task's checkout, and a project capacity slot, so
 * every phase queued behind any of the three defers on a dispatch that will never do
 * anything.
 *
 * The lease is the wrong bound because it is sized to the *phase's* budget, not to
 * worker liveness. The mirror for the opposite case already exists: issue #719 reaps
 * a worker's stale claims the moment it *reconnects*, driven from the handshake that
 * mints a new fencing token. A worker that leaves and stays gone had no equivalent
 * path — the worse case, since nothing but the clock ever ends it. This module is
 * that path.
 *
 * How it decides: arm a grace when the drop is observed, and re-check the facts when
 * it fires — never cancel the timer, exactly as the offline-termination settle does
 * (`./dispatch-cancellation.ts`, issue #827). A worker with a live socket here again
 * is a blip that reconnected and is left alone; a worker still absent has its
 * dispatches ended through the seam both precedents already use,
 * `failDispatchResultWait`.
 *
 * Why connectivity here and not #827's `worker_sessions` silence heuristic: that
 * module never observed a close — its trigger is a *failed push*, which is ambiguous
 * — so it has to infer liveness from the retained row's `lastHeartbeatAt`. Here the
 * close was observed, and `noteTransportLoss` (`./worker-transport.ts`) already fires
 * only when no replacement socket is registered. "Is there a live socket for this
 * worker here again?" is the direct question, and it needs no Postgres round trip.
 * The single-router MVP assumption both `./worker-connections.ts` and
 * `./dispatch-results.ts` state is what makes that answer complete.
 *
 * **No re-dispatch follows.** The synthetic frame is a plain `failed` — no
 * `cancelled` — so `adaptResultToPhaseRun` raises a non-deferrable
 * `AgentRunError { kind: 'error' }` and the worker's shared failure path settles the
 * run terminally. Whether a phase lost this way should be run again is a policy
 * question this does not answer (a Respond-to-review that had already pushed must not
 * be replayed blindly); `swarm run reset` remains the operator's way to do it.
 */

import { resolveHeartbeatTtlMs } from '../identity/worker-session-service.js';
import { logger } from '../lib/logger.js';
import {
	failDispatchResultWait,
	type InterruptedDispatch,
	resolveDispatchStreamTarget,
} from './dispatch-results.js';
import { persistControlPlaneNote, TRANSPORT_LOST_ORPHAN_NOTE } from './stream-log-persistence.js';
import { isWorkerConnected } from './worker-connections.js';
import { offlineSilenceMs } from './worker-liveness.js';

/**
 * What the reaped dispatch, its run row, and the synthetic terminal result all
 * record. Deliberately neither the lease reconciler's "did not report a result
 * within the lease window" nor a cancellation's neutral message, so run history says
 * which of the three actually happened — the same reason issue #719's supersede
 * reason is its own string rather than a shared one.
 */
export const TRANSPORT_LOST_ORPHAN_REASON =
	"The worker's transport session was lost and did not return within the grace — settled from that signal, not from the lease window";

/**
 * Arm the bounded reap for the dispatches `workerId`'s drop interrupted.
 *
 * Fire-and-forget by contract, like the connection hook that calls it: returns
 * `void`, does no I/O, and never lets a socket's lifecycle wait on anything. The
 * timer is unreffed so a pending grace cannot hold the process open at shutdown, and
 * it is never cancelled — {@link settleIfTransportStayedLost} decides on the facts as
 * they stand when it fires.
 */
export function reapDispatchesIfTransportStaysLost(
	workerId: string,
	interrupted: InterruptedDispatch[],
): void {
	// The ordinary case: a worker with nothing in flight here. Nothing to bound.
	if (interrupted.length === 0) return;
	const graceMs = offlineSilenceMs(resolveHeartbeatTtlMs());
	logger.warn("worker transport lost: reaping this worker's dispatches if it stays gone", {
		workerId,
		dispatchIds: interrupted.map((dispatch) => dispatch.dispatchId),
		graceMs,
	});
	const timer = setTimeout(() => {
		settleIfTransportStayedLost(workerId, interrupted, graceMs);
	}, graceMs);
	timer.unref();
}

/**
 * The armed grace, firing. Re-runs the connectivity test rather than trusting the
 * one taken when the socket closed: a blip that reconnected inside the grace is a
 * phase still genuinely executing, and must survive exactly as it does today.
 *
 * Per dispatch, the registration is re-resolved and checked to still name *this*
 * worker. That covers both ways a dispatch can have moved on: it settled inside the
 * grace (its real result arrived, or something else ended the wait), or its id was
 * re-pushed elsewhere — `scheduleDispatchRetry` reuses dispatch ids across attempts,
 * so a later attempt's waiter must never be ended by an older drop's timer.
 */
function settleIfTransportStayedLost(
	workerId: string,
	interrupted: InterruptedDispatch[],
	graceMs: number,
): void {
	if (isWorkerConnected(workerId)) {
		logger.info('worker transport lost: the worker came back inside the grace — nothing to reap', {
			workerId,
			graceMs,
		});
		return;
	}
	for (const { dispatchId } of interrupted) {
		const target = resolveDispatchStreamTarget(dispatchId);
		if (!target || target.workerId !== workerId) continue;
		// Before the settle, so the run's own stream corrects the note that promised
		// output would resume "when it reconnects" — it never did.
		persistControlPlaneNote(target.runId, TRANSPORT_LOST_ORPHAN_NOTE);
		if (failDispatchResultWait(dispatchId, TRANSPORT_LOST_ORPHAN_REASON)) {
			logger.warn('worker transport lost: settled a dispatch whose worker never returned', {
				workerId,
				dispatchId,
				runId: target.runId,
				graceMs,
			});
		}
	}
}
