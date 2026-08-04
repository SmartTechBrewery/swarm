import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveProjectCredential:
		vi.fn<(projectId: string, envVarKey: string) => Promise<string | null>>(),
}));

import { resolveProjectCredential } from '@/db/repositories/credentialsRepository.js';
import {
	getGitLabToken,
	getGitLabTokenOrNull,
	OPERATOR_GITLAB_TOKEN_ENV,
} from '@/integrations/scm/gitlab/credentials.js';

const project = createMockProjectConfig();

describe('gitlab persona credentials', () => {
	beforeEach(() => {
		vi.mocked(resolveProjectCredential).mockReset();
		vi.stubEnv(OPERATOR_GITLAB_TOKEN_ENV, '');
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	describe('implementer — the worker-local operator token', () => {
		it('resolves from the operator env var, never the credential store', async () => {
			vi.stubEnv(OPERATOR_GITLAB_TOKEN_ENV, ' operator-token ');

			await expect(getGitLabToken(project, 'implementer')).resolves.toBe('operator-token');
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});

		it('returns null from the …OrNull variant when the env var is unset', async () => {
			await expect(getGitLabTokenOrNull(project, 'implementer')).resolves.toBeNull();
		});

		it('throws naming the env var when it is unset', async () => {
			await expect(getGitLabToken(project, 'implementer')).rejects.toThrow(
				new RegExp(`set ${OPERATOR_GITLAB_TOKEN_ENV} on this host`),
			);
		});
	});

	describe('reviewer — the project-scoped credential reference', () => {
		it('resolves the project’s provider-neutral reviewer reference from the store', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('reviewer-token');

			await expect(getGitLabToken(project, 'reviewer')).resolves.toBe('reviewer-token');
			expect(resolveProjectCredential).toHaveBeenCalledWith(
				project.id,
				project.credentials.reviewer,
			);
		});

		it('returns null from the …OrNull variant when nothing is stored', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);

			await expect(getGitLabTokenOrNull(project, 'reviewer')).resolves.toBeNull();
		});

		it('throws naming the project and the unresolved reference', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);

			await expect(getGitLabToken(project, 'reviewer')).rejects.toThrow(
				`No GitLab reviewer token configured for project '${project.id}' (credential reference '${project.credentials.reviewer}' not found in project_credentials)`,
			);
		});
	});
});
