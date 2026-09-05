import net from 'node:net';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, getDb } from '../../../src/db/client.js';

/**
 * Integration-suite database plumbing — trimmed from Cascade's
 * `tests/integration/helpers/db.ts` (no `.cascade/env` file, no rootless-Docker
 * bridge-IP fallback; SWARM's test DB is either `TEST_DATABASE_URL` or the
 * docker-compose.test.yml default).
 */

const COMPOSE_DEFAULT_URL = 'postgresql://swarm_test:swarm_test@127.0.0.1:5434/swarm_test';

function checkPortReachable(host: string, port: number, timeoutMs = 500): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = net.connect({ host, port });
		const done = (result: boolean) => {
			socket.destroy();
			resolve(result);
		};
		socket.once('connect', () => done(true));
		socket.once('error', () => done(false));
		socket.setTimeout(timeoutMs, () => done(false));
	});
}

async function tryUrl(url: string): Promise<boolean> {
	try {
		const parsed = new URL(url);
		const port = Number.parseInt(parsed.port || '5432', 10);
		return await checkPortReachable(parsed.hostname, port);
	} catch {
		return false;
	}
}

/**
 * Resolve a reachable test-database URL: `TEST_DATABASE_URL` if set and
 * reachable, else the docker-compose.test.yml default (`npm run test:db:up`),
 * else `null` — the setup file skips the whole suite on `null` rather than
 * failing it, so a machine without Docker still gets a green unit run.
 */
export async function resolveTestDbUrl(): Promise<string | null> {
	const envUrl = process.env.TEST_DATABASE_URL;
	if (envUrl && (await tryUrl(envUrl))) return envUrl;
	if (await tryUrl(COMPOSE_DEFAULT_URL)) return COMPOSE_DEFAULT_URL;
	return null;
}

const COMPOSE_DEFAULT_REDIS_URL = 'redis://127.0.0.1:6381';

/**
 * Resolve a reachable test-Redis URL, mirroring {@link resolveTestDbUrl}:
 * `TEST_REDIS_URL` if set and reachable, else the docker-compose.test.yml
 * default (`npm run test:db:up`), else `null` — Redis/BullMQ-dependent suites
 * skip themselves on `null`.
 */
export async function resolveTestRedisUrl(): Promise<string | null> {
	const envUrl = process.env.TEST_REDIS_URL;
	if (envUrl && (await tryUrl(envUrl))) return envUrl;
	if (await tryUrl(COMPOSE_DEFAULT_REDIS_URL)) return COMPOSE_DEFAULT_REDIS_URL;
	return null;
}

/** Run Drizzle migrations against the test database (`getDb()` reads the DATABASE_URL set by setup). */
export async function runMigrations(): Promise<void> {
	await migrate(getDb(), {
		migrationsFolder: path.resolve(import.meta.dirname, '../../../src/db/migrations'),
	});
}

/**
 * Truncate all application tables. Call in `beforeEach` to isolate tests —
 * CASCADE handles the FKs (project_credentials + runs + project_members +
 * project_membership_requests from projects, run_logs from runs, worker_sessions
 * from runs + workers, worker_scm_credentials + cli_quotas from workers, user_sessions +
 * user_identities + project_members + project_membership_requests + workers from
 * users, stalled_dismissals from projects *and* users); every table is listed for
 * explicitness. `app_settings` (a standalone singleton), `instance_scm_credentials`
 * (keyed on `(provider, role)` alone, with no project or worker to cascade from) and
 * `users` are listed here too so a write in one test doesn't leak into the next.
 */
export async function truncateAll(): Promise<void> {
	await getDb().execute(`
		TRUNCATE TABLE
			dispatches,
			run_output_events,
			run_logs,
			worker_project_enrollments,
			worker_scm_credentials,
			worker_sessions,
			runs,
			review_verdicts,
			stalled_dismissals,
			project_membership_requests,
			project_members,
			project_credentials,
			instance_scm_credentials,
			projects,
			app_settings,
			cli_quotas,
			user_identities,
			user_sessions,
			workers,
			users
		CASCADE
	`);
}

/** Close the test database pool. Call in the suite-level `afterAll`. */
export async function closeTestDb(): Promise<void> {
	await closeDb();
}
