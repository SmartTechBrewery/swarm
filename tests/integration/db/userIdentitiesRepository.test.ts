import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import {
	findUserIdByIdentity,
	linkIdentity,
	listIdentities,
	listIdentitiesForUser,
	unlinkIdentity,
} from '../../../src/db/repositories/userIdentitiesRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { userIdentities } from '../../../src/db/schema/userIdentities.js';
import { users } from '../../../src/db/schema/users.js';
import { IdentityLinkConflictError } from '../../../src/identity/user-identity.js';
import { truncateAll } from '../helpers/db.js';

const PROVIDER = 'github-projects';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'userIdentitiesRepository (integration)',
	() => {
		let adaId: string;
		let graceId: string;

		beforeEach(async () => {
			await truncateAll();
			adaId = (await createUser({ identifier: 'ada@example.com', displayName: 'Ada' })).id;
			graceId = (await createUser({ identifier: 'grace@example.com', displayName: 'Grace' })).id;
		});

		describe('linkIdentity / findUserIdByIdentity', () => {
			it('round-trips a link with generated id/createdAt', async () => {
				const link = await linkIdentity({ userId: adaId, provider: PROVIDER, handle: 'ada' });

				expect(link.id).toMatch(/^[0-9a-f-]{36}$/);
				expect(link.userId).toBe(adaId);
				expect(link.provider).toBe(PROVIDER);
				expect(link.handle).toBe('ada');
				expect(link.createdAt).toBeInstanceOf(Date);

				expect(await findUserIdByIdentity(PROVIDER, 'ada')).toBe(adaId);
			});

			it('returns undefined for an unlinked handle or a different provider', async () => {
				await linkIdentity({ userId: adaId, provider: PROVIDER, handle: 'ada' });

				expect(await findUserIdByIdentity(PROVIDER, 'stranger')).toBeUndefined();
				expect(await findUserIdByIdentity('jira', 'ada')).toBeUndefined();
			});

			it('is idempotent for a re-link of the same user/provider/handle', async () => {
				const first = await linkIdentity({ userId: adaId, provider: PROVIDER, handle: 'ada' });
				const again = await linkIdentity({ userId: adaId, provider: PROVIDER, handle: 'ada' });

				expect(again).toEqual(first);
				const rows = await getDb().select().from(userIdentities);
				expect(rows).toHaveLength(1);
			});

			it('refuses to re-point a handle at a second user', async () => {
				await linkIdentity({ userId: adaId, provider: PROVIDER, handle: 'ada' });

				const attempt = linkIdentity({ userId: graceId, provider: PROVIDER, handle: 'ada' });
				await expect(attempt).rejects.toThrow('already linked to another user');
				// Typed, so the API can name the owner (issue #1167).
				await expect(attempt).rejects.toBeInstanceOf(IdentityLinkConflictError);
				await expect(attempt).rejects.toMatchObject({ existingUserId: adaId });
				expect(await findUserIdByIdentity(PROVIDER, 'ada')).toBe(adaId);
			});

			it('normalizes casing/whitespace on write and lookup', async () => {
				const link = await linkIdentity({
					userId: adaId,
					provider: ' GitHub-Projects ',
					handle: ' Ada ',
				});

				expect(link.provider).toBe(PROVIDER);
				expect(link.handle).toBe('ada');
				expect(await findUserIdByIdentity(PROVIDER, 'ADA')).toBe(adaId);
				// Same handle in different casing is the same link, not a second user's.
				await expect(
					linkIdentity({ userId: graceId, provider: PROVIDER, handle: 'ADA' }),
				).rejects.toMatchObject({ name: 'IdentityLinkConflictError', existingUserId: adaId });
			});

			it('rejects whitespace-only provider or handle values with ZodError', async () => {
				await expect(
					linkIdentity({ userId: adaId, provider: ' ', handle: 'ada' }),
				).rejects.toThrow();
				await expect(
					linkIdentity({ userId: adaId, provider: PROVIDER, handle: ' ' }),
				).rejects.toThrow();
			});
		});

		describe('listIdentitiesForUser / listIdentities', () => {
			it("lists a user's handles and every link on the installation", async () => {
				await linkIdentity({ userId: adaId, provider: PROVIDER, handle: 'ada' });
				await linkIdentity({ userId: adaId, provider: 'jira', handle: 'ada-jira' });
				await linkIdentity({ userId: graceId, provider: PROVIDER, handle: 'grace' });

				expect((await listIdentitiesForUser(adaId)).map((i) => i.handle)).toEqual([
					'ada',
					'ada-jira',
				]);
				expect(await listIdentities()).toHaveLength(3);
			});

			it('returns an empty array for a user with no links', async () => {
				expect(await listIdentitiesForUser(adaId)).toEqual([]);
				expect(await listIdentities()).toEqual([]);
			});
		});

		describe('unlinkIdentity', () => {
			it('removes a link and reports whether one existed', async () => {
				await linkIdentity({ userId: adaId, provider: PROVIDER, handle: 'ada' });

				expect(await unlinkIdentity(PROVIDER, 'Ada')).toBe(true);
				expect(await findUserIdByIdentity(PROVIDER, 'ada')).toBeUndefined();
				expect(await unlinkIdentity(PROVIDER, 'ada')).toBe(false);
			});

			it('frees the handle for another user', async () => {
				await linkIdentity({ userId: adaId, provider: PROVIDER, handle: 'ada' });
				await unlinkIdentity(PROVIDER, 'ada');

				await linkIdentity({ userId: graceId, provider: PROVIDER, handle: 'ada' });
				expect(await findUserIdByIdentity(PROVIDER, 'ada')).toBe(graceId);
			});
		});

		describe('cascade deletes', () => {
			it('drops links when their user is deleted', async () => {
				await linkIdentity({ userId: adaId, provider: PROVIDER, handle: 'ada' });
				await linkIdentity({ userId: graceId, provider: PROVIDER, handle: 'grace' });

				await getDb().delete(users).where(eq(users.id, adaId));

				expect(await findUserIdByIdentity(PROVIDER, 'ada')).toBeUndefined();
				expect(await findUserIdByIdentity(PROVIDER, 'grace')).toBe(graceId);
			});
		});
	},
);
