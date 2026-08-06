import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	createEnrollment,
	getEnrollmentById,
	listEnrollmentsForProject,
	listEnrollmentsForWorker,
	setEnrollmentSharingConsent,
	updateEnrollmentConstraintsRow,
	updateEnrollmentStatus,
} = vi.hoisted(() => ({
	createEnrollment: vi.fn(),
	getEnrollmentById: vi.fn(),
	listEnrollmentsForProject: vi.fn(),
	listEnrollmentsForWorker: vi.fn(),
	setEnrollmentSharingConsent: vi.fn(),
	updateEnrollmentConstraintsRow: vi.fn(),
	updateEnrollmentStatus: vi.fn(),
}));
const { getWorkerById, listAllWorkers, listWorkersForOwner } = vi.hoisted(() => ({
	getWorkerById: vi.fn(),
	listAllWorkers: vi.fn(),
	listWorkersForOwner: vi.fn(),
}));
const { getUserById } = vi.hoisted(() => ({ getUserById: vi.fn() }));
const { getRunByIdFromDb } = vi.hoisted(() => ({ getRunByIdFromDb: vi.fn() }));
const { getLiveSessionForWorker, getRetainedSessionForWorker } = vi.hoisted(() => ({
	getLiveSessionForWorker: vi.fn(),
	getRetainedSessionForWorker: vi.fn(),
}));
const { getActiveWorkerClaims, getWorkerDispatchClaimState } = vi.hoisted(() => ({
	getActiveWorkerClaims: vi.fn(),
	getWorkerDispatchClaimState: vi.fn(),
}));

vi.mock('@/db/repositories/workerEnrollmentsRepository.js', () => ({
	createEnrollment,
	getEnrollmentById,
	listEnrollmentsForProject,
	listEnrollmentsForWorker,
	setEnrollmentSharingConsent,
	updateEnrollmentConstraints: updateEnrollmentConstraintsRow,
	updateEnrollmentStatus,
}));
vi.mock('@/db/repositories/workersRepository.js', () => ({
	getWorkerById,
	listAllWorkers,
	listWorkersForOwner,
}));
vi.mock('@/db/repositories/usersRepository.js', () => ({ getUserById }));
vi.mock('@/db/repositories/runsRepository.js', () => ({ getRunByIdFromDb }));
vi.mock('@/identity/worker-session-service.js', () => ({
	getLiveSessionForWorker,
	getRetainedSessionForWorker,
}));
vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	getActiveWorkerClaims,
	getWorkerDispatchClaimState,
}));

import type { SwarmUser } from '@/identity/schema.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';
import type { WorkerEnrollment } from '@/identity/worker-enrollment.js';
import {
	AllowedClisNotCapableError,
	approveEnrollment,
	DEFAULT_CONCURRENCY_ALLOCATION,
	DEFAULT_ENROLLMENT_ALLOWED_PHASES,
	deriveWorkerRunState,
	enrollWorker,
	getDashboardWorkerDetail,
	listDashboardWorkers,
	listOwnerWorkers,
	listProjectRoster,
	setSharingConsent,
	updateEnrollmentConstraints,
} from '@/identity/worker-enrollment-service.js';
import { ALL_TRIGGER_PHASES } from '@/triggers/types.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const ENROLLMENT_ID = '44444444-4444-4444-8444-444444444444';

