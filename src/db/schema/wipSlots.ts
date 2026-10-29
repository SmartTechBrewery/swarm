import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { dispatches } from './dispatches.js';
import { projects } from './projects.js';

/**
 * One **ticket in flight** in one repository (issue #1185) — the durable record the
 * per-repository WIP limit (`repositories[].wipLimit`, `src/config/schema.ts`) counts.
 *
 * It needs a table of its own because "in flight" must be SWARM's own state rather
 * than a count of board columns: an operator shuffling a card between the pipeline
 * columns changes nothing here, and no provider's column vocabulary is read to
 * decide it (ai/RULES.md §2). A row is taken atomically when a ticket's first
 * board-driven phase is admitted (`reserveWipSlot`,
 * `src/db/repositories/wipSlotsRepository.ts`) and **deleted** on release — the pull
 * request closing or merging, the card reaching Done or Backlog, a dashboard Put
 * back. Deleting rather than flagging keeps the per-repository count a plain index
 * scan with no state filter; the ticket's history stays in `runs`.
 *
 * **Keyed on the ticket, `(project_id, repository, task_id)`.** `repository` is the
 * scoped `project.repo` the job ran against and `task_id` the SCM-derived task id
 * Planning and Implementation share (ai/ARCHITECTURE.md "Task identity"), which is
 * also what a pull request's branch name maps back to. The unique index is the
 * reservation's conflict target, and its leading `(project_id, repository)` columns
 * serve the per-repository count.
 *
 * `work_item_*` are a snapshot of the card the ticket started from, nullable since a
 * trigger may carry none; they let later readers name a holder without a board read.
 * `opened_dispatch_id` → `dispatches.id` `on delete set null`, mirroring
 * `review_verdicts.dispatch_id`: the slot must outlive the dispatch that opened it.
 *
 * `pr_number` is the ticket's pull request, written once a pull request-driven phase
 * for the ticket's branch resolves (`recordTicketPullRequest`,
 * `src/dispatch/wip-limit.ts`, issue #1192). Nullable — a ticket still in Planning or
 * Implementation has none — and read only by the dashboard's WIP read model
 * (`src/queue/wip-usage.ts`), which folds the pull request's own liveness onto the
 * holder. Admission and release never consult it.
 */
export const wipSlots = pgTable(
	'wip_slots',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		repository: text('repository').notNull(),
		taskId: text('task_id').notNull(),
		workItemId: text('work_item_id'),
		workItemTitle: text('work_item_title'),
		workItemUrl: text('work_item_url'),
		/** The phase whose admission opened the slot — `planning` or `implementation`. */
		openedPhase: text('opened_phase').notNull(),
		openedDispatchId: uuid('opened_dispatch_id').references(() => dispatches.id, {
			onDelete: 'set null',
		}),
		openedAt: timestamp('opened_at').defaultNow().notNull(),
		prNumber: text('pr_number'),
	},
	(table) => [
		uniqueIndex('uq_wip_slots_ticket').on(table.projectId, table.repository, table.taskId),
	],
);
