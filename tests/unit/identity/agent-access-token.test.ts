import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/agentAccessTokensRepository.js', () => ({
	insertAgentAccessToken: vi.fn(),
	listAgentAccessTokensOfUser: vi.fn(),
	deleteAgentAccessToken: vi.fn(),
	findLiveAgentAccessToken: vi.fn(),
	recordAgentAccessTokenUse: vi.fn(),
	deleteExpiredAgentAccessTokens: vi.fn(),
}));

import {
	deleteAgentAccessToken,
	deleteExpiredAgentAccessTokens,
	findLiveAgentAccessToken,
	insertAgentAccessToken,
	listAgentAccessTokensOfUser,
	recordAgentAccessTokenUse,
} from '@/db/repositories/agentAccessTokensRepository.js';
import {
	AGENT_ACCESS_TOKEN_USE_RECORD_INTERVAL_MS,
	AGENT_ACCESS_TOKEN_VALIDITY_DAYS,
	AgentAccessTokenSchema,
	agentAccessTokenExpiry,
	hasAgentAccessTokenExpired,
	IssueAgentAccessTokenInputSchema,
	MAY_USE_AGENT_ACCESS_TOKENS,
	mayUseAgentAccessTokens,
	SCOPED_AGENT_TOKEN_MAX_PROJECTS,
} from '@/identity/agent-access-token.js';
import {
	issueAgentAccessToken,
	listAgentAccessTokens,
	resolveAgentAccessToken,
	revokeAgentAccessToken,
} from '@/identity/agent-access-token-service.js';
import type { SwarmUser } from '@/identity/schema.js';

const ADMIN: SwarmUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'admin@example.com',
	displayName: 'Admin',
	instanceAdmin: true,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};
const MEMBER: SwarmUser = {
	...ADMIN,
	id: '22222222-2222-4222-8222-222222222222',
	identifier: 'member@example.com',
	instanceAdmin: false,
};

const NOW = new Date('2026-11-06T12:00:00Z');
const TOKEN_ID = '33333333-3333-4333-8333-333333333333';
const STORED = {
	id: TOKEN_ID,
	name: 'office laptop',
	createdAt: NOW.toISOString(),
	expiresAt: agentAccessTokenExpiry(NOW).toISOString(),
};

/** The live token a resolve finds: an unscoped one held by `ADMIN`. */
const LIVE = { user: ADMIN, tokenId: TOKEN_ID };
const allowEveryProject = async () => true;

const sha256hex = (value: string) => createHash('sha256').update(value).digest('hex');

beforeEach(() => {
	vi.mocked(insertAgentAccessToken).mockReset().mockResolvedValue(STORED);
	vi.mocked(listAgentAccessTokensOfUser).mockReset().mockResolvedValue([STORED]);
	vi.mocked(deleteAgentAccessToken).mockReset().mockResolvedValue(true);
	vi.mocked(findLiveAgentAccessToken).mockReset().mockResolvedValue(undefined);
	vi.mocked(recordAgentAccessTokenUse).mockReset().mockResolvedValue(undefined);
	vi.mocked(deleteExpiredAgentAccessTokens).mockReset().mockResolvedValue(0);
});

