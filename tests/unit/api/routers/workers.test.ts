import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	AllowedClisNotCapableError,
	approveEnrollment,
	deriveWorkerRunState,
	enrollWorker,
	EnrollmentRepositoryMismatchError,
	getDashboardWorkerDetail,
	getEnrollment,
	listDashboardWorkers,
	listOwnerWorkers,
	listProjectRoster,
	listProjectWorkerIdsInOrder,
	moveProjectWorkerOrder,
	setEnrollmentStatus,
	setSharingConsent,
	updateEnrollmentConstraints,
} = vi.hoisted(() => {
	class AllowedClisNotCapableError extends Error {
		constructor(
			public workerId: string,
			public offending: string[],
		) {
			super(`not capable: ${offending.join(', ')}`);
			this.name = 'AllowedClisNotCapableError';
		}
	}
	class EnrollmentRepositoryMismatchError extends Error {
		constructor(
			public workerId: string,
			public declaredRepository: string,
			public projectRepository: string,
		) {
			super(`checkout is ${declaredRepository}, project is ${projectRepository}`);
			this.name = 'EnrollmentRepositoryMismatchError';
		}
	}
	return {
		AllowedClisNotCapableError,
		EnrollmentRepositoryMismatchError,
		approveEnrollment: vi.fn(),
		deriveWorkerRunState: vi.fn(),
		enrollWorker: vi.fn(),
		getDashboardWorkerDetail: vi.fn(),
		getEnrollment: vi.fn(),
		listDashboardWorkers: vi.fn(),
		listOwnerWorkers: vi.fn(),
		listProjectRoster: vi.fn(),
		listProjectWorkerIdsInOrder: vi.fn(),
		moveProjectWorkerOrder: vi.fn(),
		setEnrollmentStatus: vi.fn(),
		setSharingConsent: vi.fn(),
		updateEnrollmentConstraints: vi.fn(),
	};
});
const { declareWorkerCapabilities, getWorker, registerWorker, renameWorker } = vi.hoisted(() => ({
	declareWorkerCapabilities: vi.fn(),
	getWorker: vi.fn(),
	registerWorker: vi.fn(),
	renameWorker: vi.fn(),
}));
const { removeWorker } = vi.hoisted(() => ({ removeWorker: vi.fn() }));
const { getMembership, listAccessibleProjectIds } = vi.hoisted(() => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));
// Issue #799 — `register` resolves its owner and `projectScmProvider` its project
// and that project's SCM provider.
const { findUserByIdentifier } = vi.hoisted(() => ({ findUserByIdentifier: vi.fn() }));
const { findProjectByIdFromDb } = vi.hoisted(() => ({ findProjectByIdFromDb: vi.fn() }));
const { requireProjectSCMProviderId } = vi.hoisted(() => ({
	requireProjectSCMProviderId: vi.fn(),
}));

vi.mock('@/identity/worker-enrollment-service.js', async () => ({
	AllowedClisNotCapableError,
	approveEnrollment,
	deriveWorkerRunState,
	enrollWorker,
	EnrollmentRepositoryMismatchError,
	getDashboardWorkerDetail,
	getEnrollment,
	listDashboardWorkers,
	listOwnerWorkers,
	listProjectRoster,
	listProjectWorkerIdsInOrder,
	moveProjectWorkerOrder,
	setEnrollmentStatus,
	setSharingConsent,
	updateEnrollmentConstraints,
	// The router validates the reorder direction with the domain's own enum, so the
	// mock re-exports the real schema rather than a stand-in that could drift from it.
	WorkerOrderDirectionSchema: (
		await vi.importActual<typeof import('@/identity/worker-enrollment.js')>(
			'@/identity/worker-enrollment.js',
		)
	).WorkerOrderDirectionSchema,
}));
vi.mock('@/identity/worker-service.js', () => ({
	declareWorkerCapabilities,
	getWorker,
	registerWorker,
	renameWorker,
}));
vi.mock('@/db/repositories/workersRepository.js', () => ({ removeWorker }));
vi.mock('@/identity/membership-service.js', () => ({ getMembership, listAccessibleProjectIds }));
vi.mock('@/db/repositories/usersRepository.js', () => ({ findUserByIdentifier }));
// Spread the real modules and override one export each: both are imported
// elsewhere in this router's module graph (`identity/worker-scm-credential.ts`
// reads `requireProjectSCMProviderId` and `findProjectByIdFromDb` too), so a
// factory returning only the stub would leave those imports undefined.
vi.mock('@/db/repositories/projectsRepository.js', async () => ({
	...(await vi.importActual<typeof import('@/db/repositories/projectsRepository.js')>(
		'@/db/repositories/projectsRepository.js',
	)),
	findProjectByIdFromDb,
}));
vi.mock('@/integrations/scm/registry.js', async () => ({
	...(await vi.importActual<typeof import('@/integrations/scm/registry.js')>(
		'@/integrations/scm/registry.js',
	)),
	requireProjectSCMProviderId,
}));

import { workersRouter } from '@/api/routers/workers.js';
import type { ProjectMembership, ProjectRole } from '@/identity/membership.js';
import type { SwarmUser } from '@/identity/schema.js';
import {
	DEFAULT_WORKER_SUPPORTED_PHASES,
	type Worker,
	WorkerCapabilityNotProbedError,
	WorkerCapabilityReductionError,
} from '@/identity/worker.js';
import type { WorkerEnrollment } from '@/identity/worker-enrollment.js';
import { ALL_TRIGGER_PHASES } from '@/triggers/types.js';

const OWNER_ID = '00000000-0000-4000-8000-0000000000aa';
const OTHER_ID = '00000000-0000-4000-8000-0000000000bb';
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const ENROLLMENT_ID = '44444444-4444-4444-8444-444444444444';

