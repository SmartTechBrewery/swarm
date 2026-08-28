/**
 * The operator session API — how a human authenticates the CLI to the control
 * plane **over the network** (issue #798).
 *
 * Until now the only way to authenticate to this installation was the dashboard's
 * session *cookie*, resolved in `../api/server.ts`'s `createContext`. That serves
 * a browser and nothing else: there was no API key, no personal-access-token, and
 * no `swarm login` anywhere in the repo, so an operator on a machine that holds
 * only `SWARM_CONTROL_PLANE_URL` reachability — no `DATABASE_URL`, no browser —
 * had no identity at all. These three routes are that missing concept, and
 * `../cli/commands/login.ts` is their client.
 *
 * **Why this surface is on the router and not on the API server.**
 * `SWARM_CONTROL_PLANE_URL` points at *this* process (`docs/configuration.md`,
 * `docs/cloudflare-tunnel.md`), which is the only tunnel-exposed one; the API
 * server binds `127.0.0.1` and ships in no Compose service
 * (`docs/public-hosting-exploration.md` §2). A login endpoint an operator cannot
 * reach is not a login endpoint.
 *
 * **`SWARM_SINGLE_USER_MODE` is deliberately not honoured here.** The API server
 * can hand every `/trpc/*` request the bootstrapped passwordless `localhost-admin`
 * (`../api/server.ts`) precisely because it is loopback-only. This process is
 * internet-reachable through the tunnel, so the same branch would be an open
 * door — anyone who found the URL would be an installation admin. A single-user
 * installation therefore sets a password once (`swarm users set-password
 * localhost-admin`) and logs in like anyone else. Nothing in this module reads
 * that variable, and nothing should start.
 *
 * No new credential type, table, or hashing: `verifyCredentials` / `createSession`
 * / `resolveSession` / `revokeSession` (`../identity/auth.ts`) are reused verbatim,
 * so a `swarm login` is an ordinary `user_sessions` row governed by
 * `SWARM_SESSION_TTL_HOURS`, and re-running `swarm login` is the renewal path.
 *
 * Three routes under `/operator/session`:
 *   - `POST`   — `{ identifier, password }` → `{ token, expiresAt, user }`.
 *   - `GET`    — `Authorization: Bearer <token>` → `{ user }`.
 *   - `DELETE` — bearer → revoke; always `200 { ok: true }`.
 *
 * Mirrors `./worker-delivery.ts`: the request logic is factored out of the HTTP
 * glue into pure, injectable functions (`handleOperatorLogin`,
 * `handleOperatorWhoami`, `handleOperatorLogout`) so tests drive them with fake
 * deps and never need a live router. Both secrets — the password on the way in and
 * the minted token on the way out — appear only in the request body or the
 * `Authorization` header; neither is ever logged, and a *rejected* one is never
 * reflected in a response.
 */

import type { Context, Hono } from 'hono';
import { z } from 'zod';

import {
	createSession,
	type MintedSession,
	resolveSession,
	revokeSession,
	verifyCredentials,
} from '../identity/auth.js';
import type { SwarmUser } from '../identity/schema.js';

/** The login body. Both fields are secrets' carriers, so neither is echoed back. */
export const OperatorLoginRequestSchema = z.object({
	identifier: z.string().min(1),
	password: z.string().min(1),
});

/**
 * Collaborators the operator-session API depends on, defaulted to the real
 * identity services so production wiring is a bare `registerOperatorSession(app)`;
 * tests inject fakes. Mirrors `WorkerDeliveryDeps` in `./worker-delivery.ts`.
 */
export interface OperatorSessionDeps {
	verifyCredentials: (identifier: string, password: string) => Promise<SwarmUser | undefined>;
	createSession: (userId: string) => Promise<MintedSession>;
	resolveSession: (rawToken: string) => Promise<SwarmUser | undefined>;
	revokeSession: (rawToken: string) => Promise<void>;
}

function defaultDeps(): OperatorSessionDeps {
	return { verifyCredentials, createSession, resolveSession, revokeSession };
}

/** An operator-session outcome: the HTTP status and the JSON body to return. */
export interface OperatorSessionResult {
	status: 200 | 400 | 401;
	json: Record<string, unknown>;
}

/**
 * Extract the raw token from an `Authorization: Bearer <token>` header — the
 * reusable half of these routes, exported because the operator-facing API mounted
 * on this process authenticates exactly the same way.
 */
export function resolveOperatorBearer(c: Context): string | undefined {
	const authorization = c.req.header('authorization');
	if (!authorization) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
	return match ? match[1] : undefined;
}

/**
 * Log in as a pure function of its deps and the request body: validate → verify
 * the credentials → mint a session. Returns the raw token exactly once, which is
 * the only time it exists outside the caller's cache.
 *
 * A wrong password and an unknown identifier are the *same* answer, deliberately:
 * `verifyCredentials` already returns `undefined` for both and spends the same
 * scrypt time on each, so neither the body nor the timing tells an unauthenticated
 * caller whether an identifier exists.
 */
export async function handleOperatorLogin(
	deps: OperatorSessionDeps,
	body: unknown,
): Promise<OperatorSessionResult> {
	const parsed = OperatorLoginRequestSchema.safeParse(body);
	if (!parsed.success)
		return {
			status: 400,
			json: { error: 'Bad Request', reason: 'identifier and password are required' },
		};

	const user = await deps.verifyCredentials(parsed.data.identifier, parsed.data.password);
	if (!user) return { status: 401, json: { error: 'Unauthorized', reason: 'Invalid credentials' } };

	const session = await deps.createSession(user.id);
	return {
		status: 200,
		json: { token: session.token, expiresAt: session.expiresAt.toISOString(), user },
	};
}

/**
 * Resolve a bearer token to its user — how `swarm login --status` answers "who am
 * I?" by *asking* rather than by decoding an opaque token it cannot read. An
 * absent, expired, revoked or unknown token are one answer: `401`.
 */
export async function handleOperatorWhoami(
	deps: OperatorSessionDeps,
	token: string | undefined,
): Promise<OperatorSessionResult> {
	const user = token ? await deps.resolveSession(token) : undefined;
	if (!user) return { status: 401, json: { error: 'Unauthorized', reason: 'Invalid session' } };
	return { status: 200, json: { user } };
}

/**
 * Revoke a bearer token. Always `200 { ok: true }` — idempotent like
 * `/auth/logout`, so a re-run, a token this installation never minted, and a
 * request carrying none at all all leave the caller free to drop its local copy.
 */
export async function handleOperatorLogout(
	deps: OperatorSessionDeps,
	token: string | undefined,
): Promise<OperatorSessionResult> {
	if (token) await deps.revokeSession(token);
	return { status: 200, json: { ok: true } };
}

/**
 * Wire the operator-session routes onto the router's Hono `app`, next to
 * `registerWorkerTransport` / `registerWorkerDelivery`. Pass `overrides` to
 * substitute collaborators in tests; omit for production wiring.
 */
export function registerOperatorSession(
	app: Hono,
	overrides: Partial<OperatorSessionDeps> = {},
): void {
	const deps = { ...defaultDeps(), ...overrides };

	app.post('/operator/session', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			body = undefined;
		}
		const result = await handleOperatorLogin(deps, body);
		return c.json(result.json, result.status);
	});

	app.get('/operator/session', async (c) => {
		const result = await handleOperatorWhoami(deps, resolveOperatorBearer(c));
		return c.json(result.json, result.status);
	});

	app.delete('/operator/session', async (c) => {
		const result = await handleOperatorLogout(deps, resolveOperatorBearer(c));
		return c.json(result.json, result.status);
	});
}
