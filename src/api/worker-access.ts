/**
 * The worker-ownership guards shared by `routers/workers.ts` and the routers nested
 * into it.
 *
 * Extracted here with issue #766 rather than left in `routers/workers.ts`: that
 * module imports `workerScmCredentialsRouter` in order to nest it, so the nested
 * router cannot import back from it without a cycle. A pure move — the rule, the
 * `NOT_FOUND`, and the reasoning are unchanged.
 */

import { TRPCError } from '@trpc/server';

import type { SwarmUser } from '../identity/schema.js';
import { getWorker, type Worker } from '../identity/worker-service.js';

/** The `NOT_FOUND` a non-owner (or anyone querying an unknown id) receives for a worker. */
export function workerNotFound(workerId: string): TRPCError {
	return new TRPCError({ code: 'NOT_FOUND', message: `Worker with ID "${workerId}" not found` });
}

/**
 * Resolve a worker the caller **strictly** owns — no `instanceAdmin` override.
 * Used for acts that are the machine owner's own call about their machine
 * (its display name; its operator SCM credential; an enrollment's sharing consent
 * and execution constraints, via `resolveOwnedEnrollment`), as opposed to
 * `resolveOwnedWorker`'s `enroll`, which reads as administering the
 * *project* side of the offer. A missing worker and one owned by someone else
 * both surface the same `NOT_FOUND`.
 */
export async function resolveStrictlyOwnedWorker(
	user: SwarmUser,
	workerId: string,
): Promise<Worker> {
	const worker = await getWorker(workerId);
	if (!worker || worker.ownerUserId !== user.id) {
		throw workerNotFound(workerId);
	}
	return worker;
}
