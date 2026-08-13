import { jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import type { CliQuotaSnapshot } from '../../harness/quota.js';

/**
 * Persisted capability and quota snapshot per **(host, CLI)** pair (issue #164,
 * keyed on the host by issue #703).
 *
 * Stored in the DB so that the process running on the host (which has CLI
 * access) can populate/refresh it, and the dashboard API/UI can consume it
 * without probing the host.
 *
 * A row records a **host-local** fact — which agent CLIs are installed on one
 * machine and what allowance is left on them — so the host is part of the key
 * rather than an attribute. Keyed on `cli` alone, an installation had exactly
 * three rows and every writer overwrote the same ones, so the last discovery to
 * run presented its own machine's allowance as the installation's (issue #703).
 * `host` is the discovering process's `os.hostname()` — the same string a worker
 * daemon reports in its handshake (`src/transport/connect-entry.ts`), so a
 * future worker-reported snapshot keys on the same name.
 */
export const cliQuotas = pgTable(
	'cli_quotas',
	{
		/** The machine the snapshot describes: the discovering process's `os.hostname()`. */
		host: text('host').notNull(),
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
	(table) => [primaryKey({ columns: [table.host, table.cli] })],
);
