/**
 * Session authentication for the dashboard — the credential-verification and
 * opaque-session machinery that replaces the shared `DASHBOARD_TOKEN` bearer
 * guard (#281 task 2). Dependency-free by design (ai/RULES.md §2 "no new
 * dependency"): password hashing uses Node `crypto.scrypt` + a random salt +
 * `timingSafeEqual`, mirroring the style of `src/db/crypto.ts`, and session
 * tokens are opaque random bytes stored only as a SHA-256.
 *
 * Two secrets are handled here and neither is ever persisted or returned in a
 * response: the user's **password** (only its scrypt hash is stored, on
 * `users.password_hash`) and the raw **session token** (only its SHA-256 is
 * stored, on `user_sessions.token_hash`). `createSession` returns the raw token
 * exactly once so the caller can set it as an HTTP-only cookie; every later
 * request re-derives the hash to look the session up.
 */

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import {
	deleteExpiredSessions,
	deleteSessionByToken,
	findUserIdBySessionToken,
	insertSession,
} from '../db/repositories/userSessionsRepository.js';
import {
	ensureLocalAdminUser,
	findUserCredentialById,
	findUserCredentialByIdentifier,
	getUserById,
	setPasswordHash,
} from '../db/repositories/usersRepository.js';
import type { SwarmUser } from './schema.js';

const scryptAsync = promisify(scrypt);

// scrypt parameters. 16-byte salt + 64-byte derived key are the Node docs'
// worked example; the cost stays at scrypt's defaults (N=16384), which is a
// sound interactive-login target and keeps us dependency-free.
const SALT_BYTES = 16;
const KEY_BYTES = 64;

// Opaque session token: 32 random bytes (256 bits) is well beyond guessing
// range, so the stored SHA-256 needs no salt/stretch (unlike a low-entropy
// password) — it exists only so a leaked DB row can't be replayed as a cookie.
const SESSION_TOKEN_BYTES = 32;

const DEFAULT_SESSION_TTL_HOURS = 168; // 7 days

/**
 * A syntactically valid but unmatchable hash, used to spend the same scrypt time
 * on a login for an unknown user (or one with no password) as for a real one, so
 * response timing doesn't leak whether an identifier exists.
 */
const DUMMY_PASSWORD_HASH = `${'0'.repeat(SALT_BYTES * 2)}:${'0'.repeat(KEY_BYTES * 2)}`;

/**
 * Hash a plaintext password as `scrypt(salt, password)` with a fresh random
 * salt, encoded `<saltHex>:<keyHex>`. Never store or log the plaintext.
 */
export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(SALT_BYTES);
	const derived = (await scryptAsync(password, salt, KEY_BYTES)) as Buffer;
	return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Verify a plaintext password against a stored `<saltHex>:<keyHex>` hash using a
 * constant-time comparison. Returns `false` (never throws) for a wrong password
 * or a malformed/empty stored value, so callers can treat it as a plain
 * predicate.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [saltHex, keyHex] = stored.split(':');
	if (!saltHex || !keyHex) return false;

	const salt = Buffer.from(saltHex, 'hex');
	const expected = Buffer.from(keyHex, 'hex');
	if (salt.length === 0 || expected.length === 0) return false;

	const derived = (await scryptAsync(password, salt, expected.length)) as Buffer;
	// Lengths match by construction (keylen === expected.length), so
	// timingSafeEqual compares in constant time rather than throwing.
	return timingSafeEqual(derived, expected);
}

/**
 * Verify a login: resolve the user by identifier and check the password against
 * their stored hash. Returns the `SwarmUser` on success, `undefined` on any
 * failure (unknown user, no password set, or wrong password) — never
 * distinguishing which, and always spending the same scrypt time, so neither the
 * result nor the timing reveals whether the identifier exists.
 */
export async function verifyCredentials(
	identifier: string,
	password: string,
): Promise<SwarmUser | undefined> {
	const credential = await findUserCredentialByIdentifier(identifier);
	if (!credential || credential.passwordHash === null) {
		await verifyPassword(password, DUMMY_PASSWORD_HASH);
		return undefined;
	}
	const ok = await verifyPassword(password, credential.passwordHash);
	return ok ? credential.user : undefined;
}

