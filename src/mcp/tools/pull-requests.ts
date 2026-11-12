/**
 * The operator MCP server's pull-request reads: `pr_status` (issue #1342) and
 * `pr_live_state` (issue #1441).
 *
 * Both wrap the dashboard's own `runs.*` procedures through {@link callerFor}, so a
 * contributor of the project reads them and anyone else gets the same `NOT_FOUND`
 * an unknown project does. `pr_status` reports what SWARM itself recorded about the
 * pull request — the merge-automation outcome on its latest completed Review run and
 * its review-verdict ledger — and never asks the source-control provider anything.
 * `pr_live_state` is the one that does: it reads the pull request's current state
 * from the project's own provider, through the provider-neutral `SCMProvider`
 * contract, so a merge, close or push made outside SWARM is visible. Nothing here
 * writes.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
	PullRequestLiveStateInputSchema,
	PullRequestStatusInputSchema,
} from '../../api/routers/runs.js';
import type { ToolContext } from '../tool-access.js';
import { callerFor, runTool } from '../tool-helpers.js';

/** `runs.prStatus`'s own input fields, re-used so the tool accepts exactly what it does. */
const prStatusInput = {
	projectId: PullRequestStatusInputSchema.shape.projectId.describe('The project id.'),
	repository: PullRequestStatusInputSchema.shape.repository.describe(
		'The repository as the project configures it (e.g. `owner/repo`), matched exactly.',
	),
	prNumber: PullRequestStatusInputSchema.shape.prNumber.describe('The pull request number.'),
};

/** `runs.prLiveState`'s own input fields. */
const prLiveStateInput = {
	projectId: PullRequestLiveStateInputSchema.shape.projectId.describe('The project id.'),
	repository: PullRequestLiveStateInputSchema.shape.repository.describe(
		'The repository as the project configures it (e.g. `owner/repo`), matched exactly.',
	),
	prNumber: PullRequestLiveStateInputSchema.shape.prNumber.describe('The pull request number.'),
};

/** Register the pull-request read tools on `server`, authorizing every call as `context`'s user. */
export function registerPullRequestTools(server: McpServer, context: ToolContext): void {
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
				'(`overrideOutstanding`). Does not query the source-control provider — `pr_live_state` does.',
			inputSchema: prStatusInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(input) => runTool(context, 'pr_status', () => callerFor(context.user).runs.prStatus(input)),
	);
	server.registerTool(
		'pr_live_state',
		{
			title: 'Pull request live state',
			description:
				"Read-only. Asks the project's source-control provider for one pull request's " +
				'current state: `state` (`open`, `merged`, or `closed` — closed without merging), ' +
				'its head commit (`headSha`) and its head and base branches. Use it to tell whether ' +
				'a pull request was merged, closed or pushed to outside SWARM, which SWARM’s own ' +
				'records (`pr_status`, `run_get`) do not show.',
			inputSchema: prLiveStateInput,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		(input) =>
			runTool(context, 'pr_live_state', () => callerFor(context.user).runs.prLiveState(input)),
	);
}