describe('agent access token rules (issue #1362)', () => {
	it('lets every installation role hold tokens, one decision per role (issue #1457)', () => {
		expect(MAY_USE_AGENT_ACCESS_TOKENS).toEqual({ instanceAdmin: true, user: true });
		expect(mayUseAgentAccessTokens(ADMIN)).toBe(true);
		expect(mayUseAgentAccessTokens(MEMBER)).toBe(true);
	});

	it('expires a token a fixed 30 days after issuing', () => {
		expect(AGENT_ACCESS_TOKEN_VALIDITY_DAYS).toBe(30);
		expect(agentAccessTokenExpiry(NOW).toISOString()).toBe('2026-12-06T12:00:00.000Z');
	});

	it('takes a non-blank name and nothing else when issuing', () => {
		expect(IssueAgentAccessTokenInputSchema.safeParse({ name: '  laptop  ' }).data).toEqual({
			name: 'laptop',
		});
		const blank = IssueAgentAccessTokenInputSchema.safeParse({ name: '   ' });
		expect(blank.success).toBe(false);
		expect(blank.error?.issues[0]?.message).toBe('A token name is required.');
		expect(
			IssueAgentAccessTokenInputSchema.safeParse({ name: 'laptop', userId: MEMBER.id }).success,
		).toBe(false);
	});

	// Issue #1385: a scoped agent credential names its projects at issuing.
	it('takes 1–50 project ids for a scoped credential, collapsing repeats', () => {
		expect(
			IssueAgentAccessTokenInputSchema.parse({
				name: 'agent',
				projectIds: ['proj-a', 'proj-b', 'proj-a'],
			}),
		).toEqual({ name: 'agent', projectIds: ['proj-a', 'proj-b'] });

		const empty = IssueAgentAccessTokenInputSchema.safeParse({ name: 'agent', projectIds: [] });
		expect(empty.success).toBe(false);
		expect(empty.error?.issues[0]?.message).toBe(
			'A scoped agent credential needs at least one project.',
		);
		expect(
			IssueAgentAccessTokenInputSchema.safeParse({ name: 'agent', projectIds: [''] }).success,
		).toBe(false);
		const tooMany = Array.from({ length: SCOPED_AGENT_TOKEN_MAX_PROJECTS + 1 }, (_, i) => `p${i}`);
		expect(
			IssueAgentAccessTokenInputSchema.safeParse({ name: 'agent', projectIds: tooMany }).success,
		).toBe(false);
	});

	it('has no token-value field on the list shape', () => {
		expect(Object.keys(AgentAccessTokenSchema.shape)).not.toContain('token');
		expect(AgentAccessTokenSchema.strict().safeParse({ ...STORED, token: 'raw' }).success).toBe(
			false,
		);
	});

	it('flags a listed token past its expiry', () => {
		expect(hasAgentAccessTokenExpired(STORED, NOW.getTime())).toBe(false);
		expect(hasAgentAccessTokenExpired(STORED, agentAccessTokenExpiry(NOW).getTime())).toBe(true);
	});
});

describe('issueAgentAccessToken', () => {
	it('returns a 256-bit token once and stores only its SHA-256 with an absolute expiry', async () => {
		const result = await issueAgentAccessToken({
			actor: ADMIN,
			token: { name: 'office laptop' },
			now: NOW,
			mayScopeTo: allowEveryProject,
		});

		if (result.outcome !== 'issued') throw new Error('expected an issued token');
		expect(result.issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(result.issued).toMatchObject(STORED);
		expect(insertAgentAccessToken).toHaveBeenCalledWith({
			userId: ADMIN.id,
			name: 'office laptop',
			tokenHash: sha256hex(result.issued.token),
			expiresAt: agentAccessTokenExpiry(NOW),
		});
	});

	it('issues a non-admin their own token, scoped by the same project rule (issue #1457)', async () => {
		const mayScopeTo = vi.fn(allowEveryProject);
		const result = await issueAgentAccessToken({
			actor: MEMBER,
			token: { name: 'x', projectIds: ['proj-a'] },
			now: NOW,
			mayScopeTo,
		});

		expect(result.outcome).toBe('issued');
		expect(mayScopeTo).toHaveBeenCalledWith('proj-a');
		expect(insertAgentAccessToken).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: MEMBER.id,
				projectIds: ['proj-a'],
				expiresAt: agentAccessTokenExpiry(NOW),
			}),
		);
	});

	it('stores the projects of a scoped credential once every one of them is allowed', async () => {
		const scoped = { ...STORED, projectIds: ['proj-a', 'proj-b'] };
		vi.mocked(insertAgentAccessToken).mockResolvedValue(scoped);
		const mayScopeTo = vi.fn(allowEveryProject);

		const result = await issueAgentAccessToken({
			actor: ADMIN,
			token: { name: 'agent', projectIds: ['proj-a', 'proj-b'] },
			now: NOW,
			mayScopeTo,
		});

		if (result.outcome !== 'issued') throw new Error('expected an issued token');
		expect(result.issued.projectIds).toEqual(['proj-a', 'proj-b']);
		expect(mayScopeTo.mock.calls).toEqual([['proj-a'], ['proj-b']]);
		expect(insertAgentAccessToken).toHaveBeenCalledWith(
			expect.objectContaining({ projectIds: ['proj-a', 'proj-b'] }),
		);
	});

	it('refuses the whole credential as unknown-project when any project is not allowed', async () => {
		const result = await issueAgentAccessToken({
			actor: ADMIN,
			token: { name: 'agent', projectIds: ['proj-a', 'proj-missing'] },
			now: NOW,
			mayScopeTo: async (projectId) => projectId === 'proj-a',
		});

		expect(result).toEqual({ outcome: 'unknown-project' });
		expect(insertAgentAccessToken).not.toHaveBeenCalled();
	});
});

