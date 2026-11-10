/**
 * The operator MCP server's CLI cool-down write tool (issue #1350):
 * `cli_rate_limit_set`, registered through the audited write-tool framework
 * (`../write-tool.ts`) — a mandatory `reason`, a `dryRun`, and an
 * `operator_actions` row for every call.
 *
 * It wraps `workers.setCliRateLimit` through {@link callerFor}, so it is gated as
 * the dashboard's machine-owner mutations are: the worker's owner or an instance
 * administrator, and the same `NOT_FOUND` for anybody else. Its dry run and its
 * pre-write authorization are `workers.previewCliRateLimit`, the same gate and the
 * same plan with no write. A worker belongs to no project, so the audit row names
 * none.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { CliRateLimitInputSchema } from '../../api/routers/workers.js';
import type { ToolContext } from '../tool-access.js';
import { registerWriteTool } from '../write-tool.js';

const shape = CliRateLimitInputSchema.shape;

const cliRateLimitSetInput = {
	workerId: shape.workerId.describe('The worker id (as `workers_state` returns it).'),
	cli: shape.cli.describe(
		'The agent CLI to keep off the machine: `claude`, `antigravity` or `codex`.',
	),
	until: shape.until.describe(
		'When the cool-down ends, as an ISO 8601 instant with a zone. Give this or `durationMinutes`.',
	),
	durationMinutes: shape.durationMinutes.describe(
		'How long from now the cool-down lasts, in minutes. Give this or `until`.',
	),
	resetHint: shape.resetHint.describe(
		'Optional text shown beside the cool-down, e.g. the reset message the CLI printed.',
	),
	scope: shape.scope.describe(
		"`worker` (default) blocks this machine only. `owner` blocks every machine the worker's " +
			'owner operates: SWARM records no CLI-account identity, so one owner stands in for one ' +
			'CLI account.',
	),
};

/** Register the CLI cool-down write tool on `server`, authorizing and auditing every call as `context`'s user. */
export function registerCliRateLimitSetTools(server: McpServer, context: ToolContext): void {
	registerWriteTool(server, context, {
		name: 'cli_rate_limit_set',
		title: 'Set or extend a CLI cool-down',
		description:
			'WRITE. Keeps one agent CLI off a worker, or off every worker its owner operates ' +
			"(`scope: 'owner'`), until `until` or for `durationMinutes` — the same cool-down SWARM " +
			'records when a run reports a spent allowance, so routing skips that CLI there until ' +
			'it expires. Extends only: a machine whose cool-down already lasts at least as long ' +
			'is left unchanged, and nothing is ever shortened or cleared. At most 8 days ahead. ' +
			"Needs to be the worker's owner or an instance admin. Requires a `reason`; pass " +
			'`dryRun: true` first to list each machine with its current and new `expiresAt`.',
		inputSchema: cliRateLimitSetInput,
		destructive: false,
		targetOf: (input) => `${input.workerId}:${input.cli}`,
		preview: async (input, caller) => ({
			projectId: null,
			plan: await caller.workers.previewCliRateLimit(input),
		}),
		apply: (input, caller) => caller.workers.setCliRateLimit(input),
	});
}
