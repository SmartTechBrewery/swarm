import { pgTable, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * The installation's **default** SCM credential for one `(provider, role)` slot at
 * rest, one row per pair (issue #769) — the value an instance administrator records
 * once in General Settings → Credentials.
 *
 * A third storage tier beside its two siblings, and the differences are the point:
 * `project_credentials` resolves a *project's* credential reference into a secret and
 * `worker_scm_credentials` a *worker operator's own* identity, while this table holds
 * neither — it is the installation's default for a role every project would otherwise
 * be handed the same value for. **Nothing reads it at credential-resolution time**:
 * `resolveScmCredentialOrNull` (`src/config/provider.ts`) keeps its no-fallback-chain
 * rule, and this value is a creation-time seed for a *new* project (phase 2/2 of issue
 * #769), never a fallback for an existing one.
 *
 * SCM-only by name: a PM twin would be its own table, mirroring how `credentials.scm`
 * and `credentials.pm` are separate blocks rather than one map.
 *
 * No `project_id` and therefore no FK — the row outlives every project — and no `name`
 * column, since nothing reads `project_credentials.name` for an SCM reference either.
 * There is no reference indirection at this tier: an instance default has no project
 * and so no reference key to honour, only the `(provider, role)` slot it is the value
 * for.
 *
 * `provider_id` and `role` are `text` rather than pg enums for the same reason
 * `projects.scm_type` is: `ScmProviderIdSchema` (`src/scm/events.ts`) and
 * `SCM_CREDENTIAL_ROLES` (`src/scm/types.ts`) are the value lists' source of truth, and
 * a fourth provider must not need a migration. The unique index on
 * `(provider_id, role)` is the upsert target, which makes a rotation an update rather
 * than a second row.
 *
 * `value` is encrypted with AES-256-GCM before it reaches this table, using
 * `instance:scm:<providerId>:<role>` as AAD (`src/db/crypto.ts`,
 * `instanceScmCredentialAad`), so a ciphertext copied into another slot's row fails
 * authentication rather than resolving as that provider's secret.
 */
export const instanceScmCredentials = pgTable(
	'instance_scm_credentials',
	{
		id: serial('id').primaryKey(),
		/** One of `ScmProviderIdSchema` — the provider this default authenticates against. */
		providerId: text('provider_id').notNull(),
		/** One of `SCM_CREDENTIAL_ROLES`, and one the provider declares `instanceDefault` for. */
		role: text('role').notNull(),
		value: text('value').notNull(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		uniqueIndex('uq_instance_scm_credentials_provider_role').on(table.providerId, table.role),
	],
);
