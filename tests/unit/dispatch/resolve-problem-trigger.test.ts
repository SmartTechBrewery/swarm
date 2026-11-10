import { describe, expect, it, vi } from 'vitest';

import type { PipelineRunRow } from '@/db/repositories/runsRepository.js';
import {
	dispatchResolveProblemForFailedRuns,
	RESOLVE_PROBLEM_DELAY_MS,
	RESOLVE_PROBLEM_LOOKBACK_MS,
	resolveProblemProjectIds,
	resolveProblemWindow,
} from '@/dispatch/resolve-problem-trigger.js';
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
