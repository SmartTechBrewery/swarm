import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveProjectCredential:
		vi.fn<(projectId: string, envVarKey: string) => Promise<string | null>>(),
}));

import { resolveProjectCredential } from '@/db/repositories/credentialsRepository.js';
import {
	getBitbucketCredential,
	getBitbucketCredentialOrNull,
	OPERATOR_BITBUCKET_TOKEN_ENV,
} from '@/integrations/scm/bitbucket/credentials.js';

const project = createMockProjectConfig();

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

	describe('reviewer — the project-scoped credential reference', () => {
		it('resolves the project’s provider-neutral reviewer reference from the store', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('reviewer-cred');

			await expect(getBitbucketCredential(project, 'reviewer')).resolves.toBe('reviewer-cred');
			expect(resolveProjectCredential).toHaveBeenCalledWith(
				project.id,
				project.credentials.reviewer,
			);
		});

		it('returns null from the …OrNull variant when nothing is stored', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);

			await expect(getBitbucketCredentialOrNull(project, 'reviewer')).resolves.toBeNull();
		});

		it('throws naming the project and the unresolved reference', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);

			await expect(getBitbucketCredential(project, 'reviewer')).rejects.toThrow(
				`No Bitbucket reviewer credential configured for project '${project.id}' (credential reference '${project.credentials.reviewer}' not found in project_credentials)`,
			);
		});
	});
});
