/**
 * The operator MCP server's phase-agent write tools, registered through the audited
 * write-tool framework (`../write-tool.ts`) — a mandatory `reason`, a `dryRun`, and
 * an `operator_actions` row for every call:
 *
 *  - `phase_agents_reorder` and `phase_agents_restore` (issue #1349) only
 *    **permute** one phase's existing `agents.<phase>.targets` — never add, drop or
 *    edit one.
 *  - `phase_agents_set` (issue #1415) **replaces** one phase's whole target list —
 *    adding, dropping, editing and ordering targets in one call, or clearing it to
 *    put the phase back on its coded defaults — and nothing else of the project.
 *
 * All three persist through the dashboard's own `projects.update` via
 * {@link callerFor}, so they are `projectAdmin`-only exactly as the Agents tab is
 * and the stored config is validated as any save is. Their dry run and pre-write
 * authorization are `projects.agentsForUpdate`, gated at the same role.
 *
 * A reorder and a set record the list they replaced on their audit row
 * (`detail.previous`), and a restore re-applies the `previous` order of the latest
 * **successful, real** reorder of that project's phase — refusing when the targets
 * were edited since, or set by `phase_agents_set` since, because re-applying that
 * order would silently undo the edit. The audit read happens only after the
 * `projectAdmin` check, and only for that project.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { AgentConfig, AgentsConfig, AgentTarget } from '../../config/schema.js';
import { findLatestOperatorAction } from '../../db/repositories/operatorActionsRepository.js';
import { AgentCliSchema } from '../../harness/agent-cli.js';
import { ReasoningLevelSchema } from '../../harness/models.js';
import {
	type ReorderResult,
	reorderTargets,
	restoreOrder,
	setTargets,
	targetKey,
} from '../agent-order.js';
import type { ToolContext } from '../tool-access.js';
import type { SwarmCaller } from '../tool-helpers.js';
import { registerWriteTool, type WriteToolPreview } from '../write-tool.js';
import { AgentPhaseSchema } from './project-config.js';

type AgentPhase = z.infer<typeof AgentPhaseSchema>;

const REORDER_TOOL = 'phase_agents_reorder';
const SET_TOOL = 'phase_agents_set';

const phaseInput = {
	projectId: z.string().min(1).describe('The project id.'),
	phase: AgentPhaseSchema.describe(
		'The phase, as the project configuration names it (see `phase_agents_get`).',
	),
};

const reorderInput = {
	...phaseInput,
	order: z
		.array(z.string().min(1))
		.min(1)
		.describe(
			"The phase's targets in the new priority order, first = most preferred. Name each " +
				'target as `<cli>/<model>` (e.g. `claude/opus`) or by its CLI alone (`claude`); ' +
				'every current target exactly once.',
		),
};

const setInput = {
	...phaseInput,
	targets: z
		.array(
			z.object({
				cli: AgentCliSchema.describe('The agent CLI this target runs on.'),
				model: z
					.string()
					.min(1)
					.optional()
					.describe(
						"A model id the CLI knows (see `agent_models_list`); omit it to run on the CLI's default model.",
					),
				reasoning: ReasoningLevelSchema.optional().describe(
					"A reasoning level the model supports (see `agent_models_list`); omit it for the model's default.",
				),
			}),
		)
		.describe(
			"The phase's whole new target list in priority order, first = most preferred; at most " +
				'one target per CLI. It replaces the current list outright, so a target left out is ' +
				'removed. `[]` clears it and puts the phase back on its coded defaults.',
		),
};

/** One project/phase pair as the audit row's `target`, so a restore can find its reorder. */
function auditTarget(projectId: string, phase: AgentPhase): string {
	return `${projectId}/${phase}`;
}

/** The `{ previous, next }` a reorder or restore records — what `phase_agents_restore` reads. */
const RecordedOrderSchema = z.object({
	previous: z.array(
		z.object({
			cli: z.string().optional(),
			model: z.string().optional(),
			reasoning: z.string().optional(),
		}),
	),
});

/**
 * A reorder or restore preview: the reported `plan`, the `{ previous, next }` its
 * audit row records, and — kept off the reported plan, since the whole `agents`
 * block is more of the project than these tools exist to show — the block `apply`
 * writes.
 */
interface OrderPreview extends WriteToolPreview {
	/** Always a project: a phase's agents belong to one, unlike a worker-scoped tool's target. */
	projectId: string;
	plan: { projectId: string; phase: AgentPhase; before: string[]; after: string[] };
	detail: { previous: AgentTarget[]; next: AgentTarget[] };
	write: { phase: AgentPhase; agents: AgentsConfig };
}

