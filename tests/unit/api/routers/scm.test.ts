import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/scm/github/client.js', () => ({
	getGitHubUserForToken: vi.fn(),
}));

vi.mock('@/integrations/scm/gitlab/client.js', () => ({
	getGitLabUserForToken: vi.fn(),
}));

// The default-branch read's two collaborators (issue #884): the provider dispatch and
// the instance-credential tier the secret comes from. Mocked the way
// `projects.test.ts` mocks the latter — the procedure's job is which credential it
// resolves and what it does when there is none, not the provider call itself.
vi.mock('@/api/scm-default-branch.js', () => ({
	resolveScmDefaultBranch: vi.fn(),
}));

vi.mock('@/db/repositories/instanceCredentialsRepository.js', () => ({
	resolveInstanceScmCredential: vi.fn(),
}));

import { scmRouter } from '@/api/routers/scm.js';
import { resolveScmDefaultBranch } from '@/api/scm-default-branch.js';
import { resolveInstanceScmCredential } from '@/db/repositories/instanceCredentialsRepository.js';
import { getGitHubUserForToken } from '@/integrations/scm/github/client.js';
import { getGitLabUserForToken } from '@/integrations/scm/gitlab/client.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';

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
		vi.mocked(resolveScmDefaultBranch).mockReset();
		vi.mocked(resolveInstanceScmCredential).mockReset();
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

	// Issue #884: the second pre-project read on this router. It authenticates with the
	// installation's default credential for the selected provider — the same secret
	// `projects.create` already requires and seeds — and answers `{ branch: null }` for
	// every way the read can fail, because the dialog's response to all of them is to
	// keep the value already in its field.
	describe('defaultBranch', () => {
		// A stub manifest rather than a hand-picked role name: the procedure reads which
		// role is eligible off the registry, so a hardcoded `'reviewer'` would keep
		// passing after a provider renamed its own.
		beforeEach(() => {
			_resetSCMProviderRegistryForTesting();
			registerSCMProvider({
				id: 'github',
				label: 'Stub',
				category: 'scm',
				webhookRoute: '/stub/webhook',
				credentialRoles: [
					{ role: 'reviewer', envVarKey: 'SCM_STUB_TOKEN_REVIEWER', instanceDefault: true },
					{ role: 'webhookSecret', envVarKey: 'SCM_STUB_WEBHOOK_SECRET' },
				],
			} as unknown as SCMProviderManifest);
		});

		it('returns the branch the provider reports, read with the resolved instance credential', async () => {
			vi.mocked(resolveInstanceScmCredential).mockResolvedValue('ghp_instance_default');
			vi.mocked(resolveScmDefaultBranch).mockResolvedValue('develop');

			const result = await caller.defaultBranch({ scm: 'github', repo: 'team/swarm' });

			expect(result).toEqual({ branch: 'develop' });
			expect(resolveInstanceScmCredential).toHaveBeenCalledWith('github', 'reviewer');
			expect(resolveScmDefaultBranch).toHaveBeenCalledWith(
				'github',
				'team/swarm',
				'ghp_instance_default',
			);
		});

		it('returns a null branch when the provider answers nothing', async () => {
			vi.mocked(resolveInstanceScmCredential).mockResolvedValue('ghp_instance_default');
			vi.mocked(resolveScmDefaultBranch).mockResolvedValue(null);

			expect(await caller.defaultBranch({ scm: 'github', repo: 'team/swarm' })).toEqual({
				branch: null,
			});
		});

		// "No credential recorded" is not an error: a project cannot be created on that
		// provider anyway (`requireInstanceScmDefaults` refuses), and the dialog's note is
		// the same one an unreadable repository produces.
		it('returns a null branch without touching the provider when no instance credential is recorded', async () => {
			vi.mocked(resolveInstanceScmCredential).mockResolvedValue(null);

			expect(await caller.defaultBranch({ scm: 'github', repo: 'team/swarm' })).toEqual({
				branch: null,
			});
			expect(resolveScmDefaultBranch).not.toHaveBeenCalled();
		});

		it('returns a null branch without touching the provider when the provider declares no eligible role', async () => {
			_resetSCMProviderRegistryForTesting();

			expect(await caller.defaultBranch({ scm: 'github', repo: 'team/swarm' })).toEqual({
				branch: null,
			});
			expect(resolveInstanceScmCredential).not.toHaveBeenCalled();
			expect(resolveScmDefaultBranch).not.toHaveBeenCalled();
		});

		it('rejects a repo that is not owner/repo before resolving anything', async () => {
			await expect(caller.defaultBranch({ scm: 'github', repo: 'swarm' })).rejects.toThrow();
			expect(resolveInstanceScmCredential).not.toHaveBeenCalled();
			expect(resolveScmDefaultBranch).not.toHaveBeenCalled();
		});

		it('rejects a provider id outside the closed SCM vocabulary', async () => {
			await expect(
				caller.defaultBranch({
					scm: 'subversion' as unknown as 'github',
					repo: 'team/swarm',
				}),
			).rejects.toThrow();
			expect(resolveScmDefaultBranch).not.toHaveBeenCalled();
		});
	});
});
