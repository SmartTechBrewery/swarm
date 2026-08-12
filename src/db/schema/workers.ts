import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { AgentCli } from '../../harness/agent-cli.js';
import { ALL_TRIGGER_PHASES, type TriggerPhase } from '../../triggers/types.js';
import { users } from './users.js';

/**
 * One row per registered **worker** — the persisted form of `Worker`
 * (`src/identity/worker.ts`), which stays the source of truth for the shape
 * (ai/CODING_STANDARDS.md "Zod is the source of truth"). The third slice of the
 * multi-user foundation (ADR-001): where `users` models a person and
 * `project_members` a person's role on a project, this models a locally operated
 * execution environment a user owns.
 *
 * `owner_user_id` is a `users.id` (`uuid`); the FK is `ON DELETE CASCADE`, so a
 * worker vanishes with its owner and never dangles. `capabilities` is the
 * declared set of agent CLIs, persisted as `jsonb` of `AgentCli[]` (the Zod
 * `WorkerCapabilitiesSchema` is the source of truth for the values), matching how
 * `runs.usage` persists a typed jsonb value.
 *
 * `credential_hash` is a SHA-256 of the worker credential — **never** the raw
 * token. It is deliberately **not** part of the `Worker` domain read model
 * (`rowToWorker` drops it) and never leaves the DB layer, the same treatment
 * `user_sessions.token_hash` / `users.password_hash` get. It is unique so a
 * credential resolves to at most one worker (the authentication seam).
 *
 * Worker sessions, enrollment, and the eligibility gate consume this identity
 * when selecting and claiming an execution host.
 */
export const workers = pgTable(
	'workers',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerUserId: uuid('owner_user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		displayName: text('display_name').notNull(),
		/** One of `AgentCliSchema` per element (source of truth in `worker.ts`). */
		capabilities: jsonb('capabilities').$type<AgentCli[]>().notNull(),
		/**
		 * The pipeline phases this worker's daemon declared it can execute (issue
		 * #467) — the second capability axis alongside `capabilities`, since a
		 * daemon's repertoire is otherwise indistinguishable to the dispatcher from
		 * any other's. It is not a distinction between daemon *kinds*: since issue
		 * #536 the DB-free remote daemon declares every phase, `planning` included,
		 * so a narrower set means an older build. One `TriggerPhase` per element.
		 *
		 * `NOT NULL` with an every-phase default so the eligibility gate never has a
		 * null case to interpret: a worker registered before it ever connects, a row
		 * that predates this column, and a daemon too old to declare the field all
		 * read as "every phase" — exactly the behaviour that pre-dated the column.
		 */
		supportedPhases: jsonb('supported_phases')
			.$type<TriggerPhase[]>()
			.notNull()
			.default(ALL_TRIGGER_PHASES as TriggerPhase[]),
		/**
		 * The `owner/repo` the daemon **currently operating this row** declared its one
		 * local checkout to be (issue #687), resolved from that checkout's `origin`
		 * remote at handshake. The control plane learns it no other way:
		 * `SWARM_WORKER_REPO_ROOT` is host-local and never travels.
		 *
		 * Nullable with no default, and that is the point: NULL means "no repository
		 * declared", which is what every row written before this column existed says and
		 * what a daemon too old to send the field keeps saying — nothing to backfill, and
		 * no default that would be honest. The stored form is the normalised, host-less,
		 * `.git`-less one (`RepoSlugSchema`, `src/scm/repo-slug.ts`), so a comparison
		 * against `projects.repo` must normalise that side too.
		 */
		repository: text('repository'),
		/** SHA-256 of the worker credential — never the raw token; dropped by `rowToWorker`. */
		credentialHash: text('credential_hash').notNull().unique(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		// A user may operate several workers, but each machine name is unique per
		// owner so rosters stay unambiguous; a re-register under the same name is a
		// conflict (pick a new name, or rotate via remove+register).
		uniqueIndex('idx_workers_owner_display_name').on(table.ownerUserId, table.displayName),
		// The owner-scoped listing (`listWorkersForOwner`).
		index('idx_workers_owner').on(table.ownerUserId),
	],
);
