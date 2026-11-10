/**
 * The operator MCP server's worker removal write tool (issue #1413):
 * `worker_remove`, registered through the audited write-tool framework
 * (`../write-tool.ts`) — a mandatory `reason`, a `dryRun`, and an
 * `operator_actions` row for every call.
 *
 * It wraps `workers.remove` — the procedure `swarm workers remove` and the
 * dashboard's Delete worker call — through {@link callerFor}, so it is gated
 * exactly as they are: the worker's owner or an instance administrator, and the
 * same `NOT_FOUND` for anybody else; a machine executing a run is refused with
 * `CONFLICT`. Its dry run and its pre-write authorization are
 * `workers.previewRemove`, the same gate with no write. A worker belongs to no
 * project, so the audit row names none. Like every worker-owner tool, it is not
 * offered to a scoped agent credential.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { WorkerRemoveInputSchema } from '../../api/routers/workers.js';
import type { ToolContext } from '../tool-access.js';
import { registerWriteTool } from '../write-tool.js';

const workerRemoveInput = {
	workerId: WorkerRemoveInputSchema.shape.workerId.describe(
		'The worker id (as `workers_state` returns it).',
	),
};

/** Register the worker removal write tool on `server`, authorizing and auditing every call as `context`'s user. */
export function registerWorkerRemoveTools(server: McpServer, context: ToolContext): void {
	registerWriteTool(server, context, {
		name: 'worker_remove',
		title: 'Remove (deregister) a worker',
		description:
			'WRITE, destructive. Deregisters a worker machine — the same as `swarm workers remove` ' +
			'and the dashboard Delete worker. Its enrollments, operator SCM credentials and session ' +
			'go; its runs and dispatches stay in history with their attribution kept. Refused with ' +
			"CONFLICT while the worker is executing a run. Needs to be the worker's owner or an " +
			'instance admin; anyone else gets NOT_FOUND. Requires a `reason`; pass `dryRun: true` ' +
			'first to see the worker and whether it is busy.',
		inputSchema: workerRemoveInput,
		destructive: true,
		targetOf: (input) => input.workerId,
		preview: async (input, caller) => ({
			projectId: null,
			plan: await caller.workers.previewRemove(input),
		}),
		apply: (input, caller) => caller.workers.remove(input),
	});
}
