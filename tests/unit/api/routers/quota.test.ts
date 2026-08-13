import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/cliQuotasRepository.js', () => ({
	getAllCliQuotas: vi.fn(),
	upsertCliQuota: vi.fn(),
}));

vi.mock('@/harness/quota-discovery.js', () => ({
	discoverCliQuotas: vi.fn(),
	discoveryHost: vi.fn(() => 'control-plane.local'),
}));

import { quotaRouter } from '@/api/routers/quota.js';
import {
	getAllCliQuotas,
	type HostCliQuotaSnapshot,
	upsertCliQuota,
} from '@/db/repositories/cliQuotasRepository.js';
import type { CliQuotaSnapshot } from '@/harness/quota.js';
import { discoverCliQuotas } from '@/harness/quota-discovery.js';

describe('quotaRouter', () => {
	const AUTHED_USER = {
		id: '00000000-0000-4000-8000-000000000000',
		identifier: 'tester@example.com',
		displayName: 'Tester',
		instanceAdmin: true,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const caller = quotaRouter.createCaller({ user: AUTHED_USER });

	beforeEach(() => {
		vi.mocked(getAllCliQuotas).mockReset();
		vi.mocked(upsertCliQuota).mockReset();
		vi.mocked(discoverCliQuotas).mockReset();
	});

	describe('getQuotas', () => {
		// Issue #703: two hosts can report the same CLI, and each row's host must
		// survive the read — the page attributes an allowance with it.
		it('passes host-attributed snapshots through unchanged', async () => {
			const mockSnapshots: HostCliQuotaSnapshot[] = [
				{
					host: 'builder-01',
					cli: 'codex',
					status: 'available',
					source: 'live',
					lastUpdated: new Date().toISOString(),
				},
				{
					host: 'builder-02',
					cli: 'codex',
					status: 'unavailable',
					source: 'fallback',
					lastUpdated: new Date().toISOString(),
				},
			];
			vi.mocked(getAllCliQuotas).mockResolvedValue(mockSnapshots);

			const result = await caller.getQuotas();
			expect(result).toEqual(mockSnapshots);
			expect(getAllCliQuotas).toHaveBeenCalledTimes(1);
		});
	});

	describe('refreshQuotas', () => {
		it('triggers a full CLI discovery, upserts each snapshot against this host, and returns the result', async () => {
			const mockSnapshots: CliQuotaSnapshot[] = [
				{
					cli: 'claude',
					status: 'available',
					source: 'fallback',
					lastUpdated: new Date().toISOString(),
				},
				{
					cli: 'codex',
					status: 'unavailable',
					source: 'fallback',
					lastUpdated: new Date().toISOString(),
				},
			];
			vi.mocked(discoverCliQuotas).mockResolvedValue(mockSnapshots);

			const result = await caller.refreshQuotas();

			expect(discoverCliQuotas).toHaveBeenCalledWith(false); // cheap = false for manual refresh
			expect(upsertCliQuota).toHaveBeenCalledTimes(2);
			// The probing host is stamped on every row this refresh writes (issue #703),
			// so it replaces only its own machine's snapshots.
			expect(upsertCliQuota).toHaveBeenNthCalledWith(
				1,
				'control-plane.local',
				mockSnapshots[0].cli,
				mockSnapshots[0].status,
				mockSnapshots[0],
			);
			expect(upsertCliQuota).toHaveBeenLastCalledWith(
				'control-plane.local',
				mockSnapshots[1].cli,
				mockSnapshots[1].status,
				mockSnapshots[1],
			);
			expect(result).toEqual(mockSnapshots);
		});
	});
});
