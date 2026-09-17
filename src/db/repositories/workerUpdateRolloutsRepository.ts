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
 * That in turn is what lets two of an operator's rollouts hold the same machine at
 * once, which {@link findRolloutHoldElsewhere} is the read for.
 *
 * Since issue #1024 a rollout also has a **scope**, and the lookups come in pairs
 * because of it: every read that used to mean "this operator's rollout" now says
 * `scope = 'owner'` as well, and each has an installation-wide twin
 * ({@link findInProgressInstallationRollout}, {@link findLatestInstallationRollout},
 * {@link findAdvanceableInstallationRollout}). The narrowing is not cosmetic — an
 * installation-wide rollout carries the administrator who started it in
 * `requested_by_user_id`, so an un-narrowed owner read would hand *their own*
 * owner-scoped surfaces a rollout over machines they do not own.
 * {@link listAdvanceableRollouts}, the tick's read, is deliberately left scope-blind:
 * a rollout worth advancing is worth advancing whatever it is over.
 */

import { and, asc, desc, eq, exists, inArray, ne, notInArray, or, sql } from 'drizzle-orm';

import {
	COMMITTED_WORKER_UPDATE_ROLLOUT_MEMBER_STATES,
	SETTLED_WORKER_UPDATE_ROLLOUT_MEMBER_STATES,
	type WorkerUpdateRollout,
	type WorkerUpdateRolloutMember,
	type WorkerUpdateRolloutMemberState,
	type WorkerUpdateRolloutScope,
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
		scope: row.scope as WorkerUpdateRolloutScope,
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
	/** Which machines this rollout is over — `owner` | `installation` (issue #1024). */
	scope: WorkerUpdateRolloutScope;
	target: string;
	waveSize: number;
	/** The machines to move, in the order they are to be moved — `position` is the index. */
	workerIds: string[];
}

/**
 * Start a rollout and name its members, in one transaction so a rollout never
 * exists without the machines it is about.
 *
 * Rejects with the pg `23505` unique violation when a live rollout already occupies
 * the slot this one asks for — the owner's, for `scope = 'owner'`, or the
 * installation's single one, for `scope = 'installation'`. Both partial unique
 * indexes decide that, not a read here, so a second `swarm workers update --all`
 * landing at the same instant cannot slip between a check and the insert. The caller
 * translates it (a `CONFLICT` naming the status command), exactly as `createWorker`'s
 * duplicate is translated by its own.
 */
