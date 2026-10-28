/**
 * Password links (issue #1151): how an installation admin gets a user a
 * password — a new user's first one, or a reset — without anyone holding a
 * shell. The admin's `users` router mutation mints a random 256-bit token,
 * stores only its SHA-256 (`user_password_tokens`), and returns the raw token
 * exactly once, in that response; the dashboard builds the `/set-password` link
 * from it. Nothing here logs the token or puts it in an error.
 *
 * A link lasts {@link PASSWORD_LINK_TTL_MS}, works once (redemption claims the
 * row atomically), and replaces that user's earlier link. Unlike the first-run
 * setup link (`./first-run-setup.ts`), it lives in Postgres: it has to survive a
 * restart for its whole lifetime, and no log line can re-announce it.
 *
 * Issuing a link changes nothing about the account. Redeeming it sets the new
 * password and revokes **every** session the user has, in one transaction
 * (`redeemPasswordToken`); the route then signs the redeemer in afresh.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
	createUserWithPasswordToken,
	redeemPasswordToken,
	replacePasswordToken,
} from '../db/repositories/userPasswordTokensRepository.js';
import { getUserById } from '../db/repositories/usersRepository.js';
import { hashPassword } from './auth.js';
import type { SwarmUser } from './schema.js';

/** How long an issued link stays usable — long enough for an invite to outlast a weekend. */
export const PASSWORD_LINK_TTL_MS = 72 * 60 * 60 * 1000;

const PASSWORD_LINK_TOKEN_BYTES = 32;

/** A freshly issued link: the raw token (shown once) and its absolute expiry. */
export interface IssuedPasswordLink {
	user: SwarmUser;
	token: string;
	expiresAt: Date;
}

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

function mintToken(now: Date): { token: string; tokenHash: string; expiresAt: Date } {
	const token = randomBytes(PASSWORD_LINK_TOKEN_BYTES).toString('base64url');
	return {
		token,
		tokenHash: hashToken(token),
		expiresAt: new Date(now.getTime() + PASSWORD_LINK_TTL_MS),
	};
}

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
 * whose original pg error (carrying `code: '23505'`) is on `.cause`. Copied from
 * `src/api/routers/members.ts` rather than extracted, as that copy explains.
 */
function isUniqueViolation(error: unknown): boolean {
	return (
		hasUniqueViolationCode(error) || (error instanceof Error && hasUniqueViolationCode(error.cause))
	);
}

/**
 * Create a user with no password and issue their first link, atomically. A
 * taken identifier is an expected outcome, not an error, and writes nothing.
 */
export async function createUserWithPasswordLink(
	input: { identifier: string; displayName: string; instanceAdmin: boolean },
	now: Date = new Date(),
): Promise<{ outcome: 'created'; link: IssuedPasswordLink } | { outcome: 'identifier-taken' }> {
	const { token, tokenHash, expiresAt } = mintToken(now);
	try {
		const user = await createUserWithPasswordToken({ ...input, tokenHash, expiresAt, now });
		return { outcome: 'created', link: { user, token, expiresAt } };
	} catch (error) {
		if (isUniqueViolation(error)) return { outcome: 'identifier-taken' };
		throw error;
	}
}

/**
 * Issue a (reset) link for an existing user, invalidating their earlier one.
 * Returns `undefined` for an unknown user id.
 */
export async function issuePasswordLink(
	userId: string,
	now: Date = new Date(),
): Promise<IssuedPasswordLink | undefined> {
	const user = await getUserById(userId);
	if (!user) return undefined;

	const { token, tokenHash, expiresAt } = mintToken(now);
	await replacePasswordToken({ userId, tokenHash, expiresAt, now });
	return { user, token, expiresAt };
}

/** The expected outcomes of redeeming a link, mapped to statuses by the route. */
export type PasswordLinkRedemption =
	| { outcome: 'set'; user: SwarmUser }
	| { outcome: 'invalid-link' };

/**
 * Redeem a link: set the password and revoke the user's sessions. The password
 * is hashed before the claiming transaction opens, so no slow work runs under
 * its lock and an unknown token costs the same scrypt time as a live one.
 * Neither secret is logged or returned.
 */
export async function redeemPasswordLink(
	input: { token: string; password: string },
	now: Date = new Date(),
): Promise<PasswordLinkRedemption> {
	const passwordHash = await hashPassword(input.password);
	const userId = await redeemPasswordToken({
		tokenHash: hashToken(input.token),
		passwordHash,
		now,
	});
	if (!userId) return { outcome: 'invalid-link' };

	const user = await getUserById(userId);
	return user ? { outcome: 'set', user } : { outcome: 'invalid-link' };
}