describe('listAgentAccessTokens / revokeAgentAccessToken', () => {
	it("lists the caller's own tokens", async () => {
		expect(await listAgentAccessTokens(ADMIN)).toEqual({ outcome: 'listed', tokens: [STORED] });
		expect(listAgentAccessTokensOfUser).toHaveBeenCalledWith(ADMIN.id);
	});

	it('revokes only within the caller’s own tokens', async () => {
		expect(await revokeAgentAccessToken(TOKEN_ID, ADMIN)).toEqual({ outcome: 'revoked' });
		expect(deleteAgentAccessToken).toHaveBeenCalledWith(TOKEN_ID, ADMIN.id);

		vi.mocked(deleteAgentAccessToken).mockResolvedValue(false);
		expect(await revokeAgentAccessToken(TOKEN_ID, ADMIN)).toEqual({ outcome: 'unknown-token' });
	});

	it('lists and revokes a non-admin’s own tokens (issue #1457)', async () => {
		expect(await listAgentAccessTokens(MEMBER)).toEqual({ outcome: 'listed', tokens: [STORED] });
		expect(listAgentAccessTokensOfUser).toHaveBeenCalledWith(MEMBER.id);
		expect(await revokeAgentAccessToken(TOKEN_ID, MEMBER)).toEqual({ outcome: 'revoked' });
		expect(deleteAgentAccessToken).toHaveBeenCalledWith(TOKEN_ID, MEMBER.id);
	});
});

describe('resolveAgentAccessToken', () => {
	it('resolves a live token by its hash and stamps its use, throttled to a minute', async () => {
		vi.mocked(findLiveAgentAccessToken).mockResolvedValue(LIVE);

		expect(await resolveAgentAccessToken('raw-token', NOW)).toBe(LIVE);
		expect(findLiveAgentAccessToken).toHaveBeenCalledWith(sha256hex('raw-token'), NOW);
		expect(recordAgentAccessTokenUse).toHaveBeenCalledWith(
			sha256hex('raw-token'),
			NOW,
			new Date(NOW.getTime() - AGENT_ACCESS_TOKEN_USE_RECORD_INTERVAL_MS),
		);
		expect(AGENT_ACCESS_TOKEN_USE_RECORD_INTERVAL_MS).toBe(60_000);
		expect(deleteExpiredAgentAccessTokens).toHaveBeenCalledWith(NOW);
	});

	it('stamps nothing for a token that does not resolve', async () => {
		expect(await resolveAgentAccessToken('revoked-or-expired', NOW)).toBeUndefined();
		expect(recordAgentAccessTokenUse).not.toHaveBeenCalled();
	});

	it('never lets a failed stamp or sweep block a live token', async () => {
		vi.mocked(findLiveAgentAccessToken).mockResolvedValue(LIVE);
		vi.mocked(recordAgentAccessTokenUse).mockRejectedValue(new Error('db down'));
		vi.mocked(deleteExpiredAgentAccessTokens).mockRejectedValue(new Error('db down'));

		expect(await resolveAgentAccessToken('raw-token', NOW)).toBe(LIVE);
	});

	it("returns a scoped credential's projects with its holder and id (issue #1385)", async () => {
		const scoped = { ...LIVE, projectIds: ['proj-a'] };
		vi.mocked(findLiveAgentAccessToken).mockResolvedValue(scoped);

		expect(await resolveAgentAccessToken('raw-token', NOW)).toEqual({
			user: ADMIN,
			tokenId: TOKEN_ID,
			projectIds: ['proj-a'],
		});
	});

	it('resolves an empty token to nothing without a query', async () => {
		expect(await resolveAgentAccessToken('', NOW)).toBeUndefined();
		expect(findLiveAgentAccessToken).not.toHaveBeenCalled();
	});
});
