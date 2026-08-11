import { describe, expect, it } from 'vitest';
import {
	resolveActiveSettingsTab,
	settingsSearchSchema,
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
		expect(visibleSettingsTabs(ADMIN)).toEqual(['agents', 'appearance']);
	});

	it('hides Agent Defaults from a non-administrator', () => {
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

	it('treats an unresolved viewer as a non-administrator, so the section never flashes', () => {
		expect(resolveActiveSettingsTab({ tab: 'agents' })).toBe('appearance');
		expect(resolveActiveSettingsTab({})).toBe('appearance');
	});
});

describe('settingsTabSearch', () => {
	it('builds search state for a tab', () => {
		expect(settingsTabSearch('appearance')).toEqual({ tab: 'appearance' });
	});
});
