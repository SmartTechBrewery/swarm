import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import {
	addMember,
	getMembership,
	listMembersForProject,
	listMembersWithUsersForProject,
	listProjectsForUser,
	removeMember,
	updateMemberRole,
} from '../../../src/db/repositories/projectMembersRepository.js';
import { deleteProjectFromDb } from '../../../src/db/repositories/projectsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { projectMembers } from '../../../src/db/schema/projectMembers.js';
import { users } from '../../../src/db/schema/users.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_A = 'proj-members-a';
const PROJECT_B = 'proj-members-b';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'projectMembersRepository (integration)',
	() => {
		let adaId: string;
		let graceId: string;

		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_A, repo: 'jkwiecien/members-a' });
			await seedProject({ id: PROJECT_B, repo: 'jkwiecien/members-b' });
			adaId = (await createUser({ identifier: 'ada@example.com', displayName: 'Ada' })).id;
			graceId = (await createUser({ identifier: 'grace@example.com', displayName: 'Grace' })).id;
		});

		describe('addMember / getMembership', () => {
			it('round-trips a created membership with generated id/createdAt', async () => {
				const created = await addMember({ projectId: PROJECT_A, userId: adaId, role: 'member' });

				expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
				expect(created.projectId).toBe(PROJECT_A);
				expect(created.userId).toBe(adaId);
				expect(created.role).toBe('member');
				expect(created.createdAt).toBeInstanceOf(Date);

				expect(await getMembership(adaId, PROJECT_A)).toEqual(created);
			});

			it('returns undefined for a user who is not a member of the project', async () => {
				await addMember({ projectId: PROJECT_A, userId: adaId, role: 'member' });
				expect(await getMembership(graceId, PROJECT_A)).toBeUndefined();
				expect(await getMembership(adaId, PROJECT_B)).toBeUndefined();
			});

			it('rejects a duplicate (project, user) with a unique violation', async () => {
				await addMember({ projectId: PROJECT_A, userId: adaId, role: 'member' });
				await expect(
					addMember({ projectId: PROJECT_A, userId: adaId, role: 'contributor' }),
				).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23505' }) });
			});
		});

		describe('listMembersForProject / listProjectsForUser', () => {
			it('lists every member of a project and every project of a user', async () => {
				await addMember({ projectId: PROJECT_A, userId: adaId, role: 'projectAdmin' });
				await addMember({ projectId: PROJECT_A, userId: graceId, role: 'contributor' });
				await addMember({ projectId: PROJECT_B, userId: adaId, role: 'member' });

				const membersOfA = await listMembersForProject(PROJECT_A);
				expect(membersOfA.map((m) => m.userId).sort()).toEqual([adaId, graceId].sort());

				const adasProjects = await listProjectsForUser(adaId);
				expect(adasProjects.map((m) => m.projectId).sort()).toEqual([PROJECT_A, PROJECT_B].sort());

				expect(await listProjectsForUser(graceId)).toHaveLength(1);
			});

			it('returns empty arrays for a project/user with no memberships', async () => {
				expect(await listMembersForProject(PROJECT_A)).toEqual([]);
				expect(await listProjectsForUser(adaId)).toEqual([]);
			});
		});

		// The roster read the `members` tRPC router serves (issue #805): one joined
		// query, so an API caller never fans out a `getUserById` per row.
		describe('listMembersWithUsersForProject', () => {
			it('returns each member with the identity a human recognises them by', async () => {
				await addMember({ projectId: PROJECT_A, userId: adaId, role: 'projectAdmin' });
				await addMember({ projectId: PROJECT_A, userId: graceId, role: 'contributor' });

				expect(await listMembersWithUsersForProject(PROJECT_A)).toEqual([
					{
						userId: adaId,
						identifier: 'ada@example.com',
						displayName: 'Ada',
						role: 'projectAdmin',
					},
					{
						userId: graceId,
						identifier: 'grace@example.com',
						displayName: 'Grace',
						role: 'contributor',
					},
				]);
			});

			it('orders by identifier rather than by insertion', async () => {
				await addMember({ projectId: PROJECT_A, userId: graceId, role: 'member' });
				await addMember({ projectId: PROJECT_A, userId: adaId, role: 'member' });

				const members = await listMembersWithUsersForProject(PROJECT_A);
				expect(members.map((member) => member.identifier)).toEqual([
					'ada@example.com',
					'grace@example.com',
				]);
			});

			it('is scoped to the one project', async () => {
				await addMember({ projectId: PROJECT_A, userId: adaId, role: 'member' });
				await addMember({ projectId: PROJECT_B, userId: graceId, role: 'member' });

				const members = await listMembersWithUsersForProject(PROJECT_A);
				expect(members.map((member) => member.identifier)).toEqual(['ada@example.com']);
			});

			it('returns an empty array for a project with no members', async () => {
				expect(await listMembersWithUsersForProject(PROJECT_A)).toEqual([]);
			});

			it('never carries the password hash off the users row', async () => {
				await addMember({ projectId: PROJECT_A, userId: adaId, role: 'member' });

				const [member] = await listMembersWithUsersForProject(PROJECT_A);
				expect(Object.keys(member).sort()).toEqual(['displayName', 'identifier', 'role', 'userId']);
			});
		});

		describe('updateMemberRole', () => {
			it('changes an existing membership role', async () => {
				await addMember({ projectId: PROJECT_A, userId: adaId, role: 'contributor' });
				const updated = await updateMemberRole(adaId, PROJECT_A, 'projectAdmin');
				expect(updated?.role).toBe('projectAdmin');
				expect((await getMembership(adaId, PROJECT_A))?.role).toBe('projectAdmin');
			});

			it('returns undefined for a non-member', async () => {
				expect(await updateMemberRole(adaId, PROJECT_A, 'member')).toBeUndefined();
			});
		});

		describe('removeMember', () => {
			it('removes a membership and reports whether one existed', async () => {
				await addMember({ projectId: PROJECT_A, userId: adaId, role: 'member' });

				expect(await removeMember(adaId, PROJECT_A)).toBe(true);
				expect(await getMembership(adaId, PROJECT_A)).toBeUndefined();
				expect(await removeMember(adaId, PROJECT_A)).toBe(false);
			});
		});

		describe('cascade deletes', () => {
			it('drops memberships when their project is deleted', async () => {
				await addMember({ projectId: PROJECT_A, userId: adaId, role: 'member' });
				await addMember({ projectId: PROJECT_B, userId: adaId, role: 'member' });

				await deleteProjectFromDb(PROJECT_A);

				expect(await getMembership(adaId, PROJECT_A)).toBeUndefined();
				// The other project's membership is untouched.
				expect(await getMembership(adaId, PROJECT_B)).toBeDefined();
			});

			it('drops memberships when their user is deleted', async () => {
				await addMember({ projectId: PROJECT_A, userId: adaId, role: 'member' });
				await addMember({ projectId: PROJECT_A, userId: graceId, role: 'member' });

				await getDb().delete(users).where(eq(users.id, adaId));

				expect(await getMembership(adaId, PROJECT_A)).toBeUndefined();
				const remaining = await getDb()
					.select()
					.from(projectMembers)
					.where(eq(projectMembers.projectId, PROJECT_A));
				expect(remaining.map((row) => row.userId)).toEqual([graceId]);
			});
		});
	},
);
