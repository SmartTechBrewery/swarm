import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { SwarmJob } from '@/queue/jobs.js';

/**
 * The reconnect half of issue #972: a machine coming back is what collapses an
 * offline update's wait, and — across the upgrade from the pub/sub delivery — what
 * writes the dispatch a request recorded by an older control plane never got.
 *
 * Both collaborators are datastores, so both are mocked, exactly as
 * `availability-promotion.test.ts` mocks its own; what is under test is the order the
 * two branches do their work in, which is the part a repository test cannot see.
 */

const findWakeableWorkerUpdateDispatch =
	vi.fn<(workerId: string) => Promise<DispatchRow | undefined>>();
const promoteDispatchToImmediateWake =
	vi.fn<(id: string, wakeSeq: number) => Promise<DispatchRow | null>>();

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	findWakeableWorkerUpdateDispatch: (workerId: string) =>
		findWakeableWorkerUpdateDispatch(workerId),
	promoteDispatchToImmediateWake: (id: string, wakeSeq: number) =>
		promoteDispatchToImmediateWake(id, wakeSeq),
	// Unused here, but imported by the module under test.
	cancelAllWaitingDispatches: vi.fn(),
	cancelWaitingDispatch: vi.fn(),
	claimDispatch: vi.fn(),
	createDispatch: vi.fn(),
	getActiveDispatchByRunId: vi.fn(),
	listAvailabilityWaitsForWorker: vi.fn(),
	listPullRequestInFlightWaits: vi.fn(),
	listTaskInFlightWaits: vi.fn(),
	selectNextCapacityDispatch: vi.fn(),
	supersedeDispatchesByCoalesceKey: vi.fn(),
}));

const adoptOutstandingWorkerUpdateRequest =
	vi.fn<(workerId: string) => Promise<DispatchRow | undefined>>();

vi.mock('@/db/repositories/workersRepository.js', () => ({
	adoptOutstandingWorkerUpdateRequest: (workerId: string) =>
		adoptOutstandingWorkerUpdateRequest(workerId),
}));

const enqueueDispatchWakeUp =
	vi.fn<(job: SwarmJob, jobId: string, delayMs: number) => Promise<string | undefined>>();
const removePendingJobById = vi.fn<(jobId: string) => Promise<boolean>>();

vi.mock('@/queue/producer.js', () => ({
	enqueueDispatchWakeUp: (job: SwarmJob, jobId: string, delayMs: number) =>
		enqueueDispatchWakeUp(job, jobId, delayMs),
	removePendingJobById: (jobId: string) => removePendingJobById(jobId),
	clearPendingJobs: vi.fn(),
	priorityFor: () => -10,
}));

import { promoteWorkerUpdateDispatchForWorker, wakeJobId } from '@/dispatch/dispatcher.js';

const WORKER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const REQUEST_ID = '66666666-6666-4666-8666-666666666666';

function updateJob(): SwarmJob {
	return {
		type: 'worker-update',
		projectId: 'swarm',
		workerId: WORKER_ID,
		requestId: REQUEST_ID,
		target: 'main',
	};
}

function row(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-update-1',
		projectId: 'swarm',
		taskId: null,
		phase: 'worker-update',
		state: 'retry-scheduled',
		waitReason: 'worker-eligibility',
		wakeSeq: 2,
		availableAt: new Date('2026-09-15T08:00:00Z'),
		runId: 'run-1',
		jobPayload: updateJob(),
		...overrides,
	} as DispatchRow;
}

describe('promoteWorkerUpdateDispatchForWorker', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		removePendingJobById.mockResolvedValue(true);
		enqueueDispatchWakeUp.mockResolvedValue('queued');
		findWakeableWorkerUpdateDispatch.mockResolvedValue(undefined);
		adoptOutstandingWorkerUpdateRequest.mockResolvedValue(undefined);
	});

	it('wakes the waiting dispatch and never reaches the adoption path', async () => {
		const waiting = row();
		findWakeableWorkerUpdateDispatch.mockResolvedValue(waiting);
		promoteDispatchToImmediateWake.mockResolvedValue({
			...waiting,
			availableAt: new Date(),
			wakeSeq: waiting.wakeSeq + 1,
		});

		expect(await promoteWorkerUpdateDispatchForWorker(WORKER_ID)).toBe(true);

		expect(removePendingJobById).toHaveBeenCalledWith(wakeJobId(waiting));
		expect(enqueueDispatchWakeUp).toHaveBeenCalledOnce();
		expect(adoptOutstandingWorkerUpdateRequest).not.toHaveBeenCalled();
	});

	// The upgrade case: a request an older control plane recorded has no dispatch at
	// all, so there is nothing to wake and the missing row is written here instead.
	it('adopts a pre-#972 request into a dispatch and publishes its wake-up', async () => {
		// `createDispatch` defaults `availableAt` to now, so its wake-up is immediate.
		const adopted = row({
			id: 'dispatch-adopted',
			state: 'pending',
			wakeSeq: 0,
			availableAt: new Date(Date.now() - 1_000),
		});
		adoptOutstandingWorkerUpdateRequest.mockResolvedValue(adopted);

		expect(await promoteWorkerUpdateDispatchForWorker(WORKER_ID)).toBe(true);

		expect(adoptOutstandingWorkerUpdateRequest).toHaveBeenCalledExactlyOnceWith(WORKER_ID);
		expect(enqueueDispatchWakeUp).toHaveBeenCalledExactlyOnceWith(
			{ ...updateJob(), dispatchId: adopted.id },
			wakeJobId(adopted),
			0,
		);
		// Nothing to remove: the adopted row has never had a wake-up.
		expect(removePendingJobById).not.toHaveBeenCalled();
	});

	// The ordinary path for a machine with nothing outstanding — and for every request
	// recorded since the issue, which already carries its dispatch.
	it('publishes nothing when there is neither a wakeable nor an unwritten dispatch', async () => {
		expect(await promoteWorkerUpdateDispatchForWorker(WORKER_ID)).toBe(false);

		expect(enqueueDispatchWakeUp).not.toHaveBeenCalled();
	});

	// It runs off a socket open, which a datastore hiccup must never fail.
	it('swallows an adoption failure rather than throwing into the socket-open hook', async () => {
		adoptOutstandingWorkerUpdateRequest.mockRejectedValue(new Error('database is down'));

		await expect(promoteWorkerUpdateDispatchForWorker(WORKER_ID)).resolves.toBe(false);
	});
});
