/**
 * Agent access token persistence (issue #1362) — plain functions, one `getDb()`
 * per call, mirroring `userSessionsRepository.ts`. Backs the
 * `agent_access_tokens` table (`src/db/schema/agentAccessTokens.ts`).
 *
 * This is the dumb store: it knows SQL and no rule — not who may hold a token nor
 * how long one lives (`src/identity/agent-access-token.ts` settles both) — and it
 * operates on the token **hash** alone; the raw token never reaches it.
 */

import { and, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';

import type { AgentAccessToken } from '../../identity/agent-access-token.js';
import type { SwarmUser } from '../../identity/schema.js';
import { getDb } from '../client.js';
import { agentAccessTokens } from '../schema/agentAccessTokens.js';
import { users } from '../schema/users.js';
import { rowToSwarmUser } from './usersRepository.js';

/** The fields a caller supplies to persist a token; `id`/`createdAt` are generated. */
export interface NewAgentAccessTokenValues {
	userId: string;
	name: string;
	tokenHash: string;
	expiresAt: Date;
	/** The projects a scoped agent credential is limited to; omitted for an ordinary token. */
	projectIds?: string[];
}

/**
 * A live token's holder, the token's id, and — for a scoped agent credential
 * (issue #1385) — the projects it is limited to; `projectIds` is absent for an
 * ordinary token.
 */
export interface LiveAgentAccessToken {
	user: SwarmUser;
	tokenId: string;
	projectIds?: string[];
}

type AgentAccessTokenRow = typeof agentAccessTokens.$inferSelect;

/**
 * The row in the wire shape — **the hash is deliberately not on it**, and a
 * never-used token carries no `lastUsedAt` at all rather than a `null`.
 */
function toAgentAccessToken(row: AgentAccessTokenRow): AgentAccessToken {
	return {
		id: row.id,
		name: row.name,
		createdAt: row.createdAt.toISOString(),
		expiresAt: row.expiresAt.toISOString(),
		...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.toISOString() } : {}),
		...(row.projectIds ? { projectIds: row.projectIds } : {}),
	};
}

export async function insertAgentAccessToken(
	values: NewAgentAccessTokenValues,
): Promise<AgentAccessToken> {
	const [row] = await getDb().insert(agentAccessTokens).values(values).returning();
	return toAgentAccessToken(row);
}

/** One account's tokens, the freshest first. There is no read of anybody else's. */
export async function listAgentAccessTokensOfUser(userId: string): Promise<AgentAccessToken[]> {
	const rows = await getDb()
		.select()
		.from(agentAccessTokens)
		.where(eq(agentAccessTokens.userId, userId))
		.orderBy(desc(agentAccessTokens.createdAt));
	return rows.map(toAgentAccessToken);
}

/**
 * Remove one token **of the named account** and answer whether a row went. The
 * owner stands in the query itself, which is what makes somebody else's token
 * indistinguishable from one that never existed.
 */
export async function deleteAgentAccessToken(id: string, userId: string): Promise<boolean> {
	const removed = await getDb()
		.delete(agentAccessTokens)
		.where(and(eq(agentAccessTokens.id, id), eq(agentAccessTokens.userId, userId)))
		.returning({ id: agentAccessTokens.id });
	return removed.length > 0;
}

/**
 * The live token matching a hash — its holder, id and project scope — or
 * `undefined` when none matches: a not-found lookup, not an error. Expiry stands
 * **in the query**, so an expired row never resolves even before it is swept.
 */
export async function findLiveAgentAccessToken(
	tokenHash: string,
	now: Date,
): Promise<LiveAgentAccessToken | undefined> {
	const rows = await getDb()
		.select({
			user: users,
			tokenId: agentAccessTokens.id,
			projectIds: agentAccessTokens.projectIds,
		})
		.from(agentAccessTokens)
		.innerJoin(users, eq(agentAccessTokens.userId, users.id))
		.where(and(eq(agentAccessTokens.tokenHash, tokenHash), gt(agentAccessTokens.expiresAt, now)))
		.limit(1);
	const row = rows[0];
	if (!row) return undefined;
	return {
		user: rowToSwarmUser(row.user),
		tokenId: row.tokenId,
		...(row.projectIds && row.projectIds.length > 0 ? { projectIds: row.projectIds } : {}),
	};
}

/**
 * Stamp the token's last use with `now` — **only when the previous stamp is
 * older than `notBefore`** or there is none yet. The throttle stands in the
 * `WHERE`, so a burst of calls costs one write and the rest match nothing.
 */
export async function recordAgentAccessTokenUse(
	tokenHash: string,
	now: Date,
	notBefore: Date,
): Promise<void> {
	await getDb()
		.update(agentAccessTokens)
		.set({ lastUsedAt: now })
		.where(
			and(
				eq(agentAccessTokens.tokenHash, tokenHash),
				or(isNull(agentAccessTokens.lastUsedAt), lt(agentAccessTokens.lastUsedAt, notBefore)),
			),
		);
}

/** Sweep the expired rows and return their count. Housekeeping, not enforcement. */
export async function deleteExpiredAgentAccessTokens(now: Date): Promise<number> {
	const deleted = await getDb()
		.delete(agentAccessTokens)
		.where(lt(agentAccessTokens.expiresAt, now))
		.returning({ id: agentAccessTokens.id });
	return deleted.length;
}
