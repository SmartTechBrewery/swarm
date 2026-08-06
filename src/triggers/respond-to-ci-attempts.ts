/**
 * Respond-to-CI fix-attempt cap, Redis-backed — the loop guard the per-SHA
 * review dedup (`review-dispatch-dedup.ts`) can't provide.
 *
 * The Respond-to-CI phase fixes a failing build by pushing a commit. That new
 * commit is a *new* head SHA, so it fires a fresh `check_suite` — and if the
 * fix didn't actually make CI green, the review handler routes it straight back
 * to Respond-to-CI. The PR+SHA dedup can't stop that: each attempt is a
 * different SHA, so every one claims a fresh slot. Left unbounded, a fix that
 * never sticks loops forever, burning an agent run each round. (Loop-prevention
 * doesn't catch it either — `check_suite` events are deliberately never dropped
 * as self-authored, since the persona pushing the fix isn't the suite's sender.)
 *
 * So this caps *distinct fix attempts per PR*. `claimRespondToCiAttempt` bumps a
 * per-PR counter (`INCR`, with a TTL refreshed each bump) and returns whether
 * the PR is still under {@link MAX_FIX_ATTEMPTS}. The counter is keyed on the PR,
 * not the SHA, so it accumulates across fix commits; the TTL lets a PR that goes
 * quiet reset so genuinely new work later can be fixed again.
 *
 * Redis (not a process-local Map) for the same reason as the dedup: sibling
 * events for one PR become distinct BullMQ jobs that may run on different worker
 * replicas with no shared memory. Mirrors `review-dispatch-dedup.ts`.
 *
 * **Fails open**, unlike the dedup. If Redis is unreachable the attempt is
 * *allowed* (logged) rather than blocked: a transient blip must not disable
 * CI-fix wholesale, and the per-SHA dedup — which fails closed — still stops
 * duplicate agents for the same commit. The bounded downside is a few extra
 * attempts during an outage, versus silently dropping every legitimate fix.
 */

import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

/**
 * Max distinct fix attempts per PR before Respond-to-CI stops re-dispatching.
 * Matches Cascade's respond-to-ci `MAX_ATTEMPTS`: enough for a genuine fix that
 * takes a round or two, low enough that a fix which never sticks can't loop.
 */
export const MAX_FIX_ATTEMPTS = 3;

// 1 hour — long enough to span the fix → checks → re-dispatch cycles of one PR,
// short enough that a PR going quiet resets so later new work can be fixed
// afresh rather than being permanently capped.
const ATTEMPTS_TTL_SEC = 60 * 60;

const KEY_NS = 'swarm:respond-to-ci-attempts:';

let redisInstance: Redis | null = null;

/**
 * Lazy singleton — the worker pays the connection cost only if it actually
 * checks an attempt cap. `REDIS_URL` is read here, not at module load, so
 * importing this module without ever claiming needs no Redis (mirrors the
 * dedup's lazy connection, including the `maxRetriesPerRequest: 1` override so
 * an unreachable Redis rejects promptly rather than blocking the check).
 */
function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('respond-to-ci attempts: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/** The per-PR attempt-counter key. `repo` is `owner/repo`. */
export function buildRespondToCiAttemptKey(repo: string, prNumber: string): string {
	return `${repo}:${prNumber}`;
}

export interface RespondToCiAttemptClaim {
	/** Whether this attempt is within {@link MAX_FIX_ATTEMPTS} and may dispatch. */
	allowed: boolean;
	/** The attempt number this dispatch would be (1-based). */
	attempt: number;
}

/**
 * Record and check a fix attempt for a PR. Increments the per-PR counter and
 * returns `{ allowed, attempt }` — `allowed` is `false` once the count exceeds
 * {@link MAX_FIX_ATTEMPTS}, so the caller drops the dispatch and leaves the PR
 * to a human.
 *
 * Fails open on Redis errors: logs and returns `allowed: true` (attempt 0) so a
 * transient outage doesn't disable CI-fix — the per-SHA dedup still guards
 * against duplicate agents for the same commit.
 */
export async function claimRespondToCiAttempt(
	key: string,
	context: { prNumber: string; headSha: string },
): Promise<RespondToCiAttemptClaim> {
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		// INCR the counter and refresh its TTL in one round-trip via MULTI/EXEC, so
		// the two can't be split by a crash: a bare `incr` followed by a separate
		// `expire` would, if the process died between them, leave a TTL-less key
		// that permanently caps the PR. Refreshing the TTL on every bump keeps an
		// actively-looping PR's counter alive for the whole cycle, then lets it age
		// out once the PR goes quiet. `exec()` resolves to per-command `[err, res]`
		// tuples in issue order; the INCR result is the first tuple's value.
		const results = await getRedis()
			.multi()
			.incr(namespacedKey)
			.expire(namespacedKey, ATTEMPTS_TTL_SEC)
			.exec();
		// A null `results` means the MULTI was discarded (e.g. connection loss); a
		// per-command error surfaces in the tuple's first slot. Treat either as a
		// failed call so the catch's fail-open path handles it uniformly.
		const incrResult = results?.[0];
		if (!incrResult || incrResult[0]) {
			throw incrResult?.[0] ?? new Error('respond-to-ci attempts: MULTI/EXEC returned no result');
		}
		const attempt = Number(incrResult[1]);
		const allowed = attempt <= MAX_FIX_ATTEMPTS;
		if (!allowed) {
			logger.warn('respond-to-ci attempts: fix-attempt cap reached — not dispatching', {
				respondToCiAttemptKey: key,
				attempt,
				max: MAX_FIX_ATTEMPTS,
				prNumber: context.prNumber,
				headSha: context.headSha,
			});
		}
		return { allowed, attempt };
	} catch (err) {
		logger.error('respond-to-ci attempts: Redis call failed — failing open (allowing attempt)', {
			respondToCiAttemptKey: key,
			error: String(err),
		});
		return { allowed: true, attempt: 0 };
	}
}

/**
 * Give back an attempt a handler claimed before the automation gate skipped its
 * dispatch. The Lua script avoids creating a negative TTL-less key when the
 * claim already expired, and atomically deletes a one-count key so a concurrent
 * later claim cannot be removed after it increments.
 */
export async function releaseRespondToCiAttempt(key: string): Promise<void> {
	try {
		await getRedis().eval(
			`local value = redis.call('GET', KEYS[1])
if not value then return 0 end
if tonumber(value) <= 1 then return redis.call('DEL', KEYS[1]) end
return redis.call('DECR', KEYS[1])`,
			1,
			`${KEY_NS}${key}`,
		);
	} catch (err) {
		logger.warn('respond-to-ci attempts: attempt release failed (TTL will reap)', {
			respondToCiAttemptKey: key,
			error: String(err),
		});
	}
}
