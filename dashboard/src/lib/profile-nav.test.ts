import { describe, expect, it } from 'vitest';
import {
	AVAILABLE_PROFILE_TABS,
	isProfileTabAvailable,
	isProfileTabVisibleTo,
	PROFILE_TABS,
	profileSearchSchema,
	profileTabSearch,
	resolveActiveProfileTab,
} from './profile-nav.js';

describe('PROFILE_TABS', () => {
	it('declares the whole profile navigation structure in display order', () => {
		expect(PROFILE_TABS).toEqual(['account', 'workers', 'projects', 'security', 'mcp']);
	});

	it('offers only the tabs whose content is delivered', () => {
		// A tripwire: turning a follow-up tab on is a deliberate edit here, made by
		// the issue that ships its panel, not a side effect of unrelated work.
		expect([...AVAILABLE_PROFILE_TABS]).toEqual([
			'account',
			'workers',
			'projects',
			'security',
			'mcp',
		]);
		expect(isProfileTabAvailable('account')).toBe(true);
		expect(isProfileTabAvailable('workers')).toBe(true);
		expect(isProfileTabAvailable('projects')).toBe(true);
		expect(isProfileTabAvailable('security')).toBe(true);
		expect(isProfileTabAvailable('mcp')).toBe(true);
	});
});

const ADMIN = { instanceAdmin: true };
const MEMBER = { instanceAdmin: false };

describe('isProfileTabVisibleTo', () => {
	it('shows the MCP tab to installation administrators only (issue #1362)', () => {
		expect(isProfileTabVisibleTo('mcp', ADMIN)).toBe(true);
		expect(isProfileTabVisibleTo('mcp', MEMBER)).toBe(false);
	});

	it('shows every other delivered tab to everyone', () => {
		for (const tab of ['account', 'workers', 'projects', 'security'] as const) {
			expect(isProfileTabVisibleTo(tab, ADMIN)).toBe(true);
			expect(isProfileTabVisibleTo(tab, MEMBER)).toBe(true);
		}
	});
});

describe('profileSearchSchema', () => {
	it('yields no tab for a bare profile link', () => {
		expect(profileSearchSchema.parse({})).toEqual({ tab: undefined });
	});

	it('parses a declared tab', () => {
		expect(profileSearchSchema.parse({ tab: 'security' })).toEqual({ tab: 'security' });
	});

	it('falls back to undefined rather than throwing on an unknown tab', () => {
		expect(profileSearchSchema.parse({ tab: 'nope' })).toEqual({ tab: undefined });
	});

	it('strips unknown params, so a hand-added user id addresses nothing', () => {
		expect(profileSearchSchema.parse({ tab: 'account', userId: 'someone-else' })).toEqual({
			tab: 'account',
		});
	});
});

describe('resolveActiveProfileTab', () => {
	it('defaults to the Account tab for an empty search', () => {
		expect(resolveActiveProfileTab({}, MEMBER)).toBe('account');
	});

	it('honors an explicit, available tab', () => {
		expect(resolveActiveProfileTab({ tab: 'account' }, MEMBER)).toBe('account');
		expect(resolveActiveProfileTab({ tab: 'workers' }, MEMBER)).toBe('workers');
		expect(resolveActiveProfileTab({ tab: 'projects' }, MEMBER)).toBe('projects');
		expect(resolveActiveProfileTab({ tab: 'security' }, MEMBER)).toBe('security');
	});

	it('honors the MCP tab for an admin and degrades it to Account for anyone else', () => {
		expect(resolveActiveProfileTab({ tab: 'mcp' }, ADMIN)).toBe('mcp');
		expect(resolveActiveProfileTab({ tab: 'mcp' }, MEMBER)).toBe('account');
	});

	it('degrades a deep link to an unavailable tab to Account', () => {
		expect(resolveActiveProfileTab({ tab: undefined }, MEMBER)).toBe('account');
	});
});

describe('profileTabSearch', () => {
	it('builds search state for a tab', () => {
		expect(profileTabSearch('account')).toEqual({ tab: 'account' });
	});
});
