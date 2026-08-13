import { beforeEach, describe, expect, it } from 'vitest';

import {
	getAllCliQuotas,
	upsertCliQuota,
} from '../../../src/db/repositories/cliQuotasRepository.js';
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
 * Issue #703 written as a test: `cli_quotas` is keyed on `(host, cli)`, so a row
 * is one machine's installation rather than the installation's. Keyed on `cli`
 * alone, every host overwrote the same three rows and the last probe to run won
 * for everybody.
 */
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('cliQuotasRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
	});

	it('keeps two hosts’ snapshots of the same CLI as two rows', async () => {
		await upsertCliQuota('builder-01', 'codex', 'available', snapshot({ remainingPercentage: 90 }));
		await upsertCliQuota(
			'builder-02',
			'codex',
			'unavailable',
			snapshot({ status: 'unavailable', source: 'fallback', error: 'codex binary not found' }),
		);

		const rows = await getAllCliQuotas();
		expect(rows).toHaveLength(2);
		// Ordered by (host, cli), and each snapshot carries the machine it describes.
		expect(rows.map((r) => [r.host, r.cli, r.status])).toEqual([
			['builder-01', 'codex', 'available'],
			['builder-02', 'codex', 'unavailable'],
		]);
		expect(rows[0]).toMatchObject({ host: 'builder-01', remainingPercentage: 90 });
	});

	it('replaces only the re-reporting host’s row', async () => {
		await upsertCliQuota('builder-01', 'codex', 'available', snapshot({ remainingPercentage: 90 }));
		await upsertCliQuota('builder-02', 'codex', 'available', snapshot({ remainingPercentage: 25 }));

		await upsertCliQuota(
			'builder-01',
			'codex',
			'unavailable',
			snapshot({ status: 'unavailable', source: 'fallback', error: 'exhausted' }),
		);

		const rows = await getAllCliQuotas();
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			host: 'builder-01',
			status: 'unavailable',
			error: 'exhausted',
		});
		// The other host's allowance is untouched by its neighbour's re-probe.
		expect(rows[1]).toMatchObject({
			host: 'builder-02',
			status: 'available',
			remainingPercentage: 25,
		});
	});

	it('stores one row per CLI within a host, ordered by CLI', async () => {
		await upsertCliQuota('builder-01', 'codex', 'available', snapshot({ cli: 'codex' }));
		await upsertCliQuota('builder-01', 'claude', 'available', snapshot({ cli: 'claude' }));

		const rows = await getAllCliQuotas();
		expect(rows.map((r) => r.cli)).toEqual(['claude', 'codex']);
		expect(rows.every((r) => r.host === 'builder-01')).toBe(true);
	});

	it('returns nothing when no host has reported', async () => {
		expect(await getAllCliQuotas()).toEqual([]);
	});
});
