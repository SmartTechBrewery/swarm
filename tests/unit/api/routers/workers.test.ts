import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	AllowedClisNotCapableError,
	approveEnrollment,
	enrollWorker,
	getDashboardWorkerDetail,
	getEnrollment,
	listDashboardWorkers,
	listOwnerWorkers,
	listProjectRoster,
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
	return {
		AllowedClisNotCapableError,
		approveEnrollment: vi.fn(),
		enrollWorker: vi.fn(),
		getDashboardWorkerDetail: vi.fn(),
		getEnrollment: vi.fn(),
		listDashboardWorkers: vi.fn(),
		listOwnerWorkers: vi.fn(),
		listProjectRoster: vi.fn(),
		setEnrollmentStatus: vi.fn(),
		setSharingConsent: vi.fn(),
		updateEnrollmentConstraints: vi.fn(),
	};
});
const { getWorker, renameWorker } = vi.hoisted(() => ({
	getWorker: vi.fn(),
	renameWorker: vi.fn(),
}));
const { getMembership, listAccessibleProjectIds } = vi.hoisted(() => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));

vi.mock('@/identity/worker-enrollment-service.js', () => ({
	AllowedClisNotCapableError,
	approveEnrollment,
	enrollWorker,
	getDashboardWorkerDetail,
	getEnrollment,
	listDashboardWorkers,
	listOwnerWorkers,
	listProjectRoster,
	setEnrollmentStatus,
	setSharingConsent,
	updateEnrollmentConstraints,
}));
vi.mock('@/identity/worker-service.js', () => ({ getWorker, renameWorker }));
vi.mock('@/identity/membership-service.js', () => ({ getMembership, listAccessibleProjectIds }));

import { workersRouter } from '@/api/routers/workers.js';
import type { ProjectMembership, ProjectRole } from '@/identity/membership.js';
import type { SwarmUser } from '@/identity/schema.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';
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
	return {
		id: WORKER_ID,
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude', 'codex'],
		supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
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
		setEnrollmentStatus,
		setSharingConsent,
		updateEnrollmentConstraints,
		getWorker,
		renameWorker,
		getMembership,
		listAccessibleProjectIds,
	]) {
		m.mockReset();
	}
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

	it('passes only the caller’s membership project ids for an ordinary user', async () => {
		listAccessibleProjectIds.mockResolvedValue(['proj-a', 'proj-b']);
		listDashboardWorkers.mockResolvedValue([]);

		await owner.list();

		expect(listAccessibleProjectIds).toHaveBeenCalledWith(OWNER_ID);
		expect(listDashboardWorkers).toHaveBeenCalledWith(['proj-a', 'proj-b']);
	});

	it('returns an empty roster for a user with no accessible project', async () => {
		listAccessibleProjectIds.mockResolvedValue([]);
		listDashboardWorkers.mockResolvedValue([]);

		await expect(owner.list()).resolves.toEqual([]);
		expect(listDashboardWorkers).toHaveBeenCalledWith([]);
	});

	it('serializes last-seen to an ISO string (and keeps null for a never-connected worker)', async () => {
		listAccessibleProjectIds.mockResolvedValue(['proj-a']);
		listDashboardWorkers.mockResolvedValue([
			{ workerId: WORKER_ID, lastSeenAt: new Date('2026-07-01T12:00:00.000Z') },
			{ workerId: 'w2', lastSeenAt: null },
		]);

		const rows = await owner.list();

		expect(rows[0].lastSeenAt).toBe('2026-07-01T12:00:00.000Z');
		expect(rows[1].lastSeenAt).toBeNull();
	});
});

describe('workers.list ordering — the viewer’s own machines first (issue #657)', () => {
	/** A roster row as `listDashboardWorkers` returns it, reduced to the fields ordering reads. */
	function rosterRow(workerId: string, ownerUserId: string | null) {
		return {
			workerId,
			lastSeenAt: null,
			owner: ownerUserId
				? {
						userId: ownerUserId,
						identifier: `${ownerUserId}@example.com`,
						displayName: ownerUserId,
					}
				: null,
		};
	}

	it('lists the caller’s workers first, keeping each group’s existing order', async () => {
		listAccessibleProjectIds.mockResolvedValue(['proj-a']);
		listDashboardWorkers.mockResolvedValue([
			rosterRow('other-1', OTHER_ID),
			rosterRow('mine-1', OWNER_ID),
			rosterRow('other-2', OTHER_ID),
			rosterRow('mine-2', OWNER_ID),
		]);

		const rows = await owner.list();

		expect(rows.map((row) => row.workerId)).toEqual(['mine-1', 'mine-2', 'other-1', 'other-2']);
	});

	it('applies the same ordering to a project-scoped roster', async () => {
		getMembership.mockResolvedValue(membershipFor('contributor'));
		listDashboardWorkers.mockResolvedValue([
			rosterRow('other-1', OTHER_ID),
			rosterRow('mine-1', OWNER_ID),
		]);

		const rows = await owner.list({ projectId: 'p1' });

		expect(rows.map((row) => row.workerId)).toEqual(['mine-1', 'other-1']);
	});

	it('leaves the order untouched for a viewer who owns no visible worker', async () => {
		listAccessibleProjectIds.mockResolvedValue(['proj-a']);
		// The third row's owner user row no longer resolves; it is still not the
		// viewer's, whose own row resolved to authenticate the request.
		listDashboardWorkers.mockResolvedValue([
			rosterRow('other-1', OTHER_ID),
			rosterRow('other-2', OTHER_ID),
			rosterRow('orphaned', null),
		]);

		const rows = await owner.list();

		expect(rows.map((row) => row.workerId)).toEqual(['other-1', 'other-2', 'orphaned']);
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

		expect(getDashboardWorkerDetail).toHaveBeenCalledWith(WORKER_ID, ['p1']);
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
