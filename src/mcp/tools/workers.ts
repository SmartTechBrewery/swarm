/**
 * The operator MCP server's worker reads (issue #1341): `workers_state` and
 * `cli_rate_limits`.
 *
 * Both wrap the dashboard's own `workers` procedures through {@link callerFor},
 * so they are scoped exactly as the Workers screens are: given a `projectId`, a
 * `contributor` of that project reads its enrolled workers (anyone else gets the
 * same `NOT_FOUND` an unknown project does); without one, the installation-wide
 * view is an instance administrator's alone and anyone else is refused with
 * `FORBIDDEN`. Neither writes anything — setting or extending a cool-down is the
 * audited write tool `cli_rate_limit_set` (`./cli-rate-limit-set.ts`).
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { workerNotFound } from '../../api/worker-access.js';
import type { ToolContext } from '../tool-access.js';
import { callerFor, runTool } from '../tool-helpers.js';

const projectIdInput = z
	.string()
	.min(1)
	.optional()
	.describe(
		"Read this project's enrolled workers. Required unless you are an instance administrator, " +
			'for whom omitting it reads every worker on the installation.',
	);

const workersStateInput = { projectId: projectIdInput };

const cliRateLimitsInput = {
	projectId: projectIdInput,
	workerId: z
		.string()
		.uuid()
		.optional()
		.describe(
			'Only this worker (its id, as `workers_state` returns it). It must be visible in the ' +
				'same scope, and is returned even when it is cooling on nothing.',
		),
};

/** Register the worker read tools on `server`, authorizing every call as `context`'s user. */
export function registerWorkerTools(server: McpServer, context: ToolContext): void {
	server.registerTool(
		'workers_state',
		{
			title: 'Worker state',
			description:
				'Read-only. Lists workers with whether each is connected (`connection`), draining, ' +
				'the run it is executing, and its enrolled projects, each with its capacity in use ' +
				'(`activeRuns` of `concurrencyAllocation`), whether the project may route work to it, ' +
				'and its enrollment status, as `{ workers }`.',
			inputSchema: workersStateInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		({ projectId }) =>
			runTool(context, 'workers_state', async () => ({
				workers: await callerFor(context.user).workers.state(projectId ? { projectId } : undefined),
			})),
	);

	server.registerTool(
		'cli_rate_limits',
		{
			title: 'CLI rate limits',
			description:
				"Read-only. Lists the workers cooling on an agent CLI's usage limit, each with its " +
				'active limits: the CLI, `expiresAt` (when SWARM routes that CLI to the worker again), ' +
				'`observedAt`, and `resetHint` (the reset text the CLI itself printed, or null), ' +
				'as `{ workers }`. A worker with no active limit is left out unless named by `workerId`.',
			inputSchema: cliRateLimitsInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		({ projectId, workerId }) =>
			runTool(context, 'cli_rate_limits', async () => {
				// `workers.list` already carries each row's live cool-downs, read in one
				// batched query for the whole roster, under the roster's own scope.
				const roster = await callerFor(context.user).workers.list(
					projectId ? { projectId } : undefined,
				);
				const rows = workerId ? roster.filter((worker) => worker.workerId === workerId) : roster;
				if (workerId && rows.length === 0) {
					// The same refusal `workers.getById` gives a worker outside the
					// caller's view, so existence does not leak through this tool either.
					throw workerNotFound(workerId);
				}
				return {
					workers: rows
						.filter((worker) => workerId !== undefined || worker.rateLimits.length > 0)
						.map((worker) => ({
							workerId: worker.workerId,
							displayName: worker.displayName,
							rateLimits: worker.rateLimits,
						})),
				};
			}),
	);
}
