import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import {
	deleteAgentAccessToken,
	deleteExpiredAgentAccessTokens,
	findLiveAgentAccessToken,
	insertAgentAccessToken,
	listAgentAccessTokensOfUser,
	recordAgentAccessTokenUse,
} from '../../../src/db/repositories/agentAccessTokensRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { agentAccessTokens } from '../../../src/db/schema/agentAccessTokens.js';
import { truncateAll } from '../helpers/db.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-06T12:00:00Z');

async function rows() {
	return getDb().select().from(agentAccessTokens);
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'agentAccessTokensRepository (integration, issue #1362)',
	() => {
		beforeEach(async () => {
			await truncateAll();
		});

		async function adminWithToken(tokenHash = 'hash-a', expiresAt = new Date(NOW.getTime() + DAY)) {
			const user = await createUser({
				identifier: 'admin@example.com',
				displayName: 'Admin',
				instanceAdmin: true,
			});
			const token = await insertAgentAccessToken({
				userId: user.id,
				name: 'office laptop',
				tokenHash,
				expiresAt,
			});
			return { user, token };
		}

		it('stores the hash and returns the wire shape without it or a last use', async () => {
			const { user, token } = await adminWithToken();

			expect(Object.keys(token).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'name']);
			expect(await listAgentAccessTokensOfUser(user.id)).toEqual([token]);
			expect((await rows())[0]).toMatchObject({ tokenHash: 'hash-a', lastUsedAt: null });
		});

		it('resolves a live token to its holder, and an expired or unknown one to nothing', async () => {
			const { user } = await adminWithToken('hash-live');
			await insertAgentAccessToken({
				userId: user.id,
				name: 'old',
				tokenHash: 'hash-expired',
				expiresAt: new Date(NOW.getTime() - 1),
			});

			const live = await findLiveAgentAccessToken('hash-live', NOW);
			expect(live?.user).toMatchObject({ id: user.id, instanceAdmin: true });
			// An ordinary token carries no project scope.
			expect(live).not.toHaveProperty('projectIds');
			expect(await findLiveAgentAccessToken('hash-expired', NOW)).toBeUndefined();
			expect(await findLiveAgentAccessToken('hash-unknown', NOW)).toBeUndefined();
			// The expired row is still listed (and flagged by the screen) until swept.
			expect(await listAgentAccessTokensOfUser(user.id)).toHaveLength(2);

			expect(await deleteExpiredAgentAccessTokens(NOW)).toBe(1);
			expect(await listAgentAccessTokensOfUser(user.id)).toHaveLength(1);
		});

		it('stores, lists and resolves the projects of a scoped credential (issue #1385)', async () => {
			const { user } = await adminWithToken();
			const scoped = await insertAgentAccessToken({
				userId: user.id,
				name: 'agent',
				tokenHash: 'hash-scoped',
				expiresAt: new Date(NOW.getTime() + 60_000),
				projectIds: ['proj-a', 'proj-b'],
			});

			expect(scoped.projectIds).toEqual(['proj-a', 'proj-b']);
			expect(await findLiveAgentAccessToken('hash-scoped', NOW)).toMatchObject({
				tokenId: scoped.id,
				projectIds: ['proj-a', 'proj-b'],
			});
			const listed = await listAgentAccessTokensOfUser(user.id);
			expect(listed.find((token) => token.id === scoped.id)?.projectIds).toEqual([
				'proj-a',
				'proj-b',
			]);
		});

		it('stamps the last use at most once per throttle window', async () => {
			const { user } = await adminWithToken();
			const minute = 60_000;

			await recordAgentAccessTokenUse('hash-a', NOW, new Date(NOW.getTime() - minute));
			const later = new Date(NOW.getTime() + 30_000);
			await recordAgentAccessTokenUse('hash-a', later, new Date(later.getTime() - minute));
			expect((await listAgentAccessTokensOfUser(user.id))[0]?.lastUsedAt).toBe(NOW.toISOString());

			const muchLater = new Date(NOW.getTime() + 2 * minute);
			await recordAgentAccessTokenUse('hash-a', muchLater, new Date(muchLater.getTime() - minute));
			expect((await listAgentAccessTokensOfUser(user.id))[0]?.lastUsedAt).toBe(
				muchLater.toISOString(),
			);
		});

		it("revokes only the owner's token; another account's id is the same miss as none", async () => {
			const { user, token } = await adminWithToken();
			const other = await createUser({ identifier: 'other@example.com', displayName: 'Other' });

			expect(await deleteAgentAccessToken(token.id, other.id)).toBe(false);
			expect(await rows()).toHaveLength(1);
			expect(await deleteAgentAccessToken(token.id, user.id)).toBe(true);
			expect(await deleteAgentAccessToken(token.id, user.id)).toBe(false);
			expect(await findLiveAgentAccessToken('hash-a', NOW)).toBeUndefined();
		});
	},
);
