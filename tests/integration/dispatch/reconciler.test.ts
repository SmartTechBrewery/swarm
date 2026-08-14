import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
	claimDispatch,
	claimWorkerForDispatch,
	createDispatch,
	getActiveDispatchByRunId,
	getDispatchById,
	getWorkerDispatchClaimState,
	markDispatchRunning,
} from '../../../src/db/repositories/dispatchesRepository.js';
import { createProjectInDb } from '../../../src/db/repositories/projectsRepository.js';
import {
	completeRun,
	createRun,
	getRunByIdFromDb,
	updateReviewMergeOutcome,
} from '../../../src/db/repositories/runsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { createEnrollment } from '../../../src/db/repositories/workerEnrollmentsRepository.js';
import { acquireLease } from '../../../src/db/repositories/workerSessionsRepository.js';
import { createWorker } from '../../../src/db/repositories/workersRepository.js';
import {
	reconcileDispatchesAtStartup,
	reconcileSupersededWorkerClaims,
} from '../../../src/dispatch/reconciler.js';
import { QUEUE_NAME, type SwarmJob } from '../../../src/queue/jobs.js';
import { closeQueue } from '../../../src/queue/producer.js';
import { createMockProjectRecord, createMockScmWebhookJob } from '../../helpers/factories.js';
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

		// issue #684 phase 2 — the import scopes the project from the *run's* repository,
		// so a merge intent recorded for a project's second repository is executed against
		// that repository rather than against whichever entry the config lists first.
		it("names the run's own repository on an imported merge dispatch, not the project default", async () => {
			await createProjectInDb(
				createMockProjectRecord({
					id: 'proj-reconciler-multi',
					name: 'Reconciler Multi',
					repositories: [{ repo: 'jkwiecien/recon-first' }, { repo: 'jkwiecien/recon-second' }],
				}),
			);
			const runId = await createRun({
				projectId: 'proj-reconciler-multi',
				repository: 'jkwiecien/recon-second',
				taskId: '18',
				phase: 'review',
				prNumber: '18',
			});
			await completeRun(runId, { status: 'completed', reviewVerdict: 'approve' });
			await updateReviewMergeOutcome(runId, {
				status: 'not-ready',
				message: 'pending required checks',
				attempt: 1,
				approvedHeadSha: 'cafebabe',
			});

			await reconcileDispatchesAtStartup();

			expect((await getActiveDispatchByRunId(runId))?.jobPayload).toMatchObject({
				type: 'merge-automation',
				repo: 'jkwiecien/recon-second',
			});
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

		/**
		 * The signal-driven repair (issue #719): a claim bound to a fencing token the
		 * worker's session has moved past belongs to a generation that is gone, and the
		 * handshake that minted the new one settles it there and then rather than leaving
		 * it to the back-channel timer.
		 */
		describe('reconcileSupersededWorkerClaims', () => {
			/** A worker with an active enrollment, its session lease, and a claimed dispatch. */
			async function seedClaimedDispatch() {
				const owner = await createUser({
					identifier: 'superseded-owner@example.com',
					displayName: 'Owner',
				});
				const worker = await createWorker({
					ownerUserId: owner.id,
					displayName: 'm3_pro_karolina',
					capabilities: ['claude'],
					credentialHash: 'hash-superseded',
				});
				await createEnrollment({
					workerId: worker.id,
					projectId: PROJECT_ID,
					status: 'active',
					allowedClis: ['claude'],
					allowedPhases: ['implementation'],
					concurrencyAllocation: 1,
					sharingConsent: true,
				});
				const session = await acquireLease(worker.id, 60_000);
				const runId = await createRun({
					projectId: PROJECT_ID,
					repository: REPO,
					taskId: '719',
					phase: 'implementation',
				});
				const { dispatch } = await createDispatch({
					projectId: PROJECT_ID,
					jobPayload: job({ runId }),
					source: 'webhook',
					runId,
					taskId: '719',
					phase: 'implementation',
				});
				// A long lease, as a real agent-timeout dispatch has: the whole point is that
				// this settles without waiting for it to expire.
				const leased = await claimDispatch(dispatch.id, 'host-a:1', 3_000_000);
				if (!leased) throw new Error('test dispatch was not leased');
				const claim = await claimWorkerForDispatch({
					dispatchId: dispatch.id,
					dispatchLeaseOwner: leased.leaseOwner ?? '',
					projectId: PROJECT_ID,
					selectedWorkerId: worker.id,
					executionWorkerId: worker.id,
					workerSessionId: session.id,
					workerFencingToken: session.fencingToken,
					cli: 'claude',
					heartbeatTtlMs: 60_000,
				});
				expect(claim.claimed).toBe(true);
				// The reproduction's shape: the phase is executing, on a lease that will not
				// expire for another 50 minutes.
				await markDispatchRunning(
					dispatch.id,
					runId,
					new Date(Date.now() + 3_000_000),
					'719',
					'implementation',
				);
				return { worker, session, runId, dispatchId: dispatch.id };
			}

			it('settles the claim and its running run, and frees the worker’s capacity', async () => {
				const { worker, session, runId, dispatchId } = await seedClaimedDispatch();

				const failed = await reconcileSupersededWorkerClaims(worker.id, session.fencingToken + 1);

				// The rows are returned, not counted: each one's control-plane result wait is
				// keyed by dispatch id and has to end with it.
				expect(failed.map((row) => row.id)).toEqual([dispatchId]);
				const settled = await getDispatchById(dispatchId);
				expect(settled).toMatchObject({ state: 'failed', leaseOwner: null, leaseExpiresAt: null });
				// The reason says which of the two things happened — not the timer's "did not
				// report a result within the lease window" (AC 4).
				expect(settled?.lastError).toContain('superseded');
				expect(settled?.lastError).not.toContain('did not report a result');
				// The run row settles with it, on the same reason, rather than staying
				// `running` behind a dispatch nothing is executing.
				const run = await getRunByIdFromDb(runId);
				expect(run?.status).toBe('failed');
				expect(run?.error).toBe(settled?.lastError);
				// The durable half of "the freed capacity is usable immediately" (AC 2).
				expect((await getWorkerDispatchClaimState(worker.id, PROJECT_ID)).activeRuns).toBe(0);
			});

			it('leaves a claim bound to the current generation alone (AC 3)', async () => {
				const { worker, session, runId, dispatchId } = await seedClaimedDispatch();

				// The same daemon reclaiming its own lease never reaches this call, but the
				// SQL guard is the second line of defence: a phase still executing under the
				// active token is not this reap's business.
				const failed = await reconcileSupersededWorkerClaims(worker.id, session.fencingToken);

				expect(failed).toEqual([]);
				expect((await getDispatchById(dispatchId))?.state).toBe('running');
				expect((await getRunByIdFromDb(runId))?.status).toBe('running');
			});

			it('is idempotent — a second pass finds nothing left to settle', async () => {
				const { worker, session } = await seedClaimedDispatch();

				await reconcileSupersededWorkerClaims(worker.id, session.fencingToken + 1);

				expect(await reconcileSupersededWorkerClaims(worker.id, session.fencingToken + 1)).toEqual(
					[],
				);
			});
		});
	},
);