function makeWorker(overrides: Partial<Worker> = {}): Worker {
	return {
		id: WORKER_ID,
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude', 'codex'],
		supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

function makeOwner(overrides: Partial<SwarmUser> = {}): SwarmUser {
	return {
		id: OWNER_ID,
		identifier: 'ada@example.com',
		displayName: 'Ada Lovelace',
		instanceAdmin: false,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

function makeEnrollment(overrides: Partial<WorkerEnrollment> = {}): WorkerEnrollment {
	return {
		id: ENROLLMENT_ID,
		workerId: WORKER_ID,
		projectId: 'proj-a',
		status: 'active',
		allowedClis: ['claude'],
		allowedPhases: [...ALL_TRIGGER_PHASES],
		concurrencyAllocation: 1,
		sharingConsent: true,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

beforeEach(() => {
	for (const m of [
		createEnrollment,
		getEnrollmentById,
		listEnrollmentsForProject,
		listEnrollmentsForWorker,
		setEnrollmentSharingConsent,
		updateEnrollmentConstraintsRow,
		updateEnrollmentStatus,
		getWorkerById,
		listAllWorkers,
		listWorkersForOwner,
		getUserById,
		getRunByIdFromDb,
		getWorkerDispatchClaimState,
		getActiveWorkerClaims,
		getLiveSessionForWorker,
		getRetainedSessionForWorker,
	]) {
		m.mockReset();
	}
	getWorkerDispatchClaimState.mockResolvedValue({ activeRuns: 0, currentRunId: null });
	getActiveWorkerClaims.mockResolvedValue([]);
});

describe('deriveWorkerRunState (busy/current-run from run lifecycle)', () => {
	it('is idle when the worker has no live session', async () => {
		getLiveSessionForWorker.mockResolvedValue(undefined);
		expect(await deriveWorkerRunState(WORKER_ID)).toEqual({ busy: false, currentRunId: null });
		expect(getRunByIdFromDb).not.toHaveBeenCalled();
	});

	it('is idle when the live session has no current run', async () => {
		getLiveSessionForWorker.mockResolvedValue({ currentRunId: null });
		expect(await deriveWorkerRunState(WORKER_ID)).toEqual({ busy: false, currentRunId: null });
		expect(getRunByIdFromDb).not.toHaveBeenCalled();
	});

	it('is busy when the live session points at a running run', async () => {
		getLiveSessionForWorker.mockResolvedValue({ currentRunId: RUN_ID });
		getRunByIdFromDb.mockResolvedValue({ id: RUN_ID, status: 'running' });
		expect(await deriveWorkerRunState(WORKER_ID)).toEqual({ busy: true, currentRunId: RUN_ID });
	});

	it('is idle when the pointed-at run is no longer running (stale pointer)', async () => {
		getLiveSessionForWorker.mockResolvedValue({ currentRunId: RUN_ID });
		getRunByIdFromDb.mockResolvedValue({ id: RUN_ID, status: 'completed' });
		expect(await deriveWorkerRunState(WORKER_ID)).toEqual({ busy: false, currentRunId: null });
	});

	it('is idle when the pointed-at run no longer exists', async () => {
		getLiveSessionForWorker.mockResolvedValue({ currentRunId: RUN_ID });
		getRunByIdFromDb.mockResolvedValue(undefined);
		expect(await deriveWorkerRunState(WORKER_ID)).toEqual({ busy: false, currentRunId: null });
	});
});

describe('listProjectRoster', () => {
	it('assembles a secret-free entry with owner, capabilities, constraints, isRoutable and run state', async () => {
		listEnrollmentsForProject.mockResolvedValue([
			makeEnrollment({ status: 'active', sharingConsent: true }),
		]);
		getWorkerById.mockResolvedValue(makeWorker());
		getUserById.mockResolvedValue(makeOwner());
		getLiveSessionForWorker.mockResolvedValue({ currentRunId: RUN_ID });
		getRunByIdFromDb.mockResolvedValue({ id: RUN_ID, status: 'running' });

		const [entry] = await listProjectRoster('proj-a');

		// Exactly the intended fields — no repo path, PAT, token, or credential hash
		// can ride along, because the assembler names each field explicitly.
		expect(Object.keys(entry).sort()).toEqual(
			[
				'allowedClis',
				'allowedPhases',
				'capabilities',
				'concurrencyAllocation',
				'displayName',
				'enrollmentId',
				'isRoutable',
				'owner',
				'projectId',
				'runState',
				'sharingConsent',
				'status',
				'workerId',
			].sort(),
		);
		expect(Object.keys(entry.owner ?? {}).sort()).toEqual(['displayName', 'identifier', 'userId']);
		expect(entry).toMatchObject({
			workerId: WORKER_ID,
			displayName: 'ada-laptop',
			capabilities: ['claude', 'codex'],
			status: 'active',
			allowedClis: ['claude'],
			sharingConsent: true,
			isRoutable: true,
			runState: { busy: true, currentRunId: RUN_ID },
		});
		expect(JSON.stringify(entry)).not.toMatch(/credential|password|token|repoRoot|worktree/i);
	});

	it('reports isRoutable false for a consent-revoked enrollment', async () => {
		listEnrollmentsForProject.mockResolvedValue([
			makeEnrollment({ status: 'active', sharingConsent: false }),
		]);
		getWorkerById.mockResolvedValue(makeWorker());
		getUserById.mockResolvedValue(makeOwner());
		getLiveSessionForWorker.mockResolvedValue(undefined);

		const [entry] = await listProjectRoster('proj-a');
		expect(entry.isRoutable).toBe(false);
	});

	it('skips an enrollment whose worker has vanished', async () => {
		listEnrollmentsForProject.mockResolvedValue([makeEnrollment()]);
		getWorkerById.mockResolvedValue(undefined);

		expect(await listProjectRoster('proj-a')).toEqual([]);
	});
});

describe('listOwnerWorkers', () => {
	it('returns only the owner’s own workers, each with its enrollments and run state', async () => {
		listWorkersForOwner.mockResolvedValue([makeWorker()]);
		listEnrollmentsForWorker.mockResolvedValue([
			makeEnrollment({ projectId: 'proj-a' }),
			makeEnrollment({ id: 'e2', projectId: 'proj-b', status: 'pending', sharingConsent: false }),
		]);
		getLiveSessionForWorker.mockResolvedValue(undefined);

		const views = await listOwnerWorkers(OWNER_ID);

		expect(listWorkersForOwner).toHaveBeenCalledWith(OWNER_ID);
		expect(views).toHaveLength(1);
		expect(views[0]).toMatchObject({
			workerId: WORKER_ID,
			displayName: 'ada-laptop',
			runState: { busy: false, currentRunId: null },
		});
		expect(views[0].enrollments.map((e) => e.projectId)).toEqual(['proj-a', 'proj-b']);
		// The owner view carries no owner/worker secret and no derived-from-elsewhere leaks.
		expect(JSON.stringify(views)).not.toMatch(/credential|password|token|repoRoot/i);
	});

	it('returns nothing for an owner with no workers', async () => {
		listWorkersForOwner.mockResolvedValue([]);
		expect(await listOwnerWorkers(OWNER_ID)).toEqual([]);
	});
});

describe('listDashboardWorkers (issue #133)', () => {
	const OTHER_WORKER_ID = '55555555-5555-4555-8555-555555555555';

	/** A live session heartbeating now — the online case. */
	function liveSession(currentRunId: string | null = null) {
		return { currentRunId, lastHeartbeatAt: new Date('2026-07-01T12:00:00Z') };
	}

	/**
	 * A `running` run row as `getRunByIdFromDb` returns it, carrying the work-item
	 * fields the Active job description is assembled from (issue #473).
	 */
	function runningRun(overrides: Record<string, unknown> = {}) {
		return {
			id: RUN_ID,
			status: 'running',
			projectId: 'proj-a',
			taskId: '42',
			phase: 'implementation',
			workItemId: 'I_kwitem',
			workItemTitle: 'Teach the dispatcher to count',
			workItemUrl: 'https://github.com/acme/widgets/issues/42',
			prNumber: null,
			prTitle: null,
			...overrides,
		};
	}

	describe('connectivity and last-seen', () => {
		it('reports a worker with a live session online, with its live heartbeat as last seen', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(liveSession());

			const [view] = await listDashboardWorkers(null);

			expect(view.connection).toBe('online');
			expect(view.lastSeenAt).toEqual(new Date('2026-07-01T12:00:00Z'));
			// A live session already carries the freshest heartbeat.
			expect(getRetainedSessionForWorker).not.toHaveBeenCalled();
		});

		it('reports an expired/released worker offline but keeps its retained last heartbeat', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(undefined);
			getRetainedSessionForWorker.mockResolvedValue({
				currentRunId: RUN_ID,
				lastHeartbeatAt: new Date('2026-06-30T09:00:00Z'),
			});

			const [view] = await listDashboardWorkers(null);

			expect(view.connection).toBe('offline');
			expect(view.lastSeenAt).toEqual(new Date('2026-06-30T09:00:00Z'));
			// An offline worker is running nothing, whatever its stale row still points at.
			expect(view.currentRun).toBeNull();
			expect(getRunByIdFromDb).not.toHaveBeenCalled();
		});

		it('reports a never-connected worker offline with no last-seen value', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(undefined);
			getRetainedSessionForWorker.mockResolvedValue(undefined);

			const [view] = await listDashboardWorkers(null);

			expect(view).toMatchObject({ connection: 'offline', lastSeenAt: null, currentRun: null });
		});
	});

	describe('active run', () => {
		it('describes the active job — not just its id — while that run is actually running', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(liveSession(RUN_ID));
			getRunByIdFromDb.mockResolvedValue(runningRun());

			const [view] = await listDashboardWorkers(null);
			// The Workers screen renders the same work-item description `/runs` does
			// (issue #473), so the read model carries the run's task fields.
			expect(view.currentRun).toEqual({
				runId: RUN_ID,
				projectId: 'proj-a',
				taskId: '42',
				phase: 'implementation',
				workItemId: 'I_kwitem',
				workItemTitle: 'Teach the dispatcher to count',
				workItemUrl: 'https://github.com/acme/widgets/issues/42',
				prNumber: null,
				prTitle: null,
			});
		});

		it('carries nothing beyond the job description — no payload, error, or usage from the run row', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(liveSession(RUN_ID));
			getRunByIdFromDb.mockResolvedValue({
				...runningRun(),
				jobPayload: { credentials: { reviewer: 'ghp_secret' } },
				error: 'boom',
				usage: { inputTokens: 1 },
			});

			const [view] = await listDashboardWorkers(null);

			expect(Object.keys(view.currentRun ?? {}).sort()).toEqual(
				[
					'phase',
					'prNumber',
					'prTitle',
					'projectId',
					'runId',
					'taskId',
					'workItemId',
					'workItemTitle',
					'workItemUrl',
				].sort(),
			);
			expect(JSON.stringify(view.currentRun)).not.toMatch(/ghp_secret|boom|inputTokens/);
		});

		it('reads a stale pointer to a completed run as idle', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(liveSession(RUN_ID));
			getRunByIdFromDb.mockResolvedValue(runningRun({ status: 'completed' }));

			const [view] = await listDashboardWorkers(null);
			expect(view.currentRun).toBeNull();
		});

		it('derives candidate current run from active, unexpired durable dispatch claims when currentRunId is null', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(liveSession(null));
			getActiveWorkerClaims.mockResolvedValue([{ runId: RUN_ID, projectId: 'proj-a' }]);
			getRunByIdFromDb.mockResolvedValue(runningRun());

			const [view] = await listDashboardWorkers(null);
			expect(view.currentRun?.runId).toBe(RUN_ID);
			expect(getActiveWorkerClaims).toHaveBeenCalledWith(WORKER_ID);
		});

		it('withholds the claim run id if the run is not running', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(liveSession(null));
			getActiveWorkerClaims.mockResolvedValue([{ runId: RUN_ID, projectId: 'proj-a' }]);
			getRunByIdFromDb.mockResolvedValue(runningRun({ status: 'completed' }));

			const [view] = await listDashboardWorkers(null);
			expect(view.currentRun).toBeNull();
		});

		it('withholds the claim run id if its project is outside the accessible scope for a restricted viewer', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([
				makeEnrollment({ projectId: 'proj-a' }),
				makeEnrollment({ id: 'e2', projectId: 'proj-secret' }),
			]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(liveSession(null));
			getActiveWorkerClaims.mockResolvedValue([{ runId: RUN_ID, projectId: 'proj-secret' }]);
			getRunByIdFromDb.mockResolvedValue(runningRun({ projectId: 'proj-secret' }));

			const [view] = await listDashboardWorkers(['proj-a']);
			expect(view.currentRun).toBeNull();
		});

		it('chooses only the claim/run whose project is in the accessible scope when the worker has concurrent work', async () => {
			const OTHER_RUN_ID = '66666666-6666-4666-8666-666666666666';
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([
				makeEnrollment({ projectId: 'proj-a' }),
				makeEnrollment({ id: 'e2', projectId: 'proj-secret' }),
			]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(liveSession(null));
			getActiveWorkerClaims.mockResolvedValue([
				{ runId: RUN_ID, projectId: 'proj-secret' },
				{ runId: OTHER_RUN_ID, projectId: 'proj-a' },
			]);
			getRunByIdFromDb.mockImplementation(async (id: string) => {
				if (id === RUN_ID) return runningRun({ projectId: 'proj-secret' });
				if (id === OTHER_RUN_ID) return runningRun({ id: OTHER_RUN_ID });
				return null;
			});

			const [view] = await listDashboardWorkers(['proj-a']);
			expect(view.currentRun?.runId).toBe(OTHER_RUN_ID);
		});

		it('falls back to the legacy session pointer if there are no active claims', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(liveSession(RUN_ID));
			getActiveWorkerClaims.mockResolvedValue([]);
			getRunByIdFromDb.mockResolvedValue(runningRun());

			const [view] = await listDashboardWorkers(null);
			expect(view.currentRun?.runId).toBe(RUN_ID);
		});
	});

	describe('declared capabilities', () => {
		it('reports the phase repertoire the daemon declared, so the screen can say a machine refuses Planning', async () => {
			// What a DB-free remote daemon declares (`SUPPORTED_DB_FREE_PHASES`): every
			// CLI, no `planning`. The dispatch gate reads the same field (issue #467).
			listAllWorkers.mockResolvedValue([
				makeWorker({ supportedPhases: ['implementation', 'review', 'respond-to-review'] }),
			]);
			listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(undefined);
			getRetainedSessionForWorker.mockResolvedValue(undefined);

			const [view] = await listDashboardWorkers(null);

			expect(view.supportedPhases).toEqual(['implementation', 'review', 'respond-to-review']);
			expect(view.capabilities).toEqual(['claude', 'codex']);
		});
	});

	describe('authorization scope', () => {
		it('gives an administrator every registered worker, including an un-enrolled one', async () => {
			listAllWorkers.mockResolvedValue([
				makeWorker(),
				makeWorker({ id: OTHER_WORKER_ID, displayName: 'unenrolled-box' }),
			]);
			listEnrollmentsForWorker.mockImplementation(async (workerId: string) =>
				workerId === WORKER_ID ? [makeEnrollment({ projectId: 'proj-a' })] : [],
			);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(undefined);
			getRetainedSessionForWorker.mockResolvedValue(undefined);

			const views = await listDashboardWorkers(null);

			expect(views.map((v) => v.displayName)).toEqual(['ada-laptop', 'unenrolled-box']);
			expect(views[1].enrollments).toEqual([]);
		});

		it('hides a worker an ordinary viewer shares no accessible project with', async () => {
			listAllWorkers.mockResolvedValue([
				makeWorker(),
				makeWorker({ id: OTHER_WORKER_ID, displayName: 'stranger-box' }),
			]);
			listEnrollmentsForWorker.mockImplementation(async (workerId: string) =>
				workerId === WORKER_ID
					? [makeEnrollment({ projectId: 'proj-a' })]
					: [makeEnrollment({ id: 'e-other', projectId: 'proj-secret' })],
			);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(undefined);
			getRetainedSessionForWorker.mockResolvedValue(undefined);

			const views = await listDashboardWorkers(['proj-a']);

			expect(views.map((v) => v.displayName)).toEqual(['ada-laptop']);
		});

		it('lists a worker enrolled in several visible projects once, showing both enrollments', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([
				makeEnrollment({ projectId: 'proj-a', status: 'active' }),
				makeEnrollment({ id: 'e2', projectId: 'proj-b', status: 'pending' }),
			]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(undefined);
			getRetainedSessionForWorker.mockResolvedValue(undefined);

			const views = await listDashboardWorkers(['proj-a', 'proj-b']);

			expect(views).toHaveLength(1);
			expect(views[0].enrollments).toEqual([
				{ projectId: 'proj-a', status: 'active', allowedClis: ['claude'] },
				{ projectId: 'proj-b', status: 'pending', allowedClis: ['claude'] },
			]);
		});

		it('strips an inaccessible project’s enrollment from a visible worker’s row', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([
				makeEnrollment({ projectId: 'proj-a' }),
				makeEnrollment({ id: 'e2', projectId: 'proj-secret', status: 'suspended' }),
			]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(undefined);
			getRetainedSessionForWorker.mockResolvedValue(undefined);

			const [view] = await listDashboardWorkers(['proj-a']);

			expect(view.enrollments).toEqual([
				{ projectId: 'proj-a', status: 'active', allowedClis: ['claude'] },
			]);
		});

		it('withholds an in-flight run belonging to a project outside the viewer’s scope', async () => {
			listAllWorkers.mockResolvedValue([makeWorker()]);
			listEnrollmentsForWorker.mockResolvedValue([
				makeEnrollment({ projectId: 'proj-a' }),
				makeEnrollment({ id: 'e2', projectId: 'proj-secret' }),
			]);
			getUserById.mockResolvedValue(makeOwner());
			getLiveSessionForWorker.mockResolvedValue(liveSession(RUN_ID));
			getRunByIdFromDb.mockResolvedValue(runningRun({ projectId: 'proj-secret' }));

			const [view] = await listDashboardWorkers(['proj-a']);

			// The worker is visible (shared project) but its job is not.
			expect(view.connection).toBe('online');
			expect(view.currentRun).toBeNull();
		});

		it('returns nothing — and reads no workers — for a viewer with no accessible project', async () => {
			expect(await listDashboardWorkers([])).toEqual([]);
			expect(listAllWorkers).not.toHaveBeenCalled();
		});
	});

	it('exposes exactly the roster fields — no credential, path, constraint, or approval control', async () => {
		listAllWorkers.mockResolvedValue([makeWorker()]);
		listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);
		getUserById.mockResolvedValue(makeOwner());
		getLiveSessionForWorker.mockResolvedValue(liveSession(RUN_ID));
		getRunByIdFromDb.mockResolvedValue(runningRun());

		const [view] = await listDashboardWorkers(null);

		expect(Object.keys(view).sort()).toEqual(
			[
				'capabilities',
				'connection',
				'currentRun',
				'displayName',
				'enrollments',
				'lastSeenAt',
				'owner',
				'supportedPhases',
				'workerId',
			].sort(),
		);
		expect(Object.keys(view.owner ?? {}).sort()).toEqual(['displayName', 'identifier', 'userId']);
		// Enrollment summaries carry approval state plus the effective allowed CLIs
		// (for the roster's Capabilities column) — no consent/concurrency knob the
		// screen could turn into a control.
		expect(Object.keys(view.enrollments[0]).sort()).toEqual(
			['allowedClis', 'projectId', 'status'].sort(),
		);
		expect(JSON.stringify(view)).not.toMatch(/credential|password|token|repoRoot|worktree/i);
	});
});

