import { beforeEach, describe, expect, it, vi } from 'vitest';

const { linkIdentity, unlinkIdentity, listIdentities, listIdentitiesForUser } = vi.hoisted(() => ({
	linkIdentity: vi.fn(),
	unlinkIdentity: vi.fn(),
	listIdentities: vi.fn(),
	listIdentitiesForUser: vi.fn(),
}));
const { findUserByIdentifier, getUserById } = vi.hoisted(() => ({
	findUserByIdentifier: vi.fn(),
	getUserById: vi.fn(),
}));
const { closeDb } = vi.hoisted(() => ({ closeDb: vi.fn() }));

vi.mock('@/db/repositories/userIdentitiesRepository.js', () => ({
	linkIdentity,
	unlinkIdentity,
	listIdentities,
	listIdentitiesForUser,
}));
vi.mock('@/db/repositories/usersRepository.js', () => ({ findUserByIdentifier, getUserById }));
vi.mock('@/db/client.js', () => ({ closeDb }));

import { run } from '@/cli/commands/identities.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function makeUser(overrides: Record<string, unknown> = {}) {
	return {
		id: USER_ID,
		identifier: 'ada@example.com',
		displayName: 'Ada Lovelace',
		instanceAdmin: false,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function makeIdentity(overrides: Record<string, unknown> = {}) {
	return {
		id: '99999999-9999-4999-8999-999999999999',
		userId: USER_ID,
		provider: 'github-projects',
		handle: 'ada',
		createdAt: new Date(),
		...overrides,
	};
}

const LINK_ARGS = ['--user', 'ada@example.com', '--provider', 'github-projects', '--handle', 'ada'];

describe('swarm identities', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		linkIdentity.mockReset().mockImplementation(async (input) => makeIdentity(input));
		unlinkIdentity.mockReset().mockResolvedValue(true);
		listIdentities.mockReset().mockResolvedValue([]);
		listIdentitiesForUser.mockReset().mockResolvedValue([]);
		findUserByIdentifier.mockReset().mockResolvedValue(makeUser());
		getUserById.mockReset().mockResolvedValue(makeUser());
		closeDb.mockReset().mockResolvedValue(undefined);
	});

	describe('link', () => {
		it('links a handle to the resolved user and closes the db', async () => {
			expect(await run(['link', ...LINK_ARGS])).toBe(0);
			expect(linkIdentity).toHaveBeenCalledWith({
				userId: USER_ID,
				provider: 'github-projects',
				handle: 'ada',
			});
			expect(closeDb).toHaveBeenCalledOnce();
		});

		it('requires --user, --provider and --handle', async () => {
			expect(
				await run(['link', '--user', 'ada@example.com', '--provider', 'github-projects']),
			).toBe(1);
			expect(linkIdentity).not.toHaveBeenCalled();
		});

		it('rejects whitespace-only provider or handle', async () => {
			expect(
				await run(['link', '--user', 'ada@example.com', '--provider', ' ', '--handle', 'ada']),
			).toBe(1);
			expect(
				await run([
					'link',
					'--user',
					'ada@example.com',
					'--provider',
					'github-projects',
					'--handle',
					' ',
				]),
			).toBe(1);
			expect(linkIdentity).not.toHaveBeenCalled();
		});

		it('fails for an unknown user', async () => {
			findUserByIdentifier.mockResolvedValue(undefined);
			expect(await run(['link', ...LINK_ARGS])).toBe(1);
			expect(linkIdentity).not.toHaveBeenCalled();
		});

		it('surfaces a handle already linked to another user, still closing the db', async () => {
			linkIdentity.mockRejectedValue(new Error('already linked to another user'));
			await expect(run(['link', ...LINK_ARGS])).rejects.toThrow('already linked to another user');
			expect(closeDb).toHaveBeenCalledOnce();
		});
	});

	describe('unlink', () => {
		it('unlinks a handle', async () => {
			expect(await run(['unlink', '--provider', 'github-projects', '--handle', 'ada'])).toBe(0);
			expect(unlinkIdentity).toHaveBeenCalledWith('github-projects', 'ada');
		});

		it('requires --provider and --handle', async () => {
			expect(await run(['unlink', '--handle', 'ada'])).toBe(1);
			expect(unlinkIdentity).not.toHaveBeenCalled();
		});

		it('rejects whitespace-only provider or handle', async () => {
			expect(await run(['unlink', '--provider', ' ', '--handle', 'ada'])).toBe(1);
			expect(await run(['unlink', '--provider', 'github-projects', '--handle', ' '])).toBe(1);
			expect(unlinkIdentity).not.toHaveBeenCalled();
		});

		it('fails when the handle was not linked', async () => {
			unlinkIdentity.mockResolvedValue(false);
			expect(await run(['unlink', '--provider', 'github-projects', '--handle', 'ada'])).toBe(1);
		});
	});

	describe('list', () => {
		it('lists every link, resolving each identifier', async () => {
			listIdentities.mockResolvedValue([makeIdentity()]);
			const log = vi.spyOn(console, 'log');

			expect(await run(['list'])).toBe(0);
			expect(listIdentities).toHaveBeenCalledOnce();
			expect(log).toHaveBeenCalledWith(expect.stringContaining('ada@example.com'));
			expect(closeDb).toHaveBeenCalledOnce();
		});

		it('scopes to one user with --user', async () => {
			listIdentitiesForUser.mockResolvedValue([makeIdentity()]);
			expect(await run(['list', '--user', 'ada@example.com'])).toBe(0);
			expect(listIdentitiesForUser).toHaveBeenCalledWith(USER_ID);
			expect(listIdentities).not.toHaveBeenCalled();
		});

		it('fails for an unknown --user', async () => {
			findUserByIdentifier.mockResolvedValue(undefined);
			expect(await run(['list', '--user', 'nobody'])).toBe(1);
			expect(listIdentitiesForUser).not.toHaveBeenCalled();
		});
	});

	describe('dispatch', () => {
		it('returns 1 for an unknown subcommand without opening the db', async () => {
			expect(await run(['nope'])).toBe(1);
			expect(closeDb).not.toHaveBeenCalled();
		});

		it('returns 1 with no subcommand and 0 for explicit --help', async () => {
			expect(await run([])).toBe(1);
			expect(await run(['--help'])).toBe(0);
			expect(linkIdentity).not.toHaveBeenCalled();
			expect(closeDb).not.toHaveBeenCalled();
		});

		it('names the Jira accountId as the handle to link in --help', async () => {
			const log = vi.spyOn(console, 'log');

			await run(['--help']);

			expect(log).toHaveBeenCalledWith(expect.stringMatching(/jira\s+the Atlassian accountId/));
		});
	});
});
