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
import { agentScopeOf, type SwarmUser, scopeUserToProjects } from '@/identity/schema.js';

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

// Issue #1385: a scoped agent credential's user is limited to its projects, before
// and regardless of the administrator bypass.
describe('a scoped agent credential', () => {
	const scopedAdmin = () =>
		scopeUserToProjects(user({ instanceAdmin: true }), ['proj-a', 'proj-b']);
	const scopedMember = () => scopeUserToProjects(user(), ['proj-a', 'proj-b']);

	beforeEach(() => {
		getMembership.mockReset();
		listAccessibleProjectIds.mockReset();
	});

	it('reads a project outside its scope as NOT_FOUND, even for an administrator holder', async () => {
		await expect(assertProjectAccess(scopedAdmin(), 'proj-z', 'contributor')).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND', message: 'Project with ID "proj-z" not found' }),
		);
		await expect(
			assertProjectAccess(scopedAdmin(), 'proj-z', 'contributor', 'Run with ID "r" not found'),
		).rejects.toThrowError(expect.objectContaining({ message: 'Run with ID "r" not found' }));
		expect(await mayAccessProject(scopedAdmin(), 'proj-z', 'contributor')).toBe(false);
		expect(getMembership).not.toHaveBeenCalled();
	});

	it('passes an administrator holder inside the scope without consulting membership', async () => {
		await expect(
			assertProjectAccess(scopedAdmin(), 'proj-a', 'projectAdmin'),
		).resolves.toBeUndefined();
		expect(await mayAccessProject(scopedAdmin(), 'proj-b', 'projectAdmin')).toBe(true);
		expect(getMembership).not.toHaveBeenCalled();
	});

	it("applies a non-admin holder's own membership inside the scope", async () => {
		getMembership.mockResolvedValue(membership('contributor'));

		await expect(
			assertProjectAccess(scopedMember(), 'proj-a', 'contributor'),
		).resolves.toBeUndefined();
		await expect(assertProjectAccess(scopedMember(), 'proj-a', 'member')).rejects.toThrowError(
			expect.objectContaining({ code: 'FORBIDDEN' }),
		);
		expect(await mayAccessProject(scopedMember(), 'proj-a', 'member')).toBe(false);
	});

	it('scopes cross-project reads to its projects, intersected with what the holder may read', async () => {
		expect(await accessibleProjectScope(scopedAdmin())).toEqual(['proj-a', 'proj-b']);
		expect(listAccessibleProjectIds).not.toHaveBeenCalled();

		listAccessibleProjectIds.mockResolvedValue(['proj-b', 'proj-z']);
		expect(await accessibleProjectScope(scopedMember())).toEqual(['proj-b']);
		expect(
			await filterAccessibleProjects(scopedAdmin(), [{ id: 'proj-a' }, { id: 'proj-z' }]),
		).toEqual([{ id: 'proj-a' }]);
	});

	it('is refused every installation-wide view, even for an administrator holder', () => {
		expect(() => assertInstanceAdmin(scopedAdmin(), 'workers')).toThrowError(
			expect.objectContaining({ code: 'FORBIDDEN' }),
		);
	});

	it('acts as its holder with the installation-admin flag cleared', () => {
		const scoped = scopedAdmin();

		expect(scoped.id).toBe(USER_ID);
		expect(scoped.instanceAdmin).toBe(false);
		expect(agentScopeOf(scoped)).toEqual({
			projectIds: ['proj-a', 'proj-b'],
			holderInstanceAdmin: true,
		});
		expect(agentScopeOf(user())).toBeUndefined();
	});
});
