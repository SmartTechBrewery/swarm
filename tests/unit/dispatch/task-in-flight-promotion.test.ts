import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { SwarmJob } from '@/queue/jobs.js';
import { createMockPmWebhookJob } from '../../helpers/factories.js';

const listTaskInFlightWaits =
	vi.fn<(projectId: string, taskId: string) => Promise<DispatchRow[]>>();

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	listTaskInFlightWaits: (projectId: string, taskId: string) =>
		listTaskInFlightWaits(projectId, taskId),
	// Unused by these tests, but imported by the module under test.
	cancelAllWaitingDispatches: vi.fn(),
	cancelWaitingDispatch: vi.fn(),
	claimDispatch: vi.fn(),
	createDispatch: vi.fn(),
	getActiveDispatchByRunId: vi.fn(),
	listAvailabilityWaitsForWorker: vi.fn(),
	promoteDispatchToImmediateWake: vi.fn(),
	selectNextCapacityDispatch: vi.fn(),
	supersedeDispatchesByCoalesceKey: vi.fn(),
}));

const enqueueDispatchWakeUp =
	vi.fn<(job: SwarmJob, jobId: string, delayMs: number) => Promise<string | undefined>>();

vi.mock('@/queue/producer.js', () => ({
	enqueueDispatchWakeUp: (job: SwarmJob, jobId: string, delayMs: number) =>
		enqueueDispatchWakeUp(job, jobId, delayMs),
	removePendingJobById: vi.fn(),
	clearPendingJobs: vi.fn(),
	priorityFor: () => undefined,
}));

import { promoteTaskInFlightWaits, wakeJobId } from '@/dispatch/dispatcher.js';

function row(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		projectId: 'proj-1',
		taskId: '754',
		phase: 'implementation',
		state: 'pending',
		waitReason: 'task-in-flight',
		wakeSeq: 2,
		// A pending wait is eligible now — its wake-up was simply never published.
		availableAt: new Date(Date.now() - 1_000),
		jobPayload: createMockPmWebhookJob(),
		...overrides,
	} as DispatchRow;
}

describe('promoteTaskInFlightWaits', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		enqueueDispatchWakeUp.mockResolvedValue('queued');
	});

	it('publishes an immediate wake-up per waiter at its current wake sequence', async () => {
		const waiting = row();
		listTaskInFlightWaits.mockResolvedValue([waiting]);

		expect(await promoteTaskInFlightWaits('proj-1', '754')).toBe(1);

		expect(listTaskInFlightWaits).toHaveBeenCalledExactlyOnceWith('proj-1', '754');
		const [, jobId, delayMs] = enqueueDispatchWakeUp.mock.calls[0] as [SwarmJob, string, number];
		// No re-dating: the row is already due, so the publish is delay-0 under the id
		// the row already sits on (idempotent if the reconciler published it too).
		expect(jobId).toBe(wakeJobId(waiting));
		expect(delayMs).toBe(0);
	});

	it('wakes every waiter, letting the loser of the race re-defer', async () => {
		listTaskInFlightWaits.mockResolvedValue([row({ id: 'dispatch-1' }), row({ id: 'dispatch-2' })]);

		expect(await promoteTaskInFlightWaits('proj-1', '754')).toBe(2);
		expect(enqueueDispatchWakeUp).toHaveBeenCalledTimes(2);
	});

	it('no-ops when nothing is waiting for the task', async () => {
		listTaskInFlightWaits.mockResolvedValue([]);

		expect(await promoteTaskInFlightWaits('proj-1', '754')).toBe(0);
		expect(enqueueDispatchWakeUp).not.toHaveBeenCalled();
	});

	it('swallows a failure rather than failing the settled run that triggered it', async () => {
		listTaskInFlightWaits.mockRejectedValue(new Error('postgres is down'));
		await expect(promoteTaskInFlightWaits('proj-1', '754')).resolves.toBe(0);

		listTaskInFlightWaits.mockResolvedValue([row()]);
		enqueueDispatchWakeUp.mockRejectedValue(new Error('redis is down'));
		await expect(promoteTaskInFlightWaits('proj-1', '754')).resolves.toBe(0);
	});
});
