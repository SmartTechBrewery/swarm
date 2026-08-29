import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/cliQuotasRepository.js', () => ({
	listCliQuotasForOwner: vi.fn(),
}));

import { quotaRouter } from '@/api/routers/quota.js';
import {
	listCliQuotasForOwner,
	type WorkerCliQuotaSnapshot,
} from '@/db/repositories/cliQuotasRepository.js';
import type { SwarmUser } from '@/identity/schema.js';

function user(overrides: Partial<SwarmUser> = {}): SwarmUser {
	return {
		id: '00000000-0000-4000-8000-000000000000',
		identifier: 'tester@example.com',
		displayName: 'Tester',
		instanceAdmin: false,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

function snapshot(overrides: Partial<WorkerCliQuotaSnapshot> = {}): WorkerCliQuotaSnapshot {
	return {
		workerId: '11111111-1111-4111-8111-111111111111',
		workerName: 'm5_pro',
		cli: 'codex',
		status: 'available',
		source: 'live',
		lastUpdated: '2026-08-13T08:00:00.000Z',
		...overrides,
	};
}

describe('quotaRouter', () => {
	beforeEach(() => {
		vi.mocked(listCliQuotasForOwner).mockReset();
		vi.mocked(listCliQuotasForOwner).mockResolvedValue([]);
	});

	describe('getQuotas', () => {
		// Issue #823: two workers can report the same CLI, and each row's attribution
		// must survive the read — the page groups an allowance by it.
		it('reads the caller’s own workers and passes the rows through unchanged', async () => {
			const rows = [
				snapshot(),
				snapshot({
					workerId: '22222222-2222-4222-8222-222222222222',
					workerName: 'mini',
					status: 'unavailable',
					source: 'fallback',
				}),
			];
			vi.mocked(listCliQuotasForOwner).mockResolvedValue(rows);

			const caller = quotaRouter.createCaller({ user: user() });
			const result = await caller.getQuotas();

			expect(result).toEqual(rows);
			expect(listCliQuotasForOwner).toHaveBeenCalledTimes(1);
			expect(listCliQuotasForOwner).toHaveBeenCalledWith(user().id);
		});

		// The regression guard for "no admin override" — the thing a future reader is
		// most likely to "fix". An admin sees their own machines, like everyone else.
		it('scopes an instanceAdmin caller by their own id too', async () => {
			const admin = user({ id: '33333333-3333-4333-8333-333333333333', instanceAdmin: true });

			await quotaRouter.createCaller({ user: admin }).getQuotas();

			expect(listCliQuotasForOwner).toHaveBeenCalledWith(admin.id);
		});

		it('asks for each caller’s own owner id, never one taken off the input', async () => {
			const ada = user({ id: '44444444-4444-4444-8444-444444444444' });
			const grace = user({ id: '55555555-5555-4555-8555-555555555555' });

			await quotaRouter.createCaller({ user: ada }).getQuotas();
			await quotaRouter.createCaller({ user: grace }).getQuotas();

			expect(vi.mocked(listCliQuotasForOwner).mock.calls).toEqual([[ada.id], [grace.id]]);
		});

		it('returns an empty list for a caller whose workers have reported nothing', async () => {
			vi.mocked(listCliQuotasForOwner).mockResolvedValue([]);

			await expect(quotaRouter.createCaller({ user: user() }).getQuotas()).resolves.toEqual([]);
		});
	});

	// The removed mutation probed the API server's own host, which is precisely the
	// machine whose data must stop being presented as everyone's (issue #823). Asserting
	// on the procedure list keeps it from being reinstated silently.
	it('exposes no refresh procedure', () => {
		expect(Object.keys(quotaRouter._def.procedures)).toEqual(['getQuotas']);
	});
});
