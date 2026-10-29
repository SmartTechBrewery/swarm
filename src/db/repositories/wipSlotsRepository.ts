/**
 * The `wip_slots` reads and writes (issue #1185) — the durable half of the
 * per-repository WIP limit.
 *
 * All plain: the atomic reservation a new ticket's start takes, the release that
 * frees it, the count promotion reads, the full list the slot sweep
 * (`src/dispatch/wip-slot-sweep.ts`, issue #1189) re-checks, and — for the dashboard's
 * WIP panel (issue #1192) — the holder's pull request. The *policy* — which
 * phases are gated, what releases a slot, who is woken — lives in
 * `src/dispatch/wip-limit.ts`; nothing here decides anything but "is there room".
 */

import { and, asc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm';

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

/**
 * Record the pull request a ticket in flight opened (issue #1192), so the dashboard's
 * WIP read model can follow the holder onto it. A conditional UPDATE: a no-op for a
 * ticket holding no slot, and for a slot already naming this pull request. Returns
 * whether a row changed.
 */
export async function recordWipSlotPullRequest(
	projectId: string,
	repository: string,
	taskId: string,
	prNumber: string,
): Promise<boolean> {
	const rows = await getDb()
		.update(wipSlots)
		.set({ prNumber })
		.where(
			and(
				eq(wipSlots.projectId, projectId),
				eq(wipSlots.repository, repository),
				eq(wipSlots.taskId, taskId),
				or(isNull(wipSlots.prNumber), sql`${wipSlots.prNumber} <> ${prNumber}`),
			),
		)
		.returning({ id: wipSlots.id });
	return rows.length > 0;
}

/**
 * One held slot, as the slot sweep re-checks it against its card (issue #1189) and the
 * dashboard's WIP read model (`src/queue/wip-usage.ts`) reads it.
 */
export interface WipSlotRow {
	projectId: string;
	repository: string;
	taskId: string;
	workItemId: string | null;
	workItemTitle: string | null;
	workItemUrl: string | null;
	openedPhase: string;
	openedAt: Date;
	prNumber: string | null;
}

/**
 * Every held slot, oldest first per repository, so one project's repositories come out
 * together — the slot sweep (issue #1189) and the dashboard's WIP panel (issue #1192).
 * Unbounded on purpose: the table holds at most the sum of every repository's
 * `wipLimit`, which is small by construction. `projectIds` is the authorization scope,
 * the `listTaskActivitySince` convention: omitted (the sweep) reads every project; an
 * empty scope is answered without a query, so it can never widen to every project.
 */
export async function listWipSlots(projectIds?: readonly string[]): Promise<WipSlotRow[]> {
	if (projectIds && projectIds.length === 0) return [];
	const conditions: SQL[] = [];
	if (projectIds) conditions.push(inArray(wipSlots.projectId, [...projectIds]));
	return getDb()
		.select({
			projectId: wipSlots.projectId,
			repository: wipSlots.repository,
			taskId: wipSlots.taskId,
			workItemId: wipSlots.workItemId,
			workItemTitle: wipSlots.workItemTitle,
			workItemUrl: wipSlots.workItemUrl,
			openedPhase: wipSlots.openedPhase,
			openedAt: wipSlots.openedAt,
			prNumber: wipSlots.prNumber,
		})
		.from(wipSlots)
		.where(conditions.length > 0 ? and(...conditions) : undefined)
		.orderBy(
			asc(wipSlots.projectId),
			asc(wipSlots.repository),
			asc(wipSlots.openedAt),
			asc(wipSlots.taskId),
		);
}
