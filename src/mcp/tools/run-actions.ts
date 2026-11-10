/**
 * The operator MCP server's first write tools (issue #1346): `run_reset` and
 * `dispatch_redispatch_now`, both registered through the audited write-tool
 * framework (`../write-tool.ts`) — a mandatory `reason`, a `dryRun`, and an
 * `operator_actions` row for every call.
 *
 * Each wraps the dashboard's own mutation through {@link callerFor}: `run_reset` is
 * `runs.reset` ("Reset & restart", what `swarm run reset` does) and
 * `dispatch_redispatch_now` is `runs.retryNow` ("Retry now"), so both need `member`
 * on the run's project, exactly as in the dashboard, and neither changes what the
 * mutation does. Their dry run and their pre-write authorization are
 * `runs.previewAction`, which is gated at the same role and reports the same
 * refusals in the same words.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { PreviewableRunAction } from '../../api/routers/runs.js';
import type { ToolContext } from '../tool-access.js';
import type { SwarmCaller } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const runActionInput = {
	runId: z.string().min(1).describe('The run id (as `runs_list` and `run_get` report it).'),
};

async function previewFor(
	action: PreviewableRunAction,
	runId: string,
	caller: SwarmCaller,
): Promise<{ projectId: string; plan: unknown }> {
	const plan = await caller.runs.previewAction({ runId, action });
	return { projectId: plan.run.projectId, plan };
}

/** Register the run write tools on `server`, authorizing and auditing every call as `context`'s user. */
export function registerRunActionTools(server: McpServer, context: ToolContext): void {
	registerWriteTool(server, context, {
		name: 'run_reset',
		title: 'Reset & restart a run',
		description:
			'WRITE — destructive. Resets a wedged run and re-dispatches its phase from scratch, as ' +
			'the dashboard\'s "Reset & restart" and `swarm run reset` do: stops its live agent, ' +
			'cancels its active dispatch (even a claimed one), clears its cancellation flag, tears ' +
			'down its checkout discarding uncommitted and unpushed work, clears its recovery ' +
			'record, then restarts the phase as a fresh first attempt (or settles the run failed ' +
			"when it has no payload or project). Needs `member` on the run's project. Requires a " +
			'`reason`; pass `dryRun: true` first to see what it would do.',
		inputSchema: runActionInput,
		destructive: true,
		targetOf: (input) => input.runId,
		preview: (input, caller) => previewFor('reset', input.runId, caller),
		apply: (input, caller) => caller.runs.reset({ runId: input.runId }),
	});

	registerWriteTool(server, context, {
		name: 'dispatch_redispatch_now',
		title: "Re-dispatch a run's waiting dispatch now",
		description:
			'WRITE. Re-dispatches a deferred, checkpointed or failed run immediately, as the ' +
			'dashboard\'s "Retry now" does: re-opens its waiting dispatch for an immediate attempt ' +
			'(superseding a scheduled automatic retry), takes back one whose worker lease has ' +
			'lapsed, or creates a fresh dispatch from its stored payload when it has none; retry ' +
			'budgets start again from zero. Refused for a run a worker is executing. Needs ' +
			"`member` on the run's project. Requires a `reason`; pass `dryRun: true` first to see " +
			'what it would do.',
		inputSchema: runActionInput,
		destructive: false,
		targetOf: (input) => input.runId,
		preview: (input, caller) => previewFor('retryNow', input.runId, caller),
		apply: (input, caller) => caller.runs.retryNow({ runId: input.runId }),
	});
}
