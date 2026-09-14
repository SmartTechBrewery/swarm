/**
 * Prompt notification that a worker has been asked to sweep its abandoned
 * worktrees (issue #955) — the cross-process hand-off behind
 * `workers.requestWorktreeSweep`.
 *
 * A copy of `./worker-updates.ts` on its own channel, for the same reason that one
 * exists: the API server and the router are separate processes and **only the
 * router holds worker sockets**, so the mutation cannot push the frame itself. It
 * records the request on the `workers` row and publishes the worker id here; the
 * router subscribes and turns each one into a `worktree-sweep` push
 * (`../router/worktree-sweep-dispatch.ts`).
 *
 * Notification only, with no durable half: Postgres already *is* the durable record
 * — the pending request lives on the row, and the router re-reads it both when this
 * channel fires and when a worker reconnects — so a Redis set recording the same
 * fact would be a second source of truth for one that already has one.
 *
 * Own lazy ioredis client per process, mirroring `./cancellation.ts` and
 * `./worker-updates.ts` — the API server publishes, the router subscribes, both
 * against the one shared Redis.
 */

import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

/** Pub/sub channel carrying the id of a worker whose row has a fresh sweep request. */
const WORKTREE_SWEEP_CHANNEL = 'swarm:worktree-sweep';

let redisInstance: Redis | null = null;

function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('worktree-sweep: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/**
 * Notify the router that `workerId`'s row carries a fresh worktree-sweep request.
 *
 * Deliberately carries only the worker id: the row is the record, and what the
 * machine is actually asked to sweep is resolved from its approved enrollments when
 * the frame is built — so a stale or duplicated message cannot push a sweep of a
 * project the machine is no longer enrolled in.
 *
 * Never throws. The durable request already landed before this is called, and a
 * worker that misses the notification is pushed to on its next reconnect
 * (`resendPendingWorktreeSweepToWorker`), so a failed publish costs promptness and
 * nothing else — failing the mutation over it would tell the operator their request
 * did not land when it did.
 */
export async function publishWorktreeSweepRequest(workerId: string): Promise<void> {
	try {
		await getRedis().publish(WORKTREE_SWEEP_CHANNEL, workerId);
	} catch (err) {
		logger.warn('worktree-sweep: failed to publish the sweep notification', {
			workerId,
			error: String(err),
		});
	}
}

/**
 * Subscribe to sweep requests, invoking `onRequest(workerId)` for each. ioredis
 * requires a dedicated connection in subscriber mode (it cannot also run normal
 * commands), so this duplicates the shared client. Returns an async closer the
 * router calls on shutdown.
 */
export function subscribeToWorktreeSweepRequests(onRequest: (workerId: string) => void): {
	close: () => Promise<void>;
} {
	const subscriber = getRedis().duplicate();
	subscriber.on('error', (err) => {
		logger.warn('worktree-sweep: subscriber connection error', { error: String(err) });
	});
	subscriber.subscribe(WORKTREE_SWEEP_CHANNEL).catch((err) => {
		logger.error('worktree-sweep: failed to subscribe to the sweep channel', {
			error: String(err),
		});
	});
	subscriber.on('message', (channel, message) => {
		if (channel === WORKTREE_SWEEP_CHANNEL && message) onRequest(message);
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
export async function closeWorktreeSweepRedis(): Promise<void> {
	if (redisInstance) {
		try {
			await redisInstance.quit();
		} catch {
			redisInstance.disconnect();
		}
		redisInstance = null;
	}
}
