import { beforeEach, describe, expect, it } from 'vitest';

import { APP_SETTINGS_DEFAULTS } from '../../../src/config/app-settings.js';
import {
	getAppSettings,
	updateAppSettings,
} from '../../../src/db/repositories/appSettingsRepository.js';
import { truncateAll } from '../helpers/db.js';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('appSettingsRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
	});

	describe('getAppSettings', () => {
		it('returns the coded defaults when no row exists', async () => {
			expect(await getAppSettings()).toEqual(APP_SETTINGS_DEFAULTS);
		});
	});

	describe('updateAppSettings', () => {
		it('round-trips the stored settings', async () => {
			const settings = {
				agents: { defaults: { claude: 'opus' } },
				appearance: { theme: 'light' as const },
				workers: { followInstallationVersion: false },
			};
			const returned = await updateAppSettings(settings);

			expect(returned).toEqual(settings);
			expect(await getAppSettings()).toEqual(settings);
		});

		it('is an idempotent upsert — a second write replaces the first in place', async () => {
			await updateAppSettings({
				agents: { defaults: { claude: 'opus' } },
				appearance: { theme: 'dark' },
				workers: { followInstallationVersion: true },
			});
			await updateAppSettings({
				agents: { defaults: { claude: 'sonnet' } },
				appearance: { theme: 'system' },
				workers: { followInstallationVersion: true },
			});

			expect(await getAppSettings()).toEqual({
				agents: { defaults: { claude: 'sonnet' } },
				appearance: { theme: 'system' },
				workers: { followInstallationVersion: true },
			});
		});

		it('round-trips each theme value', async () => {
			for (const theme of ['dark', 'light', 'system'] as const) {
				const settings = { appearance: { theme }, workers: { followInstallationVersion: true } };
				await updateAppSettings(settings);
				expect(await getAppSettings()).toEqual(settings);
			}
		});
	});

	describe('legacy rows', () => {
		it('normalizes a pre-appearance, pre-workers row to the defaults on read', async () => {
			const db = (await import('../../../src/db/client.js')).getDb();
			const { appSettings } = await import('../../../src/db/schema/appSettings.js');
			// biome-ignore lint/suspicious/noExplicitAny: intentionally bypassing the AppSettings type to write a pre-#250 shape
			await db.insert(appSettings).values({ id: 'global', settings: { agents: {} } as any });

			expect(await getAppSettings()).toEqual({
				agents: {},
				appearance: { theme: 'dark' },
				workers: { followInstallationVersion: true },
			});
		});
	});
});
