/**
 * The one-resolution-run-per-state claim for `resolve-conflicts`, Redis-backed.
 * Both entry points into the phase take it — the trigger's per-PR check
 * (`handlers/resolve-conflicts.ts`) and Review's conflict route
 * (`handlers/review.ts`) — so two live checks for the same pull request, head and
 * base resolve to exactly one dispatch: a duplicate resolution run is destructive,
 * which is why every uncertain answer here fails closed.
 *
 * **A claim lives exactly as long as the dispatch that took it (issue #1047).**
 * The claim is taken in the trigger handler, before the dispatch it belongs to is
 * guaranteed to run, and is then held across waits of unbounded length. Released
 * only on the paths that remember to, it outlived every holder that ended some
 * other way — superseded by a coalesced recheck while waiting for a worker, reaped
 * by the reconciler, failed by a restart — and refused the pull request's every
 * later check for its full 24 h TTL, with nothing scheduled and no error anywhere.
 * So the claim's value is its owning dispatch's id, and a claimant that finds the
 * key held honours it only while that dispatch is still in
 * {@link ACTIVE_DISPATCH_STATES}. A holder that has settled terminally (or whose
 * row is gone) is replaced by a compare-and-set, so of two claimants that both
 * find the same dead holder exactly one wins. Terminal really is dead:
 * `dispatchesRepository`'s conditional updates never resurrect a `completed`,
 * `failed` or `cancelled` dispatch — the same argument the Review verdict ledger
 * relies on for its pending slots (issue #857).
 */

import { Redis } from 'ioredis';
import { z } from 'zod';
import {
	ACTIVE_DISPATCH_STATES,
	getDispatchById,
} from '../db/repositories/dispatchesRepository.js';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

const CLAIM_TTL_SEC = 24 * 60 * 60;
const KEY_NS = 'swarm:resolve-conflicts:';

/** Replace the holder only while it is still the one the claimant found dead. */
const TAKE_OVER_SCRIPT = `
	if redis.call('get', KEYS[1]) == ARGV[1] then
		redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
		return 1
	else
		return 0
	end
`;

const DispatchIdSchema = z.string().uuid();

let redis: Redis | undefined;
function client(): Redis {
	if (!redis) {
		redis = new Redis({ ...parseRedisUrl(requireEnv('REDIS_URL')), maxRetriesPerRequest: 1 });
		redis.on('error', (error) =>
			logger.warn('resolve-conflicts dedup: Redis error', { error: String(error) }),
		);
	}
	return redis;
}

export function buildConflictResolutionKey(
	repo: string,
	prNumber: string,
	headSha: string,
	baseSha: string,
): string {
	return `${repo}:${prNumber}:${headSha}:${baseSha}`;
}

/**
 * Claim the one resolution run for a PR/head/base state on behalf of
 * `dispatchId` — the claimed dispatch row whose trigger evaluation is asking
 * (`TriggerContext.dispatchId`). Required and positional for the same reason
 * `reserveReviewVerdict`'s is: a claim must be owned from the instant it exists.
 *
 * Granted when the key is free, when it already names this dispatch (its own
 * claim, re-entered by a later attempt of the same dispatch), or when it names a
 * dispatch that is no longer active. Fails closed on any Redis or database error.
 */
export async function claimConflictResolution(key: string, dispatchId: string): Promise<boolean> {
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		if (await claimIfFree(namespacedKey, dispatchId)) return true;
		const holder = await client().get(namespacedKey);
		// It lapsed between the two reads, so claim it the ordinary way.
		if (holder === null) return await claimIfFree(namespacedKey, dispatchId);
		if (holder === dispatchId) return true;
		if (await isHolderActive(holder)) return false;
		const result = await client().eval(
			TAKE_OVER_SCRIPT,
			1,
			namespacedKey,
			holder,
			dispatchId,
			String(CLAIM_TTL_SEC),
		);
		const took = result === 1;
		if (took) {
			logger.info('resolve-conflicts dedup: took over a claim whose dispatch has ended', {
				key,
				previousHolder: holder,
				dispatchId,
			});
		}
		return took;
	} catch (error) {
		logger.error('resolve-conflicts dedup: claim failed — skipping', { key, error: String(error) });
		return false;
	}
}

async function claimIfFree(namespacedKey: string, dispatchId: string): Promise<boolean> {
	return (await client().set(namespacedKey, dispatchId, 'EX', CLAIM_TTL_SEC, 'NX')) === 'OK';
}

/**
 * Whether the dispatch named by a held claim may still run. A value that names no
 * dispatch was written before claims recorded their owner; nothing can say whether
 * its holder is alive, so it keeps the claim until its TTL reaps it, exactly as
 * every claim did before issue #1047. Database errors propagate to the claim, which
 * fails closed on them.
 */
async function isHolderActive(holder: string): Promise<boolean> {
	if (!DispatchIdSchema.safeParse(holder).success) return true;
	const dispatch = await getDispatchById(holder);
	// A row that is gone — its project was deleted and the cascade took it — holds nothing.
	if (!dispatch) return false;
	return ACTIVE_DISPATCH_STATES.includes(dispatch.state as (typeof ACTIVE_DISPATCH_STATES)[number]);
}

/**
 * Keep a pending resolution's held claim alive until its fallback retry can run,
 * re-stamping `dispatchId` as its owner — the dispatch that is waiting on it now.
 */
export async function refreshConflictResolutionClaim(
	key: string,
	ttlSec: number,
	dispatchId: string,
): Promise<void> {
	try {
		await client().set(`${KEY_NS}${key}`, dispatchId, 'EX', Math.max(ttlSec, CLAIM_TTL_SEC));
	} catch (error) {
		logger.warn('resolve-conflicts dedup: claim refresh failed (TTL will reap)', {
			key,
			error: String(error),
		});
	}
}

/** Release a claim when a dispatch is skipped before conflict resolution starts. */
export async function releaseConflictResolution(key: string): Promise<void> {
	try {
		await client().del(`${KEY_NS}${key}`);
	} catch (error) {
		logger.warn('resolve-conflicts dedup: claim release failed (TTL will reap)', {
			key,
			error: String(error),
		});
	}
}
