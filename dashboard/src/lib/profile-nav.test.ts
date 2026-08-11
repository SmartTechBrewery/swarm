import { describe, expect, it } from 'vitest';
import {
	AVAILABLE_PROFILE_TABS,
	isProfileTabAvailable,
	PROFILE_TABS,
	profileSearchSchema,
	profileTabSearch,
	resolveActiveProfileTab,
} from './profile-nav.js';

describe('PROFILE_TABS', () => {
	it('declares the whole profile navigation structure in display order', () => {
		expect(PROFILE_TABS).toEqual(['account', 'workers', 'projects', 'security']);
	});

	it('offers only the tabs whose content is delivered', () => {
		// A tripwire: turning a follow-up tab on is a deliberate edit here, made by
		// the issue that ships its panel, not a side effect of unrelated work.
		expect([...AVAILABLE_PROFILE_TABS]).toEqual(['account']);
		expect(isProfileTabAvailable('account')).toBe(true);
		expect(isProfileTabAvailable('security')).toBe(false);
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
		expect(resolveActiveProfileTab({})).toBe('account');
	});

	it('honors an explicit, available tab', () => {
		expect(resolveActiveProfileTab({ tab: 'account' })).toBe('account');
	});

	it('degrades a deep link to a declared-but-undelivered tab to Account', () => {
		expect(resolveActiveProfileTab({ tab: 'security' })).toBe('account');
		expect(resolveActiveProfileTab({ tab: 'workers' })).toBe('account');
		expect(resolveActiveProfileTab({ tab: 'projects' })).toBe('account');
	});
});

describe('profileTabSearch', () => {
	it('builds search state for a tab', () => {
		expect(profileTabSearch('account')).toEqual({ tab: 'account' });
	});
});
