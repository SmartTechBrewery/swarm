import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
	claimDispatch,
	createDispatch,
	getActiveDispatchByRunId,
	getDispatchById,
} from '../../../src/db/repositories/dispatchesRepository.js';
import {
	completeRun,
	createRun,
	getRunByIdFromDb,
	updateReviewMergeOutcome,
} from '../../../src/db/repositories/runsRepository.js';
import { reconcileDispatchesAtStartup } from '../../../src/dispatch/reconciler.js';
import { QUEUE_NAME, type SwarmJob } from '../../../src/queue/jobs.js';
import { closeQueue } from '../../../src/queue/producer.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-reconciler';
const REPO = 'jkwiecien/reconciler-repo';

function job(overrides: Partial<SwarmJob> = {}): SwarmJob {
	return { ...createMockScmWebhookJob(), projectId: PROJECT_ID, ...overrides } as SwarmJob;
}

// Startup reconciliation against real Postgres + Redis: the deterministic
// repair of issue #284's live orphan shapes — a deferred run whose retry job
// vanished (#269), a `running` claim with no live worker (#279), and the
// retired Redis pending-continuation registry.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE || !process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'dispatch reconciler (integration, Postgres + Redis/BullMQ)',
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
		});

		afterAll(async () => {
			await inspect?.obliterate({ force: true }).catch(() => {});
			await inspect?.close();
			await redis?.quit();
			await closeQueue();
		});

		async function pendingJobIds(): Promise<string[]> {
			const [waiting, prioritized, delayed] = await Promise.all([
				inspect.getWaiting(),
				inspect.getPrioritized(),
				inspect.getDelayed(),
			]);
			return [...waiting, ...prioritized, ...delayed].map((j) => j.id ?? '');
		}

		it('imports a deferred run whose retry job vanished as a scheduled dispatch (the #269 orphan)', async () => {
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: '269',
				phase: 'implementation',
				jobPayload: job(),
			});
			await completeRun(runId, {
				status: 'deferred',
				error: 'rate limited',
				nextRetryAt: new Date(Date.now() + 60_000),
			});

			await reconcileDispatchesAtStartup();

			const dispatch = await getActiveDispatchByRunId(runId);
			expect(dispatch).toMatchObject({
				state: 'retry-scheduled',
				waitReason: 'recovered',
				runId,
				source: 'recovered',
			});
			// Its wake-up is republished too — the retry actually fires again.
			expect(await pendingJobIds()).toContain(`dispatch_${dispatch?.id}_w0`);
		});

		it('fails a leased dispatch (and its running run) left by a dead worker (the #279 orphan)', async () => {
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: '279',
				phase: 'review',
			});
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'webhook',
				runId,
			});
			await claimDispatch(dispatch.id, 'dead-worker:1', -1_000);

			await reconcileDispatchesAtStartup();

			expect((await getDispatchById(dispatch.id))?.state).toBe('failed');
			expect((await getRunByIdFromDb(runId))?.status).toBe('failed');
		});

		it('imports legacy Redis pending-continuation entries and clears the registry', async () => {
			const legacyJob = job({ runId: undefined });
			await redis.hset(
				`swarm:pending-continuations:${PROJECT_ID}`,
				'17:review',
				JSON.stringify({
					taskId: '17',
					phase: 'review',
					enqueuedAt: Date.now(),
					job: legacyJob,
					continuation: true,
				}),
			);

			await reconcileDispatchesAtStartup();

			expect(await redis.exists(`swarm:pending-continuations:${PROJECT_ID}`)).toBe(0);
			// The entry became a durable capacity-pending dispatch, visible to the
			// canonical queue and woken by slot releases.
			const { listWaitingDispatches } = await import(
				'../../../src/db/repositories/dispatchesRepository.js'
			);
			const waiting = await listWaitingDispatches(PROJECT_ID);
			expect(waiting).toHaveLength(1);
			expect(waiting[0]).toMatchObject({
				state: 'pending',
				waitReason: 'project-capacity',
				continuation: true,
				taskId: '17',
			});
		});

		it('imports legacy not-ready merge-follow-up intent as a durable merge dispatch, exactly once (issue #292)', async () => {
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: '17',
				phase: 'review',
				prNumber: '17',
			});
			await completeRun(runId, { status: 'completed', reviewVerdict: 'approve' });
			await updateReviewMergeOutcome(runId, {
				status: 'not-ready',
				message: 'pending required checks',
				attempt: 2,
				approvedHeadSha: 'deadbeef',
			});

			await reconcileDispatchesAtStartup();

			const dispatch = await getActiveDispatchByRunId(runId);
			expect(dispatch).toMatchObject({
				state: 'pending',
				waitReason: 'recovered',
				source: 'recovered',
				dedupKey: `merge:${runId}`,
				phase: 'merge-automation',
				runId,
				attempt: 3,
			});
			expect(dispatch?.jobPayload).toMatchObject({
				type: 'merge-automation',
				projectId: PROJECT_ID,
				reviewRunId: runId,
				prNumber: '17',
				approvedHeadSha: 'deadbeef',
			});
			expect(await pendingJobIds()).toContain(`dispatch_${dispatch?.id}_w0`);

			// A second pass is a no-op — the dedup key refuses a duplicate import.
			await reconcileDispatchesAtStartup();
			expect(await getActiveDispatchByRunId(runId)).toMatchObject({ id: dispatch?.id });
			expect(await pendingJobIds()).toHaveLength(1);
		});

		it('is idempotent — a second startup pass changes nothing', async () => {
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: '269',
				phase: 'implementation',
				jobPayload: job(),
			});
			await completeRun(runId, { status: 'deferred', error: 'rate limited' });

			await reconcileDispatchesAtStartup();
			const first = await getActiveDispatchByRunId(runId);
			await reconcileDispatchesAtStartup();
			const second = await getActiveDispatchByRunId(runId);

			expect(second?.id).toBe(first?.id);
			expect(await pendingJobIds()).toHaveLength(1);
		});
	},
);
