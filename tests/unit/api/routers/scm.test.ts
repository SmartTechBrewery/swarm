import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/scm/github/client.js', () => ({
	getGitHubUserForToken: vi.fn(),
}));

vi.mock('@/integrations/scm/gitlab/client.js', () => ({
	getGitLabUserForToken: vi.fn(),
}));

import { scmRouter } from '@/api/routers/scm.js';
import { getGitHubUserForToken } from '@/integrations/scm/github/client.js';
import { getGitLabUserForToken } from '@/integrations/scm/gitlab/client.js';

describe('scmRouter', () => {
	const AUTHED_USER = {
		id: '00000000-0000-4000-8000-000000000000',
		identifier: 'tester@example.com',
		displayName: 'Tester',
		instanceAdmin: true,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
	const caller = scmRouter.createCaller({ user: AUTHED_USER });

	beforeEach(() => {
		vi.mocked(getGitHubUserForToken).mockReset();
		vi.mocked(getGitLabUserForToken).mockReset();
	});

	describe('verifyGithubToken', () => {
		it('returns the resolved login when the token is valid', async () => {
			vi.mocked(getGitHubUserForToken).mockResolvedValue('octocat');

			const result = await caller.verifyGithubToken({ token: 'test-token-valid' });

			expect(result).toEqual({ valid: true, login: 'octocat' });
			expect(getGitHubUserForToken).toHaveBeenCalledWith('test-token-valid');
		});

		it('returns a not-valid result when the token does not resolve', async () => {
			vi.mocked(getGitHubUserForToken).mockResolvedValue(null);

			const result = await caller.verifyGithubToken({ token: 'test-token-invalid' });

			expect(result).toEqual({ valid: false });
		});

		it('rejects an empty token before calling GitHub', async () => {
			await expect(caller.verifyGithubToken({ token: '' })).rejects.toThrow();
			expect(getGitHubUserForToken).not.toHaveBeenCalled();
		});
	});

	// GitLab's own procedure, added with issue #619 when the provider became
	// runtime-selectable: the dashboard has a pasted secret and a provider name but no
	// project, so verification cannot go through a resolved `SCMProvider`.
	describe('verifyGitLabToken', () => {
		it('returns the resolved username when the token is valid', async () => {
			vi.mocked(getGitLabUserForToken).mockResolvedValue('reviewer-bot');

			const result = await caller.verifyGitLabToken({ token: 'glpat-valid' });

			expect(result).toEqual({ valid: true, login: 'reviewer-bot' });
			expect(getGitLabUserForToken).toHaveBeenCalledWith('glpat-valid');
			expect(getGitHubUserForToken).not.toHaveBeenCalled();
		});

		it('returns a not-valid result when the token does not resolve', async () => {
			vi.mocked(getGitLabUserForToken).mockResolvedValue(null);

			expect(await caller.verifyGitLabToken({ token: 'glpat-invalid' })).toEqual({ valid: false });
		});

		it('rejects an empty token before calling GitLab', async () => {
			await expect(caller.verifyGitLabToken({ token: '' })).rejects.toThrow();
			expect(getGitLabUserForToken).not.toHaveBeenCalled();
		});
	});
});
