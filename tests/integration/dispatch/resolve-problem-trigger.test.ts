import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import { createDispatch } from '../../../src/db/repositories/dispatchesRepository.js';
import {
	completeRun,
	createRun,
	listUnrecoveredFailedRuns,
	markRunResetStarted,
} from '../../../src/db/repositories/runsRepository.js';
import { dispatches } from '../../../src/db/schema/dispatches.js';
import { projects } from '../../../src/db/schema/projects.js';
import { runs } from '../../../src/db/schema/runs.js';
import {
	dispatchResolveProblemForFailedRuns,
	RESOLVE_PROBLEM_DELAY_MS,
	RESOLVE_PROBLEM_LOOKBACK_MS,
	resolveProblemWindow,
} from '../../../src/dispatch/resolve-problem-trigger.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import { closeQueue } from '../../../src/queue/producer.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-resolve-problem';
const OTHER_PROJECT_ID = 'proj-resolve-problem-off';
const REPO = 'jkwiecien/resolve-problem-repo';
const OTHER_REPO = 'jkwiecien/resolve-problem-off-repo';
const MINUTE = 60 * 1000;

function job(projectId = PROJECT_ID): SwarmJob {
	return { ...createMockScmWebhookJob(), projectId } as SwarmJob;
}

/** A run of `status`, settled `minutesAgo` minutes ago and started a minute before that. */
async function settledRun(
	options: {
		status?: 'failed' | 'deferred' | 'checkpointed' | 'completed';
		minutesAgo?: number;
		taskId?: string;
		prNumber?: string;
		phase?: 'implementation' | 'review' | 'resolve-problem';
		projectId?: string;
		repository?: string;
		resolvesRunId?: string;
		nextRetryAt?: Date;
	} = {},
): Promise<string> {
	const projectId = options.projectId ?? PROJECT_ID;
	const id = await createRun({
		projectId,
		repository: options.repository ?? REPO,
		taskId: options.taskId ?? '42',
		phase: options.phase ?? 'implementation',
		...(options.prNumber ? { prNumber: options.prNumber } : {}),
		...(options.resolvesRunId ? { resolvesRunId: options.resolvesRunId } : {}),
		jobPayload: job(projectId),
	});
	await completeRun(id, {
		status: options.status ?? 'failed',
		error: 'boom',
		...(options.nextRetryAt ? { nextRetryAt: options.nextRetryAt } : {}),
	});
	const completedAt = new Date(Date.now() - (options.minutesAgo ?? 15) * MINUTE);
	await getDb()
		.update(runs)
		.set({ completedAt, startedAt: new Date(completedAt.getTime() - MINUTE) })
		.where(eq(runs.id, id));
	return id;
}

async function candidateIds(projectIds: string[] = [PROJECT_ID]): Promise<string[]> {
	const rows = await listUnrecoveredFailedRuns({ projectIds, ...resolveProblemWindow(new Date()) });
	return rows.map((row) => row.id);
}

