import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

/**
 * One sighting of a check failing on an approved pull-request head whose red
 * SWARM's own CI agent adjudicated `no-fix` (issue #1464) — written each time the
 * approved-head re-run policy (`src/dispatch/approved-head-checks-rerun.ts`) is
 * applied to such a head, which is the durable meaning of "adjudicated on an
 * approved head". `src/dispatch/shared-check-failure.ts` reads these to tell one
 * pull request failing on its own from the same check failing on several.
 *
 * One row per `(project, repository, check, pull request, head)`: a repeat sighting
 * of the same head refreshes `observed_at` rather than adding a row, so the 24 h
 * detection window measures the latest sighting. `repository` denormalizes the
 * project's repo on `review_verdicts`' precedent.
 */
export const sharedCheckFailureObservations = pgTable(
	'shared_check_failure_observations',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		repository: text('repository').notNull(),
		checkName: text('check_name').notNull(),
		prNumber: text('pr_number').notNull(),
		headSha: text('head_sha').notNull(),
		observedAt: timestamp('observed_at').defaultNow().notNull(),
	},
	(table) => [
		uniqueIndex('uq_shared_check_failure_observations_head').on(
			table.projectId,
			table.repository,
			table.checkName,
			table.prNumber,
			table.headSha,
		),
		index('idx_shared_check_failure_observations_check').on(
			table.projectId,
			table.repository,
			table.checkName,
			table.observedAt,
		),
	],
);

/**
 * One shared check failure (issue #1464): the same check, adjudicated `no-fix`,
 * failing on two or more open approved pull-request heads of one repository. It
 * is reported once — `reported_at` is the once-only claim — and while it
 * **stands** (unresolved and younger than `SHARED_CHECK_EPISODE_MAX_AGE_MS`) the
 * approved-head re-run policy stops re-running, notifying and attempting the heads
 * it covers.
 *
 * The partial unique index keeps at most one unresolved episode per
 * `(project, repository, check)`; an unresolved one past its age is stamped
 * `resolution = 'expired'` before a successor opens. `resolution` is `text`, not
 * an enum, on `bug_reports.status`' precedent — phase 2 adds `base-advanced`.
 */
export const sharedCheckFailureEpisodes = pgTable(
	'shared_check_failure_episodes',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		repository: text('repository').notNull(),
		checkName: text('check_name').notNull(),
		openedAt: timestamp('opened_at').defaultNow().notNull(),
		/** When the once-only report was claimed; `null` until a caller wins it. */
		reportedAt: timestamp('reported_at'),
		resolvedAt: timestamp('resolved_at'),
		/** Why it was resolved — `expired` today. */
		resolution: text('resolution'),
	},
	(table) => [
		uniqueIndex('uq_shared_check_failure_episodes_standing')
			.on(table.projectId, table.repository, table.checkName)
			.where(sql`${table.resolvedAt} IS NULL`),
	],
);
