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
// It is the TTL of a claim nobody has taken responsibility for yet; a holder
// that needs the slot for longer than the gap it covers — a deferred
// continuation, a running CI fix — extends it explicitly via
// {@link refreshReviewDispatchClaim} rather than widening the default for all.
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
 * The value merge automation's claim on a head its own branch update produced is
 * stored under (`claimUpdatedHeadReviewSlot`, `src/worker/merge-automation.ts`).
 * Named so the one reader that tells it apart from every other holder
 * ({@link takeOverMergeAutomationClaim}, issue #1430) cannot drift from the
 * writer.
 */
export const MERGE_AUTOMATION_CLAIM_OWNER = 'merge-automation';

/**
 * The value a Review's claim is stored under — its owning dispatch (issue #1105),
 * so a hand-back can prove the claim it is about to release is still its own
 * ({@link releaseReviewDispatchHeldBy}).
 */
export function reviewDispatchClaimOwner(dispatchId: string): string {
	return `pr-review:${dispatchId}`;
}

/**
 * Atomically claim the review-dispatch slot for `key`. Returns `true` exactly
 * once per key within the TTL window across all connected processes; every later
 * call returns `false` until the claim expires or is released.
 *
 * `context.owner` is stored as the claim's value when given (otherwise the
 * trigger name is) — the token {@link releaseReviewDispatchHeldBy} compares.
 * `context.ttlSec` overrides the default lease for a holder that knows up front
 * it needs the slot for longer, so the claim and its lease are one atomic write
 * and the owner token survives (a later {@link refreshReviewDispatchClaim}
 * would overwrite it).
 *
 * Fails closed on Redis errors: logs and returns `false` so the caller skips the
 * dispatch rather than risk a duplicate review.
 */
export async function claimReviewDispatch(
	key: string,
	triggerName: string,
	context: { prNumber: string; headSha: string; owner?: string; ttlSec?: number },
): Promise<boolean> {
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		const result = await getRedis().set(
			namespacedKey,
			context.owner ?? triggerName,
			'EX',
			context.ttlSec ?? DEDUP_TTL_SEC,
			'NX',
		);
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
 * How many seconds a live claim on `key` has left, or `undefined` when nothing
 * holds it (or the lease can't be read).
 *
 * Read-only, and for the operator's benefit alone (issue #1019): a dispatch
 * dropped because this slot is held is reported with the wait it actually faces
 * rather than as a disposition that changed. It is deliberately *not* consulted
 * before claiming — {@link claimReviewDispatch}'s `SET NX` is the only thing
 * that decides ownership, and a check-then-claim would reopen the race that
 * atomic primitive exists to close.
 *
 * Best-effort, like every other read here: an unreachable Redis costs the
 * message its "frees in" clause, never the decline itself.
 */
export async function reviewDispatchClaimTtlSec(key: string): Promise<number | undefined> {
	try {
		// `TTL` answers -2 for a key that does not exist and -1 for one with no
		// expiry; neither is a wait an operator can be told to sit out, so both
		// collapse to "unknown" here.
		const ttl = await getRedis().ttl(`${KEY_NS}${key}`);
		return ttl > 0 ? ttl : undefined;
	} catch (err) {
		logger.debug('review-dispatch dedup: could not read a claim TTL', {
			reviewDispatchKey: key,
			error: String(err),
		});
		return undefined;
	}
}

/**
 * Refresh (extend) a live claim's TTL without re-claiming — the counterpart used
 * wherever the slot has to stay owned for longer than the default TTL, by a
 * holder that will re-enter without re-claiming. Three callers:
 *  - a dispatch deferred as a *pending continuation* (issue #214,
 *    `retainContinuationDispatchClaim`). A Review blocked solely by project
 *    concurrency keeps its PR+SHA claim so no sibling `opened`/`check_suite`
 *    event can steal it while it waits, and its prioritized retry (fired well
 *    within this refreshed TTL) reuses the held claim rather than re-claiming —
 *    so exactly one Review still runs per PR/head SHA across the initial webhook
 *    and its retry.
 *  - a dispatched Respond-to-CI (`handlers/review.ts`), which extends the slot
 *    to cover its own agent wall clock: the default five minutes is shorter than
 *    a fix run, and a lapsed lease lets a delayed sibling completed-check event
 *    start a second fix on the red already being fixed. The extended lease is
 *    handed back if the fix is cancelled (issue #1053).
 *  - a `no-fix` hand-over (`src/dispatch/ci-no-fix-recovery.ts`), which passes
 *    that still-held lease from the finished fix to the recovery it enqueues.
 *
 * `SET key value EX ttl` (no `NX`): extends the existing claim, or re-establishes
 * it if it lapsed a moment ago, so the pending continuation is never dropped as a
 * duplicate. Rewriting the value also clears a no-checks mark
 * ({@link markReviewDispatchClaimedWithoutChecks}): whoever refreshes now holds
 * the slot, not the Review that took it without checks. Best-effort — errors are logged, never thrown (same posture as
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
 * claim/release). `src/worker/consumer.ts` calls it for the dispatches that
 * provably delivered no review: one the automation-label gate skipped, one a
 * writing phase's hold dropped, one that re-evaluated to `no-trigger` *without*
 * an already-submitted verdict behind it — and, since issue #1019, a Review run
 * that settled terminally `failed` having delivered nothing. Since issue #1053
 * also a Respond-to-CI run that was cancelled (it never posts a verdict), and a
 * Review or Respond-to-CI dispatch cancelled before its phase started. Since
 * issue #1105 also a Review dropped as a same-phase duplicate after its own
 * evaluation created the head's verdict slot — through the owner-fenced
 * {@link releaseReviewDispatchHeldBy}.
 *
 * The rule all of them share is the only one that matters: **it must NOT be
 * called once a verdict may have been posted.** The agent submits the formal
 * review inside its run (`src/pipeline/review.ts`), so releasing then would let a
 * sibling event post a duplicate — the exact incident this dedup exists to
 * prevent. That is why the no-trigger redelivery of a run the ledger already
 * records as `submitted` keeps its claim (issue #815), and why the failed-run
 * release is conditioned on that same ledger read *plus* the phase's own
 * delivery signal: a Review that got as far as delivery raises a
 * `DeliveryDeferredError` rather than an ordinary failure, so a terminal failure
 * carrying one keeps its claim too. A *cancelled* Review is held to the same two
 * reads, with the delivery signal carried through the cancellation
 * (`RunTerminatedError.deliveryStarted`, issue #1053).
 *
 * Before #1019 a failed run kept its claim unconditionally, and the TTL was the
 * only thing that freed it — which left the operator's retry of a review that
 * never ran bounced by the guard against a *duplicate* review, and told them
 * their board disposition had changed.
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

/**
 * Suffix a claim's value carries while it is held by a Review dispatched on a
 * head that reported **no checks** (issue #1270). Kept on the claim's own value,
 * not in a key beside it, so the mark lives exactly as long as that Review's
 * hold: when a CI fix takes the slot over ({@link refreshReviewDispatchClaim}
 * rewrites the value) or the claim lapses, the mark goes with it.
 */
const NO_CHECKS_MARK = ':no-checks';

// Compare-and-delete: DEL only while the key still carries the caller's token —
// bare, or marked as a Review dispatched without checks (ARGV[2]).
const RELEASE_IF_HELD_BY = `local v = redis.call('get', KEYS[1]) if v == ARGV[1] or v == ARGV[1] .. ARGV[2] then return redis.call('del', KEYS[1]) end return 0`;

/**
 * Release a claim only while `owner` still holds it (issue #1105) — the
 * ownership-fenced form of {@link releaseReviewDispatch}, for a hand-back that
 * can run long after its own claim was taken. A claim lapses after five minutes,
 * so by then a later dispatch may have re-claimed the key; an unconditional DEL
 * would erase *its* claim and let a further event start a duplicate review. Any
 * other value — a later dispatch's token, a refreshed continuation's — is left
 * alone, as is an expired key. The owner's token still matches once
 * {@link markReviewDispatchClaimedWithoutChecks} has marked it (issue #1270).
 *
 * Best-effort, like the unconditional release: errors are logged, never thrown.
 */
export async function releaseReviewDispatchHeldBy(key: string, owner: string): Promise<void> {
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		await getRedis().eval(RELEASE_IF_HELD_BY, 1, namespacedKey, owner, NO_CHECKS_MARK);
	} catch (err) {
		logger.warn('review-dispatch dedup: owner-fenced release failed (TTL will reap)', {
			reviewDispatchKey: key,
			error: String(err),
		});
	}
}

// Append the mark to the live value, keeping its TTL; a no-op on a missing or
// already-marked key.
const MARK_WITHOUT_CHECKS = `local v = redis.call('get', KEYS[1]) if v and string.sub(v, -string.len(ARGV[1])) ~= ARGV[1] then redis.call('set', KEYS[1], v .. ARGV[1], 'XX', 'KEEPTTL') return 1 end return 0`;

// The remaining TTL while the key carries the mark; -2 otherwise.
const TTL_IF_MARKED_WITHOUT_CHECKS = `local v = redis.call('get', KEYS[1]) if v and string.sub(v, -string.len(ARGV[1])) == ARGV[1] then return redis.call('ttl', KEYS[1]) end return -2`;

/**
 * Mark the live claim on `key` as held by a Review dispatched on a head that
 * reported **no checks** — the `reviewChecks: 'if-present'` path (issues #274,
 * #1107) — keeping its owner token and its TTL (issue #1270).
 *
 * Such a Review is the one claim holder the shared slot's invariant does not
 * cover: GitHub can register a head's checks a moment *after* the PR event that
 * read none, and when those checks then go red, the Respond-to-CI the red event
 * routes to finds this claim and would be dropped as a duplicate of a phase that
 * never looked at CI. The mark is what lets the red event recognise that holder
 * ({@link reviewClaimedWithoutChecksTtlSec}) and wait for its claim to lapse
 * rather than drop.
 *
 * Best-effort, like every write here: a failure costs only that wait.
 */
export async function markReviewDispatchClaimedWithoutChecks(key: string): Promise<void> {
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		await getRedis().eval(MARK_WITHOUT_CHECKS, 1, namespacedKey, NO_CHECKS_MARK);
	} catch (err) {
		logger.warn('review-dispatch dedup: could not mark a claim as taken without checks', {
			reviewDispatchKey: key,
			error: String(err),
		});
	}
}

/**
 * How many seconds the claim on `key` has left **while it is held by a Review
 * dispatched without checks** ({@link markReviewDispatchClaimedWithoutChecks}),
 * or `undefined` for any other holder, no holder, or a failed read (issue #1270).
 *
 * Read only after a failed {@link claimReviewDispatch}, never in place of it: the
 * answer tells a red event to re-check once that lease lapses, and the re-check
 * still has to win the claim itself, so `SET NX` remains the only thing that
 * decides who dispatches.
 */
export async function reviewClaimedWithoutChecksTtlSec(key: string): Promise<number | undefined> {
	try {
		const ttl = await getRedis().eval(
			TTL_IF_MARKED_WITHOUT_CHECKS,
			1,
			`${KEY_NS}${key}`,
			NO_CHECKS_MARK,
		);
		// `0` is a lease about to lapse — still this holder's; -1/-2 are not leases.
		return typeof ttl === 'number' && ttl >= 0 ? ttl : undefined;
	} catch (err) {
		logger.debug('review-dispatch dedup: could not read whether a claim was taken without checks', {
			reviewDispatchKey: key,
			error: String(err),
		});
		return undefined;
	}
}

// Compare-and-set: hand the slot to ARGV[2] only while merge automation (ARGV[1])
// holds it, keeping its TTL; a no-op on any other holder or a missing key.
const TAKE_OVER_IF_HELD_BY = `if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('set', KEYS[1], ARGV[2], 'XX', 'KEEPTTL') return 1 end return 0`;

/**
 * Take the claim on `key` over for `owner` **only while merge automation holds
 * it** for a head its own branch update produced ({@link MERGE_AUTOMATION_CLAIM_OWNER},
 * issue #1430). Returns `true` when this caller now holds the slot.
 *
 * Merge automation takes that claim so the head's *green* checks start no
 * redundant Review — it never guards against a CI fix, and the merge dispatch
 * never dispatches one. A red that arrives while it is held is therefore not a
 * duplicate of anything, and dropping it stranded the pull request: nothing
 * re-fires `checks completed` for that head. Every other holder — a Review, a
 * running CI fix, a held continuation — is left alone.
 *
 * One Lua script, so the take-over is atomic: of several sibling red events,
 * exactly one finds the merge-automation value and wins; the value is then the
 * winner's own token, so every later event reads an ordinary holder and drops.
 * The lease is kept rather than reset — the CI fix extends it itself.
 *
 * Fails closed, like {@link claimReviewDispatch}: a Redis error logs and returns
 * `false`, so the caller keeps the duplicate drop rather than risk a second fix.
 */
export async function takeOverMergeAutomationClaim(key: string, owner: string): Promise<boolean> {
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		const taken = await getRedis().eval(
			TAKE_OVER_IF_HELD_BY,
			1,
			namespacedKey,
			MERGE_AUTOMATION_CLAIM_OWNER,
			owner,
		);
		return taken === 1;
	} catch (err) {
		logger.error(
			'review-dispatch dedup: merge-automation claim take-over failed — failing closed',
			{
				reviewDispatchKey: key,
				error: String(err),
			},
		);
		return false;
	}
}

