/**
 * The router-hosted **operator MCP endpoint** (issue #1338) — an MCP server an
 * assistant session connects to in order to monitor (and, in later phases,
 * unblock) the pipeline, served at `/operator/mcp` beside the operator API's
 * `/operator/trpc` and authenticated by the same `swarm login` bearer token.
 *
 * **Why it is here and not on the API server.** Same reasoning as
 * `./operator-api.ts`: `SWARM_CONTROL_PLANE_URL` points at *this* process, the only
 * network-reachable one on a split deployment, and the all-in-one control plane
 * already path-routes `/operator/*` to it — so a client off the control-plane host
 * reaches this endpoint wherever it reaches `swarm login`.
 *
 * **Authentication is exactly the operator API's.** `Authorization: Bearer <token>`,
 * resolved with `resolveSession`; a request with no bearer, or one whose token is
 * unknown, expired or revoked, is answered `401` before any MCP message is read.
 * **`SWARM_SINGLE_USER_MODE` is deliberately not honoured**, for the reason
 * `./operator-api.ts` gives: on an internet-reachable process it would make anyone
 * who found the URL an installation admin. Nothing in this module reads that
 * variable, and nothing should start.
 *
 * **Authorization is exactly the dashboard's.** Every tool calls the dashboard's own
 * tRPC procedure as the resolved user (`../mcp/tool-helpers.ts`), so a bearer caller
 * reads exactly what the same user reads in the browser.
 *
 * **Stateless Streamable HTTP.** Each `POST` builds a fresh server and transport for
 * the resolved user, answers with plain JSON (`enableJsonResponse`), and closes both
 * — no MCP session id, no in-memory state, nothing to lose when the router
 * restarts. With no sessions there is no server-initiated stream to open (`GET`)
 * and no session to end (`DELETE`), so every method but `POST` is `405`.
 */

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';

// Side-effect import: registers every PM and SCM provider manifest into its
// registry, for the same reason `./operator-api.ts` states it — the procedures the
// tools call read the registry at request time, and this module must not depend on
// a sibling having loaded it first.
import '../integrations/entrypoint.js';
import { resolveSession } from '../identity/auth.js';
import type { SwarmUser } from '../identity/schema.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { createSwarmMcpServer } from '../mcp/server.js';
import { resolveOperatorBearer } from './operator-session.js';

/** The path the operator MCP server is served at. Kept as one constant so the mount and the docs agree. */
export const OPERATOR_MCP_ENDPOINT = '/operator/mcp';

/**
 * Collaborators the endpoint depends on, defaulted to the real identity service so
 * production wiring is a bare `registerOperatorMcp(app)`; tests inject a fake.
 * Mirrors `OperatorApiDeps` in `./operator-api.ts`.
 */
export interface OperatorMcpDeps {
	resolveSession: (rawToken: string) => Promise<SwarmUser | undefined>;
}

/**
 * Wire the operator MCP endpoint onto the router's Hono `app`, beside
 * `registerOperatorApi`. Pass `overrides` to substitute the session lookup in tests;
 * omit for production wiring.
 */
export function registerOperatorMcp(app: Hono, overrides: Partial<OperatorMcpDeps> = {}): void {
	const deps: OperatorMcpDeps = { resolveSession, ...overrides };

	app.all(OPERATOR_MCP_ENDPOINT, async (c) => {
		const token = resolveOperatorBearer(c);
		const user = token ? await deps.resolveSession(token) : undefined;
		if (!user) {
			return c.json({ error: 'Unauthorized' }, 401);
		}
		if (c.req.method !== 'POST') {
			c.header('Allow', 'POST');
			return c.json({ error: 'Method not allowed: this MCP server is stateless, POST only' }, 405);
		}

		const server = createSwarmMcpServer(user);
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		try {
			await server.connect(transport);
			return await transport.handleRequest(c.req.raw);
		} catch (error) {
			logger.warn('operator MCP request failed', { error: describeError(error) });
			return c.json(
				{ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
				500,
			);
		} finally {
			// JSON-response mode has settled every reply by the time `handleRequest`
			// returns, so the per-request server can be torn down here.
			await server.close().catch(() => undefined);
		}
	});
}
