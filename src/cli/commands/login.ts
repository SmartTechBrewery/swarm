/**
 * `swarm login` — authenticate this machine's operator CLI to the control plane
 * (issue #798).
 *
 * Every other DB-touching `swarm` command reaches Postgres directly, which is only
 * possible on the control-plane host. This one is the opposite by design: it holds
 * **no** `DATABASE_URL` and imports nothing from `../../db/*`, talking to the
 * router's `/operator/session` routes (`../../router/operator-session.ts`) over
 * `SWARM_CONTROL_PLANE_URL` exactly as the worker daemon does — resolved by the
 * precedence every command shares (`../_shared/control-plane-env.ts`). That is
 * what makes it usable from a machine that is not the control plane.
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
import { CONTROL_PLANE_ENV, ensureControlPlaneUrl } from '../_shared/control-plane-env.js';
import {
	clearOperatorSessionCache,
	type OperatorSessionCache,
	operatorSessionCachePath,
	readOperatorSessionCache,
} from '../_shared/operator-session-cache.js';
import {
	type SessionEndpoint,
	sessionEndpoint,
	sessionRequest,
	signIn,
	unreachableMessage,
	WhoamiResponseSchema,
} from '../_shared/operator-sign-in.js';
import * as out from '../_shared/output.js';
import { promptHidden, readStdin } from '../_shared/secret-input.js';

const USAGE = `swarm login — sign this CLI in to the control plane

Usage:
  swarm login [--identifier <id>] [--control-plane-url <url>]
  swarm login --status
  swarm login --logout

  --identifier <id>  The login handle to authenticate as. Prompted for on a TTY;
                     required when stdin is a pipe (which carries the password).
  --control-plane-url <url>
                     The installation to sign in to. Overrides
                     ${CONTROL_PLANE_ENV} in the environment, which
                     overrides this checkout's .env. Written to .env only when
                     it carries no assignment; a different one already there is
                     kept, and login warns that it is using another installation.
  --status           Report who the cached session resolves to, by asking the
                     control plane. Exits non-zero when there is no live session.
  --logout           Revoke the session on the control plane and delete the local
                     copy.

The password is typed without echo on a TTY, or read from stdin otherwise. It is
never accepted as an argument, never printed, and never logged; neither is the
session token, which is cached under ~/.swarm/operator-sessions/ at 700/600.

Needs ${CONTROL_PLANE_ENV} — the same router base URL the worker uses, taken
from --control-plane-url, else the environment, else this checkout's .env, as
every swarm command does — and no DATABASE_URL. A single-user installation is not exempt: SWARM_SINGLE_USER_MODE is
deliberately not honoured by the control plane's login routes, so run
\`swarm users set-password localhost-admin\` once and sign in like anyone else.`;

/**
 * Resolve `SWARM_CONTROL_PLANE_URL` — which `ensureControlPlaneUrl` has just put
 * into the environment — into the session endpoint (`sessionEndpoint`).
 */
function resolveSessionEndpoint(): SessionEndpoint | { error: string } {
	return sessionEndpoint(process.env[CONTROL_PLANE_ENV] ?? '');
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

function unreachable(url: string): void {
	out.error(unreachableMessage(url));
}

/** `null` (nothing cached) and `undefined` (unreadable) are different problems, reported as such. */
function requireCachedSession(base: string): OperatorSessionCache | undefined {
	const cached = readOperatorSessionCache(base);
	if (cached === null) {
		out.error(`not signed in to ${base} — run \`swarm login\``);
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

	const signedIn = await signIn({ controlPlaneUrl: endpoint.base, identifier, password });
	if (!signedIn.ok) {
		out.error(signedIn.error);
		return 1;
	}
	// The identifier, the expiry, and the path — never the token.
	out.info(`signed in to ${endpoint.base} as '${signedIn.identifier}'`);
	out.info(`session expires ${signedIn.expiresAt}; cached at ${signedIn.path}`);
	return 0;
}

async function status(endpoint: { url: string; base: string }) {
	const cached = requireCachedSession(endpoint.base);
	if (!cached) return 1;

	// Who the token resolves to is asked, not read off the cache: the token is
	// opaque here, and it can be revoked server-side at any time, so a local record
	// can only ever say who it *was* issued to.
	const response = await sessionRequest(endpoint.url, {
		method: 'GET',
		headers: { authorization: `Bearer ${cached.token}` },
	});
	if (!response) {
		unreachable(endpoint.url);
		return 1;
	}
	if (response.status === 401) {
		out.error(
			`the cached session for ${endpoint.base} was rejected (expired or revoked) — run \`swarm login\``,
		);
		return 1;
	}
	if (response.status !== 200) {
		out.error(`the control plane could not resolve the cached session (HTTP ${response.status})`);
		return 1;
	}
	const parsed = WhoamiResponseSchema.safeParse(response.body);
	if (!parsed.success) {
		out.error(
			'the control plane answered the cached-session check with an unexpected response (is it running a different version?)',
		);
		return 1;
	}
	const resolved = parsed.data;

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
		out.info(`not signed in to ${endpoint.base} — nothing to revoke`);
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

	const response = await sessionRequest(endpoint.url, {
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
			'control-plane-url': { type: 'string' },
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

	// This is the *first* command run on a machine being onboarded, so it is also
	// the first to need the URL — before `workers register-and-enroll`, which does
	// the same bootstrap, has run at all. Same helper, same precedence (flag, then
	// environment, then `.env`), same idempotence: an existing assignment is never
	// rewritten, so signing in again on an onboarded machine writes nothing. A
	// different one only warns — a login leaves nothing behind that reads `.env`,
	// unlike a registered worker (`../_shared/control-plane-env.ts`).
	if (!(await ensureControlPlaneUrl(values['control-plane-url'], { onEnvFileConflict: 'warn' })))
		return 1;

	const endpoint = resolveSessionEndpoint();
	if ('error' in endpoint) {
		out.error(endpoint.error);
		return 1;
	}

	if (values.status) return status(endpoint);
	if (values.logout) return logout(endpoint);
	return login(endpoint, values.identifier);
}