/**
 * The outcome of a self-service password change (issue #662). A string union
 * rather than a thrown error for the *expected* outcomes, so the API layer maps
 * each to its own status without pattern-matching a message; anything
 * unexpected still throws (ai/CODING_STANDARDS.md "Error handling").
 */
export type PasswordChangeOutcome =
	| 'changed'
	| 'invalid-current-password'
	| 'no-password-set'
	| 'unknown-user';

/**
 * Change a user's **own** password, re-authenticating them with their current
 * one first (issue #662). The subject is a user id the caller resolved from the
 * session, never an identifier taken from a request body, so this can only ever
 * re-credential the signed-in account.
 *
 * Fails closed on a user with no password set: a null hash means "cannot log
 * in", never "any current password matches" — and it is reachable, since the
 * single-user `localhost-admin` is bootstrapped passwordless. A wrong current
 * password writes nothing.
 *
 * **Neither plaintext leaves this function** — not in the return value, not in
 * an error, and nothing here logs.
 */
export async function changeOwnPassword(input: {
	userId: string;
	currentPassword: string;
	newPassword: string;
}): Promise<PasswordChangeOutcome> {
	const credential = await findUserCredentialById(input.userId);
	if (!credential) return 'unknown-user';
	if (credential.passwordHash === null) return 'no-password-set';

	const ok = await verifyPassword(input.currentPassword, credential.passwordHash);
	if (!ok) return 'invalid-current-password';

	await setPasswordHash(input.userId, await hashPassword(input.newPassword));
	return 'changed';
}

/** SHA-256 of a raw session token — the only form that touches the DB. */
function hashSessionToken(rawToken: string): string {
	return createHash('sha256').update(rawToken).digest('hex');
}

/** The configured session lifetime in ms (`SWARM_SESSION_TTL_HOURS`, default 7 days). */
function sessionTtlMs(): number {
	const raw = process.env.SWARM_SESSION_TTL_HOURS;
	const hours = raw ? Number(raw) : DEFAULT_SESSION_TTL_HOURS;
	const safe = Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SESSION_TTL_HOURS;
	return safe * 60 * 60 * 1000;
}

/** A freshly minted session: the raw token (shown once) and its absolute expiry. */
export interface MintedSession {
	token: string;
	expiresAt: Date;
}

/**
 * Mint a session for a user: generate an opaque token, persist only its hash and
 * an absolute expiry, and return the raw token once so the caller can set the
 * cookie. The raw token is never stored, logged, or returned again.
 */
export async function createSession(userId: string): Promise<MintedSession> {
	const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
	const expiresAt = new Date(Date.now() + sessionTtlMs());
	await insertSession({ userId, tokenHash: hashSessionToken(token), expiresAt });
	return { token, expiresAt };
}

/**
 * Resolve a raw session token to its `SwarmUser`, or `undefined` when the token
 * matches no live (unexpired) session or the user no longer exists. Expired rows
 * are swept opportunistically; a failed sweep never fails the resolve.
 */
export async function resolveSession(rawToken: string): Promise<SwarmUser | undefined> {
	if (!rawToken) return undefined;
	const userId = await findUserIdBySessionToken(hashSessionToken(rawToken));
	if (!userId) return undefined;

	void deleteExpiredSessions().catch(() => {});
	return getUserById(userId);
}

/**
 * Resolve the caller in local single-user mode (issue #298): the bootstrapped
 * `localhost-admin` installation admin, ensured on first use and returned
 * directly. This is the single-user counterpart to {@link resolveSession} —
 * deliberately session-free, so a local install needs no `/login`, password, or
 * `swarm_session` cookie. It never mints or reads a session; callers use it only
 * when `isSingleUserMode()` is enabled, and the normal cookie flow is untouched
 * when it is not.
 */
export async function resolveSingleUser(): Promise<SwarmUser> {
	return ensureLocalAdminUser();
}

/** Revoke a session by its raw token (logout). A no-op if it doesn't exist. */
export async function revokeSession(rawToken: string): Promise<void> {
	if (!rawToken) return;
	await deleteSessionByToken(hashSessionToken(rawToken));
}
