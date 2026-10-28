import { describe, expect, it } from 'vitest';
import { PM_MAPPING_PROVIDERS } from './board-mapping.js';
import {
	groupIdentitiesByUser,
	IDENTITY_HANDLE_COPY,
	IDENTITY_PROVIDER_OPTIONS,
	identityProviderLabel,
	type LinkedIdentity,
} from './identity-links.js';

function identity(userId: string, provider: string, handle: string): LinkedIdentity {
	return { id: `${provider}:${handle}`, userId, provider, handle, createdAt: '2026-10-01' };
}

describe('identity links (issue #1167)', () => {
	it('has handle copy for every catalogued PM provider', () => {
		for (const provider of PM_MAPPING_PROVIDERS) {
			const copy = IDENTITY_HANDLE_COPY[provider.id];
			expect(copy.handleLabel).not.toBe('');
			expect(copy.hint).not.toBe('');
			expect(copy.placeholder).not.toBe('');
		}
	});

	it("labels each option with the provider's own catalogue name", () => {
		expect(IDENTITY_PROVIDER_OPTIONS.map((o) => [o.id, o.label])).toEqual(
			PM_MAPPING_PROVIDERS.map((p) => [p.id, p.label]),
		);
	});

	it('labels a stored provider, falling back to the raw key rather than GitHub', () => {
		expect(identityProviderLabel('jira')).toBe('Jira');
		expect(identityProviderLabel('legacy-pm')).toBe('legacy-pm');
	});

	it('groups links by user, keeping their order', () => {
		const grouped = groupIdentitiesByUser([
			identity('a', 'github-projects', 'ada'),
			identity('b', 'jira', 'x'),
			identity('a', 'jira', 'y'),
		]);
		expect(grouped.get('a')?.map((i) => i.handle)).toEqual(['ada', 'y']);
		expect(grouped.get('b')?.map((i) => i.handle)).toEqual(['x']);
		expect(grouped.get('c')).toBeUndefined();
	});
});
