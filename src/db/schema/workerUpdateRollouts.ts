import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core';
import { DEFAULT_ROLLOUT_WAVE_SIZE } from '../../identity/worker-update-rollout.js';
import { users } from './users.js';
import { workers } from './workers.js';

/**
 * One row per **staged fleet update** — the persisted form of
 * `WorkerUpdateRollout` (`src/identity/worker-update-rollout.ts`, which stays the
 * source of truth for the shape and for both state vocabularies). Issue #940's
 * durable record: where issue #933's six `workers.update_*` columns hold one
 * machine's request and answer, this holds the *operator action* across a fleet —
 * which machines are being moved, in what order, and whether the action is still
 * moving at all.
 *
 * `requested_by_user_id` is a `users.id` (`uuid`); the FK is `ON DELETE CASCADE`,
 * so a rollout vanishes with the operator who asked for it and never dangles —
 * their machines cascade away with them too, so a surviving rollout would name
 * nothing.
 *
 * **At most one `in_progress` rollout per owner**, enforced by the partial unique
 * index below rather than by a read-then-insert in the service. Two overlapping
 * rollouts over the same machines would drain and undrain each other's members,
 * and the check has to be one statement with the insert or a second `swarm workers
 * update --all` landing at the same instant slips between them. `halted` and
 * `completed` rows are exempt and accumulate as history, which is what makes
 * "start a new rollout" the documented way past a halted one.
 *
 * `status` and both member vocabularies are stored as free `text` with the Zod
 * enums as the source of truth, the treatment `worker_project_enrollments.status`
 * already gets.
 */
export const workerUpdateRollouts = pgTable(
	'worker_update_rollouts',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		requestedByUserId: uuid('requested_by_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** The build every member is being moved to — one of `WorkerUpdateTargetSchema` (`src/lib/build-identity.ts`). */
		target: text('target').notNull(),
		/**
		 * How many machines one advance may take out of the pool. Stated on the row
		 * rather than read from the constant at advance time, so a rollout keeps the
		 * bound it was started with even if the default moves under it — and so the
		 * status readout can say what bound is actually in force.
		 */
		waveSize: integer('wave_size').notNull().default(DEFAULT_ROLLOUT_WAVE_SIZE),
		/** One of `WorkerUpdateRolloutStatusSchema` — `in_progress` | `halted` | `completed`. */
		status: text('status').notNull().default('in_progress'),
		/**
		 * Why the rollout stopped, in the machine's own words where it had any. Null at
		 * every status but `halted`, and written in the same statement that sets it, so
		 * a halted rollout never reads as stopped for no reason.
		 */
		haltReason: text('halt_reason'),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		// One live rollout per operator — see the table doc-comment. Partial, so the
		// halted/completed history is unconstrained.
		uniqueIndex('idx_worker_update_rollouts_owner_live')
			.on(table.requestedByUserId)
			.where(sql`${table.status} = 'in_progress'`),
		// The owner-scoped read (`swarm workers update --status`), newest first.
		index('idx_worker_update_rollouts_owner').on(table.requestedByUserId, table.createdAt),
	],
);

/**
 * One machine's place in a rollout — the persisted form of
 * `WorkerUpdateRolloutMember` (`src/identity/worker-update-rollout.ts`, the source
 * of truth for the shape and for what each `state` means).
 *
 * The primary key is `(rollout_id, worker_id)`: a machine appears at most once in
 * a rollout, and the rollout is always the thing a member is read through, so
 * there is no separate surrogate id to keep in step. Both FKs are `ON DELETE
 * CASCADE` — a retired machine leaves the rollout it was named in rather than
 * leaving a member row pointing at nothing, and the rollout simply finishes with
 * the machines it still has.
 *
 * `position` is the order the rollout reaches its machines in, taken from
 * `listWorkersForOwner` at start so it matches what `swarm workers list` prints.
 * The three "…_at_signal" facts (`fencing_token_at_signal`,
 * `build_commit_at_signal`) and `drained_by_rollout` are all there so a decision
 * made *later* can be made against what was true when the machine was signalled —
 * see the domain module for each one's reasoning.
 */
export const workerUpdateRolloutMembers = pgTable(
	'worker_update_rollout_members',
	{
		rolloutId: uuid('rollout_id')
			.notNull()
			.references(() => workerUpdateRollouts.id, { onDelete: 'cascade' }),
		workerId: uuid('worker_id')
			.notNull()
			.references(() => workers.id, { onDelete: 'cascade' }),
		/** This machine's rank in the rollout's own order; waves are taken in it, ascending. */
		position: integer('position').notNull(),
		/** One of `WorkerUpdateRolloutMemberStateSchema` — see the domain module. */
		state: text('state').notNull().default('queued'),
		/**
		 * The per-machine request id the fan-out minted for this member, kept so a
		 * report can be told from a stale one exactly as the `workers` row tells them
		 * apart. Null until the member is signalled.
		 */
		requestId: uuid('request_id'),
		/** The outcome the machine reported (one of `WorkerUpdateStatusSchema`), verbatim. */
		outcome: text('outcome'),
		/** The machine's own prose beside that outcome, verbatim — the halt reason is quoted from it. */
		message: text('message'),
		/**
		 * Whether **this rollout** took the machine out of the pool. Only a machine it
		 * drained itself is returned to the pool when the rollout is done with it; one
		 * the operator had drained for their own reasons is left exactly as they left it.
		 */
		drainedByRollout: boolean('drained_by_rollout').notNull().default(false),
		/**
		 * `worker_sessions.fencing_token` as it stood at signal time — per-worker
		 * monotonic and bumped on every re-acquire, so a larger one afterwards is the
		 * exact "a new daemon process took the lease" signal. `bigint` in mode `number`,
		 * matching the column it is copied from. Null when the machine had no live
		 * session to read one from.
		 */
		fencingTokenAtSignal: bigint('fencing_token_at_signal', { mode: 'number' }),
		/**
		 * The commit the machine's install root declared at signal time (issue #918). A
		 * machine that returned *itself* to its last known good build (issue #934) comes
		 * back with a bumped token too, so this is what tells "came back" from "came back
		 * on the new build". Null when the machine declared no build.
		 */
		buildCommitAtSignal: text('build_commit_at_signal'),
		signalledAt: timestamp('signalled_at'),
		settledAt: timestamp('settled_at'),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		primaryKey({ columns: [table.rolloutId, table.workerId] }),
		// Every read is "this rollout's members, in order".
		index('idx_worker_update_rollout_members_order').on(table.rolloutId, table.position),
		// …every read but one (issue #1023): "does another rollout still hold this
		// machine", asked when a member is taken into a wave and when one settles, so
		// two rollouts over the same machine hand the drain over rather than undraining
		// it out from under each other. The primary key leads with `rollout_id` and so
		// cannot serve a `worker_id` search, which would otherwise be a scan growing
		// with the whole rollout history. The per-event trigger path deliberately does
		// *not* use this — it still resolves rollouts through the machine's owner.
		index('idx_worker_update_rollout_members_worker').on(table.workerId),
	],
);
