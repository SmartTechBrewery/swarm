import { describe, expect, it } from 'vitest';
import {
	bugReportSearch,
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

	it('parses the bug report the Issues tab shows (issue #1390)', () => {
		const report = '00000000-0000-4000-8000-000000000001';
		expect(settingsSearchSchema.parse({ tab: 'issues', report })).toEqual({
			tab: 'issues',
			report,
		});
	});

	it('drops a malformed report id rather than throwing', () => {
		expect(settingsSearchSchema.parse({ tab: 'issues', report: 'nope' })).toEqual({
			tab: 'issues',
			report: undefined,
		});
	});
});

describe('visibleSettingsTabs', () => {
	it('gives an instance administrator every tab', () => {
		expect(visibleSettingsTabs(ADMIN)).toEqual([
			'agents',
			'credentials',
			'users',
			'fleet',
			'issues',
			'appearance',
		]);
	});

	it('hides Agent Defaults, Credentials, Users and Fleet from a non-administrator', () => {
		expect(visibleSettingsTabs(NON_ADMIN)).toEqual(['issues', 'appearance']);
	});

	it('treats an unresolved viewer as a non-administrator', () => {
		expect(visibleSettingsTabs(undefined)).toEqual(['issues', 'appearance']);
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

	// Hidden as a courtesy; `settings.update` refuses a non-administrator's change to the
	// key it edits regardless (issue #1284).
	it('degrades a direct ?tab=fleet link for a non-administrator', () => {
		expect(resolveActiveSettingsTab({ tab: 'fleet' }, NON_ADMIN)).toBe('appearance');
		expect(resolveActiveSettingsTab({ tab: 'fleet' })).toBe('appearance');
	});

	it('honors ?tab=fleet for an administrator', () => {
		expect(resolveActiveSettingsTab({ tab: 'fleet' }, ADMIN)).toBe('fleet');
	});

	// Every signed-in user sees Issues; `bugReports.list` scopes what it lists (issue #1390).
	it('honors ?tab=issues for a non-administrator, not degrading it to the fallback', () => {
		expect(resolveActiveSettingsTab({ tab: 'issues' }, NON_ADMIN)).toBe('issues');
		expect(resolveActiveSettingsTab({ tab: 'issues' }, ADMIN)).toBe('issues');
	});

	it('treats an unresolved viewer as a non-administrator, so the section never flashes', () => {
		expect(resolveActiveSettingsTab({ tab: 'agents' })).toBe('appearance');
		expect(resolveActiveSettingsTab({})).toBe('appearance');
	});
});

describe('settingsTabNeedsAppSettings', () => {
	it('waits on settings.get only for the tabs that render from it', () => {
		expect(settingsTabNeedsAppSettings('agents')).toBe(true);
		expect(settingsTabNeedsAppSettings('fleet')).toBe(true);
		expect(settingsTabNeedsAppSettings('appearance')).toBe(true);
		expect(settingsTabNeedsAppSettings('credentials')).toBe(false);
		expect(settingsTabNeedsAppSettings('users')).toBe(false);
		expect(settingsTabNeedsAppSettings('issues')).toBe(false);
	});
});

describe('settingsTabSearch', () => {
	it('builds search state for a tab', () => {
		expect(settingsTabSearch('appearance')).toEqual({ tab: 'appearance' });
	});
});

describe('bugReportSearch', () => {
	it('opens a report on the Issues tab, or returns to its list', () => {
		expect(bugReportSearch('r1')).toEqual({ tab: 'issues', report: 'r1' });
		expect(bugReportSearch(undefined)).toEqual({ tab: 'issues' });
	});
});
