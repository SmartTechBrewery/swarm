/**
 * The `operator_actions` writes (issue #1346) — the audit trail of the operator MCP
 * server's write tools (`src/mcp/write-tool.ts`).
 *
 * Two functions, one per half of a call: {@link recordOperatorAction} inserts the
 * row as `pending` before the tool does anything, and {@link settleOperatorAction}
 * records how it ended. Nothing here decides anything; the write-tool framework
 * owns the outcome. One read, {@link findLatestOperatorAction} (issue #1349), lets a
 * tool act on what an earlier call recorded — `phase_agents_restore` re-applying the
 * order the latest `phase_agents_reorder` replaced.
 */

import { and, desc, eq } from 'drizzle-orm';

import { getDb } from '../client.js';
import { operatorActions } from '../schema/operatorActions.js';

/** How a write-tool call ended. `pending` is the state of a row whose call has not settled. */
export type OperatorActionOutcome = 'pending' | 'succeeded' | 'refused' | 'failed';

export type OperatorActionRow = typeof operatorActions.$inferSelect;

export interface RecordOperatorActionInput {
	userId: string;
	userIdentifier: string;
	tool: string;
	projectId: string | null;
	target: string;
	reason: string;
	dryRun: boolean;
	input: unknown;
}

/** Insert one call's audit row as `pending`; returns its id for {@link settleOperatorAction}. */
export async function recordOperatorAction(input: RecordOperatorActionInput): Promise<string> {
	const [row] = await getDb()
		.insert(operatorActions)
		.values({ ...input, input: input.input ?? {}, outcome: 'pending' })
		.returning({ id: operatorActions.id });
	if (!row) throw new Error('operator_actions insert returned no row');
	return row.id;
}

/**
 * Record how a call ended. `projectId` and `detail` are written only when given, so
 * a call whose project resolved only while it ran (the run it named) still carries
 * it, and a tool that records no detail leaves the column `null`.
 */
export async function settleOperatorAction(
	id: string,
	settle: {
		outcome: Exclude<OperatorActionOutcome, 'pending'>;
		error: string | null;
		projectId?: string | null;
		detail?: unknown;
	},
): Promise<void> {
	await getDb()
		.update(operatorActions)
		.set({
			outcome: settle.outcome,
			error: settle.error,
			completedAt: new Date(),
			...(settle.projectId !== undefined ? { projectId: settle.projectId } : {}),
			...(settle.detail !== undefined ? { detail: settle.detail } : {}),
		})
		.where(eq(operatorActions.id, id));
}

/**
 * The most recent **real** (not dry-run) call of `tool` on `target` in `projectId`
 * that **succeeded** — the only kind whose recorded `detail` describes a change that
 * actually happened. `undefined` when there is none.
 */
export async function findLatestOperatorAction(query: {
	tool: string;
	projectId: string;
	target: string;
}): Promise<OperatorActionRow | undefined> {
	const [row] = await getDb()
		.select()
		.from(operatorActions)
		.where(
			and(
				eq(operatorActions.tool, query.tool),
				eq(operatorActions.projectId, query.projectId),
				eq(operatorActions.target, query.target),
				eq(operatorActions.dryRun, false),
				eq(operatorActions.outcome, 'succeeded'),
			),
		)
		.orderBy(desc(operatorActions.startedAt))
		.limit(1);
	return row;
}
