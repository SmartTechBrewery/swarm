import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/scm/azure-devops/client.js', () => ({
	getAzureDevOpsUserForToken: vi.fn(),
	getAzureDevOpsRepositoryDefaultBranch: vi.fn(),
}));

import { resolveScmDefaultBranch } from '@/api/scm-default-branch.js';
import { verifyScmCredentialSecret } from '@/api/scm-verification.js';
import {
	getAzureDevOpsRepositoryDefaultBranch,
	getAzureDevOpsUserForToken,
} from '@/integrations/scm/azure-devops/client.js';

// The Azure DevOps branches of the two pre-project per-provider dispatches (issue #1089
// phase 6/6). The other providers' branches are exercised through `scm.test.ts`.
describe('pre-project SCM reads — Azure DevOps', () => {
	beforeEach(() => {
		vi.mocked(getAzureDevOpsUserForToken).mockReset();
		vi.mocked(getAzureDevOpsRepositoryDefaultBranch).mockReset();
	});

	describe('verifyScmCredentialSecret', () => {
		it("resolves the PAT within the repository's organization", async () => {
			vi.mocked(getAzureDevOpsUserForToken).mockResolvedValue('guid-1');

			await expect(
				verifyScmCredentialSecret('azure-devops', 'ado-pat', 'Fabrikam/Fiber/Web'),
			).resolves.toEqual({ valid: true, login: 'guid-1' });
			expect(getAzureDevOpsUserForToken).toHaveBeenCalledWith('ado-pat', 'Fabrikam');
		});

		// An organization-scoped PAT names no account on its own, so with no repository —
		// or one that is not Azure-shaped — it reads as unverifiable, never as verified.
		it('reports invalid without a request when no Azure-shaped repository is given', async () => {
			await expect(verifyScmCredentialSecret('azure-devops', 'ado-pat')).resolves.toEqual({
				valid: false,
			});
			await expect(
				verifyScmCredentialSecret('azure-devops', 'ado-pat', 'owner/repo'),
			).resolves.toEqual({ valid: false });
			expect(getAzureDevOpsUserForToken).not.toHaveBeenCalled();
		});
	});

	describe('resolveScmDefaultBranch', () => {
		it("reads the repository's default branch through the Azure DevOps client", async () => {
			vi.mocked(getAzureDevOpsRepositoryDefaultBranch).mockResolvedValue('main');

			await expect(
				resolveScmDefaultBranch('azure-devops', 'Fabrikam/Fiber/Web', 'ado-pat'),
			).resolves.toBe('main');
			expect(getAzureDevOpsRepositoryDefaultBranch).toHaveBeenCalledWith(
				'Fabrikam/Fiber/Web',
				'ado-pat',
			);
		});
	});
});
