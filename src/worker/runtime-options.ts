import { optionalEnv } from '../lib/env.js';

export const DEFAULT_WORKER_LOCK_DURATION_MS = 15 * 60 * 1000;
export const MAX_WORKER_LOCK_RENEW_TIME_MS = 30 * 1000;

/** Jobs a worker runs at once when neither the flag nor the env var is set. */
export const DEFAULT_WORKER_CONCURRENCY = 1;

/**
 * Extract a `--concurrency <n>` / `--concurrency=<n>` launch flag from argv.
 * Returns the raw string (possibly empty, so a value-less `--concurrency` fails
 * validation rather than being silently ignored), or `undefined` when the flag
 * is absent.
 */
function readConcurrencyFlag(argv: string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--concurrency') return argv[i + 1] ?? '';
		if (arg.startsWith('--concurrency=')) return arg.slice('--concurrency='.length);
	}
	return undefined;
}

/**
 * Resolve how many jobs this worker runs at once (BullMQ's `concurrency`).
 *
 * Precedence: the `--concurrency <n>` launch flag (so `npm run dev:worker:legacy --
 * --concurrency 2` overrides without editing `.env`), then the
 * `SWARM_WORKER_CONCURRENCY` env var, then {@link DEFAULT_WORKER_CONCURRENCY}.
 * Must resolve to a positive integer — a typo throws rather than silently
 * falling back, naming whichever source supplied the bad value.
 *
 * This is the worker's *process-wide* cap across every project it serves; a
 * project's own `maxConcurrentJobs` and an enrollment's `concurrencyAllocation`
 * bound it further (see `worker-eligibility.ts`).
 */
export function resolveWorkerConcurrency(
	argv: string[] = process.argv.slice(2),
	rawEnv = optionalEnv('SWARM_WORKER_CONCURRENCY', String(DEFAULT_WORKER_CONCURRENCY)),
): number {
	const flag = readConcurrencyFlag(argv);
	const raw = flag ?? rawEnv;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		const source = flag !== undefined ? '--concurrency' : 'SWARM_WORKER_CONCURRENCY';
		throw new Error(`${source} must be a positive integer, got '${raw}'`);
	}
	return value;
}

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
