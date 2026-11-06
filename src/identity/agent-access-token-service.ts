/**
 * Issuing, listing, revoking and resolving **agent access tokens** (issue #1362)
 * — the node half of `./agent-access-token.ts`, which holds the wire shapes and
 * the per-role decision. Nothing here touches the session (`./auth.ts`): the token
 * is a second credential beside it, not a change to it.
 *
 * Because the token has 256 bits of entropy, its SHA-256 needs neither salt nor
 * stretching — it exists only so a leaked row cannot be replayed. The raw value
 * reaches neither the logs nor any answer but the one to the issuing, and
 * nothing in this module logs.
 *
 * The three holder verbs refuse a role `MAY_USE_AGENT_ACCESS_TOKENS` denies
 * **before any query**, so a refusal says nothing about what is stored. Their
 * expected outcomes are values, not exceptions; the API layer maps them to codes.
 */

import { createHash, randomBytes } from 'node:crypto';

import {
	deleteAgentAccessToken,
	deleteExpiredAgentAccessTokens,
	findUserByLiveAgentAccessToken,
	insertAgentAccessToken,
	listAgentAccessTokensOfUser,
	recordAgentAccessTokenUse,
} from '../db/repositories/agentAccessTokensRepository.js';
import {
	AGENT_ACCESS_TOKEN_USE_RECORD_INTERVAL_MS,
	type AgentAccessToken,
	agentAccessTokenExpiry,
	type IssueAgentAccessTokenInput,
	type IssuedAgentAccessToken,
	mayUseAgentAccessTokens,
} from './agent-access-token.js';
import type { SwarmUser } from './schema.js';

const AGENT_ACCESS_TOKEN_BYTES = 32;

export type IssueAgentAccessTokenOutcome =
	| { outcome: 'issued'; issued: IssuedAgentAccessToken }
	| { outcome: 'forbidden' };

export type ListAgentAccessTokensOutcome =
	| { outcome: 'listed'; tokens: AgentAccessToken[] }
	| { outcome: 'forbidden' };

/**
 * `unknown-token` is the revoke's alone: there is no such token **of this
 * account**. Somebody else's token is deliberately the same answer as one that
 * was never there.
 */
export type RevokeAgentAccessTokenOutcome =
	| { outcome: 'revoked' }
	| { outcome: 'forbidden' }
	| { outcome: 'unknown-token' };

/** SHA-256 of a raw token — the only form that touches the database. Private on purpose. */
function hashAgentAccessToken(rawToken: string): string {
	return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Issue a token for the caller themselves: the raw value goes back, only its
 * hash to the database. The input is the name alone — the account is `actor`,
 * resolved from the session — so no request can issue one for somebody else.
 */
export async function issueAgentAccessToken(input: {
	actor: SwarmUser;
	token: IssueAgentAccessTokenInput;
	now: Date;
}): Promise<IssueAgentAccessTokenOutcome> {
	if (!mayUseAgentAccessTokens(input.actor)) return { outcome: 'forbidden' };

	const token = randomBytes(AGENT_ACCESS_TOKEN_BYTES).toString('base64url');
	const stored = await insertAgentAccessToken({
		userId: input.actor.id,
		name: input.token.name,
		tokenHash: hashAgentAccessToken(token),
		expiresAt: agentAccessTokenExpiry(input.now),
	});
	return { outcome: 'issued', issued: { ...stored, token } };
}

/** The caller's **own** tokens, the freshest first — never a raw value. */
export async function listAgentAccessTokens(
	actor: SwarmUser,
): Promise<ListAgentAccessTokensOutcome> {
	if (!mayUseAgentAccessTokens(actor)) return { outcome: 'forbidden' };
	return { outcome: 'listed', tokens: await listAgentAccessTokensOfUser(actor.id) };
}

/** Revoke one of the caller's own tokens; a repeat ends like an id never issued. */
export async function revokeAgentAccessToken(
	tokenId: string,
	actor: SwarmUser,
): Promise<RevokeAgentAccessTokenOutcome> {
	if (!mayUseAgentAccessTokens(actor)) return { outcome: 'forbidden' };
	return (await deleteAgentAccessToken(tokenId, actor.id))
		? { outcome: 'revoked' }
		: { outcome: 'unknown-token' };
}

/**
 * Resolve a raw token to its holder, or `undefined` when no live token matches —
 * the twin of `resolveSession`. A token never issued, an expired one and a
 * revoked one are **one** `undefined`, so the caller's single refusal tells the
 * asker nothing about which tokens exist.
 *
 * A live match, and only a live match, **stamps the token's last use**, at most
 * once per {@link AGENT_ACCESS_TOKEN_USE_RECORD_INTERVAL_MS}. The stamp is awaited
 * so the next list read sees it, but its failure is swallowed: bookkeeping has no
 * right to turn a live token into a refusal. Expired rows are swept lazily here,
 * fire-and-forget, for the same reason.
 *
 * **The role is not checked here.** The token says who is asking; whether they
 * may ask is the endpoint's rule (`src/router/operator-mcp.ts`), and that refusal
 * is a different one (403, not 401). `MAY_USE_AGENT_ACCESS_TOKENS` governs
 * holding a token, not what it opens.
 */
export async function resolveAgentAccessToken(
	rawToken: string,
	now: Date = new Date(),
): Promise<SwarmUser | undefined> {
	if (!rawToken) return undefined;

	const tokenHash = hashAgentAccessToken(rawToken);
	const user = await findUserByLiveAgentAccessToken(tokenHash, now);

	if (user) {
		await recordAgentAccessTokenUse(
			tokenHash,
			now,
			new Date(now.getTime() - AGENT_ACCESS_TOKEN_USE_RECORD_INTERVAL_MS),
		).catch(() => {});
	}

	void deleteExpiredAgentAccessTokens(now).catch(() => {});

	return user;
}