describe('enrollWorker', () => {
	it('rejects allowed CLIs that exceed the worker’s capabilities', async () => {
		const worker = makeWorker({ capabilities: ['claude'] });

		await expect(
			enrollWorker({ worker, projectId: 'proj-a', allowedClis: ['claude', 'codex'] }),
		).rejects.toBeInstanceOf(AllowedClisNotCapableError);
		expect(createEnrollment).not.toHaveBeenCalled();
	});

	it('de-dupes allowed CLIs, defaults status pending / consent off / allocation 1', async () => {
		const worker = makeWorker({ capabilities: ['claude', 'codex'] });
		createEnrollment.mockImplementation(async (input) => makeEnrollment(input));

		await enrollWorker({ worker, projectId: 'proj-a', allowedClis: ['claude', 'claude'] });

		expect(createEnrollment).toHaveBeenCalledWith({
			workerId: WORKER_ID,
			projectId: 'proj-a',
			status: 'pending',
			allowedClis: ['claude'],
			// Issue #509: an omitted phase selection constrains nothing on its own — the
			// machine's declaration and the project's own toggles still apply.
			allowedPhases: [...DEFAULT_ENROLLMENT_ALLOWED_PHASES],
			// Issue #480: an omitted allocation is the safe value, not "uncapped".
			concurrencyAllocation: DEFAULT_CONCURRENCY_ALLOCATION,
			sharingConsent: false,
		});
		expect(DEFAULT_CONCURRENCY_ALLOCATION).toBe(1);
	});

	it('passes through an explicit status, consent, and concurrency', async () => {
		const worker = makeWorker();
		createEnrollment.mockImplementation(async (input) => makeEnrollment(input));

		await enrollWorker({
			worker,
			projectId: 'proj-a',
			allowedClis: ['claude'],
			concurrencyAllocation: 4,
			status: 'active',
			sharingConsent: true,
		});

		expect(createEnrollment).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'active', sharingConsent: true, concurrencyAllocation: 4 }),
		);
	});

	it('rejects a non-positive concurrency allocation', async () => {
		const worker = makeWorker();
		await expect(
			enrollWorker({
				worker,
				projectId: 'proj-a',
				allowedClis: ['claude'],
				concurrencyAllocation: 0,
			}),
		).rejects.toThrow();
		expect(createEnrollment).not.toHaveBeenCalled();
	});

	it('de-dupes an explicit phase selection and stores it as given (issue #509)', async () => {
		const worker = makeWorker();
		createEnrollment.mockImplementation(async (input) => makeEnrollment(input));

		await enrollWorker({
			worker,
			projectId: 'proj-a',
			allowedClis: ['claude'],
			allowedPhases: ['implementation', 'implementation', 'review'],
		});

		expect(createEnrollment).toHaveBeenCalledWith(
			expect.objectContaining({ allowedPhases: ['implementation', 'review'] }),
		);
	});

	it('rejects an empty phase selection — that is a suspension, not a constraint', async () => {
		const worker = makeWorker();
		await expect(
			enrollWorker({ worker, projectId: 'proj-a', allowedClis: ['claude'], allowedPhases: [] }),
		).rejects.toThrow();
		expect(createEnrollment).not.toHaveBeenCalled();
	});

	// Deliberately unlike the CLI rule: the daemon rewrites its declared repertoire on
	// every reconnect, so containment can't be an invariant, and the eligibility
	// predicate ANDs the two sets instead.
	it('does not require the phase selection to be within the machine’s declared repertoire', async () => {
		const worker = makeWorker({ supportedPhases: ['implementation'] });
		createEnrollment.mockImplementation(async (input) => makeEnrollment(input));

		await enrollWorker({
			worker,
			projectId: 'proj-a',
			allowedClis: ['claude'],
			allowedPhases: ['planning'],
		});

		expect(createEnrollment).toHaveBeenCalledWith(
			expect.objectContaining({ allowedPhases: ['planning'] }),
		);
	});

	// Issue #542: `planning` is an ordinary phase. Nothing about who owns the machine
	// is read when an enrollment's phase selection is decided — the enrollment itself
	// is the authorization, and the owner's installation role is not part of it.
	describe('planning is an ordinary phase (issue #542)', () => {
		it('keeps planning in the default phase set for a non-instance-admin owner', async () => {
			const worker = makeWorker();
			createEnrollment.mockImplementation(async (input) => makeEnrollment(input));
			getUserById.mockResolvedValue(makeOwner({ instanceAdmin: false }));

			await enrollWorker({ worker, projectId: 'proj-a', allowedClis: ['claude'] });

			const [[created]] = createEnrollment.mock.calls;
			expect(created.allowedPhases).toEqual([...DEFAULT_ENROLLMENT_ALLOWED_PHASES]);
			expect(created.allowedPhases).toContain('planning');
		});

		it('accepts an explicit planning selection for a non-instance-admin owner', async () => {
			const worker = makeWorker();
			createEnrollment.mockImplementation(async (input) => makeEnrollment(input));
			getUserById.mockResolvedValue(makeOwner({ instanceAdmin: false }));

			await enrollWorker({
				worker,
				projectId: 'proj-a',
				allowedClis: ['claude'],
				allowedPhases: ['planning', 'implementation'],
			});

			expect(createEnrollment).toHaveBeenCalledWith(
				expect.objectContaining({ allowedPhases: ['planning', 'implementation'] }),
			);
		});

		it('does not read the owner at all when planning is selected', async () => {
			const worker = makeWorker();
			createEnrollment.mockImplementation(async (input) => makeEnrollment(input));

			await enrollWorker({
				worker,
				projectId: 'proj-a',
				allowedClis: ['claude'],
				allowedPhases: ['planning'],
			});

			expect(getUserById).not.toHaveBeenCalled();
		});
	});
});

