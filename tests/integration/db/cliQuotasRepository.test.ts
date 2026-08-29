import { beforeEach, describe, expect, it } from 'vitest';

import {
	listCliQuotasForOwner,
	upsertCliQuota,
} from '../../../src/db/repositories/cliQuotasRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { createWorker, removeWorker } from '../../../src/db/repositories/workersRepository.js';
import type { CliQuotaSnapshot } from '../../../src/harness/quota.js';
import { truncateAll } from '../helpers/db.js';

function snapshot(overrides: Partial<CliQuotaSnapshot> = {}): CliQuotaSnapshot {
	return {
		cli: 'codex',
		status: 'available',
		source: 'live',
		lastUpdated: '2026-08-13T08:00:00.000Z',
		...overrides,
	};
}

/**
 * Issue #823 written as a test: `cli_quotas` is keyed on `(worker_id, cli)`, so a
 * row is one *worker's* installation and therefore attributable to that worker's
 * owner — which is what lets the read be scoped to the viewer. Keyed on a hostname
 * (issue #703) the row named no user at all, and the only read was unscoped, so
 * every signed-in user was shown whichever machine ran the discovering process.
 */
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('cliQuotasRepository (integration)', () => {
	let ada: { id: string };
	let grace: { id: string };
	let adaMini: string;
	let adaTower: string;
	let graceWorker: string;

	beforeEach(async () => {
		await truncateAll();
		ada = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
		grace = await createUser({ identifier: 'grace@example.com', displayName: 'Grace' });
		adaMini = (
			await createWorker({
				ownerUserId: ada.id,
				displayName: 'mini',
				capabilities: ['claude'],
				credentialHash: 'hash-ada-mini',
			})
		).id;
		adaTower = (
			await createWorker({
				ownerUserId: ada.id,
				displayName: 'tower',
				capabilities: ['claude'],
				credentialHash: 'hash-ada-tower',
			})
		).id;
		graceWorker = (
			await createWorker({
				ownerUserId: grace.id,
				displayName: 'grace-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-grace',
			})
		).id;
	});

	it('keeps two of an owner’s workers reporting the same CLI as two rows', async () => {
		await upsertCliQuota(adaTower, 'codex', 'available', snapshot({ remainingPercentage: 90 }));
		await upsertCliQuota(
			adaMini,
			'codex',
			'unavailable',
			snapshot({ status: 'unavailable', source: 'fallback', error: 'codex binary not found' }),
		);

		const rows = await listCliQuotasForOwner(ada.id);
		expect(rows).toHaveLength(2);
		// Ordered by worker display name then cli, each row carrying its worker.
		expect(rows.map((r) => [r.workerName, r.cli, r.status])).toEqual([
			['mini', 'codex', 'unavailable'],
			['tower', 'codex', 'available'],
		]);
		expect(rows[1]).toMatchObject({ workerId: adaTower, remainingPercentage: 90 });
	});

	// The assertion the issue is about: one owner's page never shows another's machine.
	it('never returns another owner’s worker’s row', async () => {
		await upsertCliQuota(adaMini, 'codex', 'available', snapshot({ remainingPercentage: 90 }));
		await upsertCliQuota(graceWorker, 'codex', 'available', snapshot({ remainingPercentage: 5 }));

		const rows = await listCliQuotasForOwner(ada.id);
		expect(rows.map((r) => r.workerId)).toEqual([adaMini]);
		expect(await listCliQuotasForOwner(grace.id)).toMatchObject([{ workerId: graceWorker }]);
	});

	it('returns nothing for a user who owns no worker', async () => {
		await upsertCliQuota(adaMini, 'codex', 'available', snapshot());
		const nobody = await createUser({ identifier: 'nobody@example.com', displayName: 'Nobody' });

		expect(await listCliQuotasForOwner(nobody.id)).toEqual([]);
	});

	it('replaces only the re-reporting worker’s row', async () => {
		await upsertCliQuota(adaMini, 'codex', 'available', snapshot({ remainingPercentage: 90 }));
		await upsertCliQuota(adaTower, 'codex', 'available', snapshot({ remainingPercentage: 25 }));

		await upsertCliQuota(
			adaMini,
			'codex',
			'unavailable',
			snapshot({ status: 'unavailable', source: 'fallback', error: 'exhausted' }),
		);

		const rows = await listCliQuotasForOwner(ada.id);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			workerName: 'mini',
			status: 'unavailable',
			error: 'exhausted',
		});
		// The neighbouring machine's allowance is untouched by its neighbour's re-report.
		expect(rows[1]).toMatchObject({
			workerName: 'tower',
			status: 'available',
			remainingPercentage: 25,
		});
	});

	it('stores one row per CLI within a worker, ordered by CLI', async () => {
		await upsertCliQuota(adaMini, 'codex', 'available', snapshot({ cli: 'codex' }));
		await upsertCliQuota(adaMini, 'claude', 'available', snapshot({ cli: 'claude' }));

		const rows = await listCliQuotasForOwner(ada.id);
		expect(rows.map((r) => r.cli)).toEqual(['claude', 'codex']);
		expect(rows.every((r) => r.workerId === adaMini)).toBe(true);
	});

	// `ON DELETE CASCADE`: a deregistered machine's snapshots go with it rather than dangling.
	it('drops a worker’s rows when the worker is removed', async () => {
		await upsertCliQuota(adaMini, 'codex', 'available', snapshot());
		await upsertCliQuota(adaTower, 'codex', 'available', snapshot());

		await removeWorker(adaMini);

		expect((await listCliQuotasForOwner(ada.id)).map((r) => r.workerId)).toEqual([adaTower]);
	});

	// The join selects columns explicitly so the worker's secret never rides along.
	it('carries no credential hash in the projection', async () => {
		await upsertCliQuota(adaMini, 'codex', 'available', snapshot());

		const [row] = await listCliQuotasForOwner(ada.id);
		expect(Object.keys(row)).not.toContain('credentialHash');
	});

	it('returns nothing when no worker has reported', async () => {
		expect(await listCliQuotasForOwner(ada.id)).toEqual([]);
	});
});