const OWNER_USER: SwarmUser = {
	id: OWNER_ID,
	identifier: 'ada@example.com',
	displayName: 'Ada',
	instanceAdmin: false,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const ADMIN_USER: SwarmUser = { ...OWNER_USER, id: OTHER_ID, instanceAdmin: true };

function makeWorker(overrides: Partial<Worker> = {}): Worker {
	const worker: Worker = {
		id: WORKER_ID,
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude', 'codex'],
		// No declaration (issue #783), so the probe is the effective set.
		probedCapabilities: ['claude'],
		declaredCapabilities: null,
		supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
		repository: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
	// Keep the two CLI fields in step when a test overrides only `capabilities`.
	return { ...worker, probedCapabilities: overrides.probedCapabilities ?? worker.capabilities };
}

function makeEnrollment(overrides: Partial<WorkerEnrollment> = {}): WorkerEnrollment {
	return {
		id: ENROLLMENT_ID,
		workerId: WORKER_ID,
		projectId: 'p1',
		status: 'pending',
		allowedClis: ['claude'],
		allowedPhases: [...ALL_TRIGGER_PHASES],
		concurrencyAllocation: 1,
		orderIndex: 0,
		sharingConsent: false,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

function membershipFor(role: ProjectRole, projectId = 'p1'): ProjectMembership {
	return { id: 'm1', projectId, userId: OWNER_ID, role, createdAt: new Date(0) };
}

const owner = workersRouter.createCaller({ user: OWNER_USER });

beforeEach(() => {
	for (const m of [
		approveEnrollment,
		enrollWorker,
		getDashboardWorkerDetail,
		getEnrollment,
		listDashboardWorkers,
		listOwnerWorkers,
		listProjectRoster,
		listProjectWorkerIdsInOrder,
		moveProjectWorkerOrder,
		setEnrollmentStatus,
		setSharingConsent,
		updateEnrollmentConstraints,
		deriveWorkerRunState,
		declareWorkerCapabilities,
		getWorker,
		registerWorker,
		renameWorker,
		removeWorker,
		getMembership,
		listAccessibleProjectIds,
		findUserByIdentifier,
		findProjectByIdFromDb,
		requireProjectSCMProviderId,
	]) {
		m.mockReset();
	}
	// Every project-scoped list read resolves the project's worker order (issue
	// #750); a suite that asserts on ordering states its own.
	listProjectWorkerIdsInOrder.mockResolvedValue([]);
	// An idle machine unless a case says otherwise — `workers.remove` reads this to
	// decide whether the machine is mid-run (issue #789).
	deriveWorkerRunState.mockResolvedValue({ busy: false, currentRunId: null });
	removeWorker.mockResolvedValue(true);
});

describe('workers.list (installation roster, issue #133)', () => {
	it('passes unrestricted scope for an instanceAdmin', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		listDashboardWorkers.mockResolvedValue([]);

		await admin.list();

		expect(listDashboardWorkers).toHaveBeenCalledWith(null);
		// Layer-1 override: an admin's scope never needs a membership lookup.
		expect(listAccessibleProjectIds).not.toHaveBeenCalled();
	});

	// issue #647 — the installation-wide roster is an operator's view of the whole
	// instance (it includes un-enrolled machines), so an ordinary worker owner is
	// denied it outright rather than served a membership-filtered subset. Their
	// project-scoped roster is the suite below.
	it('denies the installation-wide roster to an ordinary user, without querying', async () => {
		await expect(owner.list()).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
		expect(listDashboardWorkers).not.toHaveBeenCalled();
		// The gate is the installation role alone — no membership read at all.
		expect(listAccessibleProjectIds).not.toHaveBeenCalled();
	});

	it('serializes last-seen to an ISO string (and keeps null for a never-connected worker)', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		// Named `a`/`b` so the ordering the unscoped list applies (issue #808) leaves
		// them in this sequence — this test is about the timestamp, not the sort.
		listDashboardWorkers.mockResolvedValue([
			{ workerId: WORKER_ID, displayName: 'a', lastSeenAt: new Date('2026-07-01T12:00:00.000Z') },
			{ workerId: 'w2', displayName: 'b', lastSeenAt: null },
		]);

		const rows = await admin.list();

		expect(rows[0].lastSeenAt).toBe('2026-07-01T12:00:00.000Z');
		expect(rows[1].lastSeenAt).toBeNull();
	});
});

/**
 * A roster row as `listDashboardWorkers` returns it, reduced to the fields
 * ordering reads: the machine's own name and its owner identity. Both labels
 * default off the ids, so a test that only cares *whose* a machine is invents
 * nothing; `labels` overrides them where the alphabetical rules are the subject.
 */
function rosterRow(
	workerId: string,
	ownerUserId: string | null,
	labels: { name?: string; ownerName?: string; ownerIdentifier?: string } = {},
) {
	return {
		workerId,
		displayName: labels.name ?? workerId,
		lastSeenAt: null,
		owner: ownerUserId
			? {
					userId: ownerUserId,
					identifier: labels.ownerIdentifier ?? `${ownerUserId}@example.com`,
					displayName: labels.ownerName ?? ownerUserId,
				}
			: null,
	};
}

const THIRD_ID = '00000000-0000-4000-8000-0000000000cc';
const FOURTH_ID = '00000000-0000-4000-8000-0000000000dd';

describe('workers.list ordering — viewer first, then grouped by owner (issues #657, #808)', () => {
	it('lists the caller’s workers first, in the read model’s own order', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		// The viewer's two machines are deliberately *not* alphabetical: their group
		// keeps the order #657 shipped, which is the one an operator already knows.
		listDashboardWorkers.mockResolvedValue([
			rosterRow('other-1', OWNER_ID),
			rosterRow('mine-zulu', OTHER_ID),
			rosterRow('other-2', OWNER_ID),
			rosterRow('mine-alpha', OTHER_ID),
		]);

		const rows = await admin.list();

		expect(rows.map((row) => row.workerId)).toEqual([
			'mine-zulu',
			'mine-alpha',
			'other-1',
			'other-2',
		]);
	});

	// The point of issue #808: the remaining machines arrive interleaved in
	// registration order, and an operator scanning for one teammate's machines
	// should not have to read the whole roster to find them.
	it('groups every other owner’s machines contiguously, owners and machines alphabetical', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		listDashboardWorkers.mockResolvedValue([
			rosterRow('w1', THIRD_ID, { name: 'zeta', ownerName: 'Cleo' }),
			rosterRow('w2', OWNER_ID, { name: 'delta', ownerName: 'Ada' }),
			rosterRow('w3', THIRD_ID, { name: 'alpha', ownerName: 'Cleo' }),
			rosterRow('w4', FOURTH_ID, { name: 'omega', ownerName: 'Bram' }),
			rosterRow('w5', OWNER_ID, { name: 'beta', ownerName: 'Ada' }),
		]);

		const rows = await admin.list();

		expect(rows.map((row) => row.displayName)).toEqual([
			// Ada's, alphabetical …
			'beta',
			'delta',
			// … then Bram's …
			'omega',
			// … then Cleo's, also alphabetical.
			'alpha',
			'zeta',
		]);
	});

	// Display names are not unique; the identifier is, so a collision resolves to a
	// fixed order rather than to whichever machine happened to register first.
	it('breaks a shared owner display name on the owner’s unique identifier', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		listDashboardWorkers.mockResolvedValue([
			rosterRow('w1', THIRD_ID, { ownerName: 'Alex', ownerIdentifier: 'alex.zhu@example.com' }),
			rosterRow('w2', FOURTH_ID, { ownerName: 'Alex', ownerIdentifier: 'alex.ng@example.com' }),
		]);

		const rows = await admin.list();

		expect(rows.map((row) => row.workerId)).toEqual(['w2', 'w1']);
	});

	it('sorts a row whose owner no longer resolves last, after every owner group', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		// The ownerless rows are still not the viewer's, whose own user row resolved
		// to authenticate the request — and they have no label to alphabetise by, so
		// they go last as their own run rather than among owners they are not part of.
		listDashboardWorkers.mockResolvedValue([
			rosterRow('orphan-b', null),
			rosterRow('w1', OWNER_ID, { name: 'zeta', ownerName: 'Zoë' }),
			rosterRow('orphan-a', null),
			rosterRow('w2', OWNER_ID, { name: 'alpha', ownerName: 'Zoë' }),
		]);

		const rows = await admin.list();

		expect(rows.map((row) => row.workerId)).toEqual(['w2', 'w1', 'orphan-a', 'orphan-b']);
	});

	// Issue #750 — viewer-first is now the *global* list's rule alone: a project has a
	// configured order that the dispatch gate also schedules by, and showing every
	// operator a different sequence from that one would misdescribe the project.
	it('does not apply to a project-scoped roster, which follows the project order', async () => {
		getMembership.mockResolvedValue(membershipFor('contributor'));
		listProjectWorkerIdsInOrder.mockResolvedValue(['other-1', 'mine-1']);
		listDashboardWorkers.mockResolvedValue([
			rosterRow('mine-1', OWNER_ID),
			rosterRow('other-1', OTHER_ID),
		]);

		const rows = await owner.list({ projectId: 'p1' });

		expect(rows.map((row) => row.workerId)).toEqual(['other-1', 'mine-1']);
	});
});

