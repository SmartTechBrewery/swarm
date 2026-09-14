import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RolloutView } from '@/api/worker-update-rollout.js';
import type { Worker } from '@/identity/worker.js';
import type { WorkerUpdateRollout } from '@/identity/worker-update-rollout.js';
import { logger } from '@/lib/logger.js';
import {
	advanceRolloutForWorker,
	advanceRolloutsInProgress,
	advanceWorkerRollout,
	ROLLOUT_ADVANCE_TICK_MS,
	startRolloutAdvanceTicker,
} from '@/router/worker-rollout-advance.js';

/**
 * The triggers that advance a fleet rollout with nobody watching (issue #941).
 *
 * Three collaborators are mocked and nothing else is, on `worker-update-dispatch.test.ts`'s
 * reasoning: the two Postgres reads and the advance itself are datastores and policy
 * this module deliberately owns none of — *when* the advance runs is the thing under
 * test, and it is decided here alone.
 */

const { advanceRollout } = vi.hoisted(() => ({
	advanceRollout: vi.fn<(rolloutId: string) => Promise<RolloutView | undefined>>(),
}));
vi.mock('@/api/worker-update-rollout.js', () => ({ advanceRollout }));

const { findInProgressRolloutForOwner, listInProgressRollouts } = vi.hoisted(() => ({
	findInProgressRolloutForOwner:
		vi.fn<(ownerUserId: string) => Promise<WorkerUpdateRollout | undefined>>(),
	listInProgressRollouts: vi.fn<() => Promise<WorkerUpdateRollout[]>>(),
}));
vi.mock('@/db/repositories/workerUpdateRolloutsRepository.js', () => ({
	findInProgressRolloutForOwner,
	listInProgressRollouts,
}));

const { getWorker } = vi.hoisted(() => ({
	getWorker: vi.fn<(id: string) => Promise<Worker | undefined>>(),
}));
vi.mock('@/identity/worker-service.js', () => ({ getWorker }));

const WORKER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const ROLLOUT_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_ROLLOUT_ID = '88888888-8888-4888-8888-888888888888';

