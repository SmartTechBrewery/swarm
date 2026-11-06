/**
 * The operator MCP server's control-plane log read (issue #1343):
 * `control_plane_logs`, the recent lines of the process serving this MCP server,
 * read from the logger's in-memory ring buffer (`enableLogRingBuffer`, enabled by
 * `src/router/index.ts` and `src/serve/index.ts`). It covers only what this
 * process logged since it last started, up to the buffer's capacity — not the API
 * server's or any worker's logs, and nothing from before a restart.
 *
 * **This tool authorizes itself, unlike every other tool here.** The rule in
 * `../tool-helpers.ts` is that a tool calls the dashboard's own tRPC procedure so
 * its authorization cannot drift from the dashboard's — but there is no such
 * procedure to call: the dashboard runs in the API server, a different process
 * whose memory holds a different buffer, so a procedure there could never read
 * the router's lines. The tool therefore calls the same authz helpers a procedure
 * would (`../../api/authz.ts`), with the same matrix: a line carrying a
 * `projectId` is read with that project's `contributor` access (a non-member gets
 * the `NOT_FOUND` an unknown project gets), and the unscoped view — which includes
 * every line naming no project — is an instance administrator's alone.
 *
 * The logger already keeps secrets out of its lines, so nothing new is redacted
 * here; a message is only cut to {@link MAX_MESSAGE_CHARS} so one huge line
 * cannot crowd a page out of a model's context.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { assertInstanceAdmin, assertProjectAccess } from '../../api/authz.js';
import type { SwarmUser } from '../../identity/schema.js';
import { type LogRingEntry, queryLogRingBuffer } from '../../lib/logger.js';
import { runTool } from '../tool-helpers.js';

/** The most entries one call returns. */
export const CONTROL_PLANE_LOGS_MAX_LIMIT = 1000;

/** A returned message longer than this is cut, with a marker naming how much was. */
export const MAX_MESSAGE_CHARS = 4000;

const timestamp = z.string().datetime({ offset: true });

const controlPlaneLogsInput = {
	projectId: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Only lines carrying this project id. Required unless you are an instance administrator, for whom omitting it reads every line, including those naming no project.',
		),
	taskId: z.string().min(1).optional().describe('Only lines carrying this task id.'),
	prNumber: z
		.number()
		.int()
		.positive()
		.optional()
		.describe('Only lines carrying this pull request number.'),
	dispatchId: z.string().min(1).optional().describe('Only lines carrying this dispatch id.'),
	level: z
		.enum(['debug', 'info', 'warn', 'error'])
		.optional()
		.describe(
			'Minimum level (e.g. `warn` returns warn and error). Lines below `SWARM_LOG_LEVEL` were never recorded.',
		),
	since: timestamp.optional().describe('ISO 8601 timestamp; only lines logged at or after it.'),
	until: timestamp.optional().describe('ISO 8601 timestamp; only lines logged before it.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(CONTROL_PLANE_LOGS_MAX_LIMIT)
		.default(100)
		.describe(
			`Most lines to return, newest first (1–${CONTROL_PLANE_LOGS_MAX_LIMIT}, default 100).`,
		),
};

function capMessage(entry: LogRingEntry): LogRingEntry {
	if (entry.msg.length <= MAX_MESSAGE_CHARS) return entry;
	const cut = entry.msg.length - MAX_MESSAGE_CHARS;
	return { ...entry, msg: `${entry.msg.slice(0, MAX_MESSAGE_CHARS)}… [${cut} more characters]` };
}

/** Register the control-plane log read on `server`, authorizing every call as `user`. */
export function registerLogTools(server: McpServer, user: SwarmUser): void {
	server.registerTool(
		'control_plane_logs',
		{
			title: 'Control-plane logs',
			description:
				"Read-only. The control plane's own recent log lines (the router process serving this " +
				'server), newest first, as `{ entries, buffer }`: each entry `{ time, level, msg, context }`, ' +
				'and `buffer` the in-memory window they come from (`capacity`, `size`, `oldestTime`). It ' +
				'covers only what was logged since the process last restarted, up to its capacity; ' +
				'worker and API-server logs are not included.',
			inputSchema: controlPlaneLogsInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		({ projectId, taskId, prNumber, dispatchId, level, since, until, limit }) =>
			runTool('control_plane_logs', async () => {
				if (projectId) {
					await assertProjectAccess(user, projectId, 'contributor');
				} else {
					assertInstanceAdmin(user, 'control-plane logs');
				}
				const { entries, capacity, size, oldestTime } = queryLogRingBuffer({
					projectId,
					taskId,
					prNumber,
					dispatchId,
					level,
					since: since ? new Date(since) : undefined,
					until: until ? new Date(until) : undefined,
					limit,
				});
				return { entries: entries.map(capMessage), buffer: { capacity, size, oldestTime } };
			}),
	);
}