describe('updateEnrollmentConstraints', () => {
	it('re-validates an allowedClis change against the worker’s capabilities', async () => {
		const worker = makeWorker({ capabilities: ['claude'] });
		await expect(
			updateEnrollmentConstraints({ worker, enrollmentId: ENROLLMENT_ID, allowedClis: ['codex'] }),
		).rejects.toBeInstanceOf(AllowedClisNotCapableError);
		expect(updateEnrollmentConstraintsRow).not.toHaveBeenCalled();
	});

	it('passes a validated patch through to the repository', async () => {
		const worker = makeWorker({ capabilities: ['claude', 'codex'] });
		updateEnrollmentConstraintsRow.mockResolvedValue(makeEnrollment());

		await updateEnrollmentConstraints({
			worker,
			enrollmentId: ENROLLMENT_ID,
			allowedClis: ['codex', 'codex'],
			concurrencyAllocation: 3,
		});

		expect(updateEnrollmentConstraintsRow).toHaveBeenCalledWith(ENROLLMENT_ID, {
			allowedClis: ['codex'],
			concurrencyAllocation: 3,
		});
	});

	it('rejects a non-positive allocation instead of storing it (issue #480)', async () => {
		// There is no "clear the allocation" value any more: an enrollment always
		// states its share of the project, so 0 is a validation error rather than a
		// route to the old unbounded state.
		const worker = makeWorker();
		await expect(
			updateEnrollmentConstraints({
				worker,
				enrollmentId: ENROLLMENT_ID,
				concurrencyAllocation: 0,
			}),
		).rejects.toThrow();
		expect(updateEnrollmentConstraintsRow).not.toHaveBeenCalled();
	});

	it('omits an unspecified allocation from the patch (leaves it unchanged)', async () => {
		const worker = makeWorker();
		updateEnrollmentConstraintsRow.mockResolvedValue(makeEnrollment());

		await updateEnrollmentConstraints({
			worker,
			enrollmentId: ENROLLMENT_ID,
			allowedClis: ['claude'],
		});

		expect(updateEnrollmentConstraintsRow).toHaveBeenCalledWith(ENROLLMENT_ID, {
			allowedClis: ['claude'],
		});
	});

	it('patches only the phase selection when that is all that changed (issue #509)', async () => {
		const worker = makeWorker();
		updateEnrollmentConstraintsRow.mockResolvedValue(makeEnrollment());

		await updateEnrollmentConstraints({
			worker,
			enrollmentId: ENROLLMENT_ID,
			allowedPhases: ['review', 'review', 'implementation'],
		});

		expect(updateEnrollmentConstraintsRow).toHaveBeenCalledWith(ENROLLMENT_ID, {
			allowedPhases: ['review', 'implementation'],
		});
	});

	it('rejects an empty phase selection instead of storing it', async () => {
		const worker = makeWorker();
		await expect(
			updateEnrollmentConstraints({ worker, enrollmentId: ENROLLMENT_ID, allowedPhases: [] }),
		).rejects.toThrow();
		expect(updateEnrollmentConstraintsRow).not.toHaveBeenCalled();
	});

	// Issue #542: adding `planning` is the owner's own routing choice, exactly like
	// adding any other phase — the owner's installation role is never consulted.
	it('allows adding planning for a non-instance-admin owner (issue #542)', async () => {
		const worker = makeWorker();
		updateEnrollmentConstraintsRow.mockResolvedValue(makeEnrollment());
		getUserById.mockResolvedValue(makeOwner({ instanceAdmin: false }));

		await updateEnrollmentConstraints({
			worker,
			enrollmentId: ENROLLMENT_ID,
			allowedPhases: ['planning', 'implementation'],
		});

		expect(updateEnrollmentConstraintsRow).toHaveBeenCalledWith(ENROLLMENT_ID, {
			allowedPhases: ['planning', 'implementation'],
		});
		expect(getUserById).not.toHaveBeenCalled();
	});
});

