import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import {
	createUserWithPasswordToken,
	redeemPasswordToken,
	replacePasswordToken,
} from '../../../src/db/repositories/userPasswordTokensRepository.js';
import {
	findUserIdBySessionToken,
	insertSession,
} from '../../../src/db/repositories/userSessionsRepository.js';
import {
	createUser,
	findUserCredentialById,
	listUsers,
} from '../../../src/db/repositories/usersRepository.js';
import { userPasswordTokens } from '../../../src/db/schema/userPasswordTokens.js';
import { users } from '../../../src/db/schema/users.js';
import { truncateAll } from '../helpers/db.js';

const HOUR = 60 * 60 * 1000;

function link(tokenHash: string, now = new Date()) {
	return { tokenHash, expiresAt: new Date(now.getTime() + HOUR), now };
}

async function tokenRows() {
	return getDb().select().from(userPasswordTokens);
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'userPasswordTokensRepository (integration)',
	() => {
		beforeEach(async () => {
			await truncateAll();
		});

		describe('createUserWithPasswordToken', () => {
			it('creates a passwordless user and stores only the given hash', async () => {
				const user = await createUserWithPasswordToken({
					identifier: 'ada@example.com',
					displayName: 'Ada',
					instanceAdmin: true,
					...link('hash-ada'),
				});

				expect(user).toMatchObject({ identifier: 'ada@example.com', instanceAdmin: true });
				expect((await findUserCredentialById(user.id))?.passwordHash).toBeNull();
				const rows = await tokenRows();
				expect(rows).toHaveLength(1);
				expect(rows[0]).toMatchObject({ userId: user.id, tokenHash: 'hash-ada' });
			});

			it('rejects a duplicate identifier and writes no token', async () => {
				await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });

				await expect(
					createUserWithPasswordToken({
						identifier: 'ada@example.com',
						displayName: 'Ada again',
						instanceAdmin: false,
						...link('hash-dup'),
					}),
				).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23505' }) });
				expect(await tokenRows()).toHaveLength(0);
				expect(await listUsers()).toHaveLength(1);
			});
		});

		describe('replacePasswordToken', () => {
			it("invalidates that user's earlier link but not another user's", async () => {
				const ada = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
				const grace = await createUser({ identifier: 'grace@example.com', displayName: 'Grace' });
				await replacePasswordToken({ userId: ada.id, ...link('hash-ada-1') });
				await replacePasswordToken({ userId: grace.id, ...link('hash-grace') });

				await replacePasswordToken({ userId: ada.id, ...link('hash-ada-2') });

				expect((await tokenRows()).map((r) => r.tokenHash).sort()).toEqual([
					'hash-ada-2',
					'hash-grace',
				]);
				const now = new Date();
				expect(
					await redeemPasswordToken({ tokenHash: 'hash-ada-1', passwordHash: 'h', now }),
				).toBeUndefined();
				expect(await redeemPasswordToken({ tokenHash: 'hash-grace', passwordHash: 'h', now })).toBe(
					grace.id,
				);
			});

			it("sweeps every user's expired links", async () => {
				const ada = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
				const grace = await createUser({ identifier: 'grace@example.com', displayName: 'Grace' });
				const past = new Date(Date.now() - 2 * HOUR);
				await replacePasswordToken({ userId: grace.id, ...link('hash-stale', past) });

				await replacePasswordToken({ userId: ada.id, ...link('hash-ada') });

				expect((await tokenRows()).map((r) => r.tokenHash)).toEqual(['hash-ada']);
			});
		});

		describe('redeemPasswordToken', () => {
			it("works once, sets the hash, and deletes only that user's sessions", async () => {
				const ada = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
				const grace = await createUser({ identifier: 'grace@example.com', displayName: 'Grace' });
				const expiresAt = new Date(Date.now() + HOUR);
				await insertSession({ userId: ada.id, tokenHash: 'session-ada', expiresAt });
				await insertSession({ userId: grace.id, tokenHash: 'session-grace', expiresAt });
				await replacePasswordToken({ userId: ada.id, ...link('hash-ada') });

				const input = { tokenHash: 'hash-ada', passwordHash: 'salt:key', now: new Date() };
				expect(await redeemPasswordToken(input)).toBe(ada.id);
				expect(await redeemPasswordToken(input)).toBeUndefined();

				expect((await findUserCredentialById(ada.id))?.passwordHash).toBe('salt:key');
				expect(await findUserIdBySessionToken('session-ada')).toBeUndefined();
				expect(await findUserIdBySessionToken('session-grace')).toBe(grace.id);
				expect(await tokenRows()).toHaveLength(0);
			});

			it('refuses an expired link and writes nothing', async () => {
				const ada = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
				await insertSession({
					userId: ada.id,
					tokenHash: 'session-ada',
					expiresAt: new Date(Date.now() + HOUR),
				});
				const issuedAt = new Date(Date.now() - 2 * HOUR);
				await replacePasswordToken({ userId: ada.id, ...link('hash-ada', issuedAt) });

				expect(
					await redeemPasswordToken({
						tokenHash: 'hash-ada',
						passwordHash: 'salt:key',
						now: new Date(),
					}),
				).toBeUndefined();
				expect((await findUserCredentialById(ada.id))?.passwordHash).toBeNull();
				expect(await findUserIdBySessionToken('session-ada')).toBe(ada.id);
			});

			it('lets exactly one of two concurrent redemptions succeed', async () => {
				const ada = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
				await replacePasswordToken({ userId: ada.id, ...link('hash-ada') });
				const now = new Date();

				const results = await Promise.all([
					redeemPasswordToken({ tokenHash: 'hash-ada', passwordHash: 'first:hash', now }),
					redeemPasswordToken({ tokenHash: 'hash-ada', passwordHash: 'second:hash', now }),
				]);

				expect(results.filter((r) => r === ada.id)).toHaveLength(1);
				expect(results.filter((r) => r === undefined)).toHaveLength(1);
			});
		});

		it("drops a user's link when the user is deleted", async () => {
			const ada = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
			await replacePasswordToken({ userId: ada.id, ...link('hash-ada') });

			await getDb().delete(users).where(eq(users.id, ada.id));

			expect(await tokenRows()).toHaveLength(0);
		});
	},
);
