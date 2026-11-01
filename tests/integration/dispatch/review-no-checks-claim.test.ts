/**
 * A Review dispatched on a head that reported no checks marks its PR+SHA claim
 * (issue #1270) — against the real Redis, since the mark, its read and the
 * owner-fenced release are Lua scripts a mocked client cannot check.
 *
 * The sequence the mark exists for: the check-less Review holds the slot, the
 * head's checks register and go red, and the red event has to tell that holder
 * from a CI fix already running on the head — which it must never duplicate.
 */

import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { parseRedisUrl } from '../../../src/lib/redis.js';
import {
	buildReviewDispatchKey,
	claimReviewDispatch,
	markReviewDispatchClaimedWithoutChecks,
	refreshReviewDispatchClaim,
	releaseReviewDispatchHeldBy,
	reviewClaimedWithoutChecksTtlSec,
	reviewDispatchClaimOwner,
} from '../../../src/triggers/review-dispatch-dedup.js';

const CLAIM_KEY = buildReviewDispatchKey('acme/review-no-checks-claim', '346', 'e79b7f05');
/** Mirrors the module's own key layout so the test can inspect and clean up. */
const REDIS_KEY = `swarm:review-dedup:${CLAIM_KEY}`;

async function claimAs(dispatchId: string): Promise<boolean> {
	return claimReviewDispatch(CLAIM_KEY, 'pr-review', {
		prNumber: '346',
		headSha: 'e79b7f05',
		owner: reviewDispatchClaimOwner(dispatchId),
	});
}

describe.skipIf(!process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'check-less Review claim mark (integration, Redis)',
	() => {
		let redis: Redis;

		beforeEach(async () => {
			redis ??= new Redis(parseRedisUrl(process.env.REDIS_URL as string));
			await redis.del(REDIS_KEY);
		});

		afterAll(async () => {
			await redis?.del(REDIS_KEY);
			await redis?.quit();
		});

		it('marks the live claim in place, keeping its owner and TTL', async () => {
			expect(await claimAs('d1')).toBe(true);

			await markReviewDispatchClaimedWithoutChecks(CLAIM_KEY);
			await markReviewDispatchClaimedWithoutChecks(CLAIM_KEY);

			expect(await redis.get(REDIS_KEY)).toBe('pr-review:d1:no-checks');
			const ttl = await reviewClaimedWithoutChecksTtlSec(CLAIM_KEY);
			expect(ttl).toBeGreaterThan(290);
			expect(ttl).toBeLessThanOrEqual(300);
			// Still held: a red sibling event cannot take it.
			expect(await claimAs('d2')).toBe(false);
		});

		it('reports no check-less holder for an unmarked claim or a free slot', async () => {
			expect(await reviewClaimedWithoutChecksTtlSec(CLAIM_KEY)).toBeUndefined();

			expect(await claimAs('d1')).toBe(true);
			expect(await reviewClaimedWithoutChecksTtlSec(CLAIM_KEY)).toBeUndefined();
		});

		it('never creates a claim when there is none to mark', async () => {
			await markReviewDispatchClaimedWithoutChecks(CLAIM_KEY);

			expect(await redis.exists(REDIS_KEY)).toBe(0);
		});

		// The double-fix guard: once a CI fix extends the slot, the red event must
		// read an ordinary holder again and drop.
		it('loses the mark when a CI fix takes the slot over', async () => {
			expect(await claimAs('d1')).toBe(true);
			await markReviewDispatchClaimedWithoutChecks(CLAIM_KEY);

			await refreshReviewDispatchClaim(CLAIM_KEY, 2100);

			expect(await reviewClaimedWithoutChecksTtlSec(CLAIM_KEY)).toBeUndefined();
		});

		it('still lets its owner, and only its owner, hand a marked claim back', async () => {
			expect(await claimAs('d1')).toBe(true);
			await markReviewDispatchClaimedWithoutChecks(CLAIM_KEY);

			await releaseReviewDispatchHeldBy(CLAIM_KEY, reviewDispatchClaimOwner('d2'));
			expect(await redis.exists(REDIS_KEY)).toBe(1);

			await releaseReviewDispatchHeldBy(CLAIM_KEY, reviewDispatchClaimOwner('d1'));
			expect(await redis.exists(REDIS_KEY)).toBe(0);
		});
	},
);