/** The project's `agents` and this phase's targets, read at `projectAdmin`. */
async function readPhase(
	caller: SwarmCaller,
	projectId: string,
	phase: AgentPhase,
): Promise<{ agents: AgentsConfig; agent: AgentConfig; targets: AgentTarget[] }> {
	const { agents } = await caller.projects.agentsForUpdate({ id: projectId });
	const agent = agents?.[phase];
	if (!agents || !agent?.targets?.length) {
		throw new TRPCError({
			code: 'PRECONDITION_FAILED',
			message: `Phase "${phase}" of project "${projectId}" has no configured targets to reorder; it runs on its coded defaults.`,
		});
	}
	return { agents, agent, targets: agent.targets };
}

/**
 * A set preview: the reported `plan` names the targets in full — CLI, model *and*
 * reasoning, which a {@link targetKey} leaves out — since a set may change a level
 * without moving a target.
 */
interface SetPreview extends WriteToolPreview {
	projectId: string;
	plan: { projectId: string; phase: AgentPhase; before: AgentTarget[]; after: AgentTarget[] };
	detail: { previous: AgentTarget[]; next: AgentTarget[] };
	write: { phase: AgentPhase; agents: AgentsConfig };
}

/**
 * The preview of replacing `phase`'s targets with `targets`, or a `BAD_REQUEST`
 * naming every target the config schema refuses. Unlike a reorder it accepts a
 * phase with no configured targets, or no `agents` block at all. Every other
 * phase, and this phase's `timeoutMs` and `prompt`, are carried into the write
 * as stored.
 */
async function setPreview(
	caller: SwarmCaller,
	projectId: string,
	phase: AgentPhase,
	targets: z.infer<typeof setInput.targets>,
): Promise<SetPreview> {
	const { agents = {} } = await caller.projects.agentsForUpdate({ id: projectId });
	const current = agents[phase];
	const result = setTargets(current, targets);
	if (!result.ok) {
		throw new TRPCError({
			code: 'BAD_REQUEST',
			message: `${result.reason}. See \`agent_models_list\` for the valid CLI, model and reasoning values.`,
		});
	}
	const { [phase]: _replaced, ...otherPhases } = agents;
	const before = current?.targets ?? [];
	return {
		projectId,
		plan: { projectId, phase, before, after: result.targets },
		detail: { previous: before, next: result.targets },
		write: {
			phase,
			agents: result.agent ? { ...otherPhases, [phase]: result.agent } : otherPhases,
		},
	};
}

/**
 * The preview both order tools return, or the permutation's refusal — a `BAD_REQUEST` for
 * a reorder's own `order`, a `PRECONDITION_FAILED` for a restore whose recorded
 * order the targets have moved on from.
 */
function orderPreview(
	projectId: string,
	phase: AgentPhase,
	read: { agents: AgentsConfig; agent: AgentConfig; targets: AgentTarget[] },
	result: ReorderResult,
	refusal: 'BAD_REQUEST' | 'PRECONDITION_FAILED',
	extra: Record<string, unknown> = {},
): OrderPreview {
	if (!result.ok) throw new TRPCError({ code: refusal, message: result.reason });
	const next = result.targets;
	return {
		projectId,
		plan: {
			projectId,
			phase,
			...extra,
			before: read.targets.map(targetKey),
			after: next.map(targetKey),
		},
		detail: { previous: read.targets, next },
		write: { phase, agents: { ...read.agents, [phase]: { ...read.agent, targets: next } } },
	};
}

/** Persist the previewed order through `projects.update`, reporting only this phase's targets. */
async function applyOrder(caller: SwarmCaller, preview: OrderPreview) {
	const updated = await caller.projects.update({
		id: preview.projectId,
		agents: preview.write.agents,
	});
	return {
		projectId: preview.projectId,
		phase: preview.write.phase,
		before: preview.plan.before,
		after: (updated.agents?.[preview.write.phase]?.targets ?? []).map(targetKey),
	};
}

/** Persist the previewed target list through `projects.update`, reporting only this phase's targets. */
async function applySet(caller: SwarmCaller, preview: SetPreview) {
	const updated = await caller.projects.update({
		id: preview.projectId,
		agents: preview.write.agents,
	});
	return {
		projectId: preview.projectId,
		phase: preview.write.phase,
		before: preview.plan.before,
		after: updated.agents?.[preview.write.phase]?.targets ?? [],
	};
}

