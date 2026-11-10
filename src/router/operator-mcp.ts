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
 * **Authentication: one header, two credentials** (issue #1362). `Authorization:
 * Bearer <token>`, where the token is either the `swarm login` session the operator
 * API takes (`resolveSession`) or an **agent access token** issued from the
 * profile's MCP tab (`resolveAgentAccessToken`) — this endpoint is the only place
 * the latter is accepted. A request with no bearer, or one neither credential
 * resolves (unknown, expired or revoked), is answered `401` before any MCP message
 * is read.
 *
 * **Authorization: every signed-in user, then per tool and per project** (issue
 * #1382). Whatever the credential, a caller {@link MAY_USE_OPERATOR_MCP} denies is
 * answered `403` before any MCP message is read — today that map admits every
 * installation role, and the check stays so a role added later has to decide.
 * Past it, the caller's *role ceiling* (their highest project role, or
 * installation admin) decides which tools `tools/list` shows and which may be
 * called (`TOOL_ACCESS`, `../mcp/tool-access.ts`), and each call is authorized per
 * project by the dashboard procedure the tool wraps. Agent access tokens are still
 * issued to installation administrators only (`MAY_USE_AGENT_ACCESS_TOKENS`), so a
 * non-admin connects with their `swarm login` session.
 *
 * **A scoped agent credential** (issue #1385) — an agent access token issued with
 * `projectIds` — acts as its holder limited to those projects: every other project
 * reads as `NOT_FOUND`, an installation-wide view is `FORBIDDEN`
 * (`../api/authz.ts`), and only the read tools plus the recovery allowlist are
 * listed or callable (`agentScoped`, `../mcp/tool-access.ts`). Its write-tool
 * calls are audited as `scoped-agent-token` with the token's id. A **run-bound**
 * one (issue #1393) also carries its run and write cap into the principal, and
 * the write-tool framework enforces its per-run guardrails (`../mcp/write-tool.ts`).
 * **`SWARM_SINGLE_USER_MODE` is deliberately not honoured**, for the reason
 * `./operator-api.ts` gives: on an internet-reachable process it would make anyone
 * who found the URL an installation admin. Nothing in this module reads that
 * variable, and nothing should start.
 *
 * **Behind those gates, authorization is exactly the dashboard's.** Every tool calls
 * the dashboard's own tRPC procedure as the resolved user (`../mcp/tool-helpers.ts`),
 * so a bearer caller reads exactly what the same user reads in the browser, with
 * exactly their project roles: a project they are not a member of reads as
 * `NOT_FOUND`, and a cross-project list holds only the projects they may read.
 *
 * **Stateless Streamable HTTP.** Each `POST` builds a fresh server and transport for
 * the resolved user, answers with plain JSON (`enableJsonResponse`), and closes both
 * — no MCP session id, no in-memory state, nothing to lose when the router
 * restarts. With no sessions there is no server-initiated stream to open (`GET`)
 * and no session to end (`DELETE`), so every method but `POST` is `405`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Hono } from 'hono';

// Side-effect import: registers every PM and SCM provider manifest into its
// registry, for the same reason `./operator-api.ts` states it — the procedures the
// tools call read the registry at request time, and this module must not depend on
// a sibling having loaded it first.
import '../integrations/entrypoint.js';
import {
	type LiveAgentAccessToken,
	resolveAgentAccessToken,
} from '../identity/agent-access-token-service.js';
import { resolveSession } from '../identity/auth.js';
import { type InstallationRole, installationRoleFor, type SwarmUser } from '../identity/schema.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { createSwarmMcpServer } from '../mcp/server.js';
import {
	type McpPrincipal,
	mcpCeilingFor,
	scopedAgentPrincipal,
	userPrincipal,
} from '../mcp/tool-access.js';
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
	resolveAgentAccessToken: (rawToken: string) => Promise<LiveAgentAccessToken | undefined>;
}

/**
 * Who may connect to the operator MCP server at all, whichever credential they
 * present — **every signed-in user** since issue #1382, which moved the decision to
 * each tool (`TOOL_ACCESS`, `../mcp/tool-access.ts`). Total over
 * {@link InstallationRole}, so a role added later has to take this decision rather
 * than inherit one.
 */
export const MAY_USE_OPERATOR_MCP: Record<InstallationRole, boolean> = {
	instanceAdmin: true,
	user: true,
};

/**
 * The bearer's principal: a `swarm login` session first, then an agent access
 * token. The two are hashed into different tables, so a token resolves in at most
 * one. A session and an ordinary token act as their user; a token carrying
 * projects is a **scoped agent credential** (issue #1385), acting as its holder
 * limited to those projects.
 */
async function resolveBearerPrincipal(
	deps: OperatorMcpDeps,
	token: string,
): Promise<McpPrincipal | undefined> {
	const session = await deps.resolveSession(token);
	if (session) return userPrincipal(session);
	const agentToken = await deps.resolveAgentAccessToken(token);
	if (!agentToken) return undefined;
	if (!agentToken.projectIds || agentToken.projectIds.length === 0) {
		return userPrincipal(agentToken.user);
	}
	// A run-bound credential (issue #1393) with no stored cap gets none: zero real writes.
	const run = agentToken.runId
		? { runId: agentToken.runId, maxWriteActions: agentToken.maxWriteActions ?? 0 }
		: undefined;
	return scopedAgentPrincipal(agentToken.user, agentToken.tokenId, agentToken.projectIds, run);
}

/**
 * Serve one MCP request as an already-authenticated `principal`: its role
 * ceiling, read once, then a fresh server and transport, torn down once the JSON
 * reply has settled. The mount below runs the credential and installation-role
 * gates first; exported so the tools' own per-user authorization can be exercised
 * directly.
 */
export async function serveOperatorMcpRequest(
	principal: McpPrincipal,
	request: Request,
): Promise<Response> {
	let server: McpServer | undefined;
	try {
		server = createSwarmMcpServer({ ...principal, ceiling: await mcpCeilingFor(principal.user) });
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		await server.connect(transport);
		return await transport.handleRequest(request);
	} catch (error) {
		logger.warn('operator MCP request failed', { error: describeError(error) });
		return Response.json(
			{ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null },
			{ status: 500 },
		);
	} finally {
		// JSON-response mode has settled every reply by the time `handleRequest`
		// returns, so the per-request server can be torn down here.
		await server?.close().catch(() => undefined);
	}
}

/**
 * Wire the operator MCP endpoint onto the router's Hono `app`, beside
 * `registerOperatorApi`. Pass `overrides` to substitute the credential lookups in
 * tests; omit for production wiring.
 */
export function registerOperatorMcp(app: Hono, overrides: Partial<OperatorMcpDeps> = {}): void {
	const deps: OperatorMcpDeps = { resolveSession, resolveAgentAccessToken, ...overrides };

	app.all(OPERATOR_MCP_ENDPOINT, async (c) => {
		const token = resolveOperatorBearer(c);
		const principal = token ? await resolveBearerPrincipal(deps, token) : undefined;
		if (!principal) {
			return c.json({ error: 'Unauthorized' }, 401);
		}
		if (!MAY_USE_OPERATOR_MCP[installationRoleFor(principal.user)]) {
			return c.json({ error: 'Forbidden: your installation role may not use the MCP server' }, 403);
		}
		if (c.req.method !== 'POST') {
			c.header('Allow', 'POST');
			return c.json({ error: 'Method not allowed: this MCP server is stateless, POST only' }, 405);
		}

		return serveOperatorMcpRequest(principal, c.req.raw);
	});
}