// Issue #750 — the project's persisted worker order is what its Workers tab shows,
// so an operator reads the same sequence the dispatch gate prefers.
describe('workers.list ordering — the project’s configured order (issue #750)', () => {
	it('returns a project-scoped roster in the persisted order', async () => {
		getMembership.mockResolvedValue(membershipFor('contributor'));
		listProjectWorkerIdsInOrder.mockResolvedValue(['w3', 'w1', 'w2']);
		listDashboardWorkers.mockResolvedValue([
			rosterRow('w1', OTHER_ID),
			rosterRow('w2', OTHER_ID),
			rosterRow('w3', OTHER_ID),
		]);

		const rows = await owner.list({ projectId: 'p1' });

		expect(rows.map((row) => row.workerId)).toEqual(['w3', 'w1', 'w2']);
		expect(listProjectWorkerIdsInOrder).toHaveBeenCalledWith('p1');
	});

	it('does not read a project order for the unscoped installation roster', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		listDashboardWorkers.mockResolvedValue([]);

		await admin.list();

		expect(listProjectWorkerIdsInOrder).not.toHaveBeenCalled();
	});
});

describe('workers.list scoped to one project (issue #574)', () => {
	it('runs the project roster’s own access rule and scopes to that project alone', async () => {
		getMembership.mockResolvedValue(membershipFor('contributor'));
		listDashboardWorkers.mockResolvedValue([]);

		await owner.list({ projectId: 'p1' });

		expect(listDashboardWorkers).toHaveBeenCalledWith(['p1']);
		// The cross-project scope is not consulted at all — this read is the
		// project's roster, not a filtered view of the installation's.
		expect(listAccessibleProjectIds).not.toHaveBeenCalled();
	});

	it('denies a non-member with NOT_FOUND, hiding the roster and the project', async () => {
		getMembership.mockResolvedValue(undefined);

		await expect(owner.list({ projectId: 'p1' })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		expect(listDashboardWorkers).not.toHaveBeenCalled();
	});

	// The visibility issue #647 preserves: narrowing the *installation-wide* roster
	// to instance admins leaves a worker owner's per-project roster untouched.
	it('still serves a non-admin contributor the roster of a project they are enrolled in', async () => {
		getMembership.mockResolvedValue(membershipFor('contributor'));
		listDashboardWorkers.mockResolvedValue([
			{ workerId: WORKER_ID, lastSeenAt: new Date('2026-07-01T12:00:00.000Z') },
		]);

		const rows = await owner.list({ projectId: 'p1' });

		expect(rows).toEqual([{ workerId: WORKER_ID, lastSeenAt: '2026-07-01T12:00:00.000Z' }]);
	});

	it('scopes an instanceAdmin too, so un-enrolled machines stay off a project tab', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		listDashboardWorkers.mockResolvedValue([]);

		await admin.list({ projectId: 'p1' });

		expect(listDashboardWorkers).toHaveBeenCalledWith(['p1']);
		expect(listDashboardWorkers).not.toHaveBeenCalledWith(null);
	});
});

describe('workers.getById (worker detail, issue #477)', () => {
	/** The service view the router decorates — only the fields this suite asserts on. */
	function detailView(overrides: Record<string, unknown> = {}) {
		return {
			workerId: WORKER_ID,
			displayName: 'ada-laptop',
			ownerUserId: OWNER_ID,
			lastSeenAt: new Date('2026-07-01T12:00:00.000Z'),
			enrollments: [{ enrollmentId: ENROLLMENT_ID, projectId: 'p1', status: 'active' }],
			...overrides,
		};
	}

	it('scopes the read exactly like the list, and serializes last-seen to ISO', async () => {
		listAccessibleProjectIds.mockResolvedValue(['p1']);
		getDashboardWorkerDetail.mockResolvedValue(detailView());
		getMembership.mockResolvedValue(membershipFor('contributor'));

		const detail = await owner.getById({ workerId: WORKER_ID });

		expect(getDashboardWorkerDetail).toHaveBeenCalledWith(WORKER_ID, ['p1'], OWNER_ID);
		expect(detail.lastSeenAt).toBe('2026-07-01T12:00:00.000Z');
	});

	it('is NOT_FOUND for a worker the viewer may not see, exactly like a missing one', async () => {
		listAccessibleProjectIds.mockResolvedValue(['p1']);
		getDashboardWorkerDetail.mockResolvedValue(null);

		await expect(owner.getById({ workerId: WORKER_ID })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
	});

	it('reports the owner as able to change the owner-controlled values', async () => {
		listAccessibleProjectIds.mockResolvedValue(['p1']);
		getDashboardWorkerDetail.mockResolvedValue(detailView());
		getMembership.mockResolvedValue(membershipFor('contributor'));

		const detail = await owner.getById({ workerId: WORKER_ID });

		expect(detail.viewerIsOwner).toBe(true);
	});

	it('reports another user as unable to, so no owner control is offered', async () => {
		const other = workersRouter.createCaller({ user: { ...OWNER_USER, id: OTHER_ID } });
		listAccessibleProjectIds.mockResolvedValue(['p1']);
		getDashboardWorkerDetail.mockResolvedValue(detailView());
		getMembership.mockResolvedValue(membershipFor('contributor'));

		const detail = await other.getById({ workerId: WORKER_ID });

		expect(detail.viewerIsOwner).toBe(false);
	});

	it('does not treat an instanceAdmin as owner-capable — no override on the owner-controlled values', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		getDashboardWorkerDetail.mockResolvedValue(detailView());

		const detail = await admin.getById({ workerId: WORKER_ID });

		expect(detail.viewerIsOwner).toBe(false);
		// viewerCanAdminister is a *project*-role flag, unaffected: an instanceAdmin
		// still administers every project (mayAccessProject's own override), with
		// no membership lookup needed for it.
		expect(getMembership).not.toHaveBeenCalled();
		expect(detail.enrollments[0].viewerCanAdminister).toBe(true);
	});

	it('reports approve/suspend capability per project, from the same role check the mutations run', async () => {
		listAccessibleProjectIds.mockResolvedValue(['p1', 'p2']);
		getDashboardWorkerDetail.mockResolvedValue(
			detailView({
				enrollments: [
					{ enrollmentId: ENROLLMENT_ID, projectId: 'p1', status: 'pending' },
					{ enrollmentId: 'e2', projectId: 'p2', status: 'active' },
				],
			}),
		);
		getMembership.mockImplementation(async (_userId: string, projectId: string) =>
			projectId === 'p1' ? membershipFor('projectAdmin', 'p1') : membershipFor('member', 'p2'),
		);

		const detail = await owner.getById({ workerId: WORKER_ID });

		expect(detail.enrollments.map((enrollment) => enrollment.viewerCanAdminister)).toEqual([
			true,
			false,
		]);
	});
});