/** Register the phase-agent write tools on `server`, authorizing and auditing every call as `context`'s user. */
export function registerPhaseAgentTools(server: McpServer, context: ToolContext): void {
	registerWriteTool<typeof reorderInput, OrderPreview>(server, context, {
		name: REORDER_TOOL,
		title: "Reorder a phase's agent targets",
		description:
			"WRITE. Changes the priority order of one phase's agent targets — which CLI/model a " +
			'worker tries first — without adding, removing or editing any (e.g. put `claude` ' +
			'first while Codex is rate-limited). `order` must name every current target exactly ' +
			'once; see `phase_agents_get`. The order it replaced is recorded, so ' +
			'`phase_agents_restore` can put it back. Saves through the project configuration, so ' +
			'it needs `projectAdmin` on the project. Requires a `reason`; pass `dryRun: true` ' +
			'first to see the order before and after.',
		inputSchema: reorderInput,
		destructive: false,
		targetOf: (input) => auditTarget(input.projectId, input.phase),
		preview: async (input, caller) => {
			const read = await readPhase(caller, input.projectId, input.phase);
			return orderPreview(
				input.projectId,
				input.phase,
				read,
				reorderTargets(read.targets, input.order),
				'BAD_REQUEST',
			);
		},
		apply: (_input, caller, preview) => applyOrder(caller, preview),
	});

	registerWriteTool<typeof phaseInput, OrderPreview>(server, context, {
		name: 'phase_agents_restore',
		title: "Restore a phase's agent order",
		description:
			"WRITE. Puts back the agent-target order the latest successful `phase_agents_reorder` of this project's phase replaced. Refused when there is no such reorder, " +
			'when the targets were edited since (so the recorded order is no longer a ' +
			'permutation of them), or when `phase_agents_set` set them since. Saves through the project configuration, so it needs ' +
			'`projectAdmin` on the project. Requires a `reason`; pass `dryRun: true` first to ' +
			'see the order before and after.',
		inputSchema: phaseInput,
		destructive: false,
		targetOf: (input) => auditTarget(input.projectId, input.phase),
		preview: async (input, caller) => {
			// Authorization first: the audit trail is read only for a project the caller administers.
			const read = await readPhase(caller, input.projectId, input.phase);
			const reorder = await findLatestOperatorAction({
				tool: REORDER_TOOL,
				projectId: input.projectId,
				target: auditTarget(input.projectId, input.phase),
			});
			if (!reorder) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Phase "${input.phase}" of project "${input.projectId}" has no successful \`${REORDER_TOOL}\` to restore.`,
				});
			}
			// A set made since replaced the list the reorder recorded, even one that only
			// moved the same targets; re-applying the reorder's order would undo it.
			const set = await findLatestOperatorAction({
				tool: SET_TOOL,
				projectId: input.projectId,
				target: auditTarget(input.projectId, input.phase),
			});
			if (set && set.startedAt > reorder.startedAt) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `The targets of phase "${input.phase}" were set by \`${SET_TOOL}\` (audit ${set.id}) after the latest \`${REORDER_TOOL}\` (audit ${reorder.id}), so there is no reorder to undo. Use \`${SET_TOOL}\` to change them again.`,
				});
			}
			const recorded = RecordedOrderSchema.safeParse(reorder.detail);
			if (!recorded.success) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `The latest \`${REORDER_TOOL}\` of phase "${input.phase}" (audit ${reorder.id}) recorded no previous order to restore.`,
				});
			}
			return orderPreview(
				input.projectId,
				input.phase,
				read,
				restoreOrder(read.targets, recorded.data.previous),
				'PRECONDITION_FAILED',
				{ restoring: { auditId: reorder.id, reorderedAt: reorder.startedAt } },
			);
		},
		apply: (_input, caller, preview) => applyOrder(caller, preview),
	});
	registerWriteTool<typeof setInput, SetPreview>(server, context, {
		name: SET_TOOL,
		title: "Set a phase's agent targets",
		description:
			"WRITE. Sets one phase's whole agent-target list — which CLI/model/reasoning a worker " +
			'may run it on, in priority order (first = most preferred) — adding, removing, ' +
			'editing and reordering targets in one call; `targets: []` puts the phase back on its ' +
			"coded defaults. Every other phase, and this phase's timeout and custom prompt, are " +
			'left as they are. Validated as a dashboard save is: a model its CLI knows, a ' +
			'reasoning level the model supports, at most one target per CLI — read the valid ' +
			'values with `agent_models_list` and the current list with `phase_agents_get`. The ' +
			'list it replaced is recorded on its audit row. Saves through the project ' +
			'configuration, so it needs `projectAdmin` on the project. Requires a `reason`; pass ' +
			'`dryRun: true` first to see the targets before and after.',
		inputSchema: setInput,
		destructive: false,
		targetOf: (input) => auditTarget(input.projectId, input.phase),
		preview: (input, caller) => setPreview(caller, input.projectId, input.phase, input.targets),
		apply: (_input, caller, preview) => applySet(caller, preview),
	});
}
