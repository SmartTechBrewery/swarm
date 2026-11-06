/**
 * The operator MCP server's period statistics (issue #1345): `pipeline_stats`.
 *
 * Wraps the dashboard's own `runs.stats` procedure through {@link callerFor}, so it
 * needs contributor access to the project it names, and a project the caller cannot
 * read is reported as not found. Counts only — two grouped SQL counts over the runs
 * table, no provider call — and nothing here writes.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { PipelineStatsInputFields } from '../../api/routers/runs.js';
import type { SwarmUser } from '../../identity/schema.js';
import { callerFor, runTool } from '../tool-helpers.js';

/** `runs.stats`'s own input fields, re-used so the tool accepts exactly what it does. */
const pipelineStatsInput = {
	projectId: PipelineStatsInputFields.shape.projectId.describe('The project id to count.'),
	since: PipelineStatsInputFields.shape.since.describe(
		'ISO 8601 timestamp; the start of the period (inclusive).',
	),
	until: PipelineStatsInputFields.shape.until.describe(
		'ISO 8601 timestamp; the end of the period (exclusive). Omit for now.',
	),
};

/** Register the statistics tools on `server`, authorizing every call as `user`. */
export function registerStatsTools(server: McpServer, user: SwarmUser): void {
	server.registerTool(
		'pipeline_stats',
		{
			title: 'Pipeline statistics',
			description:
				"Read-only. One project's counts for a period, as `{ runsByStatus, runsByPhase, " +
				'mergedPrsByRepository, since, until }`: the pipeline runs started in the period by ' +
				'the status each is in now and by phase, and how many distinct pull requests ' +
				"SWARM's merge automation merged in it, per repository (keyed on the approving " +
				'Review run completing in the period; a pull request merged by hand is not counted). ' +
				'A status, phase or repository with nothing to count is absent. `until` defaults to now.',
			inputSchema: pipelineStatsInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(input) => runTool('pipeline_stats', () => callerFor(user).runs.stats(input)),
	);
}
