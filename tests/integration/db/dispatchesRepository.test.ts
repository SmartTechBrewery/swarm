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
	findActivePlanningDispatchForTask,
	findExecutingDispatchForTask,
	findExecutingWritingDispatchForPullRequest,
	findWakeableWorkerUpdateDispatch,
	getActiveDispatchByRunId,
	getDispatchById,
	getWorkerDispatchClaimState,
	hasExecutingDispatchForTask,
	listActiveDispatchTaskRefs,
	listAvailabilityWaitsForWorker,
	listDeferredRunsWithoutActiveDispatch,
	listPullRequestInFlightWaits,
	listRunnableDispatchesForPool,
	listTaskInFlightWaits,
	listWaitingDispatches,
	listWakeablePendingDispatches,
	markDispatchRunning,
	promoteDispatchToImmediateWake,
	recordDispatchResolution,
	reopenDispatchForManualRetry,
	scheduleDispatchRetry,
	selectNextCapacityDispatch,
	supersedeDispatchesByCoalesceKey,
	supersedeWorkerUpdateDispatches,
	takeOverStaleDispatchForManualRetry,
} from '../../../src/db/repositories/dispatchesRepository.js';
import {
	completeRun,
	createRun,
	getRunByIdFromDb,
	recordRunPreservedWorker,
} from '../../../src/db/repositories/runsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { createEnrollment } from '../../../src/db/repositories/workerEnrollmentsRepository.js';
import { acquireLease } from '../../../src/db/repositories/workerSessionsRepository.js';
import {
	createWorker,
	setWorkerDeclaredCapabilities,
	setWorkerDraining,
} from '../../../src/db/repositories/workersRepository.js';
import { dispatches } from '../../../src/db/schema/dispatches.js';
import { projects } from '../../../src/db/schema/projects.js';
import { workers } from '../../../src/db/schema/workers.js';
import type { AgentCli } from '../../../src/harness/agent-cli.js';
import { describeError } from '../../../src/lib/errors.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import type { TriggerPhase } from '../../../src/triggers/types.js';
import {
	createMockProjectRepositoryPair,
	createMockScmWebhookJob,
} from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-dispatches';
const REPO = 'jkwiecien/dispatch-repo';
const OWNER = 'test-worker:1';

function job(overrides: Partial<SwarmJob> = {}): SwarmJob {
	return { ...createMockScmWebhookJob(), projectId: PROJECT_ID, ...overrides } as SwarmJob;
}

const WORKER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_WORKER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/** A durable worker self-update payload (issue #972) — the only one ranked negatively. */
function workerUpdateJob(workerId: string, requestId: string): SwarmJob {
	return {
		type: 'worker-update',
		projectId: PROJECT_ID,
		workerId,
		requestId,
		target: 'main',
	};
}

/** States only reachable by actually executing the dispatch. */
const EXECUTED_STATES: readonly DispatchState[] = ['running', 'completed', 'failed'];

/**
 * A dispatch for `taskId` (a review one unless `phase` says otherwise), driven to
 * `state` through the real transitions. Returns its id so a caller can exclude it.
 *
 * `pullRequest` seeds the PR coordinates the same way production does (issue #850):
 * through `recordDispatchResolution` on claim, and again through
 * `markDispatchRunning` for a state that actually executes — so a `pending` row
 * carrying them is the real shape of a writer that resolved and then deferred, not
 * a row the read could never have matched anyway.
 */
