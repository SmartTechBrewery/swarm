/**
 * Worker persistence — plain functions, one `getDb()` per call, no class,
 * mirroring `usersRepository.ts` / `projectMembersRepository.ts`. Backs the
 * `workers` table (`src/db/schema/workers.ts`), the persisted form of `Worker`
 * (`src/identity/worker.ts`, the source of truth for the shape).
 *
 * A `workers` row already carries the domain's exact types, so mapping a row back
 * to `Worker` is a re-assembly, not a re-validation — same as `rowToSwarmUser`
 * (`capabilities` comes back typed from `jsonb` and is cast to `AgentCli[]`, the
 * only values the writers here ever store, exactly as `role`/`status` are cast
 * back in the membership repositories). `rowToWorker` drops `credential_hash`:
 * the credential secret never enters the domain read model, mirroring how
 * `rowToSwarmUser` drops `password_hash`.
 *
 * A duplicate `(owner, displayName)` or `credentialHash` surfaces the raw pg
 * `23505` unique violation; the caller (the `swarm workers` CLI) translates it to
 * a friendly message. Lookups that find nothing return `undefined`/`[]` — a
 * not-found, not an error (ai/CODING_STANDARDS.md "Error handling").
 */

import { asc, eq, inArray } from 'drizzle-orm';

import type { AgentCli } from '../../harness/agent-cli.js';
import {
	DEFAULT_WORKER_SUPPORTED_PHASES,
	type Worker,
	WorkerCapabilityReductionError,
} from '../../identity/worker.js';
import type { TriggerPhase } from '../../triggers/types.js';
import { getDb } from '../client.js';
import { workerProjectEnrollments } from '../schema/workerProjectEnrollments.js';
import { workers } from '../schema/workers.js';

type WorkerRow = typeof workers.$inferSelect;

/** The fields a caller supplies to create a worker; `id`/timestamps are generated. */
export interface CreateWorkerInput {
	ownerUserId: string;
	displayName: string;
	capabilities: AgentCli[];
	/** SHA-256 of the worker credential — never the raw token (see `worker-service.ts`). */
	credentialHash: string;
}

