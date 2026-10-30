import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveProjectCredential:
		vi.fn<(projectId: string, envVarKey: string) => Promise<string | null>>(),
}));

import { resolveProjectCredential } from '@/db/repositories/credentialsRepository.js';
// Registers the real SCM manifests, so the "missing credential" error below names
// this provider's label and its own conventional env var key (issue #628).
import '@/integrations/entrypoint.js';
import {
	getBitbucketCredential,
	getBitbucketCredentialOrNull,
} from '@/integrations/scm/bitbucket/credentials.js';
import { withOperatorCredential } from '@/scm/operator-credential.js';

// A project that runs on this provider and stores *its* reviewer reference — never a
// shared pair, since issue #628 gave each provider its own (`credentials.scm`).
const REVIEWER_REFERENCE = 'BITBUCKET_REVIEWER_REF';
const project = createMockProjectConfig({
	scm: 'bitbucket',
	credentials: {
		scm: { bitbucket: { reviewer: REVIEWER_REFERENCE, webhookSecret: 'BITBUCKET_HOOK_REF' } },
		pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
	},
});

describe('bitbucket persona credentials', () => {
	beforeEach(() => {
		vi.mocked(resolveProjectCredential).mockReset();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe('implementer — the operator credential in scope (issue #1249)', () => {
		it('resolves the bound operator credential, never the store or the environment', async () => {
			vi.stubEnv('SWARM_OPERATOR_BITBUCKET_TOKEN', 'retired-env-value');

			await expect(
				withOperatorCredential('operator-cred', () =>
					getBitbucketCredential(project, 'implementer'),
				),
			).resolves.toBe('operator-cred');
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});

		it('returns null from the …OrNull variant outside an operator scope', async () => {
			await expect(getBitbucketCredentialOrNull(project, 'implementer')).resolves.toBeNull();
		});

		it('throws outside an operator scope without suggesting an env var', async () => {
			const failure = getBitbucketCredential(project, 'implementer');
			await expect(failure).rejects.toThrow('No Bitbucket implementer credential is in scope');
			await expect(failure).rejects.not.toThrow(/SWARM_OPERATOR_/);
		});
	});

	describe('reviewer — the project-scoped, per-provider credential reference', () => {
		it('resolves Bitbucket’s own reviewer reference from the store', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('reviewer-cred');

			await expect(getBitbucketCredential(project, 'reviewer')).resolves.toBe('reviewer-cred');
			expect(resolveProjectCredential).toHaveBeenCalledWith(project.id, REVIEWER_REFERENCE);
		});

		it('returns null from the …OrNull variant when nothing is stored', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);

			await expect(getBitbucketCredentialOrNull(project, 'reviewer')).resolves.toBeNull();
		});

		// The criterion this issue turns on: a project holding only *another* provider's
		// reviewer token must fail here rather than authenticate as that provider's account.
		it('never falls back to another provider’s reviewer reference', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('github-cred');
			const githubOnly = createMockProjectConfig({
				scm: 'bitbucket',
				credentials: {
					scm: { github: { reviewer: 'GITHUB_REVIEWER_REF' } },
					pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
				},
			});

			await expect(getBitbucketCredentialOrNull(githubOnly, 'reviewer')).resolves.toBeNull();
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});

		it('throws naming the project, the reference to set, and Bitbucket’s own env var key', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);

			await expect(getBitbucketCredential(project, 'reviewer')).rejects.toThrow(
				`No Bitbucket reviewer credential configured for project '${project.id}' ` +
					'(set credentials.scm.bitbucket.reviewer to a stored reference; ' +
					'BITBUCKET_TOKEN_REVIEWER is its conventional config-apply key)',
			);
		});
	});
});
