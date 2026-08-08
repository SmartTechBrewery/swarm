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
 * `RunTerminatedError` for the shared settle path.
 *
 * Best-effort by design, exactly as the notification it rides is: a run this
 * router is not executing (queued, deferred, already settled, or dispatched from
 * another router) resolves to nothing and the push is skipped. The durable marker
 * remains the source of truth for *whether* a run was cancelled — `processJob`
 * reads it when the phase fails — so a missed push costs promptness, never
 * correctness.
 */

import { logger } from '../lib/logger.js';
import { subscribeToRunCancellations } from '../queue/cancellation.js';
import { resolveDispatchTargetForRun } from './dispatch-results.js';
import { sendToWorker } from './worker-connections.js';

/**
 * The `reason` carried on the pushed frame. It is for the daemon's log only — the
 * run's terminal message is the control plane's own neutral `RUN_CANCELLED_MESSAGE`
 * (issue #305), applied when the worker's `cancelled` result comes back — so it
 * names no actor and asserts no origin.
 */
const CANCEL_FRAME_REASON = 'a cancellation was requested for this run';

/**
 * Push a `task-cancel` to the worker executing `runId` for this router, if any.
 * Returns whether a frame was actually sent; `false` covers both "not executing
 * here" and "its socket dropped", neither of which is an error — the dispatch is
 * then settled by the durable state as it would have been before this existed.
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
	});
	if (!sent) {
		logger.warn('run cancellation: could not push task-cancel — the worker is not connected', {
			runId,
			dispatchId: target.dispatchId,
			workerId: target.workerId,
		});
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