async function seedDispatchInState(
	taskId: string,
	state: DispatchState,
	runId: string | undefined,
	phase: TriggerPhase = 'review',
	pullRequest?: { repository: string; prNumber: string },
): Promise<string> {
	// `createDispatch` can start a row directly in any waiting/leased state;
	// everything past that is reached through the real lifecycle calls.
	const { dispatch } = await createDispatch({
		projectId: PROJECT_ID,
		jobPayload: job({ runId }),
		source: 'manual',
		taskId,
		phase,
		runId,
		state: state === 'leased' || state === 'retry-scheduled' ? state : 'pending',
	});
	if (pullRequest) await recordDispatchResolution(dispatch.id, { taskId, phase, pullRequest });
	if (state === 'cancelled') await cancelWaitingDispatch(dispatch.id, 'cleared the queue');
	if (EXECUTED_STATES.includes(state)) {
		await claimDispatch(dispatch.id, OWNER, 60_000);
		await markDispatchRunning(dispatch.id, runId, new Date(Date.now() + 60_000), {
			taskId,
			phase,
			pullRequest,
		});
	}
	if (state === 'completed') await completeDispatch(dispatch.id, 'phase-succeeded');
	if (state === 'failed') await failDispatch(dispatch.id, 'boom');
	return dispatch.id;
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('dispatchesRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
		await seedProject({ id: PROJECT_ID, repo: REPO });
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
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: '17',
				phase: 'review',
			});
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
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: '17',
				phase: 'review',
			});
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
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: TASK,
				phase: 'review',
			});
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
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: TASK,
				phase: 'review',
			});
			await seedDispatchInState(TASK, state, runId);
			expect(await hasExecutingDispatchForTask(PROJECT_ID, TASK)).toBe(false);
		});

		it('is false when the only executing dispatch belongs to the excluded run', async () => {
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: TASK,
				phase: 'review',
			});
			await seedDispatchInState(TASK, 'running', runId);
			expect(await hasExecutingDispatchForTask(PROJECT_ID, TASK, runId)).toBe(false);
		});

		it('is true for a run-row-less executing dispatch even when a run is excluded', async () => {
			await seedDispatchInState(TASK, 'running', undefined);
			// SQL `NULL <> $1` is unknown, so only the explicit isNull leg keeps this true.
			const otherRunId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: TASK,
				phase: 'review',
			});
			expect(await hasExecutingDispatchForTask(PROJECT_ID, TASK, otherRunId)).toBe(true);
		});

		it('scopes to the given project and task', async () => {
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: TASK,
				phase: 'review',
			});
			await seedDispatchInState(TASK, 'running', runId);
			expect(await hasExecutingDispatchForTask(PROJECT_ID, '78')).toBe(false);
			expect(await hasExecutingDispatchForTask('proj-other', TASK)).toBe(false);
		});
	});

	// Issue #759. The guard needs *which* phase holds the task, not merely whether one
	// does: the board-driven pair share a task id on purpose, so a same-phase collision
	// is a repeated delivery while a different-phase one is the pipeline advancing.
	describe('findExecutingDispatchForTask (issue #759)', () => {
		const TASK = '754';

		it.each([
			'leased',
			'running',
		] as const)('reports a %s dispatch together with the phase it holds', async (state) => {
			await seedDispatchInState(TASK, state, undefined, 'planning');
			expect(await findExecutingDispatchForTask(PROJECT_ID, TASK)).toMatchObject({
				phase: 'planning',
			});
		});

		it.each([
			'pending',
			'retry-scheduled',
			'completed',
			'failed',
			'cancelled',
		] as const)('ignores a %s dispatch — it owns no checkout', async (state) => {
			await seedDispatchInState(TASK, state, undefined, 'planning');
			expect(await findExecutingDispatchForTask(PROJECT_ID, TASK)).toBeUndefined();
		});

		it('ignores the asking dispatch, which is already leased with its own phase recorded', async () => {
			const own = await seedDispatchInState(TASK, 'leased', undefined, 'implementation');
			expect(await findExecutingDispatchForTask(PROJECT_ID, TASK, own)).toBeUndefined();
			expect(await findExecutingDispatchForTask(PROJECT_ID, TASK)).toMatchObject({ id: own });
		});

		it('ignores a merge-automation dispatch — it carries a taskId but provisions no worktree', async () => {
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'synthetic',
				taskId: TASK,
				phase: 'merge-automation',
				state: 'leased',
			});
			expect(await findExecutingDispatchForTask(PROJECT_ID, TASK)).toBeUndefined();
		});

		it('still reports an executing row whose phase was never recorded', async () => {
			// `IS DISTINCT FROM` rather than `ne`: SQL `NULL <> 'merge-automation'` is
			// unknown, which would drop exactly the row the caller must treat as "some
			// other phase" and therefore defer behind.
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				taskId: TASK,
				state: 'leased',
			});
			expect(await findExecutingDispatchForTask(PROJECT_ID, TASK)).toEqual({
				id: dispatch.id,
				phase: null,
			});
		});

		it('scopes to the given project and task', async () => {
			await seedDispatchInState(TASK, 'running', undefined, 'planning');
			expect(await findExecutingDispatchForTask(PROJECT_ID, '755')).toBeUndefined();
			expect(await findExecutingDispatchForTask('proj-other', TASK)).toBeUndefined();
		});
	});

	// Issue #761. The executing read above deliberately cannot see a *queued* Planning
	// dispatch — it owns no checkout — but that is exactly the dispatch an
	// Implementation must not overtake, since it was dispatched to consume its plan.
	describe('findActivePlanningDispatchForTask (issue #761)', () => {
		const TASK = '754';

		it.each([
			'pending',
			'leased',
			'running',
			'retry-scheduled',
		] as const)('reports a %s planning dispatch — it has not settled', async (state) => {
			await seedDispatchInState(TASK, state, undefined, 'planning');
			expect(await findActivePlanningDispatchForTask(PROJECT_ID, TASK)).toMatchObject({ state });
		});

		it.each([
			'completed',
			'failed',
			'cancelled',
		] as const)('ignores a %s planning dispatch — a settled plan holds nobody up', async (state) => {
			await seedDispatchInState(TASK, state, undefined, 'planning');
			expect(await findActivePlanningDispatchForTask(PROJECT_ID, TASK)).toBeUndefined();
		});

		it.each([
			'implementation',
			'review',
		] as const)('ignores an active %s dispatch — only Planning is waited for', async (phase) => {
			await seedDispatchInState(TASK, 'pending', undefined, phase);
			expect(await findActivePlanningDispatchForTask(PROJECT_ID, TASK)).toBeUndefined();
		});

		it('ignores a dispatch whose phase was never recorded — the documented blind spot', async () => {
			// A never-claimed dispatch carries a null `task_id`/`phase`, so it matches
			// nothing here. Matching on `phase IS NULL` instead would make two duplicate
			// Implementation deliveries defer to each other — the mirror case this read
			// exists to avoid.
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				taskId: TASK,
			});
			expect(await findActivePlanningDispatchForTask(PROJECT_ID, TASK)).toBeUndefined();
		});

		it('ignores the asking dispatch when it is excluded', async () => {
			const own = await seedDispatchInState(TASK, 'leased', undefined, 'planning');
			expect(await findActivePlanningDispatchForTask(PROJECT_ID, TASK, own)).toBeUndefined();
			expect(await findActivePlanningDispatchForTask(PROJECT_ID, TASK)).toMatchObject({ id: own });
		});

		it('scopes to the given project and task', async () => {
			await seedDispatchInState(TASK, 'pending', undefined, 'planning');
			expect(await findActivePlanningDispatchForTask(PROJECT_ID, '755')).toBeUndefined();
			expect(await findActivePlanningDispatchForTask('proj-other', TASK)).toBeUndefined();
		});
	});

	// Issue #850. Neither task read above can see two phases of one pull request: the
	// PR-driven phases carry deliberately distinct suffixed task ids, so the artifact
	// they actually contend for — the PR's head branch — had no key at all.
	describe('findExecutingWritingDispatchForPullRequest (issue #850)', () => {
		const PR = { repository: REPO, prNumber: '101' };

		it.each([
			'leased',
			'running',
		] as const)('reports a %s writing dispatch together with the phase it holds', async (state) => {
			await seedDispatchInState('101-conflicts', state, undefined, 'resolve-conflicts', PR);
			expect(
				await findExecutingWritingDispatchForPullRequest(PROJECT_ID, REPO, '101'),
			).toMatchObject({ phase: 'resolve-conflicts' });
		});

		it.each([
			'pending',
			'retry-scheduled',
			'completed',
			'failed',
			'cancelled',
		] as const)('ignores a %s dispatch — it is pushing nothing', async (state) => {
			await seedDispatchInState('101-conflicts', state, undefined, 'resolve-conflicts', PR);
			expect(
				await findExecutingWritingDispatchForPullRequest(PROJECT_ID, REPO, '101'),
			).toBeUndefined();
		});

		it.each([
			'respond-to-review',
			'respond-to-ci',
			'resolve-conflicts',
		] as const)('reports an executing %s dispatch — the three phases that push', async (phase) => {
			await seedDispatchInState(`101-${phase}`, 'running', undefined, phase, PR);
			expect(
				await findExecutingWritingDispatchForPullRequest(PROJECT_ID, REPO, '101'),
			).toMatchObject({ phase });
		});

		it('ignores an executing review dispatch — it checks the head out read-only', async () => {
			await seedDispatchInState('101', 'running', undefined, 'review', PR);
			expect(
				await findExecutingWritingDispatchForPullRequest(PROJECT_ID, REPO, '101'),
			).toBeUndefined();
		});

		it('ignores a merge-automation dispatch on the same pull request — it pushes nothing', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'synthetic',
				taskId: '101',
				phase: 'merge-automation',
				state: 'leased',
			});
			await getDb()
				.update(dispatches)
				.set({ repository: REPO, prNumber: '101' })
				.where(eq(dispatches.id, dispatch.id));
			expect(
				await findExecutingWritingDispatchForPullRequest(PROJECT_ID, REPO, '101'),
			).toBeUndefined();
		});

		it('ignores an executing row whose phase was never recorded', async () => {
			// The one deliberate difference from `findExecutingDispatchForTask`, which
			// reports such a row as "some other phase": here the verdict turns on *which*
			// phase holds the pull request, so an unrecorded one cannot be assumed to be a
			// writer — assuming it would defer a Review behind a Review.
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				taskId: '101',
				state: 'leased',
			});
			await getDb()
				.update(dispatches)
				.set({ repository: REPO, prNumber: '101' })
				.where(eq(dispatches.id, dispatch.id));
			expect(
				await findExecutingWritingDispatchForPullRequest(PROJECT_ID, REPO, '101'),
			).toBeUndefined();
		});

		it('ignores the asking dispatch, which already recorded its own pull request', async () => {
			const own = await seedDispatchInState(
				'101-respond',
				'leased',
				undefined,
				'respond-to-review',
				PR,
			);
			expect(
				await findExecutingWritingDispatchForPullRequest(PROJECT_ID, REPO, '101', own),
			).toBeUndefined();
			expect(
				await findExecutingWritingDispatchForPullRequest(PROJECT_ID, REPO, '101'),
			).toMatchObject({ id: own });
		});

		// A project spans several repositories (issue #684), so PR 42 in one is not PR 42
		// in the other — ai/TESTING.md "Two repositories of one project".
		it('scopes to the repository, the pull request, and the project', async () => {
			const [android, backend] = createMockProjectRepositoryPair();
			await seedDispatchInState('42-ci', 'running', undefined, 'respond-to-ci', {
				repository: android.repo,
				prNumber: '42',
			});

			expect(
				await findExecutingWritingDispatchForPullRequest(PROJECT_ID, android.repo, '42'),
			).toMatchObject({ phase: 'respond-to-ci' });
			expect(
				await findExecutingWritingDispatchForPullRequest(PROJECT_ID, backend.repo, '42'),
			).toBeUndefined();
			expect(
				await findExecutingWritingDispatchForPullRequest(PROJECT_ID, android.repo, '43'),
			).toBeUndefined();
			expect(
				await findExecutingWritingDispatchForPullRequest('proj-other', android.repo, '42'),
			).toBeUndefined();
		});
	});

	describe('listPullRequestInFlightWaits (issue #850)', () => {
		async function seedWait(overrides: Partial<Parameters<typeof createDispatch>[0]> = {}) {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				taskId: '101-respond',
				phase: 'respond-to-review',
				waitReason: 'pr-in-flight',
				...overrides,
			});
			await recordDispatchResolution(dispatch.id, {
				taskId: '101-respond',
				phase: 'respond-to-review',
				pullRequest: { repository: REPO, prNumber: '101' },
			});
			return dispatch;
		}

		it('returns the pending pr-in-flight waits for the pull request, oldest availability first', async () => {
			const later = await seedWait({ availableAt: new Date(Date.now() - 1_000) });
			const earlier = await seedWait({ availableAt: new Date(Date.now() - 10_000) });

			const waits = await listPullRequestInFlightWaits(PROJECT_ID, REPO, '101');
			expect(waits.map((row) => row.id)).toEqual([earlier.id, later.id]);
		});

		it('excludes other wait reasons, other pull requests, other repositories, and non-pending rows', async () => {
			const wanted = await seedWait();
			await seedWait({ waitReason: 'task-in-flight' });
			await seedWait({ state: 'leased' });
			const other = await seedWait();
			await getDb().update(dispatches).set({ prNumber: '102' }).where(eq(dispatches.id, other.id));
			const otherRepo = await seedWait();
			await getDb()
				.update(dispatches)
				.set({ repository: 'jkwiecien/second-repo' })
				.where(eq(dispatches.id, otherRepo.id));

			const waits = await listPullRequestInFlightWaits(PROJECT_ID, REPO, '101');
			expect(waits.map((row) => row.id)).toEqual([wanted.id]);
		});
	});

	describe('listTaskInFlightWaits (issue #759)', () => {
		const TASK = '754';

		async function seedWait(overrides: Partial<Parameters<typeof createDispatch>[0]> = {}) {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				taskId: TASK,
				phase: 'implementation',
				waitReason: 'task-in-flight',
				...overrides,
			});
			return dispatch;
		}

		it('returns the pending task-in-flight waits for the task, oldest availability first', async () => {
			const later = await seedWait({ availableAt: new Date(Date.now() - 1_000) });
			const earlier = await seedWait({ availableAt: new Date(Date.now() - 10_000) });

			const waits = await listTaskInFlightWaits(PROJECT_ID, TASK);
			expect(waits.map((row) => row.id)).toEqual([earlier.id, later.id]);
		});

		it('excludes other wait reasons, other tasks, other projects, and non-pending rows', async () => {
			const wanted = await seedWait();
			await seedWait({ waitReason: 'project-capacity' });
			await seedWait({ taskId: '755' });
			await seedWait({ state: 'leased' });
			await seedProject({ id: 'proj-other', repo: 'jkwiecien/other' });
			await createDispatch({
				projectId: 'proj-other',
				jobPayload: job({ projectId: 'proj-other' }),
				source: 'webhook',
				taskId: TASK,
				phase: 'implementation',
				waitReason: 'task-in-flight',
			});

			const waits = await listTaskInFlightWaits(PROJECT_ID, TASK);
			expect(waits.map((row) => row.id)).toEqual([wanted.id]);
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
		async function seedFederatedWorker(allocation = 1, suffix = String(allocation)) {
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
				allowedPhases: ['implementation'],
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

		it('a widened allocation lets one worker fill both project slots', async () => {
			// With allocation=1 the previous test capped a single worker at one run
			// even when the project allowed two. Raising the enrollment's share to 2
			// is how an operator lets the same worker fill both project slots — issue
			// #480 removed the `null`/"uncapped" allocation that used to do this
			// implicitly.
			await getDb()
				.update(projects)
				.set({ maxConcurrentJobs: 2 })
				.where(eq(projects.id, PROJECT_ID));
			const { worker, session } = await seedFederatedWorker(2, 'wide');
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

	// Issue #783: the under-lock re-check of the eligibility gate reads the same
	// effective set the gate did — a declaration the row carries, not the raw probe
	// column.
	describe('claim re-check against a declared capability set', () => {
		async function seedDeclarableWorker(suffix: string, allowedClis: AgentCli[]) {
			const owner = await createUser({
				identifier: `owner-${suffix}@example.com`,
				displayName: 'Owner',
			});
			const worker = await createWorker({
				ownerUserId: owner.id,
				displayName: `worker-${suffix}`,
				capabilities: ['claude', 'codex'],
				credentialHash: `hash-${suffix}`,
			});
			await createEnrollment({
				workerId: worker.id,
				projectId: PROJECT_ID,
				status: 'active',
				allowedClis,
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});
			const session = await acquireLease(worker.id, 60_000);
			return { worker, session };
		}

		async function claimInputFor(
			worker: { id: string },
			session: { id: string; fencingToken: number },
			owner: string,
		) {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			const leased = await claimDispatch(dispatch.id, owner, 60_000);
			if (!leased) throw new Error('test dispatch was not leased');
			return {
				dispatchId: leased.id,
				dispatchLeaseOwner: owner,
				projectId: PROJECT_ID,
				selectedWorkerId: worker.id,
				executionWorkerId: worker.id,
				workerSessionId: session.id,
				workerFencingToken: session.fencingToken,
				heartbeatTtlMs: 60_000,
			};
		}

		it('still admits a claim for a CLI the declaration keeps', async () => {
			const { worker, session } = await seedDeclarableWorker('declared-keeps', ['claude']);
			await setWorkerDeclaredCapabilities(worker.id, ['claude']);

			const input = await claimInputFor(worker, session, 'host-declared-keeps:1');
			expect(await claimWorkerForDispatch({ ...input, cli: 'claude' })).toMatchObject({
				claimed: true,
			});
		});

		// The declaration write refuses to drop a CLI an enrollment requires, so this row
		// state is unreachable through the service API — which is exactly the point: like
		// the probe-column check it replaces, this re-check is the defence against the
		// gate's read having gone stale between observing a worker and claiming it. Forced
		// directly, the way the lease-expiry cases in this file force theirs.
		it('refuses a claim for a CLI the declaration excludes, however the row got there', async () => {
			const { worker, session } = await seedDeclarableWorker('declared-excludes', [
				'claude',
				'codex',
			]);
			await getDb()
				.update(workers)
				.set({ declaredCapabilities: ['claude'] })
				.where(eq(workers.id, worker.id));

			const input = await claimInputFor(worker, session, 'host-declared-excludes:1');
			expect(await claimWorkerForDispatch({ ...input, cli: 'codex' })).toEqual({
				claimed: false,
				reason: 'missing-cli-capability',
			});
		});
	});

	// Issue #919: the half of the drain gate that cannot be raced. An operator may
	// drain a machine *after* the gate selected it, so the claim re-checks the flag
	// under the worker row's own `FOR UPDATE` lock — the claim is then refused and the
	// dispatch stays unclaimed for another machine, rather than the phase starting on a
	// machine somebody is about to restart.
	describe('claim re-check against the draining flag', () => {
		async function seedDrainableWorker(suffix: string) {
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
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});
			const session = await acquireLease(worker.id, 60_000);
			return { worker, session };
		}

		async function drainClaimInput(
			worker: { id: string },
			session: { id: string; fencingToken: number },
			owner: string,
		) {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			const leased = await claimDispatch(dispatch.id, owner, 60_000);
			if (!leased) throw new Error('test dispatch was not leased');
			return {
				dispatchId: leased.id,
				dispatchLeaseOwner: owner,
				projectId: PROJECT_ID,
				selectedWorkerId: worker.id,
				executionWorkerId: worker.id,
				workerSessionId: session.id,
				workerFencingToken: session.fencingToken,
				cli: 'claude' as AgentCli,
				heartbeatTtlMs: 60_000,
			};
		}

		it('refuses a claim for a machine drained after it was selected, leaving the dispatch unclaimed', async () => {
			const { worker, session } = await seedDrainableWorker('drained');
			const input = await drainClaimInput(worker, session, 'host-drained:1');

			await setWorkerDraining(worker.id, true);

			expect(await claimWorkerForDispatch(input)).toEqual({
				claimed: false,
				reason: 'worker-draining',
			});
			// Nothing was bound, so the dispatch is free to go to another eligible machine
			// on the next re-check rather than being failed here.
			const row = await getDispatchById(input.dispatchId);
			expect(row?.selectedWorkerId).toBeNull();
			expect(await getWorkerDispatchClaimState(worker.id, PROJECT_ID)).toEqual({
				activeRuns: 0,
				currentRunId: null,
			});
		});

		it('still admits a claim for a machine in the pool', async () => {
			const { worker, session } = await seedDrainableWorker('in-pool');
			const input = await drainClaimInput(worker, session, 'host-in-pool:1');

			expect(await claimWorkerForDispatch(input)).toMatchObject({ claimed: true });
		});

		it('admits a claim again once the machine is undrained', async () => {
			const { worker, session } = await seedDrainableWorker('undrained');
			await setWorkerDraining(worker.id, true);
			const refused = await drainClaimInput(worker, session, 'host-undrained:1');
			expect(await claimWorkerForDispatch(refused)).toEqual({
				claimed: false,
				reason: 'worker-draining',
			});

			await setWorkerDraining(worker.id, false);

			const input = await drainClaimInput(worker, session, 'host-undrained:2');
			expect(await claimWorkerForDispatch(input)).toMatchObject({ claimed: true });
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

		// Issue #1017. The claim the retry takes back is exactly the one the
		// lease-expiry sweep would have reaped; the take-over just does not wait for it.
		it('takes a claimed dispatch back, clearing the abandoned worker binding', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			const claimed = await claimDispatch(dispatch.id, OWNER, -1_000); // lease already lapsed

			const reopened = await takeOverStaleDispatchForManualRetry(
				dispatch.id,
				job({ rateLimitRetryAttempt: 0, cliOverride: 'codex' }),
				{
					leaseExpiresAt: claimed?.leaseExpiresAt ?? null,
					workerSessionId: claimed?.workerSessionId ?? null,
					workerFencingToken: claimed?.workerFencingToken ?? null,
				},
			);

			expect(reopened).toMatchObject({
				state: 'pending',
				waitReason: 'manual-retry',
				attempt: 0,
				leaseOwner: null,
				leaseExpiresAt: null,
				selectedWorkerId: null,
				workerSessionId: null,
				workerFencingToken: null,
			});
			expect(reopened?.jobPayload).toMatchObject({ cliOverride: 'codex' });
			// A worker that comes back to a dispatch it no longer holds must not be able
			// to start the phase on it.
			expect(
				await markDispatchRunning(dispatch.id, undefined, new Date(Date.now() + 60_000), {
					taskId: '103',
					phase: 'implementation',
				}),
			).toBe(false);
		});

		it('refuses the take-over when the claim moved since it was judged stale', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});
			const claimed = await claimDispatch(dispatch.id, OWNER, -1_000);
			// The worker got there first and renewed the lease onto the phase's budget,
			// which is precisely the window the compare-and-set closes.
			await markDispatchRunning(dispatch.id, undefined, new Date(Date.now() + 60_000), {
				taskId: '103',
				phase: 'implementation',
			});

			expect(
				await takeOverStaleDispatchForManualRetry(dispatch.id, job(), {
					leaseExpiresAt: claimed?.leaseExpiresAt ?? null,
					workerSessionId: claimed?.workerSessionId ?? null,
					workerFencingToken: claimed?.workerFencingToken ?? null,
				}),
			).toBeNull();
			expect((await getDispatchById(dispatch.id))?.state).toBe('running');
		});

		it('leaves a waiting dispatch to the reopen path', async () => {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
			});

			expect(
				await takeOverStaleDispatchForManualRetry(dispatch.id, job(), {
					leaseExpiresAt: null,
					workerSessionId: null,
					workerFencingToken: null,
				}),
			).toBeNull();
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
			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: '17',
				phase: 'review',
			});
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ runId }),
				source: 'webhook',
				runId,
			});
			await claimDispatch(dispatch.id, OWNER, -1_000);
			await markDispatchRunning(dispatch.id, runId, new Date(Date.now() - 1_000), {
				taskId: '17',
				phase: 'review',
			});

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
				repository: REPO,
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

	// Issue #533's demand read: what the dispatch gate matches against the pool's free
	// worker slots. Its whole value is in the filter, so it is pinned against real SQL.
	describe('pool-scheduling demand read', () => {
		it('returns the dispatches that still need a worker, in queue order', async () => {
			const board = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-board' }),
				dedupKey: 'delivery:d-board',
				source: 'webhook',
				// A PM-driven job is demoted below review-lifecycle work (`priorityFor`), and
				// the demand read must preserve that ranking.
				priority: 10,
				phase: 'planning',
			});
			const review = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-review' }),
				dedupKey: 'delivery:d-review',
				source: 'webhook',
				phase: 'review',
			});
			// Being gated right now — the contender that most needs a scarce worker is
			// often one another consumer is deciding on at this very moment.
			const leased = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-leased' }),
				dedupKey: 'delivery:d-leased',
				source: 'webhook',
				state: 'leased',
				phase: 'implementation',
			});
			// Scheduled into the future: not demand on the pool now.
			await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-later' }),
				dedupKey: 'delivery:d-later',
				source: 'recovered',
				state: 'retry-scheduled',
				availableAt: new Date(Date.now() + 60_000),
				phase: 'review',
			});
			await seedDispatchInState('task-running', 'running', undefined);
			await seedDispatchInState('task-done', 'completed', undefined);

			const runnable = await listRunnableDispatchesForPool(PROJECT_ID);

			expect(runnable.map((row) => row.id)).toEqual([
				review.dispatch.id,
				leased.dispatch.id,
				board.dispatch.id,
			]);
		});

		it('drops a dispatch that already claimed its worker', async () => {
			// Its capacity is spent — the worker's availability snapshot already reflects
			// it, so counting it as demand would double-book the same run.
			const owner = await createUser({ identifier: 'pool@example.com', displayName: 'Owner' });
			const worker = await createWorker({
				ownerUserId: owner.id,
				displayName: 'worker-pool',
				capabilities: ['claude'],
				credentialHash: 'hash-pool',
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
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				phase: 'implementation',
			});
			await claimDispatch(dispatch.id, OWNER, 60_000);
			expect(await listRunnableDispatchesForPool(PROJECT_ID)).toHaveLength(1);

			const claim = await claimWorkerForDispatch({
				dispatchId: dispatch.id,
				dispatchLeaseOwner: OWNER,
				projectId: PROJECT_ID,
				selectedWorkerId: worker.id,
				executionWorkerId: worker.id,
				workerSessionId: session.id,
				workerFencingToken: session.fencingToken,
				cli: 'claude',
				heartbeatTtlMs: 60_000,
			});

			expect(claim.claimed).toBe(true);
			expect(await listRunnableDispatchesForPool(PROJECT_ID)).toEqual([]);
		});
	});

	describe('orphaned deferred-run backfill source', () => {
		it('finds deferred runs with no active dispatch and ignores covered ones', async () => {
			const orphanId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: 'orphan',
				phase: 'review',
			});
			await completeRun(orphanId, { status: 'deferred', error: 'rate limited' });

			const coveredId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
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

	// Issue #610. Which deferred dispatches a worker becoming available may start —
	// the read behind the early wake-up, and the conditional re-date that makes two
	// concurrent wake-ups resolve to one promotion.
	describe('availability-wait promotion', () => {
		const OTHER_PROJECT_ID = 'proj-dispatches-other';

		/** A worker of `suffix`, enrolled in `PROJECT_ID` with the given routability. */
		async function seedEnrolledWorker(
			suffix: string,
			enrollment: { status?: 'pending' | 'active' | 'suspended'; sharingConsent?: boolean } = {},
		): Promise<string> {
			const owner = await createUser({
				identifier: `wake-${suffix}@example.com`,
				displayName: 'Owner',
			});
			const worker = await createWorker({
				ownerUserId: owner.id,
				displayName: `worker-${suffix}`,
				capabilities: ['claude'],
				credentialHash: `wake-hash-${suffix}`,
			});
			await createEnrollment({
				workerId: worker.id,
				projectId: PROJECT_ID,
				status: enrollment.status ?? 'active',
				allowedClis: ['claude'],
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: enrollment.sharingConsent ?? true,
			});
			return worker.id;
		}

		/** A dispatch deferred on `waitReason`, due in a minute like the real re-check. */
		async function deferredDispatch(
			waitReason:
				| 'worker-eligibility'
				| 'worker-authorization'
				| 'worker-rate-limited'
				| 'preserved-worker',
			overrides: { projectId?: string; runId?: string; availableAt?: Date } = {},
		): Promise<DispatchRow> {
			const { dispatch } = await createDispatch({
				projectId: overrides.projectId ?? PROJECT_ID,
				jobPayload: job({ runId: overrides.runId }),
				source: 'webhook',
				state: 'retry-scheduled',
				waitReason,
				availableAt: overrides.availableAt ?? new Date(Date.now() + 60_000),
				runId: overrides.runId,
			});
			return dispatch;
		}

		it('offers the availability waits in the worker’s routable projects, and nothing else', async () => {
			await seedProject({ id: OTHER_PROJECT_ID, repo: 'jkwiecien/other-repo' });
			const workerId = await seedEnrolledWorker('routable');

			const waiting = await deferredDispatch('worker-eligibility');
			// A structural wait a machine cannot clear (issue #607), another project, a
			// dispatch already due, and one that is no longer waiting at all.
			await deferredDispatch('worker-authorization');
			await deferredDispatch('worker-eligibility', { projectId: OTHER_PROJECT_ID });
			await deferredDispatch('worker-eligibility', {
				availableAt: new Date(Date.now() - 1_000),
			});
			const claimed = await deferredDispatch('worker-eligibility');
			await claimDispatch(claimed.id, OWNER, 60_000);

			const candidates = await listAvailabilityWaitsForWorker(workerId);
			expect(candidates.map((row) => row.id)).toEqual([waiting.id]);
		});

		it('offers nothing to a worker whose enrollment is not routable', async () => {
			const suspended = await seedEnrolledWorker('suspended', { status: 'suspended' });
			const withoutConsent = await seedEnrolledWorker('no-consent', { sharingConsent: false });
			await deferredDispatch('worker-eligibility');

			expect(await listAvailabilityWaitsForWorker(suspended)).toEqual([]);
			expect(await listAvailabilityWaitsForWorker(withoutConsent)).toEqual([]);
		});

		it('offers a preserved-checkout wait to its own machine, enrolled here or not', async () => {
			// The pinned machine is deliberately *not* enrolled in this project — the gate
			// honours the pin regardless (issue #567), so enrollment is the wrong key.
			const owner = await createUser({ identifier: 'pinned@example.com', displayName: 'Owner' });
			const pinned = await createWorker({
				ownerUserId: owner.id,
				displayName: 'worker-pinned',
				capabilities: ['claude'],
				credentialHash: 'wake-hash-pinned',
			});
			const enrolledElsewhere = await seedEnrolledWorker('bystander');

			const runId = await createRun({
				projectId: PROJECT_ID,
				repository: REPO,
				taskId: '549',
				phase: 'implementation',
				workerId: pinned.id,
			});
			await recordRunPreservedWorker(runId);
			const waiting = await deferredDispatch('preserved-worker', { runId });

			expect((await listAvailabilityWaitsForWorker(pinned.id)).map((row) => row.id)).toEqual([
				waiting.id,
			]);
			// Every other worker in the project being free changes nothing.
			expect(await listAvailabilityWaitsForWorker(enrolledElsewhere)).toEqual([]);
		});

		it('re-dates the dispatch once, whichever wake-up gets there first', async () => {
			const workerId = await seedEnrolledWorker('racing');
			const waiting = await deferredDispatch('worker-eligibility');

			const first = await promoteDispatchToImmediateWake(waiting.id, waiting.wakeSeq);
			const second = await promoteDispatchToImmediateWake(waiting.id, waiting.wakeSeq);

			expect(second).toBeNull();
			expect(first?.wakeSeq).toBe(waiting.wakeSeq + 1);
			expect(first?.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
			// The retry intent is untouched: the woken job spends the budget the previous
			// settle persisted, and re-enters the gate exactly as the timer would have.
			expect(first?.attempt).toBe(waiting.attempt);
			expect(first?.jobPayload).toEqual(waiting.jobPayload);
			expect(first?.waitReason).toBe('worker-eligibility');
			// And it is no longer a candidate, so a later wake-up is a no-op.
			expect(await listAvailabilityWaitsForWorker(workerId)).toEqual([]);
		});

		it('refuses to re-date a structural wait even when asked directly', async () => {
			const waiting = await deferredDispatch('worker-authorization');

			expect(await promoteDispatchToImmediateWake(waiting.id, waiting.wakeSeq)).toBeNull();
		});

		// Issue #988. The cooling wait is an *aggregate* refusal — every candidate was
		// out of allowance — so a machine turning up is exactly the event that can clear
		// it, and it joins the routable-enrollment leg rather than being left to the
		// timer. Asserted at **both** gates on purpose: widening only the listing would
		// strip the row's live wake-up and then have the re-date refuse it, abandoning
		// the dispatch to the reconciler's republish with nothing in the log saying so.
		it('wakes a cooling wait for a routably-enrolled machine, at both promotion gates', async () => {
			const workerId = await seedEnrolledWorker('cooling');
			const waiting = await deferredDispatch('worker-rate-limited');

			expect((await listAvailabilityWaitsForWorker(workerId)).map((row) => row.id)).toEqual([
				waiting.id,
			]);

			const promoted = await promoteDispatchToImmediateWake(waiting.id, waiting.wakeSeq);
			expect(promoted?.waitReason).toBe('worker-rate-limited');
			expect(promoted?.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
			// The wait reason is all that changed about this row's treatment: the retry
			// intent it carries is untouched, exactly as for `worker-eligibility`.
			expect(promoted?.attempt).toBe(waiting.attempt);
			expect(promoted?.jobPayload).toEqual(waiting.jobPayload);
		});

		// The scoping rule is the eligibility wait's, not a looser one: a cooling
		// refusal in a project this machine cannot take work in is none of its business.
		it('offers a cooling wait only where the machine is routably enrolled', async () => {
			await seedProject({ id: OTHER_PROJECT_ID, repo: 'jkwiecien/other-repo' });
			const withoutConsent = await seedEnrolledWorker('cooling-no-consent', {
				sharingConsent: false,
			});
			await deferredDispatch('worker-rate-limited');
			await deferredDispatch('worker-rate-limited', { projectId: OTHER_PROJECT_ID });

			expect(await listAvailabilityWaitsForWorker(withoutConsent)).toEqual([]);
		});
	});

	// issue #840 — the dispatch-side half of the item-liveness read model: the
	// "something is still due for this item" set.
	describe('listActiveDispatchTaskRefs', () => {
		it('returns every non-terminal state, with the resolved task and phase', async () => {
			await seedDispatchInState('92', 'pending', undefined);
			await seedDispatchInState('93', 'leased', undefined);
			await seedDispatchInState('94', 'running', undefined);
			await seedDispatchInState('95', 'retry-scheduled', undefined);

			const refs = await listActiveDispatchTaskRefs();

			expect(refs.map((ref) => ref.taskId).sort()).toEqual(['92', '93', '94', '95']);
			expect(new Set(refs.map((ref) => ref.phase))).toEqual(new Set(['review']));
			expect(new Set(refs.map((ref) => ref.projectId))).toEqual(new Set([PROJECT_ID]));
		});

		it('excludes terminal dispatches', async () => {
			await seedDispatchInState('96', 'completed', undefined);
			await seedDispatchInState('97', 'failed', undefined);
			await seedDispatchInState('98', 'cancelled', undefined);

			expect(await listActiveDispatchTaskRefs()).toEqual([]);
		});

		// A never-claimed dispatch is seconds old, so it can never be the
		// explanation for a multi-hour silence.
		it('excludes an active dispatch that has not resolved a task yet', async () => {
			await createDispatch({ projectId: PROJECT_ID, jobPayload: job(), source: 'webhook' });

			expect(await listActiveDispatchTaskRefs()).toEqual([]);
		});

		it('honours the accessible-project scope', async () => {
			await seedProject({ id: 'proj-other-dispatches', repo: 'jkwiecien/other-repo' });
			await seedDispatchInState('92', 'pending', undefined);
			await createDispatch({
				projectId: 'proj-other-dispatches',
				jobPayload: job({ projectId: 'proj-other-dispatches' }),
				source: 'manual',
				taskId: '99',
				phase: 'review',
			});

			const scoped = await listActiveDispatchTaskRefs([PROJECT_ID]);
			expect(scoped.map((ref) => ref.taskId)).toEqual(['92']);

			expect(await listActiveDispatchTaskRefs()).toHaveLength(2);
		});

		// A caller that narrowed to no accessible project must not be widened back
		// to the installation — the distinction `undefined` makes.
		it('answers an empty scope with no rows rather than every project', async () => {
			await seedDispatchInState('92', 'pending', undefined);

			expect(await listActiveDispatchTaskRefs([])).toEqual([]);
			expect(await listActiveDispatchTaskRefs()).toHaveLength(1);
		});
	});

	// Issue #972 — the machine-scoped queued unit. What only a real database settles
	// is the *ordering* it buys and the two payload-keyed reads behind it.
	describe('worker-update dispatches', () => {
		const REQUEST_ID = '66666666-6666-4666-8666-666666666666';
		const OTHER_REQUEST_ID = '77777777-7777-4777-8777-777777777777';

		async function seedUpdateDispatch(
			workerId: string,
			requestId: string,
			overrides: Partial<Parameters<typeof createDispatch>[0]> = {},
		) {
			const { dispatch } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: workerUpdateJob(workerId, requestId),
				dedupKey: `worker-update:${requestId}`,
				priority: -10,
				source: 'manual',
				phase: 'worker-update',
				...overrides,
			});
			return dispatch;
		}

		// The acceptance criterion, in the queue's own terms: ahead of work already
		// waiting, whatever it is and however long it has been there.
		it('sorts ahead of everything already waiting, in both claim-ordering reads', async () => {
			const board = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-board' }),
				dedupKey: 'delivery:d-board',
				source: 'webhook',
				priority: 10,
				phase: 'planning',
				// Oldest of the three, so FIFO alone would put it first.
				availableAt: new Date(Date.now() - 600_000),
			});
			const review = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job({ deliveryId: 'd-review' }),
				dedupKey: 'delivery:d-review',
				source: 'webhook',
				phase: 'review',
				availableAt: new Date(Date.now() - 300_000),
			});
			const update = await seedUpdateDispatch(WORKER_ID, REQUEST_ID);

			expect((await listWaitingDispatches(PROJECT_ID)).map((row) => row.id)).toEqual([
				update.id,
				review.dispatch.id,
				board.dispatch.id,
			]);
			expect((await listRunnableDispatchesForPool(PROJECT_ID)).map((row) => row.id)).toEqual([
				update.id,
				review.dispatch.id,
				board.dispatch.id,
			]);
		});

		// It names no pipeline phase and resolves no task, so nothing turns it into
		// demand on the worker pool or into an item-liveness signal.
		it('is invisible to the task-liveness read model', async () => {
			await seedUpdateDispatch(WORKER_ID, REQUEST_ID);

			expect(await listActiveDispatchTaskRefs()).toEqual([]);
		});

		describe('supersedeWorkerUpdateDispatches', () => {
			it("cancels this machine's non-terminal update dispatches and nobody else's", async () => {
				const mine = await seedUpdateDispatch(WORKER_ID, REQUEST_ID);
				const theirs = await seedUpdateDispatch(OTHER_WORKER_ID, OTHER_REQUEST_ID);
				const unrelated = await createDispatch({
					projectId: PROJECT_ID,
					jobPayload: job({ deliveryId: 'd-unrelated' }),
					dedupKey: 'delivery:d-unrelated',
					source: 'webhook',
					phase: 'review',
				});

				await supersedeWorkerUpdateDispatches(WORKER_ID, 'Superseded by a later request.');

				expect(await getDispatchById(mine.id)).toMatchObject({
					state: 'cancelled',
					lastError: 'Superseded by a later request.',
				});
				expect(await getDispatchById(theirs.id)).toMatchObject({ state: 'pending' });
				expect(await getDispatchById(unrelated.dispatch.id)).toMatchObject({ state: 'pending' });
			});

			// Terminal states are never resurrected or rewritten, exactly as everywhere
			// else in this repository.
			it('leaves an already-settled update dispatch alone', async () => {
				const settled = await seedUpdateDispatch(WORKER_ID, REQUEST_ID);
				await claimDispatch(settled.id, OWNER, 60_000);
				await completeDispatch(settled.id, 'worker-update-pushed');

				await supersedeWorkerUpdateDispatches(WORKER_ID, 'Superseded.');

				expect(await getDispatchById(settled.id)).toMatchObject({
					state: 'completed',
					outcome: 'worker-update-pushed',
				});
			});
		});

		describe('findWakeableWorkerUpdateDispatch', () => {
			/** The state an offline machine's dispatch is left in by the executor. */
			async function waitingForMachine(workerId: string, requestId: string) {
				const dispatch = await seedUpdateDispatch(workerId, requestId);
				await claimDispatch(dispatch.id, OWNER, 60_000);
				const scheduled = await scheduleDispatchRetry(dispatch.id, {
					jobPayload: workerUpdateJob(workerId, requestId),
					availableAt: new Date(Date.now() + 300_000),
					waitReason: 'worker-eligibility',
					attempt: 1,
				});
				if (!scheduled) throw new Error('expected the retry to be scheduled');
				return scheduled;
			}

			it("finds only this machine's future-dated retry-scheduled row", async () => {
				const mine = await waitingForMachine(WORKER_ID, REQUEST_ID);
				await waitingForMachine(OTHER_WORKER_ID, OTHER_REQUEST_ID);

				expect((await findWakeableWorkerUpdateDispatch(WORKER_ID))?.id).toBe(mine.id);
			});

			// A dispatch already due needs no promotion, and its wake-up may be in flight
			// — which is what makes the remove-then-re-date sequence safe for the caller.
			it('ignores a dispatch that is already due', async () => {
				await seedUpdateDispatch(WORKER_ID, REQUEST_ID, { state: 'retry-scheduled' });

				expect(await findWakeableWorkerUpdateDispatch(WORKER_ID)).toBeUndefined();
			});

			it('ignores a pending or terminal dispatch', async () => {
				const pending = await seedUpdateDispatch(WORKER_ID, REQUEST_ID);
				expect(await findWakeableWorkerUpdateDispatch(WORKER_ID)).toBeUndefined();

				await cancelWaitingDispatch(pending.id, 'cleared the queue');
				expect(await findWakeableWorkerUpdateDispatch(WORKER_ID)).toBeUndefined();
			});

			// The whole point of the reconnect hook: the wait collapses to now, so the
			// republished wake-up delivers the frame immediately.
			it('hands the found row to promoteDispatchToImmediateWake', async () => {
				const waiting = await waitingForMachine(WORKER_ID, REQUEST_ID);

				const promoted = await promoteDispatchToImmediateWake(waiting.id, waiting.wakeSeq);

				expect(promoted).not.toBeNull();
				expect(promoted?.wakeSeq).toBe(waiting.wakeSeq + 1);
				expect(promoted?.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
			});
		});

		// The executor is handed a transaction-less default in production but the
		// *request* write hands it its own `tx`, so the parameter has to be honoured.
		it('honours an executor so the dispatch can join the request transaction', async () => {
			const db = getDb();
			await expect(
				db.transaction(async (tx) => {
					const { dispatch } = await createDispatch(
						{
							projectId: PROJECT_ID,
							jobPayload: workerUpdateJob(WORKER_ID, REQUEST_ID),
							dedupKey: `worker-update:${REQUEST_ID}`,
							priority: -10,
							source: 'manual',
							phase: 'worker-update',
						},
						tx,
					);
					expect(dispatch.priority).toBe(-10);
					throw new Error('roll back');
				}),
			).rejects.toThrow('roll back');

			// Rolled back with the transaction rather than committed on its own.
			expect(await listWaitingDispatches(PROJECT_ID)).toEqual([]);
		});
	});
});
