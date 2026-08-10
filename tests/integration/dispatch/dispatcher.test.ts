import { Queue } from 'bullmq';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
	claimDispatch,
	createDispatch,
	getDispatchById,
	listWakeablePendingDispatches,
} from '../../../src/db/repositories/dispatchesRepository.js';
import { completeRun, createRun } from '../../../src/db/repositories/runsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { createEnrollment } from '../../../src/db/repositories/workerEnrollmentsRepository.js';
import { createWorker } from '../../../src/db/repositories/workersRepository.js';
import {
	cancelAllWaitingWork,
	cancelDispatchAndWake,
	claimDispatchForJob,
	createAndPublishDispatch,
	promoteAvailabilityWaitsForWorker,
	promoteNextCapacityDispatch,
	publishDispatchWakeUp,
	scheduleCoalescedDispatch,
	wakeJobId,
} from '../../../src/dispatch/dispatcher.js';
import { QUEUE_NAME, type SwarmJob } from '../../../src/queue/jobs.js';
import { closeQueue } from '../../../src/queue/producer.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-dispatcher';

function job(overrides: Partial<SwarmJob> = {}): SwarmJob {
	return { ...createMockScmWebhookJob(), projectId: PROJECT_ID, ...overrides } as SwarmJob;
}

// Real Postgres + Redis/BullMQ (issue #284's acceptance criteria): these tests
// exercise the persist→publish outbox, the crash-repair republish, and the
// claim-refusal that makes cancellation final — against the actual transports,
// with "crashes" injected by simply not performing the step a real crash would
// skip.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE || !process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'dispatcher (integration, Postgres + Redis/BullMQ)',
	() => {
		// Inspection-only queue handle on the same connection settings the producer uses.
		let inspect: Queue<SwarmJob>;

		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: 'jkwiecien/dispatcher-repo' });
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

		it('persist → publish: creating a dispatch lands exactly one deterministic wake-up', async () => {
			const { dispatch } = await createAndPublishDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-1' }),
				dedupKey: 'delivery:d-1',
				source: 'webhook',
			});

			expect(await pendingJobIds()).toEqual([wakeJobId(dispatch)]);

			// A redelivery of the same identity publishes nothing new.
			await createAndPublishDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-1' }),
				dedupKey: 'delivery:d-1',
				source: 'webhook',
			});
			expect(await pendingJobIds()).toHaveLength(1);
		});

		it('crash between persist and publish: the republish repair is idempotent', async () => {
			// Simulated crash: the dispatch was durably recorded but its wake-up
			// never landed (a kill between the insert and the queue add).
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			expect(await pendingJobIds()).toHaveLength(0);

			// The reconciler's repair path: republish every wakeable dispatch.
			for (const row of await listWakeablePendingDispatches()) {
				await publishDispatchWakeUp(row);
			}
			expect(await pendingJobIds()).toEqual([wakeJobId(dispatch)]);

			// Running the repair again must not stack a second delivery.
			for (const row of await listWakeablePendingDispatches()) {
				await publishDispatchWakeUp(row);
			}
			expect(await pendingJobIds()).toHaveLength(1);
		});

		it('cancel → claim refusal: a wake-up that survives cancellation is dropped at claim time', async () => {
			const { dispatch } = await createAndPublishDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			// Cancel while the wake-up is already in the queue, then simulate the
			// removal half failing (a crash between cancel and remove) by re-adding
			// the wake-up ourselves.
			const cancelled = await cancelDispatchAndWake(dispatch.id, 'operator cancelled');
			expect(cancelled).not.toBeNull();
			expect(await pendingJobIds()).toHaveLength(0);
			await publishDispatchWakeUp(dispatch);
			expect(await pendingJobIds()).toHaveLength(1);

			// The delivery arrives anyway — the claim refuses it.
			const claim = await claimDispatchForJob(job({ dispatchId: dispatch.id }), 60_000);
			expect(claim).toEqual({ claimed: false, reason: 'terminal' });
			expect((await getDispatchById(dispatch.id))?.state).toBe('cancelled');
		});

		it('adopts a legacy runId-carrying job by claiming the run’s backfilled dispatch', async () => {
			const runId = await createRun({ projectId: PROJECT_ID, taskId: '17', phase: 'review' });
			await completeRun(runId, { status: 'deferred', error: 'rate limited' });
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'recovered',
				state: 'retry-scheduled',
				waitReason: 'recovered',
				runId,
			});

			// A pre-deploy delayed BullMQ job for the same run arrives with no dispatchId.
			const claim = await claimDispatchForJob(job({ runId }), 60_000);

			expect(claim.claimed).toBe(true);
			if (!claim.claimed) throw new Error('unreachable');
			expect(claim.dispatch.id).toBe(dispatch.id);
			// The one-active-dispatch-per-run index means no duplicate was created.
			expect((await getDispatchById(dispatch.id))?.state).toBe('leased');
		});

		it('adopts a fully legacy job by creating a leased dispatch record', async () => {
			const claim = await claimDispatchForJob(job({ deliveryId: 'legacy-d' }), 60_000);

			expect(claim.claimed).toBe(true);
			if (!claim.claimed) throw new Error('unreachable');
			expect(claim.dispatch).toMatchObject({
				state: 'leased',
				source: 'adopted',
				dedupKey: 'delivery:legacy-d',
			});
		});

		it('slot release wakes the next capacity-blocked dispatch with a fresh deterministic id', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				state: 'pending',
				waitReason: 'project-capacity',
			});

			await promoteNextCapacityDispatch(PROJECT_ID, true);

			const ids = await pendingJobIds();
			expect(ids).toEqual([wakeJobId(dispatch)]);

			// Promotion is idempotent under racing slot releases (same job id).
			await promoteNextCapacityDispatch(PROJECT_ID, true);
			expect(await pendingJobIds()).toHaveLength(1);
		});

		// Issue #610. The availability wake-up's real difference from the capacity one:
		// it promotes a `retry-scheduled` row that already holds a *delayed* wake-up, so
		// the stale one has to go rather than be overwritten.
		it('an available worker replaces the delayed wake-up with an immediate one', async () => {
			const owner = await createUser({ identifier: 'wake@example.com', displayName: 'Owner' });
			const worker = await createWorker({
				ownerUserId: owner.id,
				displayName: 'worker-wake',
				capabilities: ['claude'],
				credentialHash: 'wake-hash',
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
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				state: 'retry-scheduled',
				waitReason: 'worker-eligibility',
				// The 5-minute re-check the gate's deferral schedules.
				availableAt: new Date(Date.now() + 300_000),
			});
			await publishDispatchWakeUp(dispatch);
			const [delayed] = await inspect.getDelayed();
			expect(delayed?.id).toBe(wakeJobId(dispatch));

			expect(await promoteAvailabilityWaitsForWorker(worker.id, 'connected')).toBe(1);

			// Exactly one wake-up, on the next wake sequence, eligible now rather than in
			// five minutes — the stale delayed job is gone, not merely shadowed.
			const promoted = await getDispatchById(dispatch.id);
			expect(promoted?.wakeSeq).toBe(dispatch.wakeSeq + 1);
			expect(await pendingJobIds()).toEqual([wakeJobId({ id: dispatch.id, wakeSeq: 1 })]);
			expect(await inspect.getDelayed()).toEqual([]);

			// A second worker becoming available finds nothing left to promote.
			expect(await promoteAvailabilityWaitsForWorker(worker.id, 'capacity-freed')).toBe(0);
			expect(await pendingJobIds()).toHaveLength(1);
		});

		it('coalesced rechecks supersede the prior dispatch and its wake-up', async () => {
			await scheduleCoalescedDispatch(job({ recheckAttempt: 1 }), 'check-suite:r:1:sha', 50);
			const firstIds = await pendingJobIds();
			expect(firstIds).toHaveLength(1);

			await scheduleCoalescedDispatch(job({ recheckAttempt: 2 }), 'check-suite:r:1:sha', 50);

			const ids = await pendingJobIds();
			expect(ids).toHaveLength(1);
			expect(ids[0]).not.toBe(firstIds[0]);
		});

		it('queue clear cancels canonical dispatches first, then drains the transport', async () => {
			await createAndPublishDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-a' }),
				dedupKey: 'delivery:d-a',
				source: 'webhook',
			});
			const capacity = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-b' }),
				dedupKey: 'delivery:d-b',
				source: 'webhook',
				state: 'pending',
				waitReason: 'project-capacity',
			});

			const result = await cancelAllWaitingWork('cleared in test');

			expect(result.cancelledDispatches).toBe(2);
			expect(await pendingJobIds()).toHaveLength(0);
			// Nothing can resurrect the capacity dispatch: a late slot release
			// finds nothing to promote, and a claim refuses.
			await promoteNextCapacityDispatch(PROJECT_ID, true);
			expect(await pendingJobIds()).toHaveLength(0);
			expect(await claimDispatch(capacity.dispatch.id, 'w:1', 60_000)).toBeNull();
		});
	},
);
