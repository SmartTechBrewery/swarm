/**
 * Signing an operator in to a control plane, and asking it who a cached session
 * resolves to — the network half of `swarm login` (`../commands/login.ts`, issue
 * #798), factored out with issue #1311 so `swarm-worker setup` / `login` sign in
 * the same way with no SWARM clone on the machine.
 *
 * It is handed the control-plane URL and never resolves one: no `.env` is read or
 * written here, and nothing is put into `process.env`. That is what lets the
 * launcher package (`../../launcher/swarm-worker.ts`) use it — the package holds
 * no `.env` and must not create one — while `swarm login` keeps its own
 * bootstrap (`ensureControlPlaneUrl`) in front of it.
 *
 * The password goes to the control plane in the request body and nowhere else:
 * it is never printed, logged, cached or returned. Only the session token it
 * mints is kept, in the per-installation cache (`./operator-session-cache.ts`,
 * `700`/`600`), and that token is never printed either.
 *
 * Every response is read through a Zod schema declared here rather than imported
 * from `../../router/operator-session.ts`, which would pull `../../identity/auth.ts`
 * and its `../../db/*` tree into a CLI whose whole point is holding no
 * `DATABASE_URL`. None is `.strict()`, so a control plane answering with more
 * fields — a newer one — is not a failure.
 */

import { z } from 'zod';
import { CONTROL_PLANE_ENV } from './control-plane-env.js';
import { writeOperatorSessionCache } from './operator-session-cache.js';

/** Long enough for a scrypt verification on a loaded host, short enough to fail rather than hang. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The `fetch` surface used here — injectable so tests drive it without a network. */
export type SignInFetch = (
	input: string,
	init: RequestInit,
) => Promise<{ status: number; json: () => Promise<unknown> }>;

/** A control plane's `/operator/session` endpoint, and the base URL it was derived from. */
export interface SessionEndpoint {
	url: string;
	base: string;
}

/**
 * Derive the session endpoint from a control-plane base URL, mirroring the daemon's
 * own validation (`../../transport/worker-client.ts`'s `deriveTransportUrls`) so a
 * URL that works for one works for the other. A base path is preserved, for a
 * router mounted under a sub-path.
 */
