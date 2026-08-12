import { beforeEach, describe, expect, it } from 'vitest';

import {
	createUser,
	ensureLocalAdminUser,
	findUserByIdentifier,
	findUserCredentialById,
	findUserCredentialByIdentifier,
	getUserById,
	LOCAL_ADMIN_IDENTIFIER,
	listUsers,
	setDisplayName,
	setInstanceAdmin,
	setPasswordHash,
} from '../../../src/db/repositories/usersRepository.js';
import { truncateAll } from '../helpers/db.js';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('usersRepository (integration)', () => {
	beforeEach(async () => {
		await truncateAll();
	});

	describe('createUser', () => {
		it('creates a user with generated id/timestamps and default non-admin', async () => {
			const user = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });

			expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
			expect(user.identifier).toBe('ada@example.com');
			expect(user.displayName).toBe('Ada');
			expect(user.instanceAdmin).toBe(false);
			expect(user.createdAt).toBeInstanceOf(Date);
			expect(user.updatedAt).toBeInstanceOf(Date);
		});

		it('honours an explicit instanceAdmin flag', async () => {
			const user = await createUser({
				identifier: 'admin@example.com',
				displayName: 'Admin',
				instanceAdmin: true,
			});
			expect(user.instanceAdmin).toBe(true);
		});

		it('rejects a duplicate identifier with a unique violation', async () => {
			await createUser({ identifier: 'dup@example.com', displayName: 'First' });
			await expect(
				createUser({ identifier: 'dup@example.com', displayName: 'Second' }),
			).rejects.toMatchObject({
				cause: expect.objectContaining({ code: '23505' }),
			});
		});
	});

	describe('getUserById / findUserByIdentifier', () => {
		it('round-trips a created user by id and by identifier', async () => {
			const created = await createUser({ identifier: 'grace@example.com', displayName: 'Grace' });

			expect(await getUserById(created.id)).toEqual(created);
			expect(await findUserByIdentifier('grace@example.com')).toEqual(created);
		});

		it('returns undefined for unknown lookups', async () => {
			expect(await getUserById('11111111-1111-4111-8111-111111111111')).toBeUndefined();
			expect(await findUserByIdentifier('nobody@example.com')).toBeUndefined();
		});
	});

	describe('listUsers', () => {
		it('lists all users ordered by identifier', async () => {
			await createUser({ identifier: 'b@example.com', displayName: 'B' });
			await createUser({ identifier: 'a@example.com', displayName: 'A' });

			const identifiers = (await listUsers()).map((u) => u.identifier);
			expect(identifiers).toEqual(['a@example.com', 'b@example.com']);
		});
	});

	describe('setInstanceAdmin', () => {
		it('flips the admin flag and returns the updated user', async () => {
			const user = await createUser({ identifier: 'flip@example.com', displayName: 'Flip' });

			const granted = await setInstanceAdmin(user.id, true);
			expect(granted?.instanceAdmin).toBe(true);

			const revoked = await setInstanceAdmin(user.id, false);
			expect(revoked?.instanceAdmin).toBe(false);
		});

		it('returns undefined for an unknown id', async () => {
			expect(await setInstanceAdmin('11111111-1111-4111-8111-111111111111', true)).toBeUndefined();
		});
	});

	describe('setDisplayName', () => {
		it('persists the new name and returns the updated user', async () => {
			const user = await createUser({ identifier: 'rename@example.com', displayName: 'Before' });

			const updated = await setDisplayName(user.id, 'After');

			expect(updated?.displayName).toBe('After');
			expect(updated?.identifier).toBe('rename@example.com');
			expect((await getUserById(user.id))?.displayName).toBe('After');
		});

		it('returns undefined for an unknown id and leaves other users alone', async () => {
			const other = await createUser({ identifier: 'other@example.com', displayName: 'Other' });

			expect(await setDisplayName('11111111-1111-4111-8111-111111111111', 'Nope')).toBeUndefined();
			expect((await getUserById(other.id))?.displayName).toBe('Other');
		});
	});

	describe('findUserCredentialById', () => {
		it('returns the user with their stored hash', async () => {
			const user = await createUser({ identifier: 'cred@example.com', displayName: 'Cred' });
			await setPasswordHash(user.id, 'deadbeef:cafef00d');

			const credential = await findUserCredentialById(user.id);

			expect(credential?.user).toEqual({ ...user, updatedAt: credential?.user.updatedAt });
			expect(credential?.user.id).toBe(user.id);
			expect(credential?.passwordHash).toBe('deadbeef:cafef00d');
		});

		it('reports a null hash for a user with no password, and undefined for an unknown id', async () => {
			const user = await createUser({ identifier: 'nopass@example.com', displayName: 'No Pass' });

			expect((await findUserCredentialById(user.id))?.passwordHash).toBeNull();
			expect(await findUserCredentialById('11111111-1111-4111-8111-111111111111')).toBeUndefined();
		});
	});

	describe('ensureLocalAdminUser', () => {
		it('creates the reserved localhost-admin as an admin with no password', async () => {
			const admin = await ensureLocalAdminUser();

			expect(admin.identifier).toBe(LOCAL_ADMIN_IDENTIFIER);
			expect(admin.instanceAdmin).toBe(true);
			expect(admin.id).toMatch(/^[0-9a-f-]{36}$/);

			// No password is set — the single-user admin authenticates by mode, not
			// credentials. The hash lives only in the credential read model.
			const credential = await findUserCredentialByIdentifier(LOCAL_ADMIN_IDENTIFIER);
			expect(credential?.passwordHash).toBeNull();
		});

		it('is idempotent — repeated calls return the same row', async () => {
			const first = await ensureLocalAdminUser();
			const second = await ensureLocalAdminUser();

			expect(second.id).toBe(first.id);
			expect(
				(await listUsers()).filter((u) => u.identifier === LOCAL_ADMIN_IDENTIFIER),
			).toHaveLength(1);
		});

		it('promotes a pre-existing non-admin row to admin without touching its password', async () => {
			const existing = await createUser({
				identifier: LOCAL_ADMIN_IDENTIFIER,
				displayName: 'Pre-existing',
			});
			await setPasswordHash(existing.id, 'deadbeef:cafef00d');
			expect(existing.instanceAdmin).toBe(false);

			const promoted = await ensureLocalAdminUser();

			expect(promoted.id).toBe(existing.id);
			expect(promoted.instanceAdmin).toBe(true);

			const credential = await findUserCredentialByIdentifier(LOCAL_ADMIN_IDENTIFIER);
			expect(credential?.passwordHash).toBe('deadbeef:cafef00d');
		});
	});
});
