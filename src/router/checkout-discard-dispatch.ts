/**
 * Control-plane delivery of a reset's checkout discards to the machine that holds the
 * checkout (issue #1402) — the `./worktree-sweep-dispatch.ts` bridge for a different
 * request. `resetRun` runs in the API server and records a `checkout_discards` row
 * when it abandons a preserved worker; only the router holds worker sockets, so this
 * module turns the row into a `checkout-discard` push, now (on the notification) or
 * when the machine next connects (from the socket-open hook in `./worker-transport.ts`).
 *
 * Every push is built from the rows, never from the notification, and each request is
 * re-checked first: a run that has since been **preserved on this same machine again**
 * — a newer attempt that deferred there after the reset — owns the checkout now, so
 * that request is settled `superseded` instead of pushed. The machine applies its own
 * guards on top (`../transport/checkout-discard.ts`).
 *
 * Best-effort: a worker not connected here is skipped and its rows stay pending.
 */

import {
	listPendingCheckoutDiscards,
	settleCheckoutDiscard,
} from '../db/repositories/checkoutDiscardsRepository.js';
import { getRunByIdFromDb } from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
	closeCheckoutDiscardRedis,
	subscribeToCheckoutDiscardRequests,
} from '../queue/checkout-discards.js';
import type { ControlPlaneMessage } from '../transport/protocol.js';
import { sendToWorker } from './worker-connections.js';

/** The collaborators this module reaches — injected in tests. */
export interface CheckoutDiscardDispatchDeps {
	listPending: typeof listPendingCheckoutDiscards;
	settle: typeof settleCheckoutDiscard;
	/** The run's current preserved worker, or `null` — `undefined` when the run is gone. */
	preservedWorkerOf: (runId: string) => Promise<string | null | undefined>;
	send: (workerId: string, frame: ControlPlaneMessage) => boolean;
}

function defaultDeps(): CheckoutDiscardDispatchDeps {
	return {
		listPending: listPendingCheckoutDiscards,
		settle: settleCheckoutDiscard,
		preservedWorkerOf: async (runId) => {
			const run = await getRunByIdFromDb(runId);
			return run ? (run.recovery?.preservedWorkerId ?? null) : undefined;
		},
		send: sendToWorker,
	};
}

/**
 * Push every discard `workerId` still owes to its live socket. Returns how many frames
 * were sent; `0` covers "nothing pending" and "not connected here", neither an error.
 * Safe to repeat: the daemon deduplicates on `requestId`.
 */
export async function pushPendingCheckoutDiscards(
	workerId: string,
	deps: CheckoutDiscardDispatchDeps = defaultDeps(),
): Promise<number> {
	const pending = await deps.listPending(workerId);
	let sent = 0;
	for (const request of pending) {
		const preservedOn = await deps.preservedWorkerOf(request.runId);
		if (preservedOn === workerId) {
			await deps.settle(
				workerId,
				request.id,
				'superseded',
				'The run was preserved on this worker again after the reset, so the checkout there belongs to its newer attempt and was kept.',
			);
			logger.info('checkout discard: superseded by a newer preserved attempt on the same worker', {
				workerId,
				requestId: request.id,
				runId: request.runId,
			});
			continue;
		}
		const delivered = deps.send(workerId, {
			type: 'checkout-discard',
			requestId: request.id,
			runId: request.runId,
			projectId: request.projectId,
			repository: request.repository,
			taskId: request.taskId,
			worktreeRoot: request.worktreeRoot,
		});
		if (!delivered) {
			logger.info('checkout discard: the worker is not connected here — leaving it pending', {
				workerId,
				pending: pending.length,
			});
			return sent;
		}
		sent += 1;
		logger.info('checkout discard: pushed a reset’s discard request to the worker', {
			workerId,
			requestId: request.id,
			runId: request.runId,
			taskId: request.taskId,
		});
	}
	return sent;
}

/**
 * Hand a reconnected worker the discards it missed while its socket was down — the
 * offline-holder case the issue names. Fire-and-forget so the transport's connection
 * hooks stay synchronous; every failure is logged.
 */
export function resendPendingCheckoutDiscardsToWorker(workerId: string): void {
	void pushPendingCheckoutDiscards(workerId).catch((err) => {
		logger.warn('checkout discard: could not push pending discards to a reconnected worker', {
			workerId,
			error: describeError(err),
		});
	});
}

/**
 * Subscribe to discard notifications and push each to the worker it names. Started
 * and closed with the router process, like the sweep subscription.
 */
export function subscribeCheckoutDiscardDispatch(): { close: () => Promise<void> } {
	const subscription = subscribeToCheckoutDiscardRequests((workerId) => {
		void pushPendingCheckoutDiscards(workerId).catch((err) => {
			logger.warn('checkout discard: could not push a requested discard', {
				workerId,
				error: describeError(err),
			});
		});
	});
	return {
		close: async () => {
			await subscription.close();
			await closeCheckoutDiscardRedis();
		},
	};
}
