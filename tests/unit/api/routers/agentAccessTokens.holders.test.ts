import { TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #1457: every signed-in user holds agent access tokens. Unlike
 * `./agentAccessTokens.test.ts`, which pins the router's mapping against a mocked
 * service, this suite runs the router **and** the real service for a non-admin,
 * mocking only the stores beneath them — so the installation-role rule, the
 * `member` scoping rule and the 30-day expiry are all the production ones.
 */

vi.mock('@/db/repositories/agentAccessTokensRepository.js', () => ({
	insertAgentAccessToken: vi.fn(),
	listAgentAccessTokensOfUser: vi.fn(),
	deleteAgentAccessToken: vi.fn(),
	deleteAgentAccessTokensOfRun: vi.fn(),
	findLiveAgentAccessToken: vi.fn(),
	recordAgentAccessTokenUse: vi.fn(),
	deleteExpiredAgentAccessTokens: vi.fn(),
}));

const { findProjectRecordByIdFromDb } = vi.hoisted(() => ({
	findProjectRecordByIdFromDb: vi.fn(),
}));
vi.mock('@/db/repositories/projectsRepository.js', () => ({ findProjectRecordByIdFromDb }));

const { getMembership, listAccessibleProjectIds } = vi.hoisted(() => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));
vi.mock('@/identity/membership-service.js', () => ({ getMembership, listAccessibleProjectIds }));

import { agentAccessTokensRouter } from '@/api/routers/agentAccessTokens.js';
import {
	deleteAgentAccessToken,
	insertAgentAccessToken,
	listAgentAccessTokensOfUser,
} from '@/db/repositories/agentAccessTokensRepository.js';
import { agentAccessTokenExpiry } from '@/identity/agent-access-token.js';
import type { ProjectRole } from '@/identity/membership.js';
import type { SwarmUser } from '@/identity/schema.js';

function user(id: string, identifier: string): SwarmUser {
	return {
		id,
		identifier,
		displayName: identifier,
		instanceAdmin: false,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

/** A non-admin who may drive `proj-a` (`member`) and only read `proj-b` (`contributor`). */
const DRIVER = user('22222222-2222-4222-8222-222222222222', 'driver@example.com');
/** A non-admin with no project membership at all. */
const NOBODY = user('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'nobody@example.com');

const ROLES: Record<string, Record<string, ProjectRole>> = {
	[DRIVER.id]: { 'proj-a': 'member', 'proj-b': 'contributor' },
};

const NOW = new Date('2026-11-13T12:00:00Z');
const TOKEN_ID = '33333333-3333-4333-8333-333333333333';

async function expectCode(promise: Promise<unknown>, code: TRPCError['code']): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(TRPCError);
	await expect(promise).rejects.toMatchObject({ code });
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	vi.mocked(insertAgentAccessToken)
		.mockReset()
		.mockImplementation(async (values) => ({
			id: TOKEN_ID,
			name: values.name,
			createdAt: NOW.toISOString(),
			expiresAt: values.expiresAt.toISOString(),
			...(values.projectIds ? { projectIds: values.projectIds } : {}),
		}));
	vi.mocked(listAgentAccessTokensOfUser).mockReset().mockResolvedValue([]);
	vi.mocked(deleteAgentAccessToken).mockReset();
	findProjectRecordByIdFromDb
		.mockReset()
		.mockImplementation(async (id: string) =>
			['proj-a', 'proj-b', 'proj-c'].includes(id) ? { id } : undefined,
		);
	getMembership.mockReset().mockImplementation(async (userId: string, projectId: string) => {
		const role = ROLES[userId]?.[projectId];
		return role
			? { id: `m-${projectId}`, userId, projectId, role, createdAt: new Date(0) }
			: undefined;
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe('agentAccessTokensRouter — a non-admin holder (issue #1457)', () => {
	const caller = agentAccessTokensRouter.createCaller({ user: DRIVER });

	it('issues a full-access token for themselves, valid a fixed 30 days', async () => {
		const issued = await caller.issue({ name: 'laptop' });

		expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(issued.expiresAt).toBe(agentAccessTokenExpiry(NOW).toISOString());
		expect(insertAgentAccessToken).toHaveBeenCalledWith(
			expect.objectContaining({ userId: DRIVER.id, name: 'laptop' }),
		);
		expect(vi.mocked(insertAgentAccessToken).mock.calls[0][0]).not.toHaveProperty('projectIds');
	});

	it('issues a token scoped to a project they may drive', async () => {
		const issued = await caller.issue({ name: 'agent', projectIds: ['proj-a'] });

		expect(issued.projectIds).toEqual(['proj-a']);
		expect(getMembership).toHaveBeenCalledWith(DRIVER.id, 'proj-a');
		expect(insertAgentAccessToken).toHaveBeenCalledWith(
			expect.objectContaining({ userId: DRIVER.id, projectIds: ['proj-a'] }),
		);
	});

	it.each([
		['one they may only read', 'proj-b'],
		['one they are not a member of', 'proj-c'],
		['one that does not exist', 'proj-missing'],
	])('refuses scoping to %s as NOT_FOUND, storing nothing', async (_, projectId) => {
		await expectCode(
			caller.issue({ name: 'agent', projectIds: ['proj-a', projectId] }),
			'NOT_FOUND',
		);
		expect(insertAgentAccessToken).not.toHaveBeenCalled();
	});

	it('lists their own tokens', async () => {
		const own = {
			id: TOKEN_ID,
			name: 'laptop',
			createdAt: NOW.toISOString(),
			expiresAt: agentAccessTokenExpiry(NOW).toISOString(),
		};
		vi.mocked(listAgentAccessTokensOfUser).mockResolvedValue([own]);

		expect(await caller.list()).toEqual([own]);
		expect(listAgentAccessTokensOfUser).toHaveBeenCalledWith(DRIVER.id);
	});

	it('revokes their own token, and reads a foreign or repeated one as NOT_FOUND', async () => {
		vi.mocked(deleteAgentAccessToken).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

		expect(await caller.revoke({ tokenId: TOKEN_ID })).toEqual({ ok: true });
		expect(deleteAgentAccessToken).toHaveBeenCalledWith(TOKEN_ID, DRIVER.id);
		await expectCode(caller.revoke({ tokenId: TOKEN_ID }), 'NOT_FOUND');
	});
});

describe('agentAccessTokensRouter — a user with no membership (issue #1457)', () => {
	const caller = agentAccessTokensRouter.createCaller({ user: NOBODY });

	it('issues, lists and revokes an ordinary token', async () => {
		vi.mocked(deleteAgentAccessToken).mockResolvedValue(true);

		expect((await caller.issue({ name: 'laptop' })).token).toBeTruthy();
		expect(await caller.list()).toEqual([]);
		expect(await caller.revoke({ tokenId: TOKEN_ID })).toEqual({ ok: true });
		expect(listAgentAccessTokensOfUser).toHaveBeenCalledWith(NOBODY.id);
		expect(deleteAgentAccessToken).toHaveBeenCalledWith(TOKEN_ID, NOBODY.id);
	});

	it('cannot scope a token to any project', async () => {
		await expectCode(caller.issue({ name: 'agent', projectIds: ['proj-a'] }), 'NOT_FOUND');
		expect(insertAgentAccessToken).not.toHaveBeenCalled();
	});
});
