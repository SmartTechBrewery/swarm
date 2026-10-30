import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/integrations/scm/azure-devops/client.js', async (importOriginal) => ({
	// The real coordinate parser, so the organization comes from `project.repo`.
	azureRepoCoordinates: (
		await importOriginal<typeof import('@/integrations/scm/azure-devops/client.js')>()
	).azureRepoCoordinates,
	getAzureDevOpsUserForToken:
		vi.fn<(pat: string | null, organization: string) => Promise<string | null>>(),
}));
vi.mock('@/integrations/scm/azure-devops/credentials.js', () => ({
	getAzureDevOpsTokenOrNull:
		vi.fn<(project: unknown, persona: 'implementer' | 'reviewer') => Promise<string | null>>(),
}));

import { getAzureDevOpsUserForToken } from '@/integrations/scm/azure-devops/client.js';
import { getAzureDevOpsTokenOrNull } from '@/integrations/scm/azure-devops/credentials.js';
import {
	_resetAzureDevOpsPersonaIdentityCache,
	isAzureDevOpsReviewer,
	resolveAzureDevOpsReviewerIdentity,
} from '@/integrations/scm/azure-devops/personas.js';

const REV_ID = '7e2d3b4c-0000-4000-8000-00000000000b';
const project = createMockProjectConfig({
	scm: 'azure-devops',
	repo: 'fabrikam/Fiber Project/web',
});

/** The reviewer resolves to a token, and that to its own identity id. */
function stubHappyPath(): void {
	vi.mocked(getAzureDevOpsTokenOrNull).mockResolvedValue('pat-rev');
	vi.mocked(getAzureDevOpsUserForToken).mockResolvedValue(REV_ID);
}

describe('azure-devops reviewer identity', () => {
	beforeEach(() => {
		_resetAzureDevOpsPersonaIdentityCache();
		vi.mocked(getAzureDevOpsTokenOrNull).mockReset();
		vi.mocked(getAzureDevOpsUserForToken).mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('isAzureDevOpsReviewer', () => {
		it('recognizes the reviewer identity id, case-insensitively', () => {
			expect(isAzureDevOpsReviewer(REV_ID, REV_ID)).toBe(true);
			expect(isAzureDevOpsReviewer(REV_ID.toUpperCase(), REV_ID)).toBe(true);
		});

		it('does not match an operator account or a human', () => {
			expect(isAzureDevOpsReviewer('6f1c2a3b-0000-4000-8000-00000000000a', REV_ID)).toBe(false);
			expect(isAzureDevOpsReviewer('some-human', REV_ID)).toBe(false);
		});
	});

	describe('resolveAzureDevOpsReviewerIdentity', () => {
		it('resolves the reviewer from its own token alone — no implementer credential', async () => {
			stubHappyPath();

			await expect(resolveAzureDevOpsReviewerIdentity(project)).resolves.toBe(REV_ID);
			expect(getAzureDevOpsTokenOrNull).toHaveBeenCalledWith(project, 'reviewer');
			expect(getAzureDevOpsTokenOrNull).not.toHaveBeenCalledWith(project, 'implementer');
			expect(vi.mocked(getAzureDevOpsUserForToken)).toHaveBeenCalledWith('pat-rev', 'fabrikam');
		});

		it('caches per project — a second call does not re-resolve', async () => {
			stubHappyPath();

			await resolveAzureDevOpsReviewerIdentity(project);
			await resolveAzureDevOpsReviewerIdentity(project);

			expect(vi.mocked(getAzureDevOpsUserForToken)).toHaveBeenCalledTimes(1);
		});

		it('re-resolves once the 60s TTL has expired', async () => {
			stubHappyPath();
			vi.useFakeTimers();

			await resolveAzureDevOpsReviewerIdentity(project);
			vi.advanceTimersByTime(60_001);
			await resolveAzureDevOpsReviewerIdentity(project);

			expect(vi.mocked(getAzureDevOpsUserForToken)).toHaveBeenCalledTimes(2);
		});

		it('fails closed when the reviewer identity cannot be resolved', async () => {
			vi.mocked(getAzureDevOpsTokenOrNull).mockResolvedValue(null);
			vi.mocked(getAzureDevOpsUserForToken).mockResolvedValue(null);

			await expect(resolveAzureDevOpsReviewerIdentity(project)).rejects.toThrow(/reviewer/);
		});

		it('does not cache a failure — the next call retries', async () => {
			vi.mocked(getAzureDevOpsTokenOrNull).mockResolvedValue(null);
			vi.mocked(getAzureDevOpsUserForToken).mockResolvedValue(null);
			await expect(resolveAzureDevOpsReviewerIdentity(project)).rejects.toThrow();

			stubHappyPath();
			await expect(resolveAzureDevOpsReviewerIdentity(project)).resolves.toBe(REV_ID);
		});
	});
});
