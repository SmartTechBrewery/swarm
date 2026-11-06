import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	AGENT_ACCESS_TOKEN_VALIDITY_DAYS,
	IssueAgentAccessTokenInputSchema,
} from '../../identity/agent-access-token.js';
import {
	issueAgentAccessToken,
	listAgentAccessTokens,
	revokeAgentAccessToken,
} from '../../identity/agent-access-token-service.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * The signed-in user's own **agent access tokens** (issue #1362) — the API behind
 * the profile's MCP tab. A token is what an MCP client sends to `/operator/mcp`
 * as `Authorization: Bearer`; this router only manages them and accepts none.
 *
 * **The subject is always `ctx.user`.** Issuing takes a name and nothing else,
 * list and revoke see only the caller's own tokens, and no procedure takes a user
 * id — so no request here can reach another account's tokens.
 *
 * **Installation administrators only** (`MAY_USE_AGENT_ACCESS_TOKENS`): any other
 * caller gets `FORBIDDEN` from all three before any query, so the refusal says
 * nothing about what is stored. Somebody else's token id revokes as `NOT_FOUND`,
 * exactly like one never issued.
 *
 * The raw token is in the `issue` response and nowhere else — the list's shape
 * has no field for it, and the database holds a hash alone. Each token lives
 * {@link AGENT_ACCESS_TOKEN_VALIDITY_DAYS} days from issuing, never slid by use.
 *
 * Deliberately **not** mounted on the operator router (`../operator-router.ts`):
 * managing tokens stays on the dashboard's own session.
 */

const FORBIDDEN_MESSAGE = 'Only installation administrators can hold agent access tokens.';

function forbidden(): TRPCError {
	return new TRPCError({ code: 'FORBIDDEN', message: FORBIDDEN_MESSAGE });
}

export const agentAccessTokensRouter = router({
	list: authedProcedure.query(async ({ ctx }) => {
		const read = await listAgentAccessTokens(ctx.user);
		if (read.outcome === 'forbidden') throw forbidden();
		return read.tokens;
	}),

	issue: authedProcedure
		.input(IssueAgentAccessTokenInputSchema)
		.mutation(async ({ ctx, input }) => {
			const issued = await issueAgentAccessToken({
				actor: ctx.user,
				token: input,
				now: new Date(),
			});
			if (issued.outcome === 'forbidden') throw forbidden();
			return issued.issued;
		}),

	revoke: authedProcedure
		.input(z.object({ tokenId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			const revoked = await revokeAgentAccessToken(input.tokenId, ctx.user);
			switch (revoked.outcome) {
				case 'revoked':
					return { ok: true as const };
				case 'forbidden':
					throw forbidden();
				default:
					throw new TRPCError({
						code: 'NOT_FOUND',
						message: 'You have no agent access token with this id.',
					});
			}
		}),
});
