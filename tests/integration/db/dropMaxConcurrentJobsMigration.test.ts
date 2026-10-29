import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import {
	createDispatch,
	getDispatchById,
} from '../../../src/db/repositories/dispatchesRepository.js';
import { dispatches } from '../../../src/db/schema/dispatches.js';
import { projects } from '../../../src/db/schema/projects.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-drop-cap';
// The project-wide job cap's retired wait reason (issue #1190), which no longer
// type-checks as a `DispatchWaitReason` — rows carrying it can only predate the upgrade.
const RETIRED_WAIT_REASON = 'project-capacity';

/**
 * The data statements of `0085_drop_max_concurrent_jobs.sql`, read from the file itself
 * so the test exercises the SQL that ships. The column drop is excluded: the suite's
 * setup has already applied the whole migration, and the statements under test are
 * written to be re-runnable over that state.
 */
function migrationDataStatements(): string[] {
	const file = readFileSync(
		path.resolve(
			import.meta.dirname,
			'../../../src/db/migrations/0085_drop_max_concurrent_jobs.sql',
		),
		'utf8',
	);
	return file
		.split('--> statement-breakpoint')
		.map((statement) => statement.trim())
		.filter((statement) => !statement.includes('DROP COLUMN'));
}

async function runMigrationData(): Promise<void> {
	for (const statement of migrationDataStatements()) await getDb().execute(sql.raw(statement));
}

function job(): SwarmJob {
	return { ...createMockScmWebhookJob(), projectId: PROJECT_ID } as SwarmJob;
}

/** A pending dispatch carrying the retired wait reason, as an upgraded database holds it. */
async function capacityWaiter(state: 'pending' | 'retry-scheduled' = 'pending') {
	const { dispatch } = await createDispatch({
		projectId: PROJECT_ID,
		jobPayload: job(),
		source: 'webhook',
		state,
	});
	await getDb()
		.update(dispatches)
		.set({ waitReason: sql`${RETIRED_WAIT_REASON}` })
		.where(eq(dispatches.id, dispatch.id));
	return dispatch;
}

// Issue #1190: retiring the project-wide job cap must not strand the dispatches that
// were waiting on it at upgrade — nothing promotes that wait any more.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'migration 0085_drop_max_concurrent_jobs',
	() => {
		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: 'jkwiecien/drop-cap' });
		});

		it('turns a pending capacity waiter into ordinary pending work with a fresh wake sequence', async () => {
			const waiter = await capacityWaiter();

			await runMigrationData();

			const after = await getDispatchById(waiter.id);
			expect(after).toMatchObject({
				state: 'pending',
				waitReason: null,
				wakeSeq: waiter.wakeSeq + 1,
			});
			expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(waiter.updatedAt.getTime());
		});

		it('leaves every other dispatch alone, and is re-runnable', async () => {
			const scheduled = await capacityWaiter('retry-scheduled');
			const { dispatch: other } = await createDispatch({
				projectId: PROJECT_ID,
				jobPayload: job(),
				source: 'webhook',
				state: 'pending',
				waitReason: 'task-in-flight',
			});
			const waiter = await capacityWaiter();

			await runMigrationData();
			await runMigrationData();

			expect(await getDispatchById(scheduled.id)).toMatchObject({
				waitReason: RETIRED_WAIT_REASON,
				wakeSeq: scheduled.wakeSeq,
			});
			expect(await getDispatchById(other.id)).toMatchObject({
				waitReason: 'task-in-flight',
				wakeSeq: other.wakeSeq,
			});
			expect(await getDispatchById(waiter.id)).toMatchObject({ wakeSeq: waiter.wakeSeq + 1 });
		});

		it('strips the retired continuation-priority key from a persisted pipeline', async () => {
			await getDb()
				.update(projects)
				.set({
					pipeline: sql`'{"prioritizeContinuations": false, "respondToCi": {"enabled": true}}'::jsonb`,
				})
				.where(eq(projects.id, PROJECT_ID));

			await runMigrationData();

			const [row] = await getDb()
				.select({ pipeline: projects.pipeline })
				.from(projects)
				.where(eq(projects.id, PROJECT_ID));
			expect(row.pipeline).toEqual({ respondToCi: { enabled: true } });
		});
	},
);
