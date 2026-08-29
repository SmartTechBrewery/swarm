import { jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { CliQuotaSnapshot } from '../../harness/quota.js';
import { workers } from './workers.js';

/**
 * Persisted capability and quota snapshot per **(worker, CLI)** pair (issue #164,
 * keyed on the machine by issue #703, on the *worker* by issue #823).
 *
 * A row records a **machine-local** fact — which agent CLIs are installed on one
 * machine and what allowance is left on them — so the machine is part of the key
 * rather than an attribute. Keyed on `cli` alone, an installation had exactly
 * three rows and every writer overwrote the same ones, so the last discovery to
 * run presented its own machine's allowance as the installation's (issue #703).
 *
 * The machine is now named by `worker_id` rather than by a hostname string, and
 * that is what makes a row **attributable**: a worker has an owner, so "whose
 * allowance is this?" has an answer the control plane can authenticate, and the
 * quota read can be scoped to the viewer (`listCliQuotasForOwner`). A hostname
 * named no user at all — any process could claim any string — which is why every
 * signed-in user was shown the same rows, describing whichever machine ran the
 * discovering process.
 *
 * `ON DELETE CASCADE` mirrors `worker_scm_credentials`: a deregistered worker's
 * snapshots vanish with it rather than dangling.
 */
export const cliQuotas = pgTable(
	'cli_quotas',
	{
		/** The worker whose machine the snapshot describes. */
		workerId: uuid('worker_id')
			.notNull()
			.references(() => workers.id, { onDelete: 'cascade' }),
		/** The agent CLI identifier: 'claude', 'antigravity', or 'codex' */
		cli: text('cli').notNull(),
		/** The overall availability status: 'available', 'unavailable', or 'error' */
		status: text('status').notNull(),
		/** The detailed provider-neutral quota snapshot JSON blob */
		snapshot: jsonb('snapshot').$type<CliQuotaSnapshot>().notNull(),
		createdAt: timestamp('created_at').defaultNow(),
		updatedAt: timestamp('updated_at')
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [primaryKey({ columns: [table.workerId, table.cli] })],
);
