import { describe, expect, it } from 'vitest';
import {
	DEFAULT_WORKER_LOCK_DURATION_MS,
	MAX_WORKER_LOCK_RENEW_TIME_MS,
	resolveWorkerLockOptions,
} from '@/worker/runtime-options.js';

describe('resolveWorkerLockOptions', () => {
	it('uses a long lock with frequent renewal by default', () => {
		expect(resolveWorkerLockOptions(undefined)).toEqual({
			lockDuration: DEFAULT_WORKER_LOCK_DURATION_MS,
			lockRenewTime: MAX_WORKER_LOCK_RENEW_TIME_MS,
		});
	});

	it('caps renewal at half of a short custom lock', () => {
		expect(resolveWorkerLockOptions('20000')).toEqual({
			lockDuration: 20_000,
			lockRenewTime: 10_000,
		});
	});

	it.each(['0', '-1', 'nope', '1.5'])('rejects invalid lock duration %s', (value) => {
		expect(() => resolveWorkerLockOptions(value)).toThrow(
			/SWARM_WORKER_LOCK_DURATION_MS must be a positive integer/,
		);
	});
});