// Issue #799 — the network equivalent of `swarm workers register`, and the one
// procedure in the tree that returns a secret.
describe('workers.register (issue #799)', () => {
	const REGISTERED = { worker: makeWorker(), credential: 'one-time-worker-credential' };

	it('registers a machine for the caller themselves and returns the one-time credential', async () => {
		findUserByIdentifier.mockResolvedValue(OWNER_USER);
		registerWorker.mockResolvedValue(REGISTERED);

		const result = await owner.register({
			ownerIdentifier: 'ada@example.com',
			displayName: 'ada-laptop',
			capabilities: ['claude'],
		});

		expect(result).toBe(REGISTERED);
		expect(registerWorker).toHaveBeenCalledWith({
			ownerUserId: OWNER_ID,
			displayName: 'ada-laptop',
			capabilities: ['claude'],
		});
	});

	// Registering a machine for somebody else is an installation-administration act,
	// matching how `swarm workers register <owner-identifier>` is used today.
	it('lets an instanceAdmin register for another owner', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		findUserByIdentifier.mockResolvedValue(OWNER_USER);
		registerWorker.mockResolvedValue(REGISTERED);

		await admin.register({
			ownerIdentifier: 'ada@example.com',
			displayName: 'ada-laptop',
			capabilities: ['claude'],
		});

		expect(registerWorker).toHaveBeenCalledWith(expect.objectContaining({ ownerUserId: OWNER_ID }));
	});

	it('refuses a non-admin acting for another owner, registering nothing', async () => {
		findUserByIdentifier.mockResolvedValue({ ...OWNER_USER, id: OTHER_ID });

		await expect(
			owner.register({
				ownerIdentifier: 'grace@example.com',
				displayName: 'grace-laptop',
				capabilities: ['claude'],
			}),
		).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
		expect(registerWorker).not.toHaveBeenCalled();
	});

	// The FORBIDDEN precedes the owner NOT_FOUND deliberately, so a caller who may
	// not register for others cannot use this as a "does this identifier exist?"
	// oracle on an internet-exposed mount.
	it('answers a non-admin identically whether or not the named owner exists', async () => {
		findUserByIdentifier.mockResolvedValue(undefined);

		await expect(
			owner.register({
				ownerIdentifier: 'nobody@example.com',
				displayName: 'ghost',
				capabilities: ['claude'],
			}),
		).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
		expect(registerWorker).not.toHaveBeenCalled();
	});

	it('gives an instanceAdmin the honest NOT_FOUND for an unknown identifier', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		findUserByIdentifier.mockResolvedValue(undefined);

		await expect(
			admin.register({
				ownerIdentifier: 'nobody@example.com',
				displayName: 'ghost',
				capabilities: ['claude'],
			}),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(registerWorker).not.toHaveBeenCalled();
	});

	it('translates a duplicate (owner, displayName) to CONFLICT', async () => {
		findUserByIdentifier.mockResolvedValue(OWNER_USER);
		registerWorker.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));

		await expect(
			owner.register({
				ownerIdentifier: 'ada@example.com',
				displayName: 'ada-laptop',
				capabilities: ['claude'],
			}),
		).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
	});

	it('rejects an empty capability set before it reaches the service', async () => {
		findUserByIdentifier.mockResolvedValue(OWNER_USER);

		await expect(
			owner.register({
				ownerIdentifier: 'ada@example.com',
				displayName: 'ada-laptop',
				// `WorkerCapabilitiesSchema` is non-empty at the type level too, so an
				// empty set only ever arrives from a client tRPC never typed — which is
				// exactly the hand-rolled CLI client this mount exists for.
				capabilities: [] as unknown as ['claude'],
			}),
		).rejects.toThrow();
		expect(registerWorker).not.toHaveBeenCalled();
	});
});

describe('workers.listMine (owner self-service)', () => {
	it('returns only the caller’s own workers', async () => {
		const views = [{ workerId: WORKER_ID, displayName: 'ada-laptop' }];
		listOwnerWorkers.mockResolvedValue(views);

		await expect(owner.listMine()).resolves.toBe(views);
		expect(listOwnerWorkers).toHaveBeenCalledWith(OWNER_ID);
	});
});

