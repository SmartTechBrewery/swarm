import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the mock factory below can use it before the hoisted `import`s run.
const { requirePmCredential } = vi.hoisted(() => ({
	requirePmCredential: vi.fn<(project: unknown, role: string) => Promise<string>>(),
}));

// A PM credential role resolves against the *registered* manifest, and Jira
// registers none until its final phase (ai/RULES.md §2), so the seam is mocked.
vi.mock('@/config/provider.js', () => ({ requirePmCredential }));

import { getScopedJiraCredentials } from '@/integrations/pm/jira/client.js';
import {
	JIRA_API_TOKEN_ROLE,
	JIRA_EMAIL_ROLE,
	withJiraProjectCredentials,
} from '@/integrations/pm/jira/credentials.js';
import { createMockJiraProjectConfig } from '../../../../helpers/factories.js';

const PROJECT = createMockJiraProjectConfig();

describe('withJiraProjectCredentials', () => {
	beforeEach(() => {
		requirePmCredential.mockReset();
		requirePmCredential.mockImplementation(async (_project, role) =>
			role === JIRA_EMAIL_ROLE ? 'bot@example.com' : 'jira-api-token',
		);
	});

	it('binds both basic-auth roles plus the configured site base URL', async () => {
		const scoped = await withJiraProjectCredentials(PROJECT, async () =>
			getScopedJiraCredentials(),
		);

		expect(scoped).toEqual({
			email: 'bot@example.com',
			apiToken: 'jira-api-token',
			// The site URL is board config, never a credential role (issue #490).
			baseUrl: 'https://example.atlassian.net',
		});
		expect(requirePmCredential.mock.calls.map(([, role]) => role)).toEqual([
			JIRA_EMAIL_ROLE,
			JIRA_API_TOKEN_ROLE,
		]);
	});

	it('resolves no credential role for the base URL', async () => {
		await withJiraProjectCredentials(PROJECT, async () => undefined);

		expect(requirePmCredential).toHaveBeenCalledTimes(2);
		expect(requirePmCredential.mock.calls.map(([, role]) => role)).not.toContain('baseUrl');
	});

	it('propagates an unresolvable role rather than running unauthenticated', async () => {
		requirePmCredential.mockRejectedValue(
			new Error('PM credential role apiToken is not configured'),
		);

		await expect(withJiraProjectCredentials(PROJECT, async () => 'never')).rejects.toThrow(
			/apiToken is not configured/,
		);
	});

	it('leaves no credentials in scope after the operation', async () => {
		await withJiraProjectCredentials(PROJECT, async () => undefined);

		expect(() => getScopedJiraCredentials()).toThrow(/withJiraCredentials/);
	});
});
