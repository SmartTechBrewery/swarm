import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/agentAccessTokensRepository.js', () => ({
	insertAgentAccessToken: vi.fn(),
	listAgentAccessTokensOfUser: vi.fn(),
	deleteAgentAccessToken: vi.fn(),
	findUserByLiveAgentAccessToken: vi.fn(),
	recordAgentAccessTokenUse: vi.fn(),
	deleteExpiredAgentAccessTokens: vi.fn(),
}));

import {
	deleteAgentAccessToken,
	deleteExpiredAgentAccessTokens,
	findUserByLiveAgentAccessToken,
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

const sha256hex = (value: string) => createHash('sha256').update(value).digest('hex');

beforeEach(() => {
	vi.mocked(insertAgentAccessToken).mockReset().mockResolvedValue(STORED);
	vi.mocked(listAgentAccessTokensOfUser).mockReset().mockResolvedValue([STORED]);
	vi.mocked(deleteAgentAccessToken).mockReset().mockResolvedValue(true);
	vi.mocked(findUserByLiveAgentAccessToken).mockReset().mockResolvedValue(undefined);
	vi.mocked(recordAgentAccessTokenUse).mockReset().mockResolvedValue(undefined);
	vi.mocked(deleteExpiredAgentAccessTokens).mockReset().mockResolvedValue(0);
});

describe('agent access token rules (issue #1362)', () => {
	it('lets installation administrators and nobody else hold tokens, one decision per role', () => {
		expect(MAY_USE_AGENT_ACCESS_TOKENS).toEqual({ instanceAdmin: true, user: false });
		expect(mayUseAgentAccessTokens(ADMIN)).toBe(true);
		expect(mayUseAgentAccessTokens(MEMBER)).toBe(false);
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

	it('refuses a non-admin before any query', async () => {
		const result = await issueAgentAccessToken({ actor: MEMBER, token: { name: 'x' }, now: NOW });

		expect(result).toEqual({ outcome: 'forbidden' });
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

	it('refuses a non-admin before any query', async () => {
		expect(await listAgentAccessTokens(MEMBER)).toEqual({ outcome: 'forbidden' });
		expect(await revokeAgentAccessToken(TOKEN_ID, MEMBER)).toEqual({ outcome: 'forbidden' });
		expect(listAgentAccessTokensOfUser).not.toHaveBeenCalled();
		expect(deleteAgentAccessToken).not.toHaveBeenCalled();
	});
});

describe('resolveAgentAccessToken', () => {
	it('resolves a live token by its hash and stamps its use, throttled to a minute', async () => {
		vi.mocked(findUserByLiveAgentAccessToken).mockResolvedValue(ADMIN);

		expect(await resolveAgentAccessToken('raw-token', NOW)).toBe(ADMIN);
		expect(findUserByLiveAgentAccessToken).toHaveBeenCalledWith(sha256hex('raw-token'), NOW);
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
		vi.mocked(findUserByLiveAgentAccessToken).mockResolvedValue(ADMIN);
		vi.mocked(recordAgentAccessTokenUse).mockRejectedValue(new Error('db down'));
		vi.mocked(deleteExpiredAgentAccessTokens).mockRejectedValue(new Error('db down'));

		expect(await resolveAgentAccessToken('raw-token', NOW)).toBe(ADMIN);
	});

	it('resolves an empty token to nothing without a query', async () => {
		expect(await resolveAgentAccessToken('', NOW)).toBeUndefined();
		expect(findUserByLiveAgentAccessToken).not.toHaveBeenCalled();
	});
});
