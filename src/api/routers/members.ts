/**
 * Project **membership** over tRPC (issue #805) — add / list / set-role /
 * remove, the four operations `swarm members` (`src/cli/commands/members.ts`)
 * has always exposed, reachable by a project administrator instead of only from
 * the machine holding `DATABASE_URL`.
 *
 * This is a second path, not a replacement: the CLI is unchanged and stays the
 * `DATABASE_URL`-side one, which is why nothing here invents policy. Every
 * procedure is gated by `assertProjectAccess(user, projectId, 'projectAdmin')`
 * (`../authz.ts`), so an `instanceAdmin` bypasses (layer 1), a non-member gets
 * the existence-hiding `NOT_FOUND`, and a `member`/`contributor` gets
 * `FORBIDDEN` — the same boundary `projects.listMembershipRequests` draws,
 * because administering the roster is administering the project. The role model,
 * its ranking, and its predicates are `../../identity/membership.ts`'s, reused
 * verbatim; there is no new table, column, or policy.
 *
 * Two shape decisions worth not re-deriving:
 *
 * 1. **`add` takes an `identifier`, `setRole`/`remove` take a `userId`.** Adding
 *    is the one operation whose subject the caller has to *name* — they are
 *    typing a colleague's login handle — while the other two address a row the
 *    caller just read off `list`, where the generated uuid is the stable key and
 *    a re-typed identifier could address a different account. The CLI is
 *    identifier-keyed throughout because it has no list to click.
 * 2. **`list` requires `projectAdmin`, not `contributor`.** It is the
 *    administration read that backs an administrator tab (the phase-2 dashboard
 *    UI), exactly like the membership-request reads. Widening it to "every member
 *    may see the roster" is a separate decision with no caller today.
 *
 * Reads go through the membership service (`../../identity/membership-service.ts`),
 * the seam every router already reads membership through; writes go straight to
 * `projectMembersRepository.ts`, as `projects.ts` already does for membership
 * requests.
 *
 * Deliberately absent: a "last project administrator" guard on `remove`/`setRole`.
 * `swarm members` has none, an `instanceAdmin` can always restore access, and
 * inventing one here would make the two paths disagree.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	addMember,
	removeMember,
	updateMemberRole,
} from '../../db/repositories/projectMembersRepository.js';
import { findProjectRecordByIdFromDb } from '../../db/repositories/projectsRepository.js';
import { findUserByIdentifier } from '../../db/repositories/usersRepository.js';
import { ProjectRoleSchema } from '../../identity/membership.js';
import { listMembersWithUsers } from '../../identity/membership-service.js';
import { assertProjectAccess } from '../authz.js';
import { authedProcedure, router } from '../trpc.js';

function hasUniqueViolationCode(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code: unknown }).code === '23505'
	);
}

/**
 * drizzle-orm wraps every node-postgres query error in a `DrizzleQueryError`,
 * which has no top-level `code` — the original pg error (the one carrying
 * `code: '23505'` for a unique violation) is on `.cause`. Check both so this
 * still matches once drizzle's wrapping is in the way. Copied from `projects.ts`
 * rather than extracted: ten lines here is a smaller change than a shared module
 * plus re-pointing two existing call sites.
 */
function isUniqueViolation(error: unknown): boolean {
	return (
		hasUniqueViolationCode(error) || (error instanceof Error && hasUniqueViolationCode(error.cause))
	);
}

/** The `NOT_FOUND` message `authz.ts` and the other routers use, kept identical. */
function projectNotFoundMessage(projectId: string): string {
	return `Project with ID "${projectId}" not found`;
}

export const membersRouter = router({
	// The project's members with the identity a human recognises them by, in one
	// joined query (`listMembersWithUsers`) rather than the CLI's per-row lookup.
	list: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			return await listMembersWithUsers(input.projectId);
		}),

	// Add an *existing* SWARM user, named by login handle, in a chosen role.
	// Creating the user is not this router's job — `swarm users add` stays the only
	// path — so an unknown identifier is NOT_FOUND rather than an implicit signup.
	add: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				identifier: z.string().trim().min(1),
				role: ProjectRoleSchema.default('member'),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');

			// `assertProjectAccess` returns early for an `instanceAdmin` without
			// touching the database, so it never proves the project exists. Without
			// this an admin's typo becomes a pg foreign-key 500 instead of NOT_FOUND.
			const project = await findProjectRecordByIdFromDb(input.projectId);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: projectNotFoundMessage(input.projectId),
				});
			}

			const user = await findUserByIdentifier(input.identifier);
			if (!user) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `No SWARM user with identifier "${input.identifier}". Create them with \`swarm users add\` first.`,
				});
			}

			try {
				await addMember({ projectId: input.projectId, userId: user.id, role: input.role });
			} catch (error) {
				if (isUniqueViolation(error)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: `"${input.identifier}" is already a member of this project — use setRole to change their role.`,
					});
				}
				throw error;
			}

			return {
				userId: user.id,
				identifier: user.identifier,
				displayName: user.displayName,
				role: input.role,
			};
		}),

	// Re-role an existing member, keyed on the user id `list` returned. A user who
	// is not a member is NOT_FOUND — there is no membership to change, and adding
	// one is `add`.
	setRole: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				userId: z.string().uuid(),
				role: ProjectRoleSchema,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');

			const updated = await updateMemberRole(input.userId, input.projectId, input.role);
			if (!updated) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `User "${input.userId}" is not a member of this project`,
				});
			}
			return { userId: updated.userId, role: updated.role };
		}),

	// Remove a member. NOT_FOUND when there was no membership, so a caller acting
	// on a stale roster learns that rather than reading it as a successful removal.
	remove: authedProcedure
		.input(z.object({ projectId: z.string().min(1), userId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');

			const removed = await removeMember(input.userId, input.projectId);
			if (!removed) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `User "${input.userId}" is not a member of this project`,
				});
			}
			return { userId: input.userId };
		}),
});
