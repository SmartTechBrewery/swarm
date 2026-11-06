import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pipeline snapshot and dispatch history (issue #1340): the read model's
 * shaping (`src/api/pipeline-snapshot.ts`) and the `runs.pipelineSnapshot` /
 * `runs.dispatchHistory` procedures' authorization. The repository reads
 * themselves are covered against Postgres in `tests/integration/db/`.
 */
vi.mock('@/db/repositories/runsRepository.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/db/repositories/runsRepository.js')>()),
	listSnapshotRunsForProject: vi.fn(),
	countRunsSettledSinceByStatus: vi.fn(),
}));

vi.mock('@/db/repositories/dispatchesRepository.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/db/repositories/dispatchesRepository.js')>()),
	listOpenDispatchesForProject: vi.fn(),
	listDispatchesForTask: vi.fn(),
}));

vi.mock('@/identity/worker-service.js', () => ({
	getWorker: vi.fn(),
	getWorkers: vi.fn(),
}));

vi.mock('@/identity/membership-service.js', () => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));

import {
	DISPATCH_HISTORY_ROW_LIMIT,
	loadDispatchHistory,
	loadPipelineSnapshot,
	PIPELINE_SNAPSHOT_ROW_LIMIT,
} from '@/api/pipeline-snapshot.js';
import { runsRouter } from '@/api/routers/runs.js';
import {
	type DispatchRow,
	listDispatchesForTask,
	listOpenDispatchesForProject,
} from '@/db/repositories/dispatchesRepository.js';
import {
	countRunsSettledSinceByStatus,
	listSnapshotRunsForProject,
	type RunRow,
} from '@/db/repositories/runsRepository.js';
import type { ProjectMembership, ProjectRole } from '@/identity/membership.js';
import { getMembership } from '@/identity/membership-service.js';
import type { SwarmUser } from '@/identity/schema.js';
import type { Worker } from '@/identity/worker.js';
import { getWorkers } from '@/identity/worker-service.js';
import { createMockPmWebhookJob, createMockScmWebhookJob } from '../../helpers/factories.js';

const NOW = new Date('2026-11-06T12:00:00Z');
const WORKER_ID = '77777777-7777-4777-8777-777777777777';

function makeRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: 'run-1',
		projectId: 'p1',
		kind: 'pipeline',
		repository: 'acme/widgets',
		taskId: '7',
		workItemId: null,
		workItemTitle: 'Fix the widget',
		workItemUrl: null,
		prNumber: null,
		prTitle: null,
		phase: 'implementation',
		workerId: WORKER_ID,
		maintenanceMachine: null,
		status: 'deferred',
		error: 'rate limited',
		startedAt: new Date('2026-11-06T11:00:00Z'),
		completedAt: new Date('2026-11-06T11:30:00Z'),
		nextRetryAt: new Date('2026-11-06T13:00:00Z'),
		continuationCount: 2,
		...overrides,
	} as RunRow;
}

function makeDispatch(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		projectId: 'p1',
		taskId: '7',
		phase: 'review',
		repository: 'acme/widgets',
		prNumber: '42',
		state: 'retry-scheduled',
		waitReason: 'recheck',
		outcome: null,
		dedupKey: null,
		coalesceKey: null,
		continuation: false,
		priority: 0,
		attempt: 3,
		wakeSeq: 1,
		availableAt: new Date('2026-11-06T12:05:00Z'),
		jobPayload: createMockScmWebhookJob({ projectId: 'p1' }),
		runId: 'run-1',
		selectedWorkerId: null,
		workerSessionId: null,
		workerFencingToken: null,
		leaseOwner: null,
		leaseExpiresAt: null,
		lastError: 'checks pending',
		source: 'recheck',
		createdAt: new Date('2026-11-06T11:50:00Z'),
		updatedAt: new Date('2026-11-06T11:55:00Z'),
		completedAt: null,
		...overrides,
	};
}

