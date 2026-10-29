import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { SwarmJob } from '@/queue/jobs.js';

/**
 * The release half of the merge queue (issue #1114): a merge dispatch's turn ending
 * wakes the next one waiting on the same repository. Both collaborators are
 * datastores, so both are mocked, exactly as `worker-update-promotion.test.ts` mocks
 * its own; what is under test is which waiter is woken and the order the
 * remove → re-date → publish steps run in.
 */

const listMergeQueueWaits =
	vi.fn<(projectId: string, repository: string) => Promise<DispatchRow[]>>();
const promoteDispatchToImmediateWake =
	vi.fn<(id: string, wakeSeq: number) => Promise<DispatchRow | null>>();

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	listMergeQueueWaits: (projectId: string, repository: string) =>
		listMergeQueueWaits(projectId, repository),
	promoteDispatchToImmediateWake: (id: string, wakeSeq: number) =>
		promoteDispatchToImmediateWake(id, wakeSeq),
	// Unused here, but imported by the module under test.
	cancelAllWaitingDispatches: vi.fn(),
	cancelWaitingDispatch: vi.fn(),
	claimDispatch: vi.fn(),
	createDispatch: vi.fn(),
	findWakeableWorkerUpdateDispatch: vi.fn(),
	getActiveDispatchByRunId: vi.fn(),
	listAvailabilityWaitsForWorker: vi.fn(),
	listPullRequestInFlightWaits: vi.fn(),
	listTaskInFlightWaits: vi.fn(),
	supersedeDispatchesByCoalesceKey: vi.fn(),
}));

const enqueueDispatchWakeUp =
	vi.fn<(job: SwarmJob, jobId: string, delayMs: number) => Promise<string | undefined>>();
const removePendingJobById = vi.fn<(jobId: string) => Promise<boolean>>();

vi.mock('@/queue/producer.js', () => ({
	enqueueDispatchWakeUp: (job: SwarmJob, jobId: string, delayMs: number) =>
		enqueueDispatchWakeUp(job, jobId, delayMs),
	removePendingJobById: (jobId: string) => removePendingJobById(jobId),
	clearPendingJobs: vi.fn(),
	priorityFor: () => undefined,
}));

import { promoteMergeQueueWaits, wakeJobId } from '@/dispatch/dispatcher.js';

const REPO = 'SmartTechBrewery/rover';

function row(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		projectId: 'proj-1',
		taskId: '101',
		phase: 'merge-automation',
		state: 'retry-scheduled',
		waitReason: 'merge-queue',
		wakeSeq: 3,
		// A merge-queue waiter holds a delayed re-check.
		availableAt: new Date(Date.now() + 60_000),
		runId: 'run-1',
		jobPayload: {
			type: 'merge-automation',
			projectId: 'proj-1',
			reviewRunId: 'run-1',
			repo: REPO,
			prNumber: '101',
			approvedHeadSha: 'deadbeef',
		},
		...overrides,
	} as DispatchRow;
}

describe('promoteMergeQueueWaits', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		removePendingJobById.mockResolvedValue(true);
		enqueueDispatchWakeUp.mockResolvedValue('queued');
		listMergeQueueWaits.mockResolvedValue([]);
	});

	it('wakes only the earliest waiter: remove its delayed wake-up, re-date, publish', async () => {
		const first = row();
		const second = row({ id: 'dispatch-2', wakeSeq: 1 });
		listMergeQueueWaits.mockResolvedValue([first, second]);
		promoteDispatchToImmediateWake.mockResolvedValue({
			...first,
			availableAt: new Date(),
			wakeSeq: first.wakeSeq + 1,
		});

		expect(await promoteMergeQueueWaits('proj-1', REPO)).toBe(true);

		expect(listMergeQueueWaits).toHaveBeenCalledExactlyOnceWith('proj-1', REPO);
		expect(removePendingJobById).toHaveBeenCalledExactlyOnceWith(wakeJobId(first));
		expect(promoteDispatchToImmediateWake).toHaveBeenCalledExactlyOnceWith(first.id, first.wakeSeq);
		const [, jobId, delayMs] = enqueueDispatchWakeUp.mock.calls[0] as [SwarmJob, string, number];
		expect(jobId).toBe(wakeJobId({ id: first.id, wakeSeq: first.wakeSeq + 1 }));
		expect(delayMs).toBe(0);
		expect(removePendingJobById.mock.invocationCallOrder[0]).toBeLessThan(
			promoteDispatchToImmediateWake.mock.invocationCallOrder[0] as number,
		);
	});

	it('is a no-op when nothing waits', async () => {
		expect(await promoteMergeQueueWaits('proj-1', REPO)).toBe(false);

		expect(removePendingJobById).not.toHaveBeenCalled();
		expect(enqueueDispatchWakeUp).not.toHaveBeenCalled();
	});

	// Claimed by its own timer, cancelled, or already promoted in between.
	it('publishes nothing when the waiter moved on before the re-date', async () => {
		listMergeQueueWaits.mockResolvedValue([row()]);
		promoteDispatchToImmediateWake.mockResolvedValue(null);

		expect(await promoteMergeQueueWaits('proj-1', REPO)).toBe(false);

		expect(enqueueDispatchWakeUp).not.toHaveBeenCalled();
	});

	// It runs off a settled merge, which a datastore hiccup must never fail.
	it('swallows a read failure', async () => {
		listMergeQueueWaits.mockRejectedValue(new Error('database is down'));

		await expect(promoteMergeQueueWaits('proj-1', REPO)).resolves.toBe(false);
	});

	it('swallows a publish failure', async () => {
		const waiting = row();
		listMergeQueueWaits.mockResolvedValue([waiting]);
		promoteDispatchToImmediateWake.mockResolvedValue({ ...waiting, wakeSeq: 4 });
		enqueueDispatchWakeUp.mockRejectedValue(new Error('redis is down'));

		await expect(promoteMergeQueueWaits('proj-1', REPO)).resolves.toBe(false);
	});
});
