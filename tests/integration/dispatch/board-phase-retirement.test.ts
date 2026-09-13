import { Queue } from 'bullmq';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type {
	DispatchPhase,
	DispatchWaitReason,
} from '../../../src/db/repositories/dispatchesRepository.js';
import {
	createDispatch,
	deferDispatchToPending,
	getDispatchById,
	listDeferredRunsWithoutActiveDispatch,
	listTaskInFlightWaits,
	listWaitingDispatches,
	listWakeablePendingDispatches,
} from '../../../src/db/repositories/dispatchesRepository.js';
import {
	completeRun,
	createRun,
	getRunByIdFromDb,
} from '../../../src/db/repositories/runsRepository.js';
import { retireSupersededBoardPhases } from '../../../src/dispatch/board-phase-retirement.js';
import {
	claimDispatchForJob,
	publishDispatchWakeUp,
	wakeJobId,
} from '../../../src/dispatch/dispatcher.js';
import { QUEUE_NAME, type SwarmJob } from '../../../src/queue/jobs.js';
import { closeQueue } from '../../../src/queue/producer.js';
import { createMockPmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-board-retirement';
const REPO = 'jkwiecien/board-retirement-repo';
const TASK_ID = '21';

function job(overrides: Partial<SwarmJob> = {}): SwarmJob {
	return { ...createMockPmWebhookJob(), projectId: PROJECT_ID, ...overrides } as SwarmJob;
}

// Real Postgres + Redis (issue #909): the criteria this rule is actually about are
// about *durable state* — a retired dispatch must go terminal, its `deferred` run
// must be settled in the same transaction, and nothing (a retry, a slot release, a
// wake-up, or the reconciler's backfill) may bring either back.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE || !process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'board-driven phase retirement (integration, Postgres + Redis/BullMQ)',
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
		 * A resolved waiting dispatch, with its wake-up published — the state a board
		 * dispatch is in once its claim resolved the trigger and a gate deferred it.
		 */
		async function seedWaiting(input: {
			dedupKey: string;
			phase: DispatchPhase;
			taskId?: string;
			state?: 'pending' | 'leased';
			waitReason?: DispatchWaitReason;
			runId?: string;
		}) {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: input.dedupKey }),
				dedupKey: input.dedupKey,
				source: 'webhook',
				taskId: input.taskId ?? TASK_ID,
				phase: input.phase,
				state: input.state ?? 'pending',
				waitReason: input.waitReason,
				runId: input.runId,
				...(input.state === 'leased'
					? { leaseOwner: 'host:1', leaseExpiresAt: new Date(Date.now() + 60_000) }
					: {}),
			});
			await publishDispatchWakeUp(dispatch);
			return dispatch;
		}

		/** A `deferred` run row — the one a retirement has to settle with its dispatch. */
		async function seedDeferredRun(phase: 'planning' | 'implementation', agentSessionId?: string) {
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: TASK_ID,
				phase,
				jobPayload: job(),
			});
			await completeRun(runId, {
				status: 'deferred',
				error: 'waiting for the task checkout',
				nextRetryAt: new Date(Date.now() + 60_000),
				agentSessionId,
				...(agentSessionId ? { recovery: { state: 'preserved', agentSessionId } } : {}),
			});
			return runId;
		}

		// The observed incident (run 401c7c88…, task 21): an Implementation deferred
		// behind a `task-in-flight` Planning, which had to be terminated by hand.
		it('retires the queued Implementation and settles its deferred run when the card returns to Planning', async () => {
			const runId = await seedDeferredRun('implementation');
			const stale = await seedWaiting({
				dedupKey: 'd-impl',
				phase: 'implementation',
				waitReason: 'task-in-flight',
				runId,
			});
			const planning = await seedWaiting({ dedupKey: 'd-planning', phase: 'planning' });

			const retired = await retireSupersededBoardPhases({
				projectId: PROJECT_ID,
				taskId: TASK_ID,
				keepPhase: 'planning',
				excludeDispatchId: 'some-other-dispatch',
			});

			expect(retired).toBe(1);
			expect(await getDispatchById(stale.id)).toMatchObject({
				state: 'cancelled',
				waitReason: null,
			});
			// Settled together with its dispatch, not left `deferred` with a retry due.
			expect(await getRunByIdFromDb(runId)).toMatchObject({
				status: 'failed',
				nextRetryAt: null,
			});
			expect((await getRunByIdFromDb(runId))?.error).toContain('Planning');

			// The phase the card's column actually asks for is untouched, wake-up included.
			expect(await getDispatchById(planning.id)).toMatchObject({ state: 'pending' });
			expect(await pendingJobIds()).toEqual([wakeJobId(planning)]);
		});

		// The acceptance criterion in full: no retry, slot release, wake-up, or
		// reconciliation may resurrect a retired dispatch or its run.
		it('leaves nothing behind that could resurrect the retired phase', async () => {
			const runId = await seedDeferredRun('implementation');
			const stale = await seedWaiting({
				dedupKey: 'd-impl',
				phase: 'implementation',
				waitReason: 'task-in-flight',
				runId,
			});

			await retireSupersededBoardPhases({
				projectId: PROJECT_ID,
				taskId: TASK_ID,
				keepPhase: 'planning',
				excludeDispatchId: 'some-other-dispatch',
			});

			// The reconciler's startup backfill re-dispatches deferred runs with no
			// active dispatch — the very path an unpaired cancel would have fed.
			expect(await listDeferredRunsWithoutActiveDispatch()).toEqual([]);
			expect(await listWakeablePendingDispatches()).toEqual([]);
			expect(await listTaskInFlightWaits(PROJECT_ID, TASK_ID)).toEqual([]);
			expect(await listWaitingDispatches(PROJECT_ID)).toEqual([]);
			// A wake-up that survived anyway would still be refused at claim time.
			expect(await claimDispatchForJob({ ...job(), dispatchId: stale.id }, 60_000)).toMatchObject({
				claimed: false,
				reason: 'terminal',
			});
		});

		it('retires every waiting board phase when the card moves to a column that starts none', async () => {
			const planning = await seedWaiting({ dedupKey: 'd-planning', phase: 'planning' });
			const implementation = await seedWaiting({ dedupKey: 'd-impl', phase: 'implementation' });

			const retired = await retireSupersededBoardPhases({
				projectId: PROJECT_ID,
				taskId: TASK_ID,
				keepPhase: undefined,
				excludeDispatchId: 'some-other-dispatch',
			});

			expect(retired).toBe(2);
			expect(await getDispatchById(planning.id)).toMatchObject({ state: 'cancelled' });
			expect(await getDispatchById(implementation.id)).toMatchObject({ state: 'cancelled' });
			expect(await pendingJobIds()).toEqual([]);
		});

		// Stopping a phase that is already executing stays Terminate's job.
		it('never retires an executing sibling, nor touches its run', async () => {
			const runId = await seedDeferredRun('implementation');
			const executing = await seedWaiting({
				dedupKey: 'd-impl',
				phase: 'implementation',
				state: 'leased',
				runId,
			});

			expect(
				await retireSupersededBoardPhases({
					projectId: PROJECT_ID,
					taskId: TASK_ID,
					keepPhase: 'planning',
					excludeDispatchId: 'some-other-dispatch',
				}),
			).toBe(0);
			expect(await getDispatchById(executing.id)).toMatchObject({ state: 'leased' });
			expect(await getRunByIdFromDb(runId)).toMatchObject({ status: 'deferred' });
		});

		// The phase filter's whole point: a Review carries the bare `task-<pr>` id, so a
		// card whose `taskRef` is the same number must not sweep it up.
		it('never retires an SCM-driven phase sharing the task id', async () => {
			const review = await seedWaiting({ dedupKey: 'd-review', phase: 'review' });

			expect(
				await retireSupersededBoardPhases({
					projectId: PROJECT_ID,
					taskId: TASK_ID,
					keepPhase: undefined,
					excludeDispatchId: 'some-other-dispatch',
				}),
			).toBe(0);
			expect(await getDispatchById(review.id)).toMatchObject({ state: 'pending' });
		});

		it('never retires the evaluation’s own dispatch, even when its phase differs', async () => {
			const own = await seedWaiting({ dedupKey: 'd-own', phase: 'implementation' });

			expect(
				await retireSupersededBoardPhases({
					projectId: PROJECT_ID,
					taskId: TASK_ID,
					keepPhase: 'planning',
					excludeDispatchId: own.id,
				}),
			).toBe(0);
			expect(await getDispatchById(own.id)).toMatchObject({ state: 'pending' });
		});

		// Unlike `failRunFromStatus`, the settle keeps the session and the recovery
		// record, so a retired run that held a preserved session is still resumable.
		it('keeps a retired run’s preserved session and recovery record', async () => {
			const runId = await seedDeferredRun('implementation', 'session-abc');
			await seedWaiting({ dedupKey: 'd-impl', phase: 'implementation', runId });

			await retireSupersededBoardPhases({
				projectId: PROJECT_ID,
				taskId: TASK_ID,
				keepPhase: 'planning',
				excludeDispatchId: 'some-other-dispatch',
			});

			const run = await getRunByIdFromDb(runId);
			expect(run).toMatchObject({ status: 'failed', agentSessionId: 'session-abc' });
			expect(run?.recovery).toMatchObject({ state: 'preserved', agentSessionId: 'session-abc' });
		});

		// A dispatch whose trigger has not run yet is a queue hop, not a wait: it
		// self-corrects at its own claim, and matching it here would make the two
		// deliveries of one drag retire each other.
		it('is blind to a dispatch that has not resolved a phase yet', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-unresolved' }),
				dedupKey: 'd-unresolved',
				source: 'webhook',
			});

			expect(
				await retireSupersededBoardPhases({
					projectId: PROJECT_ID,
					taskId: TASK_ID,
					keepPhase: undefined,
					excludeDispatchId: 'some-other-dispatch',
				}),
			).toBe(0);
			expect(await getDispatchById(dispatch.id)).toMatchObject({ state: 'pending' });
		});

		// The one interleaving where a retired phase could still come back. A pre-run
		// wait makes its dispatch `pending` *before* settling the run it just created
		// (`deferBeforeRun`, `src/worker/consumer.ts`), so a board move landing in
		// between finds a `pending` dispatch paired with a `running` run. The three
		// calls below are that sequence, in that order, through the same repository
		// functions the worker uses.
		it('retires a phase caught mid-deferral without letting its run come back', async () => {
			// 1. `tryCreateRun` — the row is `running` from here until the settle.
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: TASK_ID,
				phase: 'implementation',
				jobPayload: job(),
			});
			const claimed = await seedWaiting({
				dedupKey: 'd-impl',
				phase: 'implementation',
				state: 'leased',
			});

			// 2. `deferDispatchToPending` — the dispatch is waiting, the run is not yet.
			const pending = await deferDispatchToPending(claimed.id, {
				jobPayload: job({ deliveryId: 'd-impl' }),
				waitReason: 'task-in-flight',
				continuation: false,
				runId,
			});
			expect(pending).toMatchObject({ state: 'pending', runId });
			expect(await getRunByIdFromDb(runId)).toMatchObject({ status: 'running' });

			// 3. The newer board move lands in the window and retires the phase.
			expect(
				await retireSupersededBoardPhases({
					projectId: PROJECT_ID,
					taskId: TASK_ID,
					keepPhase: 'planning',
					excludeDispatchId: 'some-other-dispatch',
				}),
			).toBe(1);
			// The still-`running` row is settled with its dispatch, not skipped.
			expect(await getRunByIdFromDb(runId)).toMatchObject({
				status: 'failed',
				nextRetryAt: null,
			});

			// 4. The worker resumes and makes its guarded settle — which now loses.
			const settled = await completeRun(runId, {
				status: 'deferred',
				error: 'waiting for the task checkout',
				nextRetryAt: null,
				fromStatus: 'running',
			});
			expect(settled).toBe(false);

			expect(await getDispatchById(claimed.id)).toMatchObject({ state: 'cancelled' });
			expect(await getRunByIdFromDb(runId)).toMatchObject({ status: 'failed' });
			// The backfill is the path that would have re-dispatched the stale phase.
			expect(await listDeferredRunsWithoutActiveDispatch()).toEqual([]);
		});

		// The same guard must not swallow the ordinary case: with no retirement in the
		// window, the deferral settles exactly as it always did.
		it('still settles a pre-run deferral’s run when nothing retires it', async () => {
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: TASK_ID,
				phase: 'implementation',
				jobPayload: job(),
			});
			const claimed = await seedWaiting({
				dedupKey: 'd-impl',
				phase: 'implementation',
				state: 'leased',
			});
			await deferDispatchToPending(claimed.id, {
				jobPayload: job({ deliveryId: 'd-impl' }),
				waitReason: 'task-in-flight',
				continuation: false,
				runId,
			});

			expect(
				await completeRun(runId, {
					status: 'deferred',
					error: 'waiting for the task checkout',
					nextRetryAt: null,
					fromStatus: 'running',
				}),
			).toBe(true);
			expect(await getRunByIdFromDb(runId)).toMatchObject({ status: 'deferred' });
		});

		// A same-phase waiting sibling is a duplicate delivery, which the existing
		// dedup / `skipped-duplicate` machinery already owns.
		it('never retires a same-phase sibling', async () => {
			const sibling = await seedWaiting({ dedupKey: 'd-planning-2', phase: 'planning' });

			expect(
				await retireSupersededBoardPhases({
					projectId: PROJECT_ID,
					taskId: TASK_ID,
					keepPhase: 'planning',
					excludeDispatchId: 'some-other-dispatch',
				}),
			).toBe(0);
			expect(await getDispatchById(sibling.id)).toMatchObject({ state: 'pending' });
		});
	},
);
