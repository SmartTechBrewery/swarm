/**
 * The operator MCP server's pull-request read (issue #1342): `pr_status`.
 *
 * Wraps the dashboard's own `runs.prStatus` procedure through {@link callerFor}, so
 * a contributor of the project reads it and anyone else gets the same `NOT_FOUND`
 * an unknown project does. It reports what SWARM itself recorded about the pull
 * request — the merge-automation outcome on its latest completed Review run and its
 * review-verdict ledger — and never asks the source-control provider anything, so
 * it is not a live mergeability read. Nothing here writes.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { PullRequestStatusInputSchema } from '../../api/routers/runs.js';
import type { SwarmUser } from '../../identity/schema.js';
import { callerFor, runTool } from '../tool-helpers.js';

/** `runs.prStatus`'s own input fields, re-used so the tool accepts exactly what it does. */
const prStatusInput = {
	projectId: PullRequestStatusInputSchema.shape.projectId.describe('The project id.'),
	repository: PullRequestStatusInputSchema.shape.repository.describe(
		'The repository as the project configures it (e.g. `owner/repo`), matched exactly.',
	),
	prNumber: PullRequestStatusInputSchema.shape.prNumber.describe('The pull request number.'),
};

/** Register the pull-request read tools on `server`, authorizing every call as `user`. */
export function registerPullRequestTools(server: McpServer, user: SwarmUser): void {
	server.registerTool(
		'pr_status',
		{
			title: 'Pull request status',
			description:
				"Read-only. Reports SWARM's own record of one pull request: its latest completed " +
				'Review run and verdict, the merge-automation outcome recorded on that run ' +
				'(`mergeOutcome`, e.g. `merged`, `not-ready`, `retry-exhausted`, or null), how many ' +
				'review verdicts it has spent against the cap (`verdictCount` of `verdictCap`, ' +
				'`supersededCount` of `supersededCap`), whether a cap is reached (`capReached`, ' +
				'`capBound`), and whether an operator Force re-review grant is still unspent ' +
				'(`overrideOutstanding`). Does not query the source-control provider.',
			inputSchema: prStatusInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(input) => runTool('pr_status', () => callerFor(user).runs.prStatus(input)),
	);
}