describe('workers.roster (project-scoped read)', () => {
	it('denies a non-member with NOT_FOUND, hiding existence', async () => {
		getMembership.mockResolvedValue(undefined);

		await expect(owner.roster({ projectId: 'p1' })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		expect(listProjectRoster).not.toHaveBeenCalled();
	});

	it('lets a contributor read the roster', async () => {
		getMembership.mockResolvedValue(membershipFor('contributor'));
		const roster = [{ workerId: WORKER_ID }];
		listProjectRoster.mockResolvedValue(roster);

		await expect(owner.roster({ projectId: 'p1' })).resolves.toBe(roster);
		expect(listProjectRoster).toHaveBeenCalledWith('p1');
	});
});

// Issue #799 — the one project fact a DB-free `register-and-enroll` cannot work
// out for itself, since the operator SCM credential is stored per provider.
describe('workers.projectScmProvider (issue #799)', () => {
	const PROJECT = { id: 'p1', scm: 'bitbucket' } as never;

	it('returns the provider the project’s own lookup resolves, for a contributor', async () => {
		getMembership.mockResolvedValue(membershipFor('contributor'));
		findProjectByIdFromDb.mockResolvedValue(PROJECT);
		requireProjectSCMProviderId.mockReturnValue('bitbucket');

		await expect(owner.projectScmProvider({ projectId: 'p1' })).resolves.toEqual({
			providerId: 'bitbucket',
		});
		expect(requireProjectSCMProviderId).toHaveBeenCalledWith(PROJECT);
	});

	it('denies a non-member with NOT_FOUND, without reading the project', async () => {
		getMembership.mockResolvedValue(undefined);

		await expect(owner.projectScmProvider({ projectId: 'p1' })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		expect(findProjectByIdFromDb).not.toHaveBeenCalled();
		expect(requireProjectSCMProviderId).not.toHaveBeenCalled();
	});

	it('is NOT_FOUND for a project row that does not exist', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		findProjectByIdFromDb.mockResolvedValue(undefined);

		await expect(admin.projectScmProvider({ projectId: 'gone' })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		expect(requireProjectSCMProviderId).not.toHaveBeenCalled();
	});

	// The lookup's three throws already name the project and what it asked for, so
	// the message travels verbatim: the project's configuration is what has to
	// change, not the request.
	it('surfaces an unresolvable provider as PRECONDITION_FAILED with the message verbatim', async () => {
		getMembership.mockResolvedValue(membershipFor('contributor'));
		findProjectByIdFromDb.mockResolvedValue(PROJECT);
		requireProjectSCMProviderId.mockImplementation(() => {
			throw new Error("Cannot resolve the SCM provider for project 'p1': it selects 'bitbucket'");
		});

		await expect(owner.projectScmProvider({ projectId: 'p1' })).rejects.toThrowError(
			expect.objectContaining({
				code: 'PRECONDITION_FAILED',
				message: "Cannot resolve the SCM provider for project 'p1': it selects 'bitbucket'",
			}),
		);
	});
});

describe('workers.approveEnrollment (projectAdmin only)', () => {
	it('is NOT_FOUND for an unknown enrollment', async () => {
		getEnrollment.mockResolvedValue(undefined);

		await expect(owner.approveEnrollment({ enrollmentId: ENROLLMENT_ID })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		expect(approveEnrollment).not.toHaveBeenCalled();
	});

	it('hides the enrollment from a non-member of its project (NOT_FOUND)', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment());
		getMembership.mockResolvedValue(undefined);

		await expect(owner.approveEnrollment({ enrollmentId: ENROLLMENT_ID })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		expect(approveEnrollment).not.toHaveBeenCalled();
	});

	it('forbids a contributor from approving', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment());
		getMembership.mockResolvedValue(membershipFor('contributor'));

		await expect(owner.approveEnrollment({ enrollmentId: ENROLLMENT_ID })).rejects.toThrowError(
			expect.objectContaining({ code: 'FORBIDDEN' }),
		);
		expect(approveEnrollment).not.toHaveBeenCalled();
	});

	it('lets a projectAdmin approve', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment());
		getMembership.mockResolvedValue(membershipFor('projectAdmin'));
		approveEnrollment.mockResolvedValue(makeEnrollment({ status: 'active' }));

		const result = await owner.approveEnrollment({ enrollmentId: ENROLLMENT_ID });
		expect(result.status).toBe('active');
		expect(approveEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID);
	});
});

describe('workers.setStatus (projectAdmin revoke/reactivate)', () => {
	it('forbids a contributor from suspending an enrollment', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment({ status: 'active' }));
		getMembership.mockResolvedValue(membershipFor('contributor'));

		await expect(
			owner.setStatus({ enrollmentId: ENROLLMENT_ID, status: 'suspended' }),
		).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
		expect(setEnrollmentStatus).not.toHaveBeenCalled();
	});

	it('lets a projectAdmin suspend (revoke) an enrollment', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment({ status: 'active' }));
		getMembership.mockResolvedValue(membershipFor('projectAdmin'));
		setEnrollmentStatus.mockResolvedValue(makeEnrollment({ status: 'suspended' }));

		const result = await owner.setStatus({ enrollmentId: ENROLLMENT_ID, status: 'suspended' });
		expect(result.status).toBe('suspended');
		expect(setEnrollmentStatus).toHaveBeenCalledWith(ENROLLMENT_ID, 'suspended');
	});
});

// Issue #750 — reordering is a project administrator's act, gated exactly like
// approval and suspension, and existence-hiding the same way.
describe('workers.reorderProjectWorker (projectAdmin only)', () => {
	const reorder = { projectId: 'p1', workerId: WORKER_ID, direction: 'up' as const };

	it('hides the project from a non-member (NOT_FOUND)', async () => {
		getMembership.mockResolvedValue(undefined);

		await expect(owner.reorderProjectWorker(reorder)).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		expect(moveProjectWorkerOrder).not.toHaveBeenCalled();
	});

	it('forbids a contributor from reordering', async () => {
		getMembership.mockResolvedValue(membershipFor('contributor'));

		await expect(owner.reorderProjectWorker(reorder)).rejects.toThrowError(
			expect.objectContaining({ code: 'FORBIDDEN' }),
		);
		expect(moveProjectWorkerOrder).not.toHaveBeenCalled();
	});

	it('lets a projectAdmin move a worker and returns the new order', async () => {
		getMembership.mockResolvedValue(membershipFor('projectAdmin'));
		moveProjectWorkerOrder.mockResolvedValue([WORKER_ID, 'w2']);

		const result = await owner.reorderProjectWorker({ ...reorder, direction: 'down' });

		expect(moveProjectWorkerOrder).toHaveBeenCalledWith({
			projectId: 'p1',
			workerId: WORKER_ID,
			direction: 'down',
		});
		expect(result).toEqual({ projectId: 'p1', workerIds: [WORKER_ID, 'w2'] });
	});

	it('is NOT_FOUND when the worker holds no enrollment in that project', async () => {
		getMembership.mockResolvedValue(membershipFor('projectAdmin'));
		moveProjectWorkerOrder.mockResolvedValue(undefined);

		await expect(owner.reorderProjectWorker(reorder)).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
	});

	it('rejects a direction outside the vocabulary before any authorization read', async () => {
		await expect(
			// biome-ignore lint/suspicious/noExplicitAny: exercising the input schema itself.
			owner.reorderProjectWorker({ ...reorder, direction: 'top' as any }),
		).rejects.toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
		expect(getMembership).not.toHaveBeenCalled();
	});
});

