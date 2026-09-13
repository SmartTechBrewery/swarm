import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
	DispatchRow,
	listRetirableBoardDispatchesForTask as ListRetirable,
	retireWaitingBoardDispatch as RetireWaiting,
} from '@/db/repositories/dispatchesRepository.js';

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	listRetirableBoardDispatchesForTask: vi.fn<typeof ListRetirable>(),
	retireWaitingBoardDispatch: vi.fn<typeof RetireWaiting>(),
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
	listRetirableBoardDispatchesForTask,
	retireWaitingBoardDispatch,
} from '@/db/repositories/dispatchesRepository.js';
import { retireSupersededBoardPhases } from '@/dispatch/board-phase-retirement.js';
import { removePendingJobById } from '@/queue/producer.js';

/** A waiting board-driven dispatch row, only the columns this module reads. */
function row(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'd-stale',
		wakeSeq: 3,
		phase: 'implementation',
		runId: 'run-stale',
		...overrides,
	} as DispatchRow;
}

const INPUT = {
	projectId: 'proj-1',
	taskId: '21',
	keepPhase: 'planning' as const,
	excludeDispatchId: 'd-current',
};

/**
 * Stage the waiting rows the read answers with, and make the settle echo the very
 * row it was asked about — so a test asserting on the wake-up job id is asserting
 * on that row's own `wakeSeq` rather than on a fixture default.
 */
function stage(rows: DispatchRow[]): void {
	vi.mocked(listRetirableBoardDispatchesForTask).mockResolvedValue(rows);
	vi.mocked(retireWaitingBoardDispatch).mockImplementation(async (id) => {
		const found = rows.find((candidate) => candidate.id === id);
		return found ? { dispatch: found, runSettled: true } : null;
	});
}

beforeEach(() => {
	vi.mocked(listRetirableBoardDispatchesForTask).mockReset();
	vi.mocked(retireWaitingBoardDispatch).mockReset();
	vi.mocked(removePendingJobById).mockReset().mockResolvedValue(true);
	stage([]);
});

describe('retireSupersededBoardPhases', () => {
	it('threads the card key, the phase to keep, and the asking dispatch into the read', async () => {
		expect(await retireSupersededBoardPhases(INPUT)).toBe(0);
		expect(listRetirableBoardDispatchesForTask).toHaveBeenCalledWith(
			'proj-1',
			'21',
			'planning',
			'd-current',
		);
		// Nothing waiting — no settle, no wake-up removal, nothing logged.
		expect(retireWaitingBoardDispatch).not.toHaveBeenCalled();
		expect(removePendingJobById).not.toHaveBeenCalled();
	});

	// A column that starts no phase is the same rule, not a second one: the read is
	// asked for *every* waiting board phase of the task.
	it('passes an undefined keepPhase through for a column that starts no phase', async () => {
		await retireSupersededBoardPhases({ ...INPUT, keepPhase: undefined });
		expect(listRetirableBoardDispatchesForTask).toHaveBeenCalledWith(
			'proj-1',
			'21',
			undefined,
			'd-current',
		);
	});

	it('settles each waiting row and removes its wake-up under its own wake sequence', async () => {
		stage([row({ id: 'd-1', wakeSeq: 0 }), row({ id: 'd-2', wakeSeq: 7 })]);

		expect(await retireSupersededBoardPhases(INPUT)).toBe(2);
		expect(vi.mocked(retireWaitingBoardDispatch).mock.calls.map(([id]) => id)).toEqual([
			'd-1',
			'd-2',
		]);
		expect(vi.mocked(removePendingJobById).mock.calls.map(([id]) => id)).toEqual([
			'dispatch_d-1_w0',
			'dispatch_d-2_w7',
		]);
	});

	// The conditional cancel losing means a worker claimed the dispatch in between —
	// it is executing now, so it is neither counted nor stripped of its wake-up.
	it('counts out a row that was claimed between the read and the settle', async () => {
		stage([row({ id: 'd-claimed' }), row({ id: 'd-waiting' })]);
		// The conditional cancel loses for the one a worker took.
		const settle = vi.mocked(retireWaitingBoardDispatch).getMockImplementation();
		vi.mocked(retireWaitingBoardDispatch).mockImplementation(async (id, reason) =>
			id === 'd-claimed' ? null : ((await settle?.(id, reason)) ?? null),
		);

		expect(await retireSupersededBoardPhases(INPUT)).toBe(1);
		expect(vi.mocked(removePendingJobById).mock.calls.map(([id]) => id)).toEqual([
			'dispatch_d-waiting_w3',
		]);
	});

	it('keeps retiring the remaining rows when a wake-up removal rejects', async () => {
		stage([row({ id: 'd-1' }), row({ id: 'd-2' })]);
		vi.mocked(removePendingJobById).mockRejectedValue(new Error('redis down'));

		expect(await retireSupersededBoardPhases(INPUT)).toBe(2);
	});

	// Fail-open: the failure direction is "a stale phase survives", which is what
	// happened before this rule existed — never failing an otherwise-good dispatch.
	it('swallows a read failure and reports nothing retired', async () => {
		vi.mocked(listRetirableBoardDispatchesForTask).mockRejectedValue(new Error('db down'));
		expect(await retireSupersededBoardPhases(INPUT)).toBe(0);
	});

	it('swallows a settle failure and reports nothing retired', async () => {
		stage([row()]);
		vi.mocked(retireWaitingBoardDispatch).mockRejectedValue(new Error('deadlock'));
		expect(await retireSupersededBoardPhases(INPUT)).toBe(0);
	});

	describe('the reason recorded on the retired dispatch and its run', () => {
		async function reasonFor(keepPhase: 'planning' | undefined): Promise<string> {
			stage([row({ id: 'd-1', phase: 'implementation' })]);
			await retireSupersededBoardPhases({ ...INPUT, keepPhase });
			return vi.mocked(retireWaitingBoardDispatch).mock.calls[0][1];
		}

		it('names both the retired phase and the one the column now asks for', async () => {
			const reason = await reasonFor('planning');
			expect(reason).toContain('Implementation');
			expect(reason).toContain('Planning');
		});

		it('says the column starts no phase when it does not', async () => {
			const reason = await reasonFor(undefined);
			expect(reason).toContain('starts no phase');
			expect(reason).toContain('Implementation');
		});

		// ai/RULES.md §2: shared code speaks the canonical phase vocabulary, never a
		// board's own column names.
		it('carries no board-native status vocabulary', async () => {
			for (const reason of [await reasonFor('planning'), await reasonFor(undefined)]) {
				expect(reason).not.toMatch(/ToDo|Backlog|In progress|In review|Done|Ready/i);
			}
		});
	});
});
