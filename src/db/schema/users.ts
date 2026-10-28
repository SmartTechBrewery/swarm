import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * One row per authenticated **SWARM user** — the persisted form of `SwarmUser`
 * (`src/identity/schema.ts`), which stays the source of truth for the shape
 * (ai/CODING_STANDARDS.md "Zod is the source of truth"). The first slice of the
 * multi-user foundation (ADR-001, issue #281).
 *
 * A SWARM user is a person who signs in to this installation — not an SCM
 * identity and not an implementer/reviewer GitHub credential (those live in
 * `project_credentials`). The `id` is generated (`uuid`, `defaultRandom()`) like
 * `review_verdicts`, not externally supplied like a `projects` id.
 *
 * `identifier` is the stable, unique login handle (username/email);
 * `instance_admin` is the single installation-role flag — admin of every
 * project/membership/enrollment (see `InstallationRoleSchema`). It defaults to
 * `false`: an admin is designated explicitly via the operator CLI
 * (`swarm users add --admin` / `grant-admin`), the first-run setup link (issue
 * #1150, `src/identity/first-run-setup.ts`) or the admin-only `users` router
 * (issue #1151), never implicitly.
 *
 * `password_hash` is the credential material backing cookie session auth (#281
 * task 2): a `scrypt` salt+hash (`src/identity/auth.ts`), **never** a plaintext
 * password. It is nullable — a user created by `swarm users add` (or the `users`
 * router) has no password until an operator sets one with `swarm users
 * set-password` or the user redeems a password link (issue #1151,
 * `src/identity/password-link.ts`), and a user with no hash can never log in. It is deliberately **not** part of the `SwarmUser`
 * domain read model (`src/identity/schema.ts`), so it never leaves the DB layer:
 * `rowToSwarmUser` drops it and only the auth path reads it.
 */
export const users = pgTable('users', {
	id: uuid('id').primaryKey().defaultRandom(),
	/** Stable, unique login handle (username/email). */
	identifier: text('identifier').notNull().unique(),
	/** Human-friendly label shown in the dashboard. */
	displayName: text('display_name').notNull(),
	/** Installation-admin flag — designated explicitly, never auto-granted. */
	instanceAdmin: boolean('instance_admin').notNull().default(false),
	/** `scrypt` salt+hash of the login password (never plaintext); null until set. */
	passwordHash: text('password_hash'),
	createdAt: timestamp('created_at').notNull().defaultNow(),
	updatedAt: timestamp('updated_at')
		.notNull()
		.defaultNow()
		.$onUpdate(() => new Date()),
});