export async function createRollout(input: CreateRolloutInput): Promise<LoadedRollout> {
	return await getDb().transaction(async (tx) => {
		const [rolloutRow] = await tx
			.insert(workerUpdateRollouts)
			.values({
				requestedByUserId: input.requestedByUserId,
				scope: input.scope,
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
 * The owner's most recent **owner-scoped** rollout whatever its status, or
 * `undefined` when they have never started one — what `swarm workers update
 * --status` reads, so a halted or completed rollout stays readable after it has
 * stopped moving.
 *
 * Narrowed by `scope` since issue #1024 for the same reason
 * {@link findInProgressRolloutForOwner} is, and one that matters more here: an
 * administrator's installation-wide rollout carries *their* id in
 * `requested_by_user_id`, so without the narrowing their own owner-scoped status
 * procedure would answer with it — a member list of machines they do not own,
 * through a procedure that is owner-scoped and gated by nothing but
 * `authedProcedure`.
 */
export async function findLatestRolloutForOwner(
	ownerUserId: string,
): Promise<WorkerUpdateRollout | undefined> {
	const rows = await getDb()
		.select()
		.from(workerUpdateRollouts)
		.where(
			and(
				eq(workerUpdateRollouts.requestedByUserId, ownerUserId),
				eq(workerUpdateRollouts.scope, 'owner'),
			),
		)
		.orderBy(desc(workerUpdateRollouts.createdAt), desc(workerUpdateRollouts.id))
		.limit(1);
	const row = rows[0];
	return row ? rowToRollout(row) : undefined;
}

/**
 * The owner's **owner-scoped** rollout that is still moving, or `undefined` when none
 * is. At most one can exist (the partial unique index), so this is a lookup rather
 * than a pick.
 *
 * `scope = 'owner'` is not redundant with the cross-scope refusal the policy applies
 * on top of it (issue #1024): an installation-wide rollout carries the administrator
 * who started it in `requested_by_user_id`, so without this the administrator's own
 * `startRollout({ scope: 'owner' })` would find it and hand it to
 * `resolveAgainstExisting`, which would *advance* an installation-wide rollout on an
 * owner-scoped call.
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
				eq(workerUpdateRollouts.scope, 'owner'),
				eq(workerUpdateRollouts.status, 'in_progress'),
			),
		)
		.limit(1);
	const row = rows[0];
	return row ? rowToRollout(row) : undefined;
}

/**
 * **Anybody's** owner-scoped rollout that is still moving, or `undefined` when none
 * is — the read behind the cross-scope refusal (issue #1024), which has to answer
 * "is any owner mid-rollout" before an installation-wide one drains machines those
 * rollouts are already holding. A lookup rather than a list: the refusal needs one
 * example to name, not the set.
 *
 * Served by the same partial unique index the per-owner lookup is, which under this
 * predicate holds one row per owner with a live rollout and nothing else.
 */
export async function findAnyInProgressOwnerRollout(): Promise<WorkerUpdateRollout | undefined> {
	const rows = await getDb()
		.select()
		.from(workerUpdateRollouts)
		.where(
			and(eq(workerUpdateRollouts.scope, 'owner'), eq(workerUpdateRollouts.status, 'in_progress')),
		)
		.orderBy(asc(workerUpdateRollouts.createdAt), asc(workerUpdateRollouts.id))
		.limit(1);
	const row = rows[0];
	return row ? rowToRollout(row) : undefined;
}

/**
 * The installation-wide rollout that is still moving, or `undefined` when none is —
 * the installation twin of {@link findInProgressRolloutForOwner} (issue #1024). At
 * most one can exist for the whole installation, which is
 * `idx_worker_update_rollouts_installation_live`'s own rule, so this is a lookup
 * rather than a pick.
 */
export async function findInProgressInstallationRollout(): Promise<
	WorkerUpdateRollout | undefined
> {
	const rows = await getDb()
		.select()
		.from(workerUpdateRollouts)
		.where(
			and(
				eq(workerUpdateRollouts.scope, 'installation'),
				eq(workerUpdateRollouts.status, 'in_progress'),
			),
		)
		.limit(1);
	const row = rows[0];
	return row ? rowToRollout(row) : undefined;
}

/**
 * The installation's most recent installation-wide rollout whatever its status, or
 * `undefined` when none has ever run — the installation twin of
 * {@link findLatestRolloutForOwner}, and what
 * `workers.fleetUpdateStatusForInstallation` reads.
 */
export async function findLatestInstallationRollout(): Promise<WorkerUpdateRollout | undefined> {
	const rows = await getDb()
		.select()
		.from(workerUpdateRollouts)
		.where(eq(workerUpdateRollouts.scope, 'installation'))
		.orderBy(desc(workerUpdateRollouts.createdAt), desc(workerUpdateRollouts.id))
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

/**
 * The single installation-wide rollout an advance can still move, or `undefined` when
 * there is none (issue #1024) — the same predicate as the two reads above, narrowed to
 * `scope = 'installation'`.
 *
 * A lookup rather than a list, unlike the owner read beside it: the live one is unique
 * by index, and a halted installation-wide rollout still owing its members an answer
 * is the rare second row, so the newest is taken and any older one is left to the
 * tick — which is already scope-blind and sweeps every advanceable rollout.
 *
 * It exists because the per-machine triggers resolve rollouts through the machine's
 * **owner**, and an installation-wide rollout names machines whose owner never started
 * anything, so the owner lookup can never find it.
 */
export async function findAdvanceableInstallationRollout(): Promise<
	WorkerUpdateRollout | undefined
> {
	const rows = await getDb()
		.select()
		.from(workerUpdateRollouts)
		.where(and(eq(workerUpdateRollouts.scope, 'installation'), advanceableRollout()))
		.orderBy(desc(workerUpdateRollouts.createdAt), desc(workerUpdateRollouts.id))
		.limit(1);
	const row = rows[0];
	return row ? rowToRollout(row) : undefined;
}

/**
 * Another rollout's live claim on one machine — see {@link findRolloutHoldElsewhere}.
 */
export interface RolloutHold {
	/** Whether that other rollout is the one that took the machine out of the pool. */
	drainedByRollout: boolean;
}

/**
 * Whether a rollout *other than* `excludeRolloutId` has committed to this machine and
 * not yet settled it — and if so, whether that rollout is the one holding its drain.
 *
 * Only exists because a halted rollout is advanceable again since issue #1023: the
 * operator's next rollout is created while the halted one is still settling the
 * members it had committed to, and the two then overlap on the same machines — the
 * very thing the partial unique index prevents between two *live* rollouts. Without
 * this read the halted rollout's member settles `skipped` (its machine's request id
 * has moved on to the newer rollout's) and puts the machine straight back in the
 * dispatch pool while the newer rollout has it mid-update.
 *
 * `queued` members are not holds: the rollout has not reached them, nothing was
 * drained for them, and nothing is owed on them — the same line `takeNextWave` draws
 * between "in flight" and "not reached yet". Settled members are not holds either,
 * which is what makes the answer drop back to `undefined` by itself as the older
 * rollout finishes.
 *
 * Answers with the **strongest** hold when there are several: if any of them took the
 * machine out of the pool, the drain is a rollout's to hand on rather than the
 * operator's to keep. Served by `idx_worker_update_rollout_members_worker`.
 */
export async function findRolloutHoldElsewhere(
	workerId: string,
	excludeRolloutId: string,
): Promise<RolloutHold | undefined> {
	const rows = await getDb()
		.select({ drainedByRollout: workerUpdateRolloutMembers.drainedByRollout })
		.from(workerUpdateRolloutMembers)
		.where(
			and(
				eq(workerUpdateRolloutMembers.workerId, workerId),
				ne(workerUpdateRolloutMembers.rolloutId, excludeRolloutId),
				inArray(workerUpdateRolloutMembers.state, [
					...COMMITTED_WORKER_UPDATE_ROLLOUT_MEMBER_STATES,
				]),
			),
		)
		.orderBy(desc(workerUpdateRolloutMembers.drainedByRollout))
		.limit(1);
	const row = rows[0];
	return row ? { drainedByRollout: row.drainedByRollout } : undefined;
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
