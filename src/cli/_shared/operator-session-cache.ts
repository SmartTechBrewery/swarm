/**
 * The per-installation operator session cache (issue #798).
 *
 * `swarm login` authenticates a human operator against the control plane over the
 * network and gets back an opaque session token. Only its SHA-256 is stored
 * server-side (`../../identity/auth.ts`), so the raw token exists exactly once —
 * and unlike the dashboard's copy, which a browser holds as a cookie, nothing on
 * the CLI side would otherwise keep it. This is where it is kept.
 *
 * **Where it lives.** `~/.swarm/operator-sessions/<sha256(normalised control-plane
 * URL)>/session.json` — the same `~/.swarm/<kind>/<sha256>/` convention
 * `../../worktree/checkout-key.ts` documents, keyed on the *installation* rather
 * than on a checkout, so one machine can hold a session for several control
 * planes at once. The key is derived here rather than by bending
 * `checkoutStateDir`, whose key is a realpath: a URL has no realpath, and its own
 * canonicalization is a different question ({@link normalizeControlPlaneUrl}).
 *
 * **The token is at rest on disk**, at the same owner-only expectation as the
 * worker credential cache next door (`./worker-credential-cache.ts`): `700` on
 * the directory and `600` on the file, both set explicitly rather than left to
 * the process umask. Nothing ever prints the value back — `swarm login` names the
 * *path* it wrote and the identifier it resolved.
 */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { readJson } from '../../worktree/local-lock.js';

/** The cache directory's `kind` under `~/.swarm/`, sibling to `worker-credentials`. */
const CACHE_KIND = 'operator-sessions';

const SESSION_FILE = 'session.json';

export const OperatorSessionCacheSchema = z.object({
	/** The normalised control-plane URL, recorded for an operator reading an opaque `<sha256>` directory. */
	controlPlaneUrl: z.string().min(1),
	token: z.string().min(1),
	userId: z.string().min(1),
	/** The login handle the token resolved to, so `--status` can name it without a round trip. */
	identifier: z.string().min(1),
	expiresAt: z.string().datetime(),
	createdAt: z.string().datetime(),
});
export type OperatorSessionCache = z.infer<typeof OperatorSessionCacheSchema>;

/**
 * The installation's identity: its URL, spelled one way. `https://SWARM.example.com/`
 * and `https://swarm.example.com` are the same control plane, and a cache keyed on
 * the spelling would hand the second one "not signed in" right after the first
 * logged in. `new URL` already lowercases the scheme and host and drops a default
 * port (`https://swarm.example.com:443` serializes without `:443`), so only the
 * trailing slash is left to strip.
 */
export function normalizeControlPlaneUrl(controlPlaneUrl: string): string {
	const trimmed = controlPlaneUrl.trim();
	try {
		return new URL(trimmed).toString().replace(/\/+$/, '');
	} catch {
		// Not a URL at all. `swarm login` rejects that before it reaches here, so
		// this only keeps the key derivable rather than throwing from a path helper.
		return trimmed.replace(/\/+$/, '');
	}
}

/** `<homeDir>/.swarm/operator-sessions/<sha256(normalised URL)>`. */
function operatorSessionStateDir(controlPlaneUrl: string, homeDir?: string): string {
	const canonical = normalizeControlPlaneUrl(controlPlaneUrl);
	return resolve(
		homeDir ?? homedir(),
		'.swarm',
		CACHE_KIND,
		createHash('sha256').update(canonical).digest('hex'),
	);
}

/** `~/.swarm/operator-sessions/<sha256(normalised URL)>/session.json`. */
export function operatorSessionCachePath(controlPlaneUrl: string, homeDir?: string): string {
	return resolve(operatorSessionStateDir(controlPlaneUrl, homeDir), SESSION_FILE);
}

export interface WriteOperatorSessionCacheInput {
	controlPlaneUrl: string;
	token: string;
	userId: string;
	identifier: string;
	/** The session's absolute expiry, as the ISO-8601 string the control plane returned. */
	expiresAt: string;
	/** Injectable so tests never touch the real home directory or clock. */
	homeDir?: string;
	now?: () => number;
}

/**
 * Write (or replace) this installation's cache entry and return the path written.
 *
 * Logging in again replaces the file: the newest session is the live one, and the
 * previous token is unrecoverable from here anyway (it stays valid server-side
 * until it expires, which is why `--logout` revokes before clearing). The write
 * goes through a temporary file and a `rename`, so a concurrent reader never sees
 * a half-written record.
 */
export function writeOperatorSessionCache(input: WriteOperatorSessionCacheInput): string {
	const now = input.now ?? Date.now;
	const dir = operatorSessionStateDir(input.controlPlaneUrl, input.homeDir);
	const path = resolve(dir, SESSION_FILE);

	// `~/.swarm/operator-sessions/` is created owner-only and then chmod'ed
	// explicitly, so the result does not depend on the process umask or on a
	// pre-existing directory's mode.
	mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
	chmodSync(dirname(dir), 0o700);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);

	const record: OperatorSessionCache = {
		// The same normalization the directory name is derived from, so the recorded
		// URL and the `<sha256>` it sits under can never disagree about which
		// installation this is.
		controlPlaneUrl: normalizeControlPlaneUrl(input.controlPlaneUrl),
		token: input.token,
		userId: input.userId,
		identifier: input.identifier,
		expiresAt: input.expiresAt,
		createdAt: new Date(now()).toISOString(),
	};
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
	renameSync(temp, path);
	// After the rename, in case the file it replaced had a laxer mode.
	chmodSync(path, 0o600);
	return path;
}

/**
 * `null` — no session cached for this control plane (the actionable "run
 * `swarm login`" case). `undefined` — an entry exists but could not be read or
 * does not match the schema, which is a different problem and gets its own
 * message.
 */
export function readOperatorSessionCache(
	controlPlaneUrl: string,
	homeDir?: string,
): OperatorSessionCache | null | undefined {
	return readJson(operatorSessionCachePath(controlPlaneUrl, homeDir), OperatorSessionCacheSchema);
}

/**
 * Delete this installation's cache entry, returning whether one was there. The
 * enclosing `<sha256>` directory is left behind: it is empty, owner-only, and
 * removing it would race a concurrent `swarm login` writing its temp file into it.
 */
export function clearOperatorSessionCache(controlPlaneUrl: string, homeDir?: string): boolean {
	const path = operatorSessionCachePath(controlPlaneUrl, homeDir);
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	return true;
}
