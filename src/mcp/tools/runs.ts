/**
 * The operator MCP server's run reads (issue #1338): `runs_list` and `run_get`.
 *
 * Both wrap the dashboard's own `runs` procedures through {@link callerFor}, so they
 * read exactly what the same user reads on the Runs page and the run detail page —
 * an instance administrator the whole installation, anyone else the projects they
 * are a member of, and a run in any other project reads as not found. Neither
 * writes anything.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { ListRunsInputSchema } from '../../api/routers/runs.js';
import type { SwarmUser } from '../../identity/schema.js';
import { callerFor, runTool } from '../tool-helpers.js';

/**
 * `runs.list`'s own input fields, re-used rather than re-declared so the tool can
 * never accept a filter the procedure would reject (or miss one it gains), each
 * given the description a calling model reads.
 */
const runsListInput = {
	projectId: ListRunsInputSchema.shape.projectId.describe(
		'Only runs of this project id. Omit to list every project you can read.',
	),
	status: ListRunsInputSchema.shape.status.describe('Only runs in this status.'),
	phase: ListRunsInputSchema.shape.phase.describe('Only runs of this pipeline phase.'),
	since: ListRunsInputSchema.shape.since.describe(
		'ISO 8601 timestamp; only runs started at or after it.',
	),
	limit: ListRunsInputSchema.shape.limit.describe('Page size (1–200, default 50).'),
	offset: ListRunsInputSchema.shape.offset.describe('Rows to skip, for paging (default 0).'),
};

const runGetInput = {
	runId: z.string().min(1).describe('The run id, as `runs_list` returns it.'),
	includeOutput: z
		.boolean()
		.default(true)
		.describe("Include the run's captured agent output events (default true)."),
	outputAfter: z
		.number()
		.int()
		.nonnegative()
		.default(0)
		.describe(
			'Return only output events after this cursor (the `nextCursor` of an earlier call); default 0, from the start.',
		),
	includeLogs: z
		.boolean()
		.default(false)
		.describe("Include the run's stored stdout/stderr logs (default false; they can be large)."),
};

/** Register the run read tools on `server`, authorizing every call as `user`. */
export function registerRunTools(server: McpServer, user: SwarmUser): void {
	server.registerTool(
		'runs_list',
		{
			title: 'List runs',
			description:
				'Read-only. Lists pipeline runs, newest first, with their phase, status, task, ' +
				'worker and timing, as `{ data, total }`. Covers every project you are a member of ' +
				'(every project for an instance administrator); pass `projectId` to read one project.',
			inputSchema: runsListInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(input) => runTool('runs_list', () => callerFor(user).runs.list(input)),
	);

	server.registerTool(
		'run_get',
		{
			title: 'Get a run',
			description:
				'Read-only. Reads one run in full — its status, error and failure diagnosis, ' +
				'checkpoint and attribution — plus, optionally, its captured agent output and stored ' +
				'logs, as `{ run, output?, logs? }`. A run in a project you cannot read is reported as not found.',
			inputSchema: runGetInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		({ runId, includeOutput, outputAfter, includeLogs }) =>
			runTool('run_get', async () => {
				const caller = callerFor(user);
				// The run read goes first: it is the authorization check, so neither
				// optional read is attempted for a run the caller cannot see.
				const run = await caller.runs.getById({ id: runId });
				const output = includeOutput
					? await caller.runs.getOutput({ runId, after: outputAfter })
					: undefined;
				const logs = includeLogs ? await caller.runs.getLogs({ runId }) : undefined;
				return {
					run,
					...(output === undefined ? {} : { output }),
					...(logs === undefined ? {} : { logs }),
				};
			}),
	);
}
