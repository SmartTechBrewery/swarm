import {
	type AnyPgColumn,
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core';

/**
 * SWARM's own **bug reports** (issue #1383) — a defect in SWARM, or in what it runs
 * on, that an agent or a person observed. Statuses and their rules live in
 * `src/api/bug-reports.ts`; the procedures in `src/api/routers/bugReports.ts`.
 *
 * `status` is `text` rather than a pg enum, as `operator_actions.outcome` is: Zod
 * validates it, and a new status must not need a migration.
 *
 * **No foreign key on `project_id`**, as on `operator_actions`: a report must outlive
 * the project it was observed in. `null` means installation-wide, which only an
 * instance administrator reads. `filed_by_user_id` has none either, for the same
 * reason the audit row's `user_id` has none; `filed_by_user_identifier` keeps the
 * sign-in identifier at the time, so a deleted account still reads.
 *
 * `occurrence_count`, `first_seen_at` and `last_seen_at` are denormalized from
 * `bug_report_occurrences`, updated in the same transaction as each occurrence
 * insert. Creating a report always inserts its first occurrence, so the count always
 * equals the occurrence rows.
 */
export const bugReports = pgTable(
	'bug_reports',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		title: text('title').notNull(),
		description: text('description').notNull(),
		status: text('status').notNull().default('new'),
		projectId: text('project_id'),
		/** The report this one duplicates; set only while `status = 'duplicate'`. */
		duplicateOfId: uuid('duplicate_of_id').references((): AnyPgColumn => bugReports.id, {
			onDelete: 'set null',
		}),
		/** The issue the report became; set by `ticketed` and kept afterwards. */
		githubIssueUrl: text('github_issue_url'),
		filedByUserId: uuid('filed_by_user_id').notNull(),
		filedByUserIdentifier: text('filed_by_user_identifier').notNull(),
		/** The agent run that filed it, when an agent did. */
		filedByRunId: text('filed_by_run_id'),
		occurrenceCount: integer('occurrence_count').notNull().default(1),
		firstSeenAt: timestamp('first_seen_at').notNull(),
		lastSeenAt: timestamp('last_seen_at').notNull(),
		statusChangedAt: timestamp('status_changed_at'),
		createdAt: timestamp('created_at').defaultNow().notNull(),
		updatedAt: timestamp('updated_at').defaultNow().notNull(),
	},
	(table) => [
		index('idx_bug_reports_status_last_seen').on(table.status, table.lastSeenAt),
		index('idx_bug_reports_project_last_seen').on(table.projectId, table.lastSeenAt),
	],
);

/**
 * One observation of a {@link bugReports} report: the context it was seen in (each
 * field optional) and who recorded it. Deleted with its report.
 */
export const bugReportOccurrences = pgTable(
	'bug_report_occurrences',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		reportId: uuid('report_id')
			.notNull()
			.references(() => bugReports.id, { onDelete: 'cascade' }),
		runId: text('run_id'),
		dispatchId: text('dispatch_id'),
		taskId: text('task_id'),
		repository: text('repository'),
		prNumber: integer('pr_number'),
		/** What this occurrence looked like. */
		note: text('note'),
		filedByUserId: uuid('filed_by_user_id').notNull(),
		filedByUserIdentifier: text('filed_by_user_identifier').notNull(),
		filedByRunId: text('filed_by_run_id'),
		observedAt: timestamp('observed_at').defaultNow().notNull(),
	},
	(table) => [
		index('idx_bug_report_occurrences_report_observed').on(table.reportId, table.observedAt),
	],
);
