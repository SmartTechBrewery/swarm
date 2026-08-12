/**
 * SWARM user persistence — plain functions, one `getDb()` per call, no class,
 * mirroring `projectsRepository.ts` / `appSettingsRepository.ts`. Backs the
 * `users` table (`src/db/schema/users.ts`), the persisted form of `SwarmUser`
 * (`src/identity/schema.ts`, the source of truth for the shape).
 *
 * A `users` row already carries the domain's exact types (`uuid`, `text`,
 * `boolean`, `timestamp`), so mapping a row back to `SwarmUser` is a re-assembly,
 * not a re-validation — same as `rowToProjectConfig`. A duplicate `identifier`
 * surfaces the raw pg `23505` unique violation; the caller (the `swarm users`
 * CLI) translates it to a friendly message.
 */

import { asc, eq } from 'drizzle-orm';

import type { SwarmUser } from '../../identity/schema.js';
import { getDb } from '../client.js';
import { users } from '../schema/users.js';

type UserRow = typeof users.$inferSelect;

/**
 * The reserved login handle of the bootstrapped local single-user admin (issue
 * #298). `ensureLocalAdminUser` owns this row; it is a normal `users.identifier`
 * (subject to the same unique constraint) chosen so it cannot collide with a
 * real email/username. Exported so the auth path and tests refer to one constant.
 */
export const LOCAL_ADMIN_IDENTIFIER = 'localhost-admin';

/** Human-friendly label shown for the bootstrapped local single-user admin. */
const LOCAL_ADMIN_DISPLAY_NAME = 'Local Admin';

/** The fields a caller supplies to create a user; `id`/timestamps are generated. */
export interface CreateUserInput {
	identifier: string;
	displayName: string;
	instanceAdmin?: boolean;
}

/** Re-assemble a `SwarmUser` from a persisted `users` row. */
function rowToSwarmUser(row: UserRow): SwarmUser {
	return {
		id: row.id,
		identifier: row.identifier,
		displayName: row.displayName,
		instanceAdmin: row.instanceAdmin,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Create a user. Rejects with the pg `23505` unique violation if `identifier`
 * already exists (the identifier is the stable, unique login handle) — the
 * caller decides how to surface that.
 */
export async function createUser(input: CreateUserInput): Promise<SwarmUser> {
	const [row] = await getDb()
		.insert(users)
		.values({
			identifier: input.identifier,
			displayName: input.displayName,
			instanceAdmin: input.instanceAdmin ?? false,
		})
		.returning();
	return rowToSwarmUser(row);
}

/**
 * Ensure the reserved `localhost-admin` user exists as an installation admin,
 * for local single-user mode (issue #298). Atomic and idempotent via the
 * `users.identifier` unique constraint — no new schema, no migration:
 *
 * - first use inserts the account with no password (`password_hash` stays null),
 * - repeated or concurrent use returns the same row (the loser of a concurrent
 *   insert takes the `ON CONFLICT` update path), and
 * - a pre-existing row with this identifier is promoted to `instanceAdmin`
 *   without touching its `password_hash` or display name.
 *
 * The single-user admin never has a password — it authenticates by the mode
 * flag, not credentials — so this never sets one.
 */
export async function ensureLocalAdminUser(): Promise<SwarmUser> {
	const [row] = await getDb()
		.insert(users)
		.values({
			identifier: LOCAL_ADMIN_IDENTIFIER,
			displayName: LOCAL_ADMIN_DISPLAY_NAME,
			instanceAdmin: true,
		})
		.onConflictDoUpdate({
			target: users.identifier,
			// Promote an existing row to admin only; leave password_hash and
			// display_name as they are.
			set: { instanceAdmin: true },
		})
		.returning();
	return rowToSwarmUser(row);
}

/** Resolve a user by generated id. Returns `undefined` if unknown. */
export async function getUserById(id: string): Promise<SwarmUser | undefined> {
	const rows = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
	const row = rows[0];
	return row ? rowToSwarmUser(row) : undefined;
}

/**
 * Resolve a user by their login handle. Returns `undefined` when no user owns
 * that identifier — a not-found lookup, not an error (ai/CODING_STANDARDS.md
 * "Error handling").
 */
export async function findUserByIdentifier(identifier: string): Promise<SwarmUser | undefined> {
	const rows = await getDb().select().from(users).where(eq(users.identifier, identifier)).limit(1);
	const row = rows[0];
	return row ? rowToSwarmUser(row) : undefined;
}

/** List all users, ordered by identifier. */
export async function listUsers(): Promise<SwarmUser[]> {
	const rows = await getDb().select().from(users).orderBy(asc(users.identifier));
	return rows.map(rowToSwarmUser);
}

/**
 * Set (grant/revoke) a user's installation-admin flag. Returns the updated user,
 * or `undefined` if no user has that id.
 */
export async function setInstanceAdmin(id: string, value: boolean): Promise<SwarmUser | undefined> {
	const [row] = await getDb()
		.update(users)
		.set({ instanceAdmin: value })
		.where(eq(users.id, id))
		.returning();
	return row ? rowToSwarmUser(row) : undefined;
}

/**
 * Set a user's own display name (issue #662). Returns the updated user, or
 * `undefined` if no user has that id. `updated_at` maintains itself (`$onUpdate`
 * on the column), so nothing else is written; the caller validates the name
 * (`renameUser`, `src/identity/service.ts`).
 */
export async function setDisplayName(
	id: string,
	displayName: string,
): Promise<SwarmUser | undefined> {
	const [row] = await getDb()
		.update(users)
		.set({ displayName })
		.where(eq(users.id, id))
		.returning();
	return row ? rowToSwarmUser(row) : undefined;
}

/**
 * The credential material for a login attempt — the user plus their stored
 * password hash. Kept separate from `SwarmUser` on purpose: the hash is a secret
 * that must never leak into the domain read model or any response, so only the
 * auth path (`src/identity/auth.ts`) reads it via this function.
 */
export interface UserCredential {
	user: SwarmUser;
	passwordHash: string | null;
}

/**
 * Resolve a user and their password hash by login handle, for credential
 * verification. Returns `undefined` when no user owns that identifier; the hash
 * is `null` when the user exists but has no password set (they can't log in).
 */
export async function findUserCredentialByIdentifier(
	identifier: string,
): Promise<UserCredential | undefined> {
	const rows = await getDb().select().from(users).where(eq(users.identifier, identifier)).limit(1);
	const row = rows[0];
	return row ? { user: rowToSwarmUser(row), passwordHash: row.passwordHash } : undefined;
}

/**
 * Resolve a user and their password hash by generated id, for the self-service
 * password change (issue #662) — the id is what a session authoritatively
 * carries, and the same key {@link setPasswordHash} takes. Returns `undefined`
 * when no user has that id; the hash is `null` when the user exists but has no
 * password set. Carries the same secret as
 * {@link findUserCredentialByIdentifier}, so it too is read only by the auth
 * path (`src/identity/auth.ts`).
 */
export async function findUserCredentialById(id: string): Promise<UserCredential | undefined> {
	const rows = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
	const row = rows[0];
	return row ? { user: rowToSwarmUser(row), passwordHash: row.passwordHash } : undefined;
}

/**
 * Store (or replace) a user's password hash. Returns `true` when a row was
 * updated, `false` when no user has that id. The caller passes an already-hashed
 * value — this layer never sees a plaintext password.
 */
export async function setPasswordHash(id: string, passwordHash: string): Promise<boolean> {
	const updated = await getDb()
		.update(users)
		.set({ passwordHash })
		.where(eq(users.id, id))
		.returning({ id: users.id });
	return updated.length > 0;
}
