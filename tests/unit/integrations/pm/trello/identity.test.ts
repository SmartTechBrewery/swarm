import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the mock factory below can use it before the hoisted `import`s run.
const { requirePmCredential } = vi.hoisted(() => ({
	requirePmCredential: vi.fn<(project: unknown, role: string) => Promise<string>>(),
}));

// A PM credential role resolves against the *registered* manifest, and Trello
// registers none until its final phase (ai/RULES.md §2), so the seam is mocked.
// `fetch` is the only other stand-in, so the real client and its key/token query
// scoping run.
vi.mock('@/config/provider.js', () => ({ requirePmCredential }));

import { resolveTrelloMemberId } from '@/integrations/pm/trello/identity.js';
import { createMockTrelloProjectConfig } from '../../../../helpers/factories.js';

const PROJECT = createMockTrelloProjectConfig({ id: 'proj-trello' });
const MEMBER_ID = '5d1b2c3d4e5f60718293a4b5';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function respondWith(body: unknown, status = 200): void {
	fetchMock.mockResolvedValue(
		new Response(body === undefined ? null : JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		}),
	);
}

describe('resolveTrelloMemberId', () => {
	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
		requirePmCredential.mockImplementation(async (_project, role) =>
			role === 'apiKey' ? 'trello-api-key' : 'trello-token',
		);
	});

	it("reads the member behind the project's own key/token pair", async () => {
		respondWith({ id: MEMBER_ID });

		expect(await resolveTrelloMemberId(PROJECT)).toBe(MEMBER_ID);

		const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(url.pathname).toBe('/1/members/me');
		expect(url.searchParams.get('fields')).toBe('id');
		// The credential is the provider's own, scoped by `withTrelloProjectCredentials`
		// — never a function argument, and never an SCM identity (ai/RULES.md §2).
		expect(url.searchParams.get('key')).toBe('trello-api-key');
		expect(url.searchParams.get('token')).toBe('trello-token');
	});

	// The caller (the loop-prevention gate) fails open on a throw, so an
	// unresolvable identity must throw rather than answer a falsy member id that
	// would compare equal to a delivery carrying none.
	it.each([
		['a body with no id', {}],
		['an empty body', undefined],
	])('throws naming the project for %s', async (_label, body) => {
		respondWith(body);

		await expect(resolveTrelloMemberId(PROJECT)).rejects.toThrow(/proj-trello/);
	});

	it('propagates a failed API call', async () => {
		respondWith({ message: 'invalid token' }, 401);

		await expect(resolveTrelloMemberId(PROJECT)).rejects.toThrow(
			/Trello API request failed \(401\)/,
		);
	});
});
