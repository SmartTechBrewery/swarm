import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/config/provider.js', () => ({ requirePmCredential: vi.fn() }));
vi.mock('@/integrations/scm/github/client.js', () => ({
	getGitHubUserForToken: vi.fn(),
	withGitHubToken: vi.fn(),
}));

import { requirePmCredential } from '@/config/provider.js';
import {
	_resetGitHubProjectsIdentityCache,
	matchesGitHubProjectsIdentity,
	resolveGitHubProjectsIdentity,
} from '@/integrations/pm/github-projects/credentials.js';
import { getGitHubUserForToken } from '@/integrations/scm/github/client.js';

/**
 * The board identity is what `GitHubProjectsRouterAdapter.isSelfAuthored` compares
 * an inbound actor against, so a stale answer is a loop-prevention failure, not a
 * cosmetic one: SWARM's own board writes stop being recognized as its own.
 */
describe('GitHub Projects board identity', () => {
	const project = createMockProjectConfig({ id: 'swarm' });

	beforeEach(() => {
		_resetGitHubProjectsIdentityCache();
		vi.mocked(requirePmCredential).mockReset();
		vi.mocked(getGitHubUserForToken).mockReset();
	});

	afterEach(() => {
		_resetGitHubProjectsIdentityCache();
	});

	it('resolves the login the board credential authenticates as', async () => {
		vi.mocked(requirePmCredential).mockResolvedValue('token-a');
		vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-board');

		await expect(resolveGitHubProjectsIdentity(project)).resolves.toBe('swarm-board');
	});

	it('serves an unchanged credential from cache instead of asking GitHub again', async () => {
		vi.mocked(requirePmCredential).mockResolvedValue('token-a');
		vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-board');

		await resolveGitHubProjectsIdentity(project);
		await resolveGitHubProjectsIdentity(project);

		expect(getGitHubUserForToken).toHaveBeenCalledTimes(1);
	});

	it('re-resolves as soon as the credential is rotated', async () => {
		vi.mocked(requirePmCredential).mockResolvedValue('token-a');
		vi.mocked(getGitHubUserForToken).mockResolvedValue('old-board-account');
		await resolveGitHubProjectsIdentity(project);

		// Rotated on the Project Management tab. Keying the cache on the project alone
		// would keep answering `old-board-account` for the rest of the TTL, so every
		// card SWARM moved with the new token would read as a human's change.
		vi.mocked(requirePmCredential).mockResolvedValue('token-b');
		vi.mocked(getGitHubUserForToken).mockResolvedValue('new-board-account');

		await expect(resolveGitHubProjectsIdentity(project)).resolves.toBe('new-board-account');
		expect(getGitHubUserForToken).toHaveBeenCalledTimes(2);
	});

	it('stops answering once the credential is removed', async () => {
		vi.mocked(requirePmCredential).mockResolvedValue('token-a');
		vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-board');
		await resolveGitHubProjectsIdentity(project);

		vi.mocked(requirePmCredential).mockRejectedValue(new Error('No PM credential configured'));

		await expect(resolveGitHubProjectsIdentity(project)).rejects.toThrow(
			'No PM credential configured',
		);
	});

	it('does not cache a failed identity lookup', async () => {
		vi.mocked(requirePmCredential).mockResolvedValue('token-a');
		vi.mocked(getGitHubUserForToken).mockResolvedValue(undefined as unknown as string);
		await expect(resolveGitHubProjectsIdentity(project)).rejects.toThrow(/Failed to resolve/);

		vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-board');
		await expect(resolveGitHubProjectsIdentity(project)).resolves.toBe('swarm-board');
	});

	it('recognizes the GitHub App form of the same identity', () => {
		expect(matchesGitHubProjectsIdentity('swarm-board', 'swarm-board')).toBe(true);
		expect(matchesGitHubProjectsIdentity('swarm-board[bot]', 'swarm-board')).toBe(true);
		expect(matchesGitHubProjectsIdentity('a-human', 'swarm-board')).toBe(false);
	});
});