/** Re-assemble a `Worker` from a persisted `workers` row, dropping `credentialHash`. */
function rowToWorker(row: WorkerRow): Worker {
	return {
		id: row.id,
		ownerUserId: row.ownerUserId,
		displayName: row.displayName,
		capabilities: row.capabilities as AgentCli[],
		supportedPhases: row.supportedPhases as TriggerPhase[],
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Create a worker. Rejects with the pg `23505` unique violation if the owner
 * already has a worker by this `displayName`, or if `credentialHash` collides —
 * the caller decides how to surface that.
 */
export async function createWorker(input: CreateWorkerInput): Promise<Worker> {
	const [row] = await getDb()
		.insert(workers)
		.values({
			ownerUserId: input.ownerUserId,
			displayName: input.displayName,
			capabilities: input.capabilities,
			// Stated explicitly rather than left to the column's SQL default: that
			// default is frozen at migration time, so a phase added to `TriggerPhase`
			// later would silently be missing from every newly registered worker and —
			// since only the operating program rewrites the set — refuse that phase on
			// machines that can run it. The runtime constant is the authority for new
			// rows; the SQL default remains only as the backfill for rows predating it.
			supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
			credentialHash: input.credentialHash,
		})
		.returning();
	return rowToWorker(row);
}

/** Resolve a worker by generated id. Returns `undefined` if unknown. */
export async function getWorkerById(id: string): Promise<Worker | undefined> {
	const rows = await getDb().select().from(workers).where(eq(workers.id, id)).limit(1);
	const row = rows[0];
	return row ? rowToWorker(row) : undefined;
}

/**
 * Resolve several workers by id in one read — the batched form of
 * {@link getWorkerById}, so a page of runs can be labelled with the machines
 * that executed them without a query per row (issue #523). Unknown ids are
 * simply absent from the result; an empty input reads nothing at all.
 */
export async function getWorkersByIds(ids: string[]): Promise<Worker[]> {
	if (ids.length === 0) return [];
	const rows = await getDb().select().from(workers).where(inArray(workers.id, ids));
	return rows.map(rowToWorker);
}

/**
 * List every registered worker, oldest first — the installation-wide read the
 * dashboard roster builds on (an `instanceAdmin` sees machines with no
 * enrollment at all). Rows still map through `rowToWorker`, so the credential
 * hash never leaves the repository. Empty if nothing is registered.
 */
export async function listAllWorkers(): Promise<Worker[]> {
	const rows = await getDb()
		.select()
		.from(workers)
		.orderBy(asc(workers.createdAt), asc(workers.id));
	return rows.map(rowToWorker);
}

/** List every worker an owner operates, oldest first. Empty if they operate none. */
export async function listWorkersForOwner(ownerUserId: string): Promise<Worker[]> {
	const rows = await getDb()
		.select()
		.from(workers)
		.where(eq(workers.ownerUserId, ownerUserId))
		.orderBy(asc(workers.createdAt), asc(workers.id));
	return rows.map(rowToWorker);
}

/**
 * Resolve a worker by its credential hash — the authentication seam (the analogue
 * of `findUserIdBySessionToken`). Returns the domain `Worker` (still no hash) so
 * callers get an authenticated identity, or `undefined` when no worker matches —
 * a not-found lookup, not an error.
 */
export async function findWorkerByCredentialHash(hash: string): Promise<Worker | undefined> {
	const rows = await getDb()
		.select()
		.from(workers)
		.where(eq(workers.credentialHash, hash))
		.limit(1);
	const row = rows[0];
	return row ? rowToWorker(row) : undefined;
}

/**
 * Replace a worker's declared capabilities. Returns the updated worker, or
 * `undefined` if no worker has that id (nothing to update). Rejects with
 * {@link WorkerCapabilityReductionError} if any existing enrollment for the worker
 * requires a CLI not present in the updated capabilities.
 *
 * `supportedPhases` (issue #467) is written in the **same transaction** when
 * given, because a handshake declares both axes at once and a partial write would
 * leave the roster describing a machine that never existed. Omit it to leave the
 * stored phases untouched — the CLI-only path (`swarm workers set-cli`) knows
 * nothing about phases and must not silently reset them.
 *
 * Note the asymmetry with the CLI check above: phases are deliberately *not*
 * validated against enrollments, even though an enrollment does now constrain them
 * (`allowedPhases`, issue #509). The two constraints are maintained differently on
 * purpose. A CLI reduction is refused while an enrollment still requires the CLI,
 * which is what makes `allowedClis ⊆ capabilities` an invariant; a daemon must stay
 * free to re-declare a *narrower* phase repertoire on reconnect, because that
 * declaration describes the program now running, not a promise to the enrollment.
 * So a daemon that stops supporting a phase narrows its own eligibility — the
 * dispatch gate ANDs the two sets — rather than invalidating an owner's selection,
 * which is exactly the guarantee #509 needs: an owner's choice is never overwritten
 * by a reconnect, and a reconnect is never blocked by an owner's choice.
 */
/**
 * The CLIs some enrollment still requires that `capabilities` would no longer
 * provide — the reduction {@link updateWorkerCapabilities} refuses. Pure and
 * extracted so that transaction reads as its three steps (lock → validate →
 * write) rather than carrying the set arithmetic inline.
 */
function clisRequiredByEnrollments(
	enrollments: { allowedClis: unknown }[],
	capabilities: AgentCli[],
): AgentCli[] {
	const declared = new Set(capabilities);
	const offending = new Set<AgentCli>();
	for (const enrollment of enrollments) {
		for (const cli of enrollment.allowedClis as AgentCli[]) {
			if (!declared.has(cli)) offending.add(cli);
		}
	}
	return [...offending];
}

export async function updateWorkerCapabilities(
	id: string,
	capabilities: AgentCli[],
	supportedPhases?: TriggerPhase[],
): Promise<Worker | undefined> {
	return await getDb().transaction(async (tx) => {
		const existingWorkerRows = await tx
			.select()
			.from(workers)
			.where(eq(workers.id, id))
			.for('update')
			.limit(1);
		const existingWorker = existingWorkerRows[0];
		if (!existingWorker) return undefined;

		const enrollments = await tx
			.select()
			.from(workerProjectEnrollments)
			.where(eq(workerProjectEnrollments.workerId, id));

		const offending = clisRequiredByEnrollments(enrollments, capabilities);
		if (offending.length > 0) {
			throw new WorkerCapabilityReductionError(id, offending);
		}

		const [updatedRow] = await tx
			.update(workers)
			.set(supportedPhases ? { capabilities, supportedPhases } : { capabilities })
			.where(eq(workers.id, id))
			.returning();

		return updatedRow ? rowToWorker(updatedRow) : undefined;
	});
}

/**
 * Replace a worker's declared **phase** repertoire alone, leaving `capabilities`
 * untouched. Returns the updated worker, or `undefined` if no worker has that id.
 *
 * Separate from {@link updateWorkerCapabilities} because the two declarations have
 * different owners: the CLI set is registered by an operator and re-declared by a
 * *transport* handshake, while the phase set is a property of whichever **program**
 * currently operates the row — and the in-process host worker
 * (`src/worker/index.ts`) authenticates by acquiring an execution session rather
 * than by handshaking, so it has a CLI set it must not overwrite and a phase
 * repertoire it must state. Without this, a row narrowed by one `connect` run
 * would stay narrowed for every later in-process run, permanently refusing
 * `planning` on a host that can in fact run it (issue #467). Issue #536 made
 * `connect` declare every phase too, so the narrowing case is now a daemon on an
 * older build — the same skew, one build behind rather than one program over.
 *
 * No enrollment validation, for the reason given on {@link updateWorkerCapabilities}:
 * an enrollment's own phase selection (`allowedPhases`, issue #509) is the owner's
 * and is never overwritten here, and this declaration is never blocked by it.
 */
export async function updateWorkerSupportedPhases(
	id: string,
	supportedPhases: TriggerPhase[],
): Promise<Worker | undefined> {
	const [updatedRow] = await getDb()
		.update(workers)
		.set({ supportedPhases })
		.where(eq(workers.id, id))
		.returning();
	return updatedRow ? rowToWorker(updatedRow) : undefined;
}

/**
 * Rename a worker (the owner's own machine label). Rejects with the pg `23505`
 * unique violation if the owner already has another worker by that
 * `displayName` — the caller decides how to surface that, exactly as
 * {@link createWorker} does. Returns the updated worker, or `undefined` if no
 * worker has that id.
 */
export async function updateWorkerDisplayName(
	id: string,
	displayName: string,
): Promise<Worker | undefined> {
	const [updatedRow] = await getDb()
		.update(workers)
		.set({ displayName })
		.where(eq(workers.id, id))
		.returning();
	return updatedRow ? rowToWorker(updatedRow) : undefined;
}

/**
 * Remove a worker (owner deregistration). Returns `true` if a worker was removed,
 * `false` if none had that id (a no-op, not an error).
 */
export async function removeWorker(id: string): Promise<boolean> {
	const rows = await getDb()
		.delete(workers)
		.where(eq(workers.id, id))
		.returning({ id: workers.id });
	return rows.length > 0;
}
