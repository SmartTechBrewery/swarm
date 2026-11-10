/**
 * The operator MCP server's project-configuration read (issue #1342):
 * `phase_agents_get`.
 *
 * Wraps the dashboard's own `projects.getById` through {@link callerFor}, so it is
 * gated exactly as the project page is — a contributor of the project reads it,
 * anyone else gets the same `NOT_FOUND` an unknown project does — and then returns
 * **only** the one phase's agent configuration. The rest of the project record
 * (repositories, board mapping, credential references) is dropped here, so this
 * tool cannot become a way to read more of a project than the phase's agents.
 * Nothing here writes.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { AgentsConfigSchema } from '../../config/schema.js';
import type { ToolContext } from '../tool-access.js';
import { callerFor, runTool } from '../tool-helpers.js';

/**
 * The phases `agents` configures — every key of {@link AgentsConfigSchema} but
 * `defaults`, which is a per-CLI model map rather than a phase.
 */
export const AgentPhaseSchema = AgentsConfigSchema.keyof().exclude(['defaults']);

const phaseAgentsGetInput = {
	projectId: z.string().min(1).describe('The project id.'),
	phase: AgentPhaseSchema.describe(
		'The phase, as the project configuration names it (`implementationUnplanned` is the ' +
			'Implementation variant used when the item has no completed Planning run).',
	),
};

/** Register the project-configuration read tools on `server`, authorizing every call as `context`'s user. */
export function registerProjectConfigTools(server: McpServer, context: ToolContext): void {
	server.registerTool(
		'phase_agents_get',
		{
			title: 'Get a phase’s agent configuration',
			description:
				"Read-only. Reads one phase's agent configuration for a project, as stored after " +
				'normalisation: `targets` (CLI/model/reasoning, in priority order — the worker runs ' +
				'the first one whose CLI it has), `timeoutMs` and the custom `prompt`, plus ' +
				'`cli`/`model`/`reasoning` mirroring `targets[0]`. `configured: false` means the ' +
				'phase runs on its coded defaults.',
			inputSchema: phaseAgentsGetInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		({ projectId, phase }) =>
			runTool(context, 'phase_agents_get', async () => {
				const project = await callerFor(context.user).projects.getById({ id: projectId });
				const agent = project.agents?.[phase];
				return { projectId, phase, configured: agent !== undefined, ...agent };
			}),
	);
}
