/**
 * Project-scoped **authorization** for the tRPC API (#281 task 4) — the
 * enforcement layer that finally consumes the identity context (task 2) and the
 * membership read model (task 3). Where `authedProcedure` (`./trpc.ts`) answers
 * *"is there a signed-in user?"*, these helpers answer *"may this user touch
 * this project, at this level?"* — the second of ADR-001's three authorization
 * layers (installation role → project membership → worker enrollment;
 * `docs/decisions/ADR-001-federated-workers-and-project-access.md`).
 *
 * The role → capability matrix, defined here once and referenced by every
 * project-scoped procedure (`routers/projects.ts`, `routers/runs.ts`, the nested
 * `routers/credentials.ts`):
 *
 * | Capability                                   | Min role      | Predicate            |
 * | -------------------------------------------- | ------------- | -------------------- |
 * | Read a project / its runs / its credentials  | `contributor` | `canReadProject`     |
 * | Drive a project's runs (retry/terminate/…)   | `member`      | `canWriteProject`    |
 * | Administer config / credentials / delete     | `projectAdmin`| `canAdministerProject`|
 * | Read an installation-wide view (runs/workers)| —             | `assertInstanceAdmin`|
 *
 * That last row is deliberately roleless: it is a **layer-1** check, decided by
 * the installation role alone (see {@link assertInstanceAdmin}), and no project
 * membership grants it.
 *
 * An `instanceAdmin` (installation role, layer 1) bypasses every check and
 * accesses every project. A user with *no* membership cannot even learn a
 * project exists — reads and mutations alike surface `NOT_FOUND`, not
 * `FORBIDDEN`, so the API never leaks which project ids are real. A member whose
 * role is below the required level gets `FORBIDDEN` (they already know the
 * project exists). The three named roles and their ordering are the source of
 * truth in `../identity/membership.ts`; this module only maps procedures onto
 * them.
 */

import { TRPCError } from '@trpc/server';
import { type ProjectRole, roleAtLeast } from '../identity/membership.js';
import { getMembership, listAccessibleProjectIds } from '../identity/membership-service.js';
import { isInstanceAdmin, type SwarmUser } from '../identity/schema.js';

/**
 * The `NOT_FOUND` a non-member (or anyone querying an unknown id) receives — the
 * same shape the routers already throw for a genuinely missing project, so a
 * denial is indistinguishable from a non-existent project and existence never
 * leaks. Kept identical to the routers' own message.
 */
function projectNotFound(projectId: string, notFoundMessage?: string): TRPCError {
	return new TRPCError({
		code: 'NOT_FOUND',
		message: notFoundMessage ?? `Project with ID "${projectId}" not found`,
	});
}

/**
 * Throw unless `user` is an installation administrator — the layer-1 gate the
 * **installation-wide** dashboard views run behind (issue #647). The global
 * `/runs` and `/workers` screens read across every project on the instance,
 * which is an operator's view of the installation rather than a member's view of
 * their own work, so the installation role decides it and project membership
 * does not enter into it.
 *
 * `FORBIDDEN`, not the `NOT_FOUND` the project-scoped helpers use: there is no
 * existence to hide — the caller named no project id, only a fixed
 * installation-wide view — so the honest answer is that the view is not theirs.
 * `view` names it in the copy ("runs", "queue", "workers").
 *
 * Synchronous on purpose: it reads a flag already on `ctx.user` and must not
 * imply a database read. Project-scoped reads are untouched — an enrolled worker
 * owner still reads their projects' runs and workers through
 * {@link assertProjectAccess}.
 */
export function assertInstanceAdmin(user: SwarmUser, view: string): void {
	if (isInstanceAdmin(user)) return;
	throw new TRPCError({
		code: 'FORBIDDEN',
		message: `The installation-wide ${view} view is available to instance administrators only. Open a project you are enrolled in to see its ${view}.`,
	});
}

/**
 * Throw unless `user` may act on `projectId` at (at least) `minRole`. Resolves
 * to nothing on success. An `instanceAdmin` always passes; a non-member gets
 * `NOT_FOUND` (existence hidden); a member below `minRole` gets `FORBIDDEN`. See
 * the matrix in this file's header for which procedures pass which `minRole`.
 * Pass `notFoundMessage` when checking access via a resource look-up (e.g. a run)
 * so non-member denials match the resource-not-found error shape instead of leaking
 * project existence.
 */
export async function assertProjectAccess(
	user: SwarmUser,
	projectId: string,
	minRole: ProjectRole,
	notFoundMessage?: string,
): Promise<void> {
	if (isInstanceAdmin(user)) return;

	const membership = await getMembership(user.id, projectId);
	if (!membership) {
		throw projectNotFound(projectId, notFoundMessage);
	}
	if (!roleAtLeast(membership.role, minRole)) {
		throw new TRPCError({
			code: 'FORBIDDEN',
			message: `You do not have permission to perform this action on project "${projectId}".`,
		});
	}
}

/**
 * Whether `user` may act on `projectId` at (at least) `minRole` — the
 * non-throwing counterpart to {@link assertProjectAccess}, applying the identical
 * rule (an `instanceAdmin` always may; anyone else needs a membership at
 * `minRole` or above).
 *
 * For a procedure that *reports* a capability instead of enforcing it: a read
 * model telling the dashboard which controls to offer (issue #477 — the Workers
 * detail view asks whether the viewer administers each project so it never draws
 * an approve/suspend control that would come back `FORBIDDEN`). Enforcement still
 * happens in the mutation itself, which calls `assertProjectAccess`; this only
 * spares the client from guessing.
 */
export async function mayAccessProject(
	user: SwarmUser,
	projectId: string,
	minRole: ProjectRole,
): Promise<boolean> {
	if (isInstanceAdmin(user)) return true;
	const membership = await getMembership(user.id, projectId);
	return membership !== undefined && roleAtLeast(membership.role, minRole);
}

/**
 * The set of project ids `user` may access, or `null` when there is no
 * restriction at all (an `instanceAdmin` sees every project). Callers scoping a
 * cross-project query treat `null` as "no filter" and an empty array as "match
 * nothing". Backs both {@link filterAccessibleProjects} and the runs router's
 * cross-project list/queued scoping.
 */
export async function accessibleProjectScope(user: SwarmUser): Promise<string[] | null> {
	if (isInstanceAdmin(user)) return null;
	return listAccessibleProjectIds(user.id);
}

/**
 * Narrow an already-fetched list of projects to the ones `user` may see — an
 * `instanceAdmin` keeps the whole list, anyone else keeps only their membership
 * set. Used by `projects.list`, which lists every project and then filters,
 * rather than pushing the id set into the query.
 */
export async function filterAccessibleProjects<T extends { id: string }>(
	user: SwarmUser,
	projects: T[],
): Promise<T[]> {
	const scope = await accessibleProjectScope(user);
	if (scope === null) return projects;
	const accessible = new Set(scope);
	return projects.filter((project) => accessible.has(project.id));
}
