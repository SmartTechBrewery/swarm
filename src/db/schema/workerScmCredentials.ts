import { pgTable, serial, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { workers } from './workers.js';

/**
 * The worker **operator's own** SCM credential at rest, one row per
 * `(worker, scmProvider)` (issue #765) — the identity every commit, push, pull
 * request and implementer-side comment a phase makes is authored as
 * (`SCMProvider.operatorDeliveryProvider`, `src/scm/types.ts`).
 *
 * It is the worker's credential, never a project's: nothing here reintroduces the
 * retired project-scoped `credentials.implementer` persona (issue #396). Its
 * sibling table `project_credentials` holds the other half of the model — the
 * reviewer PAT and the PM credential, which stay per project and never reach a
 * worker at all.
 *
 * `value` is encrypted with AES-256-GCM before it reaches this table, using
 * `${workerId}:${scmProviderId}` as AAD (`src/db/crypto.ts`), so a ciphertext
 * copied onto another worker's row — or onto the same worker's row for a different
 * provider — fails authentication rather than resolving.
 *
 * `scm_provider_id` is `text` rather than a pg enum for the same reason
 * `projects.scm_type` is: `ScmProviderIdSchema` (`src/scm/events.ts`) is the source
 * of truth for the value list, and a fourth provider must not need a migration. The
 * unique index on `(worker_id, scm_provider_id)` is the upsert target, which is what
 * makes a rotation an update rather than a second row; `ON DELETE CASCADE` means a
 * deregistered worker's secrets vanish with it.
 */
export const workerScmCredentials = pgTable(
	'worker_scm_credentials',
	{
		id: serial('id').primaryKey(),
		workerId: uuid('worker_id')
			.notNull()
			.references(() => workers.id, { onDelete: 'cascade' }),
		/** One of `ScmProviderIdSchema` — the provider this credential authenticates against. */
		scmProviderId: text('scm_provider_id').notNull(),
		value: text('value').notNull(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		uniqueIndex('uq_worker_scm_credentials_worker_provider').on(
			table.workerId,
			table.scmProviderId,
		),
	],
);
