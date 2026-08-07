import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the mock factory below can use it before the hoisted `import`s run.
const { requirePmCredential } = vi.hoisted(() => ({
	requirePmCredential: vi.fn<(project: unknown, role: string) => Promise<string>>(),
}));

// A PM credential role resolves against the *registered* manifest, and Trello
// registers none until its final phase (ai/RULES.md §2), so the seam is mocked.
vi.mock('@/config/provider.js', () => ({ requirePmCredential }));

import { getScopedTrelloCredentials } from '@/integrations/pm/trello/client.js';
import {
	TRELLO_API_KEY_ROLE,
	TRELLO_TOKEN_ROLE,
	withTrelloProjectCredentials,
} from '@/integrations/pm/trello/credentials.js';
import { createMockTrelloProjectConfig } from '../../../../helpers/factories.js';

const PROJECT = createMockTrelloProjectConfig();

describe('withTrelloProjectCredentials', () => {
	beforeEach(() => {
		requirePmCredential.mockReset();
		requirePmCredential.mockImplementation(async (_project, role) =>
			role === TRELLO_API_KEY_ROLE ? 'trello-api-key' : 'trello-token',
		);
	});

	it('binds both halves of the key/token pair', async () => {
		const scoped = await withTrelloProjectCredentials(PROJECT, async () =>
			getScopedTrelloCredentials(),
		);

		expect(scoped).toEqual({ apiKey: 'trello-api-key', token: 'trello-token' });
		expect(requirePmCredential.mock.calls.map(([, role]) => role)).toEqual([
			TRELLO_API_KEY_ROLE,
			TRELLO_TOKEN_ROLE,
		]);
	});

	it('resolves no role for the webhook signing secret, which the manifest owns', async () => {
		await withTrelloProjectCredentials(PROJECT, async () => undefined);

		expect(requirePmCredential).toHaveBeenCalledTimes(2);
		expect(requirePmCredential.mock.calls.map(([, role]) => role)).not.toContain('webhookSecret');
	});

	it('propagates an unresolvable role rather than running unauthenticated', async () => {
		requirePmCredential.mockRejectedValue(new Error('PM credential role token is not configured'));

		await expect(withTrelloProjectCredentials(PROJECT, async () => 'never')).rejects.toThrow(
			/token is not configured/,
		);
	});

	it('leaves no credentials in scope after the operation', async () => {
		await withTrelloProjectCredentials(PROJECT, async () => undefined);

		expect(() => getScopedTrelloCredentials()).toThrow(/withTrelloCredentials/);
	});
});
