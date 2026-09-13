/**
 * Prompt notification that a worker has been asked to update itself (issue #933)
 * — the cross-process hand-off behind `workers.requestUpdate`.
 *
 * The API server and the router are separate processes and **only the router holds
 * worker sockets**, so the mutation cannot push the frame itself. It records the
 * request on the `workers` row and publishes the worker id here; the router
 * subscribes and turns each one into a `worker-update` push
 * (`../router/worker-update-dispatch.ts`).
 *
 * This is the shape `../queue/cancellation.ts` established, with its durable half
 * removed: Postgres already *is* the durable record here — the pending request lives
 * on the row, and the router re-reads it both when this channel fires and when a
 * worker reconnects — so a Redis set recording the same fact would be a second
 * source of truth for one that already has one. What is left is notification only,
 * and it is best-effort by construction: a publish nobody is subscribed for costs
 * promptness, and the request stays pending until an operator's machine answers it.
 *
 * Own lazy ioredis client per process, mirroring `./cancellation.ts` — the API
 * server publishes, the router subscribes, both against the one shared Redis.
 */

import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

/** Pub/sub channel carrying the id of a worker whose row has a fresh update request. */
const WORKER_UPDATE_CHANNEL = 'swarm:worker-update';

let redisInstance: Redis | null = null;

function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('worker-update: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/**
 * Notify the router that `workerId`'s row carries a fresh update request.
 *
 * Deliberately carries only the worker id, never the target: the row is the record,
 * so the router reads what to push from it rather than trusting a channel payload —
 * which is what keeps a stale or duplicated message from pushing a build the
 * operator has since re-targeted away from.
 *
 * Never throws. The durable request already landed before this is called, and a
 * worker that misses the notification is pushed to on its next reconnect
 * (`resendPendingWorkerUpdateToWorker`), so a failed publish costs promptness and
 * nothing else — failing the mutation over it would tell the operator their request
 * did not land when it did.
 */
export async function publishWorkerUpdateRequest(workerId: string): Promise<void> {
	try {
		await getRedis().publish(WORKER_UPDATE_CHANNEL, workerId);
	} catch (err) {
		logger.warn('worker-update: failed to publish the update notification', {
			workerId,
			error: String(err),
		});
	}
}

/**
 * Subscribe to update requests, invoking `onRequest(workerId)` for each. ioredis
 * requires a dedicated connection in subscriber mode (it cannot also run normal
 * commands), so this duplicates the shared client. Returns an async closer the
 * router calls on shutdown.
 */
export function subscribeToWorkerUpdateRequests(onRequest: (workerId: string) => void): {
	close: () => Promise<void>;
} {
	const subscriber = getRedis().duplicate();
	subscriber.on('error', (err) => {
		logger.warn('worker-update: subscriber connection error', { error: String(err) });
	});
	subscriber.subscribe(WORKER_UPDATE_CHANNEL).catch((err) => {
		logger.error('worker-update: failed to subscribe to the update channel', {
			error: String(err),
		});
	});
	subscriber.on('message', (channel, message) => {
		if (channel === WORKER_UPDATE_CHANNEL && message) onRequest(message);
	});
	return {
		close: async () => {
			try {
				await subscriber.quit();
			} catch {
				subscriber.disconnect();
			}
		},
	};
}

/** Close the shared client — called from process shutdown so the socket frees. */
export async function closeWorkerUpdateRedis(): Promise<void> {
	if (redisInstance) {
		try {
			await redisInstance.quit();
		} catch {
			redisInstance.disconnect();
		}
		redisInstance = null;
	}
}
