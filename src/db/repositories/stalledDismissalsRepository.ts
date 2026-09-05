/**
 * The `stalled_dismissals` reads and writes (issue #880) — the durable half of an
 * operator dismissing a stalled liveness unit.
 *
 * Two functions only, and both are plain: the read that bounds the Stalled view's
 * third input, and the upsert one Dismiss click makes. The *decision* stays in the
 * pure `src/dispatch/item-liveness.ts`, exactly as it does for the other two reads
 * this one joins (`listTaskActivitySince`, `listActiveDispatchTaskRefs`) — nothing
 * here classifies anything.
 */

import { and, gte, inArray, type SQL } from 'drizzle-orm';

import { getDb } from '../client.js';
import { stalledDismissals } from '../schema/stalledDismissals.js';

/** One dismissal, in the shape the read model folds onto a unit. */
export interface StalledDismissalRow {
	projectId: string;
	repository: string;
	unit: string;
	reference: string;
	/** The unit's own `lastActivityAt` at the instant it was dismissed. */
	lastActivityAt: Date;
}

/**
 * The dismissals that could suppress a row the caller is about to report.
 *
 * `since` is the same lookback window `listTaskActivitySince` reads over, and
 * filtering on it here is exact rather than a heuristic: that read only aggregates
 * runs at or after `since`, so a reported unit's `lastActivityAt` is always `>=
 * since`, and a dismissal recorded at an older instant could never suppress a
 * visible row. It is what bounds this read alongside the other two.
 */
export async function listStalledDismissals(input: {
	since: Date;
	projectIds?: readonly string[];
}): Promise<StalledDismissalRow[]> {
	// An empty scope is "no accessible project", not "every project" — the same
	// guard `listTaskActivitySince` opens with, for the same reason: a caller that
	// narrowed to nothing must not be widened back to the installation by a missing
	// `inArray` term.
	if (input.projectIds && input.projectIds.length === 0) return [];

	const conditions: SQL[] = [gte(stalledDismissals.lastActivityAt, input.since)];
	if (input.projectIds) {
		conditions.push(inArray(stalledDismissals.projectId, [...input.projectIds]));
	}

	return await getDb()
		.select({
			projectId: stalledDismissals.projectId,
			repository: stalledDismissals.repository,
			unit: stalledDismissals.unit,
			reference: stalledDismissals.reference,
			lastActivityAt: stalledDismissals.lastActivityAt,
		})
		.from(stalledDismissals)
		.where(and(...conditions));
}

/**
 * Record (or re-record) one unit's dismissal at the activity instant the operator
 * saw. The unique index on the four key columns makes a repeat dismissal a
 * rotation of the same row — dismiss, move, re-stall, dismiss again — rather than
 * a second row, so the table grows with distinct units and not with clicks.
 */
export async function recordStalledDismissal(input: {
	projectId: string;
	repository: string;
	unit: string;
	reference: string;
	lastActivityAt: Date;
	dismissedBy: string | null;
}): Promise<{ dismissedAt: Date }> {
	const dismissedAt = new Date();
	const rows = await getDb()
		.insert(stalledDismissals)
		.values({
			projectId: input.projectId,
			repository: input.repository,
			unit: input.unit,
			reference: input.reference,
			lastActivityAt: input.lastActivityAt,
			dismissedAt,
			dismissedBy: input.dismissedBy,
		})
		.onConflictDoUpdate({
			target: [
				stalledDismissals.projectId,
				stalledDismissals.repository,
				stalledDismissals.unit,
				stalledDismissals.reference,
			],
			set: {
				lastActivityAt: input.lastActivityAt,
				dismissedAt,
				dismissedBy: input.dismissedBy,
			},
		})
		.returning({ dismissedAt: stalledDismissals.dismissedAt });

	return { dismissedAt: rows[0].dismissedAt };
}
