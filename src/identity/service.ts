/**
 * Provider-neutral SWARM identity read model — the thin domain surface later
 * phases consume (session-auth context #281 task 2, project membership task 3,
 * dashboard user screens) so they never touch the `users` table directly. A
 * plain domain service over SWARM's own users, coupled to no IdP or SCM: #281
 * does not pick an external identity provider, and nothing here requires one.
 *
 * Reads, the installation-role predicate, and the one **self-service** write a
 * user may make about themselves: their own display name (issue #662). User
 * *creation* and the admin-flag mutations stay operator actions, exposed through
 * the `swarm users` CLI over `usersRepository.ts` — this service never widens to
 * administering someone else's account.
 */

import {
	findUserByIdentifier,
	getUserById,
	setDisplayName,
} from '../db/repositories/usersRepository.js';
import {
	isInstanceAdmin as isInstanceAdminUser,
	type SwarmUser,
	UserDisplayNameSchema,
} from './schema.js';

/** Resolve a user by id. Returns `undefined` if unknown. */
export async function getUser(id: string): Promise<SwarmUser | undefined> {
	return getUserById(id);
}

/** Resolve a user by their login handle (`identifier`). Returns `undefined` if unknown. */
export async function resolveUserByIdentifier(identifier: string): Promise<SwarmUser | undefined> {
	return findUserByIdentifier(identifier);
}

/**
 * Change a user's own display name (issue #662). Validates and trims it
 * ({@link UserDisplayNameSchema}) and returns the updated user, or `undefined`
 * when no user has that id — the same shape as `renameWorker`
 * (`./worker-service.ts`), one level up. The caller supplies the id from the
 * session, so this never addresses another account.
 */
export async function renameUser(id: string, displayName: string): Promise<SwarmUser | undefined> {
	const validated = UserDisplayNameSchema.parse(displayName);
	return setDisplayName(id, validated);
}

/**
 * Whether the user with this id is an installation admin. Loads the user and
 * applies the domain predicate (`isInstanceAdmin`, `./schema.ts`); an unknown
 * user is not an admin (`false`), not an error — authorization checks want a
 * plain boolean, not a thrown "not found".
 */
export async function isInstanceAdmin(userId: string): Promise<boolean> {
	const user = await getUserById(userId);
	return user ? isInstanceAdminUser(user) : false;
}