// Extend merge automation's (ARGV[1]) lease to ARGV[2] seconds while it holds the
// slot, or re-establish it under that owner if it lapsed; a no-op on any other holder.
const REFRESH_IF_HELD_BY = `local v = redis.call('get', KEYS[1]) if v == ARGV[1] then redis.call('expire', KEYS[1], ARGV[2]) return 1 elseif not v then redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX') return 1 end return 0`;

/**
 * Keep merge automation's claim on a head its own branch update produced alive
 * for another `ttlSec` while that head's checks are still pending (issue #1432),
 * **without** rewriting its owner token. {@link refreshReviewDispatchClaim} would
 * overwrite the value with its own, after which a red on that head could no
 * longer find {@link MERGE_AUTOMATION_CLAIM_OWNER} and
 * {@link takeOverMergeAutomationClaim} would drop the one CI fix it needs
 * (issue #1430).
 *
 * Extends the lease while merge automation holds the slot, re-establishes it
 * under that owner if it lapsed a moment ago, and leaves any other holder — a CI
 * fix that already took it over, a Review — alone. One Lua script, so the read
 * and the write cannot interleave with a take-over.
 *
 * Best-effort, like {@link refreshReviewDispatchClaim}: errors are logged, never
 * thrown.
 */
export async function refreshMergeAutomationClaim(key: string, ttlSec: number): Promise<void> {
	const namespacedKey = `${KEY_NS}${key}`;
	try {
		await getRedis().eval(
			REFRESH_IF_HELD_BY,
			1,
			namespacedKey,
			MERGE_AUTOMATION_CLAIM_OWNER,
			String(ttlSec),
		);
	} catch (err) {
		logger.warn('review-dispatch dedup: merge-automation claim refresh failed (TTL will reap)', {
			reviewDispatchKey: key,
			error: String(err),
		});
	}
}
