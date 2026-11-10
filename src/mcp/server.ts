/**
 * The operator MCP server (issue #1338) — what an MCP client connected to
 * `/operator/mcp` (`../router/operator-mcp.ts`) sees: a named server whose tools
 * read and act on the pipeline as the signed-in operator (every write through the
 * audited framework in `./write-tool.ts`).
 *
 * One server is built per HTTP request, bound to the user that request's bearer
 * resolved to, so a tool never needs to look its caller up and two requests never
 * share state. Each tool family registers itself with one `register…Tools` call
 * here; adding one publishes its tools on the internet-exposed router, so it wants
 * the same deliberate reasoning as widening `../api/operator-router.ts` — and a
 * `TOOL_ACCESS` entry (`./tool-access.ts`) naming who may use it, without which it
 * is served to installation administrators only.
 *
 * **Every tool is registered for every caller; `tools/list` shows only the ones
 * their role ceiling reaches** (issue #1382) — and, for a scoped agent credential,
 * only the `agentScoped` ones among those (issue #1385). A hidden tool stays registered so a
 * direct call to it reaches the tool's own `FORBIDDEN` refusal — audited, for a
 * write tool — rather than the SDK's "tool not found". The SDK's per-tool
 * `disable()` is not used for the same reason: a disabled tool's call is refused
 * before the tool, and so before its audit row.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	type ListToolsRequest,
	ListToolsRequestSchema,
	type ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';

import { type ToolContext, toolListedFor } from './tool-access.js';
import { registerBugReportTools } from './tools/bug-reports.js';
import { registerCliRateLimitSetTools } from './tools/cli-rate-limit-set.js';
import { registerConsistencyTools } from './tools/consistency.js';
import { registerDependencyWaitTools } from './tools/dependency-waits.js';
import { registerLogTools } from './tools/logs.js';
import { registerPhaseAgentTools } from './tools/phase-agents.js';
import { registerPipelineTools } from './tools/pipeline.js';
import { registerPullRequestActionTools } from './tools/pr-actions.js';
import { registerProjectConfigTools } from './tools/project-config.js';
import { registerProjectSetupTools } from './tools/project-setup.js';
import { registerPullRequestTools } from './tools/pull-requests.js';
import { registerRunActionTools } from './tools/run-actions.js';
import { registerRunTools } from './tools/runs.js';
import { registerStatsTools } from './tools/stats.js';
import { registerWorkItemTools } from './tools/work-items.js';
import { registerWorkerRemoveTools } from './tools/worker-remove.js';
import { registerWorkerTools } from './tools/workers.js';

/** The name an MCP client lists this server's tools under. */
export const SWARM_MCP_SERVER_NAME = 'swarm';

/**
 * The version this server reports in its `initialize` handshake — the version of
 * the tool surface, not of SWARM itself, which a client has no use for.
 */
export const SWARM_MCP_SERVER_VERSION = '1.0.0';

/**
 * Build the MCP server for one request, with every tool authorizing as
 * `context.user` and `tools/list` showing only the tools `context` may call.
 */
export function createSwarmMcpServer(context: ToolContext): McpServer {
	const server = new McpServer({ name: SWARM_MCP_SERVER_NAME, version: SWARM_MCP_SERVER_VERSION });
	registerRunTools(server, context);
	registerPipelineTools(server, context);
	registerWorkerTools(server, context);
	registerLogTools(server, context);
	registerPullRequestTools(server, context);
	registerProjectConfigTools(server, context);
	registerStatsTools(server, context);
	registerConsistencyTools(server, context);
	registerRunActionTools(server, context);
	registerPullRequestActionTools(server, context);
	registerDependencyWaitTools(server, context);
	registerPhaseAgentTools(server, context);
	registerWorkItemTools(server, context);
	registerCliRateLimitSetTools(server, context);
	registerWorkerRemoveTools(server, context);
	registerProjectSetupTools(server, context);
	registerBugReportTools(server, context);
	listOnlyReachableTools(server, context);
	return server;
}

/** The SDK's own request-handler map, which holds the `tools/list` handler it installed. */
type RequestHandlers = Map<
	string,
	(request: ListToolsRequest, extra: unknown) => Promise<ListToolsResult>
>;

/**
 * Narrow `server`'s `tools/list` answer to the tools `context` may call
 * (`toolListedFor`: its ceiling, and a scoped agent credential's allowlist).
 * `McpServer` builds that answer from its private tool registry, so this wraps the
 * handler the SDK installed (read from the low-level server's private handler map)
 * rather than re-implementing the schema conversion it does. That is SDK
 * internals: `tests/unit/router/operator-mcp.test.ts` lists the tools for every
 * ceiling, so an SDK change that breaks this fails there, not in production.
 */
function listOnlyReachableTools(server: McpServer, context: ToolContext): void {
	const handlers = (server.server as unknown as { _requestHandlers: RequestHandlers })
		._requestHandlers;
	const listAll = handlers.get(ListToolsRequestSchema.shape.method.value);
	if (!listAll) throw new Error('operator MCP: the SDK installed no tools/list handler');
	server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
		const result = await listAll(request, extra);
		return {
			...result,
			tools: result.tools.filter((tool) => toolListedFor(tool.name, context)),
		};
	});
}
