import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { users } from './users.js';

/**
 * One operator's dismissal of one **liveness unit** from the Stalled view (issue
 * #880) — the durable record that lets a finished-but-unrecorded unit be forced
 * out of the report before it ages out of `ITEM_ACTIVITY_LOOKBACK_MS`.
 *
 * It needs a table of its own precisely because *"stalled" is a computed view and
 * never a persisted status* (`src/dispatch/item-liveness.ts`): there is no column
 * on the unit to write, and inventing one would turn the read model into a state
 * machine. Nothing here references `runs` — dismissing never modifies or deletes a
 * `runs` row because it never touches that table at all.
 *
 * **Keyed on the unit, not on a run id.** A unit folds up to four `task_id`s (the
 * four SCM-driven phases of one pull request mint one each), and the row the
 * operator sees *is* the unit — so `(project_id, repository, unit, reference)` is
 * the identity, exactly as `foldLivenessUnits` computes it.
 *
 * **`last_activity_at` is what makes "re-report if it moves again" a comparison
 * rather than a background job.** It stores the unit's own `lastActivityAt` at the
 * instant the operator dismissed it; the classifier suppresses the unit only while
 * its activity has not advanced past that instant, so a unit that genuinely moves
 * again is reported normally with nothing to un-set and no sweep to run.
 *
 * `unit` and `reference` are `text` rather than pg enums for the same reason
 * `projects.scm_type` and `instance_scm_credentials.role` are: `ItemLivenessUnitKindSchema`
 * (`src/dispatch/item-liveness.ts`) is the value list's source of truth, and a third
 * unit kind must not need a migration. The unique index on the four key columns is
 * the upsert target, which makes dismiss → move → re-stall → dismiss again a
 * rotation of one row rather than a second one; its leading `project_id` also
 * serves the project-scoped list read.
 *
 * `dismissed_by` → `users.id` `on delete set null`, mirroring
 * `review_verdicts.dispatch_id` → `dispatches.id`: the record must outlive the
 * account that made it.
 */
export const stalledDismissals = pgTable(
	'stalled_dismissals',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		repository: text('repository').notNull(),
		/** One of `ItemLivenessUnitKindSchema` — `pull-request` or `work-item`. */
		unit: text('unit').notNull(),
		/** The PR number for a `pull-request` unit, the task id for a `work-item` one. */
		reference: text('reference').notNull(),
		/** The unit's own `lastActivityAt` at the instant it was dismissed. */
		lastActivityAt: timestamp('last_activity_at').notNull(),
		dismissedAt: timestamp('dismissed_at').defaultNow().notNull(),
		dismissedBy: uuid('dismissed_by').references(() => users.id, { onDelete: 'set null' }),
	},
	(table) => [
		uniqueIndex('uq_stalled_dismissals_unit').on(
			table.projectId,
			table.repository,
			table.unit,
			table.reference,
		),
	],
);
