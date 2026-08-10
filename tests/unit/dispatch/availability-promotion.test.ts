import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { SwarmJob } from '@/queue/jobs.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';

const listAvailabilityWaitsForWorker = vi.fn<(workerId: string) => Promise<DispatchRow[]>>();
const promoteDispatchToImmediateWake =
	vi.fn<(id: string, wakeSeq: number) => Promise<DispatchRow | null>>();

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	listAvailabilityWaitsForWorker: (workerId: string) => listAvailabilityWaitsForWorker(workerId),
	promoteDispatchToImmediateWake: (id: string, wakeSeq: number) =>
		promoteDispatchToImmediateWake(id, wakeSeq),
	// Unused by these tests, but imported by the module under test.
	cancelAllWaitingDispatches: vi.fn(),
	cancelWaitingDispatch: vi.fn(),
	claimDispatch: vi.fn(),
	createDispatch: vi.fn(),
	getActiveDispatchByRunId: vi.fn(),
	selectNextCapacityDispatch: vi.fn(),
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

import { promoteAvailabilityWaitsForWorker, wakeJobId } from '@/dispatch/dispatcher.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';

function row(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		projectId: 'proj-1',
		taskId: '593',
		phase: 'planning',
		state: 'retry-scheduled',
		waitReason: 'worker-eligibility',
		wakeSeq: 3,
		availableAt: new Date('2026-08-10T07:29:20Z'),
		jobPayload: createMockScmWebhookJob(),
		...overrides,
	} as DispatchRow;
}

/** The row the durable re-date returns: eligible now, on the next wake sequence. */
function promoted(input: DispatchRow): DispatchRow {
	return { ...input, availableAt: new Date(), wakeSeq: input.wakeSeq + 1 };
}

describe('promoteAvailabilityWaitsForWorker', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		removePendingJobById.mockResolvedValue(true);
		enqueueDispatchWakeUp.mockResolvedValue('queued');
		promoteDispatchToImmediateWake.mockImplementation(async (id, wakeSeq) =>
			promoted(row({ id, wakeSeq })),
		);
	});

	it('replaces the delayed wake-up with an immediate one, leaving exactly one behind', async () => {
		const waiting = row();
		listAvailabilityWaitsForWorker.mockResolvedValue([waiting]);

		expect(await promoteAvailabilityWaitsForWorker(WORKER_ID, 'connected')).toBe(1);

		// The stale delayed wake-up is removed *before* the replacement is published,
		// so the row never holds two live wake-ups at once (issue #610).
		expect(removePendingJobById).toHaveBeenCalledWith(wakeJobId(waiting));
		expect(removePendingJobById.mock.invocationCallOrder[0]).toBeLessThan(
			enqueueDispatchWakeUp.mock.invocationCallOrder[0] as number,
		);
		const [, jobId, delayMs] = enqueueDispatchWakeUp.mock.calls[0] as [SwarmJob, string, number];
		expect(jobId).toBe(wakeJobId({ id: waiting.id, wakeSeq: waiting.wakeSeq + 1 }));
		expect(delayMs).toBe(0);
	});

	it('re-dates on the exact wake sequence it read, so two workers waking resolve to one promotion', async () => {
		const waiting = row();
		listAvailabilityWaitsForWorker.mockResolvedValue([waiting]);
		// The second wake-up's conditional re-date matches nothing: the first bumped
		// the wake sequence out from under it.
		promoteDispatchToImmediateWake.mockResolvedValueOnce(promoted(waiting));
		promoteDispatchToImmediateWake.mockResolvedValueOnce(null);

		const [first, second] = await Promise.all([
			promoteAvailabilityWaitsForWorker(WORKER_ID, 'connected'),
			promoteAvailabilityWaitsForWorker('other-worker', 'capacity-freed'),
		]);

		expect(first + second).toBe(1);
		expect(promoteDispatchToImmediateWake).toHaveBeenNthCalledWith(1, waiting.id, waiting.wakeSeq);
		expect(promoteDispatchToImmediateWake).toHaveBeenNthCalledWith(2, waiting.id, waiting.wakeSeq);
		expect(enqueueDispatchWakeUp).toHaveBeenCalledTimes(1);
	});

	it('publishes nothing for a dispatch that moved on between the read and the re-date', async () => {
		listAvailabilityWaitsForWorker.mockResolvedValue([row()]);
		promoteDispatchToImmediateWake.mockResolvedValue(null);

		expect(await promoteAvailabilityWaitsForWorker(WORKER_ID, 'capacity-freed')).toBe(0);
		expect(enqueueDispatchWakeUp).not.toHaveBeenCalled();
	});

	it('swallows a queue failure and keeps promoting the rest', async () => {
		listAvailabilityWaitsForWorker.mockResolvedValue([
			row({ id: 'dispatch-1' }),
			row({ id: 'dispatch-2' }),
		]);
		removePendingJobById.mockRejectedValueOnce(new Error('redis is down'));

		expect(await promoteAvailabilityWaitsForWorker(WORKER_ID, 'capacity-freed')).toBe(1);
		expect(enqueueDispatchWakeUp).toHaveBeenCalledTimes(1);
	});

	it('swallows a read failure rather than failing the settled run that triggered it', async () => {
		listAvailabilityWaitsForWorker.mockRejectedValue(new Error('postgres is down'));

		await expect(promoteAvailabilityWaitsForWorker(WORKER_ID, 'capacity-freed')).resolves.toBe(0);
	});
});
