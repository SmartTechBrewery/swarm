import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { workers } from './workers.js';

/**
 * One machine's **live cool-down** on one agent CLI (issue #981), keyed
 * `(worker_id, cli)` like {@link cliQuotas} and cascading from `workers` for the
 * same reason: a deregistered machine's cool-downs vanish with it.
 *
 * A row is written from the one control-plane settle that observes a `rate-limit`
 * deferral with both the selected worker and the CLI it ran on in hand
 * (`pushAndAwaitResult`, `src/router/dispatcher.ts`), and it is read by the
 * federated eligibility gate, which refuses that pair until the limit is expected
 * back. It records a **fact a real run produced** — the machine's own CLI said its
 * allowance was spent — which is precisely what makes it safe to route on.
 *
 * **Not `cli_quotas`.** The two differ in provenance and in lifecycle: `cli_quotas`
 * is a probe-derived *display* snapshot refreshed on a schedule, and
 * `src/worker/target-selection.ts` warns explicitly against routing on those rows.
 * Mixing an observed refusal into a display snapshot would give one table two
 * owners and two meanings. **Not `workers.drainingSince`** either: that is
 * machine-wide and operator-owned, whereas a spent allowance is per CLI and
 * reverses by itself.
 *
 * **An expiry instant rather than a boolean.** A boolean needs somebody to clear
 * it, and whoever that is can fail to — which turns a five-hour usage window into a
 * permanently wedged machine. An instant releases itself by construction: the read
 * filters on `expires_at`, so a lapsed row is already invisible, needs no sweeper,
 * and is simply overwritten by the next observation. The value stored is
 * `retryDelayForFailure`'s own answer for the failure that produced it: the reset
 * the CLI reported, honoured out to that policy's `MAX_RETRY_DELAY_MS` — the
 * longest wait a deferred wake-up survives the job-freshness gate for, ~24 h by
 * default — so no mis-parsed reset can hold a machine back indefinitely.
 *
 * Nothing is backfilled: an installation that has not migrated, or one no worker
 * has reported a limit on, behaves exactly as it did before this table existed.
 */
export const workerCliRateLimits = pgTable(
	'worker_cli_rate_limits',
	{
		/** The worker whose machine reported the limit. */
		workerId: uuid('worker_id')
			.notNull()
			.references(() => workers.id, { onDelete: 'cascade' }),
		/** The agent CLI identifier: 'claude', 'antigravity', or 'codex'. */
		cli: text('cli').notNull(),
		/** When the limit is expected back — the record releases itself at this instant. */
		expiresAt: timestamp('expires_at').notNull(),
		/** When the deferral that recorded it was observed. */
		observedAt: timestamp('observed_at').notNull().defaultNow(),
		/** The CLI's verbatim reset text, for an operator — never parsed back. */
		resetHint: text('reset_hint'),
		updatedAt: timestamp('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [primaryKey({ columns: [table.workerId, table.cli] })],
);
