import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The audit trail of the operator MCP server's **write tools** (issue #1346) — one
 * row per call of a tool that can change the pipeline (`src/mcp/write-tool.ts`),
 * whether it was a dry run or a real one, and whether it succeeded, was refused or
 * failed.
 *
 * The row is inserted *before* the tool does anything (`outcome = 'pending'`) and
 * settled afterwards, so a write that could not be audited is never performed and a
 * process that dies mid-call still leaves a row saying the call was made.
 *
 * **No foreign keys, deliberately.** An audit record must outlive both the account
 * that acted and the project it acted on, and a `set null` on either would erase
 * exactly the fact the row exists to keep. `user_id` is the acting account's id and
 * `user_identifier` its sign-in identifier at the time, so a deleted account still
 * reads. `project_id` is `null` only when the call was refused before its target
 * resolved to a project (an unknown run, say) — the `target` still names what was
 * asked for.
 *
 * `tool` and `outcome` are `text` rather than pg enums, as `stalled_dismissals.unit`
 * is: a new write tool must not need a migration.
 */
export const operatorActions = pgTable(
	'operator_actions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id').notNull(),
		userIdentifier: text('user_identifier').notNull(),
		/** The MCP tool name, e.g. `run_reset`. */
		tool: text('tool').notNull(),
		projectId: text('project_id'),
		/** What the call acted on, e.g. the run id. */
		target: text('target').notNull(),
		/** The operator's stated reason — mandatory on every write tool. */
		reason: text('reason').notNull(),
		dryRun: boolean('dry_run').notNull(),
		/** The tool's arguments, verbatim. */
		input: jsonb('input').notNull(),
		/** `pending` until settled, then `succeeded`, `refused` or `failed`. */
		outcome: text('outcome').notNull(),
		/** The refusal or failure text, as the tool reported it; `null` on success. */
		error: text('error'),
		startedAt: timestamp('started_at').defaultNow().notNull(),
		completedAt: timestamp('completed_at'),
	},
	(table) => [
		index('idx_operator_actions_project_started').on(table.projectId, table.startedAt),
		index('idx_operator_actions_user_started').on(table.userId, table.startedAt),
	],
);
