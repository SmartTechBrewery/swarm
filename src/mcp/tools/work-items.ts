/**
 * The operator MCP server's work-item write tool (issue #1351): `work_item_close`,
 * registered through the audited write-tool framework (`../write-tool.ts`) — a
 * mandatory `reason`, a `dryRun`, and an `operator_actions` row for every call.
 *
 * It wraps `runs.closeMergedWorkItem` through the framework's caller: the fix for
 * the consistency check's `merged-pr-open-work-item` finding. It closes the work
 * item behind a pull request and moves its card to Done only when the pull request
 * is merged and the work item is not already done, then wakes the project's
 * dependency waits. Its dry run and its pre-write authorization are
 * `runs.previewCloseMergedWorkItem`, gated at the same `member` role, which reports
 * the resolved work item, its current status, and the refusal in the real call's
 * own code and wording.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { SwarmUser } from '../../identity/schema.js';
import { registerWriteTool } from '../write-tool.js';

const closeInput = {
	projectId: z.string().min(1).describe('The project id.'),
	repository: z
		.string()
		.min(1)
		.describe('The repository the pull request is in, exactly as the project configures it.'),
	prNumber: z.number().int().positive().describe('The merged pull request number.'),
};

/** Register the work-item write tools on `server`, authorizing and auditing every call as `user`. */
export function registerWorkItemTools(server: McpServer, user: SwarmUser): void {
	registerWriteTool(server, user, {
		name: 'work_item_close',
		title: 'Close the work item behind a merged pull request',
		description:
			'WRITE. Closes the work item a merged pull request implements and moves its card to ' +
			"Done on the project's board, then wakes the project's dependency-waiting dispatches so " +
			'its dependents start now — the fix for a `merged-pr-open-work-item` consistency ' +
			'finding, where the provider missed the closing reference. The work item is the one ' +
			"SWARM recorded on the pull request's Review run, else the issue its branch's task " +
			'names, else the pull request itself. Refused when the pull request is not merged, when ' +
			'no work item backs it, and when the work item is already done. Needs `member` on the ' +
			'project. Requires a `reason`; pass `dryRun: true` first to see the work item and its ' +
			'current status.',
		inputSchema: closeInput,
		destructive: false,
		targetOf: (input) => `${input.repository}#${input.prNumber}`,
		preview: async (input, caller) => ({
			projectId: input.projectId,
			plan: await caller.runs.previewCloseMergedWorkItem(input),
		}),
		apply: (input, caller) => caller.runs.closeMergedWorkItem(input),
	});
}
