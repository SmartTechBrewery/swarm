import { describe, expect, it, vi } from 'vitest';

import type { ProjectRecord } from '@/config/schema.js';
import type { PipelineRunRow, RunRow } from '@/db/repositories/runsRepository.js';
import type { ResolveProblemTicketCandidate } from '@/dispatch/resolve-problem.js';
import {
	dispatchResolveProblemForFailedRuns,
	dispatchResolveProblemForWaitingTickets,
	RESOLVE_PROBLEM_DELAY_MS,
	RESOLVE_PROBLEM_LOOKBACK_MS,
	resolveProblemProjectIds,
	resolveProblemWindow,
	waitingTicketCandidates,
} from '@/dispatch/resolve-problem-trigger.js';
import type { WipTicket, WipUsageEntry } from '@/queue/wip-usage.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const ON = createMockProjectConfig({ id: 'on', pipeline: { resolveProblem: { enabled: true } } });
const OFF = createMockProjectConfig({
	id: 'off',
	pipeline: { resolveProblem: { enabled: false } },
});
const UNSET = createMockProjectConfig({ id: 'unset' });
const NOW = new Date('2026-11-10T12:00:00Z');

function failedRun(id: string): PipelineRunRow {
	return { id, projectId: ON.id, repository: ON.repo, taskId: '7' } as PipelineRunRow;
}

describe('resolveProblemProjectIds (issue #1396)', () => {
	it('keeps only the projects that turned the phase on — it is off unless set', () => {
		expect(resolveProblemProjectIds([ON, OFF, UNSET])).toEqual(['on']);
	});
});

describe('resolveProblemWindow (issue #1396)', () => {
	it('reads failures settled at least the delay ago, within the lookback', () => {
		expect(RESOLVE_PROBLEM_DELAY_MS).toBe(10 * 60 * 1000);
		expect(resolveProblemWindow(NOW)).toEqual({
			settledBefore: new Date(NOW.getTime() - RESOLVE_PROBLEM_DELAY_MS),
			since: new Date(NOW.getTime() - RESOLVE_PROBLEM_LOOKBACK_MS),
		});
	});
});

describe('dispatchResolveProblemForFailedRuns (issue #1396)', () => {
	it('does not query for candidates while no project has the phase on', async () => {
		const listCandidates = vi.fn(async () => [failedRun('a')]);
		const schedule = vi.fn(async () => ({ created: true }));

		const created = await dispatchResolveProblemForFailedRuns({
			listProjects: async () => [OFF, UNSET],
			listCandidates,
			schedule,
		});

		expect(created).toEqual([]);
		expect(listCandidates).not.toHaveBeenCalled();
		expect(schedule).not.toHaveBeenCalled();
	});

	it('scopes the read to enabled projects and the window, and dispatches each candidate', async () => {
		const listCandidates = vi.fn(async () => [failedRun('a'), failedRun('b')]);
		const schedule = vi.fn(async (_run: PipelineRunRow) => ({ created: true }));

		const created = await dispatchResolveProblemForFailedRuns({
			listProjects: async () => [ON, OFF],
			listCandidates,
			schedule,
			now: () => NOW,
		});

		expect(listCandidates).toHaveBeenCalledWith({
			projectIds: ['on'],
			...resolveProblemWindow(NOW),
		});
		expect(schedule.mock.calls.map(([run]) => run.id)).toEqual(['a', 'b']);
		expect(created).toEqual(['a', 'b']);
	});

	it('creates one dispatch from two concurrent passes over the same failed run', async () => {
		// The dedup key `resolve-problem:<failedRunId>` is what the real schedule answers
		// `created: false` on; this stands in for its unique index.
		const keys = new Set<string>();
		const schedule = vi.fn(async (run: PipelineRunRow) => {
			await Promise.resolve();
			const key = `resolve-problem:${run.id}`;
			if (keys.has(key)) return { created: false };
			keys.add(key);
			return { created: true };
		});
		const deps = {
			listProjects: async () => [ON],
			listCandidates: async () => [failedRun('a')],
			schedule,
		};

		const passes = await Promise.all([
			dispatchResolveProblemForFailedRuns(deps),
			dispatchResolveProblemForFailedRuns(deps),
		]);

		expect(schedule).toHaveBeenCalledTimes(2);
		expect(passes.flat()).toEqual(['a']);
		expect(keys.size).toBe(1);
	});

	it('logs a failed dispatch and carries on with the rest', async () => {
		const schedule = vi
			.fn<(run: PipelineRunRow) => Promise<{ created: boolean }>>()
			.mockRejectedValueOnce(new Error('db down'))
			.mockResolvedValueOnce({ created: true });

		const created = await dispatchResolveProblemForFailedRuns({
			listProjects: async () => [ON],
			listCandidates: async () => [failedRun('a'), failedRun('b')],
			schedule,
		});

		expect(created).toEqual(['b']);
	});

	it('never throws when a read fails', async () => {
		await expect(
			dispatchResolveProblemForFailedRuns({
				listProjects: async () => {
					throw new Error('db down');
				},
			}),
		).resolves.toEqual([]);
	});
});

