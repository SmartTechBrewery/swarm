/**
 * Staged-fleet-update persistence (issue #940) — plain functions, one `getDb()`
 * per call, no class, mirroring `workersRepository.ts`. Backs the
 * `worker_update_rollouts` / `worker_update_rollout_members` tables
 * (`../schema/workerUpdateRollouts.ts`), whose domain shapes live in
 * `../../identity/worker-update-rollout.ts` and stay the source of truth.
 *
 * Rows already carry the domain's exact types, so mapping one back is a
 * re-assembly rather than a re-validation — the same treatment `rowToWorker` gets,
 * with the two `text` state columns cast back to their enums exactly as
 * `project_members.role` is.
 *
 * The one thing here that is not a plain read or write is
 * {@link advanceUnderRolloutLock}. Advancing a rollout is a read-decide-write
 * sequence over several machines, so it must be **single-flight**: two advances
 * running at once would both see the same wave settled and both drain the next
 * one, taking twice the capacity the operator bounded. It therefore takes the
 * rollout row `FOR UPDATE` and hands the caller a snapshot read under that lock
 * plus the two writes it may make, so the policy module cannot accidentally decide
 * on a stale read. Since issue #941 that call is driven from three event sources at
 * once (`../../router/worker-rollout-advance.ts`), which is what makes the lock
 * load-bearing rather than defensive.
 *
 * The *member* writes it hands over deliberately do not extend to the `workers`
 * table: draining a machine and asking it to update are single statements that
 * serialize on the worker row themselves (`setWorkerDraining`,
 * `requestWorkerUpdate`), and holding this transaction open across them would only
 * widen the lock without buying an invariant. A crash mid-advance therefore leaves
 * the rollout re-advanceable rather than atomic, which is the state machine's own
 * design: every step is decided from durable state and re-deciding it is a no-op.
 *
 * Since issue #1023 the two reads those triggers select through —
 * {@link listAdvanceableRollouts} and {@link listAdvanceableRolloutsForOwner} — take
 * a **halted** rollout that still holds an unsettled member as well as every
 * `in_progress` one. The policy already settles whatever is in flight whatever the
 * rollout's status; what was missing was anything that would advance such a rollout
 * again, so a machine it had drained stayed out of the dispatch pool for good.
 * {@link findInProgressRolloutForOwner} deliberately keeps the narrower meaning: it
 * answers "is one already moving", and a halted rollout must not block a new one.
 */

import { and, asc, desc, eq, exists, notInArray, or, sql } from 'drizzle-orm';

import {
	SETTLED_WORKER_UPDATE_ROLLOUT_MEMBER_STATES,
	type WorkerUpdateRollout,
	type WorkerUpdateRolloutMember,
	type WorkerUpdateRolloutMemberState,
	type WorkerUpdateRolloutStatus,
} from '../../identity/worker-update-rollout.js';
import type { WorkerUpdateStatus } from '../../lib/build-identity.js';
import { getDb } from '../client.js';
import {
	workerUpdateRolloutMembers,
	workerUpdateRollouts,
} from '../schema/workerUpdateRollouts.js';

type RolloutRow = typeof workerUpdateRollouts.$inferSelect;
type MemberRow = typeof workerUpdateRolloutMembers.$inferSelect;

/** A rollout plus its members, in the rollout's own order. */
export interface LoadedRollout {
	rollout: WorkerUpdateRollout;
	members: WorkerUpdateRolloutMember[];
}

