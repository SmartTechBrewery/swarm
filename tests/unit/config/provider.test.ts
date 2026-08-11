import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../helpers/factories.js';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveProjectCredential: vi.fn(),
}));
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByRepoFromDb: vi.fn(),
	findProjectByBoardFromDb: vi.fn(),
	findProjectByPmContainerFromDb: vi.fn(),
}));

import {
	findProjectByBoard,
	findProjectByLinearTeam,
	findProjectByRepo,
	getPersonaToken,
	getPersonaTokenOrNull,
	getWebhookSecretOrNull,
	requireScmCredential,
	resolveScmCredentialOrNull,
} from '@/config/provider.js';
import { resolveProjectCredential } from '@/db/repositories/credentialsRepository.js';
import {
	findProjectByBoardFromDb,
	findProjectByPmContainerFromDb,
	findProjectByRepoFromDb,
} from '@/db/repositories/projectsRepository.js';
// Registers the real SCM manifests, whose declared `envVarKey`s the "missing
// credential" errors below name — the criterion that a project asked for GitLab is
// told about GitLab, never handed GitHub's secret (issue #628).
import '@/integrations/entrypoint.js';

// A pre-#628 config: the legacy shared pair, which the schema's adoption normalizer
// files under the provider the project runs on (here an unstated `scm`, so GitHub).
const project = createMockProjectConfig({
	id: 'proj-1',
	credentials: {
		reviewer: 'REV_TOKEN_KEY',
		webhookSecret: 'WEBHOOK_KEY',
		// Required by the registered GitHub Projects manifest (issue #537).
		pm: { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
	},
});

describe('config provider', () => {
	beforeEach(() => {
		vi.mocked(resolveProjectCredential).mockReset();
		vi.mocked(findProjectByRepoFromDb).mockReset();
		vi.mocked(findProjectByBoardFromDb).mockReset();
		vi.mocked(findProjectByPmContainerFromDb).mockReset();
		delete process.env.SWARM_OPERATOR_GH_TOKEN;
	});

	afterEach(() => {
		delete process.env.SWARM_OPERATOR_GH_TOKEN;
	});

	describe('findProjectByRepo', () => {
		it('delegates to the repository', async () => {
			vi.mocked(findProjectByRepoFromDb).mockResolvedValue(project);
			expect(await findProjectByRepo('SmartTechBrewery/swarm')).toBe(project);
			expect(findProjectByRepoFromDb).toHaveBeenCalledWith('SmartTechBrewery/swarm');
		});
	});

	describe('findProjectByBoard', () => {
		it('delegates to the repository with the board node ID', async () => {
			vi.mocked(findProjectByBoardFromDb).mockResolvedValue(project);
			expect(await findProjectByBoard('PVT_kwHOAC3TF84BcNwD')).toBe(project);
			expect(findProjectByBoardFromDb).toHaveBeenCalledWith('PVT_kwHOAC3TF84BcNwD');
		});
	});

	describe('findProjectByLinearTeam', () => {
		// Its own lookup rather than the board one (issue #529): the provider names
		// both the `pm_type` it owns and the `pm_config` key that holds its container,
		// so two providers' blobs cannot collide on a shared key.
		it("delegates to the container lookup with Linear's provider id and container key", async () => {
			vi.mocked(findProjectByPmContainerFromDb).mockResolvedValue(project);
			expect(await findProjectByLinearTeam('team-uuid')).toBe(project);
			expect(findProjectByPmContainerFromDb).toHaveBeenCalledWith('linear', 'teamId', 'team-uuid');
			expect(findProjectByBoardFromDb).not.toHaveBeenCalled();
		});

		it('returns undefined for an untracked team', async () => {
			vi.mocked(findProjectByPmContainerFromDb).mockResolvedValue(undefined);
			expect(await findProjectByLinearTeam('team-unknown')).toBeUndefined();
		});
	});

	describe('getPersonaTokenOrNull', () => {
		it('resolves the implementer persona from the worker-local operator env var', async () => {
			process.env.SWARM_OPERATOR_GH_TOKEN = 'operator-token';
			const token = await getPersonaTokenOrNull(project, 'implementer');
			expect(token).toBe('operator-token');
			// The implementer never touches project_credentials (issue #396).
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});

		it('returns null for the implementer when the operator env var is unset', async () => {
			expect(await getPersonaTokenOrNull(project, 'implementer')).toBeNull();
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});

		it('uses the reviewer reference for the reviewer persona', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('test-token-reviewer');
			await getPersonaTokenOrNull(project, 'reviewer');
			expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'REV_TOKEN_KEY');
		});

		it('returns null when the reviewer reference resolves to nothing', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);
			expect(await getPersonaTokenOrNull(project, 'reviewer')).toBeNull();
		});
	});

	describe('getPersonaToken', () => {
		it('returns the implementer operator token when configured', async () => {
			process.env.SWARM_OPERATOR_GH_TOKEN = 'operator-token';
			expect(await getPersonaToken(project, 'implementer')).toBe('operator-token');
		});

		it('throws an actionable SWARM_OPERATOR_GH_TOKEN error when the implementer token is unset', async () => {
			await expect(getPersonaToken(project, 'implementer')).rejects.toThrow(
				/SWARM_OPERATOR_GH_TOKEN/,
			);
		});

		it('throws when the reviewer token is not configured', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);
			await expect(getPersonaToken(project, 'reviewer')).rejects.toThrow(
				/No GitHub reviewer credential configured for project 'proj-1'/,
			);
		});
	});

	describe('getWebhookSecretOrNull', () => {
		it("resolves the named provider's webhook-secret reference to its secret", async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('whsec_123');
			expect(await getWebhookSecretOrNull(project, 'github')).toBe('whsec_123');
			expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'WEBHOOK_KEY');
		});

		it('returns null when the reference resolves to nothing', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);
			expect(await getWebhookSecretOrNull(project, 'github')).toBeNull();
		});

		// The receiver passes the *delivering* provider's id, so a project that stores no
		// secret for it must not be verified against another provider's (issue #628).
		it('reads only the named provider, never a sibling provider’s secret', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('whsec_123');
			expect(await getWebhookSecretOrNull(project, 'bitbucket')).toBeNull();
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});
	});

	// Issue #628's acceptance criteria, directly: a project may hold several providers'
	// credentials at once, each resolves independently, and a missing one fails with its
	// own error rather than resolving a sibling's.
	describe('per-provider SCM credentials', () => {
		const multiProvider = createMockProjectConfig({
			id: 'multi',
			scm: 'gitlab',
			credentials: {
				scm: {
					github: { reviewer: 'GH_REVIEWER', webhookSecret: 'GH_HOOK' },
					gitlab: { reviewer: 'GL_REVIEWER', webhookSecret: 'GL_HOOK' },
				},
				pm: { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
			},
		});

		it('resolves each provider through its own reference', async () => {
			vi.mocked(resolveProjectCredential).mockImplementation(async (_id, key) => `secret:${key}`);

			expect(await resolveScmCredentialOrNull(multiProvider, 'github', 'reviewer')).toBe(
				'secret:GH_REVIEWER',
			);
			expect(await resolveScmCredentialOrNull(multiProvider, 'gitlab', 'reviewer')).toBe(
				'secret:GL_REVIEWER',
			);
			expect(await resolveScmCredentialOrNull(multiProvider, 'gitlab', 'webhookSecret')).toBe(
				'secret:GL_HOOK',
			);
		});

		// Retained credentials for a provider the project is not running on are stored but
		// never resolved: `resolveScmCredentialOrNull` is not a fallback chain.
		it('returns null for a provider the project stores nothing for', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('anything');
			expect(await resolveScmCredentialOrNull(multiProvider, 'bitbucket', 'reviewer')).toBeNull();
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});

		it('throws naming the asked-for provider, role and its conventional env var key', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('github-secret');

			// `project` holds GitHub's references only — asking for GitLab must fail rather
			// than hand back the GitHub secret the mock would happily return.
			await expect(requireScmCredential(project, 'gitlab', 'reviewer')).rejects.toThrow(
				"No GitLab reviewer credential configured for project 'proj-1' " +
					'(set credentials.scm.gitlab.reviewer to a stored reference; ' +
					'GITLAB_TOKEN_REVIEWER is its conventional config-apply key)',
			);
		});

		it('throws when the provider is named but its stored secret is absent', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);
			await expect(requireScmCredential(multiProvider, 'gitlab', 'webhookSecret')).rejects.toThrow(
				/GITLAB_WEBHOOK_SECRET is its conventional config-apply key/,
			);
			expect(resolveProjectCredential).toHaveBeenCalledWith('multi', 'GL_HOOK');
		});
	});
});
