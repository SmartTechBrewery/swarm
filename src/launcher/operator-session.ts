/**
 * The operator session `swarm-worker setup`, `login` and `status` (issue #1311)
 * act with: the one `swarm login` caches (`../cli/_shared/operator-session-cache.ts`,
 * `~/.swarm/operator-sessions/`, `700`/`600`), reused while it is live, otherwise
 * minted by signing in (`../cli/_shared/operator-sign-in.ts`).
 *
 * Always handed the control-plane URL: nothing here reads or writes a `.env`, or
 * consults `SWARM_CONTROL_PLANE_URL`, because the launcher package holds no `.env`
 * and a host with no SWARM clone has no checkout default to fall back to.
 *
 * The password is read (typed without echo, or from `--password-file`), sent in
 * the sign-in request, and dropped — never printed, logged or stored. Only the
 * session token is cached, and it is never printed either.
 */

import {
	createOperatorClient,
	type FetchLike,
	type OperatorClient,
	type OperatorSession,
} from '../cli/_shared/operator-client.js';
import { readOperatorSessionCache } from '../cli/_shared/operator-session-cache.js';
import { checkSession, type SignInFetch, signIn } from '../cli/_shared/operator-sign-in.js';
import * as out from '../cli/_shared/output.js';
import { type PromptIo, resolveAnswer, resolveSecret } from './operator-prompts.js';

/** The command an expired session is renewed with, named in every refusal that needs it. */
export function loginCommandFor(controlPlaneUrl: string): string {
	return `swarm-worker login --control-plane-url ${controlPlaneUrl}`;
}

/** An operator-API client for `session`, whose expired-session refusal names `swarm-worker login`. */
export function operatorClientFor(session: OperatorSession, fetch?: FetchLike): OperatorClient {
	return createOperatorClient({
		controlPlaneUrl: session.controlPlaneUrl,
		token: session.token,
		fetchImpl: fetch,
		loginCommand: loginCommandFor(session.controlPlaneUrl),
	});
}

/**
 * This host's cached session for `controlPlaneUrl` while it has not expired by its
 * own clock — without asking the control plane, so a caller that will spend the
 * token anyway (`status`) makes no extra request. `undefined` for none, an
 * unreadable one, or an expired one.
 */
export function cachedSession(
	controlPlaneUrl: string,
	options: { homeDir?: string; now?: () => number } = {},
): OperatorSession | undefined {
	const cached = readOperatorSessionCache(controlPlaneUrl, options.homeDir);
	if (!cached) return undefined;
	if (Date.parse(cached.expiresAt) <= (options.now ?? Date.now)()) return undefined;
	return { controlPlaneUrl, token: cached.token, identifier: cached.identifier };
}

export interface EnsureSessionInput {
	command: string;
	controlPlaneUrl: string;
	/** `--email` / `--identifier`. A live session for another identifier is not reused. */
	email?: string;
	/** `--password-file <path|->`. */
	passwordFile?: string;
	/** Sign in even when a live session is cached — what `login` is for. */
	renew?: boolean;
	io: PromptIo;
	fetch?: SignInFetch;
	homeDir?: string;
	now?: () => number;
}

/**
 * A live operator session for the installation: the cached one when it still
 * authenticates (and, given `--email`, is that identifier's), with no password
 * asked for; otherwise a fresh sign-in. Answers `{ error }` — one line, never
 * carrying a secret — for anything that stops it.
 */
export async function ensureSession(
	input: EnsureSessionInput,
): Promise<{ session: OperatorSession; reused: boolean } | { error: string }> {
	const { controlPlaneUrl, io, command } = input;
	const cached = readOperatorSessionCache(controlPlaneUrl, input.homeDir) ?? undefined;
	const wanted = input.email?.trim();
	const sameIdentifier =
		!wanted || (cached && cached.identifier.toLowerCase() === wanted.toLowerCase());
	const live = input.renew
		? undefined
		: cachedSession(controlPlaneUrl, { homeDir: input.homeDir, now: input.now });
	if (live && sameIdentifier) {
		const check = await checkSession(controlPlaneUrl, live.token, input.fetch);
		if (check.kind === 'live') {
			out.info(`using your session on ${controlPlaneUrl} as '${check.user.identifier}'`);
			return { session: { ...live, identifier: check.user.identifier }, reused: true };
		}
		if (check.kind === 'failed') return { error: check.error };
		// Rejected — expired or revoked server-side — so sign in again below.
	}

	const email = await resolveAnswer(io, {
		command,
		what: 'the email you sign in to SWARM with',
		flag: '--email <email>',
		value: wanted,
		question: 'Email',
		// The handle this host last signed in as there: offered on a terminal, and used
		// with no terminal, so renewing an expired session needs only the password.
		fallback: cached?.identifier,
	});
	if ('error' in email) return email;
	const password = await resolveSecret(io, {
		command,
		what: 'your SWARM password',
		flag: '--password-file <path|->',
		source: input.passwordFile,
		prompt: 'Password: ',
	});
	if ('error' in password) return password;

	const signedIn = await signIn({
		controlPlaneUrl,
		identifier: email.value,
		password: password.value,
		fetch: input.fetch,
		homeDir: input.homeDir,
		now: input.now,
	});
	if (!signedIn.ok) return { error: signedIn.error };
	// The identifier, the expiry and the path — never the token.
	out.info(`signed in to ${controlPlaneUrl} as '${signedIn.identifier}'`);
	out.info(`session expires ${signedIn.expiresAt}; cached at ${signedIn.path}`);
	return {
		session: { controlPlaneUrl, token: signedIn.token, identifier: signedIn.identifier },
		reused: false,
	};
}
