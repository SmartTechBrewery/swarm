import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { runs } from './runs.js';
import { workers } from './workers.js';

/**
 * A reset's request that one **specific machine** discard the checkout it still
 * holds for a run (issue #1402).
 *
 * Reset & restart abandons a preserved worker and lets the restart route anywhere
 * (`src/dispatch/run-reset.ts`). The `'discard'` intent riding the replacement
 * dispatch reaches only the worker that *runs* the restart, so when that is a
 * different machine the preserved checkout used to stay on the abandoned one
 * untouched while the reset reported `worktree: absent`. This row is how the
 * discard reaches the holder instead: the reset writes it, the router pushes a
 * `checkout-discard` frame to that worker now or when it next connects
 * (`src/router/checkout-discard-dispatch.ts`), and the worker's report settles it.
 *
 * A table rather than columns on `workers` because one machine can owe several —
 * one per reset run whose checkout it held.
 *
 * `worktree_root` is the project's relative root **as of the reset**, since that is
 * where the checkout was created; the machine resolves it against its own checkout
 * root for `repository`, so no host path ever travels.
 *
 * `outcome` is `null` while pending and then one of `CheckoutDiscardOutcomeSchema`
 * (`src/transport/protocol.ts`) — `text` rather than a pg enum, the same choice as
 * `stalled_dismissals.unit`, so a new outcome needs no migration.
 *
 * Cascades from both `workers` and `runs`: a deregistered machine owes nothing, and
 * a deleted run's checkout is no longer this record's business.
 */
export const checkoutDiscards = pgTable(
	'checkout_discards',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		workerId: uuid('worker_id')
			.notNull()
			.references(() => workers.id, { onDelete: 'cascade' }),
		runId: uuid('run_id')
			.notNull()
			.references(() => runs.id, { onDelete: 'cascade' }),
		projectId: text('project_id').notNull(),
		/** The run's own repository (`owner/repo`), which picks the machine's checkout root. */
		repository: text('repository').notNull(),
		taskId: text('task_id').notNull(),
		worktreeRoot: text('worktree_root').notNull(),
		requestedAt: timestamp('requested_at').defaultNow().notNull(),
		settledAt: timestamp('settled_at'),
		outcome: text('outcome'),
		/** The machine's own operator-facing words about the outcome. */
		detail: text('detail'),
	},
	(table) => [index('idx_checkout_discards_worker').on(table.workerId, table.settledAt)],
);
