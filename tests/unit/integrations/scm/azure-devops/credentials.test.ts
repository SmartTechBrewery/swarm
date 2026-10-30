import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveProjectCredential:
		vi.fn<(projectId: string, envVarKey: string) => Promise<string | null>>(),
}));

import { resolveProjectCredential } from '@/db/repositories/credentialsRepository.js';
// Registers the real SCM manifests — none of them Azure DevOps, which registers
// nothing until phase 6/6 — so the "missing credential" error below is the one an
// unregistered provider gets.
import '@/integrations/entrypoint.js';
import {
	getAzureDevOpsToken,
	getAzureDevOpsTokenOrNull,
} from '@/integrations/scm/azure-devops/credentials.js';
import { withOperatorCredential } from '@/scm/operator-credential.js';

// A project that runs on this provider and stores *its* reviewer reference — never a
// shared pair, since issue #628 gave each provider its own (`credentials.scm`).
const REVIEWER_REFERENCE = 'AZURE_DEVOPS_REVIEWER_REF';
const project = createMockProjectConfig({
	scm: 'azure-devops',
	repo: 'fabrikam/Fiber Project/web',
	credentials: {
		scm: {
			'azure-devops': { reviewer: REVIEWER_REFERENCE, webhookSecret: 'AZURE_DEVOPS_HOOK_REF' },
		},
		pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
	},
});

describe('azure devops persona credentials', () => {
	beforeEach(() => {
		vi.mocked(resolveProjectCredential).mockReset();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe('implementer — the operator credential in scope (issue #1249)', () => {
		it('resolves the bound operator credential, never the store or the environment', async () => {
			vi.stubEnv('SWARM_OPERATOR_AZURE_DEVOPS_TOKEN', 'retired-env-value');

			await expect(
				withOperatorCredential('operator-pat', () => getAzureDevOpsToken(project, 'implementer')),
			).resolves.toBe('operator-pat');
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});

		it('returns null from the …OrNull variant outside an operator scope', async () => {
			await expect(getAzureDevOpsTokenOrNull(project, 'implementer')).resolves.toBeNull();
		});

		it('throws outside an operator scope without suggesting an env var', async () => {
			const failure = getAzureDevOpsToken(project, 'implementer');
			await expect(failure).rejects.toThrow('No Azure DevOps implementer credential is in scope');
			await expect(failure).rejects.not.toThrow(/SWARM_OPERATOR_/);
		});
	});

	describe('reviewer — the project-scoped, per-provider credential reference', () => {
		it('resolves Azure DevOps’ own reviewer reference from the store', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('reviewer-pat');

			await expect(getAzureDevOpsToken(project, 'reviewer')).resolves.toBe('reviewer-pat');
			expect(resolveProjectCredential).toHaveBeenCalledWith(project.id, REVIEWER_REFERENCE);
		});

		it('returns null from the …OrNull variant when nothing is stored', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);

			await expect(getAzureDevOpsTokenOrNull(project, 'reviewer')).resolves.toBeNull();
		});

		// A project holding only GitHub's reviewer token must fail here rather than
		// authenticate as GitHub's account.
		it('never falls back to a GitHub reviewer reference', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('github-token');
			const githubOnly = createMockProjectConfig({
				scm: 'azure-devops',
				repo: 'fabrikam/Fiber Project/web',
				credentials: {
					scm: { github: { reviewer: 'GITHUB_REVIEWER_REF' } },
					pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
				},
			});

			await expect(getAzureDevOpsTokenOrNull(githubOnly, 'reviewer')).resolves.toBeNull();
			await expect(getAzureDevOpsToken(githubOnly, 'reviewer')).rejects.toThrow(
				/credentials\.scm\.azure-devops\.reviewer/,
			);
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});

		it('throws naming the project and the reference to set', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);

			await expect(getAzureDevOpsToken(project, 'reviewer')).rejects.toThrow(
				`No Azure DevOps reviewer credential configured for project '${project.id}' ` +
					'(set credentials.scm.azure-devops.reviewer to a stored reference; ' +
					'AZURE_DEVOPS_TOKEN_REVIEWER is its conventional config-apply key)',
			);
		});
	});
});
