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
	getAzureDevOpsPersonaForLogin,
	isSwarmAzureDevOpsActor,
	resolveAzureDevOpsPersonaIdentities,
} from '@/integrations/scm/azure-devops/personas.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';

const IMPL_ID = '6f1c2a3b-0000-4000-8000-00000000000a';
const REV_ID = '7e2d3b4c-0000-4000-8000-00000000000b';
const IDENTITIES: ScmPersonaIdentities = { implementer: IMPL_ID, reviewer: REV_ID };
const project = createMockProjectConfig({
	scm: 'azure-devops',
	repo: 'fabrikam/Fiber Project/web',
});

/** Both personas resolve to a token, and each token to its own identity id. */
function stubHappyPath(): void {
	vi.mocked(getAzureDevOpsTokenOrNull).mockImplementation(async (_p, persona) =>
		persona === 'implementer' ? 'pat-impl' : 'pat-rev',
	);
	vi.mocked(getAzureDevOpsUserForToken).mockImplementation(async (pat) =>
		pat === 'pat-impl' ? IMPL_ID : REV_ID,
	);
}

describe('azure devops personas', () => {
	beforeEach(() => {
		_resetAzureDevOpsPersonaIdentityCache();
		vi.mocked(getAzureDevOpsTokenOrNull).mockReset();
		vi.mocked(getAzureDevOpsUserForToken).mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('isSwarmAzureDevOpsActor', () => {
		it('recognizes both persona identity ids', () => {
			expect(isSwarmAzureDevOpsActor(IMPL_ID, IDENTITIES)).toBe(true);
			expect(isSwarmAzureDevOpsActor(REV_ID, IDENTITIES)).toBe(true);
		});

		it('matches GUIDs case-insensitively — loop prevention must fail closed', () => {
			expect(isSwarmAzureDevOpsActor(IMPL_ID.toUpperCase(), IDENTITIES)).toBe(true);
		});

		it('does not flag a human identity', () => {
			expect(isSwarmAzureDevOpsActor('00000000-0000-4000-8000-000000000000', IDENTITIES)).toBe(
				false,
			);
		});
	});

	describe('getAzureDevOpsPersonaForLogin', () => {
		it('maps each persona, case-insensitively', () => {
			expect(getAzureDevOpsPersonaForLogin(IMPL_ID, IDENTITIES)).toBe('implementer');
			expect(getAzureDevOpsPersonaForLogin(REV_ID.toUpperCase(), IDENTITIES)).toBe('reviewer');
		});

		it('returns null for an identity that is neither persona', () => {
			expect(getAzureDevOpsPersonaForLogin('someone-else', IDENTITIES)).toBeNull();
		});
	});

	describe('resolveAzureDevOpsPersonaIdentities', () => {
		it('resolves both identities from their own tokens, in the project’s organization', async () => {
			stubHappyPath();

			await expect(resolveAzureDevOpsPersonaIdentities(project)).resolves.toEqual(IDENTITIES);
			expect(vi.mocked(getAzureDevOpsUserForToken)).toHaveBeenCalledWith('pat-impl', 'fabrikam');
			expect(vi.mocked(getAzureDevOpsUserForToken)).toHaveBeenCalledWith('pat-rev', 'fabrikam');
		});

		it('caches per project — a second call does not re-resolve', async () => {
			stubHappyPath();

			await resolveAzureDevOpsPersonaIdentities(project);
			await resolveAzureDevOpsPersonaIdentities(project);

			expect(vi.mocked(getAzureDevOpsUserForToken)).toHaveBeenCalledTimes(2);
		});

		it('re-resolves once the 60s TTL has expired', async () => {
			stubHappyPath();
			vi.useFakeTimers();

			await resolveAzureDevOpsPersonaIdentities(project);
			vi.advanceTimersByTime(60_001);
			await resolveAzureDevOpsPersonaIdentities(project);

			expect(vi.mocked(getAzureDevOpsUserForToken)).toHaveBeenCalledTimes(4);
		});

		it('fails closed when the implementer identity cannot be resolved', async () => {
			vi.mocked(getAzureDevOpsTokenOrNull).mockResolvedValue(null);
			vi.mocked(getAzureDevOpsUserForToken).mockResolvedValue(null);

			await expect(resolveAzureDevOpsPersonaIdentities(project)).rejects.toThrow(/implementer/);
		});

		it('fails closed when only the reviewer identity is missing', async () => {
			vi.mocked(getAzureDevOpsTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'pat-impl' : null,
			);
			vi.mocked(getAzureDevOpsUserForToken).mockImplementation(async (pat) =>
				pat === 'pat-impl' ? IMPL_ID : null,
			);

			await expect(resolveAzureDevOpsPersonaIdentities(project)).rejects.toThrow(/reviewer/);
		});

		it('does not cache a failure — the next call retries', async () => {
			vi.mocked(getAzureDevOpsTokenOrNull).mockResolvedValue(null);
			vi.mocked(getAzureDevOpsUserForToken).mockResolvedValue(null);
			await expect(resolveAzureDevOpsPersonaIdentities(project)).rejects.toThrow();

			stubHappyPath();
			await expect(resolveAzureDevOpsPersonaIdentities(project)).resolves.toEqual(IDENTITIES);
		});
	});
});
