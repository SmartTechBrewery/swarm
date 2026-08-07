import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../helpers/factories.js';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveProjectCredential: vi.fn(),
}));
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByRepoFromDb: vi.fn(),
	findProjectByBoardFromDb: vi.fn(),
	findProjectByPmContainerFromDb: vi.fn(),
}));

import {
	findProjectByBoard,
	findProjectByLinearTeam,
	findProjectByRepo,
	getPersonaToken,
	getPersonaTokenOrNull,
	getWebhookSecretOrNull,
} from '@/config/provider.js';
import { resolveProjectCredential } from '@/db/repositories/credentialsRepository.js';
import {
	findProjectByBoardFromDb,
	findProjectByPmContainerFromDb,
	findProjectByRepoFromDb,
} from '@/db/repositories/projectsRepository.js';

const project = createMockProjectConfig({
	id: 'proj-1',
	credentials: {
		reviewer: 'REV_TOKEN_KEY',
		webhookSecret: 'WEBHOOK_KEY',
	},
});

describe('config provider', () => {
	beforeEach(() => {
		vi.mocked(resolveProjectCredential).mockReset();
		vi.mocked(findProjectByRepoFromDb).mockReset();
		vi.mocked(findProjectByBoardFromDb).mockReset();
		vi.mocked(findProjectByPmContainerFromDb).mockReset();
		delete process.env.SWARM_OPERATOR_GH_TOKEN;
	});

	afterEach(() => {
		delete process.env.SWARM_OPERATOR_GH_TOKEN;
	});

	describe('findProjectByRepo', () => {
		it('delegates to the repository', async () => {
			vi.mocked(findProjectByRepoFromDb).mockResolvedValue(project);
			expect(await findProjectByRepo('SmartTechBrewery/swarm')).toBe(project);
			expect(findProjectByRepoFromDb).toHaveBeenCalledWith('SmartTechBrewery/swarm');
		});
	});

	describe('findProjectByBoard', () => {
		it('delegates to the repository with the board node ID', async () => {
			vi.mocked(findProjectByBoardFromDb).mockResolvedValue(project);
			expect(await findProjectByBoard('PVT_kwHOAC3TF84BcNwD')).toBe(project);
			expect(findProjectByBoardFromDb).toHaveBeenCalledWith('PVT_kwHOAC3TF84BcNwD');
		});
	});

	describe('findProjectByLinearTeam', () => {
		// Its own lookup rather than the board one (issue #529): the provider names
		// both the `pm_type` it owns and the `pm_config` key that holds its container,
		// so two providers' blobs cannot collide on a shared key.
		it("delegates to the container lookup with Linear's provider id and container key", async () => {
			vi.mocked(findProjectByPmContainerFromDb).mockResolvedValue(project);
			expect(await findProjectByLinearTeam('team-uuid')).toBe(project);
			expect(findProjectByPmContainerFromDb).toHaveBeenCalledWith('linear', 'teamId', 'team-uuid');
			expect(findProjectByBoardFromDb).not.toHaveBeenCalled();
		});

		it('returns undefined for an untracked team', async () => {
			vi.mocked(findProjectByPmContainerFromDb).mockResolvedValue(undefined);
			expect(await findProjectByLinearTeam('team-unknown')).toBeUndefined();
		});
	});

	describe('getPersonaTokenOrNull', () => {
		it('resolves the implementer persona from the worker-local operator env var', async () => {
			process.env.SWARM_OPERATOR_GH_TOKEN = 'operator-token';
			const token = await getPersonaTokenOrNull(project, 'implementer');
			expect(token).toBe('operator-token');
			// The implementer never touches project_credentials (issue #396).
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});

		it('returns null for the implementer when the operator env var is unset', async () => {
			expect(await getPersonaTokenOrNull(project, 'implementer')).toBeNull();
			expect(resolveProjectCredential).not.toHaveBeenCalled();
		});

		it('uses the reviewer reference for the reviewer persona', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('test-token-reviewer');
			await getPersonaTokenOrNull(project, 'reviewer');
			expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'REV_TOKEN_KEY');
		});

		it('returns null when the reviewer reference resolves to nothing', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);
			expect(await getPersonaTokenOrNull(project, 'reviewer')).toBeNull();
		});
	});

	describe('getPersonaToken', () => {
		it('returns the implementer operator token when configured', async () => {
			process.env.SWARM_OPERATOR_GH_TOKEN = 'operator-token';
			expect(await getPersonaToken(project, 'implementer')).toBe('operator-token');
		});

		it('throws an actionable SWARM_OPERATOR_GH_TOKEN error when the implementer token is unset', async () => {
			await expect(getPersonaToken(project, 'implementer')).rejects.toThrow(
				/SWARM_OPERATOR_GH_TOKEN/,
			);
		});

		it('throws when the reviewer token is not configured', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);
			await expect(getPersonaToken(project, 'reviewer')).rejects.toThrow(/reviewer token/);
		});
	});

	describe('getWebhookSecretOrNull', () => {
		it("resolves the project's webhook-secret reference to its secret", async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue('whsec_123');
			expect(await getWebhookSecretOrNull(project)).toBe('whsec_123');
			expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'WEBHOOK_KEY');
		});

		it('returns null when the reference resolves to nothing', async () => {
			vi.mocked(resolveProjectCredential).mockResolvedValue(null);
			expect(await getWebhookSecretOrNull(project)).toBeNull();
		});
	});
});
