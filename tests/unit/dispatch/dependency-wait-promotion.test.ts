import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { SwarmJob } from '@/queue/jobs.js';

/**
 * A blocker becoming done wakes the project's dependency waits (issue #1173). Both
 * collaborators are datastores, so both are mocked, exactly as
 * `merge-checks-promotion.test.ts` mocks its own; what is under test is which
 * waiters are woken and the re-date → publish → remove order, which is what lets a
 * failed publish keep the dispatch's delayed wake-up.
 */

const listDependencyWaits = vi.fn<(projectId: string) => Promise<DispatchRow[]>>();
const promoteDispatchToImmediateWake =
	vi.fn<(id: string, wakeSeq: number) => Promise<DispatchRow | null>>();

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	listDependencyWaits: (projectId: string) => listDependencyWaits(projectId),
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
	listMergeChecksWaits: vi.fn(),
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

const info = vi.fn();
const warn = vi.fn();

vi.mock('@/lib/logger.js', () => ({
	logger: {
		debug: vi.fn(),
		info: (...args: unknown[]) => info(...args),
		warn: (...args: unknown[]) => warn(...args),
		error: vi.fn(),
	},
}));

import { promoteDependencyWaits, wakeJobId } from '@/dispatch/dispatcher.js';

function row(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		projectId: 'proj-1',
		taskId: '101',
		phase: 'implementation',
		state: 'retry-scheduled',
		waitReason: 'dependency',
		wakeSeq: 3,
		// A dependency wait holds a delayed re-check.
		availableAt: new Date(Date.now() + 300_000),
		runId: 'run-1',
		jobPayload: {
			type: 'pm',
			providerId: 'github-projects',
			projectId: 'proj-1',
			dependencyRecheckAttempt: 4,
		},
		...overrides,
	} as DispatchRow;
}

function redated(dispatch: DispatchRow): DispatchRow {
	return { ...dispatch, availableAt: new Date(), wakeSeq: dispatch.wakeSeq + 1 };
}

describe('promoteDependencyWaits', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		removePendingJobById.mockResolvedValue(true);
		enqueueDispatchWakeUp.mockResolvedValue('queued');
		listDependencyWaits.mockResolvedValue([]);
		promoteDispatchToImmediateWake.mockImplementation(async (id, wakeSeq) =>
			redated(row({ id, wakeSeq })),
		);
	});

	it('wakes every waiter: re-date, publish the replacement, then remove the delayed wake-up', async () => {
		const first = row();
		const second = row({ id: 'dispatch-2', taskId: '102', phase: 'planning', wakeSeq: 1 });
		listDependencyWaits.mockResolvedValue([first, second]);
		promoteDispatchToImmediateWake
			.mockResolvedValueOnce(redated(first))
			.mockResolvedValueOnce(redated(second));

		expect(await promoteDependencyWaits('proj-1', 'merged')).toBe(2);

		expect(listDependencyWaits).toHaveBeenCalledExactlyOnceWith('proj-1');
		expect(promoteDispatchToImmediateWake.mock.calls).toEqual([
			[first.id, first.wakeSeq],
			[second.id, second.wakeSeq],
		]);
		const published = enqueueDispatchWakeUp.mock.calls.map(([, jobId, delayMs]) => [
			jobId,
			delayMs,
		]);
		expect(published).toEqual([
			[wakeJobId({ id: first.id, wakeSeq: first.wakeSeq + 1 }), 0],
			[wakeJobId({ id: second.id, wakeSeq: second.wakeSeq + 1 }), 0],
		]);
		// The removed wake-ups are the *original* rows', not the re-dated ones'.
		expect(removePendingJobById.mock.calls).toEqual([[wakeJobId(first)], [wakeJobId(second)]]);
		const [redate] = promoteDispatchToImmediateWake.mock.invocationCallOrder as [number];
		const [publish] = enqueueDispatchWakeUp.mock.invocationCallOrder as [number];
		const [remove] = removePendingJobById.mock.invocationCallOrder as [number];
		expect(redate).toBeLessThan(publish);
		expect(publish).toBeLessThan(remove);
		expect(info).toHaveBeenCalledWith(
			expect.stringContaining('a blocker is done'),
			expect.objectContaining({
				projectId: 'proj-1',
				cause: 'merged',
				promoted: 2,
				taskIds: ['101', '102'],
				phases: ['implementation', 'planning'],
			}),
		);
	});

	it('is a no-op when nothing in the project waits on a dependency', async () => {
		expect(await promoteDependencyWaits('proj-1', 'board-done')).toBe(0);

		expect(promoteDispatchToImmediateWake).not.toHaveBeenCalled();
		expect(enqueueDispatchWakeUp).not.toHaveBeenCalled();
		expect(removePendingJobById).not.toHaveBeenCalled();
		expect(info).not.toHaveBeenCalled();
	});

	// Claimed by its own timer, cancelled, or re-deferred in between.
	it('skips a waiter that moved on before the re-date and still wakes the others', async () => {
		const movedOn = row();
		const waiting = row({ id: 'dispatch-2', wakeSeq: 1 });
		listDependencyWaits.mockResolvedValue([movedOn, waiting]);
		promoteDispatchToImmediateWake.mockResolvedValueOnce(null);

		expect(await promoteDependencyWaits('proj-1', 'board-done')).toBe(1);

		expect(enqueueDispatchWakeUp).toHaveBeenCalledOnce();
		expect(removePendingJobById).toHaveBeenCalledExactlyOnceWith(wakeJobId(waiting));
	});

	it('keeps the delayed wake-up when the publish fails, logs it, and still wakes the next waiter', async () => {
		const first = row();
		const second = row({ id: 'dispatch-2', wakeSeq: 1 });
		listDependencyWaits.mockResolvedValue([first, second]);
		enqueueDispatchWakeUp.mockRejectedValueOnce(new Error('redis is down'));

		expect(await promoteDependencyWaits('proj-1', 'merged')).toBe(1);

		expect(removePendingJobById).toHaveBeenCalledExactlyOnceWith(wakeJobId(second));
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('its delayed wake-up is left in place'),
			expect.objectContaining({ projectId: 'proj-1', cause: 'merged', dispatchId: first.id }),
		);
	});

	// It runs off a settled merge and inside trigger evaluation, neither of which a
	// datastore hiccup may fail.
	it('swallows a read failure', async () => {
		listDependencyWaits.mockRejectedValue(new Error('database is down'));

		await expect(promoteDependencyWaits('proj-1', 'merged')).resolves.toBe(0);

		expect(warn).toHaveBeenCalledWith(
			'dispatch: dependency-wait promotion failed',
			expect.objectContaining({ projectId: 'proj-1', cause: 'merged' }),
		);
	});
});
