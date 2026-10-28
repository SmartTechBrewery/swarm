/**
 * User ↔ provider-handle link persistence — plain functions, one `getDb()` per
 * call, no class, mirroring `usersRepository.ts` / `projectMembersRepository.ts`.
 * Backs the `user_identities` table (`src/db/schema/userIdentities.ts`), the
 * persisted form of `UserIdentity` (`src/identity/user-identity.ts`, the source
 * of truth for the shape).
 *
 * Every `provider`/`handle` crossing this boundary — read or write — goes
 * through `normalizeIdentityKey`, so a link seeded as `Ada` still resolves the
 * `ada` a provider reports. Lookups that find nothing return `undefined`/`[]`;
 * only a genuine conflict (the handle already belongs to a *different* user)
 * throws (ai/CODING_STANDARDS.md "Error handling").
 */

import { and, asc, eq } from 'drizzle-orm';

import {
	IdentityLinkConflictError,
	type LinkIdentityInput,
	LinkIdentityInputSchema,
	normalizeIdentityKey,
	type UserIdentity,
} from '../../identity/user-identity.js';
import { getDb } from '../client.js';
import { userIdentities } from '../schema/userIdentities.js';

type UserIdentityRow = typeof userIdentities.$inferSelect;

/** Re-assemble a `UserIdentity` from a persisted `user_identities` row. */
function rowToUserIdentity(row: UserIdentityRow): UserIdentity {
	return {
		id: row.id,
		userId: row.userId,
		provider: row.provider,
		handle: row.handle,
		createdAt: row.createdAt,
	};
}

/** Read the link for a `(provider, handle)` pair, if one exists. */
async function findIdentity(provider: string, handle: string): Promise<UserIdentity | undefined> {
	const rows = await getDb()
		.select()
		.from(userIdentities)
		.where(and(eq(userIdentities.provider, provider), eq(userIdentities.handle, handle)))
		.limit(1);
	const row = rows[0];
	return row ? rowToUserIdentity(row) : undefined;
}

/**
 * Link a provider handle to a SWARM user.
 *
 * Idempotent for a re-link of the same `(provider, handle, user)` — it returns
 * the existing row rather than erroring, so an operator re-running the command
 * (or a future auto-linker replaying a discovery) is harmless. Re-pointing a
 * handle at a *different* user throws instead of silently stealing it: that
 * ambiguity is exactly what the unique index exists to prevent, and resolving it
 * is an explicit `unlinkIdentity` + `linkIdentity`.
 */
export async function linkIdentity(input: LinkIdentityInput): Promise<UserIdentity> {
	const provider = normalizeIdentityKey(input.provider);
	const handle = normalizeIdentityKey(input.handle);

	LinkIdentityInputSchema.parse({
		userId: input.userId,
		provider,
		handle,
	});

	const [row] = await getDb()
		.insert(userIdentities)
		.values({ userId: input.userId, provider, handle })
		.onConflictDoNothing({ target: [userIdentities.provider, userIdentities.handle] })
		.returning();
	if (row) return rowToUserIdentity(row);

	const existing = await findIdentity(provider, handle);
	// The conflicting row can only be missing if it was deleted between the insert
	// and this read — a lost race, not a state to paper over.
	if (!existing) {
		throw new Error(`Failed to link '${handle}' on '${provider}': the conflicting link vanished`);
	}
	if (existing.userId !== input.userId) {
		throw new IdentityLinkConflictError(provider, handle, existing.userId);
	}
	return existing;
}

/**
 * The SWARM user id a provider handle belongs to, or `undefined` when the handle
 * is not linked to anyone — the primary read for assignee resolution.
 */
export async function findUserIdByIdentity(
	provider: string,
	handle: string,
): Promise<string | undefined> {
	const identity = await findIdentity(normalizeIdentityKey(provider), normalizeIdentityKey(handle));
	return identity?.userId;
}

/** Every handle a user owns, oldest first. Empty when they have no links. */
export async function listIdentitiesForUser(userId: string): Promise<UserIdentity[]> {
	const rows = await getDb()
		.select()
		.from(userIdentities)
		.where(eq(userIdentities.userId, userId))
		.orderBy(asc(userIdentities.createdAt), asc(userIdentities.id));
	return rows.map(rowToUserIdentity);
}

/** Every link on the installation, ordered by provider then handle. */
export async function listIdentities(): Promise<UserIdentity[]> {
	const rows = await getDb()
		.select()
		.from(userIdentities)
		.orderBy(asc(userIdentities.provider), asc(userIdentities.handle));
	return rows.map(rowToUserIdentity);
}

/**
 * Remove a provider handle's link. Returns `true` if one was removed, `false` if
 * the handle wasn't linked (a no-op, not an error).
 */
export async function unlinkIdentity(provider: string, handle: string): Promise<boolean> {
	const rows = await getDb()
		.delete(userIdentities)
		.where(
			and(
				eq(userIdentities.provider, normalizeIdentityKey(provider)),
				eq(userIdentities.handle, normalizeIdentityKey(handle)),
			),
		)
		.returning({ id: userIdentities.id });
	return rows.length > 0;
}
