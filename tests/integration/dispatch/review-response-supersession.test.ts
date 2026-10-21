import { Queue } from 'bullmq';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
	bindDispatchToRun,
	createDispatch,
	getDispatchById,
	listDeferredRunsWithoutActiveDispatch,
	markDispatchRunning,
} from '../../../src/db/repositories/dispatchesRepository.js';
import {
	completeRun,
	createRun,
	getRunByIdFromDb,
	resetRunToRunning,
} from '../../../src/db/repositories/runsRepository.js';
import {
	claimDispatchForJob,
	publishDispatchWakeUp,
	wakeJobId,
} from '../../../src/dispatch/dispatcher.js';
import { retireSupersededReviewResponses } from '../../../src/dispatch/review-response-supersession.js';
import { QUEUE_NAME, type SwarmJob } from '../../../src/queue/jobs.js';
import { closeQueue } from '../../../src/queue/producer.js';
import { createMockScmEvent, createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-review-supersession';
const REPO = 'jkwiecien/review-supersession-repo';
const PR = '1439';
const TASK_ID = `${PR}-respond`;

/** A Respond-to-review delivery for one review of the pull request. */
function reviewJob(reviewId: string, deliveryId: string): SwarmJob {
	return createMockScmWebhookJob({
		projectId: PROJECT_ID,
		deliveryId,
		event: createMockScmEvent({
			kind: 'pull-request-review',
			action: 'submitted',
			workItemId: PR,
			reviewState: 'changes-requested',
			reviewId,
			prBranch: `issue-${PR}`,
		}),
	});
}

function reviewIdOf(payload: unknown): string | undefined {
	return (payload as { event?: { reviewId?: string } } | null)?.event?.reviewId;
}

// Real Postgres + Redis (issue #1102): the incident is about durable state — an
// older review's `retry-scheduled` dispatch holding the shared `<pr>-respond` run row
// while a newer review arrives, and the unique active-run index arbitrating between
// them.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE || !process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'review-response supersession (integration, Postgres + Redis/BullMQ)',
	() => {
		/** Inspection-only queue handle on the same connection settings the producer uses. */
		let inspect: Queue<SwarmJob>;

		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: REPO });
			inspect ??= new Queue<SwarmJob>(QUEUE_NAME, {
				connection: (() => {
					const url = new URL(process.env.REDIS_URL ?? '');
					return { host: url.hostname, port: Number(url.port || 6379) };
				})(),
			});
			await inspect.obliterate({ force: true });
		});

		afterAll(async () => {
			await inspect?.obliterate({ force: true }).catch(() => {});
			await inspect?.close();
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

		/**
		 * The incident's state: run R answering review A, settled `deferred` by its
		 * `retry-scheduled` dispatch D1 (wake-up published), and the newer review B's
		 * dispatch D2 freshly claimed with no run and no resolved phase yet.
		 */
		async function seedIncident() {
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: TASK_ID,
				phase: 'respond-to-review',
				prNumber: PR,
				jobPayload: reviewJob('A', 'delivery-a'),
			});
			await completeRun(runId, {
				status: 'deferred',
				error: 'waiting for an authorized worker',
				nextRetryAt: new Date(Date.now() + 60_000),
			});
			const { dispatch: older } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: { ...reviewJob('A', 'delivery-a'), runId },
				source: 'manual',
				taskId: TASK_ID,
				phase: 'respond-to-review',
				state: 'retry-scheduled',
				waitReason: 'worker-authorization',
				runId,
			});
			await publishDispatchWakeUp(older);
			const { dispatch: newer } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: reviewJob('B', 'delivery-b'),
				dedupKey: 'delivery-b',
				source: 'webhook',
				state: 'leased',
				leaseOwner: 'host:1',
				leaseExpiresAt: new Date(Date.now() + 60_000),
			});
			return { runId, older, newer };
		}

		it('refuses the run to a newer review while the older dispatch still waits, leaving the run untouched', async () => {
			const { runId, older, newer } = await seedIncident();
			const before = await getRunByIdFromDb(runId);

			expect(await bindDispatchToRun(newer.id, runId)).toBe(false);

			const after = await getRunByIdFromDb(runId);
			expect(after).toMatchObject({
				status: before?.status,
				error: before?.error,
				workerId: before?.workerId,
			});
			expect(after?.startedAt).toEqual(before?.startedAt);
			expect(reviewIdOf(after?.jobPayload)).toBe('A');
			expect(await getDispatchById(older.id)).toMatchObject({ state: 'retry-scheduled' });
		});

		it('retires the older waiting response, settling its run and removing its wake-up', async () => {
			const { runId, older, newer } = await seedIncident();

			expect(
				await retireSupersededReviewResponses({
					projectId: PROJECT_ID,
					taskId: TASK_ID,
					excludeDispatchId: newer.id,
				}),
			).toBe(1);

			const retired = await getDispatchById(older.id);
			expect(retired).toMatchObject({ state: 'cancelled', waitReason: null });
			expect(retired?.lastError).toContain('Superseded');
			expect(await getRunByIdFromDb(runId)).toMatchObject({ status: 'failed', nextRetryAt: null });
			expect(await pendingJobIds()).not.toContain(wakeJobId(older));
			// Nothing may bring the retired response back: not the reconciler's
			// backfill, and not a wake-up that survived anyway.
			expect(await listDeferredRunsWithoutActiveDispatch()).toEqual([]);
			expect(
				await claimDispatchForJob(
					{ ...older.jobPayload, dispatchId: older.id } as SwarmJob,
					60_000,
				),
			).toMatchObject({ claimed: false, reason: 'terminal' });
		});

		it('lets the newer review take the run over cleanly once the older response is retired', async () => {
			const { runId, newer } = await seedIncident();
			await retireSupersededReviewResponses({
				projectId: PROJECT_ID,
				taskId: TASK_ID,
				excludeDispatchId: newer.id,
			});

			expect(await bindDispatchToRun(newer.id, runId)).toBe(true);
			expect(
				await resetRunToRunning(runId, { ...(newer.jobPayload as SwarmJob), runId }, 'failed'),
			).toBe(true);
			expect(
				await markDispatchRunning(newer.id, runId, new Date(Date.now() + 60_000), {
					taskId: TASK_ID,
					phase: 'respond-to-review',
					pullRequest: { repository: REPO, prNumber: PR },
				}),
			).toBe(true);

			const run = await getRunByIdFromDb(runId);
			expect(run?.status).toBe('running');
			expect(reviewIdOf(run?.jobPayload)).toBe('B');
			expect(await getDispatchById(newer.id)).toMatchObject({ state: 'running', runId });
		});

		it('retires only earlier, waiting responses for the same pull request', async () => {
			const { newer } = await seedIncident();
			const executing = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: reviewJob('X', 'delivery-x'),
				source: 'webhook',
				taskId: TASK_ID,
				phase: 'respond-to-review',
				state: 'leased',
				leaseOwner: 'host:2',
				leaseExpiresAt: new Date(Date.now() + 60_000),
			});
			const otherPr = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: reviewJob('Y', 'delivery-y'),
				source: 'webhook',
				taskId: '1440-respond',
				phase: 'respond-to-review',
			});
			const otherPhase = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: reviewJob('Z', 'delivery-z'),
				source: 'webhook',
				taskId: `${PR}-ci`,
				phase: 'respond-to-ci',
			});
			const later = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: reviewJob('C', 'delivery-c'),
				source: 'webhook',
				taskId: TASK_ID,
				phase: 'respond-to-review',
			});

			expect(
				await retireSupersededReviewResponses({
					projectId: PROJECT_ID,
					taskId: TASK_ID,
					excludeDispatchId: newer.id,
				}),
			).toBe(1);

			expect(await getDispatchById(executing.dispatch.id)).toMatchObject({ state: 'leased' });
			expect(await getDispatchById(otherPr.dispatch.id)).toMatchObject({ state: 'pending' });
			expect(await getDispatchById(otherPhase.dispatch.id)).toMatchObject({ state: 'pending' });
			// Created after the asking dispatch: a newer review, which this one must not retire.
			expect(await getDispatchById(later.dispatch.id)).toMatchObject({ state: 'pending' });
		});
	},
);
