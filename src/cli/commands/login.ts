/**
 * `swarm login` — authenticate this machine's operator CLI to the control plane
 * (issue #798).
 *
 * Every other DB-touching `swarm` command reaches Postgres directly, which is only
 * possible on the control-plane host. This one is the opposite by design: it holds
 * **no** `DATABASE_URL` and imports nothing from `../../db/*`, talking to the
 * router's `/operator/session` routes (`../../router/operator-session.ts`) over
 * `SWARM_CONTROL_PLANE_URL` exactly as the worker daemon does. That is what makes
 * it usable from a machine that is not the control plane.
 *
 * The password is read without echo on a TTY, or from stdin so a script can pipe
 * it (`../_shared/secret-input.ts`) — never from argv, where it would reach the
 * shell history and `ps`. The identifier is not a secret, so `--identifier` takes
 * it; that is also how a piped login supplies it, since stdin is spoken for by the
 * password.
 *
 * Neither secret is ever printed: a successful login names the identifier the
 * control plane resolved and the *path* the token was cached at
 * (`../_shared/operator-session-cache.ts`), and `--status` answers "who am I?" by
 * asking the control plane rather than by decoding a token it cannot read.
 *
 * A single-user installation is not exempt. `SWARM_SINGLE_USER_MODE` lets the
 * loopback-bound API server resolve a passwordless `localhost-admin`, but these
 * routes are internet-reachable through the tunnel and deliberately ignore it, so
 * set a password once with `swarm users set-password localhost-admin` and log in
 * like anyone else.
 */

import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
	clearOperatorSessionCache,
	type OperatorSessionCache,
	operatorSessionCachePath,
	readOperatorSessionCache,
	writeOperatorSessionCache,
} from '../_shared/operator-session-cache.js';
import * as out from '../_shared/output.js';
import { promptHidden, readStdin } from '../_shared/secret-input.js';

const CONTROL_PLANE_ENV = 'SWARM_CONTROL_PLANE_URL';

/** Long enough for a scrypt verification on a loaded host, short enough to fail rather than hang. */
const REQUEST_TIMEOUT_MS = 30_000;

const USAGE = `swarm login — sign this CLI in to the control plane

Usage:
  swarm login [--identifier <id>]
  swarm login --status
  swarm login --logout

  --identifier <id>  The login handle to authenticate as. Prompted for on a TTY;
                     required when stdin is a pipe (which carries the password).
  --status           Report who the cached session resolves to, by asking the
                     control plane. Exits non-zero when there is no live session.
  --logout           Revoke the session on the control plane and delete the local
                     copy.

The password is typed without echo on a TTY, or read from stdin otherwise. It is
never accepted as an argument, never printed, and never logged; neither is the
session token, which is cached under ~/.swarm/operator-sessions/ at 700/600.

Needs ${CONTROL_PLANE_ENV} — the same router base URL the worker uses — and no
DATABASE_URL. A single-user installation is not exempt: SWARM_SINGLE_USER_MODE is
deliberately not honoured by the control plane's login routes, so run
\`swarm users set-password localhost-admin\` once and sign in like anyone else.`;

/** The resolved `/operator/session` endpoint, or the one line explaining why there isn't one. */
type EndpointResolution = { url: string; base: string } | { error: string };

/**
 * Resolve `SWARM_CONTROL_PLANE_URL` into the session endpoint, mirroring the
 * daemon's own validation (`../../transport/worker-client.ts`'s
 * `deriveTransportUrls`) so a URL that works for one works for the other. A base
 * path is preserved, for a router mounted under a sub-path.
 */
