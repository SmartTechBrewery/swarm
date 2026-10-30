import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
	isBitbucketReviewer,
	resolveBitbucketReviewerIdentity,
} from '@/integrations/scm/bitbucket/personas.js';

const project = createMockProjectConfig();

/** The reviewer resolves to a credential, and that to its own login. */
function stubHappyPath(): void {
	vi.mocked(getBitbucketCredentialOrNull).mockResolvedValue('cred-rev');
	vi.mocked(getBitbucketUserForCredential).mockResolvedValue('swarm-rev');
}

describe('bitbucket reviewer identity', () => {
	beforeEach(() => {
		_resetBitbucketPersonaIdentityCache();
		vi.mocked(getBitbucketCredentialOrNull).mockReset();
		vi.mocked(getBitbucketUserForCredential).mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('isBitbucketReviewer', () => {
		it('recognizes the reviewer login, case-insensitively', () => {
			expect(isBitbucketReviewer('swarm-rev', 'swarm-rev')).toBe(true);
			expect(isBitbucketReviewer('SWARM-REV', 'swarm-rev')).toBe(true);
		});

		it('does not match an operator account or a human', () => {
			expect(isBitbucketReviewer('operator-alice', 'swarm-rev')).toBe(false);
			expect(isBitbucketReviewer('some-human', 'swarm-rev')).toBe(false);
		});
	});

	describe('resolveBitbucketReviewerIdentity', () => {
		it('resolves the reviewer from its own credential alone — no implementer credential', async () => {
			stubHappyPath();

			await expect(resolveBitbucketReviewerIdentity(project)).resolves.toBe('swarm-rev');
			expect(getBitbucketCredentialOrNull).toHaveBeenCalledWith(project, 'reviewer');
			expect(getBitbucketCredentialOrNull).not.toHaveBeenCalledWith(project, 'implementer');
		});

		it('caches per project — a second call does not re-resolve', async () => {
			stubHappyPath();

			await resolveBitbucketReviewerIdentity(project);
			await resolveBitbucketReviewerIdentity(project);

			expect(vi.mocked(getBitbucketUserForCredential)).toHaveBeenCalledTimes(1);
		});

		it('re-resolves once the 60s TTL has expired', async () => {
			stubHappyPath();
			vi.useFakeTimers();

			await resolveBitbucketReviewerIdentity(project);
			vi.advanceTimersByTime(60_001);
			await resolveBitbucketReviewerIdentity(project);

			expect(vi.mocked(getBitbucketUserForCredential)).toHaveBeenCalledTimes(2);
		});

		it('fails closed when the reviewer identity cannot be resolved', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockResolvedValue(null);
			vi.mocked(getBitbucketUserForCredential).mockResolvedValue(null);

			await expect(resolveBitbucketReviewerIdentity(project)).rejects.toThrow(/reviewer/);
		});

		it('does not cache a failure — the next call retries', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockResolvedValue(null);
			vi.mocked(getBitbucketUserForCredential).mockResolvedValue(null);
			await expect(resolveBitbucketReviewerIdentity(project)).rejects.toThrow();

			stubHappyPath();
			await expect(resolveBitbucketReviewerIdentity(project)).resolves.toBe('swarm-rev');
		});
	});
});
