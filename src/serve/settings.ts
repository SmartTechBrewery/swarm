/**
 * Settings and the startup guard for the all-in-one control plane
 * (`src/serve/index.ts`, issue #1148).
 *
 * Every variable here is read by that entrypoint alone, which is why they share the
 * `SWARM_SERVE_` prefix: the same `.env` is loaded by `dev:api` and `dev:router`, and
 * nothing set for this mode can change how the two-process layout binds or behaves.
 * The one exception is `PORT`, which this mode shares with the router on purpose —
 * it *is* the router's port, now carrying the API's routes too.
 */

import { isEncryptionEnabled, validateCredentialMasterKey } from '../db/crypto.js';
import { isSingleUserMode } from '../lib/env.js';

/** The bind address; unset or blank binds every interface, exactly as the router does. */
export const SERVE_HOST_ENV = 'SWARM_SERVE_HOST';
/** `'true'` turns the checkout-dependent worktree retention sweep back on in this mode. */
export const SERVE_WORKTREE_SWEEP_ENV = 'SWARM_SERVE_WORKTREE_SWEEP';
/** `'true'` waives {@link assertServeStartupSafety}'s refusals (logged, never silent). */
export const SERVE_ALLOW_INSECURE_ENV = 'SWARM_SERVE_ALLOW_INSECURE';

/** Listen port when `PORT` is unset — the router's own default. */
const DEFAULT_SERVE_PORT = 3000;

/** Where the all-in-one process binds. `hostname: undefined` means every interface. */
export interface ServeListen {
	hostname: string | undefined;
	port: number;
}

/**
 * Resolve the listen address. A bad `PORT` throws rather than silently falling
 * back, like every other env parser at a process boundary.
 */
export function resolveServeListen(env: NodeJS.ProcessEnv = process.env): ServeListen {
	const host = env[SERVE_HOST_ENV]?.trim();
	const rawPort = env.PORT?.trim() || String(DEFAULT_SERVE_PORT);
	const port = Number(rawPort);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`PORT must be an integer between 1 and 65535, got '${rawPort}'`);
	}
	return { hostname: host ? host : undefined, port };
}

/** Whether the host-local retention sweep runs in this mode — off unless set to exactly `'true'`. */
export function isServeWorktreeSweepEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[SERVE_WORKTREE_SWEEP_ENV] === 'true';
}

/**
 * Refuse to start the all-in-one control plane on a configuration that is unsafe
 * on a network: single-user mode (every caller is handed the admin) or no valid
 * `CREDENTIAL_MASTER_KEY` (credentials would be stored in plaintext, or not
 * decryptable at all). Throws one error naming every problem and its fix.
 *
 * **The rule keys on the mode, not on the bind address.** This mode exists to sit
 * behind a reverse proxy, so it is treated as network-facing whatever it binds:
 * inside a container it always binds `0.0.0.0`, so the bind cannot say whether the
 * host is public, and loopback is no evidence of privacy either — today's
 * production API binds `127.0.0.1` and is internet-reachable through a tunnel. So
 * there is deliberately no loopback carve-out. The explicit, documented opt-out is
 * `SWARM_SERVE_ALLOW_INSECURE=true`, which returns the waived problems so the
 * caller can log them.
 *
 * The two-process entrypoints (`src/router/index.ts`, `src/api/server.ts`) never
 * call this, so neither the existing installation nor a local single-user setup
 * can be stopped by it.
 */
export function assertServeStartupSafety(env: NodeJS.ProcessEnv = process.env): {
	waived: string[];
} {
	const violations: string[] = [];
	if (isSingleUserMode()) {
		violations.push(
			'SWARM_SINGLE_USER_MODE=true hands every caller the instance admin. Set SWARM_SINGLE_USER_MODE=false, then create an admin with `swarm users add <identifier> --admin` and `swarm users set-password <identifier>`.',
		);
	}
	if (!isEncryptionEnabled()) {
		violations.push(
			"CREDENTIAL_MASTER_KEY is unset, so credentials would be stored in plaintext. Generate one with: node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"",
		);
	} else {
		const key = validateCredentialMasterKey();
		if (!key.valid) violations.push(key.reason);
	}

	if (violations.length === 0) return { waived: [] };
	if (env[SERVE_ALLOW_INSECURE_ENV] === 'true') return { waived: violations };
	throw new Error(
		[
			'Refusing to start the all-in-one control plane: it serves the network, and this configuration is unsafe there.',
			...violations.map((violation) => `  - ${violation}`),
			`Set ${SERVE_ALLOW_INSECURE_ENV}=true to start anyway (see docs/configuration.md).`,
		].join('\n'),
	);
}
