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
 * One field is a genuine *derivation* rather than a re-assembly, and the asymmetry
 * is knowing (issue #783): the **column** `capabilities` is the daemon's last
 * self-probe, while the **domain field** `Worker.capabilities` is the effective set
 * `effectiveCapabilities()` resolves from that probe and the row's
 * `declared_capabilities`. Renaming the column to `probed_capabilities` would remove
 * the asymmetry at the cost of a rename migration and churn across every query here,
 * for no behavioural gain, so it stays documented on both sides instead.
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
	effectiveCapabilities,
	type Worker,
	WorkerCapabilityNotProbedError,
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

/**
 * Re-assemble a `Worker` from a persisted `workers` row, dropping `credentialHash`.
 *
 * The one place that is not a plain re-assembly is the CLI axis (issue #783):
 * `Worker.capabilities` is the **effective** set resolved from the row's two raw
 * columns, not either column verbatim, with both raw facts carried alongside it.
 * Resolving here rather than in each consumer is deliberate — the eligibility gate,
 * the dispatch candidate list and both roster read models then honour a declaration
 * with no edit of their own, and a reader nobody remembered fails *closed* (on the
 * declaration) instead of silently routing on the probe.
 */
function rowToWorker(row: WorkerRow): Worker {
	const probedCapabilities = row.capabilities as AgentCli[];
	const declaredCapabilities = (row.declaredCapabilities as AgentCli[] | null) ?? null;
	return {
		id: row.id,
		ownerUserId: row.ownerUserId,
		displayName: row.displayName,
		capabilities: effectiveCapabilities({
			capabilities: probedCapabilities,
			declaredCapabilities,
		}),
		probedCapabilities,
		declaredCapabilities,
		supportedPhases: row.supportedPhases as TriggerPhase[],
		repository: row.repository ?? null,
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
			// `declaredCapabilities` is deliberately left to the column's NULL (issue
			// #783): registering a machine seeds the *probe* baseline, it does not make
			// a declaration. NULL means "no declaration, use auto-discovery", which is
			// exactly how registration behaved before the column existed.
			//
			// `repository` is deliberately left to the column's NULL (issue #687):
			// registering a worker is not declaring a checkout. An operator registers a
			// machine from wherever they happen to be, and only the daemon that connects
			// can state which repository the machine actually holds.
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
 * Record the CLI set a daemon just **probed** on its own PATH, replacing the
 * `capabilities` column verbatim. Returns the updated worker, or `undefined` if no
 * worker has that id (nothing to update). Rejects with
 * {@link WorkerCapabilityReductionError} if any existing enrollment for the worker
 * requires a CLI the *effective* set would no longer provide.
 *
 * "Effective", not "probed", is the whole point of the split (issue #783): the probe
 * is still written honestly, but what the reduction check judges is
 * `effectiveCapabilities(probe, the row's existing declaration)` — the set dispatch
 * will actually route on. The consequence is intended: with a declaration in force,
 * a daemon whose probe transiently narrows no longer 409s the handshake, because the
 * declaration is what dispatch reads. With no declaration the check is verbatim
 * today's, on the incoming probe alone.
 *
 * A declaration is never written here. `swarm workers set-cli` states one through
 * {@link setWorkerDeclaredCapabilities}; a handshake only ever refreshes the probe.
 *
 * `supportedPhases` (issue #467) is written in the **same transaction** when
 * given, because a handshake declares both axes at once and a partial write would
 * leave the roster describing a machine that never existed. Omit it to leave the
 * stored phases untouched — the CLI-only path (`swarm workers set-cli`) knows
 * nothing about phases and must not silently reset them.
 *
 * `repository` (issue #687) is the daemon's declaration of which repository its one
 * local checkout is, written in that same transaction for the same reason. It is
 * **three-valued** on purpose: `undefined` leaves the stored value alone (the
 * `swarm workers set-cli` path knows nothing about checkouts and must not clear a
 * declaration it cannot make), `null` records that the connecting daemon declared
 * none, and a slug records it. `null` therefore *clears* an earlier daemon's
 * statement rather than leaving it standing — the row describes the program
 * currently operating it, and a stale-but-wrong checkout is worse than an absent
 * one.
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
	repository?: string | null,
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

		// Judge what dispatch will route on, not the raw probe: an owner's standing
		// declaration outranks this re-probe (issue #783).
		const offending = clisRequiredByEnrollments(
			enrollments,
			effectiveCapabilities({
				capabilities,
				declaredCapabilities: (existingWorker.declaredCapabilities as AgentCli[] | null) ?? null,
			}),
		);
		if (offending.length > 0) {
			throw new WorkerCapabilityReductionError(id, offending);
		}

		// Assembled rather than nested ternaries, so each declaration states its own
		// "omitted means leave it alone" rule once and a fourth axis costs one line.
		const declaration: Partial<typeof workers.$inferInsert> = { capabilities };
		if (supportedPhases) declaration.supportedPhases = supportedPhases;
		if (repository !== undefined) declaration.repository = repository;

		const [updatedRow] = await tx
			.update(workers)
			.set(declaration)
			.where(eq(workers.id, id))
			.returning();

		return updatedRow ? rowToWorker(updatedRow) : undefined;
	});
}

/**
 * State (or clear) the **owner's declaration** of which agent CLIs a worker should
 * run — the durable half of the CLI axis (issue #783), which no handshake
 * overwrites. `null` clears it, returning the worker to plain auto-discovery.
 * Returns the updated worker, or `undefined` if no worker has that id.
 *
 * Both safety properties are checked under the same `FOR UPDATE` lock as the write,
 * so neither can be raced by a concurrent handshake or enrollment change:
 *
 * - a declaration naming a CLI the machine's last probe never reported is refused
 *   with {@link WorkerCapabilityNotProbedError}. Widening past what the machine can
 *   run stays `SWARM_WORKER_TRANSPORT_CLIS`'s job, which sets the probe on the
 *   machine itself and so composes with an intersecting declaration;
 * - a declaration that would drop a CLI an existing enrollment still requires is
 *   refused with {@link WorkerCapabilityReductionError} — the same invariant
 *   ({@link updateWorkerCapabilities}) maintains on the probe path, judged here
 *   against the set this write is about to make effective.
 *
 * For a worker registered but never connected, `capabilities` is the operator's
 * registration set, so the first guard reads as "you may narrow what registration
 * declared" — coherent, and the error names the set it compared against.
 */
export async function setWorkerDeclaredCapabilities(
	id: string,
	declared: AgentCli[] | null,
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

		const probed = existingWorker.capabilities as AgentCli[];
		if (declared !== null) {
			const probedSet = new Set(probed);
			const unprobed = declared.filter((cli) => !probedSet.has(cli));
			if (unprobed.length > 0) {
				throw new WorkerCapabilityNotProbedError(id, unprobed, probed);
			}
		}

		const enrollments = await tx
			.select()
			.from(workerProjectEnrollments)
			.where(eq(workerProjectEnrollments.workerId, id));

		const offending = clisRequiredByEnrollments(
			enrollments,
			effectiveCapabilities({ capabilities: probed, declaredCapabilities: declared }),
		);
		if (offending.length > 0) {
			throw new WorkerCapabilityReductionError(id, offending);
		}

		const [updatedRow] = await tx
			.update(workers)
			.set({ declaredCapabilities: declared })
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
 * *transport* handshake, while the phase set is declared on its own — an operator
 * editing the worker (`src/identity/worker-service.ts`) states a repertoire without
 * touching a CLI set that is not theirs to overwrite. Without this split, a row
 * narrowed by one `connect` run would stay narrowed, permanently refusing
 * `planning` on a host that can in fact run it (issue #467). Issue #536 made
 * `connect` declare every phase too, so the narrowing case is now a daemon on an
 * older build.
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