function makeWorker(): Worker {
	return {
		id: WORKER_ID,
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude'],
		probedCapabilities: ['claude'],
		declaredCapabilities: null,
		supportedPhases: ['review'],
		repository: null,
		drainingSince: new Date('2026-09-13T10:00:00Z'),
		update: null,
		worktreeSweep: null,
		build: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

function makeRollout(overrides: Partial<WorkerUpdateRollout> = {}): WorkerUpdateRollout {
	return {
		id: ROLLOUT_ID,
		requestedByUserId: OWNER_ID,
		target: 'main',
		waveSize: 1,
		status: 'in_progress',
		haltReason: null,
		createdAt: new Date('2026-09-13T10:00:00Z'),
		updatedAt: new Date('2026-09-13T10:00:00Z'),
		...overrides,
	};
}

function makeView(rollout: WorkerUpdateRollout): RolloutView {
	return { rollout, members: [] };
}

beforeEach(() => {
	vi.clearAllMocks();
	getWorker.mockResolvedValue(makeWorker());
	findInProgressRolloutForOwner.mockResolvedValue(makeRollout());
	listInProgressRollouts.mockResolvedValue([]);
	advanceRollout.mockImplementation(async (id) => makeView(makeRollout({ id })));
});

describe('advanceRolloutForWorker', () => {
	// The event hooks learn about a *machine*; the rollout is resolved from it through
	// the machine's owner, which is the indexed lookup and the only rollout it can be in.
	it("advances the rollout the machine's operator has under way", async () => {
		await expect(advanceRolloutForWorker(WORKER_ID)).resolves.toBe(true);

		expect(findInProgressRolloutForOwner).toHaveBeenCalledWith(OWNER_ID);
		expect(advanceRollout).toHaveBeenCalledWith(ROLLOUT_ID);
	});

	// The ordinary case for almost every machine: nobody is moving the fleet, so the
	// hook costs two reads and does nothing.
	it('is a no-op when the operator has no rollout in progress', async () => {
		findInProgressRolloutForOwner.mockResolvedValue(undefined);

		await expect(advanceRolloutForWorker(WORKER_ID)).resolves.toBe(false);
		expect(advanceRollout).not.toHaveBeenCalled();
	});

	it('is a no-op for a machine that no longer exists', async () => {
		getWorker.mockResolvedValue(undefined);

		await expect(advanceRolloutForWorker(WORKER_ID)).resolves.toBe(false);
		expect(findInProgressRolloutForOwner).not.toHaveBeenCalled();
		expect(advanceRollout).not.toHaveBeenCalled();
	});

	// The lock answers `undefined` for a rollout that finished and was removed between
	// the two reads; that is not an advance and must not be reported as one.
	it('answers false when the rollout is gone by the time it is advanced', async () => {
		advanceRollout.mockResolvedValue(undefined);

		await expect(advanceRolloutForWorker(WORKER_ID)).resolves.toBe(false);
	});
});

describe('advanceWorkerRollout', () => {
	// Fire-and-forget by contract: a report route and a handshake stay synchronous, so
	// neither can be failed by a rollout.
	it('returns before the advance has run', () => {
		expect(advanceWorkerRollout(WORKER_ID)).toBeUndefined();
	});

	it('advances in the background', async () => {
		advanceWorkerRollout(WORKER_ID);

		await vi.waitFor(() => expect(advanceRollout).toHaveBeenCalledWith(ROLLOUT_ID));
	});

	it('catches and logs a failed advance rather than rethrowing it', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		advanceRollout.mockRejectedValue(new Error('database is down'));

		expect(() => advanceWorkerRollout(WORKER_ID)).not.toThrow();

		await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
		warnSpy.mockRestore();
	});
});

describe('advanceRolloutsInProgress', () => {
	it('advances every rollout that is still moving', async () => {
		listInProgressRollouts.mockResolvedValue([
			makeRollout(),
			makeRollout({ id: OTHER_ROLLOUT_ID, requestedByUserId: 'someone-else' }),
		]);

		await advanceRolloutsInProgress();

		expect(advanceRollout).toHaveBeenCalledWith(ROLLOUT_ID);
		expect(advanceRollout).toHaveBeenCalledWith(OTHER_ROLLOUT_ID);
	});

	// One operator's failure must not stop another operator's fleet from moving — and
	// an unhandled rejection out of a bare `setInterval` callback would take the router
	// down, so nothing here may escape.
	it('carries on past a rollout that failed, and never throws', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		listInProgressRollouts.mockResolvedValue([
			makeRollout(),
			makeRollout({ id: OTHER_ROLLOUT_ID }),
		]);
		advanceRollout.mockRejectedValueOnce(new Error('halt write failed'));

		await expect(advanceRolloutsInProgress()).resolves.toBeUndefined();

		expect(advanceRollout).toHaveBeenCalledWith(OTHER_ROLLOUT_ID);
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	it('swallows a failed read of the live set', async () => {
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		listInProgressRollouts.mockRejectedValue(new Error('database is down'));

		await expect(advanceRolloutsInProgress()).resolves.toBeUndefined();

		expect(advanceRollout).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});

describe('startRolloutAdvanceTicker', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('advances every rollout in progress on each tick', async () => {
		vi.useFakeTimers();
		listInProgressRollouts.mockResolvedValue([makeRollout()]);
		const ticker = startRolloutAdvanceTicker();

		await vi.advanceTimersByTimeAsync(ROLLOUT_ADVANCE_TICK_MS);
		expect(advanceRollout).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(ROLLOUT_ADVANCE_TICK_MS);
		expect(advanceRollout).toHaveBeenCalledTimes(2);

		ticker.close();
	});

	it('ticks no more once it is closed', async () => {
		vi.useFakeTimers();
		listInProgressRollouts.mockResolvedValue([makeRollout()]);
		const ticker = startRolloutAdvanceTicker();

		ticker.close();
		await vi.advanceTimersByTimeAsync(ROLLOUT_ADVANCE_TICK_MS * 3);

		expect(advanceRollout).not.toHaveBeenCalled();
	});

	// A sweep that outruns the interval would only queue a second set of callers behind
	// the same row locks, so a tick arriving while one is still running is skipped.
	it('runs one sweep at a time', async () => {
		vi.useFakeTimers();
		listInProgressRollouts.mockResolvedValue([makeRollout()]);
		let release: () => void = () => {};
		advanceRollout.mockImplementation(
			() =>
				new Promise((resolve) => {
					release = () => resolve(makeView(makeRollout()));
				}),
		);
		const ticker = startRolloutAdvanceTicker();

		await vi.advanceTimersByTimeAsync(ROLLOUT_ADVANCE_TICK_MS * 3);
		expect(advanceRollout).toHaveBeenCalledTimes(1);

		release();
		await vi.advanceTimersByTimeAsync(ROLLOUT_ADVANCE_TICK_MS);
		expect(advanceRollout).toHaveBeenCalledTimes(2);

		ticker.close();
	});
});
