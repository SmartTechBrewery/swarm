/**
 * Password-link persistence (issue #1151) — plain functions, one `getDb()` per
 * call, mirroring `userSessionsRepository.ts`. Backs the `user_password_tokens`
 * table (`src/db/schema/userPasswordTokens.ts`).
 *
 * This layer sees the **token hash** only; minting the token and hashing it are
 * `src/identity/password-link.ts`'s job. It is also the one place that, as part
 * of a link's lifecycle, writes `users.password_hash` and deletes that user's
 * sessions — both inside the transaction that spends the link, so a redeemed
 * link always leaves the new password set and the old sessions gone together.
 */

import { and, eq, gt, lte, or } from 'drizzle-orm';

import type { SwarmUser } from '../../identity/schema.js';
import { getDb } from '../client.js';
import { userPasswordTokens } from '../schema/userPasswordTokens.js';
import { userSessions } from '../schema/userSessions.js';
import { users } from '../schema/users.js';
import { rowToSwarmUser } from './usersRepository.js';

/** A link to persist: the (already hashed) token and its absolute expiry. */
interface PasswordTokenInput {
	tokenHash: string;
	expiresAt: Date;
	/** The issuing instant; links expired by then are swept in the same transaction. */
	now: Date;
}

/**
 * Create a user together with their first password link, in one transaction —
 * a failed token insert must not leave a user nobody can sign in as. Rejects
 * with the raw pg `23505` on a duplicate `identifier` and writes nothing; the
 * caller translates it.
 */
export async function createUserWithPasswordToken(
	input: PasswordTokenInput & { identifier: string; displayName: string; instanceAdmin: boolean },
): Promise<SwarmUser> {
	return getDb().transaction(async (tx) => {
		const [row] = await tx
			.insert(users)
			.values({
				identifier: input.identifier,
				displayName: input.displayName,
				instanceAdmin: input.instanceAdmin,
			})
			.returning();
		await tx.delete(userPasswordTokens).where(lte(userPasswordTokens.expiresAt, input.now));
		await tx.insert(userPasswordTokens).values({
			userId: row.id,
			tokenHash: input.tokenHash,
			expiresAt: input.expiresAt,
		});
		return rowToSwarmUser(row);
	});
}

/**
 * Store a new link for an existing user, deleting their earlier one (so the old
 * link stops working) and sweeping every expired link in the same transaction.
 */
export async function replacePasswordToken(
	input: PasswordTokenInput & { userId: string },
): Promise<void> {
	await getDb().transaction(async (tx) => {
		await tx
			.delete(userPasswordTokens)
			.where(
				or(
					eq(userPasswordTokens.userId, input.userId),
					lte(userPasswordTokens.expiresAt, input.now),
				),
			);
		await tx.insert(userPasswordTokens).values({
			userId: input.userId,
			tokenHash: input.tokenHash,
			expiresAt: input.expiresAt,
		});
	});
}

/**
 * Spend a link: claim it, set the user's password hash, and delete every
 * session that user has. Returns the user's id, or `undefined` — writing
 * nothing — when no live link matches.
 *
 * The claim is the `DELETE … RETURNING` itself: two concurrent redemptions of
 * one link contend for that row's lock, and the one that waits re-checks after
 * the winner commits, finds the row gone, and gets nothing.
 */
export async function redeemPasswordToken(input: {
	tokenHash: string;
	passwordHash: string;
	now: Date;
}): Promise<string | undefined> {
	return getDb().transaction(async (tx) => {
		const [claimed] = await tx
			.delete(userPasswordTokens)
			.where(
				and(
					eq(userPasswordTokens.tokenHash, input.tokenHash),
					gt(userPasswordTokens.expiresAt, input.now),
				),
			)
			.returning({ userId: userPasswordTokens.userId });
		if (!claimed) return undefined;

		await tx
			.update(users)
			.set({ passwordHash: input.passwordHash })
			.where(eq(users.id, claimed.userId));
		await tx.delete(userSessions).where(eq(userSessions.userId, claimed.userId));
		return claimed.userId;
	});
}
