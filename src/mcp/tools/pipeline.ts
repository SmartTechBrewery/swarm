/**
 * The operator MCP server's pipeline reads (issue #1340): `pipeline_snapshot` and
 * `dispatch_history`.
 *
 * Both wrap the dashboard's own `runs.pipelineSnapshot` / `runs.dispatchHistory`
 * procedures through {@link callerFor}, so each needs contributor access to the
 * project it names, exactly like the Runs page scoped to that project, and a
 * project the caller cannot read is reported as not found. Neither writes anything.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { MAX_SNAPSHOT_WINDOW_HOURS } from '../../api/pipeline-snapshot.js';
import { DispatchHistoryInputFields, PipelineSnapshotInputSchema } from '../../api/routers/runs.js';
import type { SwarmUser } from '../../identity/schema.js';
import { callerFor, runTool } from '../tool-helpers.js';

/** The procedures' own input fields, re-used so a tool never accepts what they reject. */
const pipelineSnapshotInput = {
	projectId: PipelineSnapshotInputSchema.shape.projectId.describe('The project id to read.'),
	windowHours: PipelineSnapshotInputSchema.shape.windowHours.describe(
		`How far back failed runs are listed and settled runs counted, in hours (default 12, at most ${MAX_SNAPSHOT_WINDOW_HOURS}).`,
	),
};

const dispatchHistoryInput = {
	projectId: DispatchHistoryInputFields.shape.projectId.describe('The project id to read.'),
	repository: DispatchHistoryInputFields.shape.repository.describe(
		'Only dispatches for this repository, as the project names it (e.g. `owner/repo`).',
	),
	taskId: DispatchHistoryInputFields.shape.taskId.describe(
		'The task id (the work item number a run reports as `taskId`). Name this, `prNumber`, or both.',
	),
	prNumber: DispatchHistoryInputFields.shape.prNumber.describe(
		'The pull request number, as a string. Name this, `taskId`, or both.',
	),
};

/** Register the pipeline read tools on `server`, authorizing every call as `user`. */
export function registerPipelineTools(server: McpServer, user: SwarmUser): void {
	server.registerTool(
		'pipeline_snapshot',
		{
			title: 'Pipeline snapshot',
			description:
				"Read-only. One project's pipeline state in one call: its runs still in progress " +
				'(running, deferred, checkpointed) plus the runs that failed in the window, with ' +
				'status, phase, task, repository, worker, age, continuation count, error and next ' +
				'retry; every open dispatch with its state, phase, task/PR, wait reason, ' +
				'availability and last error; and how many runs settled in the window by status. ' +
				'Cheap enough to call periodically as a guard. Lists are capped and `truncated` says when.',
			inputSchema: pipelineSnapshotInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(input) => runTool('pipeline_snapshot', () => callerFor(user).runs.pipelineSnapshot(input)),
	);

	server.registerTool(
		'dispatch_history',
		{
			title: 'Dispatch history',
			description:
				'Read-only. Every dispatch attempt of one task or pull request, oldest first, with ' +
				'its state, phase, attempts, outcome, wait reason, availability, last error and the ' +
				'run it executed against (read that with `run_get`). Only dispatches a worker has ' +
				'resolved to the task or pull request are found.',
			inputSchema: dispatchHistoryInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(input) => runTool('dispatch_history', () => callerFor(user).runs.dispatchHistory(input)),
	);
}
