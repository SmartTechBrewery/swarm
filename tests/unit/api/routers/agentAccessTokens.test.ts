import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/identity/agent-access-token-service.js', () => ({
	issueAgentAccessToken: vi.fn(),
	listAgentAccessTokens: vi.fn(),
	revokeAgentAccessToken: vi.fn(),
}));

import { agentAccessTokensRouter } from '@/api/routers/agentAccessTokens.js';
import {
	issueAgentAccessToken,
	listAgentAccessTokens,
	revokeAgentAccessToken,
} from '@/identity/agent-access-token-service.js';
import type { SwarmUser } from '@/identity/schema.js';

const ADMIN: SwarmUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'admin@example.com',
	displayName: 'Admin',
	instanceAdmin: true,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const TOKEN_ID = '33333333-3333-4333-8333-333333333333';
const TOKEN = {
	id: TOKEN_ID,
	name: 'office laptop',
	createdAt: '2026-11-06T12:00:00.000Z',
	expiresAt: '2026-12-06T12:00:00.000Z',
};

async function expectCode(promise: Promise<unknown>, code: TRPCError['code']): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(TRPCError);
	await expect(promise).rejects.toMatchObject({ code });
}

describe('agentAccessTokensRouter (issue #1362)', () => {
	const caller = agentAccessTokensRouter.createCaller({ user: ADMIN });

	beforeEach(() => {
		vi.mocked(issueAgentAccessToken).mockReset();
		vi.mocked(listAgentAccessTokens).mockReset();
		vi.mocked(revokeAgentAccessToken).mockReset();
	});

	it('requires a signed-in caller', async () => {
		await expectCode(agentAccessTokensRouter.createCaller({ user: null }).list(), 'UNAUTHORIZED');
	});

	it('issues for the caller, returning the raw token in this response only', async () => {
		vi.mocked(issueAgentAccessToken).mockResolvedValue({
			outcome: 'issued',
			issued: { ...TOKEN, token: 'raw' },
		});

		expect(await caller.issue({ name: '  office laptop ' })).toEqual({ ...TOKEN, token: 'raw' });
		expect(issueAgentAccessToken).toHaveBeenCalledWith(
			expect.objectContaining({ actor: ADMIN, token: { name: 'office laptop' } }),
		);
	});

	it('refuses a blank name or any field besides it, before the service', async () => {
		await expectCode(caller.issue({ name: '  ' }), 'BAD_REQUEST');
		await expectCode(
			caller.issue({ name: 'x', userId: ADMIN.id } as unknown as { name: string }),
			'BAD_REQUEST',
		);
		expect(issueAgentAccessToken).not.toHaveBeenCalled();
	});

	it('lists and revokes', async () => {
		vi.mocked(listAgentAccessTokens).mockResolvedValue({ outcome: 'listed', tokens: [TOKEN] });
		vi.mocked(revokeAgentAccessToken).mockResolvedValue({ outcome: 'revoked' });

		expect(await caller.list()).toEqual([TOKEN]);
		expect(await caller.revoke({ tokenId: TOKEN_ID })).toEqual({ ok: true });
		expect(revokeAgentAccessToken).toHaveBeenCalledWith(TOKEN_ID, ADMIN);
	});

	it('answers an unknown or foreign token id with NOT_FOUND', async () => {
		vi.mocked(revokeAgentAccessToken).mockResolvedValue({ outcome: 'unknown-token' });

		await expectCode(caller.revoke({ tokenId: TOKEN_ID }), 'NOT_FOUND');
	});

	it('maps the role refusal of every verb to FORBIDDEN', async () => {
		vi.mocked(issueAgentAccessToken).mockResolvedValue({ outcome: 'forbidden' });
		vi.mocked(listAgentAccessTokens).mockResolvedValue({ outcome: 'forbidden' });
		vi.mocked(revokeAgentAccessToken).mockResolvedValue({ outcome: 'forbidden' });

		await expectCode(caller.issue({ name: 'x' }), 'FORBIDDEN');
		await expectCode(caller.list(), 'FORBIDDEN');
		await expectCode(caller.revoke({ tokenId: TOKEN_ID }), 'FORBIDDEN');
	});
});
