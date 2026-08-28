/**
 * Project-membership persistence — plain functions, one `getDb()` per call, no
 * class, mirroring `usersRepository.ts` / `projectsRepository.ts`. Backs the
 * `project_members` table (`src/db/schema/projectMembers.ts`), the persisted
 * form of `ProjectMembership` (`src/identity/membership.ts`, the source of truth
 * for the shape).
 *
 * A `project_members` row already carries the domain's exact types, so mapping a
 * row back to `ProjectMembership` is a re-assembly, not a re-validation — same as
 * `rowToSwarmUser` (`role` is persisted as free `text`, so it is cast back to the
 * `ProjectRole` enum the writers here only ever store). Adding a membership that
 * already exists surfaces the raw pg `23505` unique violation on
 * `(project_id, user_id)`; the caller (the `swarm members` CLI, or the `members`
 * tRPC router since issue #805) translates it to a friendly message. Lookups that
 * find nothing return `undefined`/`[]` — a not-found, not an error
 * (ai/CODING_STANDARDS.md "Error handling").
 */

import { and, asc, eq } from 'drizzle-orm';

import type { ProjectMembership, ProjectRole } from '../../identity/membership.js';
import { getDb } from '../client.js';
import { projectMembers } from '../schema/projectMembers.js';
import { users } from '../schema/users.js';

type ProjectMemberRow = typeof projectMembers.$inferSelect;

/**
 * A membership joined to the identity a human recognises the member by — the read
 * model behind `members.list` (`src/api/routers/members.ts`, issue #805), which
 * renders a roster and cannot show raw uuids.
 *
 * Deliberately **not** a `ProjectMembership`: it carries no `id` and no
 * `createdAt`. The membership row's own id addresses nothing a caller can use
 * (`setRole`/`remove` are keyed on `(project, user)`), and a `Date` would cross
 * the tRPC link untransformed — the roster shows who and in what role, so both
 * are omitted rather than serialized.
 */
export interface ProjectMemberWithUser {
	userId: string;
	identifier: string;
	displayName: string;
	role: ProjectRole;
}

/** The fields a caller supplies to create a membership; `id`/`createdAt` are generated. */
export interface AddMemberInput {
	projectId: string;
	userId: string;
	role: ProjectRole;
}

/** Re-assemble a `ProjectMembership` from a persisted `project_members` row. */
function rowToMembership(row: ProjectMemberRow): ProjectMembership {
	return {
		id: row.id,
		projectId: row.projectId,
		userId: row.userId,
		role: row.role as ProjectRole,
		createdAt: row.createdAt,
	};
}

/**
 * Add a membership. Rejects with the pg `23505` unique violation if this user is
 * already a member of this project (at most one role per `(project, user)`) —
 * changing an existing member's role is {@link updateMemberRole}, not a re-add.
 */
export async function addMember(input: AddMemberInput): Promise<ProjectMembership> {
	const [row] = await getDb()
		.insert(projectMembers)
		.values({ projectId: input.projectId, userId: input.userId, role: input.role })
		.returning();
	return rowToMembership(row);
}

/** Resolve a user's membership of one project. Returns `undefined` if the user is not a member. */
export async function getMembership(
	userId: string,
	projectId: string,
): Promise<ProjectMembership | undefined> {
	const rows = await getDb()
		.select()
		.from(projectMembers)
		.where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectId)))
		.limit(1);
	const row = rows[0];
	return row ? rowToMembership(row) : undefined;
}

/** List every membership of a project, oldest first. Empty if the project has no members. */
export async function listMembersForProject(projectId: string): Promise<ProjectMembership[]> {
	const rows = await getDb()
		.select()
		.from(projectMembers)
		.where(eq(projectMembers.projectId, projectId))
		.orderBy(asc(projectMembers.createdAt), asc(projectMembers.id));
	return rows.map(rowToMembership);
}

/**
 * Every member of a project with the user behind each row, alphabetical by
 * login handle — one joined query rather than the `swarm members list` CLI's
 * `getUserById` per row, which is what makes this fit an API caller.
 *
 * The selected columns are listed explicitly and are exactly
 * {@link ProjectMemberWithUser}: `users.passwordHash` is credential material
 * that never leaves the DB layer (`src/db/schema/users.ts`), so a `select()`
 * over the whole joined row is not an option here.
 */
export async function listMembersWithUsersForProject(
	projectId: string,
): Promise<ProjectMemberWithUser[]> {
	const rows = await getDb()
		.select({
			userId: projectMembers.userId,
			identifier: users.identifier,
			displayName: users.displayName,
			role: projectMembers.role,
		})
		.from(projectMembers)
		.innerJoin(users, eq(users.id, projectMembers.userId))
		.where(eq(projectMembers.projectId, projectId))
		.orderBy(asc(users.identifier));
	return rows.map((row) => ({ ...row, role: row.role as ProjectRole }));
}

/** List every project membership a user holds, oldest first. Empty if the user belongs to no project. */
export async function listProjectsForUser(userId: string): Promise<ProjectMembership[]> {
	const rows = await getDb()
		.select()
		.from(projectMembers)
		.where(eq(projectMembers.userId, userId))
		.orderBy(asc(projectMembers.createdAt), asc(projectMembers.id));
	return rows.map(rowToMembership);
}

/**
 * Change a member's role on a project. Returns the updated membership, or
 * `undefined` if the user is not a member of that project (nothing to update).
 */
export async function updateMemberRole(
	userId: string,
	projectId: string,
	role: ProjectRole,
): Promise<ProjectMembership | undefined> {
	const [row] = await getDb()
		.update(projectMembers)
		.set({ role })
		.where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectId)))
		.returning();
	return row ? rowToMembership(row) : undefined;
}

/**
 * Remove a user's membership of a project. Returns `true` if a membership was
 * removed, `false` if the user was not a member (a no-op, not an error).
 */
export async function removeMember(userId: string, projectId: string): Promise<boolean> {
	const rows = await getDb()
		.delete(projectMembers)
		.where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectId)))
		.returning({ id: projectMembers.id });
	return rows.length > 0;
}
