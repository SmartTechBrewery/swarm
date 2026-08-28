import { optionalEnv } from '../lib/env.js';

export const DEFAULT_WORKER_LOCK_DURATION_MS = 15 * 60 * 1000;
export const MAX_WORKER_LOCK_RENEW_TIME_MS = 30 * 1000;

export interface WorkerLockOptions {
	lockDuration: number;
	lockRenewTime: number;
}

/**
 * Resolve BullMQ's job-lock settings for long agent phases.
 *
 * The lock must survive a temporarily starved event loop or a sleeping laptop,
 * while renewal should still happen frequently during normal operation. BullMQ
 * defaults renewal to half the lock duration; with a multi-minute lock that
 * leaves very few chances to recover from a missed timer. Cap the renewal
 * interval at 30 seconds while keeping a 15-minute expiry safety margin.
 */
export function resolveWorkerLockOptions(
	rawLockDuration = optionalEnv(
		'SWARM_WORKER_LOCK_DURATION_MS',
		String(DEFAULT_WORKER_LOCK_DURATION_MS),
	),
): WorkerLockOptions {
	const lockDuration = Number(rawLockDuration);
	if (!Number.isInteger(lockDuration) || lockDuration < 1) {
		throw new Error(
			`SWARM_WORKER_LOCK_DURATION_MS must be a positive integer, got '${rawLockDuration}'`,
		);
	}

	return {
		lockDuration,
		lockRenewTime: Math.max(
			1,
			Math.min(MAX_WORKER_LOCK_RENEW_TIME_MS, Math.floor(lockDuration / 2)),
		),
	};
}