describe('waitingTicketCandidates (issue #1425)', () => {
	const LONG_AGO = '2026-11-09T12:00:00.000Z';
	function ticket(taskId: string, overrides: Partial<WipTicket> = {}): WipTicket {
		return {
			taskId,
			openedPhase: 'implementation',
			openedAt: LONG_AGO,
			state: 'waiting-on-operator',
			...overrides,
		};
	}
	function entry(tickets: WipTicket[]): WipUsageEntry {
		return {
			projectId: ON.id,
			repository: ON.repo,
			limit: 5,
			inFlight: tickets.length,
			waiting: 0,
			tickets,
		};
	}

	it('takes on only stalled and failed Waiting-on-you holders', () => {
		const entries = [
			entry([
				ticket('stalled', { operatorReason: 'stalled', latestRunId: 'run-s' }),
				ticket('failed', { operatorReason: 'failed', latestRunId: 'run-f' }),
				ticket('terminated', { operatorReason: 'terminated', latestRunId: 'run-t' }),
				ticket('capped', { operatorReason: 'review-cap-reached', latestRunId: 'run-c' }),
				ticket('plan', { operatorReason: 'plan-awaiting-greenlight', latestRunId: 'run-p' }),
				ticket('merge', { operatorReason: 'approved-awaiting-merge', latestRunId: 'run-m' }),
				ticket('no-reason'),
				ticket('running', { state: 'running', latestRunId: 'run-r' }),
				ticket('pipeline', { state: 'waiting-on-pipeline', latestRunId: 'run-q' }),
			]),
		];
		expect(waitingTicketCandidates(entries, NOW).map((c) => c.taskId)).toEqual([
			'stalled',
			'failed',
		]);
	});

	it('maps failed to a run attempt and stalled to a ticket attempt, with or without a run', () => {
		const entries = [
			entry([
				ticket('failed', { operatorReason: 'failed', latestRunId: 'run-f' }),
				ticket('stalled-ran', {
					operatorReason: 'stalled',
					latestRunId: 'run-s',
					prNumber: '42',
					workItemId: 'card',
				}),
				ticket('stalled-never', { operatorReason: 'stalled' }),
			]),
		];
		expect(waitingTicketCandidates(entries, NOW)).toEqual([
			{ kind: 'run', runId: 'run-f', projectId: ON.id, repository: ON.repo, taskId: 'failed' },
			{
				kind: 'ticket',
				projectId: ON.id,
				repository: ON.repo,
				taskId: 'stalled-ran',
				slotOpenedAt: LONG_AGO,
				latestRunId: 'run-s',
				prNumber: '42',
				workItemId: 'card',
			},
			{
				kind: 'ticket',
				projectId: ON.id,
				repository: ON.repo,
				taskId: 'stalled-never',
				slotOpenedAt: LONG_AGO,
			},
		]);
	});

	it('waits the delay since the holder last moved, and skips a failed holder naming no run', () => {
		const justNow = new Date(NOW.getTime() - RESOLVE_PROBLEM_DELAY_MS + 1000).toISOString();
		const entries = [
			entry([
				ticket('fresh', { operatorReason: 'failed', latestRunId: 'r', lastActivityAt: justNow }),
				ticket('no-run', { operatorReason: 'failed' }),
			]),
		];
		expect(waitingTicketCandidates(entries, NOW)).toEqual([]);
	});
});

