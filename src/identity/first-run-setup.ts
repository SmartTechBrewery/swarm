/**
 * First-run setup link (issue #1150): how a multi-user installation with an
 * empty `users` table gets its first admin without a shell.
 *
 * At startup the process serving `/auth/setup` calls `announceFirstRunSetup`.
 * With no users it mints a random single-use token, keeps only its SHA-256 and
 * expiry, and writes a `/setup?token=…` link to its log — the one and only place
 * the raw token ever appears. `completeFirstRunSetup` redeems it once.
 *
 * The token lives in this module's memory, not the database. The process that
 * logs the link is always the one that serves the route (the API server, or the
 * all-in-one process that mounts the same app), so a restart dropping the token
 * is exactly "old links stop working, a fresh one is logged" — no table, no
 * migration, no cleanup.
 *
 * Redemption claims the token **synchronously** (check and clear with no
 * `await` between), so two concurrent submissions of one link cannot both pass;
 * "only one admin ever" is then enforced again by the database
 * (`createFirstInstanceAdmin`), which also covers a race with `swarm users add`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createFirstInstanceAdmin, hasAnyUser } from '../db/repositories/usersRepository.js';
import { isSingleUserMode } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { hashPassword } from './auth.js';
import type { SwarmUser } from './schema.js';

/** How long a logged setup link stays usable. A restart always logs a fresh one. */
export const SETUP_TOKEN_TTL_MS = 60 * 60 * 1000;

const SETUP_TOKEN_BYTES = 32;

let pending: { tokenHash: Buffer; expiresAt: Date } | undefined;

function sha256(value: string): Buffer {
	return createHash('sha256').update(value).digest();
}

/**
 * Issue and log a setup link when the installation has no users yet; replaces
 * (and so invalidates) any link this process issued before. Best effort: it
 * never throws, so a database problem cannot keep the server from starting.
 *
 * Nothing is issued in single-user mode, which bootstraps `localhost-admin`
 * itself on the first request. `baseUrl` prefixes the logged path when the
 * caller knows the public origin that serves the dashboard; without it the bare
 * path is logged and the operator opens it on the dashboard's own address.
 */
export async function announceFirstRunSetup(
	options: { singleUserMode?: boolean; baseUrl?: string; now?: Date } = {},
): Promise<void> {
	if (options.singleUserMode ?? isSingleUserMode()) return;

	try {
		if (await hasAnyUser()) {
			pending = undefined;
			return;
		}
	} catch (err) {
		logger.error('Could not check for existing users; no first-run setup link was issued', {
			error: describeError(err),
		});
		return;
	}

	const token = randomBytes(SETUP_TOKEN_BYTES).toString('base64url');
	const expiresAt = new Date((options.now ?? new Date()).getTime() + SETUP_TOKEN_TTL_MS);
	pending = { tokenHash: sha256(token), expiresAt };

	const base = (options.baseUrl ?? '').replace(/\/+$/, '');
	logger.warn(
		`No users exist yet. Open ${base}/setup?token=${token} to create the first installation admin (single use, expires ${expiresAt.toISOString()}).`,
	);
}

/**
 * The expected outcomes of redeeming a setup link — a union rather than thrown
 * errors so the route maps each to its own status (as `PasswordChangeOutcome`).
 */
export type FirstRunSetupOutcome =
	| { outcome: 'created'; user: SwarmUser }
	| { outcome: 'invalid-link' }
	| { outcome: 'already-set-up' };

/**
 * Redeem the setup link: create the first installation admin with the given
 * e-mail identifier and password. A wrong token leaves the real one usable; a
 * matching token is spent before anything is awaited, even if the database
 * write then fails (a restart issues a new one). Neither the token nor the
 * password is logged or returned.
 */
export async function completeFirstRunSetup(
	input: { token: string; identifier: string; password: string },
	now: Date = new Date(),
): Promise<FirstRunSetupOutcome> {
	if (!pending) return { outcome: 'invalid-link' };
	if (pending.expiresAt.getTime() <= now.getTime()) {
		pending = undefined;
		return { outcome: 'invalid-link' };
	}
	if (!timingSafeEqual(sha256(input.token), pending.tokenHash)) {
		return { outcome: 'invalid-link' };
	}
	pending = undefined;

	const user = await createFirstInstanceAdmin({
		identifier: input.identifier,
		displayName: input.identifier,
		passwordHash: await hashPassword(input.password),
	});
	return user ? { outcome: 'created', user } : { outcome: 'already-set-up' };
}

/** Drop any held token. Test-only, like the registries' `_reset…ForTesting`. */
export function _resetFirstRunSetupForTesting(): void {
	pending = undefined;
}