export function sessionEndpoint(raw: string): SessionEndpoint | { error: string } {
	const value = raw.trim();
	if (!value)
		return {
			error: `${CONTROL_PLANE_ENV} is unset — point it at this installation's router (e.g. https://swarm.example.com)`,
		};
	let base: URL;
	try {
		base = new URL(value);
	} catch {
		return { error: `${CONTROL_PLANE_ENV} is not a valid URL: '${value}'` };
	}
	if (base.protocol !== 'http:' && base.protocol !== 'https:')
		return { error: `${CONTROL_PLANE_ENV} must be an http(s) URL, got '${value}'` };
	const httpBase = base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`;
	return { url: new URL('operator/session', httpBase).toString(), base: value };
}

/**
 * One request to `/operator/session`, with every transport failure collapsed into
 * `undefined` so callers report "unreachable" rather than leaking a stack trace.
 */
export async function sessionRequest(
	url: string,
	init: RequestInit,
	fetchImpl?: SignInFetch,
): Promise<{ status: number; body: unknown } | undefined> {
	try {
		const res = await (fetchImpl ?? globalThis.fetch)(url, {
			...init,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const body = await res.json().catch(() => undefined);
		return { status: res.status, body };
	} catch {
		return undefined;
	}
}

const SessionUserSchema = z.object({
	id: z.string().min(1),
	identifier: z.string().min(1),
	displayName: z.string().min(1),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

const LoginResponseSchema = z.object({
	token: z.string().min(1),
	expiresAt: z.string().min(1),
	user: SessionUserSchema,
});

export const WhoamiResponseSchema = z.object({ user: SessionUserSchema });

/** The one line an unreachable control plane is reported with. */
export function unreachableMessage(url: string): string {
	return `could not reach the control plane at ${url} (is it running, and is ${CONTROL_PLANE_ENV} right?)`;
}

export interface SignInInput {
	controlPlaneUrl: string;
	identifier: string;
	password: string;
	fetch?: SignInFetch;
	/** Injectable so tests never touch the real home directory or clock. */
	homeDir?: string;
	now?: () => number;
}

export type SignInResult =
	| {
			ok: true;
			token: string;
			identifier: string;
			expiresAt: string;
			/** Where the session was cached. */
			path: string;
	  }
	| { ok: false; error: string };

/**
 * Sign in, prove the minted token authenticates, and cache it for this
 * installation. Never throws for anything the control plane or the network does:
 * every failure is one operator-facing line in `error`, which never carries the
 * password or the token.
 */
export async function signIn(input: SignInInput): Promise<SignInResult> {
	const endpoint = sessionEndpoint(input.controlPlaneUrl);
	if ('error' in endpoint) return { ok: false, error: endpoint.error };

	const response = await sessionRequest(
		endpoint.url,
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ identifier: input.identifier, password: input.password }),
		},
		input.fetch,
	);
	if (!response) return { ok: false, error: unreachableMessage(endpoint.url) };
	if (response.status === 401)
		// The control plane does not distinguish an unknown identifier from a wrong
		// password, and neither does this line.
		return {
			ok: false,
			error: `login to ${endpoint.base} failed — check the identifier and password, and that this is the installation you meant`,
		};
	if (response.status !== 200)
		return { ok: false, error: `the control plane refused the login (HTTP ${response.status})` };
	const parsed = LoginResponseSchema.safeParse(response.body);
	if (!parsed.success)
		return {
			ok: false,
			error:
				'the control plane answered the login with an unexpected response (is it running a different version?)',
		};
	const minted = parsed.data;

	// Prove the minted token actually authenticates before caching it, so a broken
	// session is a failed sign-in rather than a puzzling refusal later.
	const verified = await sessionRequest(
		endpoint.url,
		{ method: 'GET', headers: { authorization: `Bearer ${minted.token}` } },
		input.fetch,
	);
	if (!verified || verified.status !== 200) {
		await revokeSession(endpoint.url, minted.token, input.fetch);
		return {
			ok: false,
			error: verified
				? `the control plane did not accept the session it just issued (HTTP ${verified.status})`
				: unreachableMessage(endpoint.url),
		};
	}

	const path = writeOperatorSessionCache({
		controlPlaneUrl: endpoint.base,
		token: minted.token,
		userId: minted.user.id,
		identifier: minted.user.identifier,
		expiresAt: minted.expiresAt,
		homeDir: input.homeDir,
		now: input.now,
	});
	return {
		ok: true,
		token: minted.token,
		identifier: minted.user.identifier,
		expiresAt: minted.expiresAt,
		path,
	};
}

/** Best-effort revocation, for a minted session that could not be verified. */
export async function revokeSession(
	url: string,
	token: string,
	fetchImpl?: SignInFetch,
): Promise<void> {
	await sessionRequest(
		url,
		{ method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
		fetchImpl,
	);
}

/** What the control plane says a cached session token resolves to. */
export type SessionCheck =
	| { kind: 'live'; user: SessionUser }
	| { kind: 'rejected' }
	| { kind: 'failed'; error: string };

/**
 * Ask the control plane who `token` resolves to. The token is opaque here and can
 * be revoked server-side at any time, so a local record can only ever say who it
 * *was* issued to — this is what says whether it still works.
 */
export async function checkSession(
	controlPlaneUrl: string,
	token: string,
	fetchImpl?: SignInFetch,
): Promise<SessionCheck> {
	const endpoint = sessionEndpoint(controlPlaneUrl);
	if ('error' in endpoint) return { kind: 'failed', error: endpoint.error };
	const response = await sessionRequest(
		endpoint.url,
		{ method: 'GET', headers: { authorization: `Bearer ${token}` } },
		fetchImpl,
	);
	if (!response) return { kind: 'failed', error: unreachableMessage(endpoint.url) };
	if (response.status === 401) return { kind: 'rejected' };
	if (response.status !== 200)
		return {
			kind: 'failed',
			error: `the control plane could not resolve the cached session (HTTP ${response.status})`,
		};
	const parsed = WhoamiResponseSchema.safeParse(response.body);
	if (!parsed.success)
		return {
			kind: 'failed',
			error:
				'the control plane answered the cached-session check with an unexpected response (is it running a different version?)',
		};
	return { kind: 'live', user: parsed.data.user };
}
