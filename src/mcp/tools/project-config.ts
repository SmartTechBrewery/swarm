/**
 * The operator MCP server's project-configuration reads: `phase_agents_get` (issue
 * #1342) and `agent_models_list` (issue #1415).
 *
 * Wraps the dashboard's own `projects.getById` through {@link callerFor}, so it is
 * gated exactly as the project page is — a contributor of the project reads it,
 * anyone else gets the same `NOT_FOUND` an unknown project does — and then returns
 * **only** the one phase's agent configuration. The rest of the project record
 * (repositories, board mapping, credential references) is dropped here, so this
 * tool cannot become a way to read more of a project than the phase's agents.
 *
 * `agent_models_list` reads no project at all: it is the model catalog the
 * dashboard's Agents tab offers (`MODEL_CAPABILITIES`, `src/harness/models.ts`) —
 * the CLI, model and reasoning values `AgentTargetSchema` accepts — so an agent
 * writing targets with `phase_agents_set` need not guess them. Nothing here writes.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { AgentsConfigSchema } from '../../config/schema.js';
import { AgentCliSchema } from '../../harness/agent-cli.js';
import { DEFAULT_MODEL_PER_CLI, MODEL_CAPABILITIES } from '../../harness/models.js';
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

/**
 * Every CLI a target may name, with its coded default model and the models it
 * knows — each with the reasoning levels it accepts (empty: none may be set) and
 * the level it runs at when none is chosen (`null`: the CLI decides). Only the
 * configuration-facing fields: how a model is launched is not the caller's concern.
 */
export function agentModelCatalog() {
	return {
		clis: AgentCliSchema.options.map((cli) => ({
			cli,
			defaultModel: DEFAULT_MODEL_PER_CLI[cli],
			models: MODEL_CAPABILITIES[cli].map(({ id, label, reasoningChoices, defaultReasoning }) => ({
				id,
				label,
				reasoningChoices,
				defaultReasoning,
			})),
		})),
	};
}

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
	server.registerTool(
		'agent_models_list',
		{
			title: 'List the agent CLIs, models and reasoning levels',
			description:
				'Read-only. The values a phase agent target may name: every CLI, its default ' +
				'model, and each model it knows (`id` is the value to set as `model`) with the ' +
				'reasoning levels that model accepts (`reasoningChoices`; empty means none may be ' +
				'set) and the one it runs at when none is chosen (`defaultReasoning`; `null` means ' +
				'the CLI decides). Use it before `phase_agents_set`. Reads no project.',
			inputSchema: {},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		() => runTool(context, 'agent_models_list', async () => agentModelCatalog()),
	);
}
