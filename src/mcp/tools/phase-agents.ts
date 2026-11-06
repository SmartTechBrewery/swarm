/**
 * The operator MCP server's phase-agent order tools (issue #1349):
 * `phase_agents_reorder` and `phase_agents_restore`, registered through the audited
 * write-tool framework (`../write-tool.ts`) — a mandatory `reason`, a `dryRun`, and
 * an `operator_actions` row for every call.
 *
 * Both only **permute** one phase's existing `agents.<phase>.targets` — never add,
 * drop or edit one — and both persist through the dashboard's own `projects.update`
 * via {@link callerFor}, so they are `projectAdmin`-only exactly as the Agents tab
 * is and the stored config is validated as any save is. Their dry run and
 * pre-write authorization are `projects.agentsForUpdate`, gated at the same role.
 *
 * A reorder records the order it replaced on its audit row (`detail.previous`), and
 * a restore re-applies the `previous` order of the latest **successful, real**
 * reorder of that project's phase — refusing when the targets were edited since,
 * because re-applying that list would silently undo the edit. The audit read
 * happens only after the `projectAdmin` check, and only for that project.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { AgentConfig, AgentsConfig, AgentTarget } from '../../config/schema.js';
import { findLatestOperatorAction } from '../../db/repositories/operatorActionsRepository.js';
import type { SwarmUser } from '../../identity/schema.js';
import { type ReorderResult, reorderTargets, restoreOrder, targetKey } from '../agent-order.js';
import type { SwarmCaller } from '../tool-helpers.js';
import { registerWriteTool, type WriteToolPreview } from '../write-tool.js';
import { AgentPhaseSchema } from './project-config.js';

type AgentPhase = z.infer<typeof AgentPhaseSchema>;

const REORDER_TOOL = 'phase_agents_reorder';

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
 * The preview both tools return, or the permutation's refusal — a `BAD_REQUEST` for
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

/** Register the phase-agent order tools on `server`, authorizing and auditing every call as `user`. */
export function registerPhaseAgentTools(server: McpServer, user: SwarmUser): void {
	registerWriteTool<typeof reorderInput, OrderPreview>(server, user, {
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

	registerWriteTool<typeof phaseInput, OrderPreview>(server, user, {
		name: 'phase_agents_restore',
		title: "Restore a phase's agent order",
		description:
			"WRITE. Puts back the agent-target order the latest successful `phase_agents_reorder` of this project's phase replaced. Refused when there is no such reorder, or " +
			'when the targets were edited since (so the recorded order is no longer a ' +
			'permutation of them). Saves through the project configuration, so it needs ' +
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
}
