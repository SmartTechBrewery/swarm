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
	getGitLabPersonaForLogin,
	isSwarmGitLabActor,
	resolveGitLabPersonaIdentities,
} from '@/integrations/scm/gitlab/personas.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';

const IDENTITIES: ScmPersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };
const project = createMockProjectConfig();

/** Both personas resolve to a token, and each token to its own username. */
function stubHappyPath(): void {
	vi.mocked(getGitLabTokenOrNull).mockImplementation(async (_p, persona) =>
		persona === 'implementer' ? 'token-impl' : 'token-rev',
	);
	vi.mocked(getGitLabUserForToken).mockImplementation(async (token) =>
		token === 'token-impl' ? 'swarm-impl' : 'swarm-rev',
	);
}

describe('gitlab personas', () => {
	beforeEach(() => {
		_resetGitLabPersonaIdentityCache();
		vi.mocked(getGitLabTokenOrNull).mockReset();
		vi.mocked(getGitLabUserForToken).mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('isSwarmGitLabActor', () => {
		it('recognizes both persona usernames', () => {
			expect(isSwarmGitLabActor('swarm-impl', IDENTITIES)).toBe(true);
			expect(isSwarmGitLabActor('swarm-rev', IDENTITIES)).toBe(true);
		});

		it('matches case-insensitively — loop prevention must fail closed', () => {
			expect(isSwarmGitLabActor('Swarm-Impl', IDENTITIES)).toBe(true);
		});

		it('does not flag a human username', () => {
			expect(isSwarmGitLabActor('some-human', IDENTITIES)).toBe(false);
		});
	});

	describe('getGitLabPersonaForLogin', () => {
		it('maps each persona, case-insensitively', () => {
			expect(getGitLabPersonaForLogin('swarm-impl', IDENTITIES)).toBe('implementer');
			expect(getGitLabPersonaForLogin('SWARM-REV', IDENTITIES)).toBe('reviewer');
		});

		it('returns null for a username that is neither persona', () => {
			expect(getGitLabPersonaForLogin('some-human', IDENTITIES)).toBeNull();
		});
	});

	describe('resolveGitLabPersonaIdentities', () => {
		it('resolves both persona usernames from their own tokens', async () => {
			stubHappyPath();

			await expect(resolveGitLabPersonaIdentities(project)).resolves.toEqual(IDENTITIES);
		});

		it('caches per project — a second call does not re-resolve', async () => {
			stubHappyPath();

			await resolveGitLabPersonaIdentities(project);
			const callsAfterFirst = vi.mocked(getGitLabUserForToken).mock.calls.length;
			await resolveGitLabPersonaIdentities(project);

			expect(vi.mocked(getGitLabUserForToken).mock.calls.length).toBe(callsAfterFirst);
		});

		it('re-resolves once the 60s TTL has expired', async () => {
			stubHappyPath();
			vi.useFakeTimers();

			await resolveGitLabPersonaIdentities(project);
			vi.advanceTimersByTime(60_001);
			await resolveGitLabPersonaIdentities(project);

			expect(vi.mocked(getGitLabUserForToken)).toHaveBeenCalledTimes(4);
		});

		it('re-resolves after the test-only cache reset', async () => {
			stubHappyPath();

			await resolveGitLabPersonaIdentities(project);
			_resetGitLabPersonaIdentityCache();
			await resolveGitLabPersonaIdentities(project);

			expect(vi.mocked(getGitLabUserForToken)).toHaveBeenCalledTimes(4);
		});

		it('fails closed when the implementer identity cannot be resolved', async () => {
			vi.mocked(getGitLabTokenOrNull).mockResolvedValue(null);
			vi.mocked(getGitLabUserForToken).mockResolvedValue(null);

			await expect(resolveGitLabPersonaIdentities(project)).rejects.toThrow(/implementer/);
		});

		it('fails closed when only the reviewer identity is missing', async () => {
			vi.mocked(getGitLabTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'token-impl' : null,
			);
			vi.mocked(getGitLabUserForToken).mockImplementation(async (token) =>
				token === 'token-impl' ? 'swarm-impl' : null,
			);

			await expect(resolveGitLabPersonaIdentities(project)).rejects.toThrow(/reviewer/);
		});

		it('does not cache a failure — the next call retries', async () => {
			vi.mocked(getGitLabTokenOrNull).mockResolvedValue(null);
			vi.mocked(getGitLabUserForToken).mockResolvedValue(null);
			await expect(resolveGitLabPersonaIdentities(project)).rejects.toThrow();

			stubHappyPath();
			await expect(resolveGitLabPersonaIdentities(project)).resolves.toEqual(IDENTITIES);
		});
	});
});