describe('workers.enroll (owner offers a worker to a project)', () => {
	it('is NOT_FOUND when the caller does not own the worker', async () => {
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OTHER_ID }));

		await expect(
			owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(enrollWorker).not.toHaveBeenCalled();
		expect(getMembership).not.toHaveBeenCalled();
	});

	it('is NOT_FOUND for an unknown worker', async () => {
		getWorker.mockResolvedValue(undefined);

		await expect(
			owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(enrollWorker).not.toHaveBeenCalled();
	});

	it('hides an unknown/inaccessible project as NOT_FOUND (no enrollment written)', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(undefined);

		await expect(
			owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(enrollWorker).not.toHaveBeenCalled();
	});

	it('enrolls when the caller owns the worker and can see the project', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(membershipFor('contributor'));
		enrollWorker.mockResolvedValue(makeEnrollment());

		await owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] });

		expect(enrollWorker).toHaveBeenCalledWith(
			expect.objectContaining({ worker: makeWorker(), projectId: 'p1', allowedClis: ['claude'] }),
		);
	});

	it('translates a duplicate enrollment (23505) to CONFLICT', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(membershipFor('contributor'));
		enrollWorker.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));

		await expect(
			owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] }),
		).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
	});

	it('translates an out-of-capability CLI set to BAD_REQUEST', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(membershipFor('contributor'));
		enrollWorker.mockRejectedValue(new AllowedClisNotCapableError(WORKER_ID, ['antigravity']));

		await expect(
			owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['antigravity'] }),
		).rejects.toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
	});

	// Issue #690: the machine's checkout is not this project's repository. A rejection
	// the caller can act on, so `BAD_REQUEST` with the service's own message — which
	// already names both repositories — rather than an unexpected failure.
	it('translates a repository mismatch to BAD_REQUEST naming both repositories', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(membershipFor('contributor'));
		enrollWorker.mockRejectedValue(
			new EnrollmentRepositoryMismatchError(WORKER_ID, 'acme/frontend', 'acme/backend'),
		);

		await expect(
			owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] }),
		).rejects.toThrowError(
			expect.objectContaining({
				code: 'BAD_REQUEST',
				message: expect.stringContaining('acme/frontend'),
			}),
		);
	});

	// Issue #542: `planning` is an ordinary phase — the router neither special-cases
	// it nor consults who owns the machine, whatever the caller's installation role.
	it('enrolls with planning for an ordinary (non-admin) owner', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(membershipFor('contributor'));
		enrollWorker.mockResolvedValue(makeEnrollment());

		await owner.enroll({
			workerId: WORKER_ID,
			projectId: 'p1',
			allowedClis: ['claude'],
			allowedPhases: ['planning'],
		});

		expect(enrollWorker).toHaveBeenCalledWith(
			expect.objectContaining({ allowedPhases: ['planning'] }),
		);
	});

	it('an instanceAdmin may enroll any worker', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OWNER_ID }));
		enrollWorker.mockResolvedValue(makeEnrollment());

		await admin.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] });
		// instanceAdmin bypasses both the ownership check and assertProjectAccess.
		expect(getMembership).not.toHaveBeenCalled();
		expect(enrollWorker).toHaveBeenCalled();
	});
});

// Issue #784: both approvals routability needs are the same person's when the
// enroller owns the machine *and* administers the project, so the enrollment is
// created already granted. The rule is joint standing, never elevated privilege.
describe('workers.enroll self-administered fast path (issue #784)', () => {
	it('creates an active, consenting enrollment for an owner who is also a projectAdmin', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(membershipFor('projectAdmin'));
		enrollWorker.mockResolvedValue(makeEnrollment({ status: 'active', sharingConsent: true }));

		await owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] });

		expect(enrollWorker).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'active', sharingConsent: true }),
		);
	});

	it('leaves a contributor owner on the pending, unconsented path', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(membershipFor('contributor'));
		enrollWorker.mockResolvedValue(makeEnrollment());

		await owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] });

		expect(enrollWorker).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'pending', sharingConsent: false }),
		);
	});

	// `member` is below `projectAdmin`, so it pins the threshold rather than
	// merely re-testing the branch the contributor case already covers.
	it('leaves a member owner on the pending, unconsented path', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(membershipFor('member'));
		enrollWorker.mockResolvedValue(makeEnrollment());

		await owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] });

		expect(enrollWorker).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'pending', sharingConsent: false }),
		);
	});

	// The case the acceptance criteria rule out: `mayAccessProject` alone would say
	// yes here (an instanceAdmin always may), so the uncalled `getMembership` is what
	// pins the ownership conjunct short-circuiting ahead of it.
	it('does not fast-path an instanceAdmin enrolling someone else’s worker', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OWNER_ID }));
		enrollWorker.mockResolvedValue(makeEnrollment());

		await admin.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] });

		expect(enrollWorker).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'pending', sharingConsent: false }),
		);
		expect(getMembership).not.toHaveBeenCalled();
	});

	it('fast-paths an instanceAdmin enrolling their own worker', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OTHER_ID }));
		enrollWorker.mockResolvedValue(makeEnrollment({ status: 'active', sharingConsent: true }));

		await admin.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] });

		expect(enrollWorker).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'active', sharingConsent: true }),
		);
	});
});

describe('workers concurrency inputs (issue #480)', () => {
	it('rejects a null allocation on enroll — there is no "clear it" value', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(membershipFor('contributor'));

		await expect(
			owner.enroll({
				workerId: WORKER_ID,
				projectId: 'p1',
				allowedClis: ['claude'],
				// @ts-expect-error the input no longer accepts null — asserted at runtime too
				concurrencyAllocation: null,
			}),
		).rejects.toThrow();
		expect(enrollWorker).not.toHaveBeenCalled();
	});

	it('omits the allocation on enroll so the service applies its default', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(membershipFor('contributor'));
		enrollWorker.mockResolvedValue(makeEnrollment());

		await owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] });

		expect(enrollWorker).toHaveBeenCalledWith(
			expect.objectContaining({ concurrencyAllocation: undefined }),
		);
	});

	it('rejects a null allocation on updateConstraints, leaving the stored value alone', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment());
		getWorker.mockResolvedValue(makeWorker());

		await expect(
			owner.updateConstraints({
				enrollmentId: ENROLLMENT_ID,
				// @ts-expect-error the input no longer accepts null — asserted at runtime too
				concurrencyAllocation: null,
			}),
		).rejects.toThrow();
		expect(updateEnrollmentConstraints).not.toHaveBeenCalled();
	});

	it('passes a positive allocation through on updateConstraints', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment());
		getWorker.mockResolvedValue(makeWorker());
		updateEnrollmentConstraints.mockResolvedValue(makeEnrollment({ concurrencyAllocation: 3 }));

		const result = await owner.updateConstraints({
			enrollmentId: ENROLLMENT_ID,
			concurrencyAllocation: 3,
		});

		expect(result.concurrencyAllocation).toBe(3);
		expect(updateEnrollmentConstraints).toHaveBeenCalledWith(
			expect.objectContaining({ enrollmentId: ENROLLMENT_ID, concurrencyAllocation: 3 }),
		);
	});
});

