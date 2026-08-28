/**
 * The router-hosted **operator API** (issue #799) — the tRPC surface `swarm
 * workers` calls over the network, mounted at `/operator/trpc/*` and
 * authenticated by the bearer token `./operator-session.ts` mints (issue #798).
 *
 * **Why it is here and not on the API server.** Same reasoning as the operator
 * session routes beside it: `SWARM_CONTROL_PLANE_URL` points at *this* process
 * (`docs/configuration.md`, `docs/cloudflare-tunnel.md`), which is the only
 * tunnel-exposed one, while the API server binds `127.0.0.1` and ships in no
 * Compose service. An operator token with nothing to spend it on would be a login
 * that logs you in nowhere.
 *
 * **What it exposes is deliberately narrow.** `operatorRouter`
 * (`../api/operator-router.ts`) is a strict subset — the `workers` namespace and
 * nothing else — never `appRouter`. Because this process is internet-reachable,
 * mounting the dashboard's whole router here would publish projects, credentials,
 * settings, users and runs, none of which the CLI needs and all of which stay on
 * loopback today.
 *
 * **`SWARM_SINGLE_USER_MODE` is deliberately not honoured**, exactly as in
 * `./operator-session.ts`. The API server can resolve the bootstrapped
 * passwordless `localhost-admin` for every `/trpc/*` request precisely because it
 * is loopback-only; doing the same here would make anyone who found the tunnel URL
 * an installation admin. Nothing in this module reads that variable, and nothing
 * should start. A single-user installation sets a password once
 * (`swarm users set-password localhost-admin`) and runs `swarm login`.
 *
 * The context is built the same way `../api/server.ts` builds its own, minus both
 * branches that do not apply: no cookie is read, and no single-user shortcut
 * exists. A request with no bearer — or one whose token `resolveSession` rejects as
 * unknown, expired or revoked — gets `user: null`, which `authedProcedure`
 * (`../api/trpc.ts`) turns into `UNAUTHORIZED`. No procedure here is public.
 *
 * No data transformer is configured, matching `initTRPC.context<TrpcContext>()
 * .create()` in `../api/trpc.ts`: the wire format stays plain JSON so a
 * hand-rolled CLI client needs no tRPC dependency of its own.
 */

import { trpcServer } from '@hono/trpc-server';
import type { Hono } from 'hono';

import { operatorRouter } from '../api/operator-router.js';
import type { TrpcContext } from '../api/trpc.js';
// Side-effect import: registers every PM and SCM provider manifest into its
// registry. `../api/operator-router.ts` does this too, and the router already
// loads it via `./webhook-receiver.ts` — stated here as well because this module
// serves procedures that read the registry at request time and must not depend on
// a sibling having loaded it first (matching `./worker-delivery.ts`).
import '../integrations/entrypoint.js';
import { resolveSession } from '../identity/auth.js';
import type { SwarmUser } from '../identity/schema.js';
import { resolveOperatorBearer } from './operator-session.js';

/** The path the operator API is served under. Kept as one constant so the mount and the endpoint agree. */
export const OPERATOR_TRPC_ENDPOINT = '/operator/trpc';

/**
 * Collaborators the operator API depends on, defaulted to the real identity
 * service so production wiring is a bare `registerOperatorApi(app)`; tests inject
 * a fake. Mirrors `OperatorSessionDeps` in `./operator-session.ts`.
 */
export interface OperatorApiDeps {
	resolveSession: (rawToken: string) => Promise<SwarmUser | undefined>;
}

/**
 * Wire the operator API onto the router's Hono `app`, beside
 * `registerWorkerDelivery` / `registerOperatorSession`. Pass `overrides` to
 * substitute the session lookup in tests; omit for production wiring.
 */
export function registerOperatorApi(app: Hono, overrides: Partial<OperatorApiDeps> = {}): void {
	const deps: OperatorApiDeps = { resolveSession, ...overrides };

	app.use(
		`${OPERATOR_TRPC_ENDPOINT}/*`,
		trpcServer({
			endpoint: OPERATOR_TRPC_ENDPOINT,
			router: operatorRouter,
			createContext: async (_opts, c): Promise<TrpcContext> => {
				const token = resolveOperatorBearer(c);
				const user = token ? await deps.resolveSession(token) : undefined;
				return { user: user ?? null };
			},
		}),
	);
}
