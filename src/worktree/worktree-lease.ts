import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

const KEY_NS = 'swarm:worktree-lease:';
// Generous on purpose: must outlive the longest realistic single-phase agent
// run. A crash before cleanup()'s release leaves this to expire naturally
// rather than permanently marking the worktree "in use" — the exact case this
// issue is about (a worker crash mid-phase). Not refreshed/heartbeated: every
// phase's own `finally` releases it well before this fires on the happy path.
const LEASE_TTL_SEC = 4 * 60 * 60; // 4h

let redisInstance: Redis | null = null;

function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('worktree lease: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

export function buildLeaseKey(projectId: string, taskId: string): string {
	return `${projectId}:${taskId}`;
}

/** Best-effort; never throws. Logs and no-ops on a Redis error — losing a lease claim just means a later sweep might (rarely) skip a worktree it didn't need to. */
export async function claimWorktreeLease(
	projectId: string,
	taskId: string,
	token: string = '1',
): Promise<void> {
	const key = buildLeaseKey(projectId, taskId);
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		await getRedis().set(namespacedKey, token, 'EX', LEASE_TTL_SEC);
		logger.debug('worktree lease: claimed lease for task', { projectId, taskId, token });
	} catch (err) {
		logger.error('worktree lease: claim failed', { projectId, taskId, token, error: String(err) });
	}
}

/**
 * Race-safe acquisition: claims the lease only if it is currently free (`SET NX`),
 * returning whether this caller won it. Used by the collision-reclaim path so two
 * concurrent provisioners for the same task can't both decide to remove the
 * checkout — the loser sees the lease as held and blocks instead. Fails CLOSED:
 * a Redis error returns `false` (treat as "could not acquire"), so an uncertain
 * gate never reclaims a checkout it isn't sure is free.
 */
export async function tryClaimWorktreeLease(
	projectId: string,
	taskId: string,
	token: string = '1',
): Promise<boolean> {
	const key = buildLeaseKey(projectId, taskId);
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		const result = await getRedis().set(namespacedKey, token, 'EX', LEASE_TTL_SEC, 'NX');
		const acquired = result === 'OK';
		logger.debug('worktree lease: conditional claim', { projectId, taskId, token, acquired });
		return acquired;
	} catch (err) {
		logger.error('worktree lease: conditional claim failed — failing closed (not acquired)', {
			projectId,
			taskId,
			token,
			error: String(err),
		});
		return false;
	}
}

/** Best-effort; never throws — same posture as releaseReviewDispatch (TTL is the backstop). */
export async function releaseWorktreeLease(
	projectId: string,
	taskId: string,
	token?: string,
): Promise<void> {
	const key = buildLeaseKey(projectId, taskId);
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		const redis = getRedis();
		if (token) {
			const script = `
				if redis.call('get', KEYS[1]) == ARGV[1] then
					return redis.call('del', KEYS[1])
				else
					return 0
				end
			`;
			await redis.eval(script, 1, namespacedKey, token);
		} else {
			await redis.del(namespacedKey);
		}
		logger.debug('worktree lease: released lease for task', { projectId, taskId, token });
	} catch (err) {
		logger.warn('worktree lease: release failed (TTL will reap)', {
			projectId,
			taskId,
			token,
			error: String(err),
		});
	}
}

/**
 * The token currently holding the lease, or `null` when it is free. Fails CLOSED
 * for its one caller (the collision gate's stale-lease take-over, issue #427): a
 * Redis error returns `null`, which makes the take-over fall back to a plain
 * `SET NX` claim rather than compare-and-set against a token it never read.
 */
export async function readWorktreeLease(projectId: string, taskId: string): Promise<string | null> {
	const namespacedKey = `${KEY_NS}${buildLeaseKey(projectId, taskId)}`;
	try {
		return await getRedis().get(namespacedKey);
	} catch (err) {
		logger.error('worktree lease: read failed', { projectId, taskId, error: String(err) });
		return null;
	}
}

/**
 * Compare-and-set take-over: replace `expectedToken` with `token` (on a fresh
 * TTL) only while the lease still holds `expectedToken`. Used by the collision
 * gate to adopt an *orphaned* lease — one whose owning run/dispatch is provably
 * gone (issue #427) — without ever stealing one a concurrent provisioner
 * legitimately claimed in the meantime.
 *
 * Fails CLOSED: `false` on a token mismatch, a vanished key, or a Redis error,
 * so an uncertain take-over blocks instead of reclaiming a checkout.
 */
export async function takeOverWorktreeLease(
	projectId: string,
	taskId: string,
	expectedToken: string,
	token: string,
): Promise<boolean> {
	const namespacedKey = `${KEY_NS}${buildLeaseKey(projectId, taskId)}`;
	try {
		const script = `
			if redis.call('get', KEYS[1]) == ARGV[1] then
				redis.call('set', KEYS[1], ARGV[2], 'EX', ARGV[3])
				return 1
			else
				return 0
			end
		`;
		const result = await getRedis().eval(
			script,
			1,
			namespacedKey,
			expectedToken,
			token,
			String(LEASE_TTL_SEC),
		);
		return result === 1;
	} catch (err) {
		logger.error('worktree lease: take-over failed — failing closed (not acquired)', {
			projectId,
			taskId,
			expectedToken,
			token,
			error: String(err),
		});
		return false;
	}
}

/**
 * Fails CLOSED the opposite way from the dispatch dedups: on a Redis error this
 * returns `true` (treat as leased/in-flight), because for retention the unsafe
 * outcome is deleting something still in use, not skipping something that's
 * actually free. A prune that's overly conservative this round just retries
 * next sweep.
 */
export async function isWorktreeLeased(projectId: string, taskId: string): Promise<boolean> {
	const key = buildLeaseKey(projectId, taskId);
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		const exists = await getRedis().exists(namespacedKey);
		return exists === 1;
	} catch (err) {
		logger.error('worktree lease: check failed — failing closed (treating as leased)', {
			projectId,
			taskId,
			error: String(err),
		});
		return true;
	}
}
