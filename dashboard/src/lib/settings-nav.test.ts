import { describe, expect, it } from 'vitest';
import {
	legacyBugReportsRedirect,
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

	// The bug reports' old home (issue #1390), kept parseable so its links redirect (issue #1443).
	it('parses a legacy Issues-tab link with its report', () => {
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
			'appearance',
		]);
	});

	it('hides Agent Defaults, Credentials, Users and Fleet from a non-administrator', () => {
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

	// Hidden as a courtesy; `settings.update` refuses a non-administrator's change to the
	// key it edits regardless (issue #1284).
	it('degrades a direct ?tab=fleet link for a non-administrator', () => {
		expect(resolveActiveSettingsTab({ tab: 'fleet' }, NON_ADMIN)).toBe('appearance');
		expect(resolveActiveSettingsTab({ tab: 'fleet' })).toBe('appearance');
	});

	it('honors ?tab=fleet for an administrator', () => {
		expect(resolveActiveSettingsTab({ tab: 'fleet' }, ADMIN)).toBe('fleet');
	});

	// Issues is no longer a tab (issue #1443); the route redirects it before this is asked.
	it('renders no Issues tab for a legacy ?tab=issues', () => {
		expect(resolveActiveSettingsTab({ tab: 'issues' }, NON_ADMIN)).toBe('appearance');
		expect(resolveActiveSettingsTab({ tab: 'issues' }, ADMIN)).toBe('appearance');
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
	});
});

describe('settingsTabSearch', () => {
	it('builds search state for a tab', () => {
		expect(settingsTabSearch('appearance')).toEqual({ tab: 'appearance' });
	});
});

describe('legacyBugReportsRedirect', () => {
	const report = '00000000-0000-4000-8000-000000000001';

	it('sends a legacy Issues-tab link to the bug reports, keeping its report (issue #1443)', () => {
		expect(legacyBugReportsRedirect(settingsSearchSchema.parse({ tab: 'issues' }))).toEqual({});
		expect(legacyBugReportsRedirect(settingsSearchSchema.parse({ tab: 'issues', report }))).toEqual(
			{ report },
		);
	});

	it('leaves every other settings link alone', () => {
		expect(legacyBugReportsRedirect({})).toBeUndefined();
		expect(legacyBugReportsRedirect({ tab: 'appearance', report })).toBeUndefined();
	});
});
