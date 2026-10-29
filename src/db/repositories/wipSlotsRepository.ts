/**
 * The `wip_slots` reads and writes (issue #1185) — the durable half of the
 * per-repository WIP limit.
 *
 * Four functions, all plain: the atomic reservation a new ticket's start takes,
 * the release that frees it, the count promotion reads, and the full list the
 * slot sweep (`src/dispatch/wip-slot-sweep.ts`, issue #1189) re-checks. The *policy* — which
 * phases are gated, what releases a slot, who is woken — lives in
 * `src/dispatch/wip-limit.ts`; nothing here decides anything but "is there room".
 */

import { and, asc, eq, sql } from 'drizzle-orm';

import { getDb } from '../client.js';
import { projects } from '../schema/projects.js';
import { wipSlots } from '../schema/wipSlots.js';

/** A ticket currently holding one of a repository's slots, as a refusal names it. */
export interface WipSlotHolder {
	taskId: string;
	workItemTitle: string | null;
	openedAt: Date;
}

export interface ReserveWipSlotInput {
	projectId: string;
	repository: string;
	taskId: string;
	/** The repository's resolved limit — `resolveWipLimit` (`src/config/project-repository.ts`). */
	limit: number;
	phase: string;
	dispatchId: string;
	workItem?: { id?: string; title?: string; url?: string };
}

export type ReserveWipSlotResult =
	| { admitted: true; alreadyInFlight: boolean }
	| { admitted: false; holders: WipSlotHolder[] };

/**
 * Admit a ticket against its repository's WIP limit, atomically.
 *
 * One transaction that first takes the `projects` row `FOR UPDATE` — the row
 * `claimWorkerForDispatch` already serializes on — so two concurrent admissions for
 * one project are ordered and cannot both take a repository's last slot. Then:
 *
 * - the ticket already holds a slot → admitted, `alreadyInFlight: true`, nothing written;
 * - the repository holds `limit` or more → refused, naming the holders;
 * - otherwise the slot is inserted → admitted, `alreadyInFlight: false`. The
 *   `ON CONFLICT DO NOTHING` is belt and braces: under the lock nothing else can
 *   have inserted this ticket in between.
 *
 * It locks no `dispatches` row, so the lock order stays acyclic with
 * `claimWorkerForDispatch` (dispatches → projects → …). A project that no longer
 * exists locks nothing and its insert fails on the foreign key — the caller's own
 * project read would already have refused it.
 */
export async function reserveWipSlot(input: ReserveWipSlotInput): Promise<ReserveWipSlotResult> {
	return getDb().transaction(async (tx) => {
		await tx
			.select({ id: projects.id })
			.from(projects)
			.where(eq(projects.id, input.projectId))
			.for('update')
			.limit(1);

		const repositoryScope = and(
			eq(wipSlots.projectId, input.projectId),
			eq(wipSlots.repository, input.repository),
		);
		const holders = await tx
			.select({
				taskId: wipSlots.taskId,
				workItemTitle: wipSlots.workItemTitle,
				openedAt: wipSlots.openedAt,
			})
			.from(wipSlots)
			.where(repositoryScope)
			.orderBy(asc(wipSlots.openedAt), asc(wipSlots.taskId));

		if (holders.some((holder) => holder.taskId === input.taskId)) {
			return { admitted: true, alreadyInFlight: true };
		}
		if (holders.length >= input.limit) {
			return { admitted: false, holders };
		}

		await tx
			.insert(wipSlots)
			.values({
				projectId: input.projectId,
				repository: input.repository,
				taskId: input.taskId,
				workItemId: input.workItem?.id ?? null,
				workItemTitle: input.workItem?.title ?? null,
				workItemUrl: input.workItem?.url ?? null,
				openedPhase: input.phase,
				openedDispatchId: input.dispatchId,
			})
			.onConflictDoNothing({
				target: [wipSlots.projectId, wipSlots.repository, wipSlots.taskId],
			});
		return { admitted: true, alreadyInFlight: false };
	});
}

/**
 * Free a ticket's slot. Returns whether a row was deleted — `false` for a ticket that
 * held none (already released, or in flight since before the limit existed), which
 * is what keeps every release point idempotent.
 */
export async function releaseWipSlot(
	projectId: string,
	repository: string,
	taskId: string,
): Promise<boolean> {
	const rows = await getDb()
		.delete(wipSlots)
		.where(
			and(
				eq(wipSlots.projectId, projectId),
				eq(wipSlots.repository, repository),
				eq(wipSlots.taskId, taskId),
			),
		)
		.returning({ id: wipSlots.id });
	return rows.length > 0;
}

/** How many tickets are in flight in one repository. */
export async function countWipSlots(projectId: string, repository: string): Promise<number> {
	const [row] = await getDb()
		.select({ count: sql<number>`count(*)::int` })
		.from(wipSlots)
		.where(and(eq(wipSlots.projectId, projectId), eq(wipSlots.repository, repository)));
	return row?.count ?? 0;
}

/** One held slot, as the slot sweep re-checks it against its card. */
export interface WipSlotRow {
	projectId: string;
	repository: string;
	taskId: string;
	workItemId: string | null;
}

/**
 * Every held slot across every project (issue #1189), ordered so one project's
 * repositories come out together. Unbounded on purpose: the table holds at most the
 * sum of every repository's `wipLimit`, which is small by construction.
 */
export async function listWipSlots(): Promise<WipSlotRow[]> {
	return getDb()
		.select({
			projectId: wipSlots.projectId,
			repository: wipSlots.repository,
			taskId: wipSlots.taskId,
			workItemId: wipSlots.workItemId,
		})
		.from(wipSlots)
		.orderBy(asc(wipSlots.projectId), asc(wipSlots.repository), asc(wipSlots.openedAt));
}
