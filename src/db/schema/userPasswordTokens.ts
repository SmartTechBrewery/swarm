import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * One row per live **password link** (issue #1151) — the single-use link an
 * installation admin issues from the `users` router so a user can set their
 * password (a new user's first one, or a reset) without anyone holding a shell.
 *
 * **No secret is stored here**, for the same reason as `user_sessions`:
 * `token_hash` is a SHA-256 of the opaque 256-bit token, and the raw token
 * appears exactly once, in the issuing admin's mutation response. A row is
 * deleted the moment it is redeemed (that delete *is* the single-use claim), and
 * issuing a new link for a user deletes their earlier one, so a user has at most
 * one live link. `expires_at` is an absolute cutoff checked at redemption;
 * `cascade` on the FK drops a deleted user's link.
 */
export const userPasswordTokens = pgTable(
	'user_password_tokens',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		userId: uuid('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		/** SHA-256 of the opaque link token — never the raw token itself. */
		tokenHash: text('token_hash').notNull().unique(),
		/** Absolute expiry; a link redeemed after this instant is refused. */
		expiresAt: timestamp('expires_at').notNull(),
		createdAt: timestamp('created_at').notNull().defaultNow(),
	},
	// Redemption looks a row up by hash (the unique constraint indexes it); this
	// index serves the replace-this-user's-link delete.
	(table) => [index('idx_user_password_tokens_user_id').on(table.userId)],
);