describe('dispatchResolveProblemForWaitingTickets (issue #1425)', () => {
	const RECORD_ON = { id: 'on', pipeline: { resolveProblem: { enabled: true } } } as ProjectRecord;
	const RECORD_OFF = { id: 'off', pipeline: {} } as ProjectRecord;
	const OPENED = '2026-11-09T12:00:00.000Z';
	const ENTRIES: WipUsageEntry[] = [
		{
			projectId: 'on',
			repository: ON.repo,
			limit: 5,
			inFlight: 3,
			waiting: 0,
			tickets: [
				{
					taskId: '1',
					openedPhase: 'implementation',
					openedAt: OPENED,
					state: 'waiting-on-operator',
					operatorReason: 'failed',
					latestRunId: 'run-failed',
				},
				{
					taskId: '2',
					openedPhase: 'implementation',
					openedAt: OPENED,
					state: 'waiting-on-operator',
					operatorReason: 'stalled',
					latestRunId: 'run-done',
				},
				{
					taskId: '3',
					openedPhase: 'planning',
					openedAt: OPENED,
					state: 'waiting-on-operator',
					operatorReason: 'stalled',
				},
			],
		},
	];
	function run(id: string, overrides: Partial<RunRow> = {}): RunRow {
		return {
			id,
			projectId: 'on',
			repository: ON.repo,
			resetStartedAt: null,
			nextRetryAt: null,
			cancellation: null,
			...overrides,
		} as RunRow;
	}

	it('reads nothing while no project has the phase on', async () => {
		const loadWaiting = vi.fn(async () => ENTRIES);
		expect(
			await dispatchResolveProblemForWaitingTickets({
				listProjects: async () => [RECORD_OFF],
				loadWaiting,
			}),
		).toEqual([]);
		expect(loadWaiting).not.toHaveBeenCalled();
	});

	it('dispatches a run attempt for a failed holder and ticket attempts for stalled ones', async () => {
		const loadWaiting = vi.fn(async () => ENTRIES);
		const scheduleRun = vi.fn(async (_run: Pick<RunRow, 'id'>) => ({ created: true }));
		const scheduleTicket = vi.fn(async (_t: ResolveProblemTicketCandidate) => ({ created: true }));

		const created = await dispatchResolveProblemForWaitingTickets({
			listProjects: async () => [RECORD_ON, RECORD_OFF],
			loadWaiting,
			readRun: async (id) => run(id),
			scheduleRun,
			scheduleTicket,
			now: () => NOW,
		});

		expect(loadWaiting).toHaveBeenCalledWith([RECORD_ON], ['on']);
		expect(scheduleRun.mock.calls.map(([r]) => r.id)).toEqual(['run-failed']);
		expect(scheduleTicket.mock.calls.map(([t]) => t)).toEqual([
			{
				projectId: 'on',
				repository: ON.repo,
				taskId: '2',
				slotOpenedAt: OPENED,
				latestRunId: 'run-done',
			},
			{ projectId: 'on', repository: ON.repo, taskId: '3', slotOpenedAt: OPENED },
		]);
		expect(created).toEqual(['run-failed', `on/${ON.repo}#2`, `on/${ON.repo}#3`]);
	});

	it('skips a holder whose run is being Reset or retries by itself, and counts no repeat', async () => {
		const scheduleRun = vi.fn(async () => ({ created: true }));
		const scheduleTicket = vi.fn(async () => ({ created: false }));

		const created = await dispatchResolveProblemForWaitingTickets({
			listProjects: async () => [RECORD_ON],
			loadWaiting: async () => ENTRIES,
			readRun: async (id) =>
				id === 'run-failed'
					? run(id, { resetStartedAt: new Date('2026-11-10T11:00:00Z') })
					: run(id, { nextRetryAt: new Date('2026-11-10T13:00:00Z') }),
			scheduleRun,
			scheduleTicket,
			now: () => NOW,
		});

		expect(scheduleRun).not.toHaveBeenCalled();
		// Only the never-ran ticket has no anchor to be busy; its slot was already attempted.
		expect(scheduleTicket).toHaveBeenCalledTimes(1);
		expect(created).toEqual([]);
	});

	it('skips a holder whose run an operator cancelled (issue #1453)', async () => {
		const scheduleRun = vi.fn(async () => ({ created: true }));
		const scheduleTicket = vi.fn(async (_t: ResolveProblemTicketCandidate) => ({ created: true }));
		const requestedAt = '2026-11-10T11:00:00.000Z';

		const created = await dispatchResolveProblemForWaitingTickets({
			listProjects: async () => [RECORD_ON],
			loadWaiting: async () => ENTRIES,
			readRun: async (id) =>
				run(id, {
					cancellation:
						id === 'run-failed'
							? { source: 'dashboard', requestedAt }
							: { source: 'board-backlog', requestedAt },
				}),
			scheduleRun,
			scheduleTicket,
			now: () => NOW,
		});

		expect(scheduleRun).not.toHaveBeenCalled();
		expect(scheduleTicket.mock.calls.map(([t]) => t.taskId)).toEqual(['3']);
		expect(created).toEqual([`on/${ON.repo}#3`]);
	});

	it('logs a failed dispatch and carries on, and never throws when a read fails', async () => {
		const scheduleTicket = vi
			.fn<(t: ResolveProblemTicketCandidate) => Promise<{ created: boolean }>>()
			.mockRejectedValueOnce(new Error('db down'))
			.mockResolvedValueOnce({ created: true });

		expect(
			await dispatchResolveProblemForWaitingTickets({
				listProjects: async () => [RECORD_ON],
				loadWaiting: async () => ENTRIES,
				readRun: async (id) => run(id),
				scheduleRun: async () => ({ created: false }),
				scheduleTicket,
				now: () => NOW,
			}),
		).toEqual([`on/${ON.repo}#3`]);

		await expect(
			dispatchResolveProblemForWaitingTickets({
				listProjects: async () => [RECORD_ON],
				loadWaiting: async () => {
					throw new Error('db down');
				},
			}),
		).resolves.toEqual([]);
	});
});