describe('workers allowed-phase inputs (issue #509)', () => {
	it('passes a phase selection through on updateConstraints', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment());
		getWorker.mockResolvedValue(makeWorker());
		updateEnrollmentConstraints.mockResolvedValue(
			makeEnrollment({ allowedPhases: ['implementation', 'review'] }),
		);

		const result = await owner.updateConstraints({
			enrollmentId: ENROLLMENT_ID,
			allowedPhases: ['implementation', 'review'],
		});

		expect(result.allowedPhases).toEqual(['implementation', 'review']);
		expect(updateEnrollmentConstraints).toHaveBeenCalledWith(
			expect.objectContaining({
				enrollmentId: ENROLLMENT_ID,
				allowedPhases: ['implementation', 'review'],
			}),
		);
	});

	it('rejects an empty phase selection before it reaches the service', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment());
		getWorker.mockResolvedValue(makeWorker());

		await expect(
			owner.updateConstraints({ enrollmentId: ENROLLMENT_ID, allowedPhases: [] }),
		).rejects.toThrow();
		expect(updateEnrollmentConstraints).not.toHaveBeenCalled();
	});

	it('rejects a phase outside the pipeline vocabulary', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment());
		getWorker.mockResolvedValue(makeWorker());

		await expect(
			owner.updateConstraints({
				enrollmentId: ENROLLMENT_ID,
				// @ts-expect-error only the pipeline phases are accepted — asserted at runtime too
				allowedPhases: ['deploy'],
			}),
		).rejects.toThrow();
		expect(updateEnrollmentConstraints).not.toHaveBeenCalled();
	});

	it('hides another owner’s enrollment before validating the selection (NOT_FOUND)', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment());
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OTHER_ID }));

		await expect(
			owner.updateConstraints({ enrollmentId: ENROLLMENT_ID, allowedPhases: ['review'] }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(updateEnrollmentConstraints).not.toHaveBeenCalled();
	});

	// Issue #542: adding `planning` to an ordinary owner's enrollment is an ordinary
	// constraints update — no gate above the enrollment's own phase selection.
	it('adds planning for an ordinary (non-admin) owner', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment());
		getWorker.mockResolvedValue(makeWorker());
		updateEnrollmentConstraints.mockResolvedValue(makeEnrollment());

		await owner.updateConstraints({ enrollmentId: ENROLLMENT_ID, allowedPhases: ['planning'] });

		expect(updateEnrollmentConstraints).toHaveBeenCalledWith(
			expect.objectContaining({ allowedPhases: ['planning'] }),
		);
	});

	it('omits the selection on enroll so the service applies its default', async () => {
		getWorker.mockResolvedValue(makeWorker());
		getMembership.mockResolvedValue(membershipFor('contributor'));
		enrollWorker.mockResolvedValue(makeEnrollment());

		await owner.enroll({ workerId: WORKER_ID, projectId: 'p1', allowedClis: ['claude'] });

		expect(enrollWorker).toHaveBeenCalledWith(
			expect.objectContaining({ allowedPhases: undefined }),
		);
	});
});

describe('workers.setConsent (owner controls sharing consent)', () => {
	it('is NOT_FOUND for an unknown enrollment', async () => {
		getEnrollment.mockResolvedValue(undefined);

		await expect(
			owner.setConsent({ enrollmentId: ENROLLMENT_ID, sharingConsent: false }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(setSharingConsent).not.toHaveBeenCalled();
	});

	it('hides an enrollment whose worker the caller does not own (NOT_FOUND)', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment());
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OTHER_ID }));

		await expect(
			owner.setConsent({ enrollmentId: ENROLLMENT_ID, sharingConsent: false }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(setSharingConsent).not.toHaveBeenCalled();
	});

	it('hides the enrollment from an instanceAdmin who does not own the worker either — no override', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		getEnrollment.mockResolvedValue(makeEnrollment());
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OWNER_ID }));

		await expect(
			admin.setConsent({ enrollmentId: ENROLLMENT_ID, sharingConsent: false }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(setSharingConsent).not.toHaveBeenCalled();
	});

	it('lets the owner revoke sharing consent', async () => {
		getEnrollment.mockResolvedValue(makeEnrollment({ sharingConsent: true }));
		getWorker.mockResolvedValue(makeWorker());
		setSharingConsent.mockResolvedValue(makeEnrollment({ sharingConsent: false }));

		const result = await owner.setConsent({ enrollmentId: ENROLLMENT_ID, sharingConsent: false });
		expect(result.sharingConsent).toBe(false);
		expect(setSharingConsent).toHaveBeenCalledWith(ENROLLMENT_ID, false);
	});
});

