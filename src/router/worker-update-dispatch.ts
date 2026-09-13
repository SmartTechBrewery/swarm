/**
 * Control-plane delivery of a self-update request to the machine it names (issue
 * #933) — the worker-update twin of `./dispatch-cancellation.ts`, and the same
 * bridge for the same reason: `workers.requestUpdate` runs in the API server, only
 * the *router* holds worker sockets, so the mutation records the request on the
 * `workers` row and publishes the worker id (`../queue/worker-updates.ts`) and this
 * module turns that notification into a push.
 *
 * Two differences from the cancellation bridge, both because of what the durable
 * half is here. A cancellation's durable record is a Redis set the worker's own
 * process can also read; an update request lives on a Postgres row a DB-free worker
 * cannot reach at all, so the push is the *only* delivery there is. And the frame
 * is built from the row rather than from the notification's payload — the channel
 * carries a worker id and nothing else — so a message that arrives late, twice, or
 * after an operator re-targeted the machine cannot push a build the row has since
 * moved off.
 *
 * Best-effort, exactly as the notification it rides is: a worker that is not
 * connected here is skipped, and the request stays pending until the machine
 * reconnects and {@link resendPendingWorkerUpdateToWorker} states it again from the
 * socket-open side. Nothing is armed, timed, or settled on a missed push — unlike a
 * cancellation, an unanswered update leaves the machine working exactly as it was.
 */

import { getWorker } from '../identity/worker-service.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
	closeWorkerUpdateRedis,
	subscribeToWorkerUpdateRequests,
} from '../queue/worker-updates.js';
import { sendToWorker } from './worker-connections.js';

/**
 * Push the update request `workerId`'s row is waiting on, if any, to its live
 * socket. Returns whether a frame was actually sent; `false` covers "no request
 * pending", "already reported", and "its socket is not here", none of which is an
 * error.
 *
 * The row is re-read on every call rather than cached, which is what makes a
 * re-push safe: the daemon deduplicates on `requestId`, so a machine already
 * working on this request ignores the repeat, and a machine that was away gets
 * whatever the row says *now*.
 */
export async function pushPendingWorkerUpdate(workerId: string): Promise<boolean> {
	const worker = await getWorker(workerId);
	const update = worker?.update;
	if (!update?.requestId) {
		logger.debug('worker update: no request pending for that worker — nothing to push', {
			workerId,
		});
		return false;
	}
	const sent = sendToWorker(workerId, {
		type: 'worker-update',
		requestId: update.requestId,
		target: update.target,
	});
	if (!sent) {
		// Not a failure worth escalating: the request is durable on the row, and the
		// socket-open hook below states it again the moment the machine is back.
		logger.info('worker update: the worker is not connected here — leaving the request pending', {
			workerId,
			requestId: update.requestId,
			target: update.target,
		});
		return false;
	}
	logger.info('worker update: pushed the update request to the worker', {
		workerId,
		requestId: update.requestId,
		target: update.target,
	});
	return true;
}

/**
 * Hand a reconnected worker the update request it missed while its socket was down.
 *
 * The common case this exists for is the ordinary one rather than an edge: a
 * machine is drained (the mutation's precondition), restarted or merely offline
 * when the operator asks, and the push at request time reaches nobody. It is also
 * what re-states the request to a machine that restarted for some *other* reason
 * mid-update — nothing else would, since the notification fires once.
 *
 * Fire-and-forget: it returns `void` so the transport's connection hooks stay
 * synchronous (`./worker-transport.ts`), and every failure is caught and logged so
 * a socket that just opened never fails on it.
 */
export function resendPendingWorkerUpdateToWorker(workerId: string): void {
	void pushPendingWorkerUpdate(workerId).catch((err) => {
		logger.warn('worker update: could not push a pending request to a reconnected worker', {
			workerId,
			error: describeError(err),
		});
	});
}

/**
 * Subscribe to update requests and push each to the worker it names. Started with
 * the router process and closed with it (`./index.ts`), so the subscription exists
 * exactly while this process is the side holding worker sockets.
 *
 * Closing drops the shared client as well as the subscriber, mirroring the
 * dispatcher's own `closeRunCancellationRedis()` call (`./dispatcher.ts`): the
 * subscriber is a duplicate of that client, so quitting only the duplicate would
 * leave the router hanging on an open Redis socket.
 */
export function subscribeWorkerUpdateDispatch(): { close: () => Promise<void> } {
	const subscription = subscribeToWorkerUpdateRequests((workerId) => {
		void pushPendingWorkerUpdate(workerId).catch((err) => {
			logger.warn('worker update: could not push a requested update', {
				workerId,
				error: describeError(err),
			});
		});
	});
	return {
		close: async () => {
			await subscription.close();
			await closeWorkerUpdateRedis();
		},
	};
}
