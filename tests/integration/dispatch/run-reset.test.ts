import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import {
	claimDispatch,
	completeDispatch,
	createDispatch,
	getActiveDispatchByRunId,
} from '../../../src/db/repositories/dispatchesRepository.js';
import { completeRun, createRun } from '../../../src/db/repositories/runsRepository.js';
import { dispatches } from '../../../src/db/schema/dispatches.js';
import {
	ORPHAN_SETTLE_GRACE_MS,
	reconcileDispatchesPeriodically,
} from '../../../src/dispatch/reconciler.js';
import { resetRun } from '../../../src/dispatch/run-reset.js';
import { QUEUE_NAME, type SwarmJob } from '../../../src/queue/jobs.js';
import { closeQueue } from '../../../src/queue/producer.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

// The checkout teardown is the step a Reset spends real time in, so it is the hook the
// race is staged from: whatever `duringTeardown` does runs while the Reset is inside it.
const teardown = vi.hoisted(() => ({ duringTeardown: async () => {} }));
vi.mock('../../../src/worktree/termination-cleanup.js', () => ({
	reconcileTerminatedWorktree: vi.fn(async () => {
		await teardown.duringTeardown();
		return { outcome: 'removed' };
	}),
}));

const PROJECT_ID = 'proj-run-reset';
const REPO = 'jkwiecien/run-reset-repo';

function job(overrides: Partial<SwarmJob> = {}): SwarmJob {
	return { ...createMockScmWebhookJob(), projectId: PROJECT_ID, ...overrides } as SwarmJob;
}

// Reset & restart against real Postgres + Redis, raced by the reconciler's periodic
// orphan backfill (issue #1210).
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE || !process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'run reset (integration, Postgres + Redis/BullMQ)',
	() => {
		let inspect: Queue<SwarmJob>;
		let redis: Redis;

		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: REPO });
			const url = new URL(process.env.REDIS_URL ?? '');
			const connection = { host: url.hostname, port: Number(url.port || 6379) };
			inspect ??= new Queue<SwarmJob>(QUEUE_NAME, { connection });
			redis ??= new Redis(connection);
			await inspect.obliterate({ force: true });
			await redis.flushdb();
			teardown.duringTeardown = async () => {};
		});

		afterAll(async () => {
			await inspect?.obliterate({ force: true }).catch(() => {});
			await inspect?.close();
			await redis?.quit();
			await closeQueue();
		});

		/** A deferred run whose only dispatch settled longer ago than the settle grace. */
		async function strandedRun(): Promise<string> {
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: '1210',
				phase: 'implementation',
				jobPayload: job({ resumeSession: true }),
			});
			await completeRun(runId, { status: 'deferred', error: 'rate limited' });
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'webhook',
				runId,
			});
			await claimDispatch(dispatch.id, 'worker:1', 60_000);
			await completeDispatch(dispatch.id, 'skipped-duplicate');
			await getDb()
				.update(dispatches)
				.set({ updatedAt: new Date(Date.now() - ORPHAN_SETTLE_GRACE_MS - 60_000) })
				.where(eq(dispatches.id, dispatch.id));
			return runId;
		}

		it('restarts a stranded run even when a periodic reconcile lands mid-teardown', async () => {
			const runId = await strandedRun();
			teardown.duringTeardown = () => reconcileDispatchesPeriodically();

			const result = await resetRun(runId);

			expect(result).toMatchObject({ outcome: 'restarted', dispatch: 'none' });
			const active = await getActiveDispatchByRunId(runId);
			expect(active).toMatchObject({ source: 'manual', waitReason: 'manual-retry' });
			expect(active?.id).toBe((result as { dispatchId?: string }).dispatchId);
			expect(active?.jobPayload).toMatchObject({ recoveryMode: 'discard' });
			expect(active?.jobPayload.resumeSession).toBeUndefined();
			// The reconcile imported nothing beside the restart.
			const rows = await getDb().select().from(dispatches).where(eq(dispatches.runId, runId));
			expect(rows.filter((row) => row.source === 'recovered')).toHaveLength(0);
		});
	},
);
