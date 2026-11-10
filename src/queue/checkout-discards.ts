/**
 * Prompt notification that a worker owes a reset's checkout discard (issue #1402) —
 * the cross-process hand-off from `resetRun` (API server) to the router, which alone
 * holds worker sockets. A copy of `./worker-sweeps.ts` on its own channel.
 *
 * Notification only: the `checkout_discards` row is the durable record, and the router
 * re-reads it both when this fires and when the worker reconnects, so a missed publish
 * costs promptness and nothing else.
 */

import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

/** Pub/sub channel carrying the id of a worker with a fresh pending checkout discard. */
const CHECKOUT_DISCARD_CHANNEL = 'swarm:checkout-discard';

let redisInstance: Redis | null = null;

function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('checkout-discard: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/**
 * Notify the router that `workerId` has a pending checkout discard. Carries only the
 * worker id — the frame is built from the rows. Never throws: the row already landed,
 * and the worker's next reconnect pushes it anyway.
 */
export async function publishCheckoutDiscardRequest(workerId: string): Promise<void> {
	try {
		await getRedis().publish(CHECKOUT_DISCARD_CHANNEL, workerId);
	} catch (err) {
		logger.warn('checkout-discard: failed to publish the discard notification', {
			workerId,
			error: String(err),
		});
	}
}

/**
 * Subscribe to discard notifications, invoking `onRequest(workerId)` for each, on a
 * dedicated duplicate connection (ioredis subscriber mode). Returns an async closer.
 */
export function subscribeToCheckoutDiscardRequests(onRequest: (workerId: string) => void): {
	close: () => Promise<void>;
} {
	const subscriber = getRedis().duplicate();
	subscriber.on('error', (err) => {
		logger.warn('checkout-discard: subscriber connection error', { error: String(err) });
	});
	subscriber.subscribe(CHECKOUT_DISCARD_CHANNEL).catch((err) => {
		logger.error('checkout-discard: failed to subscribe to the discard channel', {
			error: String(err),
		});
	});
	subscriber.on('message', (channel, message) => {
		if (channel === CHECKOUT_DISCARD_CHANNEL && message) onRequest(message);
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
export async function closeCheckoutDiscardRedis(): Promise<void> {
	if (redisInstance) {
		try {
			await redisInstance.quit();
		} catch {
			redisInstance.disconnect();
		}
		redisInstance = null;
	}
}
