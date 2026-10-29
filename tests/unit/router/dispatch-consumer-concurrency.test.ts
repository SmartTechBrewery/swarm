import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CONCURRENCY_ALLOCATION } from '@/identity/worker-enrollment.js';
import * as dispatcherModule from '@/router/dispatcher.js';
import { DISPATCH_CONSUMER_CONCURRENCY } from '@/router/dispatcher.js';

/**
 * Issue #811 removed `SWARM_WORKER_CONCURRENCY`, a third — invisible — cap that
 * bounded the whole control plane to one dispatch by default. These are the
 * tripwires for it coming back: the BullMQ throttle must stay far above the
 * job-level bound an operator can actually see and edit — an enrollment's
 * `concurrencyAllocation`, the only one since issue #1190 retired the project-wide
 * cap — and must not be read from the environment.
 */
describe('dispatch consumer concurrency', () => {
	afterEach(() => {
		delete process.env.SWARM_WORKER_CONCURRENCY;
		vi.resetModules();
	});

	it('is never the tighter cap next to the visible one', () => {
		expect(DISPATCH_CONSUMER_CONCURRENCY).toBeGreaterThan(DEFAULT_CONCURRENCY_ALLOCATION);
		// Above a realistic aggregate of every enrollment's `concurrencyAllocation`, so
		// the router's fan-out bound can never be what an installation actually hits
		// first.
		expect(DISPATCH_CONSUMER_CONCURRENCY).toBeGreaterThanOrEqual(50);
	});

	it('is not read from the environment', async () => {
		process.env.SWARM_WORKER_CONCURRENCY = '1';
		vi.resetModules();
		const reloaded = await import('@/router/dispatcher.js');
		// A distinct module namespace object proves resetModules() actually produced a
		// fresh instance — without this, a silently-failed reload would still pass the
		// value check below by comparing the cached module against itself.
		expect(reloaded).not.toBe(dispatcherModule);
		expect(reloaded.DISPATCH_CONSUMER_CONCURRENCY).toBe(100);
	});
});
