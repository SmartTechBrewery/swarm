import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import {
	listStalledDismissals,
	recordStalledDismissal,
} from '../../../src/db/repositories/stalledDismissalsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { projects } from '../../../src/db/schema/projects.js';
import { stalledDismissals } from '../../../src/db/schema/stalledDismissals.js';
import { users } from '../../../src/db/schema/users.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

// `stalled_dismissals.project_id` FKs `projects`, so every test needs a seeded
// project; `dismissed_by` FKs `users`, which the cascade tests below exercise.
const PROJECT_ID = 'proj-stalled-dismissals';
const REPO = 'jkwiecien/dismissals-repo';

const NOW = new Date('2026-09-05T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function unit(overrides: Partial<Parameters<typeof recordStalledDismissal>[0]> = {}) {
	return {
		projectId: PROJECT_ID,
		repository: REPO,
		unit: 'pull-request',
		reference: '92',
		lastActivityAt: NOW,
		dismissedBy: null,
		...overrides,
	};
}

async function allRows() {
	return await getDb().select().from(stalledDismissals);
}

// issue #880 — the durable record behind an operator's dismissal. Only Postgres
// can prove the two properties this table is shaped around: that the unique index
// really makes a repeat dismissal a rotation of one row, and that the FKs behave
// as declared (the project cascades the row away, the user only nulls its author).
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('stalledDismissalsRepository', () => {
	beforeEach(async () => {
		await truncateAll();
		await seedProject({ id: PROJECT_ID, repo: REPO });
	});

	it('rotates one row rather than inserting a second when the same unit is dismissed again', async () => {
		await recordStalledDismissal(unit());
		const moved = new Date(NOW.getTime() + DAY_MS);

		const { dismissedAt } = await recordStalledDismissal(unit({ lastActivityAt: moved }));

		const rows = await allRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].lastActivityAt).toEqual(moved);
		expect(rows[0].dismissedAt).toEqual(dismissedAt);
	});

	it.each([
		['repository', { repository: 'jkwiecien/other-repo' }],
		['unit kind', { unit: 'work-item' }],
		['reference', { reference: '93' }],
	])('keeps two units apart when they differ only in %s', async (_field, overrides) => {
		await recordStalledDismissal(unit());
		await recordStalledDismissal(unit(overrides));

		expect(await allRows()).toHaveLength(2);
	});

	it('reads back the unit key and the instant it was dismissed at', async () => {
		await recordStalledDismissal(unit());

		await expect(
			listStalledDismissals({ since: new Date(NOW.getTime() - DAY_MS) }),
		).resolves.toEqual([
			{
				projectId: PROJECT_ID,
				repository: REPO,
				unit: 'pull-request',
				reference: '92',
				// A real `Date` the classifier's arithmetic can use, not a driver string.
				lastActivityAt: NOW,
			},
		]);
	});

	it('excludes a dismissal older than the lookback window', async () => {
		await recordStalledDismissal(unit({ lastActivityAt: new Date(NOW.getTime() - 40 * DAY_MS) }));

		await expect(
			listStalledDismissals({ since: new Date(NOW.getTime() - 30 * DAY_MS) }),
		).resolves.toEqual([]);
	});

	it('scopes the read to the requested projects', async () => {
		await seedProject({ id: 'proj-other', repo: 'jkwiecien/other-repo' });
		await recordStalledDismissal(unit());
		await recordStalledDismissal(
			unit({ projectId: 'proj-other', repository: 'jkwiecien/other-repo' }),
		);

		const rows = await listStalledDismissals({
			since: new Date(0),
			projectIds: [PROJECT_ID],
		});

		expect(rows.map((row) => row.projectId)).toEqual([PROJECT_ID]);
	});

	// An empty scope is "no accessible project", not "every project".
	it('answers an empty project scope with nothing rather than the whole installation', async () => {
		await recordStalledDismissal(unit());

		await expect(listStalledDismissals({ since: new Date(0), projectIds: [] })).resolves.toEqual(
			[],
		);
	});

	it('cascades the row away when its project is deleted', async () => {
		await recordStalledDismissal(unit());

		await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));

		expect(await allRows()).toHaveLength(0);
	});

	// The record must outlive the account that made it: `on delete set null`.
	it('keeps the row and nulls its author when the dismissing user is deleted', async () => {
		const user = await createUser({ identifier: 'operator', displayName: 'Operator' });
		await recordStalledDismissal(unit({ dismissedBy: user.id }));

		await getDb().delete(users).where(eq(users.id, user.id));

		const rows = await allRows();
		expect(rows).toHaveLength(1);
		expect(rows[0].dismissedBy).toBeNull();
	});
});
