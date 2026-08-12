import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { changeOwnPassword } from '../../identity/auth.js';
import { UserDisplayNameSchema } from '../../identity/schema.js';
import { renameUser } from '../../identity/service.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * The signed-in user's own account API (#281 task 2, extended by issue #662).
 * `me` returns the current `SwarmUser` resolved from the session cookie — the
 * dashboard uses it to know who is signed in and to gate the app (a null user is
 * a `UNAUTHORIZED` from `authedProcedure`, which the SPA turns into a redirect to
 * `/login`) — and the two mutations are the self-service account changes behind
 * the profile's Security tab.
 *
 * **The subject is always `ctx.user.id`.** No procedure here takes a user id, so
 * no request can address another account; administering *someone else's* account
 * (creating a user, granting admin, setting a first password) stays with the
 * `swarm users` CLI, and the login `identifier`, the installation role, and
 * project membership roles are not editable here at all.
 *
 * It returns only the public `SwarmUser` read model — never the password hash,
 * the session token, or any other secret; `changePassword` returns no user data
 * at all, and neither password value is returned, echoed in an error, or logged.
 * Login/logout themselves are plain Hono routes (`POST /auth/login`,
 * `POST /auth/logout` in `src/api/server.ts`), not tRPC procedures, because they
 * set and clear the HTTP-only session cookie.
 */

/**
 * A password change re-authenticates the caller with their current password.
 * Only emptiness and "actually a change" are enforced here — the same rule
 * `swarm users set-password` applies; a strength/rotation policy would have to
 * be decided for both, and this issue does not decide one.
 */
const ChangePasswordInput = z
	.object({
		currentPassword: z.string().min(1),
		newPassword: z.string().min(1),
	})
	.refine((value) => value.newPassword !== value.currentPassword, {
		message: 'The new password must differ from the current one.',
		path: ['newPassword'],
	});

export const authRouter = router({
	me: authedProcedure.query(({ ctx }) => ctx.user),

	// Rename the caller's own account — the human-facing label only. Mirrors
	// `workers.rename` one level up, and returns the same secret-free `SwarmUser`
	// `me` returns, so the caller can refresh its view of itself from the result.
	updateDisplayName: authedProcedure
		.input(z.object({ displayName: UserDisplayNameSchema }))
		.mutation(async ({ ctx, input }) => {
			const updated = await renameUser(ctx.user.id, input.displayName);
			if (!updated) {
				throw new TRPCError({ code: 'NOT_FOUND', message: 'Your account no longer exists.' });
			}
			return updated;
		}),

	// Change the caller's own password, verified against their current one
	// server-side. Each expected outcome gets its own status; the response body
	// carries nothing but `{ ok: true }`.
	changePassword: authedProcedure.input(ChangePasswordInput).mutation(async ({ ctx, input }) => {
		const outcome = await changeOwnPassword({
			userId: ctx.user.id,
			currentPassword: input.currentPassword,
			newPassword: input.newPassword,
		});
		switch (outcome) {
			case 'changed':
				return { ok: true as const };
			case 'invalid-current-password':
				throw new TRPCError({
					code: 'FORBIDDEN',
					message: 'Your current password is incorrect.',
				});
			case 'no-password-set':
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message:
						'This account has no password to change. An operator sets the first one with `swarm users set-password`.',
				});
			default:
				throw new TRPCError({ code: 'NOT_FOUND', message: 'Your account no longer exists.' });
		}
	}),
});
