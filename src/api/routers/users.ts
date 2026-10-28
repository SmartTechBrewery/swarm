/**
 * Installation **user administration** over tRPC (issue #1151) — the dashboard
 * twin of `swarm users` (`src/cli/commands/users.ts`): list, create, issue a
 * password link, grant and revoke installation admin. The CLI is unchanged and
 * stays the `DATABASE_URL`-side path.
 *
 * **Authorization is enforced here, not on the screen.** Every procedure, `list`
 * included, is instance-administrator only, checked in {@link userAdminProcedure}
 * before input validation or any repository call, so a non-admin gets
 * `FORBIDDEN` whatever they send.
 *
 * Decisions worth not re-deriving:
 *
 * 1. **Addressing follows `members.ts`.** `create` takes the `identifier` the
 *    admin types; every other mutation takes the `userId` read off `list`.
 * 2. **Passwords travel as links, never values.** `create` and
 *    `issuePasswordLink` return the raw single-use token once, in the response
 *    body, and the dashboard builds `/set-password?token=…` from its own origin
 *    (the server does not reliably know it). The admin never chooses or sees the
 *    user's password; `POST /auth/set-password` (`src/api/server.ts`) redeems it.
 * 3. **`revokeAdmin` refuses the last installation admin**, under a table lock
 *    (`revokeInstanceAdminUnlessLast`), so this no-shell path cannot leave an
 *    installation nobody can administer. `swarm users revoke-admin` has no such
 *    guard on purpose: whoever holds the shell can always `grant-admin` again.
 * 4. **Identity links (`identities.*`, issue #1167) are the dashboard twin of
 *    `swarm identities`**, under the same guard: the `(provider, handle)` links
 *    assignee affinity routes on (`src/identity/assignee-resolver.ts`). `link`
 *    keeps the repository's semantics — re-linking the same pair is a no-op, a
 *    handle owned by another user is refused — and only adds the owner's name to
 *    the refusal. `link` takes a registered PM provider id; `unlink` takes any
 *    stored provider key, so a row the CLI wrote under a legacy or mistyped key
 *    can still be removed from the screen that lists it. Resolution reads the
 *    table on every dispatch, so a change applies with no restart.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	linkIdentity,
	listIdentities,
	unlinkIdentity,
} from '../../db/repositories/userIdentitiesRepository.js';
import {
	getUserById,
	listUsers,
	revokeInstanceAdminUnlessLast,
	setInstanceAdmin,
} from '../../db/repositories/usersRepository.js';
import { createUserWithPasswordLink, issuePasswordLink } from '../../identity/password-link.js';
import { isInstanceAdmin, UserDisplayNameSchema } from '../../identity/schema.js';
import { IdentityLinkConflictError } from '../../identity/user-identity.js';
import { PmProviderIdSchema } from '../../pm/events.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * `authedProcedure` narrowed to installation administrators. A local guard
 * rather than `assertInstanceAdmin` (`../authz.ts`) for
 * `assertInstanceCredentialAdmin`'s reason: that helper's copy is worded for a
 * read-only installation *view*.
 */
const userAdminProcedure = authedProcedure.use(({ ctx, next }) => {
	if (!isInstanceAdmin(ctx.user)) {
		throw new TRPCError({
			code: 'FORBIDDEN',
			message: 'Users are managed by installation administrators only.',
		});
	}
	return next();
});

const UserIdInput = z.object({ userId: z.string().uuid() });

function userNotFound(userId: string): TRPCError {
	return new TRPCError({ code: 'NOT_FOUND', message: `No SWARM user with ID "${userId}".` });
}

/** `CONFLICT` naming the user who already owns the handle, by name when they still exist. */
async function identityConflict(err: IdentityLinkConflictError): Promise<TRPCError> {
	const owner = await getUserById(err.existingUserId);
	const ownerLabel = owner ? `${owner.displayName} (${owner.identifier})` : err.existingUserId;
	return new TRPCError({
		code: 'CONFLICT',
		message: `Handle "${err.handle}" on ${err.provider} is already linked to ${ownerLabel}. Unlink it from that user first.`,
	});
}

const identitiesRouter = router({
	// Every link on the installation; the panel groups them by user against `list`.
	list: userAdminProcedure.query(async () => listIdentities()),

	link: userAdminProcedure
		.input(
			z.object({
				userId: z.string().uuid(),
				provider: PmProviderIdSchema,
				handle: z.string().trim().min(1),
			}),
		)
		.mutation(async ({ input }) => {
			// Checked first so an unknown id is a NOT_FOUND, never a raw FK violation.
			if (!(await getUserById(input.userId))) throw userNotFound(input.userId);
			try {
				return await linkIdentity(input);
			} catch (err) {
				if (err instanceof IdentityLinkConflictError) throw await identityConflict(err);
				throw err;
			}
		}),

	unlink: userAdminProcedure
		.input(z.object({ provider: z.string().trim().min(1), handle: z.string().trim().min(1) }))
		.mutation(async ({ input }) => {
			if (!(await unlinkIdentity(input.provider, input.handle))) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `"${input.handle}" is not linked on ${input.provider}.`,
				});
			}
		}),
});

export const usersRouter = router({
	list: userAdminProcedure.query(async () => listUsers()),

	// Create a user with no password and hand back their first password link.
	// The display name defaults to the identifier, as `swarm users add` does.
	create: userAdminProcedure
		.input(
			z.object({
				identifier: z.string().trim().min(1),
				displayName: UserDisplayNameSchema.optional(),
				instanceAdmin: z.boolean().default(false),
			}),
		)
		.mutation(async ({ input }) => {
			const result = await createUserWithPasswordLink({
				identifier: input.identifier,
				displayName: input.displayName ?? input.identifier,
				instanceAdmin: input.instanceAdmin,
			});
			if (result.outcome === 'identifier-taken') {
				throw new TRPCError({
					code: 'CONFLICT',
					message: `A user with identifier "${input.identifier}" already exists — issue them a password link instead.`,
				});
			}
			return result.link;
		}),

	// A reset link for an existing user; replaces any link issued before it.
	issuePasswordLink: userAdminProcedure.input(UserIdInput).mutation(async ({ input }) => {
		const link = await issuePasswordLink(input.userId);
		if (!link) throw userNotFound(input.userId);
		return link;
	}),

	grantAdmin: userAdminProcedure.input(UserIdInput).mutation(async ({ input }) => {
		const user = await setInstanceAdmin(input.userId, true);
		if (!user) throw userNotFound(input.userId);
		return user;
	}),

	revokeAdmin: userAdminProcedure.input(UserIdInput).mutation(async ({ input }) => {
		const result = await revokeInstanceAdminUnlessLast(input.userId);
		if (result.outcome === 'not-found') throw userNotFound(input.userId);
		if (result.outcome === 'last-admin') {
			throw new TRPCError({
				code: 'PRECONDITION_FAILED',
				message:
					'This is the last installation administrator. Grant admin to another user before revoking it here.',
			});
		}
		return result.user;
	}),

	identities: identitiesRouter,
});
