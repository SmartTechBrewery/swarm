import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/integrations/scm/bitbucket/client.js', () => ({
	getBitbucketUserForCredential: vi.fn<(credential: string | null) => Promise<string | null>>(),
}));
vi.mock('@/integrations/scm/bitbucket/credentials.js', () => ({
	getBitbucketCredentialOrNull:
		vi.fn<(project: unknown, persona: 'implementer' | 'reviewer') => Promise<string | null>>(),
}));

import { getBitbucketUserForCredential } from '@/integrations/scm/bitbucket/client.js';
import { getBitbucketCredentialOrNull } from '@/integrations/scm/bitbucket/credentials.js';
import {
	_resetBitbucketPersonaIdentityCache,
	getBitbucketPersonaForLogin,
	isSwarmBitbucketActor,
	resolveBitbucketPersonaIdentities,
} from '@/integrations/scm/bitbucket/personas.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';

const IDENTITIES: ScmPersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };
const project = createMockProjectConfig();

/** Both personas resolve to a credential, and each credential to its own login. */
function stubHappyPath(): void {
	vi.mocked(getBitbucketCredentialOrNull).mockImplementation(async (_p, persona) =>
		persona === 'implementer' ? 'cred-impl' : 'cred-rev',
	);
	vi.mocked(getBitbucketUserForCredential).mockImplementation(async (credential) =>
		credential === 'cred-impl' ? 'swarm-impl' : 'swarm-rev',
	);
}

describe('bitbucket personas', () => {
	beforeEach(() => {
		_resetBitbucketPersonaIdentityCache();
		vi.mocked(getBitbucketCredentialOrNull).mockReset();
		vi.mocked(getBitbucketUserForCredential).mockReset();
	});

	describe('isSwarmBitbucketActor', () => {
		it('recognizes both persona logins', () => {
			expect(isSwarmBitbucketActor('swarm-impl', IDENTITIES)).toBe(true);
			expect(isSwarmBitbucketActor('swarm-rev', IDENTITIES)).toBe(true);
		});

		it('matches case-insensitively — a Bitbucket nickname has no canonical case', () => {
			expect(isSwarmBitbucketActor('Swarm-Impl', IDENTITIES)).toBe(true);
		});

		it('does not flag a human login', () => {
			expect(isSwarmBitbucketActor('some-human', IDENTITIES)).toBe(false);
		});
	});

	describe('getBitbucketPersonaForLogin', () => {
		it('maps each persona, case-insensitively', () => {
			expect(getBitbucketPersonaForLogin('swarm-impl', IDENTITIES)).toBe('implementer');
			expect(getBitbucketPersonaForLogin('SWARM-REV', IDENTITIES)).toBe('reviewer');
		});

		it('returns null for a login that is neither persona', () => {
			expect(getBitbucketPersonaForLogin('some-human', IDENTITIES)).toBeNull();
		});
	});

	describe('resolveBitbucketPersonaIdentities', () => {
		it('resolves both persona logins from their own credentials', async () => {
			stubHappyPath();

			await expect(resolveBitbucketPersonaIdentities(project)).resolves.toEqual(IDENTITIES);
		});

		it('caches per project — a second call does not re-resolve', async () => {
			stubHappyPath();

			await resolveBitbucketPersonaIdentities(project);
			const callsAfterFirst = vi.mocked(getBitbucketUserForCredential).mock.calls.length;
			await resolveBitbucketPersonaIdentities(project);

			expect(vi.mocked(getBitbucketUserForCredential).mock.calls.length).toBe(callsAfterFirst);
		});

		it('re-resolves after the test-only cache reset', async () => {
			stubHappyPath();

			await resolveBitbucketPersonaIdentities(project);
			_resetBitbucketPersonaIdentityCache();
			await resolveBitbucketPersonaIdentities(project);

			expect(vi.mocked(getBitbucketUserForCredential)).toHaveBeenCalledTimes(4);
		});

		it('fails closed when the implementer identity cannot be resolved', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockResolvedValue(null);
			vi.mocked(getBitbucketUserForCredential).mockResolvedValue(null);

			await expect(resolveBitbucketPersonaIdentities(project)).rejects.toThrow(/implementer/);
		});

		it('fails closed when only the reviewer identity is missing', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'cred-impl' : null,
			);
			vi.mocked(getBitbucketUserForCredential).mockImplementation(async (credential) =>
				credential === 'cred-impl' ? 'swarm-impl' : null,
			);

			await expect(resolveBitbucketPersonaIdentities(project)).rejects.toThrow(/reviewer/);
		});

		it('fails closed when an account exposes no nickname', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'cred-impl' : 'cred-rev',
			);
			vi.mocked(getBitbucketUserForCredential).mockImplementation(async (credential) =>
				credential === 'cred-impl' ? 'swarm-impl' : null,
			);

			await expect(resolveBitbucketPersonaIdentities(project)).rejects.toThrow(/reviewer/);
		});

		it('does not cache a failure — the next call retries', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockResolvedValue(null);
			vi.mocked(getBitbucketUserForCredential).mockResolvedValue(null);
			await expect(resolveBitbucketPersonaIdentities(project)).rejects.toThrow();

			stubHappyPath();
			await expect(resolveBitbucketPersonaIdentities(project)).resolves.toEqual(IDENTITIES);
		});
	});
});