async function enableResolveProblem(projectId: string): Promise<void> {
	await getDb()
		.update(projects)
		.set({ pipeline: { resolveProblem: { enabled: true } } })
		.where(eq(projects.id, projectId));
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'listUnrecoveredFailedRuns (integration, issue #1396)',
	() => {
		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: REPO });
		});

		it('returns a run failed for over ten minutes that nothing picked up', async () => {
			const id = await settledRun({ minutesAgo: 11 });
			expect(await candidateIds()).toEqual([id]);
		});

		it('leaves out a failure younger than the delay', async () => {
			await settledRun({ minutesAgo: RESOLVE_PROBLEM_DELAY_MS / MINUTE - 1 });
			expect(await candidateIds()).toEqual([]);
		});

		it('leaves out a failure older than the lookback', async () => {
			await settledRun({ minutesAgo: RESOLVE_PROBLEM_LOOKBACK_MS / MINUTE + 1 });
			expect(await candidateIds()).toEqual([]);
		});

		it('leaves out deferred and checkpointed runs — only failed is read', async () => {
			await settledRun({ status: 'deferred', taskId: '1' });
			await settledRun({ status: 'checkpointed', taskId: '2' });
			await settledRun({ status: 'completed', taskId: '3' });
			expect(await candidateIds()).toEqual([]);
		});

		it('leaves out a run with a retry still due', async () => {
			await settledRun({ nextRetryAt: new Date(Date.now() + 5 * MINUTE) });
			expect(await candidateIds()).toEqual([]);
		});

		it('leaves out a run with a non-terminal dispatch of its own', async () => {
			const id = await settledRun();
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'manual',
				state: 'retry-scheduled',
				runId: id,
			});
			expect(await candidateIds()).toEqual([]);
		});

		it('leaves out a run that was reset', async () => {
			const id = await settledRun();
			await markRunResetStarted(id);
			expect(await candidateIds()).toEqual([]);
		});

		it('leaves out a run whose task has an active dispatch', async () => {
			await settledRun();
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				taskId: '42',
				phase: 'review',
			});
			expect(await candidateIds()).toEqual([]);
		});

		it('leaves out a run whose pull request has an active dispatch on another task id', async () => {
			await settledRun({ phase: 'review', prNumber: '7' });
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				taskId: 'other',
				phase: 'respond-to-ci',
			});
			await getDb()
				.update(dispatches)
				.set({ repository: REPO, prNumber: '7' })
				.where(eq(dispatches.id, dispatch.id));
			expect(await candidateIds()).toEqual([]);
		});

		it('still returns a run when the active dispatch on its task is another repository’s or a Resolve problem one', async () => {
			const id = await settledRun();
			const other = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				taskId: '42',
				phase: 'implementation',
			});
			await getDb()
				.update(dispatches)
				.set({ repository: 'jkwiecien/elsewhere' })
				.where(eq(dispatches.id, other.dispatch.id));
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'synthetic',
				taskId: '42',
				phase: 'resolve-problem',
				dedupKey: 'resolve-problem:some-earlier-run',
			});
			expect(await candidateIds()).toEqual([id]);
		});

		it('leaves out a run with a newer run on the same task or pull request', async () => {
			await settledRun({ minutesAgo: 30, taskId: '42' });
			await settledRun({ minutesAgo: 20, taskId: '42', status: 'completed' });
			await settledRun({ minutesAgo: 30, taskId: '43', prNumber: '9', phase: 'review' });
			const newest = await settledRun({ minutesAgo: 20, taskId: '44', prNumber: '9' });
			expect(await candidateIds()).toEqual([newest]);
		});

		it('does not count a newer Resolve problem run as picking the task up', async () => {
			const id = await settledRun({ minutesAgo: 30 });
			await settledRun({ minutesAgo: 20, phase: 'resolve-problem', status: 'completed' });
			expect(await candidateIds()).toEqual([id]);
		});

		it('leaves out a run that already has a Resolve problem attempt', async () => {
			const id = await settledRun({ minutesAgo: 30 });
			// The attempt is on another task id so the newer-run rule cannot be what excludes it.
			await settledRun({
				minutesAgo: 20,
				taskId: 'attempt',
				phase: 'resolve-problem',
				resolvesRunId: id,
			});
			expect(await candidateIds()).toEqual([]);
		});

		it('leaves out a run whose Resolve problem dispatch exists but made no run', async () => {
			const id = await settledRun();
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'synthetic',
				dedupKey: `resolve-problem:${id}`,
				phase: 'resolve-problem',
			});
			await getDb()
				.update(dispatches)
				.set({ state: 'completed', outcome: 'skipped-not-eligible', completedAt: new Date() })
				.where(eq(dispatches.dedupKey, `resolve-problem:${id}`));
			expect(await candidateIds()).toEqual([]);
		});

		it('leaves out a failed Resolve problem run itself', async () => {
			const failed = await settledRun({ minutesAgo: 40, taskId: 'x' });
			await settledRun({ phase: 'resolve-problem', resolvesRunId: failed, taskId: 'y' });
			expect(await candidateIds()).toEqual([]);
		});

		it('reads only the projects it is scoped to', async () => {
			await seedProject({ id: OTHER_PROJECT_ID, repo: OTHER_REPO });
			await settledRun({ projectId: OTHER_PROJECT_ID, repository: OTHER_REPO });
			expect(await candidateIds()).toEqual([]);
			expect(await candidateIds([])).toEqual([]);
		});
	},
);

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE || !process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'dispatchResolveProblemForFailedRuns (integration, Postgres + Redis, issue #1396)',
	() => {
		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: REPO });
			await seedProject({ id: OTHER_PROJECT_ID, repo: OTHER_REPO });
			await enableResolveProblem(PROJECT_ID);
		});

		afterAll(async () => {
			await closeQueue();
		});

		async function resolveProblemDispatches() {
			return getDb().select().from(dispatches).where(eq(dispatches.phase, 'resolve-problem'));
		}

		it('dispatches one attempt for a qualifying run, and none for a disabled project', async () => {
			const id = await settledRun();
			await settledRun({ projectId: OTHER_PROJECT_ID, repository: OTHER_REPO });

			expect(await dispatchResolveProblemForFailedRuns()).toEqual([id]);

			const rows = await resolveProblemDispatches();
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				projectId: PROJECT_ID,
				dedupKey: `resolve-problem:${id}`,
				source: 'synthetic',
				state: 'pending',
			});
			expect(rows[0].jobPayload).toMatchObject({ type: 'resolve-problem', failedRunId: id });
		});

		it('creates one dispatch from two concurrent passes, and none from a later one', async () => {
			const id = await settledRun();

			const passes = await Promise.all([
				dispatchResolveProblemForFailedRuns(),
				dispatchResolveProblemForFailedRuns(),
			]);
			expect(passes.flat()).toEqual([id]);
			expect(await dispatchResolveProblemForFailedRuns()).toEqual([]);
			expect(await resolveProblemDispatches()).toHaveLength(1);
		});
	},
);
