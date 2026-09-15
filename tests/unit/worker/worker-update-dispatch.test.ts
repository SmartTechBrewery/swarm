import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The agent-less executor behind a `worker-update` dispatch (issue #972): it asks
 * the control plane to push one frame and settles its own dispatch against what
 * came back. Everything it touches is a datastore or a socket, so both are mocked
 * and the three push results are the axis under test.
 */

const completeDispatch = vi.fn(async (_id: string, _outcome: string) => true);
const scheduleDispatchRetry = vi.fn(
	async (_id: string, _input: unknown): Promise<DispatchRow | null> =>
		mockDispatchRow({ state: 'retry-scheduled', attempt: 1 }),
);
vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	completeDispatch: (id: string, outcome: string) => completeDispatch(id, outcome),
	scheduleDispatchRetry: (id: string, input: unknown) => scheduleDispatchRetry(id, input),
}));

const publishDispatchWakeUp = vi.fn(async (_dispatch: unknown) => {});
vi.mock('@/dispatch/dispatcher.js', () => ({
	publishDispatchWakeUp: (dispatch: unknown) => publishDispatchWakeUp(dispatch),
}));

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { WorkerUpdateJob } from '@/queue/jobs.js';
import type { WorkerUpdatePushResult } from '@/router/worker-update-dispatch.js';
import {
	processWorkerUpdateDispatch,
	WORKER_UPDATE_RECHECK_INTERVAL_MS,
} from '@/worker/worker-update-dispatch.js';

const WORKER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const REQUEST_ID = '66666666-6666-4666-8666-666666666666';

function mockDispatchRow(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		wakeSeq: 0,
		attempt: 0,
		state: 'leased',
		runId: 'run-1',
		availableAt: new Date(),
		createdAt: new Date(),
		...overrides,
	} as DispatchRow;
}

const job: WorkerUpdateJob = {
	type: 'worker-update',
	projectId: 'proj-1',
	workerId: WORKER_ID,
	requestId: REQUEST_ID,
	target: 'main',
};

function pushing(result: WorkerUpdatePushResult) {
	return vi.fn(async (_workerId: string, _requestId: string) => result);
}

beforeEach(() => {
	completeDispatch.mockClear();
	scheduleDispatchRetry.mockClear();
	publishDispatchWakeUp.mockClear();
});

describe('processWorkerUpdateDispatch', () => {
	it('completes the dispatch as pushed once the frame reaches the machine', async () => {
		const push = pushing('pushed');

		await expect(processWorkerUpdateDispatch(mockDispatchRow(), job, { push })).resolves.toEqual({
			status: 'worker-update-settled',
			result: 'pushed',
			workerId: WORKER_ID,
		});

		expect(push).toHaveBeenCalledExactlyOnceWith(WORKER_ID, REQUEST_ID);
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'worker-update-pushed');
		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
	});

	// A re-target or an already-recorded report: the row moved on, so there is
	// nothing left for this unit to deliver and it settles terminally.
	it('completes the dispatch as superseded when the row no longer waits on the request', async () => {
		await expect(
			processWorkerUpdateDispatch(mockDispatchRow(), job, { push: pushing('superseded') }),
		).resolves.toMatchObject({ result: 'superseded' });

		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'superseded');
		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
	});

	// AC 5 and AC 6: the request is still there when the machine returns, and the
	// record saying why it could not be dispatched is the queue row's own wait reason.
	it('reschedules an offline machine as a worker-eligibility wait and republishes its wake-up', async () => {
		const before = Date.now();

		await expect(
			processWorkerUpdateDispatch(mockDispatchRow(), job, { push: pushing('not-connected') }),
		).resolves.toMatchObject({ result: 'not-connected' });

		expect(completeDispatch).not.toHaveBeenCalled();
		const [id, input] = scheduleDispatchRetry.mock.calls[0] as [
			string,
			{
				jobPayload: WorkerUpdateJob;
				waitReason: string;
				attempt: number;
				runId?: string;
				availableAt: Date;
				lastError?: string;
			},
		];
		expect(id).toBe('dispatch-1');
		expect(input.jobPayload).toEqual(job);
		expect(input.waitReason).toBe('worker-eligibility');
		expect(input.attempt).toBe(1);
		expect(input.runId).toBe('run-1');
		expect(input.availableAt.getTime()).toBeGreaterThanOrEqual(
			before + WORKER_UPDATE_RECHECK_INTERVAL_MS,
		);
		// The actionable sentence an operator reads off the queue row.
		expect(input.lastError).toContain('not connected');
		expect(publishDispatchWakeUp).toHaveBeenCalledTimes(1);
	});

	// Deliberately uncapped, unlike every other `worker-eligibility` wait: the
	// request lives on the `workers` row and the machine will come back, so a
	// spent budget has nothing to give up on.
	it('keeps waiting however many attempts it has already spent', async () => {
		await expect(
			processWorkerUpdateDispatch(mockDispatchRow({ attempt: 500 }), job, {
				push: pushing('not-connected'),
			}),
		).resolves.toMatchObject({ result: 'not-connected' });

		expect(scheduleDispatchRetry.mock.calls[0]?.[1]).toMatchObject({ attempt: 501 });
		expect(completeDispatch).not.toHaveBeenCalled();
	});

	// Cancelled or re-targeted between the push and the settle — whoever got there
	// first wins, and nothing is published for a row that moved on.
	it('publishes nothing when the dispatch settled elsewhere before its retry landed', async () => {
		scheduleDispatchRetry.mockResolvedValueOnce(null);

		await expect(
			processWorkerUpdateDispatch(mockDispatchRow(), job, { push: pushing('not-connected') }),
		).resolves.toMatchObject({ result: 'not-connected' });

		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
	});
});
