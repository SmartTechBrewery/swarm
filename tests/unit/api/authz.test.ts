import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMembership, listAccessibleProjectIds } = vi.hoisted(() => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));

vi.mock('@/identity/membership-service.js', () => ({
	getMembership,
	listAccessibleProjectIds,
}));

import {
	accessibleProjectScope,
	assertInstanceAdmin,
	assertProjectAccess,
	filterAccessibleProjects,
	mayAccessProject,
} from '@/api/authz.js';
import type { ProjectMembership, ProjectRole } from '@/identity/membership.js';
import type { SwarmUser } from '@/identity/schema.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function user(overrides: Partial<SwarmUser> = {}): SwarmUser {
	return {
		id: USER_ID,
		identifier: 'ada@example.com',
		displayName: 'Ada',
		instanceAdmin: false,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

function membership(role: ProjectRole, projectId = 'proj-a'): ProjectMembership {
	return {
		id: '99999999-9999-4999-8999-999999999999',
		projectId,
		userId: USER_ID,
		role,
		createdAt: new Date(0),
	};
}

describe('assertProjectAccess', () => {
	beforeEach(() => {
		getMembership.mockReset();
		listAccessibleProjectIds.mockReset();
	});

	it('lets an instanceAdmin through without consulting membership', async () => {
		await expect(
			assertProjectAccess(user({ instanceAdmin: true }), 'proj-a', 'projectAdmin'),
		).resolves.toBeUndefined();
		expect(getMembership).not.toHaveBeenCalled();
	});

	it('throws NOT_FOUND (not FORBIDDEN) for a non-member, hiding existence', async () => {
		getMembership.mockResolvedValue(undefined);

		await expect(assertProjectAccess(user(), 'proj-a', 'contributor')).rejects.toThrowError(
			expect.objectContaining({
				code: 'NOT_FOUND',
				message: 'Project with ID "proj-a" not found',
			}),
		);
		expect(getMembership).toHaveBeenCalledWith(USER_ID, 'proj-a');
	});

	it('lets any member read (contributor satisfies the contributor floor)', async () => {
		getMembership.mockResolvedValue(membership('contributor'));
		await expect(assertProjectAccess(user(), 'proj-a', 'contributor')).resolves.toBeUndefined();
	});

	it('throws FORBIDDEN when a member is below the required role', async () => {
		getMembership.mockResolvedValue(membership('member'));

		await expect(assertProjectAccess(user(), 'proj-a', 'projectAdmin')).rejects.toThrowError(
			expect.objectContaining({ code: 'FORBIDDEN' }),
		);
	});

	it('throws FORBIDDEN when a contributor attempts a member-level action', async () => {
		getMembership.mockResolvedValue(membership('contributor'));

		await expect(assertProjectAccess(user(), 'proj-a', 'member')).rejects.toThrowError(
			expect.objectContaining({ code: 'FORBIDDEN' }),
		);
	});

	it('lets a projectAdmin through the projectAdmin floor', async () => {
		getMembership.mockResolvedValue(membership('projectAdmin'));
		await expect(assertProjectAccess(user(), 'proj-a', 'projectAdmin')).resolves.toBeUndefined();
	});
});

describe('assertInstanceAdmin (issue #647)', () => {
	beforeEach(() => {
		getMembership.mockReset();
		listAccessibleProjectIds.mockReset();
	});

	it('lets an instanceAdmin read an installation-wide view', () => {
		expect(() => assertInstanceAdmin(user({ instanceAdmin: true }), 'runs')).not.toThrow();
	});

	it('throws FORBIDDEN (not NOT_FOUND) for an ordinary user — no project id, so nothing to hide', () => {
		expect(() => assertInstanceAdmin(user(), 'workers')).toThrowError(
			expect.objectContaining({ code: 'FORBIDDEN' }),
		);
	});

	it('names the view and points the caller at their projects', () => {
		expect(() => assertInstanceAdmin(user(), 'runs')).toThrowError(/installation-wide runs view/);
		expect(() => assertInstanceAdmin(user(), 'runs')).toThrowError(
			/Open a project you are enrolled in/,
		);
	});

	it('decides on the installation role alone — no membership read at all', () => {
		expect(() => assertInstanceAdmin(user(), 'runs')).toThrow();
		expect(() => assertInstanceAdmin(user({ instanceAdmin: true }), 'runs')).not.toThrow();
		expect(getMembership).not.toHaveBeenCalled();
		expect(listAccessibleProjectIds).not.toHaveBeenCalled();
	});
});

describe('mayAccessProject (issue #477)', () => {
	beforeEach(() => {
		getMembership.mockReset();
		listAccessibleProjectIds.mockReset();
	});

	it('reports true for an instanceAdmin without consulting membership', async () => {
		await expect(
			mayAccessProject(user({ instanceAdmin: true }), 'proj-a', 'projectAdmin'),
		).resolves.toBe(true);
		expect(getMembership).not.toHaveBeenCalled();
	});

	it('reports false for a non-member rather than throwing', async () => {
		getMembership.mockResolvedValue(undefined);
		await expect(mayAccessProject(user(), 'proj-a', 'contributor')).resolves.toBe(false);
	});

	it('reports false for a member below the required role', async () => {
		getMembership.mockResolvedValue(membership('member'));
		await expect(mayAccessProject(user(), 'proj-a', 'projectAdmin')).resolves.toBe(false);
	});

	it('reports true for a member at or above the required role', async () => {
		getMembership.mockResolvedValue(membership('projectAdmin'));
		await expect(mayAccessProject(user(), 'proj-a', 'projectAdmin')).resolves.toBe(true);
		expect(getMembership).toHaveBeenCalledWith(USER_ID, 'proj-a');
	});
});

describe('accessibleProjectScope', () => {
	beforeEach(() => {
		getMembership.mockReset();
		listAccessibleProjectIds.mockReset();
	});

	it('returns null (no restriction) for an instanceAdmin', async () => {
		await expect(accessibleProjectScope(user({ instanceAdmin: true }))).resolves.toBeNull();
		expect(listAccessibleProjectIds).not.toHaveBeenCalled();
	});

	it('returns the membership id set for a non-admin', async () => {
		listAccessibleProjectIds.mockResolvedValue(['proj-a', 'proj-b']);
		await expect(accessibleProjectScope(user())).resolves.toEqual(['proj-a', 'proj-b']);
		expect(listAccessibleProjectIds).toHaveBeenCalledWith(USER_ID);
	});
});

describe('filterAccessibleProjects', () => {
	beforeEach(() => {
		getMembership.mockReset();
		listAccessibleProjectIds.mockReset();
	});

	const projects = [{ id: 'proj-a' }, { id: 'proj-b' }, { id: 'proj-c' }];

	it('returns every project unchanged for an instanceAdmin', async () => {
		await expect(
			filterAccessibleProjects(user({ instanceAdmin: true }), projects),
		).resolves.toEqual(projects);
		expect(listAccessibleProjectIds).not.toHaveBeenCalled();
	});

	it('keeps only the projects in the caller accessible set for a non-admin', async () => {
		listAccessibleProjectIds.mockResolvedValue(['proj-a', 'proj-c']);
		await expect(filterAccessibleProjects(user(), projects)).resolves.toEqual([
			{ id: 'proj-a' },
			{ id: 'proj-c' },
		]);
	});

	it('returns an empty list for a non-admin with no memberships', async () => {
		listAccessibleProjectIds.mockResolvedValue([]);
		await expect(filterAccessibleProjects(user(), projects)).resolves.toEqual([]);
	});
});