/** Re-assemble a `WorkerUpdateRollout` from its row. */
function rowToRollout(row: RolloutRow): WorkerUpdateRollout {
	return {
		id: row.id,
		requestedByUserId: row.requestedByUserId,
		target: row.target,
		waveSize: row.waveSize,
		status: row.status as WorkerUpdateRolloutStatus,
		haltReason: row.haltReason ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Re-assemble a `WorkerUpdateRolloutMember` from its row. */
function rowToMember(row: MemberRow): WorkerUpdateRolloutMember {
	return {
		workerId: row.workerId,
		position: row.position,
		state: row.state as WorkerUpdateRolloutMemberState,
		requestId: row.requestId ?? null,
		outcome: (row.outcome as WorkerUpdateStatus | null) ?? null,
		message: row.message ?? null,
		drainedByRollout: row.drainedByRollout,
		fencingTokenAtSignal: row.fencingTokenAtSignal ?? null,
		buildCommitAtSignal: row.buildCommitAtSignal ?? null,
		signalledAt: row.signalledAt ?? null,
		settledAt: row.settledAt ?? null,
	};
}

/** The fields a caller supplies to start a rollout; `id`/timestamps are generated. */
export interface CreateRolloutInput {
	requestedByUserId: string;
	target: string;
	waveSize: number;
	/** The machines to move, in the order they are to be moved — `position` is the index. */
	workerIds: string[];
}

/**
 * Start a rollout and name its members, in one transaction so a rollout never
 * exists without the machines it is about.
 *
 * Rejects with the pg `23505` unique violation when the owner already has an
 * `in_progress` rollout — the partial unique index decides that, not a read here,
 * so a second `swarm workers update --all` landing at the same instant cannot slip
 * between a check and the insert. The caller translates it (a `CONFLICT` naming the
 * status command), exactly as `createWorker`'s duplicate is translated by its own.
 */
export async function createRollout(input: CreateRolloutInput): Promise<LoadedRollout> {
	return await getDb().transaction(async (tx) => {
		const [rolloutRow] = await tx
			.insert(workerUpdateRollouts)
			.values({
				requestedByUserId: input.requestedByUserId,
				target: input.target,
				waveSize: input.waveSize,
			})
			.returning();
		const memberRows = input.workerIds.length
			? await tx
					.insert(workerUpdateRolloutMembers)
					.values(
						input.workerIds.map((workerId, position) => ({
							rolloutId: rolloutRow.id,
							workerId,
							position,
						})),
					)
					.returning()
			: [];
		return {
			rollout: rowToRollout(rolloutRow),
			members: memberRows.map(rowToMember).sort((a, b) => a.position - b.position),
		};
	});
}

/**
 * The owner's most recent rollout whatever its status, or `undefined` when they
 * have never started one — what `swarm workers update --status` reads, so a halted
 * or completed rollout stays readable after it has stopped moving.
 */
export async function findLatestRolloutForOwner(
	ownerUserId: string,
): Promise<WorkerUpdateRollout | undefined> {
	const rows = await getDb()
		.select()
		.from(workerUpdateRollouts)
		.where(eq(workerUpdateRollouts.requestedByUserId, ownerUserId))
		.orderBy(desc(workerUpdateRollouts.createdAt), desc(workerUpdateRollouts.id))
		.limit(1);
	const row = rows[0];
	return row ? rowToRollout(row) : undefined;
}

/**
 * The owner's rollout that is still moving, or `undefined` when none is. At most
 * one can exist (the partial unique index), so this is a lookup rather than a pick.
 */
export async function findInProgressRolloutForOwner(
	ownerUserId: string,
): Promise<WorkerUpdateRollout | undefined> {
	const rows = await getDb()
		.select()
		.from(workerUpdateRollouts)
		.where(
			and(
				eq(workerUpdateRollouts.requestedByUserId, ownerUserId),
				eq(workerUpdateRollouts.status, 'in_progress'),
			),
		)
		.limit(1);
	const row = rows[0];
	return row ? rowToRollout(row) : undefined;
}

/**
 * The rollouts an advance can still do something with (issue #1023): every
 * `in_progress` one, plus a `halted` one that still holds a member the rollout
 * committed to and has not settled.
 *
 * A halted rollout has to stay selectable because the advance deliberately leaves
 * its in-flight members alone to be settled by *a later advance* — and until this
 * predicate existed there was no later advance, so a member left `signalled`,
 * `verifying` or merely `draining` never settled and any machine the rollout had
 * drained stayed out of the dispatch pool with nothing but a manual `swarm workers
 * undrain` to put it back.
 *
 * `in_progress` is accepted unconditionally rather than filtered by the same
 * unsettled-member test: a rollout whose members all settled but which was cut off
 * before `completeIfSettled` wrote `completed` would otherwise never be selected
 * again, and the partial unique index would block its owner's next rollout forever.
 *
 * `completed` is never advanceable — that status is only written once every member
 * has settled, so there is nothing left to decide.
 */
function advanceableRollout() {
	return or(
		eq(workerUpdateRollouts.status, 'in_progress'),
		and(
			eq(workerUpdateRollouts.status, 'halted'),
			exists(
				getDb()
					.select({ one: sql`1` })
					.from(workerUpdateRolloutMembers)
					.where(
						and(
							eq(workerUpdateRolloutMembers.rolloutId, workerUpdateRollouts.id),
							notInArray(workerUpdateRolloutMembers.state, [
								...SETTLED_WORKER_UPDATE_ROLLOUT_MEMBER_STATES,
							]),
						),
					),
			),
		),
	);
}

/**
 * Every rollout an advance can still move, oldest first — the read behind the
 * periodic advance (issue #941, `../../router/worker-rollout-advance.ts`), which has
 * no operator to scope it by and so asks for the whole live set.
 *
 * Bounded twice over: at most one row per operator can be `in_progress` (the partial
 * unique index), and a halted one drops out of the set the moment its last committed
 * member settles, so this is "one row per operator with a fleet update still owing an
 * answer" rather than a scan whose cost grows with the rollout history.
 */
export async function listAdvanceableRollouts(): Promise<WorkerUpdateRollout[]> {
	const rows = await getDb()
		.select()
		.from(workerUpdateRollouts)
		.where(advanceableRollout())
		.orderBy(asc(workerUpdateRollouts.createdAt), asc(workerUpdateRollouts.id));
	return rows.map(rowToRollout);
}

/**
 * The same set scoped to one operator, oldest first — the read behind the two
 * per-machine triggers, which learn about a machine and resolve its rollouts through
 * its owner. A list rather than a lookup: an owner has at most one `in_progress`
 * rollout, but may have several halted ones still owed an answer. Served by
 * `idx_worker_update_rollouts_owner`.
 */
export async function listAdvanceableRolloutsForOwner(
	ownerUserId: string,
): Promise<WorkerUpdateRollout[]> {
	const rows = await getDb()
		.select()
		.from(workerUpdateRollouts)
		.where(and(eq(workerUpdateRollouts.requestedByUserId, ownerUserId), advanceableRollout()))
		.orderBy(asc(workerUpdateRollouts.createdAt), asc(workerUpdateRollouts.id));
	return rows.map(rowToRollout);
}

/** One rollout and its members, unlocked — the read behind the status surfaces. */
export async function readRollout(rolloutId: string): Promise<LoadedRollout | undefined> {
	const rows = await getDb()
		.select()
		.from(workerUpdateRollouts)
		.where(eq(workerUpdateRollouts.id, rolloutId))
		.limit(1);
	const row = rows[0];
	if (!row) return undefined;
	return { rollout: rowToRollout(row), members: await readMembers(getDb(), rolloutId) };
}

/** The fields one advance may change on a member. Omitted fields are left alone. */
export interface MemberPatch {
	state?: WorkerUpdateRolloutMemberState;
	requestId?: string | null;
	outcome?: WorkerUpdateStatus | null;
	message?: string | null;
	drainedByRollout?: boolean;
	fencingTokenAtSignal?: number | null;
	buildCommitAtSignal?: string | null;
	signalledAt?: Date | null;
	settledAt?: Date | null;
}

/** The two writes an advance may make, bound to the transaction holding the rollout lock. */
export interface RolloutWriter {
	setMember(workerId: string, patch: MemberPatch): Promise<void>;
	setStatus(status: WorkerUpdateRolloutStatus, haltReason?: string | null): Promise<void>;
}

/**
 * Run `body` with the rollout row held `FOR UPDATE`, handing it a snapshot read
 * under that lock and the writes it may make. Returns `undefined` — without calling
 * `body` — when no rollout has that id.
 *
 * The snapshot is read *inside* the lock on purpose: a caller that read the members
 * first and then took the lock would decide the next wave from a list another
 * advance had already moved on from, which is the one race the lock exists to close.
 */
export async function advanceUnderRolloutLock<T>(
	rolloutId: string,
	body: (loaded: LoadedRollout, write: RolloutWriter) => Promise<T>,
): Promise<T | undefined> {
	return await getDb().transaction(async (tx) => {
		const rows = await tx
			.select()
			.from(workerUpdateRollouts)
			.where(eq(workerUpdateRollouts.id, rolloutId))
			.for('update')
			.limit(1);
		const row = rows[0];
		if (!row) return undefined;

		const writer: RolloutWriter = {
			async setMember(workerId, patch) {
				await tx
					.update(workerUpdateRolloutMembers)
					.set(patch)
					.where(
						and(
							eq(workerUpdateRolloutMembers.rolloutId, rolloutId),
							eq(workerUpdateRolloutMembers.workerId, workerId),
						),
					);
			},
			async setStatus(status, haltReason) {
				await tx
					.update(workerUpdateRollouts)
					// The reason travels with the status in one statement, so a halted
					// rollout never reads as stopped for no reason; a non-halt clears it.
					.set({ status, haltReason: status === 'halted' ? (haltReason ?? null) : null })
					.where(eq(workerUpdateRollouts.id, rolloutId));
			},
		};

		return await body(
			{ rollout: rowToRollout(row), members: await readMembers(tx, rolloutId) },
			writer,
		);
	});
}

/** This rollout's members in its own order, on whichever connection the caller is using. */
async function readMembers(
	db: Pick<ReturnType<typeof getDb>, 'select'>,
	rolloutId: string,
): Promise<WorkerUpdateRolloutMember[]> {
	const rows = await db
		.select()
		.from(workerUpdateRolloutMembers)
		.where(eq(workerUpdateRolloutMembers.rolloutId, rolloutId))
		.orderBy(asc(workerUpdateRolloutMembers.position), asc(workerUpdateRolloutMembers.workerId));
	return rows.map(rowToMember);
}
