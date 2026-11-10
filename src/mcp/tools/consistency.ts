/**
 * The operator MCP server's pipeline consistency check (issue #1344):
 * `consistency_check`.
 *
 * Wraps the dashboard's own `runs.consistencyCheck` procedure through
 * {@link callerFor}, so a contributor of the project reads it and anyone else gets
 * the same `NOT_FOUND` an unknown project does. It reports the stuck states SWARM
 * will not leave by itself — a merged pull request whose work item is still open, a
 * dependency wait whose blockers are all done — and fixes neither: each finding
 * names the action that does. The board is read through the project's PM provider,
 * one card at a time; the source-control provider is not asked anything.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { ConsistencyCheckInputSchema } from '../../api/routers/runs.js';
import type { ToolContext } from '../tool-access.js';
import { callerFor, runTool } from '../tool-helpers.js';

/** `runs.consistencyCheck`'s own input fields, re-used so the tool accepts exactly what it does. */
const consistencyCheckInput = {
	projectId: ConsistencyCheckInputSchema.shape.projectId.describe('The project id.'),
	windowHours: ConsistencyCheckInputSchema.shape.windowHours.describe(
		'How many hours back to look for merged pull requests (default 24, at most 720). ' +
			'Dependency waits are checked whatever their age.',
	),
};

/** Register the consistency-check tool on `server`, authorizing every call as `context`'s user. */
export function registerConsistencyTools(server: McpServer, context: ToolContext): void {
	server.registerTool(
		'consistency_check',
		{
			title: 'Pipeline consistency check',
			description:
				'Read-only. Finds stuck states SWARM will not leave by itself, as `findings`: ' +
				'`merged-pr-open-work-item` — a pull request merge automation merged in the window ' +
				'whose work item is still open on the board; and `dependency-wait-blockers-done` — a ' +
				'dispatch waiting on the dependency gate although none of its blockers is still open. ' +
				'Each finding carries `repository`, `prNumber` (merged pull requests), `taskId`, ' +
				'`dispatchId` (dependency waits), `workItemId`, `workItemUrl`, `detail` and ' +
				'`suggestedAction`. Candidates whose board read failed are listed in `unchecked` with ' +
				'the reason; `truncated` is true when a per-call cap (50 of each kind) left some unread. ' +
				'Fixes nothing.',
			inputSchema: consistencyCheckInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(input) =>
			runTool(context, 'consistency_check', () =>
				callerFor(context.user).runs.consistencyCheck(input),
			),
	);
}