function user(id: string, instanceAdmin: boolean): SwarmUser {
	return {
		id,
		identifier: `${id}@example.com`,
		displayName: id,
		instanceAdmin,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

const ADMIN = user('00000000-0000-4000-8000-000000000000', true);
const ORDINARY = user('00000000-0000-4000-8000-0000000000ff', false);

function membershipFor(role: ProjectRole): ProjectMembership {
	return {
		id: '99999999-9999-4999-8999-999999999999',
		projectId: 'p1',
		userId: ORDINARY.id,
		role,
		createdAt: new Date(0),
	};
}

beforeEach(() => {
	vi.mocked(listSnapshotRunsForProject).mockReset().mockResolvedValue([]);
	vi.mocked(countRunsSettledSinceByStatus).mockReset().mockResolvedValue({});
	vi.mocked(listOpenDispatchesForProject).mockReset().mockResolvedValue([]);
	vi.mocked(listDispatchesForTask).mockReset().mockResolvedValue([]);
	vi.mocked(getWorkers)
		.mockReset()
		.mockResolvedValue([{ id: WORKER_ID, displayName: 'mac-mini' } as Worker]);
	vi.mocked(getMembership).mockReset();
});

describe('loadPipelineSnapshot', () => {
	it('reports runs, open dispatches and settled counts for the window', async () => {
		vi.mocked(listSnapshotRunsForProject).mockResolvedValue([makeRun()]);
		vi.mocked(listOpenDispatchesForProject).mockResolvedValue([
			makeDispatch({ selectedWorkerId: WORKER_ID }),
		]);
		vi.mocked(countRunsSettledSinceByStatus).mockResolvedValue({ completed: 4, failed: 1 });

		const snapshot = await loadPipelineSnapshot('p1', 12, NOW);

		const since = new Date('2026-11-06T00:00:00Z');
		expect(listSnapshotRunsForProject).toHaveBeenCalledWith(
			'p1',
			since,
			PIPELINE_SNAPSHOT_ROW_LIMIT + 1,
		);
		expect(countRunsSettledSinceByStatus).toHaveBeenCalledWith('p1', since);
		expect(snapshot).toEqual({
			projectId: 'p1',
			generatedAt: NOW.toISOString(),
			windowHours: 12,
			runs: [
				{
					id: 'run-1',
					kind: 'pipeline',
					status: 'deferred',
					phase: 'implementation',
					repository: 'acme/widgets',
					taskId: '7',
					prNumber: null,
					title: 'Fix the widget',
					workerName: 'mac-mini',
					startedAt: '2026-11-06T11:00:00.000Z',
					completedAt: '2026-11-06T11:30:00.000Z',
					ageMs: 60 * 60 * 1000,
					continuationCount: 2,
					error: 'rate limited',
					nextRetryAt: '2026-11-06T13:00:00.000Z',
				},
			],
			dispatches: [
				{
					id: 'dispatch-1',
					state: 'retry-scheduled',
					phase: 'review',
					repository: 'acme/widgets',
					taskId: '7',
					prNumber: '42',
					waitReason: 'recheck',
					outcome: null,
					lastError: 'checks pending',
					attempt: 3,
					runId: 'run-1',
					source: 'recheck',
					priority: 0,
					workerName: 'mac-mini',
					createdAt: '2026-11-06T11:50:00.000Z',
					availableAt: '2026-11-06T12:05:00.000Z',
					completedAt: null,
					ageMs: 10 * 60 * 1000,
				},
			],
			completedCounts: { since: since.toISOString(), byStatus: { completed: 4, failed: 1 } },
			truncated: { runs: false, dispatches: false },
		});
		// One batched name lookup for both lists.
		expect(getWorkers).toHaveBeenCalledTimes(1);
		expect(getWorkers).toHaveBeenCalledWith([WORKER_ID]);
	});

	it('reports what an unclaimed dispatch is for from its stored job', async () => {
		vi.mocked(listOpenDispatchesForProject).mockResolvedValue([
			makeDispatch({
				phase: null,
				repository: null,
				prNumber: null,
				taskId: null,
				jobPayload: createMockScmWebhookJob({ projectId: 'p1' }),
			}),
			makeDispatch({
				id: 'dispatch-2',
				phase: null,
				repository: null,
				prNumber: null,
				taskId: null,
				jobPayload: createMockPmWebhookJob({ projectId: 'p1', repository: 'acme/widgets' }),
			}),
		]);

		const { dispatches } = await loadPipelineSnapshot('p1', 12, NOW);

		expect(dispatches[0]).toMatchObject({
			phase: 'review',
			repository: 'SmartTechBrewery/swarm',
			prNumber: '17',
		});
		expect(dispatches[1]).toMatchObject({
			phase: 'board',
			repository: 'acme/widgets',
			prNumber: null,
		});
	});

	it('cuts each list at the bound and says so', async () => {
		vi.mocked(listSnapshotRunsForProject).mockResolvedValue(
			Array.from({ length: PIPELINE_SNAPSHOT_ROW_LIMIT + 1 }, (_, i) =>
				makeRun({ id: `run-${i}` }),
			),
		);

		const snapshot = await loadPipelineSnapshot('p1', 12, NOW);

		expect(snapshot.runs).toHaveLength(PIPELINE_SNAPSHOT_ROW_LIMIT);
		expect(snapshot.truncated).toEqual({ runs: true, dispatches: false });
	});

	it('lists rows without machine names when the name lookup fails', async () => {
		vi.mocked(listSnapshotRunsForProject).mockResolvedValue([makeRun()]);
		vi.mocked(getWorkers).mockRejectedValue(new Error('db down'));

		const snapshot = await loadPipelineSnapshot('p1', 12, NOW);

		expect(snapshot.runs[0]?.workerName).toBeNull();
	});
});

describe('loadDispatchHistory', () => {
	it('keeps the newest rows, oldest first, and says when older ones were left out', async () => {
		vi.mocked(listDispatchesForTask).mockResolvedValue(
			Array.from({ length: DISPATCH_HISTORY_ROW_LIMIT + 1 }, (_, i) =>
				makeDispatch({ id: `dispatch-${i}` }),
			),
		);

		const history = await loadDispatchHistory('p1', { taskId: '7' }, NOW);

		expect(listDispatchesForTask).toHaveBeenCalledWith(
			'p1',
			{ taskId: '7' },
			DISPATCH_HISTORY_ROW_LIMIT + 1,
		);
		expect(history.truncated).toBe(true);
		expect(history.dispatches).toHaveLength(DISPATCH_HISTORY_ROW_LIMIT);
		expect(history.dispatches[0]?.id).toBe('dispatch-1');
		expect(history.dispatches.at(-1)?.id).toBe(`dispatch-${DISPATCH_HISTORY_ROW_LIMIT}`);
	});

	it('reports each row with its outcome and run', async () => {
		vi.mocked(listDispatchesForTask).mockResolvedValue([
			makeDispatch({
				state: 'completed',
				waitReason: null,
				outcome: 'phase-succeeded',
				completedAt: new Date('2026-11-06T11:58:00Z'),
			}),
		]);

		const history = await loadDispatchHistory('p1', { prNumber: '42' }, NOW);

		expect(history).toMatchObject({
			projectId: 'p1',
			truncated: false,
			dispatches: [
				{
					state: 'completed',
					outcome: 'phase-succeeded',
					runId: 'run-1',
					completedAt: '2026-11-06T11:58:00.000Z',
				},
			],
		});
	});
});

describe('runs.pipelineSnapshot / runs.dispatchHistory authorization', () => {
	const admin = runsRouter.createCaller({ user: ADMIN });
	const ordinary = runsRouter.createCaller({ user: ORDINARY });

	it('lets an instance administrator read any project, defaulting the window to 12 hours', async () => {
		await expect(admin.pipelineSnapshot({ projectId: 'p1' })).resolves.toMatchObject({
			projectId: 'p1',
			windowHours: 12,
		});
		expect(getMembership).not.toHaveBeenCalled();
	});

	it('lets a contributor read their own project', async () => {
		vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

		await expect(
			ordinary.pipelineSnapshot({ projectId: 'p1', windowHours: 2 }),
		).resolves.toMatchObject({ windowHours: 2 });
		await expect(ordinary.dispatchHistory({ projectId: 'p1', taskId: '7' })).resolves.toMatchObject(
			{
				projectId: 'p1',
			},
		);
		expect(listDispatchesForTask).toHaveBeenCalledWith('p1', { taskId: '7' }, expect.any(Number));
	});

	it('hides a project the caller is not a member of, without reading it', async () => {
		vi.mocked(getMembership).mockResolvedValue(undefined);

		await expect(ordinary.pipelineSnapshot({ projectId: 'p9' })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		await expect(ordinary.dispatchHistory({ projectId: 'p9', prNumber: '1' })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		expect(listSnapshotRunsForProject).not.toHaveBeenCalled();
		expect(listOpenDispatchesForProject).not.toHaveBeenCalled();
		expect(listDispatchesForTask).not.toHaveBeenCalled();
	});

	it('requires the history to name a task or a pull request', async () => {
		await expect(
			admin.dispatchHistory({ projectId: 'p1', repository: 'acme/widgets' }),
		).rejects.toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
		expect(listDispatchesForTask).not.toHaveBeenCalled();
	});

	it('rejects a window wider than a week', async () => {
		await expect(
			admin.pipelineSnapshot({ projectId: 'p1', windowHours: 169 }),
		).rejects.toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
	});
});
