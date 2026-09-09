import { describe, expect, it } from 'vitest';
import {
	APP_SETTINGS_DEFAULTS,
	AppSettingsSchema,
	validateAppSettings,
} from '@/config/app-settings.js';

describe('AppSettingsSchema', () => {
	it('accepts an empty settings object (all defaults)', () => {
		expect(AppSettingsSchema.safeParse({}).success).toBe(true);
	});

	it('defaults appearance.theme to dark when absent', () => {
		expect(validateAppSettings({}).appearance.theme).toBe('dark');
		expect(validateAppSettings({ agents: {} }).appearance.theme).toBe('dark');
	});

	it('accepts each valid theme value', () => {
		for (const theme of ['dark', 'light', 'system'] as const) {
			expect(validateAppSettings({ appearance: { theme } }).appearance.theme).toBe(theme);
		}
	});

	it('rejects an unknown theme value', () => {
		expect(AppSettingsSchema.safeParse({ appearance: { theme: 'solarized' } }).success).toBe(false);
	});

	it('preserves agents.defaults alongside appearance', () => {
		const parsed = validateAppSettings({
			agents: { defaults: { claude: 'opus' } },
			appearance: { theme: 'light' },
		});
		expect(parsed.agents?.defaults?.claude).toBe('opus');
		expect(parsed.appearance.theme).toBe('light');
	});

	it('accepts a valid global agents.defaults block', () => {
		const parsed = validateAppSettings({
			agents: {
				defaults: {
					claude: 'opus',
					antigravity: 'Gemini 3.6 Flash (Medium)',
					codex: 'gpt-5.6-terra',
				},
			},
		});
		expect(parsed.agents?.defaults?.claude).toBe('opus');
	});

	it('rejects a model not in the known list for its cli', () => {
		expect(
			AppSettingsSchema.safeParse({ agents: { defaults: { claude: 'gpt-5.6-terra' } } }).success,
		).toBe(false);
	});

	it('rejects an unknown cli key in the defaults block', () => {
		expect(AppSettingsSchema.safeParse({ agents: { defaults: { gpt: 'sonnet' } } }).success).toBe(
			false,
		);
	});

	it('validateAppSettings throws on malformed input', () => {
		expect(() => validateAppSettings({ agents: { defaults: { claude: 'nonsense' } } })).toThrow();
	});

	it('APP_SETTINGS_DEFAULTS is a valid settings object defaulting to a dark theme', () => {
		expect(AppSettingsSchema.safeParse(APP_SETTINGS_DEFAULTS).success).toBe(true);
		expect(APP_SETTINGS_DEFAULTS).toEqual({ appearance: { theme: 'dark' } });
	});
});
