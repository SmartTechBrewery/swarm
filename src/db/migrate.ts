/**
 * In-process schema migration — applies any pending Drizzle migrations against
 * the live database from *inside* the worker process, at startup.
 *
 * Why this exists (not just the `db:migrate` npm-script prefix): the worker can
 * be launched directly, from compiled output, or through the opt-in
 * `dev:worker:legacy:watch` command. A watch restart does not rerun the npm prefix. A
 * process that picks up new schema-referencing code before its migration is
 * applied would run *ahead* of the DB: every `runs` insert/select would fail with
 * `column "…" does not exist`, silently (run tracking is best-effort), and the
 * phase ran but never appeared in the dashboard. Applying migrations here — on
 * every process start, watch restart included — closes that window.
 *
 * The migrations folder is the same one `drizzle-kit migrate` uses (see
 * `drizzle.config.ts` `out`), read from the source tree (the `.sql` files are
 * not compiled into `dist/`); both dev and `start:*` run from the repo root, so
 * a cwd-relative path resolves in both. `migrate()` shares the journal table
 * (`drizzle.__drizzle_migrations`) with the CLI, so already-applied migrations
 * are skipped — running it when nothing is pending is a cheap no-op.
 */

import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { getDb } from './client.js';

/** Migrations live in the source tree, not `dist/` — resolve from the cwd. */
const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'src/db/migrations');

/**
 * Apply all pending migrations. Throws if they cannot be applied — callers at
 * process startup should treat that as fatal, since a schema-mismatched process
 * is exactly the failure mode this guards against (a loud crash beats silently
 * writing invisible runs).
 */
export async function runMigrations(): Promise<void> {
	await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
}
