import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/appSettingsRepository.js', () => ({
	getAppSettings: vi.fn(),
	updateAppSettings: vi.fn(),
}));
vi.mock('@/harness/quota-discovery.js', () => ({
	discoverCliQuotas: vi.fn(async () => []),
}));
vi.mock('@/db/repositories/cliQuotasRepository.js', () => ({
	upsertCliQuota: vi.fn(async () => undefined),
}));

import { settingsRouter } from '@/api/routers/settings.js';
import type { AppSettings } from '@/config/app-settings.js';
import { getAppSettings, updateAppSettings } from '@/db/repositories/appSettingsRepository.js';
import { discoverCliQuotas } from '@/harness/quota-discovery.js';

describe('settingsRouter', () => {
	const AUTHED_USER = {
		id: '00000000-0000-4000-8000-000000000000',
		identifier: 'tester@example.com',
		displayName: 'Tester',
		instanceAdmin: true,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const caller = settingsRouter.createCaller({ user: AUTHED_USER });

	beforeEach(() => {
		vi.mocked(getAppSettings).mockReset();
		vi.mocked(updateAppSettings).mockReset();
		vi.mocked(discoverCliQuotas).mockClear();
	});

	describe('get', () => {
		it('returns whatever getAppSettings resolves', async () => {
			const settings: AppSettings = {
				agents: { defaults: { claude: 'opus' } },
				appearance: { theme: 'dark' },
				workers: { followInstallationVersion: true },
			};
			vi.mocked(getAppSettings).mockResolvedValue(settings);

			const result = await caller.get();
			expect(result).toEqual(settings);
			expect(getAppSettings).toHaveBeenCalledTimes(1);
		});

		it('returns the defaults when nothing is stored', async () => {
			const defaults: AppSettings = {
				appearance: { theme: 'dark' },
				workers: { followInstallationVersion: true },
			};
			vi.mocked(getAppSettings).mockResolvedValue(defaults);

			const result = await caller.get();
			expect(result).toEqual(defaults);
		});
	});

	describe('update', () => {
		it('validates input and passes it to updateAppSettings', async () => {
			const settings: AppSettings = {
				agents: { defaults: { claude: 'sonnet' } },
				appearance: { theme: 'light' },
				workers: { followInstallationVersion: true },
			};
			vi.mocked(updateAppSettings).mockResolvedValue(settings);

			const result = await caller.update(settings);
			expect(result).toEqual(settings);
			expect(updateAppSettings).toHaveBeenCalledWith(settings);
			expect(discoverCliQuotas).not.toHaveBeenCalled();
		});

		it('rejects a model not valid for its cli before touching the repository', async () => {
			await expect(
				caller.update({ agents: { defaults: { claude: 'gpt-5.6-terra' } } } as AppSettings),
			).rejects.toThrow();
			expect(updateAppSettings).not.toHaveBeenCalled();
		});

		it('materializes workers.followInstallationVersion as true when the input omits it', async () => {
			vi.mocked(updateAppSettings).mockImplementation(async (settings) => settings);

			await caller.update({ appearance: { theme: 'dark' } } as AppSettings);

			expect(updateAppSettings).toHaveBeenCalledWith({
				appearance: { theme: 'dark' },
				workers: { followInstallationVersion: true },
			});
		});
	});

	// Issue #1284: the key decides whether installation-wide rollouts start, which is
	// administrator-only everywhere else, so only an administrator may change it.
	describe('update — workers.followInstallationVersion', () => {
		const NON_ADMIN = { ...AUTHED_USER, instanceAdmin: false };
		const nonAdminCaller = settingsRouter.createCaller({ user: NON_ADMIN });
		const STORED: AppSettings = {
			appearance: { theme: 'dark' },
			workers: { followInstallationVersion: true },
		};

		beforeEach(() => {
			vi.mocked(getAppSettings).mockResolvedValue(STORED);
			vi.mocked(updateAppSettings).mockImplementation(async (settings) => settings);
		});

		it('refuses a non-administrator who changes it', async () => {
			const error = await nonAdminCaller
				.update({ ...STORED, workers: { followInstallationVersion: false } })
				.catch((err: unknown) => err);

			expect(error).toBeInstanceOf(TRPCError);
			expect((error as TRPCError).code).toBe('FORBIDDEN');
			expect(updateAppSettings).not.toHaveBeenCalled();
		});

		it('lets a non-administrator save another setting while carrying it unchanged', async () => {
			const next: AppSettings = { ...STORED, appearance: { theme: 'light' } };

			await expect(nonAdminCaller.update(next)).resolves.toEqual(next);
			expect(updateAppSettings).toHaveBeenCalledWith(next);
		});

		it('lets an administrator change it', async () => {
			const next: AppSettings = { ...STORED, workers: { followInstallationVersion: false } };

			await expect(caller.update(next)).resolves.toEqual(next);
			expect(updateAppSettings).toHaveBeenCalledWith(next);
		});
	});
});
