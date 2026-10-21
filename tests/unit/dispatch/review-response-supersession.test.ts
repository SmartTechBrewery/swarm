import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
	DispatchRow,
	getDispatchById as GetDispatchById,
	listEarlierWaitingRespondToReviewDispatches as ListEarlier,
	retireWaitingDispatch as RetireWaiting,
} from '@/db/repositories/dispatchesRepository.js';

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	getDispatchById: vi.fn<typeof GetDispatchById>(),
	listEarlierWaitingRespondToReviewDispatches: vi.fn<typeof ListEarlier>(),
	retireWaitingDispatch: vi.fn<typeof RetireWaiting>(),
}));

vi.mock('@/queue/producer.js', () => ({
	removePendingJobById: vi.fn<(jobId: string) => Promise<boolean>>(),
}));

// Only the deterministic id helper is needed, and it is pure — mocked rather than
// imported so the real module's BullMQ/Postgres imports stay out of a unit run.
vi.mock('@/dispatch/dispatcher.js', () => ({
	wakeJobId: (dispatch: { id: string; wakeSeq: number }) =>
		`dispatch_${dispatch.id}_w${dispatch.wakeSeq}`,
}));

import {
	getDispatchById,
	listEarlierWaitingRespondToReviewDispatches,
	retireWaitingDispatch,
} from '@/db/repositories/dispatchesRepository.js';
import { retireSupersededReviewResponses } from '@/dispatch/review-response-supersession.js';
import { removePendingJobById } from '@/queue/producer.js';

const ASKING_CREATED_AT = new Date('2026-10-21T11:30:39Z');

/** A waiting Respond-to-review dispatch row, only the columns this module reads. */
function row(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'd-stale',
		wakeSeq: 3,
		phase: 'respond-to-review',
		runId: 'run-respond',
		...overrides,
	} as DispatchRow;
}

const INPUT = {
	projectId: 'proj-1',
	taskId: '1439-respond',
	excludeDispatchId: 'd-new',
};

/** Stage the waiting rows the read answers with; the settle echoes the row it was asked about. */
function stage(rows: DispatchRow[]): void {
	vi.mocked(listEarlierWaitingRespondToReviewDispatches).mockResolvedValue(rows);
	vi.mocked(retireWaitingDispatch).mockImplementation(async (id) => {
		const found = rows.find((candidate) => candidate.id === id);
		return found ? { dispatch: found, runSettled: true } : null;
	});
}

beforeEach(() => {
	vi.mocked(getDispatchById)
		.mockReset()
		.mockResolvedValue(row({ id: 'd-new', createdAt: ASKING_CREATED_AT }));
	vi.mocked(listEarlierWaitingRespondToReviewDispatches).mockReset();
	vi.mocked(retireWaitingDispatch).mockReset();
	vi.mocked(removePendingJobById).mockReset().mockResolvedValue(true);
	stage([]);
});

describe('retireSupersededReviewResponses', () => {
	it('reads earlier waiting responses for the task, cut off at the asking dispatch’s creation', async () => {
		expect(await retireSupersededReviewResponses(INPUT)).toBe(0);
		expect(getDispatchById).toHaveBeenCalledWith('d-new');
		expect(listEarlierWaitingRespondToReviewDispatches).toHaveBeenCalledWith(
			'proj-1',
			'1439-respond',
			'd-new',
			ASKING_CREATED_AT,
		);
		expect(retireWaitingDispatch).not.toHaveBeenCalled();
	});

	it('retires each earlier waiting response with a superseded reason and removes its own wake-up', async () => {
		stage([row({ id: 'd-a', wakeSeq: 2 }), row({ id: 'd-b', wakeSeq: 5, runId: null })]);

		expect(await retireSupersededReviewResponses(INPUT)).toBe(2);
		expect(vi.mocked(retireWaitingDispatch).mock.calls.map(([id]) => id)).toEqual(['d-a', 'd-b']);
		const reason = vi.mocked(retireWaitingDispatch).mock.calls[0][1];
		expect(reason).toContain('Superseded');
		expect(reason).toContain('Respond-to-review');
		expect(vi.mocked(removePendingJobById).mock.calls.map(([id]) => id)).toEqual([
			'dispatch_d-a_w2',
			'dispatch_d-b_w5',
		]);
	});

	// The conditional cancel lost: a worker claimed it meanwhile, so it is executing
	// and stopping it stays Terminate's job.
	it('skips a row claimed between the read and the cancel, and does not count it', async () => {
		stage([row({ id: 'd-a' }), row({ id: 'd-claimed' })]);
		const settle = vi.mocked(retireWaitingDispatch).getMockImplementation();
		vi.mocked(retireWaitingDispatch).mockImplementation(async (id, reason) =>
			id === 'd-claimed' ? null : (settle?.(id, reason) ?? null),
		);

		expect(await retireSupersededReviewResponses(INPUT)).toBe(1);
		expect(vi.mocked(removePendingJobById).mock.calls.map(([id]) => id)).toEqual([
			'dispatch_d-a_w3',
		]);
	});

	it('retires nothing when the asking dispatch is gone', async () => {
		vi.mocked(getDispatchById).mockResolvedValue(undefined);

		expect(await retireSupersededReviewResponses(INPUT)).toBe(0);
		expect(listEarlierWaitingRespondToReviewDispatches).not.toHaveBeenCalled();
	});

	it('fails open — a failing read answers 0 instead of throwing', async () => {
		vi.mocked(listEarlierWaitingRespondToReviewDispatches).mockRejectedValue(
			new Error('connection reset'),
		);

		await expect(retireSupersededReviewResponses(INPUT)).resolves.toBe(0);
		expect(retireWaitingDispatch).not.toHaveBeenCalled();
	});
});