function resolveSessionEndpoint(): EndpointResolution {
	const raw = process.env[CONTROL_PLANE_ENV]?.trim();
	if (!raw)
		return {
			error: `${CONTROL_PLANE_ENV} is unset — point it at this installation's router (e.g. https://swarm.example.com)`,
		};

	let base: URL;
	try {
		base = new URL(raw);
	} catch {
		return { error: `${CONTROL_PLANE_ENV} is not a valid URL: '${raw}'` };
	}
	if (base.protocol !== 'http:' && base.protocol !== 'https:')
		return { error: `${CONTROL_PLANE_ENV} must be an http(s) URL, got '${raw}'` };

	const httpBase = base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`;
	return { url: new URL('operator/session', httpBase).toString(), base: raw };
}

/** Ask for the (non-secret) identifier on a TTY, with echo — unlike the password. */
async function promptIdentifier(): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await rl.question('Identifier: ')).trim();
	} finally {
		rl.close();
	}
}

/**
 * One request to `/operator/session`, with every transport failure collapsed into
 * `undefined` so callers report "unreachable" rather than leaking a stack trace.
 */
async function request(
	url: string,
	init: RequestInit,
): Promise<{ status: number; body: unknown } | undefined> {
	try {
		const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
		const body = await res.json().catch(() => undefined);
		return { status: res.status, body };
	} catch {
		return undefined;
	}
}

/**
 * What this command reads off each response, declared rather than duck-typed
 * (ai/CODING_STANDARDS.md "Zod is the source of truth"). Declared *here* and not
 * shared with `../../router/operator-session.ts` on purpose: importing that module
 * would pull `../../identity/auth.ts` and its `../../db/*` tree into a CLI whose
 * whole point is holding no `DATABASE_URL`. Neither is `.strict()`, so a control
 * plane that answers with more fields than these — a newer one, or one serving an
 * older client — is not a failure.
 */
const SessionUserSchema = z.object({
	id: z.string().min(1),
	identifier: z.string().min(1),
	displayName: z.string().min(1),
});

const LoginResponseSchema = z.object({
	token: z.string().min(1),
	expiresAt: z.string().min(1),
	user: SessionUserSchema,
});

const WhoamiResponseSchema = z.object({ user: SessionUserSchema });

function unreachable(url: string): void {
	out.error(
		`could not reach the control plane at ${url} (is it running, and is ${CONTROL_PLANE_ENV} right?)`,
	);
}

/** `null` (nothing cached) and `undefined` (unreadable) are different problems, reported as such. */
function requireCachedSession(base: string): OperatorSessionCache | undefined {
	const cached = readOperatorSessionCache(base);
	if (cached === null) {
		out.error('not signed in — run `swarm login`');
		return undefined;
	}
	if (cached === undefined) {
		out.error(
			`the cached session at ${operatorSessionCachePath(base)} could not be read — run \`swarm login\` to replace it`,
		);
		return undefined;
	}
	return cached;
}

async function login(endpoint: { url: string; base: string }, flagIdentifier?: string) {
	const interactive = process.stdin.isTTY === true;

	let identifier = flagIdentifier?.trim();
	if (!identifier) {
		if (!interactive) {
			out.error('--identifier <id> is required when stdin is a pipe (which carries the password)');
			return 1;
		}
		identifier = await promptIdentifier();
	}
	if (!identifier) {
		out.error('an identifier is required');
		return 1;
	}

	// Typed without echo, or piped — never argv.
	const password = interactive ? await promptHidden('Password: ') : await readStdin();
	if (password.length === 0) {
		out.error('password must not be empty');
		return 1;
	}

	const response = await request(endpoint.url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ identifier, password }),
	});
	if (!response) {
		unreachable(endpoint.url);
		return 1;
	}
	if (response.status === 401) {
		// The control plane does not distinguish an unknown identifier from a wrong
		// password, and neither does this line.
		out.error('login failed — check the identifier and password');
		return 1;
	}
	const minted =
		response.status === 200 ? LoginResponseSchema.safeParse(response.body).data : undefined;
	if (!minted) {
		out.error(`the control plane refused the login (HTTP ${response.status})`);
		return 1;
	}

	// Prove the minted token actually authenticates before caching it, so a broken
	// session is a failed `login` rather than a puzzling `--status` later.
	const verified = await request(endpoint.url, {
		method: 'GET',
		headers: { authorization: `Bearer ${minted.token}` },
	});
	if (!verified) {
		unreachable(endpoint.url);
		return 1;
	}
	if (verified.status !== 200) {
		out.error(
			`the control plane did not accept the session it just issued (HTTP ${verified.status})`,
		);
		return 1;
	}

	const path = writeOperatorSessionCache({
		controlPlaneUrl: endpoint.base,
		token: minted.token,
		userId: minted.user.id,
		identifier: minted.user.identifier,
		expiresAt: minted.expiresAt,
	});
	// The identifier, the expiry, and the path — never the token.
	out.info(`signed in to ${endpoint.base} as '${minted.user.identifier}'`);
	out.info(`session expires ${minted.expiresAt}; cached at ${path}`);
	return 0;
}

