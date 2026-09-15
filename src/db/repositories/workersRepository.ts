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

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { AgentCli } from '../../harness/agent-cli.js';
import {
	DEFAULT_WORKER_SUPPORTED_PHASES,
	effectiveCapabilities,
	type Worker,
	WorkerCapabilityNotProbedError,
	WorkerCapabilityReductionError,
	type WorkerUpdateState,
	type WorkerWorktreeSweepState,
	type WorktreeSweepResult,
	type WorktreeSweepStatus,
} from '../../identity/worker.js';
import type { WorkerBuild, WorkerUpdateStatus } from '../../lib/build-identity.js';
import type { WorkerUpdateJob } from '../../queue/jobs.js';
// The single place a job's priority is decided (issue #972) — imported rather than
// restating the constant. A pure function: `getQueue()` is lazy, so importing the
// producer opens no Redis connection.
import { priorityFor } from '../../queue/producer.js';
import type { TriggerPhase } from '../../triggers/types.js';
import { getDb } from '../client.js';
import { workerProjectEnrollments } from '../schema/workerProjectEnrollments.js';
import { workers } from '../schema/workers.js';
import {
	createDispatch,
	type DispatchRow,
	findDispatchByDedupKey,
	supersedeWorkerUpdateDispatches,
} from './dispatchesRepository.js';
import {
	createWorkerUpdateRun,
	findWorkerUpdateRunIdByRequestId,
	settleWorkerUpdateRun,
	supersedeWorkerUpdateRun,
} from './runsRepository.js';

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
		drainingSince: row.drainingSince ?? null,
		// Reassembled as one value so a consumer cannot read a commit without its flag
		// (issue #918). The pair is always written together, so a non-null commit with a
		// null flag can only be a row hand-edited in `psql`; read that as not dirty.
		build: row.buildCommit ? { commit: row.buildCommit, dirty: row.buildDirty ?? false } : null,
		update: rowToUpdateState(row),
		worktreeSweep: rowToWorktreeSweepState(row),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * Re-assemble the seven `update_*` columns into one {@link WorkerUpdateState}, or
 * `null` when nobody has asked this machine to update (issue #933).
 *
 * Keyed on `update_target`/`update_requested_at` rather than on the pending marker,
 * because the value outlives the request: the report clears `update_request_id` and
 * leaves the target it concerned standing, so an operator reads the outcome beside
 * the build it is about. A row with one of the pair hand-edited away in `psql`
 * reads as "never asked" rather than as a state with no target.
 */
function rowToUpdateState(row: WorkerRow): WorkerUpdateState | null {
	if (!row.updateTarget || !row.updateRequestedAt) return null;
	return {
		requestId: row.updateRequestId ?? null,
		target: row.updateTarget,
		requestedAt: row.updateRequestedAt,
		// Who asked (issue #922). NULL for a request recorded before the column existed
		// and for one whose requester has since been deleted (`ON DELETE SET NULL`), so
		// a reader must render "unattributed" rather than assume the machine's owner.
		requestedByUserId: row.updateRequestedByUserId ?? null,
		status: row.updateStatus ?? null,
		message: row.updateMessage ?? null,
		reportedAt: row.updateReportedAt ?? null,
	};
}

/**
 * Re-assemble the five `worktree_sweep_*` columns into one
 * {@link WorkerWorktreeSweepState}, or `null` when nobody has asked this machine to
 * sweep (issue #955).
 *
 * Keyed on `worktree_sweep_requested_at` rather than on the pending marker, for
 * {@link rowToUpdateState}'s reason: the value outlives the request, since a report
 * clears `worktree_sweep_request_id` and leaves the outcome standing to be read.
 *
 * The outcome outlives the *next question* too (issue #956): `requestedAt` is the
 * latest request's instant, while `status`/`reportedAt`/`result` are the last sweep
 * actually reported, which may answer an earlier one. `reportedAt` is what tells the
 * two apart — see {@link WorkerWorktreeSweepState}.
 */
function rowToWorktreeSweepState(row: WorkerRow): WorkerWorktreeSweepState | null {
	if (!row.worktreeSweepRequestedAt) return null;
	return {
		requestId: row.worktreeSweepRequestId ?? null,
		requestedAt: row.worktreeSweepRequestedAt,
		status: row.worktreeSweepStatus ?? null,
		reportedAt: row.worktreeSweepReportedAt ?? null,
		result: row.worktreeSweepResult ?? null,
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
			//
			// `buildCommit`/`buildDirty` likewise (issue #918): registering a machine is
			// not declaring a build, and only the program that connects knows its own.
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
 * `build` (issue #918) is the SWARM build that daemon is running, written in the
 * same transaction on the same three-valued rule — with the one divergence that it
 * spans **two** columns: `null` sets both `build_commit` and `build_dirty` to null,
 * and a value writes both, so the pair is never half-set.
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
	build?: WorkerBuild | null,
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
		if (build !== undefined) {
			declaration.buildCommit = build?.commit ?? null;
			declaration.buildDirty = build?.dirty ?? null;
		}

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
 * Take a worker **out of the dispatch pool**, or return it to it (issue #919).
 * Idempotent by construction: draining an already-draining worker keeps the
 * original instant (`coalesce`), so an operator re-running the command to check
 * whether the machine has gone idle does not restart its own "draining since"
 * clock. Returns the updated worker, or `undefined` if no worker has that id.
 *
 * No enrollment validation and no transaction of its own, unlike the two
 * capability writes: draining narrows nothing an enrollment depends on, and the
 * one place the write must be ordered against — a concurrent claim — takes the
 * `workers` row `FOR UPDATE` on its side (`claimWorkerForDispatch`,
 * `./dispatchesRepository.ts`), so the two serialize on that row either way.
 */
export async function setWorkerDraining(
	id: string,
	draining: boolean,
): Promise<Worker | undefined> {
	const [updatedRow] = await getDb()
		.update(workers)
		.set({
			drainingSince: draining ? sql`coalesce(${workers.drainingSince}, now())` : null,
		})
		.where(eq(workers.id, id))
		.returning();
	return updatedRow ? rowToWorker(updatedRow) : undefined;
}

/**
 * What became of a {@link requestWorkerUpdate} write. Four outcomes rather than a
 * `Worker | undefined`, because the draining precondition is part of the write
 * itself (issue #921) and "declined" has to be tellable from "no such machine":
 *
 * - `requested` — the row now carries the request, and `worker` is it. `runId` is the
 *   `runs` row that records the update (issue #971), and `dispatch` is the durable
 *   queued unit that will deliver it (issue #972) — the row the caller publishes a
 *   wake-up for, and the reason the delivery survives a control-plane restart.
 * - `in-pool` — the machine was not draining, so nothing was written; `worker` is the
 *   row as it stands, for the refusal the caller words.
 * - `no-project` — the machine is enrolled in no project (issue #971), so there is no
 *   project for its run to hang off and nothing was written; `worker` is the row, for
 *   the refusal the caller words.
 * - `not-found` — no worker has that id.
 */
export type WorkerUpdateRequestOutcome =
	| { outcome: 'requested'; worker: Worker; runId: string; dispatch: DispatchRow }
	| { outcome: 'in-pool'; worker: Worker }
	| { outcome: 'no-project'; worker: Worker }
	| { outcome: 'not-found' };

/**
 * The executor the two worker-update writers below take, so each can run its reads
 * and its writes inside one transaction. The spirit of `RunWriteExecutor`
 * (`./runsRepository.ts`), widened with `select` because both of them *decide* what
 * to write from a read taken in the same transaction.
 */
type WorkerUpdateExecutor = Pick<ReturnType<typeof getDb>, 'insert' | 'select' | 'update'>;

/**
 * The machine's **oldest** enrollment — the project an update's run and dispatch hang
 * off (issue #971), and deliberately unfiltered by enrollment status: those rows are
 * a *record* of what happened to a machine, not a routing decision, so a `pending` or
 * `suspended` enrollment still names the project the machine belongs to. A machine
 * enrolled in none has nothing to hang them off, which is the `no-project` boundary.
 *
 * Shared by {@link requestWorkerUpdate} and {@link adoptOutstandingWorkerUpdateRequest}
 * so the two cannot come to different answers about which project an update belongs
 * to for the same machine.
 */
async function oldestEnrollment(
	db: WorkerUpdateExecutor,
	workerId: string,
): Promise<{ projectId: string } | undefined> {
	const [row] = await db
		.select({ projectId: workerProjectEnrollments.projectId })
		.from(workerProjectEnrollments)
		.where(eq(workerProjectEnrollments.workerId, workerId))
		.orderBy(asc(workerProjectEnrollments.createdAt), asc(workerProjectEnrollments.id))
		.limit(1);
	return row;
}

/**
 * Record that an operator asked this machine to move its SWARM install root to
 * `target`, replacing any request already outstanding (issue #933) — **only while
 * the machine is draining**.
 *
 * All seven columns are written together, so a fresh request never shows the previous
 * one's verdict beside it: the outcome fields are reset to NULL in the same write
 * that records the new target. Re-targeting is therefore a plain overwrite, which is
 * the only form of "cancel" this phase has — the earlier request's push is simply no
 * longer the one the row is waiting on, and a report for it is recognised as stale
 * by {@link recordWorkerUpdateReport}'s id check.
 *
 * `requestedByUserId` is the seventh (issue #922) and is written with the request
 * rather than derived: the requester and the machine's owner are the same person for
 * every owner-scoped caller and a different one for the installation-wide command, so
 * the row records it instead of leaving a reader to assume.
 *
 * **`draining_since IS NOT NULL` is a predicate of the `WHERE`, not a check the
 * caller makes first** (issue #921). The precondition is what makes the whole
 * mechanism safe — the daemon waits for its in-flight phases to finish, and only
 * draining stops new work being dispatched into that wait — so a caller that read
 * the row, found it draining, and then wrote unconditionally would record and push a
 * request onto a machine a concurrent `swarm workers undrain` had already returned
 * to the pool. Deciding it here is what makes that impossible rather than unlikely,
 * and it is the *one* place both the single-machine and the fleet caller decide it.
 * No transaction is needed for that: the eligibility test and the write are the same
 * statement, and `setWorkerDraining` is a single statement on the same row, so the
 * two serialize on the row itself.
 *
 * The follow-up read on the declined path is not part of the guarantee — the
 * predicate already is — and only decides which refusal the caller gets to name.
 *
 * **Transactional since issue #971**, because the request now also creates the
 * `runs` row that makes the update visible: the two must exist or not exist
 * together, since a recorded request with no run is the invisibility that issue
 * exists to remove, and a run with no request is a row nothing will ever settle.
 *
 * **The durable dispatch joined that transaction with issue #972**, for exactly
 * the argument #971 made about the run: a recorded request with no dispatch is a
 * request nothing will ever deliver, and a dispatch with no request is a unit that
 * would push nothing. It is ranked below every other job's priority
 * (`priorityFor`), so a machine asked to update while its project's queue is full
 * is served first rather than last, and the previous request's dispatch is
 * superseded beside the previous request's run.
 *
 * The machine's **project** is resolved first, from its oldest enrollment — the
 * order {@link listEnrollmentsForWorker} already reads in, and deliberately not
 * filtered by enrollment status: the run is a *record* of what happened to a
 * machine, not a routing decision, so a `pending` or `suspended` enrollment still
 * names the project the machine belongs to. A machine enrolled in **no** project is
 * answered `no-project` and nothing at all is written; that boundary is decided
 * before the row write, in the same statement-order as the draining predicate, so
 * this can never record a request it cannot record a run for.
 */
export async function requestWorkerUpdate(
	id: string,
	requestId: string,
	target: string,
	requestedByUserId: string,
): Promise<WorkerUpdateRequestOutcome> {
	return await getDb().transaction(async (tx) => {
		const enrollment = await oldestEnrollment(tx, id);
		if (!enrollment) {
			const existing = await getWorkerById(id);
			return existing ? { outcome: 'no-project', worker: existing } : { outcome: 'not-found' };
		}

		const [updatedRow] = await tx
			.update(workers)
			.set({
				updateRequestId: requestId,
				updateTarget: target,
				updateRequestedAt: new Date(),
				updateRequestedByUserId: requestedByUserId,
				updateStatus: null,
				updateMessage: null,
				updateReportedAt: null,
			})
			.where(and(eq(workers.id, id), isNotNull(workers.drainingSince)))
			.returning();
		if (!updatedRow) {
			const existing = await getWorkerById(id);
			return existing ? { outcome: 'in-pool', worker: existing } : { outcome: 'not-found' };
		}

		// Re-targeting overwrites the row's one request, so the run the previous request
		// created is settled here rather than left `running` with nothing coming to close
		// it — its own report will answer `recorded: false`. Its dispatch goes the same
		// way, and for the same reason: it would otherwise sit in the queue waiting to
		// push a build the row has moved off.
		await supersedeWorkerUpdateRun(id, target, tx);
		await supersedeWorkerUpdateDispatches(
			id,
			`Superseded by a later request to move this machine to ${target}.`,
			tx,
		);
		const runId = await createWorkerUpdateRun(
			{
				projectId: enrollment.projectId,
				workerId: id,
				workerUserId: updatedRow.ownerUserId,
				requestId,
				target,
				machine: updatedRow.displayName,
			},
			tx,
		);
		// The unit that actually delivers the request. `uq_dispatches_active_run` is per
		// `run_id` and the run was just inserted, so there is nothing to collide with;
		// the supersede above is what keeps the *previous* request's dispatch from
		// lingering non-terminal.
		const jobPayload: WorkerUpdateJob = {
			type: 'worker-update',
			projectId: enrollment.projectId,
			workerId: id,
			requestId,
			target,
		};
		const { dispatch } = await createDispatch(
			{
				projectId: enrollment.projectId,
				jobPayload,
				dedupKey: workerUpdateDedupKey(requestId),
				priority: priorityFor(jobPayload) ?? 0,
				source: 'manual',
				phase: 'worker-update',
				runId,
			},
			tx,
		);
		return { outcome: 'requested', worker: rowToWorker(updatedRow), runId, dispatch };
	});
}

/**
 * The dedup identity of the dispatch that delivers one update request: the request
 * id, which is minted per machine, so two machines asked in the same fan-out never
 * share one.
 */
function workerUpdateDedupKey(requestId: string): string {
	return `worker-update:${requestId}`;
}

/**
 * Give an outstanding update request the durable dispatch it is missing, and answer
 * with the dispatch so the caller can publish its wake-up (issue #972).
 *
 * **This exists for one upgrade boundary.** Before this issue the request lived on the
 * `workers` row alone and was delivered by a direct push — at request time, and again
 * from the reconnect hook when the machine had been offline for it, which for a
 * machine an operator drains first is the ordinary path rather than an edge. That hook
 * now wakes a dispatch instead (`resendPendingWorkerUpdateToWorker`,
 * `../../router/worker-update-dispatch.ts`), so a
 * request recorded by the *old* control plane and still outstanding when the new one
 * starts would have nothing to wake and would be dropped in silence, leaving an
 * operator's machine on the old build with no error anywhere. The missing row is
 * therefore written lazily, from the same reconnect that would have delivered it,
 * rather than by a deployment-time backfill: a backfill would have to be sequenced
 * against the rollout by hand, and still could not repair a request the old build
 * recorded while that rollout was in progress.
 *
 * **Idempotent on the dispatch's dedup key, which is the request id.** A request whose
 * dispatch already exists — waiting, claimed, or long since completed — is answered
 * `undefined` and nothing is written, so a machine that reconnects repeatedly never
 * collects a second dispatch for a request one delivery already settled. That is also
 * what keeps this off the ordinary path entirely: every request recorded since this
 * issue carries its dispatch out of the transaction that recorded it, so the first
 * read here ends the call.
 *
 * `undefined` likewise covers a machine with nothing outstanding, an unknown machine,
 * and one enrolled in no project — the same boundary {@link requestWorkerUpdate}
 * answers `no-project` for, and for the same reason: there is no project to hang the
 * run and the dispatch off.
 */
export async function adoptOutstandingWorkerUpdateRequest(
	id: string,
): Promise<DispatchRow | undefined> {
	return await getDb().transaction(async (tx) => {
		const [row] = await tx.select().from(workers).where(eq(workers.id, id)).limit(1);
		// `update_request_id` is cleared by the report, so a non-null one *is* an
		// outstanding request ({@link recordWorkerUpdateReport}); `update_target` is the
		// build it names and no request is recorded without one.
		if (!row?.updateRequestId || !row.updateTarget) return undefined;
		const requestId = row.updateRequestId;
		const target = row.updateTarget;
		if (await findDispatchByDedupKey(workerUpdateDedupKey(requestId), tx)) return undefined;
		const enrollment = await oldestEnrollment(tx, id);
		if (!enrollment) return undefined;

		// The run the request already created, when it was recorded by a build carrying
		// issue #971 — linked to rather than duplicated, since that is the row an
		// operator is already looking at. A request older than #971 has none and gets one
		// here: the dispatch is what will deliver it, so the record of that delivery
		// starts now.
		const runId =
			(await findWorkerUpdateRunIdByRequestId(requestId, tx)) ??
			(await createWorkerUpdateRun(
				{
					projectId: enrollment.projectId,
					workerId: id,
					workerUserId: row.ownerUserId,
					requestId,
					target,
					machine: row.displayName,
				},
				tx,
			));

		const jobPayload: WorkerUpdateJob = {
			type: 'worker-update',
			projectId: enrollment.projectId,
			workerId: id,
			requestId,
			target,
		};
		const { dispatch } = await createDispatch(
			{
				projectId: enrollment.projectId,
				jobPayload,
				dedupKey: workerUpdateDedupKey(requestId),
				priority: priorityFor(jobPayload) ?? 0,
				source: 'manual',
				phase: 'worker-update',
				runId,
			},
			tx,
		);
		return dispatch;
	});
}

/**
 * Record what a machine reported became of a requested update, and stop treating
 * that request as outstanding (issue #933).
 *
 * The `update_request_id` match is the whole point of the `WHERE`: a report is only
 * ever the answer to the request it names, so one arriving for a request an operator
 * has since re-targeted must not clear the pending marker the *new* request set.
 * That case returns `undefined`, which the route reports as `recorded: false` —
 * not an error, since the outcome concerned a request nothing is waiting on any more.
 * `undefined` also covers a duplicate report (the marker is already cleared) and an
 * unknown worker.
 *
 * `update_target` is deliberately left standing: it is the build this outcome is
 * about, and an outcome naming none answers nothing.
 *
 * **Transactional since issue #971**, because the report also settles the `runs` row
 * the request created — and it does so **unconditionally**, not gated on the
 * `workers` write above matching. A report whose request the row has moved on from
 * still answers *that request's* run, which is the row the operator is looking at;
 * this mirrors the choice `handleReportWorkerUpdate` already makes for
 * `advanceWorkerRollout` — the outcome is written either way.
 */
export async function recordWorkerUpdateReport(
	id: string,
	requestId: string,
	status: WorkerUpdateStatus,
	message: string,
): Promise<Worker | undefined> {
	return await getDb().transaction(async (tx) => {
		const [updatedRow] = await tx
			.update(workers)
			.set({
				updateRequestId: null,
				updateStatus: status,
				updateMessage: message,
				updateReportedAt: new Date(),
			})
			.where(and(eq(workers.id, id), eq(workers.updateRequestId, requestId)))
			.returning();
		await settleWorkerUpdateRun(requestId, status, message, tx);
		return updatedRow ? rowToWorker(updatedRow) : undefined;
	});
}

/**
 * Record that an operator asked this machine to sweep its abandoned worktrees,
 * replacing any request already outstanding (issue #955). Returns the updated
 * worker, or `undefined` if no worker has that id.
 *
 * **Only the request pair is written; the reported outcome beside it is left
 * standing** (issue #956). Asking is a plain overwrite of
 * `worktree_sweep_request_id`/`worktree_sweep_requested_at` — the only form of
 * "cancel" there is, since the earlier request's push is no longer the one the row
 * waits on and a report for it is recognised as stale by
 * {@link recordWorktreeSweepReport}'s id check — but it must not also erase the
 * last sweep the machine reported, which is the record `swarm workers sweeps`
 * exists to read. Once the fleet is asked weekly by a timer nobody is watching
 * (`src/api/maintenance.ts`), a request that cleared the answer would blank the
 * readout for every machine that had not answered the latest ask yet: the ordinary
 * state of a laptop asleep at 03:00, and the permanent state of a retired one. The
 * outcome is replaced by the next *report*, not by the next question, which is what
 * the columns themselves now say (`../schema/workers.ts`).
 *
 * **Deliberately carries no `draining_since IS NOT NULL` predicate**, which is the
 * one way this diverges from {@link requestWorkerUpdate}. An update replaces the
 * code under a running daemon and therefore needs a machine no new work is
 * dispatched to; a sweep disturbs no in-flight run, because a checkout a phase
 * still holds reads as leased and is skipped. Requiring a drain would also make
 * phase 3's unattended weekly sweep impossible — so there is no `in-pool`
 * disposition here and nothing for a caller to word a refusal about.
 */
export async function requestWorktreeSweep(
	id: string,
	requestId: string,
): Promise<Worker | undefined> {
	const [updatedRow] = await getDb()
		.update(workers)
		.set({
			worktreeSweepRequestId: requestId,
			worktreeSweepRequestedAt: new Date(),
		})
		.where(eq(workers.id, id))
		.returning();
	return updatedRow ? rowToWorker(updatedRow) : undefined;
}

/**
 * Record what a machine reported became of a requested sweep, and stop treating
 * that request as outstanding (issue #955).
 *
 * The `worktree_sweep_request_id` match is the whole point of the `WHERE`, exactly
 * as it is for {@link recordWorkerUpdateReport}: a report is only ever the answer
 * to the request it names, so one arriving for a request an operator has since
 * re-issued must not clear the pending marker the *new* request set. That case
 * returns `undefined`, which the route reports as `recorded: false` — not an error,
 * since the outcome concerned a request nothing is waiting on any more.
 * `undefined` also covers a duplicate report and an unknown worker.
 */
export async function recordWorktreeSweepReport(
	id: string,
	requestId: string,
	status: WorktreeSweepStatus,
	result: WorktreeSweepResult,
): Promise<Worker | undefined> {
	const [updatedRow] = await getDb()
		.update(workers)
		.set({
			worktreeSweepRequestId: null,
			worktreeSweepStatus: status,
			worktreeSweepReportedAt: new Date(),
			worktreeSweepResult: result,
		})
		.where(and(eq(workers.id, id), eq(workers.worktreeSweepRequestId, requestId)))
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
 *
 * The worker's runs stay: `runs.worker_id` is `ON DELETE SET NULL`, and what keeps
 * each one readable afterwards is the denormalized column beside it — `worker_user_id`
 * for the attribution, and `maintenance_machine` for a maintenance run's machine
 * (issue #971), whose subject the link itself was.
 */
export async function removeWorker(id: string): Promise<boolean> {
	const rows = await getDb()
		.delete(workers)
		.where(eq(workers.id, id))
		.returning({ id: workers.id });
	return rows.length > 0;
}
