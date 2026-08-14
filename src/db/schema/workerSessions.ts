import { bigint, boolean, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { runs } from './runs.js';
import { workers } from './workers.js';

/**
 * One row per **worker session lease** — the persisted form of `WorkerSession`
 * (`src/identity/worker-session.ts`), which stays the source of truth for the
 * shape (ai/CODING_STANDARDS.md "Zod is the source of truth"). Phase 2 of the
 * worker slice: at most one live claim on a registered worker, so two daemons
 * can never drive the same machine at once (ADR-001 "User / worker").
 *
 * `worker_id` is a `workers.id` (`uuid`); the FK is `ON DELETE CASCADE`, so a
 * session vanishes with its worker and never dangles. The **unique index** on
 * `worker_id` is the crux of the invariant: at most one row per worker exists at
 * a time — a second concurrent `acquireLease` for the same worker either loses
 * the row lock (existing row) or trips this constraint (racing insert), so
 * exactly one caller wins (`workerSessionsRepository.ts`). A re-acquire replaces
 * the same row in place rather than inserting a second.
 *
 * `fencing_token` is a per-worker monotonic counter bumped on every re-acquire
 * (`bigint`, mode number — a lease counter, not a hot-path id). `last_heartbeat_at`
 * is the instant expiry is measured from: a session is live only while its last
 * heartbeat is within the heartbeat TTL. `current_run_id` FKs `runs.id` `ON
 * DELETE SET NULL` — the run the session is executing, cleared (not cascaded to
 * the session) when that run row is removed, so losing a run never drops the lease.
 * `released` flags a gracefully released session row retained to preserve fencing-token
 * monotonicity across releases.
 */
export const workerSessions = pgTable(
	'worker_sessions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		workerId: uuid('worker_id')
			.notNull()
			.references(() => workers.id, { onDelete: 'cascade' }),
		/** The current daemon process identity, null for daemons that predate issue #719. */
		instanceId: uuid('instance_id'),
		/** Per-worker monotonic fencing token; bumped on each re-acquire (`worker-session.ts`). */
		fencingToken: bigint('fencing_token', { mode: 'number' }).notNull(),
		lastHeartbeatAt: timestamp('last_heartbeat_at').notNull().defaultNow(),
		/** The run this session is executing, or null when idle; cleared (not cascaded) on run delete. */
		currentRunId: uuid('current_run_id').references(() => runs.id, { onDelete: 'set null' }),
		/** True when gracefully released; retained so the fencing counter stays monotonic across releases. */
		released: boolean('released').notNull().default(false),
		createdAt: timestamp('created_at').notNull().defaultNow(),
	},
	(table) => [
		// One live row per worker — the "one live session per registered worker"
		// invariant. A racing second insert trips this; a re-acquire updates the
		// existing row in place rather than adding a second.
		uniqueIndex('idx_worker_sessions_worker').on(table.workerId),
	],
);
