import { and, asc, eq, isNull } from 'drizzle-orm';

import { getDb } from '../client.js';
import { checkoutDiscards } from '../schema/checkoutDiscards.js';

/**
 * One reset's request that a machine discard the checkout it holds for a run
 * (issue #1402), as stored. See `../schema/checkoutDiscards.ts`.
 */
export interface CheckoutDiscardRow {
	id: string;
	workerId: string;
	runId: string;
	projectId: string;
	repository: string;
	taskId: string;
	worktreeRoot: string;
	requestedAt: Date;
	settledAt: Date | null;
	outcome: string | null;
	detail: string | null;
}

/** Record a pending discard for `workerId`, returning the request id the frame carries. */
export async function createCheckoutDiscard(input: {
	workerId: string;
	runId: string;
	projectId: string;
	repository: string;
	taskId: string;
	worktreeRoot: string;
}): Promise<string> {
	const [row] = await getDb()
		.insert(checkoutDiscards)
		.values(input)
		.returning({ id: checkoutDiscards.id });
	if (!row) throw new Error('inserting the checkout-discard request returned no row');
	return row.id;
}

/** Every discard `workerId` still owes, oldest first. */
export async function listPendingCheckoutDiscards(workerId: string): Promise<CheckoutDiscardRow[]> {
	return getDb()
		.select()
		.from(checkoutDiscards)
		.where(and(eq(checkoutDiscards.workerId, workerId), isNull(checkoutDiscards.settledAt)))
		.orderBy(asc(checkoutDiscards.requestedAt));
}

/**
 * Settle one pending discard with the outcome its worker reported (or the router
 * decided). Scoped to `workerId` so a machine can only ever settle its own requests,
 * and conditional on the row still pending, so a duplicate report changes nothing.
 * Returns whether this call settled it.
 */
export async function settleCheckoutDiscard(
	workerId: string,
	requestId: string,
	outcome: string,
	detail: string | null,
): Promise<boolean> {
	const settled = await getDb()
		.update(checkoutDiscards)
		.set({ settledAt: new Date(), outcome, detail })
		.where(
			and(
				eq(checkoutDiscards.id, requestId),
				eq(checkoutDiscards.workerId, workerId),
				isNull(checkoutDiscards.settledAt),
			),
		)
		.returning({ id: checkoutDiscards.id });
	return settled.length > 0;
}