async function status(endpoint: { url: string; base: string }) {
	const cached = requireCachedSession(endpoint.base);
	if (!cached) return 1;

	// Who the token resolves to is asked, not read off the cache: the token is
	// opaque here, and it can be revoked server-side at any time, so a local record
	// can only ever say who it *was* issued to.
	const response = await request(endpoint.url, {
		method: 'GET',
		headers: { authorization: `Bearer ${cached.token}` },
	});
	if (!response) {
		unreachable(endpoint.url);
		return 1;
	}
	if (response.status === 401) {
		out.error('the cached session was rejected (expired or revoked) — run `swarm login`');
		return 1;
	}
	const resolved =
		response.status === 200 ? WhoamiResponseSchema.safeParse(response.body).data : undefined;
	if (!resolved) {
		out.error(`the control plane could not resolve the cached session (HTTP ${response.status})`);
		return 1;
	}

	out.info(
		`signed in to ${endpoint.base} as '${resolved.user.identifier}' (${resolved.user.displayName})`,
	);
	// The expiry the control plane issued at login; the resolve above is what proves
	// the session is still live.
	out.info(`session expires ${cached.expiresAt}`);
	return 0;
}

/**
 * Revoke the session and drop the local copy. The cache is cleared **whichever
 * way the DELETE goes** — a control plane that cannot be reached is no reason to
 * leave a token on this disk — but a revocation that was not confirmed is a
 * non-zero exit that says so, because the token stays live server-side until it
 * expires.
 */
async function logout(endpoint: { url: string; base: string }) {
	const cached = readOperatorSessionCache(endpoint.base);
	if (cached === null) {
		out.info('not signed in — nothing to revoke');
		return 0;
	}

	// An unreadable entry still gets deleted: nothing can be revoked with it, and
	// leaving it behind only keeps `--status` failing.
	if (cached === undefined) {
		clearOperatorSessionCache(endpoint.base);
		out.warn(`removed an unreadable cached session at ${operatorSessionCachePath(endpoint.base)}`);
		out.error(
			'it carried no usable token, so nothing was revoked — any session it named stays live until it expires',
		);
		return 1;
	}

	const response = await request(endpoint.url, {
		method: 'DELETE',
		headers: { authorization: `Bearer ${cached.token}` },
	});
	clearOperatorSessionCache(endpoint.base);

	if (!response || response.status < 200 || response.status >= 300) {
		out.warn('removed the local session');
		out.error(
			`but the control plane at ${endpoint.url} did not confirm the revocation — the session stays live there until ${cached.expiresAt}`,
		);
		return 1;
	}

	out.info(`signed out of ${endpoint.base}`);
	return 0;
}

export async function run(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			identifier: { type: 'string' },
			status: { type: 'boolean' },
			logout: { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: false,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}
	if (values.status && values.logout) {
		out.error('login: --status and --logout are mutually exclusive');
		return 1;
	}

	const endpoint = resolveSessionEndpoint();
	if ('error' in endpoint) {
		out.error(endpoint.error);
		return 1;
	}

	if (values.status) return status(endpoint);
	if (values.logout) return logout(endpoint);
	return login(endpoint, values.identifier);
}
