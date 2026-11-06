/**
 * The operator MCP server's dependency-wait write tool (issue #1347):
 * `dependency_waits_wake`, registered through the audited write-tool framework
 * (`../write-tool.ts`) — a mandatory `reason`, a `dryRun`, and an
 * `operator_actions` row for every call.
 *
 * It wraps `runs.wakeDependencyWaits` through {@link callerFor}: the same
 * promotion a merge or a board card reaching done triggers, so the dependency gate
 * still decides — a dependent whose blockers are still open re-defers on its normal
 * cadence. Its dry run and its pre-write authorization are
 * `runs.previewDependencyWake`, which lists the waits the call would wake and is
 * gated at the same `member` role.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { DependencyWaitsInputSchema } from '../../api/routers/runs.js';
import type { SwarmUser } from '../../identity/schema.js';
import { registerWriteTool } from '../write-tool.js';

const dependencyWaitsInput = {
	projectId: DependencyWaitsInputSchema.shape.projectId.describe('The project id.'),
};

/** Register the dependency-wait tools on `server`, authorizing and auditing every call as `user`. */
export function registerDependencyWaitTools(server: McpServer, user: SwarmUser): void {
	registerWriteTool(server, user, {
		name: 'dependency_waits_wake',
		title: "Wake a project's dependency-waiting dispatches",
		description:
			'WRITE. Wakes every dispatch in the project that is waiting on the dependency gate ' +
			'now, instead of at its next re-check — what a merge or a board card reaching Done ' +
			'does on its own. The gate re-reads the blockers, so a dependent still blocked simply ' +
			'waits again. Returns how many were woken and which. Needs `member` on the project. ' +
			'Requires a `reason`; pass `dryRun: true` first to list the dispatches it would wake.',
		inputSchema: dependencyWaitsInput,
		destructive: false,
		targetOf: (input) => input.projectId,
		preview: async (input, caller) => {
			const dispatches = await caller.runs.previewDependencyWake({ projectId: input.projectId });
			return {
				projectId: input.projectId,
				plan: { projectId: input.projectId, wouldWake: dispatches.length, dispatches },
			};
		},
		apply: (input, caller) => caller.runs.wakeDependencyWaits({ projectId: input.projectId }),
	});
}
