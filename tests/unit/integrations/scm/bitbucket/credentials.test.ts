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
	OPERATOR_BITBUCKET_TOKEN_ENV,
} from '@/integrations/scm/bitbucket/credentials.js';

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
		vi.stubEnv(OPERATOR_BITBUCKET_TOKEN_ENV, '');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe('implementer — the worker-local operator credential', () => {
		it('resolves from the operator env var, never the credential store', async () => {
			vi.stubEnv(OPERATOR_BITBUCKET_TOKEN_ENV, ' operator-cred ');

			await expect(getBitbucketCredential(project, 'implementer')).resolves.toBe('operator-cred');
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});

		it('returns null from the …OrNull variant when the env var is unset', async () => {
			await expect(getBitbucketCredentialOrNull(project, 'implementer')).resolves.toBeNull();
		});

		it('throws naming the env var when it is unset', async () => {
			await expect(getBitbucketCredential(project, 'implementer')).rejects.toThrow(
				new RegExp(`set ${OPERATOR_BITBUCKET_TOKEN_ENV} on this host`),
			);
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
