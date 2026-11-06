/**
 * The operator MCP server (issue #1338) — what an MCP client connected to
 * `/operator/mcp` (`../router/operator-mcp.ts`) sees: a named server whose tools
 * read and, in later phases, act on the pipeline as the signed-in operator.
 *
 * One server is built per HTTP request, bound to the user that request's bearer
 * resolved to, so a tool never needs to look its caller up and two requests never
 * share state. Each tool family registers itself with one `register…Tools` call
 * here; adding one publishes its tools on the internet-exposed router, so it wants
 * the same deliberate reasoning as widening `../api/operator-router.ts`.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { SwarmUser } from '../identity/schema.js';
import { registerRunTools } from './tools/runs.js';
import { registerWorkerTools } from './tools/workers.js';

/** The name an MCP client lists this server's tools under. */
export const SWARM_MCP_SERVER_NAME = 'swarm';

/**
 * The version this server reports in its `initialize` handshake — the version of
 * the tool surface, not of SWARM itself, which a client has no use for.
 */
export const SWARM_MCP_SERVER_VERSION = '1.0.0';

/** Build the MCP server for one request, with every tool authorizing as `user`. */
export function createSwarmMcpServer(user: SwarmUser): McpServer {
	const server = new McpServer({ name: SWARM_MCP_SERVER_NAME, version: SWARM_MCP_SERVER_VERSION });
	registerRunTools(server, user);
	registerWorkerTools(server, user);
	return server;
}
