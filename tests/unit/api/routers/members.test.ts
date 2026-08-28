import { DrizzleQueryError } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/projectMembersRepository.js', () => ({
	addMember: vi.fn(),
	updateMemberRole: vi.fn(),
	removeMember: vi.fn(),
}));

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectRecordByIdFromDb: vi.fn(),
}));

vi.mock('@/db/repositories/usersRepository.js', () => ({
	findUserByIdentifier: vi.fn(),
}));

vi.mock('@/identity/membership-service.js', () => ({
	getMembership: vi.fn(),
	listMembersWithUsers: vi.fn(),
}));

import { membersRouter } from '@/api/routers/members.js';
import {
	addMember,
	type ProjectMemberWithUser,
	removeMember,
	updateMemberRole,
} from '@/db/repositories/projectMembersRepository.js';
import { findProjectRecordByIdFromDb } from '@/db/repositories/projectsRepository.js';
import { findUserByIdentifier } from '@/db/repositories/usersRepository.js';
import type { ProjectMembership, ProjectRole } from '@/identity/membership.js';
import { getMembership, listMembersWithUsers } from '@/identity/membership-service.js';
import type { SwarmUser } from '@/identity/schema.js';
import { createMockProjectRecord } from '../../../helpers/factories.js';

const ADMIN_USER: SwarmUser = {
	id: '00000000-0000-4000-8000-000000000000',
	identifier: 'admin@example.com',
	displayName: 'Admin',
	instanceAdmin: true,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const ORDINARY_USER: SwarmUser = {
	id: '00000000-0000-4000-8000-0000000000ff',
	identifier: 'member@example.com',
	displayName: 'Member',
	instanceAdmin: false,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

/** The member being administered — never the caller. */
const TARGET_USER: SwarmUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'ada@example.com',
	displayName: 'Ada Lovelace',
	instanceAdmin: false,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

function membershipFor(role: ProjectRole, userId = ORDINARY_USER.id): ProjectMembership {
	return {
		id: '99999999-9999-4999-8999-999999999999',
		projectId: 'p1',
		userId,
		role,
		createdAt: new Date(0),
	};
}

const admin = membersRouter.createCaller({ user: ADMIN_USER });
const ordinary = membersRouter.createCaller({ user: ORDINARY_USER });

/** Every procedure, invoked with valid input — the authorization matrix runs over this. */
const PROCEDURES = [
	['list', () => ordinary.list({ projectId: 'p1' })],
	['add', () => ordinary.add({ projectId: 'p1', identifier: TARGET_USER.identifier })],
	[
		'setRole',
		() => ordinary.setRole({ projectId: 'p1', userId: TARGET_USER.id, role: 'projectAdmin' }),
	],
	['remove', () => ordinary.remove({ projectId: 'p1', userId: TARGET_USER.id })],
] as const;

function expectNoRepositoryWrite(): void {
	expect(listMembersWithUsers).not.toHaveBeenCalled();
	expect(addMember).not.toHaveBeenCalled();
	expect(updateMemberRole).not.toHaveBeenCalled();
	expect(removeMember).not.toHaveBeenCalled();
}

describe('membersRouter', () => {
	beforeEach(() => {
		vi.mocked(getMembership).mockReset();
		vi.mocked(listMembersWithUsers).mockReset();
		vi.mocked(addMember).mockReset();
		vi.mocked(updateMemberRole).mockReset();
		vi.mocked(removeMember).mockReset();
		vi.mocked(findProjectRecordByIdFromDb).mockReset();
		vi.mocked(findUserByIdentifier).mockReset();

		// The happy-path defaults; each suite overrides what it is actually asserting.
		vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));
		vi.mocked(listMembersWithUsers).mockResolvedValue([]);
		vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(createMockProjectRecord({ id: 'p1' }));
		vi.mocked(findUserByIdentifier).mockResolvedValue(TARGET_USER);
		vi.mocked(addMember).mockResolvedValue(membershipFor('member', TARGET_USER.id));
		vi.mocked(updateMemberRole).mockResolvedValue(membershipFor('projectAdmin', TARGET_USER.id));
		vi.mocked(removeMember).mockResolvedValue(true);
	});

	// The core of the suite: administering the roster is administering the project,
	// so every procedure draws the same boundary `assertProjectAccess` defines.
	describe('project-scoped authorization', () => {
		it.each(
			PROCEDURES,
		)('%s denies a non-member with NOT_FOUND, touching nothing', async (_name, call) => {
			vi.mocked(getMembership).mockResolvedValue(undefined);

			await expect(call()).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					// Identical to the message a genuinely missing project produces, so a
					// denial never reveals that the project exists.
					message: 'Project with ID "p1" not found',
				}),
			);
			expectNoRepositoryWrite();
		});

		it.each(PROCEDURES)('%s forbids a member', async (_name, call) => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('member'));

			await expect(call()).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
			expectNoRepositoryWrite();
		});

		it.each(PROCEDURES)('%s forbids a contributor', async (_name, call) => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

			await expect(call()).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
			expectNoRepositoryWrite();
		});

		it.each(PROCEDURES)('%s admits a projectAdmin', async (_name, call) => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));

			await expect(call()).resolves.not.toThrow();
		});

		it('admits an instanceAdmin who is a member of nothing, without a membership read', async () => {
			vi.mocked(getMembership).mockResolvedValue(undefined);

			await expect(admin.list({ projectId: 'p1' })).resolves.toEqual([]);
			await expect(
				admin.add({ projectId: 'p1', identifier: TARGET_USER.identifier }),
			).resolves.toBeDefined();
			await expect(
				admin.setRole({ projectId: 'p1', userId: TARGET_USER.id, role: 'member' }),
			).resolves.toBeDefined();
			await expect(
				admin.remove({ projectId: 'p1', userId: TARGET_USER.id }),
			).resolves.toBeDefined();
			expect(getMembership).not.toHaveBeenCalled();
		});
	});

	describe('list', () => {
		it('returns exactly what the membership service resolved', async () => {
			const roster: ProjectMemberWithUser[] = [
				{
					userId: TARGET_USER.id,
					identifier: 'ada@example.com',
					displayName: 'Ada Lovelace',
					role: 'projectAdmin',
				},
				{
					userId: ORDINARY_USER.id,
					identifier: 'grace@example.com',
					displayName: 'Grace Hopper',
					role: 'contributor',
				},
			];
			vi.mocked(listMembersWithUsers).mockResolvedValue(roster);

			// `toEqual` on the whole result, so the projection is pinned: a password
			// hash or a raw row cannot start riding along unnoticed.
			await expect(ordinary.list({ projectId: 'p1' })).resolves.toEqual(roster);
			expect(listMembersWithUsers).toHaveBeenCalledWith('p1');
		});
	});

	describe('add', () => {
		it('resolves the identifier to a user id and defaults the role to member', async () => {
			await expect(
				ordinary.add({ projectId: 'p1', identifier: TARGET_USER.identifier }),
			).resolves.toEqual({
				userId: TARGET_USER.id,
				identifier: TARGET_USER.identifier,
				displayName: TARGET_USER.displayName,
				role: 'member',
			});
			expect(addMember).toHaveBeenCalledWith({
				projectId: 'p1',
				userId: TARGET_USER.id,
				role: 'member',
			});
		});

		it('passes an explicit role through', async () => {
			await expect(
				ordinary.add({ projectId: 'p1', identifier: TARGET_USER.identifier, role: 'projectAdmin' }),
			).resolves.toMatchObject({ role: 'projectAdmin' });
			expect(addMember).toHaveBeenCalledWith({
				projectId: 'p1',
				userId: TARGET_USER.id,
				role: 'projectAdmin',
			});
		});

		it('refuses an unknown identifier with NOT_FOUND rather than creating a user', async () => {
			vi.mocked(findUserByIdentifier).mockResolvedValue(undefined);

			await expect(
				ordinary.add({ projectId: 'p1', identifier: 'nobody@example.com' }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: expect.stringContaining('nobody@example.com'),
				}),
			);
			expect(addMember).not.toHaveBeenCalled();
		});

		// Only an instanceAdmin reaches this branch — `assertProjectAccess` returns
		// early for them without proving the project exists, so an unchecked id would
		// surface as a foreign-key 500.
		it('refuses an unknown project with NOT_FOUND instead of an FK violation', async () => {
			vi.mocked(findProjectRecordByIdFromDb).mockResolvedValue(undefined);

			await expect(
				admin.add({ projectId: 'nope', identifier: TARGET_USER.identifier }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "nope" not found',
				}),
			);
			expect(findUserByIdentifier).not.toHaveBeenCalled();
			expect(addMember).not.toHaveBeenCalled();
		});

		it('reports an existing membership as CONFLICT pointing at setRole', async () => {
			const pgError = Object.assign(new Error('duplicate key value'), { code: '23505' });
			vi.mocked(addMember).mockRejectedValue(pgError);

			await expect(
				ordinary.add({ projectId: 'p1', identifier: TARGET_USER.identifier }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'CONFLICT',
					message: expect.stringContaining('setRole'),
				}),
			);
		});

		it('recognises the same violation once drizzle has wrapped it', async () => {
			// A node-postgres query error arrives inside a `DrizzleQueryError`, which
			// has no top-level `code` — the real pg error is on `.cause`.
			const pgError = Object.assign(new Error('duplicate key value'), { code: '23505' });
			vi.mocked(addMember).mockRejectedValue(
				new DrizzleQueryError('insert into "project_members" ...', [], pgError),
			);

			await expect(
				ordinary.add({ projectId: 'p1', identifier: TARGET_USER.identifier }),
			).rejects.toThrowError(expect.objectContaining({ code: 'CONFLICT' }));
		});

		it('lets an unrelated repository failure through unchanged', async () => {
			vi.mocked(addMember).mockRejectedValue(new Error('connection terminated'));

			await expect(
				ordinary.add({ projectId: 'p1', identifier: TARGET_USER.identifier }),
			).rejects.toThrowError('connection terminated');
		});

		it('rejects a role outside the enum before any resolver runs', async () => {
			await expect(
				// biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
				ordinary.add({ projectId: 'p1', identifier: 'ada@example.com', role: 'owner' as any }),
			).rejects.toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
			expect(getMembership).not.toHaveBeenCalled();
			expect(addMember).not.toHaveBeenCalled();
		});
	});

	describe('setRole', () => {
		it('changes the role of an existing member', async () => {
			vi.mocked(updateMemberRole).mockResolvedValue(membershipFor('member', TARGET_USER.id));

			await expect(
				ordinary.setRole({ projectId: 'p1', userId: TARGET_USER.id, role: 'member' }),
			).resolves.toEqual({ userId: TARGET_USER.id, role: 'member' });
			expect(updateMemberRole).toHaveBeenCalledWith(TARGET_USER.id, 'p1', 'member');
		});

		it('answers NOT_FOUND when the user is not a member', async () => {
			vi.mocked(updateMemberRole).mockResolvedValue(undefined);

			await expect(
				ordinary.setRole({ projectId: 'p1', userId: TARGET_USER.id, role: 'member' }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: expect.stringContaining('is not a member of this project'),
				}),
			);
		});

		it('rejects a non-uuid userId before any resolver runs', async () => {
			await expect(
				ordinary.setRole({ projectId: 'p1', userId: 'ada@example.com', role: 'member' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
			expect(getMembership).not.toHaveBeenCalled();
			expect(updateMemberRole).not.toHaveBeenCalled();
		});
	});

	describe('remove', () => {
		it('removes an existing member', async () => {
			await expect(ordinary.remove({ projectId: 'p1', userId: TARGET_USER.id })).resolves.toEqual({
				userId: TARGET_USER.id,
			});
			expect(removeMember).toHaveBeenCalledWith(TARGET_USER.id, 'p1');
		});

		it('answers NOT_FOUND when the user is not a member', async () => {
			vi.mocked(removeMember).mockResolvedValue(false);

			await expect(
				ordinary.remove({ projectId: 'p1', userId: TARGET_USER.id }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: expect.stringContaining('is not a member of this project'),
				}),
			);
		});

		// No last-administrator guard, deliberately: `swarm members` has none, and the
		// two paths must not disagree (see the router's header).
		it('removes the last projectAdmin without a special case', async () => {
			vi.mocked(removeMember).mockResolvedValue(true);

			await expect(admin.remove({ projectId: 'p1', userId: TARGET_USER.id })).resolves.toEqual({
				userId: TARGET_USER.id,
			});
		});
	});
});
