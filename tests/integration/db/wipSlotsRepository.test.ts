import { beforeEach, describe, expect, it } from 'vitest';
import {
	countWipSlots,
	listWipSlots,
	releaseWipSlot,
	reserveWipSlot,
} from '../../../src/db/repositories/wipSlotsRepository.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-wip-slots';
const REPO = 'jkwiecien/wip-repo';
const OTHER_REPO = 'jkwiecien/wip-other';

function reservation(taskId: string, limit = 1, repository = REPO) {
	return {
		projectId: PROJECT_ID,
		repository,
		taskId,
		limit,
		phase: 'planning',
		// No dispatch row backs these: the column is a nullable `set null` FK, and the
		// reservation itself never reads it.
		dispatchId: undefined as unknown as string,
		workItem: { id: `ITEM_${taskId}`, title: `Ticket ${taskId}`, url: `https://x/${taskId}` },
	};
}

// Issue #1185 — the durable record the per-repository WIP limit counts. Only Postgres
// can prove the property the reservation is shaped around: that admissions racing for
// a repository's last slot are serialized, so the limit is never exceeded.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('wipSlotsRepository', () => {
	beforeEach(async () => {
		await truncateAll();
		await seedProject({ id: PROJECT_ID, repo: REPO });
	});

	it('admits a ticket under the limit', async () => {
		expect(await reserveWipSlot(reservation('1'))).toEqual({
			admitted: true,
			alreadyInFlight: false,
		});
		expect(await countWipSlots(PROJECT_ID, REPO)).toBe(1);
	});

	it('admits the same ticket again as already in flight, without a second slot', async () => {
		await reserveWipSlot(reservation('1'));

		expect(await reserveWipSlot(reservation('1'))).toEqual({
			admitted: true,
			alreadyInFlight: true,
		});
		expect(await countWipSlots(PROJECT_ID, REPO)).toBe(1);
	});

	it('refuses a different ticket at the limit, naming the holders', async () => {
		await reserveWipSlot(reservation('1'));

		const refused = await reserveWipSlot(reservation('2'));

		expect(refused).toMatchObject({
			admitted: false,
			holders: [{ taskId: '1', workItemTitle: 'Ticket 1' }],
		});
		expect(await countWipSlots(PROJECT_ID, REPO)).toBe(1);
	});

	it('counts each repository of a project independently', async () => {
		await reserveWipSlot(reservation('1'));

		expect(await reserveWipSlot(reservation('2', 1, OTHER_REPO))).toMatchObject({
			admitted: true,
		});
		expect(await countWipSlots(PROJECT_ID, REPO)).toBe(1);
		expect(await countWipSlots(PROJECT_ID, OTHER_REPO)).toBe(1);
	});

	it('frees a slot on release, so the refused ticket is admitted next', async () => {
		await reserveWipSlot(reservation('1'));
		expect(await reserveWipSlot(reservation('2'))).toMatchObject({ admitted: false });

		expect(await releaseWipSlot(PROJECT_ID, REPO, '1')).toBe(true);

		expect(await reserveWipSlot(reservation('2'))).toMatchObject({ admitted: true });
	});

	it('lists every held slot with the card it started from (issue #1189)', async () => {
		await reserveWipSlot(reservation('1'));
		await reserveWipSlot(reservation('2', 1, OTHER_REPO));

		expect(await listWipSlots()).toEqual(
			expect.arrayContaining([
				{ projectId: PROJECT_ID, repository: REPO, taskId: '1', workItemId: 'ITEM_1' },
				{ projectId: PROJECT_ID, repository: OTHER_REPO, taskId: '2', workItemId: 'ITEM_2' },
			]),
		);
		expect(await listWipSlots()).toHaveLength(2);
	});

	it('reports releasing a ticket that holds no slot', async () => {
		expect(await releaseWipSlot(PROJECT_ID, REPO, '404')).toBe(false);
	});

	it.each([1, 2])('never exceeds a limit of %i under concurrent admissions', async (limit) => {
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, i) => reserveWipSlot(reservation(String(i + 1), limit))),
		);

		expect(results.filter((result) => result.admitted)).toHaveLength(limit);
		expect(await countWipSlots(PROJECT_ID, REPO)).toBe(limit);
	});
});
