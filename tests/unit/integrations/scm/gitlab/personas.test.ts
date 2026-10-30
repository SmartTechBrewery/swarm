import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/integrations/scm/gitlab/client.js', () => ({
	getGitLabUserForToken: vi.fn<(token: string | null) => Promise<string | null>>(),
}));
vi.mock('@/integrations/scm/gitlab/credentials.js', () => ({
	getGitLabTokenOrNull:
		vi.fn<(project: unknown, persona: 'implementer' | 'reviewer') => Promise<string | null>>(),
}));

import { getGitLabUserForToken } from '@/integrations/scm/gitlab/client.js';
import { getGitLabTokenOrNull } from '@/integrations/scm/gitlab/credentials.js';
import {
	_resetGitLabPersonaIdentityCache,
	isGitLabReviewer,
	resolveGitLabReviewerIdentity,
} from '@/integrations/scm/gitlab/personas.js';

const project = createMockProjectConfig();

/** The reviewer resolves to a token, and that to its own username. */
function stubHappyPath(): void {
	vi.mocked(getGitLabTokenOrNull).mockResolvedValue('token-rev');
	vi.mocked(getGitLabUserForToken).mockResolvedValue('swarm-rev');
}

describe('gitlab reviewer identity', () => {
	beforeEach(() => {
		_resetGitLabPersonaIdentityCache();
		vi.mocked(getGitLabTokenOrNull).mockReset();
		vi.mocked(getGitLabUserForToken).mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('isGitLabReviewer', () => {
		it('recognizes the reviewer username, case-insensitively', () => {
			expect(isGitLabReviewer('swarm-rev', 'swarm-rev')).toBe(true);
			expect(isGitLabReviewer('SWARM-REV', 'swarm-rev')).toBe(true);
		});

		it('does not match an operator account or a human', () => {
			expect(isGitLabReviewer('operator-alice', 'swarm-rev')).toBe(false);
			expect(isGitLabReviewer('some-human', 'swarm-rev')).toBe(false);
		});
	});

	describe('resolveGitLabReviewerIdentity', () => {
		it('resolves the reviewer from its own token alone — no implementer credential', async () => {
			stubHappyPath();

			await expect(resolveGitLabReviewerIdentity(project)).resolves.toBe('swarm-rev');
			expect(getGitLabTokenOrNull).toHaveBeenCalledWith(project, 'reviewer');
			expect(getGitLabTokenOrNull).not.toHaveBeenCalledWith(project, 'implementer');
		});

		it('caches per project — a second call does not re-resolve', async () => {
			stubHappyPath();

			await resolveGitLabReviewerIdentity(project);
			await resolveGitLabReviewerIdentity(project);

			expect(vi.mocked(getGitLabUserForToken)).toHaveBeenCalledTimes(1);
		});

		it('re-resolves once the 60s TTL has expired', async () => {
			stubHappyPath();
			vi.useFakeTimers();

			await resolveGitLabReviewerIdentity(project);
			vi.advanceTimersByTime(60_001);
			await resolveGitLabReviewerIdentity(project);

			expect(vi.mocked(getGitLabUserForToken)).toHaveBeenCalledTimes(2);
		});

		it('fails closed when the reviewer identity cannot be resolved', async () => {
			vi.mocked(getGitLabTokenOrNull).mockResolvedValue(null);
			vi.mocked(getGitLabUserForToken).mockResolvedValue(null);

			await expect(resolveGitLabReviewerIdentity(project)).rejects.toThrow(/reviewer/);
		});

		it('does not cache a failure — the next call retries', async () => {
			vi.mocked(getGitLabTokenOrNull).mockResolvedValue(null);
			vi.mocked(getGitLabUserForToken).mockResolvedValue(null);
			await expect(resolveGitLabReviewerIdentity(project)).rejects.toThrow();

			stubHappyPath();
			await expect(resolveGitLabReviewerIdentity(project)).resolves.toBe('swarm-rev');
		});
	});
});
