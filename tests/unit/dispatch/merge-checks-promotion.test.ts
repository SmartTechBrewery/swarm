import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { SwarmJob } from '@/queue/jobs.js';

/**
 * A green head wakes the merge waiting on its checks (issue #1173). Both
 * collaborators are datastores, so both are mocked, exactly as
 * `merge-queue-promotion.test.ts` mocks its own; what is under test is which
 * waiters are woken and the re-date → publish → remove order, which is what lets a
 * failed publish keep the dispatch's delayed wake-up.
 */

const listMergeChecksWaits =
	vi.fn<(projectId: string, repository: string, headSha: string) => Promise<DispatchRow[]>>();
const promoteDispatchToImmediateWake =
	vi.fn<(id: string, wakeSeq: number) => Promise<DispatchRow | null>>();

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	listMergeChecksWaits: (projectId: string, repository: string, headSha: string) =>
		listMergeChecksWaits(projectId, repository, headSha),
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
	listMergeQueueWaits: vi.fn(),
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

const warn = vi.fn();

vi.mock('@/lib/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: (...args: unknown[]) => warn(...args),
		error: vi.fn(),
	},
}));

import { promoteMergeChecksWaits, wakeJobId } from '@/dispatch/dispatcher.js';

const REPO = 'SmartTechBrewery/rover';
const HEAD = 'deadbeef';

function row(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		projectId: 'proj-1',
		taskId: '101',
		phase: 'merge-automation',
		state: 'retry-scheduled',
		waitReason: 'recheck',
		wakeSeq: 3,
		// A merge waiting on its head's checks holds a delayed backoff slot.
		availableAt: new Date(Date.now() + 60_000),
		runId: 'run-1',
		jobPayload: {
			type: 'merge-automation',
			projectId: 'proj-1',
			reviewRunId: 'run-1',
			repo: REPO,
			prNumber: '101',
			approvedHeadSha: HEAD,
		},
		...overrides,
	} as DispatchRow;
}

function redated(dispatch: DispatchRow): DispatchRow {
	return { ...dispatch, availableAt: new Date(), wakeSeq: dispatch.wakeSeq + 1 };
}

describe('promoteMergeChecksWaits', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		removePendingJobById.mockResolvedValue(true);
		enqueueDispatchWakeUp.mockResolvedValue('queued');
		listMergeChecksWaits.mockResolvedValue([]);
		promoteDispatchToImmediateWake.mockImplementation(async (id, wakeSeq) =>
			redated(row({ id, wakeSeq })),
		);
	});

	it('wakes the waiter: re-date, publish the replacement, then remove the delayed wake-up', async () => {
		const waiting = row();
		listMergeChecksWaits.mockResolvedValue([waiting]);

		expect(await promoteMergeChecksWaits('proj-1', REPO, HEAD)).toBe(1);

		expect(listMergeChecksWaits).toHaveBeenCalledExactlyOnceWith('proj-1', REPO, HEAD);
		expect(promoteDispatchToImmediateWake).toHaveBeenCalledExactlyOnceWith(
			waiting.id,
			waiting.wakeSeq,
		);
		const [, jobId, delayMs] = enqueueDispatchWakeUp.mock.calls[0] as [SwarmJob, string, number];
		expect(jobId).toBe(wakeJobId({ id: waiting.id, wakeSeq: waiting.wakeSeq + 1 }));
		expect(delayMs).toBe(0);
		// The removed wake-up is the *original* row's, not the re-dated one's.
		expect(removePendingJobById).toHaveBeenCalledExactlyOnceWith(wakeJobId(waiting));
		const [redate] = promoteDispatchToImmediateWake.mock.invocationCallOrder as [number];
		const [publish] = enqueueDispatchWakeUp.mock.invocationCallOrder as [number];
		const [remove] = removePendingJobById.mock.invocationCallOrder as [number];
		expect(redate).toBeLessThan(publish);
		expect(publish).toBeLessThan(remove);
	});

	it('wakes every listed waiter', async () => {
		listMergeChecksWaits.mockResolvedValue([row(), row({ id: 'dispatch-2', wakeSeq: 1 })]);

		expect(await promoteMergeChecksWaits('proj-1', REPO, HEAD)).toBe(2);

		expect(enqueueDispatchWakeUp).toHaveBeenCalledTimes(2);
		expect(removePendingJobById).toHaveBeenCalledTimes(2);
	});

	it('is a no-op when no merge waits on the head', async () => {
		expect(await promoteMergeChecksWaits('proj-1', REPO, HEAD)).toBe(0);

		expect(promoteDispatchToImmediateWake).not.toHaveBeenCalled();
		expect(enqueueDispatchWakeUp).not.toHaveBeenCalled();
		expect(removePendingJobById).not.toHaveBeenCalled();
	});

	// Claimed by its own timer, cancelled, or re-deferred in between.
	it('publishes and removes nothing when the waiter moved on before the re-date', async () => {
		listMergeChecksWaits.mockResolvedValue([row()]);
		promoteDispatchToImmediateWake.mockResolvedValue(null);

		expect(await promoteMergeChecksWaits('proj-1', REPO, HEAD)).toBe(0);

		expect(enqueueDispatchWakeUp).not.toHaveBeenCalled();
		expect(removePendingJobById).not.toHaveBeenCalled();
	});

	it('keeps the delayed wake-up when the publish fails, logs it, and still wakes the next waiter', async () => {
		const first = row();
		const second = row({ id: 'dispatch-2', wakeSeq: 1 });
		listMergeChecksWaits.mockResolvedValue([first, second]);
		enqueueDispatchWakeUp.mockRejectedValueOnce(new Error('redis is down'));

		expect(await promoteMergeChecksWaits('proj-1', REPO, HEAD)).toBe(1);

		expect(removePendingJobById).toHaveBeenCalledExactlyOnceWith(wakeJobId(second));
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('its delayed wake-up is left in place'),
			expect.objectContaining({ dispatchId: first.id, headSha: HEAD }),
		);
	});

	it('still counts a woken merge whose delayed wake-up could not be removed', async () => {
		listMergeChecksWaits.mockResolvedValue([row()]);
		removePendingJobById.mockRejectedValue(new Error('redis is down'));

		await expect(promoteMergeChecksWaits('proj-1', REPO, HEAD)).resolves.toBe(1);

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('could not remove the delayed wake-up'),
			expect.objectContaining({ dispatchId: 'dispatch-1' }),
		);
	});

	// It runs inside trigger evaluation, which a datastore hiccup must never fail.
	it('swallows a read failure', async () => {
		listMergeChecksWaits.mockRejectedValue(new Error('database is down'));

		await expect(promoteMergeChecksWaits('proj-1', REPO, HEAD)).resolves.toBe(0);
	});
});
