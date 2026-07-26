import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import {
	cancelAllWaitingDispatches,
	cancelClaimedDispatch,
	cancelWaitingDispatch,
	claimDispatch,
	claimWorkerForDispatch,
	completeDispatch,
	createDispatch,
	type DispatchRow,
	type DispatchState,
	deferDispatchToPending,
	failDispatch,
	failExpiredDispatchLeases,
	failSupersededWorkerDispatchClaims,
	getActiveDispatchByRunId,
	getDispatchById,
	getWorkerDispatchClaimState,
	hasExecutingDispatchForTask,
	listDeferredRunsWithoutActiveDispatch,
	listWaitingDispatches,
	listWakeablePendingDispatches,
	markDispatchRunning,
	reopenDispatchForManualRetry,
	scheduleDispatchRetry,
	selectNextCapacityDispatch,
	supersedeDispatchesByCoalesceKey,
} from '../../../src/db/repositories/dispatchesRepository.js';
import {
	completeRun,
	createRun,
	getRunByIdFromDb,
} from '../../../src/db/repositories/runsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { createEnrollment } from '../../../src/db/repositories/workerEnrollmentsRepository.js';
import { acquireLease } from '../../../src/db/repositories/workerSessionsRepository.js';
import { createWorker } from '../../../src/db/repositories/workersRepository.js';
import { dispatches } from '../../../src/db/schema/dispatches.js';
import { projects } from '../../../src/db/schema/projects.js';
import { describeError } from '../../../src/lib/errors.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-dispatches';
const OWNER = 'test-worker:1';

function job(overrides: Partial<SwarmJob> = {}): SwarmJob {
	return { ...createMockScmWebhookJob(), projectId: PROJECT_ID, ...overrides } as SwarmJob;
}

/** States only reachable by actually executing the dispatch. */
const EXECUTED_STATES: readonly DispatchState[] = ['running', 'completed', 'failed'];

