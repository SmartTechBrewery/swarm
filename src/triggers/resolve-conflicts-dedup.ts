import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

const CLAIM_TTL_SEC = 24 * 60 * 60;
const KEY_NS = 'swarm:resolve-conflicts:';

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

/** One resolution run per PR/head/base state. Fails closed to prevent destructive duplicate merges. */
export async function claimConflictResolution(key: string): Promise<boolean> {
	try {
		return (await client().set(`${KEY_NS}${key}`, '1', 'EX', CLAIM_TTL_SEC, 'NX')) === 'OK';
	} catch (error) {
		logger.error('resolve-conflicts dedup: claim failed — skipping', { key, error: String(error) });
		return false;
	}
}

/** Keep a pending resolution's held claim alive until its fallback retry can run. */
export async function refreshConflictResolutionClaim(key: string, ttlSec: number): Promise<void> {
	try {
		await client().set(`${KEY_NS}${key}`, '1', 'EX', Math.max(ttlSec, CLAIM_TTL_SEC));
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
