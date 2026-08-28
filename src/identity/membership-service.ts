/**
 * Provider-neutral **membership read model** — the thin domain surface later
 * phases consume (authorization enforcement, dashboard project screens; #281
 * tasks 4/5) so they never touch the `project_members` table directly. The
 * membership-side companion to the identity read model (`./service.ts`) and the
 * second slice of the multi-user foundation (ADR-001, issue #281).
 *
 * Reads only — creating/updating/removing memberships goes straight to
 * `projectMembersRepository.ts`, from the `swarm members` CLI and, since issue
 * #805, the `members` tRPC router; this service stays the read-side seam callers
 * program against. The role predicates
 * (`canAdministerProject`/`canWriteProject`/`canReadProject`) are re-exported
 * from `./membership.ts` so a caller has one import for the whole read model.
 */

import {
	getMembership as getMembershipRow,
	listMembersForProject as listMembersForProjectRows,
	listMembersWithUsersForProject as listMembersWithUsersForProjectRows,
	listProjectsForUser as listProjectsForUserRows,
	type ProjectMemberWithUser,
} from '../db/repositories/projectMembersRepository.js';
import { listAllProjectsFromDb } from '../db/repositories/projectsRepository.js';
import type { ProjectMembership } from './membership.js';
import { isInstanceAdmin } from './service.js';

export type { ProjectMemberWithUser } from '../db/repositories/projectMembersRepository.js';
export {
	canAdministerProject,
	canReadProject,
	canWriteProject,
	type ProjectMembership,
	type ProjectRole,
} from './membership.js';

/** A user's membership of one project, or `undefined` if they are not a member. */
export async function getMembership(
	userId: string,
	projectId: string,
): Promise<ProjectMembership | undefined> {
	return getMembershipRow(userId, projectId);
}

/** Every membership of a project (empty if it has no members). */
export async function listMembersForProject(projectId: string): Promise<ProjectMembership[]> {
	return listMembersForProjectRows(projectId);
}

/**
 * Every member of a project with the user behind each row, alphabetical by login
 * handle (empty if it has no members) — the roster read model `members.list`
 * serves (issue #805). One joined query, so a caller never fans out a
 * `getUserById` per row to turn a `userId` into something a human recognises.
 */
export async function listMembersWithUsers(projectId: string): Promise<ProjectMemberWithUser[]> {
	return listMembersWithUsersForProjectRows(projectId);
}

/** Every project membership a user holds (empty if they belong to no project). */
export async function listProjectsForUser(userId: string): Promise<ProjectMembership[]> {
	return listProjectsForUserRows(userId);
}

/**
 * The set of project ids a user may access — the read model authorization
 * builds on. An installation admin (`isInstanceAdmin`, `./service.ts`) accesses
 * *every* project, so this returns all project ids; any other user accesses only
 * the projects they are a member of. Ids are returned de-duplicated and sorted
 * for a stable, comparable result.
 */
export async function listAccessibleProjectIds(userId: string): Promise<string[]> {
	if (await isInstanceAdmin(userId)) {
		const projects = await listAllProjectsFromDb();
		return projects.map((project) => project.id).sort();
	}
	const memberships = await listProjectsForUserRows(userId);
	return [...new Set(memberships.map((membership) => membership.projectId))].sort();
}
