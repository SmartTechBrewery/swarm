import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getUserById, findUserByIdentifier, setDisplayName } = vi.hoisted(() => ({
	getUserById: vi.fn(),
	findUserByIdentifier: vi.fn(),
	setDisplayName: vi.fn(),
}));

vi.mock('@/db/repositories/usersRepository.js', () => ({
	getUserById,
	findUserByIdentifier,
	setDisplayName,
}));

import type { SwarmUser } from '@/identity/schema.js';
import {
	getUser,
	isInstanceAdmin,
	renameUser,
	resolveUserByIdentifier,
} from '@/identity/service.js';

function makeUser(overrides: Partial<SwarmUser> = {}): SwarmUser {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		identifier: 'ada@example.com',
		displayName: 'Ada Lovelace',
		instanceAdmin: false,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

describe('identity service', () => {
	beforeEach(() => {
		getUserById.mockReset();
		findUserByIdentifier.mockReset();
		setDisplayName.mockReset();
	});

	describe('renameUser', () => {
		it('trims the name and delegates to the repository', async () => {
			const renamed = makeUser({ displayName: 'Ada' });
			setDisplayName.mockResolvedValue(renamed);

			expect(await renameUser(renamed.id, '  Ada  ')).toBe(renamed);
			expect(setDisplayName).toHaveBeenCalledWith(renamed.id, 'Ada');
		});

		it('passes through undefined for an unknown user', async () => {
			setDisplayName.mockResolvedValue(undefined);
			expect(await renameUser('missing', 'Ada')).toBeUndefined();
		});

		it('rejects an empty or over-long name before touching the repository', async () => {
			await expect(renameUser('id', '   ')).rejects.toThrow();
			await expect(renameUser('id', 'a'.repeat(81))).rejects.toThrow();
			expect(setDisplayName).not.toHaveBeenCalled();
		});
	});

	describe('getUser / resolveUserByIdentifier', () => {
		it('delegates to the repository', async () => {
			const user = makeUser();
			getUserById.mockResolvedValue(user);
			findUserByIdentifier.mockResolvedValue(user);

			expect(await getUser(user.id)).toBe(user);
			expect(getUserById).toHaveBeenCalledWith(user.id);
			expect(await resolveUserByIdentifier(user.identifier)).toBe(user);
			expect(findUserByIdentifier).toHaveBeenCalledWith(user.identifier);
		});

		it('passes through undefined for an unknown user', async () => {
			getUserById.mockResolvedValue(undefined);
			expect(await getUser('missing')).toBeUndefined();
		});
	});

	describe('isInstanceAdmin', () => {
		it('is true for an admin user', async () => {
			getUserById.mockResolvedValue(makeUser({ instanceAdmin: true }));
			expect(await isInstanceAdmin('id')).toBe(true);
		});

		it('is false for a non-admin user', async () => {
			getUserById.mockResolvedValue(makeUser({ instanceAdmin: false }));
			expect(await isInstanceAdmin('id')).toBe(false);
		});

		it('is false (not an error) for an unknown user', async () => {
			getUserById.mockResolvedValue(undefined);
			expect(await isInstanceAdmin('missing')).toBe(false);
		});
	});
});