/** A review dispatch for `taskId`, driven to `state` through the real transitions. */
async function seedDispatchInState(
	taskId: string,
	state: DispatchState,
	runId: string | undefined,
): Promise<void> {
	// `createDispatch` can start a row directly in any waiting/leased state;
	// everything past that is reached through the real lifecycle calls.
	const { dispatch } = await createDispatch({
		projectId: PROJECT_ID,
		jobPayload: job({ runId }),
		source: 'manual',
		taskId,
		phase: 'review',
		runId,
		state: state === 'leased' || state === 'retry-scheduled' ? state : 'pending',
	});
	if (state === 'cancelled') await cancelWaitingDispatch(dispatch.id, 'cleared the queue');
	if (EXECUTED_STATES.includes(state)) {
		await claimDispatch(dispatch.id, OWNER, 60_000);
		await markDispatchRunning(dispatch.id, runId, new Date(Date.now() + 60_000), taskId, 'review');
	}
	if (state === 'completed') await completeDispatch(dispatch.id, 'phase-succeeded');
	if (state === 'failed') await failDispatch(dispatch.id, 'boom');
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('dispatchesRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
		await seedProject({ id: PROJECT_ID, repo: 'jkwiecien/dispatch-repo' });
	});

	describe('create + dedup identity', () => {
		it('deduplicates on dedupKey, returning the existing row for a redelivery', async () => {
			const first = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-1' }),
				dedupKey: 'delivery:d-1',
				source: 'webhook',
			});
			const second = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-1' }),
				dedupKey: 'delivery:d-1',
				source: 'webhook',
			});

			expect(first.created).toBe(true);
			expect(second.created).toBe(false);
			expect(second.dispatch.id).toBe(first.dispatch.id);
		});

		it('enforces at most one active dispatch per run row (the duplicate-retry guard)', async () => {
			const runId = await createRun({ projectId: PROJECT_ID, taskId: '17', phase: 'review' });
			await completeRun(runId, { status: 'failed', error: 'boom' });

			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'manual',
				runId,
			});

			// Drizzle wraps the pg error; the constraint name lives in the cause
			// chain (`describeError` is what the API's CONFLICT detection reads).
			const failure = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'manual',
				runId,
			}).then(
				() => null,
				(err: unknown) => describeError(err),
			);
			expect(failure).toMatch(/uq_dispatches_active_run|duplicate key/);
		});

		it('allows a new active dispatch for a run whose prior dispatch is terminal', async () => {
			const runId = await createRun({ projectId: PROJECT_ID, taskId: '17', phase: 'review' });
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'manual',
				runId,
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);
			await failDispatch(dispatch.id, 'first attempt failed');

			const second = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'manual',
				runId,
			});
			expect(second.created).toBe(true);
		});
	});

	describe('hasExecutingDispatchForTask (issue #427)', () => {
		const TASK = '77';

		it.each(['leased', 'running'] as const)('is true for a %s dispatch', async (state) => {
			const runId = await createRun({ projectId: PROJECT_ID, taskId: TASK, phase: 'review' });
			await seedDispatchInState(TASK, state, runId);
			expect(await hasExecutingDispatchForTask(PROJECT_ID, TASK)).toBe(true);
		});

		it.each([
			'pending',
			'retry-scheduled',
			'completed',
			'failed',
			'cancelled',
		] as const)('is false for a %s dispatch — it owns no checkout', async (state) => {
			const runId = await createRun({ projectId: PROJECT_ID, taskId: TASK, phase: 'review' });
			await seedDispatchInState(TASK, state, runId);
			expect(await hasExecutingDispatchForTask(PROJECT_ID, TASK)).toBe(false);
		});

		it('is false when the only executing dispatch belongs to the excluded run', async () => {
			const runId = await createRun({ projectId: PROJECT_ID, taskId: TASK, phase: 'review' });
			await seedDispatchInState(TASK, 'running', runId);
			expect(await hasExecutingDispatchForTask(PROJECT_ID, TASK, runId)).toBe(false);
		});

		it('is true for a run-row-less executing dispatch even when a run is excluded', async () => {
			await seedDispatchInState(TASK, 'running', undefined);
			// SQL `NULL <> $1` is unknown, so only the explicit isNull leg keeps this true.
			const otherRunId = await createRun({ projectId: PROJECT_ID, taskId: TASK, phase: 'review' });
			expect(await hasExecutingDispatchForTask(PROJECT_ID, TASK, otherRunId)).toBe(true);
		});

		it('scopes to the given project and task', async () => {
			const runId = await createRun({ projectId: PROJECT_ID, taskId: TASK, phase: 'review' });
			await seedDispatchInState(TASK, 'running', runId);
			expect(await hasExecutingDispatchForTask(PROJECT_ID, '78')).toBe(false);
			expect(await hasExecutingDispatchForTask('proj-other', TASK)).toBe(false);
		});
	});

	describe('claim (dequeue → claim boundary)', () => {
		it('claims a pending dispatch exactly once — the loser is refused', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});

			const [a, b] = await Promise.all([
				claimDispatch(dispatch.id, 'worker-a:1', 60_000),
				claimDispatch(dispatch.id, 'worker-b:1', 60_000),
			]);

			// Exactly one concurrent claimant wins.
			expect([a, b].filter((r) => r !== null)).toHaveLength(1);
		});

		it('lets the same owner re-claim its own lease (a delivery retry after an infra throw)', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			expect(await claimDispatch(dispatch.id, OWNER, 60_000)).not.toBeNull();
			expect(await claimDispatch(dispatch.id, OWNER, 60_000)).not.toBeNull();
			expect(await claimDispatch(dispatch.id, 'other-worker:2', 60_000)).toBeNull();
		});

		it('refuses to claim a cancelled dispatch — cancellation prevents resurrection', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			expect(await cancelWaitingDispatch(dispatch.id, 'operator cleared the queue')).not.toBeNull();

			expect(await claimDispatch(dispatch.id, OWNER, 60_000)).toBeNull();
			const row = await getDispatchById(dispatch.id);
			expect(row?.state).toBe('cancelled');
		});

		it('refuses to claim completed and failed dispatches', async () => {
			for (const settle of [completeDispatch, failDispatch] as const) {
				const { dispatch } = await createDispatch({
					projectId: PROJECT_ID,
					jobPayload: job(),
					source: 'webhook',
				});
				await claimDispatch(dispatch.id, OWNER, 60_000);
				await (settle === completeDispatch
					? completeDispatch(dispatch.id, 'phase-succeeded')
					: failDispatch(dispatch.id, 'boom'));
				expect(await claimDispatch(dispatch.id, OWNER, 60_000)).toBeNull();
			}
		});
	});

	describe('federated worker execution claims', () => {
		async function seedFederatedWorker(allocation: number | null = 1, suffix = String(allocation)) {
			const owner = await createUser({
				identifier: `owner-${suffix}@example.com`,
				displayName: 'Owner',
			});
			const worker = await createWorker({
				ownerUserId: owner.id,
				displayName: `worker-${suffix}`,
				capabilities: ['claude'],
				credentialHash: `hash-${suffix}`,
			});
			await createEnrollment({
				workerId: worker.id,
				projectId: PROJECT_ID,
				status: 'active',
				allowedClis: ['claude'],
				concurrencyAllocation: allocation,
				sharingConsent: true,
			});
			const session = await acquireLease(worker.id, 60_000);
			return { worker, session };
		}

		async function leasedDispatch(owner: string) {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			const leased = await claimDispatch(dispatch.id, owner, 60_000);
			if (!leased) throw new Error('test dispatch was not leased');
			return leased;
		}

		it('allows only the selected authenticated worker host to claim execution', async () => {
			const { worker, session } = await seedFederatedWorker();
			const dispatch = await leasedDispatch('host-b:1');

			const result = await claimWorkerForDispatch({
				dispatchId: dispatch.id,
				dispatchLeaseOwner: 'host-b:1',
				projectId: PROJECT_ID,
				selectedWorkerId: worker.id,
				executionWorkerId: '22222222-2222-4222-8222-222222222222',
				workerSessionId: session.id,
				workerFencingToken: session.fencingToken,
				cli: 'claude',
				heartbeatTtlMs: 60_000,
			});

			expect(result).toEqual({ claimed: false, reason: 'wrong-worker-host' });
			expect(await getWorkerDispatchClaimState(worker.id, PROJECT_ID)).toEqual({
				activeRuns: 0,
				currentRunId: null,
			});
		});

		it('atomically prevents simultaneous dispatches from exceeding allocation', async () => {
			await getDb()
				.update(projects)
				.set({ maxConcurrentJobs: 2 })
				.where(eq(projects.id, PROJECT_ID));
			const { worker, session } = await seedFederatedWorker(1);
			const [first, second] = await Promise.all([
				leasedDispatch('host-a:1'),
				leasedDispatch('host-a:2'),
			]);
			const claim = (dispatch: DispatchRow) =>
				claimWorkerForDispatch({
					dispatchId: dispatch.id,
					dispatchLeaseOwner: dispatch.leaseOwner ?? '',
					projectId: PROJECT_ID,
					selectedWorkerId: worker.id,
					executionWorkerId: worker.id,
					workerSessionId: session.id,
					workerFencingToken: session.fencingToken,
					cli: 'claude',
					heartbeatTtlMs: 60_000,
				});

			const results = await Promise.all([claim(first), claim(second)]);
			expect(results.filter((result) => result.claimed)).toHaveLength(1);
			expect(results.filter((result) => !result.claimed)).toEqual([
				{ claimed: false, reason: 'worker-unavailable' },
			]);
			expect((await getWorkerDispatchClaimState(worker.id, PROJECT_ID)).activeRuns).toBe(1);
		});

		it('a null allocation imposes no per-worker cap — one worker fills the project slots', async () => {
			// With allocation=1 the previous test capped a single worker at one run
			// even when the project allowed two. A null allocation removes that
			// per-worker sub-limit, so the same worker fills both project slots.
			await getDb()
				.update(projects)
				.set({ maxConcurrentJobs: 2 })
				.where(eq(projects.id, PROJECT_ID));
			const { worker, session } = await seedFederatedWorker(null, 'unbounded');
			const [first, second] = await Promise.all([
				leasedDispatch('host-a:1'),
				leasedDispatch('host-a:2'),
			]);
			const claim = (dispatch: DispatchRow) =>
				claimWorkerForDispatch({
					dispatchId: dispatch.id,
					dispatchLeaseOwner: dispatch.leaseOwner ?? '',
					projectId: PROJECT_ID,
					selectedWorkerId: worker.id,
					executionWorkerId: worker.id,
					workerSessionId: session.id,
					workerFencingToken: session.fencingToken,
					cli: 'claude',
					heartbeatTtlMs: 60_000,
				});

			const results = await Promise.all([claim(first), claim(second)]);
			expect(results.filter((result) => result.claimed)).toHaveLength(2);
			expect((await getWorkerDispatchClaimState(worker.id, PROJECT_ID)).activeRuns).toBe(2);
		});

		it('serializes two worker identities against the project concurrency limit', async () => {
			const firstHost = await seedFederatedWorker(1, 'host-a');
			const secondHost = await seedFederatedWorker(1, 'host-b');
			const [first, second] = await Promise.all([
				leasedDispatch('host-a:1'),
				leasedDispatch('host-b:1'),
			]);
			const claim = (
				dispatch: DispatchRow,
				host: Awaited<ReturnType<typeof seedFederatedWorker>>,
			) =>
				claimWorkerForDispatch({
					dispatchId: dispatch.id,
					dispatchLeaseOwner: dispatch.leaseOwner ?? '',
					projectId: PROJECT_ID,
					selectedWorkerId: host.worker.id,
					executionWorkerId: host.worker.id,
					workerSessionId: host.session.id,
					workerFencingToken: host.session.fencingToken,
					cli: 'claude',
					heartbeatTtlMs: 60_000,
				});

			const results = await Promise.all([claim(first, firstHost), claim(second, secondHost)]);
			expect(results.filter((result) => result.claimed)).toHaveLength(1);
			expect(results.filter((result) => !result.claimed)).toEqual([
				{ claimed: false, reason: 'project-capacity' },
			]);
			const totalActive =
				(await getWorkerDispatchClaimState(firstHost.worker.id, PROJECT_ID)).activeRuns +
				(await getWorkerDispatchClaimState(secondHost.worker.id, PROJECT_ID)).activeRuns;
			expect(totalActive).toBe(1);
		});

		it('clears a claim on deferral so another dispatch can reserve the slot', async () => {
			const { worker, session } = await seedFederatedWorker(1);
			const first = await leasedDispatch('host-a:1');
			const claimed = await claimWorkerForDispatch({
				dispatchId: first.id,
				dispatchLeaseOwner: 'host-a:1',
				projectId: PROJECT_ID,
				selectedWorkerId: worker.id,
				executionWorkerId: worker.id,
				workerSessionId: session.id,
				workerFencingToken: session.fencingToken,
				cli: 'claude',
				heartbeatTtlMs: 60_000,
			});
			expect(claimed.claimed).toBe(true);

			const deferred = await scheduleDispatchRetry(first.id, {
				jobPayload: job(),
				availableAt: new Date(Date.now() + 60_000),
				waitReason: 'worker-eligibility',
				attempt: 1,
			});
			expect(deferred).toMatchObject({
				selectedWorkerId: null,
				workerSessionId: null,
				workerFencingToken: null,
			});
			expect((await getWorkerDispatchClaimState(worker.id, PROJECT_ID)).activeRuns).toBe(0);
		});

		it('releases capacity on success, terminal failure, and cancellation', async () => {
			const { worker, session } = await seedFederatedWorker(1);
			const settle = [
				(id: string) => completeDispatch(id, 'phase-succeeded'),
				(id: string) => failDispatch(id, 'terminal failure'),
				(id: string) => cancelClaimedDispatch(id, 'operator cancelled'),
			];
			for (const [index, settleDispatch] of settle.entries()) {
				const dispatch = await leasedDispatch(`host-a:${index}`);
				const claim = await claimWorkerForDispatch({
					dispatchId: dispatch.id,
					dispatchLeaseOwner: dispatch.leaseOwner ?? '',
					projectId: PROJECT_ID,
					selectedWorkerId: worker.id,
					executionWorkerId: worker.id,
					workerSessionId: session.id,
					workerFencingToken: session.fencingToken,
					cli: 'claude',
					heartbeatTtlMs: 60_000,
				});
				expect(claim.claimed).toBe(true);
				await settleDispatch(dispatch.id);
				expect((await getWorkerDispatchClaimState(worker.id, PROJECT_ID)).activeRuns).toBe(0);
			}
		});

		it('recovers capacity durably after a claimed dispatch lease expires', async () => {
			const { worker, session } = await seedFederatedWorker(1);
			const expired = await leasedDispatch('host-a:expired');
			const firstClaim = await claimWorkerForDispatch({
				dispatchId: expired.id,
				dispatchLeaseOwner: expired.leaseOwner ?? '',
				projectId: PROJECT_ID,
				selectedWorkerId: worker.id,
				executionWorkerId: worker.id,
				workerSessionId: session.id,
				workerFencingToken: session.fencingToken,
				cli: 'claude',
				heartbeatTtlMs: 60_000,
			});
			expect(firstClaim.claimed).toBe(true);
			await getDb()
				.update(dispatches)
				.set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
				.where(eq(dispatches.id, expired.id));
			expect((await getWorkerDispatchClaimState(worker.id, PROJECT_ID)).activeRuns).toBe(0);

			const replacement = await leasedDispatch('host-a:replacement');
			const replacementClaim = await claimWorkerForDispatch({
				dispatchId: replacement.id,
				dispatchLeaseOwner: replacement.leaseOwner ?? '',
				projectId: PROJECT_ID,
				selectedWorkerId: worker.id,
				executionWorkerId: worker.id,
				workerSessionId: session.id,
				workerFencingToken: session.fencingToken,
				cli: 'claude',
				heartbeatTtlMs: 60_000,
			});
			expect(replacementClaim.claimed).toBe(true);
		});

		it('releases an older fenced session claim immediately after re-acquisition', async () => {
			const { worker, session } = await seedFederatedWorker(1);
			const dispatch = await leasedDispatch('host-a:old-session');
			const claim = await claimWorkerForDispatch({
				dispatchId: dispatch.id,
				dispatchLeaseOwner: dispatch.leaseOwner ?? '',
				projectId: PROJECT_ID,
				selectedWorkerId: worker.id,
				executionWorkerId: worker.id,
				workerSessionId: session.id,
				workerFencingToken: session.fencingToken,
				cli: 'claude',
				heartbeatTtlMs: 60_000,
			});
			expect(claim.claimed).toBe(true);

			const failed = await failSupersededWorkerDispatchClaims(
				worker.id,
				session.fencingToken + 1,
				'old fenced session',
			);
			expect(failed.map((row) => row.id)).toEqual([dispatch.id]);
			expect((await getWorkerDispatchClaimState(worker.id, PROJECT_ID)).activeRuns).toBe(0);
		});
	});

	describe('defer → reschedule boundary', () => {
		it('persists the derived retry payload durably and bumps the wake sequence', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);

			const retryAt = new Date(Date.now() + 60_000);
			const updated = await scheduleDispatchRetry(dispatch.id, {
				jobPayload: job({ rateLimitRetryAttempt: 1, resumeSession: true }),
				availableAt: retryAt,
				waitReason: 'rate-limit',
				attempt: 1,
			});

			expect(updated).toMatchObject({
				state: 'retry-scheduled',
				waitReason: 'rate-limit',
				attempt: 1,
				wakeSeq: 1,
				leaseOwner: null,
			});
			expect(updated?.jobPayload).toMatchObject({ rateLimitRetryAttempt: 1, resumeSession: true });
			// A crash here loses only the wake-up, never the intent: the row is
			// what the reconciler re-publishes from.
			expect(await listWakeablePendingDispatches()).toHaveLength(1);
		});

		it('lets a cancellation win over a concurrent defer (cancel → remove boundary)', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);
			// A running dispatch is not waiting — a queue-clear style cancel misses it…
			expect(await cancelWaitingDispatch(dispatch.id, 'cleared')).toBeNull();
			// …but once deferred it is cancellable, and the cancel then blocks the wake-up.
			await scheduleDispatchRetry(dispatch.id, {
				jobPayload: job(),
				availableAt: new Date(),
				waitReason: 'rate-limit',
				attempt: 1,
			});
			expect(await cancelWaitingDispatch(dispatch.id, 'cleared')).not.toBeNull();
			expect(await claimDispatch(dispatch.id, OWNER, 60_000)).toBeNull();
		});
	});

	describe('capacity waits and promotion', () => {
		it('returns a claimed dispatch to pending with the capacity wait reason', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);

			const pending = await deferDispatchToPending(dispatch.id, {
				jobPayload: job({ continuationDispatchClaimed: true }),
				waitReason: 'project-capacity',
				continuation: true,
			});

			expect(pending).toMatchObject({
				state: 'pending',
				waitReason: 'project-capacity',
				continuation: true,
				wakeSeq: 1,
			});
			// Capacity waits are woken by slot releases, not timers — the wake-up
			// republisher must not touch them.
			expect(await listWakeablePendingDispatches()).toHaveLength(0);
		});

		it('selects the oldest continuation first when the policy is on, FIFO otherwise', async () => {
			async function capacityPending(continuation: boolean, availableAt: Date): Promise<string> {
				const { dispatch } = await createDispatch({
					projectId: PROJECT_ID,
					jobPayload: job(),
					source: 'webhook',
					state: 'pending',
					waitReason: 'project-capacity',
					continuation,
					availableAt,
				});
				return dispatch.id;
			}
			const boardOld = await capacityPending(false, new Date(Date.now() - 60_000));
			const continuationNew = await capacityPending(true, new Date(Date.now() - 30_000));

			expect((await selectNextCapacityDispatch(PROJECT_ID, true))?.id).toBe(continuationNew);
			expect((await selectNextCapacityDispatch(PROJECT_ID, false))?.id).toBe(boardOld);
		});
	});

	describe('manual retry', () => {
		it('reopens a scheduled retry immediately with a reset attempt budget', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);
			await scheduleDispatchRetry(dispatch.id, {
				jobPayload: job({ rateLimitRetryAttempt: 6 }),
				availableAt: new Date(Date.now() + 60 * 60 * 1000),
				waitReason: 'rate-limit',
				attempt: 6,
			});

			const reopened = await reopenDispatchForManualRetry(
				dispatch.id,
				job({ rateLimitRetryAttempt: 0, cliOverride: 'codex' }),
			);

			expect(reopened).toMatchObject({
				state: 'pending',
				waitReason: 'manual-retry',
				attempt: 0,
				wakeSeq: 2,
			});
			expect(reopened?.jobPayload).toMatchObject({ cliOverride: 'codex' });
		});

		it('refuses to reopen a dispatch a worker already claimed', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);

			expect(await reopenDispatchForManualRetry(dispatch.id, job())).toBeNull();
		});
	});

	describe('lease reclaim (claim → run boundary)', () => {
		it("fails only expired leases and preserves another host's live claim", async () => {
			const expired = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			await claimDispatch(expired.dispatch.id, OWNER, -1_000); // already expired
			const live = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-live' }),
				dedupKey: 'delivery:d-live',
				source: 'webhook',
			});
			await claimDispatch(live.dispatch.id, OWNER, 60_000);

			const reclaimed = await failExpiredDispatchLeases('dead worker', new Date());
			expect(reclaimed.map((d) => d.id)).toEqual([expired.dispatch.id]);
			expect((await getDispatchById(live.dispatch.id))?.state).toBe('leased');
		});

		it('covers running dispatches too — a dead run row cannot hide behind `running`', async () => {
			const runId = await createRun({ projectId: PROJECT_ID, taskId: '17', phase: 'review' });
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'webhook',
				runId,
			});
			await claimDispatch(dispatch.id, OWNER, -1_000);
			await markDispatchRunning(dispatch.id, runId, new Date(Date.now() - 1_000), '17', 'review');

			const reclaimed = await failExpiredDispatchLeases('dead worker', new Date());
			expect(reclaimed.map((d) => d.id)).toEqual([dispatch.id]);
		});
	});

	describe('coalesced supersede', () => {
		it('supersedes waiting dispatches sharing the coalesce key', async () => {
			const first = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				coalesceKey: 'check-suite:r:1:sha',
				source: 'recheck',
			});

			const superseded = await supersedeDispatchesByCoalesceKey('check-suite:r:1:sha');

			expect(superseded.map((d) => d.id)).toEqual([first.dispatch.id]);
			expect((await getDispatchById(first.dispatch.id))?.outcome).toBe('superseded');
			expect(await claimDispatch(first.dispatch.id, OWNER, 60_000)).toBeNull();
		});
	});

	describe('canonical queue read + clear', () => {
		it('reopens a concurrently visible deferred run with overrides without duplicating its dispatch', async () => {
			const runId = await createRun({
				projectId: PROJECT_ID,
				taskId: 'manual-retry',
				phase: 'resolve-conflicts',
			});
			await completeRun(runId, { status: 'deferred', error: 'rate limited' });
			const originalJob = job({ runId });
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: originalJob,
				source: 'synthetic',
				state: 'retry-scheduled',
				waitReason: 'rate-limit',
				runId,
			});
			expect(await getRunByIdFromDb(runId)).toBeDefined();

			const overriddenJob = {
				...originalJob,
				cliOverride: 'codex' as const,
				modelOverride: 'gpt-5.2-codex',
				reasoningOverride: 'high' as const,
			};
			const reopened = await reopenDispatchForManualRetry(dispatch.id, overriddenJob);

			expect(reopened).toMatchObject({
				id: dispatch.id,
				state: 'pending',
				waitReason: 'manual-retry',
				attempt: 0,
				jobPayload: expect.objectContaining({
					cliOverride: 'codex',
					modelOverride: 'gpt-5.2-codex',
					reasoningOverride: 'high',
				}),
			});
			const activeForRun = (await listWaitingDispatches(PROJECT_ID)).filter(
				(candidate) => candidate.runId === runId,
			);
			expect(activeForRun).toHaveLength(1);
			expect(activeForRun[0].id).toBe(dispatch.id);
			expect((await getActiveDispatchByRunId(runId))?.id).toBe(dispatch.id);
		});

		it('lists every waiting dispatch and cancels them all atomically', async () => {
			await createDispatch({ projectId: PROJECT_ID, jobPayload: job(), source: 'webhook' });
			const capacity = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-cap' }),
				dedupKey: 'delivery:d-cap',
				source: 'webhook',
				state: 'pending',
				waitReason: 'project-capacity',
			});
			const scheduled = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-sched' }),
				dedupKey: 'delivery:d-sched',
				source: 'recovered',
				state: 'retry-scheduled',
				waitReason: 'recovered',
				availableAt: new Date(Date.now() + 60_000),
			});

			// Nothing waiting is invisible (issue #284's acceptance criterion).
			const waiting = await listWaitingDispatches(PROJECT_ID);
			expect(waiting).toHaveLength(3);

			const cancelled = await cancelAllWaitingDispatches('queue cleared');
			expect(cancelled).toHaveLength(3);
			for (const d of [capacity.dispatch, scheduled.dispatch]) {
				expect(await claimDispatch(d.id, OWNER, 60_000)).toBeNull();
			}
			expect(await listWaitingDispatches(PROJECT_ID)).toHaveLength(0);
		});
	});

	describe('orphaned deferred-run backfill source', () => {
		it('finds deferred runs with no active dispatch and ignores covered ones', async () => {
			const orphanId = await createRun({
				projectId: PROJECT_ID,
				taskId: 'orphan',
				phase: 'review',
			});
			await completeRun(orphanId, { status: 'deferred', error: 'rate limited' });

			const coveredId = await createRun({
				projectId: PROJECT_ID,
				taskId: 'covered',
				phase: 'review',
			});
			await completeRun(coveredId, { status: 'deferred', error: 'rate limited' });
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId: coveredId }),
				source: 'recovered',
				state: 'retry-scheduled',
				waitReason: 'recovered',
				runId: coveredId,
			});

			const orphans = await listDeferredRunsWithoutActiveDispatch();
			expect(orphans.map((r) => r.id)).toEqual([orphanId]);
			expect(await getActiveDispatchByRunId(coveredId)).toBeDefined();
		});
	});
});