describe('status / consent write delegation', () => {
	it('approveEnrollment sets the status active', async () => {
		updateEnrollmentStatus.mockResolvedValue(makeEnrollment({ status: 'active' }));
		await approveEnrollment(ENROLLMENT_ID);
		expect(updateEnrollmentStatus).toHaveBeenCalledWith(ENROLLMENT_ID, 'active');
	});

	it('setSharingConsent delegates the boolean to the repository', async () => {
		setEnrollmentSharingConsent.mockResolvedValue(makeEnrollment({ sharingConsent: false }));
		await setSharingConsent(ENROLLMENT_ID, false);
		expect(setEnrollmentSharingConsent).toHaveBeenCalledWith(ENROLLMENT_ID, false);
	});
});

describe('getDashboardWorkerDetail (issue #477)', () => {
	beforeEach(() => {
		getLiveSessionForWorker.mockResolvedValue(undefined);
		getRetainedSessionForWorker.mockResolvedValue(undefined);
		getUserById.mockResolvedValue(makeOwner());
	});

	it('carries the full enrollment detail per project, not just project + status', async () => {
		getWorkerById.mockResolvedValue(makeWorker());
		listEnrollmentsForWorker.mockResolvedValue([
			makeEnrollment({ allowedClis: ['claude'], concurrencyAllocation: 2, sharingConsent: true }),
		]);

		const detail = await getDashboardWorkerDetail(WORKER_ID, null);

		expect(detail?.enrollments).toEqual([
			{
				enrollmentId: ENROLLMENT_ID,
				projectId: 'proj-a',
				status: 'active',
				allowedClis: ['claude'],
				allowedPhases: [...ALL_TRIGGER_PHASES],
				concurrencyAllocation: 2,
				sharingConsent: true,
				isRoutable: true,
			},
		]);
		// The roster row's own fields come along unchanged, so the detail view needs
		// no second query for identity, connectivity, or the capability axes.
		expect(detail?.displayName).toBe('ada-laptop');
		expect(detail?.connection).toBe('offline');
		expect(detail?.capabilities).toEqual(['claude', 'codex']);
		expect(detail?.supportedPhases.length).toBeGreaterThan(0);
		expect(detail?.ownerUserId).toBe(OWNER_ID);
	});

	it('reports an unapproved or unshared enrollment as not routable', async () => {
		getWorkerById.mockResolvedValue(makeWorker());
		listEnrollmentsForWorker.mockResolvedValue([
			makeEnrollment({ status: 'pending', sharingConsent: true }),
			makeEnrollment({ id: 'e2', projectId: 'proj-b', status: 'active', sharingConsent: false }),
		]);

		const detail = await getDashboardWorkerDetail(WORKER_ID, null);

		expect(detail?.enrollments.map((e) => e.isRoutable)).toEqual([false, false]);
	});

	it('strips enrollments in projects a restricted viewer may not access', async () => {
		getWorkerById.mockResolvedValue(makeWorker());
		listEnrollmentsForWorker.mockResolvedValue([
			makeEnrollment({ projectId: 'proj-a' }),
			makeEnrollment({ id: 'e2', projectId: 'proj-secret' }),
		]);

		const detail = await getDashboardWorkerDetail(WORKER_ID, ['proj-a']);

		expect(detail?.enrollments.map((e) => e.projectId)).toEqual(['proj-a']);
	});

	it('hides a worker a restricted viewer shares no project with', async () => {
		getWorkerById.mockResolvedValue(makeWorker());
		listEnrollmentsForWorker.mockResolvedValue([makeEnrollment({ projectId: 'proj-secret' })]);

		expect(await getDashboardWorkerDetail(WORKER_ID, ['proj-a'])).toBeNull();
	});

	it('shows an administrator a registered-but-un-enrolled machine', async () => {
		getWorkerById.mockResolvedValue(makeWorker());
		listEnrollmentsForWorker.mockResolvedValue([]);

		const detail = await getDashboardWorkerDetail(WORKER_ID, null);

		expect(detail?.enrollments).toEqual([]);
	});

	it('is null for an unknown worker and for a viewer with no accessible project', async () => {
		getWorkerById.mockResolvedValue(undefined);
		expect(await getDashboardWorkerDetail(WORKER_ID, null)).toBeNull();

		getWorkerById.mockResolvedValue(makeWorker());
		expect(await getDashboardWorkerDetail(WORKER_ID, [])).toBeNull();
		// A viewer with no accessible project is answered without a worker read at all.
		expect(getWorkerById).toHaveBeenCalledTimes(1);
	});

	it('leaks no secret from the worker, owner, or enrollment rows', async () => {
		getWorkerById.mockResolvedValue(makeWorker());
		listEnrollmentsForWorker.mockResolvedValue([makeEnrollment()]);

		const detail = await getDashboardWorkerDetail(WORKER_ID, null);

		expect(JSON.stringify(detail)).not.toMatch(/credential|password|token|repoRoot/i);
	});
});
