import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/config/provider.js', () => ({
	getPersonaTokenOrNull: vi.fn(),
}));
vi.mock('@/integrations/scm/github/client.js', () => ({
	getGitHubUserForToken: vi.fn(),
}));

import { getPersonaTokenOrNull } from '@/config/provider.js';
import { getGitHubUserForToken } from '@/integrations/scm/github/client.js';
import {
	_resetPersonaIdentityCache,
	getPersonaForAgentType,
	isReviewerLogin,
	resolveReviewerIdentity,
} from '@/integrations/scm/github/personas.js';

describe('personas', () => {
	beforeEach(() => {
		_resetPersonaIdentityCache();
	});

	describe('getPersonaForAgentType', () => {
		it('maps the review agent to the reviewer persona', () => {
			expect(getPersonaForAgentType('review')).toBe('reviewer');
		});

		it('maps implementation-side agents to the implementer persona', () => {
			expect(getPersonaForAgentType('implementation')).toBe('implementer');
			expect(getPersonaForAgentType('respond-to-review')).toBe('implementer');
		});

		it('defaults unknown agent types to the implementer persona', () => {
			expect(getPersonaForAgentType('some-future-agent')).toBe('implementer');
		});
	});

	describe('isReviewerLogin', () => {
		it('recognizes the reviewer login and its [bot]-suffixed App form', () => {
			expect(isReviewerLogin('swarm-rev', 'swarm-rev')).toBe(true);
			expect(isReviewerLogin('swarm-rev[bot]', 'swarm-rev')).toBe(true);
		});

		it('does not match any other login', () => {
			expect(isReviewerLogin('operator-alice', 'swarm-rev')).toBe(false);
			expect(isReviewerLogin('Swarm-Rev', 'swarm-rev')).toBe(false);
		});
	});

	describe('resolveReviewerIdentity', () => {
		const project = createMockProjectConfig();

		it('resolves the reviewer login from the reviewer token alone', async () => {
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue('tok-rev');
			vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-rev');

			await expect(resolveReviewerIdentity(project)).resolves.toBe('swarm-rev');
			expect(getPersonaTokenOrNull).toHaveBeenCalledWith(project, 'reviewer');
			expect(getPersonaTokenOrNull).not.toHaveBeenCalledWith(project, 'implementer');
		});

		it('caches per-project — a second call does not re-resolve', async () => {
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue('tok');
			vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-rev');

			await resolveReviewerIdentity(project);
			const callsAfterFirst = vi.mocked(getGitHubUserForToken).mock.calls.length;
			await resolveReviewerIdentity(project);
			expect(vi.mocked(getGitHubUserForToken).mock.calls.length).toBe(callsAfterFirst);
		});

		it('throws when the reviewer identity cannot be resolved', async () => {
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue(null);
			vi.mocked(getGitHubUserForToken).mockResolvedValue(null);

			await expect(resolveReviewerIdentity(project)).rejects.toThrow(/reviewer/);
		});
	});
});
