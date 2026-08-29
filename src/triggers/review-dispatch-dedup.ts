/**
 * Review-dispatch deduplication, Redis-backed — the cross-process guard the
 * `pr-review` trigger (`handlers/review.ts`) lacked.
 *
 * `claimReviewDispatch(key, ...)` returns `true` exactly once per key within the
 * TTL window, across ALL processes sharing the same Redis. Subsequent calls
 * return `false` and the caller must skip the dispatch. This matters because the
 * review trigger fires from more than one event for the same commit — a PR
 * `opened` and, moments later, its `check_suite` passing (a PR with several CI
 * apps emits one success per suite) — and without the claim each would provision
 * a worktree and burn agent tokens reviewing the identical head SHA. An in-memory
 * guard wouldn't help: those sibling events become two distinct BullMQ jobs, and
 * the claim is taken worker-side (`processJob` → `registry.dispatch` → `handle`),
 * so the two jobs may run concurrently — or on different worker replicas — with
 * no shared process memory between them. The claim therefore has to live in
 * shared state. Ported from Cascade's `src/triggers/github/review-dispatch-dedup.ts`.
 *
 * Redis primitive: `SET key value NX EX <ttl>` — atomic check-and-set with TTL,
 * `'OK'` on first claim and `null` on a duplicate, so there's no race window.
 *
 * Fails closed: when Redis is unreachable, `claimReviewDispatch` returns `false`
 * (treats the call as a duplicate) — skipping a legitimate review is cheaper than
 * dispatching a duplicate one. Same posture on a worker crash: a worker that dies
 * after claiming but before completing the review leaves the PR+SHA skipped until
 * the 5-minute TTL reaps the claim (and a fresh event re-triggers) — an accepted
 * consequence of failing closed rather than risking a duplicate.
 */

import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

// 5 minutes — long enough to cover the gap between a PR opening and its checks
// completing, short enough that a wedged claim can't block re-review for long.
const DEDUP_TTL_SEC = 5 * 60;

const KEY_NS = 'swarm:review-dedup:';

let redisInstance: Redis | null = null;

/**
 * Lazy singleton — the worker/router pays the connection cost only if it
 * actually claims a review dispatch. `REDIS_URL` is read here, not at module
 * load, so importing this module without ever claiming needs no Redis (mirrors
 * the producer's lazy queue).
 *
 * Built from {@link parseRedisUrl} for one deliberate override: the BullMQ
 * connection sets `maxRetriesPerRequest: null` so its blocking consumers never
 * error out, but dedup must FAIL FAST when Redis is down — a command that blocks
 * forever would hang review dispatch instead of failing closed. Capping retries
 * makes an unreachable Redis reject promptly, which the call sites turn into a
 * skipped dispatch.
 */
function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
			// `enableOfflineQueue` is left at its default (true) on purpose: with it
			// off, the very first claim on a freshly-started worker — issued before
			// the connection finishes handshaking — would reject and fail closed,
			// skipping a *legitimate* review even though Redis is healthy. Keeping it
			// on trades a brief stall during (re)connect for not dropping legit
			// reviews on cold start; a genuinely down Redis still rejects promptly
			// once `maxRetriesPerRequest` trips.
		});
		// ioredis emits 'error' on every failed reconnect; without a listener those
		// become unhandled-error crashes. The actual failures still surface (and
		// fail closed) at the set/del call sites below — this just keeps them from
		// taking the process down.
		redisInstance.on('error', (err) => {
			logger.warn('review-dispatch dedup: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/** The dedup key for a PR at a specific head commit. `repo` is `owner/repo`. */
export function buildReviewDispatchKey(repo: string, prNumber: string, headSha: string): string {
	return `${repo}:${prNumber}:${headSha}`;
}

/**
 * Atomically claim the review-dispatch slot for `key`. Returns `true` exactly
 * once per key within the TTL window across all connected processes; every later
 * call returns `false` until the claim expires or is released.
 *
 * Fails closed on Redis errors: logs and returns `false` so the caller skips the
 * dispatch rather than risk a duplicate review.
 */
export async function claimReviewDispatch(
	key: string,
	triggerName: string,
	context: { prNumber: string; headSha: string },
): Promise<boolean> {
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		const result = await getRedis().set(namespacedKey, triggerName, 'EX', DEDUP_TTL_SEC, 'NX');
		if (result === 'OK') {
			logger.debug('review-dispatch dedup: claimed review for PR+SHA', {
				trigger: triggerName,
				reviewDispatchKey: key,
				prNumber: context.prNumber,
				headSha: context.headSha,
			});
			return true;
		}
		logger.debug('review-dispatch dedup: review already dispatched for this PR+SHA, skipping', {
			trigger: triggerName,
			reviewDispatchKey: key,
			prNumber: context.prNumber,
			headSha: context.headSha,
		});
		return false;
	} catch (err) {
		logger.error('review-dispatch dedup: Redis call failed — failing closed', {
			trigger: triggerName,
			reviewDispatchKey: key,
			error: String(err),
		});
		return false;
	}
}

/**
 * Refresh (extend) a live claim's TTL without re-claiming — the counterpart used
 * to hold a claim open while its dispatch is deferred as a *pending continuation*
 * (issue #214). A Review blocked solely by project concurrency keeps its PR+SHA
 * claim so no sibling `opened`/`check_suite` event can steal it while it waits,
 * and its prioritized retry (fired well within this refreshed TTL) reuses the
 * held claim rather than re-claiming — so exactly one Review still runs per
 * PR/head SHA across the initial webhook and its retry.
 *
 * `SET key value EX ttl` (no `NX`): extends the existing claim, or re-establishes
 * it if it lapsed a moment ago, so the pending continuation is never dropped as a
 * duplicate. Best-effort — errors are logged, never thrown (same posture as
 * {@link releaseReviewDispatch}); the claim's own TTL and the fallback delayed
 * retry are the safety nets.
 */
export async function refreshReviewDispatchClaim(key: string, ttlSec: number): Promise<void> {
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		await getRedis().set(namespacedKey, 'pr-review-pending', 'EX', ttlSec);
	} catch (err) {
		logger.warn('review-dispatch dedup: claim refresh failed (TTL will reap)', {
			reviewDispatchKey: key,
			error: String(err),
		});
	}
}

/**
 * Release a claim taken by {@link claimReviewDispatch} — the claim's counterpart,
 * for the case where a dispatch is abandoned *before the review is submitted* so
 * the next legitimate trigger for the same PR+SHA needn't wait out the TTL. That
 * is Cascade's pre-run `onBlocked` case: a capacity/lock gate that rejects the
 * dispatch before the agent ever runs (issue #62 asked to port an equivalent
 * claim/release). `src/worker/consumer.ts` calls it for the two dispatches that
 * provably ran nothing: one the automation-label gate skipped, and one that
 * re-evaluated to `no-trigger` *without* an already-submitted verdict behind it.
 * It must NOT be called on a *failed* review run, nor on the no-trigger
 * redelivery of a run whose verdict the ledger already records as submitted
 * (issue #815): the agent submits the formal review inside its run
 * (`src/pipeline/review.ts`), so in both cases the review may already be posted,
 * and releasing then would let a sibling event post a duplicate — the exact
 * incident this dedup exists to prevent.
 *
 * Best-effort: errors are logged, never thrown — the TTL is the safety net.
 */
export async function releaseReviewDispatch(key: string): Promise<void> {
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		await getRedis().del(namespacedKey);
	} catch (err) {
		logger.warn('review-dispatch dedup: release failed (TTL will reap)', {
			reviewDispatchKey: key,
			error: String(err),
		});
	}
}
