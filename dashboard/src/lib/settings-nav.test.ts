import { describe, expect, it } from 'vitest';
import {
	resolveActiveSettingsTab,
	settingsSearchSchema,
	settingsTabNeedsAppSettings,
	settingsTabSearch,
	visibleSettingsTabs,
} from './settings-nav.js';

const ADMIN = { instanceAdmin: true };
const NON_ADMIN = { instanceAdmin: false };

describe('settingsSearchSchema', () => {
	it('yields no tab for a bare settings link', () => {
		expect(settingsSearchSchema.parse({})).toEqual({ tab: undefined });
	});

	it('parses a valid tab', () => {
		expect(settingsSearchSchema.parse({ tab: 'appearance' })).toEqual({ tab: 'appearance' });
	});

	it('falls back to undefined rather than throwing on an unknown tab', () => {
		expect(settingsSearchSchema.parse({ tab: 'nope' })).toEqual({ tab: undefined });
	});

	it('strips unknown params', () => {
		expect(settingsSearchSchema.parse({ tab: 'agents', extra: 'x' })).toEqual({ tab: 'agents' });
	});
});

describe('visibleSettingsTabs', () => {
	it('gives an instance administrator every tab', () => {
		expect(visibleSettingsTabs(ADMIN)).toEqual(['agents', 'credentials', 'users', 'appearance']);
	});

	it('hides Agent Defaults, Credentials and Users from a non-administrator', () => {
		expect(visibleSettingsTabs(NON_ADMIN)).toEqual(['appearance']);
	});

	it('treats an unresolved viewer as a non-administrator', () => {
		expect(visibleSettingsTabs(undefined)).toEqual(['appearance']);
	});
});

describe('resolveActiveSettingsTab', () => {
	it('defaults to the Agent Defaults tab for an administrator on an empty search', () => {
		expect(resolveActiveSettingsTab({}, ADMIN)).toBe('agents');
	});

	it('honors an explicit tab', () => {
		expect(resolveActiveSettingsTab({ tab: 'appearance' }, ADMIN)).toBe('appearance');
		expect(resolveActiveSettingsTab({ tab: 'agents' }, ADMIN)).toBe('agents');
	});

	it('lands a non-administrator on Appearance rather than Agent Defaults', () => {
		expect(resolveActiveSettingsTab({}, NON_ADMIN)).toBe('appearance');
	});

	it('degrades a direct ?tab=agents link for a non-administrator', () => {
		expect(resolveActiveSettingsTab({ tab: 'agents' }, NON_ADMIN)).toBe('appearance');
	});

	// The tab is hidden as a courtesy; `settings.credentials` refuses a non-administrator
	// in the router regardless (issue #769).
	it('degrades a direct ?tab=credentials link for a non-administrator', () => {
		expect(resolveActiveSettingsTab({ tab: 'credentials' }, NON_ADMIN)).toBe('appearance');
		expect(resolveActiveSettingsTab({ tab: 'credentials' })).toBe('appearance');
	});

	it('honors ?tab=credentials for an administrator', () => {
		expect(resolveActiveSettingsTab({ tab: 'credentials' }, ADMIN)).toBe('credentials');
	});

	// Hidden as a courtesy; every `users` procedure refuses a non-administrator in the
	// router regardless (issue #1151).
	it('degrades a direct ?tab=users link for a non-administrator', () => {
		expect(resolveActiveSettingsTab({ tab: 'users' }, NON_ADMIN)).toBe('appearance');
		expect(resolveActiveSettingsTab({ tab: 'users' })).toBe('appearance');
	});

	it('honors ?tab=users for an administrator', () => {
		expect(resolveActiveSettingsTab({ tab: 'users' }, ADMIN)).toBe('users');
	});

	it('treats an unresolved viewer as a non-administrator, so the section never flashes', () => {
		expect(resolveActiveSettingsTab({ tab: 'agents' })).toBe('appearance');
		expect(resolveActiveSettingsTab({})).toBe('appearance');
	});
});

describe('settingsTabNeedsAppSettings', () => {
	it('waits on settings.get only for the tabs that render from it', () => {
		expect(settingsTabNeedsAppSettings('agents')).toBe(true);
		expect(settingsTabNeedsAppSettings('appearance')).toBe(true);
		expect(settingsTabNeedsAppSettings('credentials')).toBe(false);
		expect(settingsTabNeedsAppSettings('users')).toBe(false);
	});
});

describe('settingsTabSearch', () => {
	it('builds search state for a tab', () => {
		expect(settingsTabSearch('appearance')).toEqual({ tab: 'appearance' });
	});
});
