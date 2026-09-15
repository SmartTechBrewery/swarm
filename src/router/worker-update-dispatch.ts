/**
 * Control-plane delivery of a self-update request to the machine it names —
 * issue #933's push, re-addressed in issue #972 to the durable queued unit that
 * now carries it.
 *
 * `workers.requestUpdate` runs in the API server and only the *router* holds
 * worker sockets, so the mutation cannot push the frame itself. It records the
 * request on the `workers` row **and enqueues a `worker-update` dispatch in the
 * same transaction**; the control-plane dispatch consumer — which is this
 * process, the queue's only consumer — claims that dispatch and calls
 * {@link pushPendingWorkerUpdate} (`../worker/worker-update-dispatch.ts` settles
 * the row against what it answers). There is no second, unranked delivery path
 * beside the queue any more: the `swarm:worker-update` pub/sub channel is gone.
 *
 * The frame is still built from the **row**, not from the dispatch's payload:
 * the row is the record, so a wake-up that arrives late, twice, or after an
 * operator re-targeted the machine cannot push a build the row has since moved
 * off. What the dispatch contributes is the `requestId` it was created for,
 * matched against the row's own — the same guarantee, now stated as an id match
 * instead of a bare presence check.
 */

import { promoteWorkerUpdateDispatchForWorker } from '../dispatch/dispatcher.js';
import { getWorker } from '../identity/worker-service.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { sendToWorker } from './worker-connections.js';

/**
 * What became of one attempt to hand a machine the update it was asked for.
 *
 * - `pushed` — the frame reached its socket.
 * - `superseded` — the row carries no outstanding request, or carries a
 *   *different* one: re-targeted, or already reported. Nothing left to deliver.
 * - `not-connected` — its socket is not on this router, so the dispatch waits.
 *
 * None of the three is an error; each settles the dispatch differently.
 */
export type WorkerUpdatePushResult = 'pushed' | 'superseded' | 'not-connected';

/**
 * Push the update request `requestId` names to `workerId`'s live socket, if the
 * row still waits on exactly that request.
 *
 * The row is re-read on every call rather than cached, which is what makes a
 * re-push safe: the daemon deduplicates on `requestId`, so a machine already
 * working on this request ignores the repeat, and a machine that was away gets
 * whatever the row says *now*.
 */
export async function pushPendingWorkerUpdate(
	workerId: string,
	requestId: string,
): Promise<WorkerUpdatePushResult> {
	const worker = await getWorker(workerId);
	const update = worker?.update;
	if (!update?.requestId || update.requestId !== requestId) {
		logger.debug('worker update: the row no longer waits on this request — nothing to push', {
			workerId,
			requestId,
			pendingRequestId: update?.requestId ?? null,
		});
		return 'superseded';
	}
	const sent = sendToWorker(workerId, {
		type: 'worker-update',
		requestId: update.requestId,
		target: update.target,
	});
	if (!sent) {
		// Not a failure worth escalating: the request is durable on the row *and* on
		// its dispatch, which waits for the machine to come back.
		logger.info('worker update: the worker is not connected here — leaving the request pending', {
			workerId,
			requestId: update.requestId,
			target: update.target,
		});
		return 'not-connected';
	}
	logger.info('worker update: pushed the update request to the worker', {
		workerId,
		requestId: update.requestId,
		target: update.target,
	});
	return 'pushed';
}

/**
 * Hand a reconnected worker the update request it missed while its socket was down
 * — by **waking its queued dispatch**, not by pushing directly, so there is one
 * delivery path rather than two (issue #972).
 *
 * The common case this exists for is the ordinary one rather than an edge: a
 * machine is drained (the mutation's precondition), restarted or merely offline
 * when the operator asks, and the push at request time reaches nobody. Its
 * dispatch is then `retry-scheduled` on the executor's timed backstop, and this is
 * what collapses that wait to the moment the machine is actually back.
 *
 * Fire-and-forget: it returns `void` so the transport's connection hooks stay
 * synchronous (`./worker-transport.ts`), and the promotion swallows every failure
 * of its own so a socket that just opened never fails on it.
 */
export function resendPendingWorkerUpdateToWorker(workerId: string): void {
	void promoteWorkerUpdateDispatchForWorker(workerId).catch((err) => {
		logger.warn('worker update: could not wake the update dispatch of a reconnected machine', {
			workerId,
			error: describeError(err),
		});
	});
}