describe('workers.setDeclaredCapabilities (owner-only, no instanceAdmin override, issue #787)', () => {
	it('is NOT_FOUND for an unknown worker', async () => {
		getWorker.mockResolvedValue(undefined);

		await expect(
			owner.setDeclaredCapabilities({ workerId: WORKER_ID, capabilities: ['claude'] }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(declareWorkerCapabilities).not.toHaveBeenCalled();
	});

	it('hides a worker the caller does not own (NOT_FOUND)', async () => {
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OTHER_ID }));

		await expect(
			owner.setDeclaredCapabilities({ workerId: WORKER_ID, capabilities: ['claude'] }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(declareWorkerCapabilities).not.toHaveBeenCalled();
	});

	// The declaration is a statement about someone's own machine, so it admits no
	// layer-1 override — exactly like `rename`, unlike `enroll`.
	it('hides another owner’s worker from an instanceAdmin too', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OWNER_ID }));

		await expect(
			admin.setDeclaredCapabilities({ workerId: WORKER_ID, capabilities: ['claude'] }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(declareWorkerCapabilities).not.toHaveBeenCalled();
	});

	it('lets the owner declare a CLI set on their own worker', async () => {
		getWorker.mockResolvedValue(makeWorker());
		declareWorkerCapabilities.mockResolvedValue(
			makeWorker({ capabilities: ['claude'], declaredCapabilities: ['claude'] }),
		);

		const result = await owner.setDeclaredCapabilities({
			workerId: WORKER_ID,
			capabilities: ['claude'],
		});

		expect(result.declaredCapabilities).toEqual(['claude']);
		expect(declareWorkerCapabilities).toHaveBeenCalledWith(WORKER_ID, ['claude']);
	});

	it('clears the declaration when passed null', async () => {
		getWorker.mockResolvedValue(makeWorker());
		declareWorkerCapabilities.mockResolvedValue(makeWorker({ declaredCapabilities: null }));

		await owner.setDeclaredCapabilities({ workerId: WORKER_ID, capabilities: null });

		expect(declareWorkerCapabilities).toHaveBeenCalledWith(WORKER_ID, null);
	});

	it('is NOT_FOUND when the worker disappears between the check and the write', async () => {
		getWorker.mockResolvedValue(makeWorker());
		declareWorkerCapabilities.mockResolvedValue(undefined);

		await expect(
			owner.setDeclaredCapabilities({ workerId: WORKER_ID, capabilities: ['claude'] }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
	});

	// The same status the handshake answers this rule with.
	it('translates a set an active enrollment still needs to CONFLICT', async () => {
		getWorker.mockResolvedValue(makeWorker());
		declareWorkerCapabilities.mockRejectedValue(
			new WorkerCapabilityReductionError(WORKER_ID, ['codex']),
		);

		await expect(
			owner.setDeclaredCapabilities({ workerId: WORKER_ID, capabilities: ['claude'] }),
		).rejects.toThrowError(
			expect.objectContaining({ code: 'CONFLICT', message: expect.stringContaining('codex') }),
		);
	});

	it('translates a set naming an unprobed CLI to BAD_REQUEST', async () => {
		getWorker.mockResolvedValue(makeWorker());
		declareWorkerCapabilities.mockRejectedValue(
			new WorkerCapabilityNotProbedError(WORKER_ID, ['antigravity'], ['claude']),
		);

		await expect(
			owner.setDeclaredCapabilities({ workerId: WORKER_ID, capabilities: ['antigravity'] }),
		).rejects.toThrowError(
			expect.objectContaining({
				code: 'BAD_REQUEST',
				message: expect.stringContaining('antigravity'),
			}),
		);
	});

	it('rejects an empty set before it reaches the service — clearing is `null`, not `[]`', async () => {
		getWorker.mockResolvedValue(makeWorker());

		await expect(
			owner.setDeclaredCapabilities({ workerId: WORKER_ID, capabilities: [] }),
		).rejects.toThrow();
		expect(declareWorkerCapabilities).not.toHaveBeenCalled();
	});

	it('rejects a CLI outside the harness vocabulary before it reaches the service', async () => {
		getWorker.mockResolvedValue(makeWorker());

		await expect(
			owner.setDeclaredCapabilities({
				workerId: WORKER_ID,
				capabilities: ['gemini'] as unknown as ['claude'],
			}),
		).rejects.toThrow();
		expect(declareWorkerCapabilities).not.toHaveBeenCalled();
	});
});

describe('workers.rename (owner-only, no instanceAdmin override)', () => {
	it('is NOT_FOUND for an unknown worker', async () => {
		getWorker.mockResolvedValue(undefined);

		await expect(
			owner.rename({ workerId: WORKER_ID, displayName: 'new-name' }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(renameWorker).not.toHaveBeenCalled();
	});

	it('hides a worker the caller does not own (NOT_FOUND)', async () => {
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OTHER_ID }));

		await expect(
			owner.rename({ workerId: WORKER_ID, displayName: 'new-name' }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(renameWorker).not.toHaveBeenCalled();
	});

	it('hides another owner’s worker from an instanceAdmin too — unlike enroll, no override', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OWNER_ID }));

		await expect(
			admin.rename({ workerId: WORKER_ID, displayName: 'new-name' }),
		).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
		expect(renameWorker).not.toHaveBeenCalled();
	});

	it('lets the owner rename their own worker', async () => {
		getWorker.mockResolvedValue(makeWorker());
		renameWorker.mockResolvedValue(makeWorker({ displayName: 'new-name' }));

		const result = await owner.rename({ workerId: WORKER_ID, displayName: 'new-name' });

		expect(result.displayName).toBe('new-name');
		expect(renameWorker).toHaveBeenCalledWith(WORKER_ID, 'new-name');
	});

	it('translates a duplicate name (23505) to CONFLICT', async () => {
		getWorker.mockResolvedValue(makeWorker());
		renameWorker.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));

		await expect(
			owner.rename({ workerId: WORKER_ID, displayName: 'new-name' }),
		).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
	});

	it('rejects an empty display name before it reaches the service', async () => {
		getWorker.mockResolvedValue(makeWorker());

		await expect(owner.rename({ workerId: WORKER_ID, displayName: '  ' })).rejects.toThrow();
		expect(renameWorker).not.toHaveBeenCalled();
	});
});

describe('workers.remove (owner-only deregistration, issue #789)', () => {
	it('is NOT_FOUND for an unknown worker', async () => {
		getWorker.mockResolvedValue(undefined);

		await expect(owner.remove({ workerId: WORKER_ID })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		expect(removeWorker).not.toHaveBeenCalled();
	});

	it('hides a worker the caller does not own (NOT_FOUND)', async () => {
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OTHER_ID }));

		await expect(owner.remove({ workerId: WORKER_ID })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		expect(removeWorker).not.toHaveBeenCalled();
	});

	it('hides another owner’s worker from an instanceAdmin too — no override', async () => {
		const admin = workersRouter.createCaller({ user: ADMIN_USER });
		getWorker.mockResolvedValue(makeWorker({ ownerUserId: OWNER_ID }));

		await expect(admin.remove({ workerId: WORKER_ID })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
		expect(removeWorker).not.toHaveBeenCalled();
	});

	it('lets the owner delete their own worker', async () => {
		getWorker.mockResolvedValue(makeWorker());

		const result = await owner.remove({ workerId: WORKER_ID });

		expect(result).toEqual({ workerId: WORKER_ID });
		expect(removeWorker).toHaveBeenCalledWith(WORKER_ID);
	});

	it('refuses while the machine is executing a run (CONFLICT), without deleting', async () => {
		getWorker.mockResolvedValue(makeWorker());
		deriveWorkerRunState.mockResolvedValue({ busy: true, currentRunId: 'run-1' });

		await expect(owner.remove({ workerId: WORKER_ID })).rejects.toThrowError(
			expect.objectContaining({ code: 'CONFLICT' }),
		);
		expect(removeWorker).not.toHaveBeenCalled();
	});

	it('refuses an expired-session worker when it still has an unexpired dispatch claim', async () => {
		getWorker.mockResolvedValue(makeWorker());
		deriveWorkerRunState.mockResolvedValue({ busy: true, currentRunId: 'run-1' });

		await expect(owner.remove({ workerId: WORKER_ID })).rejects.toThrowError(
			expect.objectContaining({ code: 'CONFLICT' }),
		);
		expect(removeWorker).not.toHaveBeenCalled();
	});

	// Merely being connected is not a reason to refuse: the session row cascades and
	// the daemon's next reconnect fails on a credential that no longer resolves,
	// which is exactly what retiring a machine means.
	it('deletes a connected but idle machine', async () => {
		getWorker.mockResolvedValue(makeWorker());
		deriveWorkerRunState.mockResolvedValue({ busy: false, currentRunId: null });

		await owner.remove({ workerId: WORKER_ID });

		expect(removeWorker).toHaveBeenCalledWith(WORKER_ID);
	});

	it('translates a row that vanished under it to NOT_FOUND', async () => {
		getWorker.mockResolvedValue(makeWorker());
		removeWorker.mockResolvedValue(false);

		await expect(owner.remove({ workerId: WORKER_ID })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND' }),
		);
	});
});
