import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { runs } from './runs.js';
import { users } from './users.js';

/**
 * One row per **agent access token** (issue #1362) — the credential an
 * installation administrator issues from the profile's MCP tab so an MCP client
 * can reach `/operator/mcp` (`src/identity/agent-access-token.ts`).
 *
 * **No secret is stored here**, for the same reason as `user_sessions`:
 * `token_hash` is the SHA-256 of the opaque 256-bit token, and the raw value
 * appears exactly once, in the issuing response.
 *
 * `expires_at` is **absolute and never slid** by use — unlike a session's, this
 * is a machine credential that is to die by itself even while in use.
 * `last_used_at` is when a live token last opened the MCP endpoint, `NULL` until
 * the first use and written at most once a minute per token; bookkeeping for the
 * list, never read to decide access. `cascade` on the FK drops a deleted user's
 * tokens with their sessions.
 *
 * A table of its own rather than a kind of `user_sessions` row: the two differ in
 * expiry, transport and reader, so a shared table would make every session query
 * filter the other credential out.
 */
export const agentAccessTokens = pgTable(
	'agent_access_tokens',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** What the holder recognises the token by on their list. */
		name: text('name').notNull(),
		/** SHA-256 of the opaque token — never the raw token itself. */
		tokenHash: text('token_hash').notNull().unique(),
		/** Absolute expiry; a token resolving after this instant is rejected. */
		expiresAt: timestamp('expires_at').notNull(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		/** The last time a live token opened `/operator/mcp`, throttled to a minute. */
		lastUsedAt: timestamp('last_used_at'),
		/**
		 * The projects a **scoped agent credential** is limited to (issue #1385): a
		 * request made with it reaches these projects alone, and only the read tools
		 * plus the recovery allowlist (`SCOPED_AGENT_RECOVERY_TOOLS`). `NULL` is an
		 * ordinary token acting with its holder's full access; never an empty array.
		 */
		projectIds: text('project_ids').array(),
		/**
		 * The run a **run-bound** scoped agent credential belongs to (issue #1393): the
		 * control plane mints one for a single run with a lifetime it chooses, and
		 * revokes it when the run settles. `NULL` for every token a holder issues. A
		 * run-bound token is a system credential, so it never appears on the holder's
		 * list; `cascade` drops it with its run.
		 */
		runId: uuid('run_id').references(() => runs.id, { onDelete: 'cascade' }),
		/**
		 * How many real (not dry-run) write-tool calls a run-bound token may make
		 * (issue #1393), enforced by the write-tool framework (`src/mcp/write-tool.ts`).
		 * `NULL` when `run_id` is.
		 */
		maxWriteActions: integer('max_write_actions'),
	},
	// Resolving looks a row up by hash (the unique constraint indexes it); these
	// indexes serve the holder's own list, the revoke and the two cascades.
	(table) => [
		index('idx_agent_access_tokens_user_id').on(table.userId),
		index('idx_agent_access_tokens_run_id').on(table.runId),
	],
);
