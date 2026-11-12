/**
 * A red event takes over merge automation's claim on a head its own branch update
 * produced (issue #1430). This runs against the real Redis because the take-over
 * is a Lua compare-and-set that a mocked client cannot check.
 *
 * The incident sequence: merge automation updates the branch and claims the new
 * head's slot for fifteen minutes so that head's green checks start no Review. Its
 * retry budget runs out while CI is still running, and the claim stays live. The
 * red that then arrives must reach exactly one CI fix, and nothing else may take
 * the slot from its holder.
 */

import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { parseRedisUrl } from '../../../src/lib/redis.js';
import {
	buildReviewDispatchKey,
	claimReviewDispatch,
	MERGE_AUTOMATION_CLAIM_OWNER,
	refreshMergeAutomationClaim,
	refreshReviewDispatchClaim,
	reviewDispatchClaimOwner,
	takeOverMergeAutomationClaim,
} from '../../../src/triggers/review-dispatch-dedup.js';

const CLAIM_KEY = buildReviewDispatchKey('acme/review-merge-automation-claim', '1430', 'f00dfeed');
/** Mirrors the module's own key layout so the test can inspect and clean up. */
const REDIS_KEY = `swarm:review-dedup:${CLAIM_KEY}`;
const UPDATED_HEAD_CLAIM_TTL_SEC = 15 * 60;

/** What `claimUpdatedHeadReviewSlot` (`src/worker/merge-automation.ts`) does. */
async function claimAsMergeAutomation(): Promise<boolean> {
	return claimReviewDispatch(CLAIM_KEY, 'merge-automation', {
		prNumber: '1430',
		headSha: 'f00dfeed',
		owner: MERGE_AUTOMATION_CLAIM_OWNER,
		ttlSec: UPDATED_HEAD_CLAIM_TTL_SEC,
	});
}

async function claimAs(dispatchId: string): Promise<boolean> {
	return claimReviewDispatch(CLAIM_KEY, 'pr-review', {
		prNumber: '1430',
		headSha: 'f00dfeed',
		owner: reviewDispatchClaimOwner(dispatchId),
	});
}

describe.skipIf(!process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'merge-automation updated-head claim take-over (integration, Redis)',
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

		it('hands the held slot to exactly one red event, keeping its lease', async () => {
			// 1. Merge automation claims the updated head for fifteen minutes.
			expect(await claimAsMergeAutomation()).toBe(true);
			expect(await redis.get(REDIS_KEY)).toBe(MERGE_AUTOMATION_CLAIM_OWNER);
			expect(await redis.ttl(REDIS_KEY)).toBeGreaterThan(UPDATED_HEAD_CLAIM_TTL_SEC - 10);

			// 2. A green event's Review claim still loses: no redundant Review.
			expect(await claimAs('green')).toBe(false);

			// 3. The red event takes it over for its own dispatch, lease intact.
			expect(await takeOverMergeAutomationClaim(CLAIM_KEY, reviewDispatchClaimOwner('d1'))).toBe(
				true,
			);
			expect(await redis.get(REDIS_KEY)).toBe('pr-review:d1');
			expect(await redis.ttl(REDIS_KEY)).toBeGreaterThan(UPDATED_HEAD_CLAIM_TTL_SEC - 10);

			// 4. A sibling red finds an ordinary holder now: no second CI fix.
			expect(await takeOverMergeAutomationClaim(CLAIM_KEY, reviewDispatchClaimOwner('d2'))).toBe(
				false,
			);
			expect(await redis.get(REDIS_KEY)).toBe('pr-review:d1');
		});

		it('lets exactly one of several concurrent red events win', async () => {
			expect(await claimAsMergeAutomation()).toBe(true);

			const results = await Promise.all(
				['d1', 'd2', 'd3', 'd4'].map((id) =>
					takeOverMergeAutomationClaim(CLAIM_KEY, reviewDispatchClaimOwner(id)),
				),
			);

			expect(results.filter(Boolean)).toHaveLength(1);
		});

		it('never takes a slot another holder has', async () => {
			expect(await claimAs('review')).toBe(true);
			expect(await takeOverMergeAutomationClaim(CLAIM_KEY, reviewDispatchClaimOwner('d1'))).toBe(
				false,
			);
			expect(await redis.get(REDIS_KEY)).toBe('pr-review:review');

			// A running CI fix's extended lease is no merge-automation claim either.
			await refreshReviewDispatchClaim(CLAIM_KEY, 2100);
			expect(await takeOverMergeAutomationClaim(CLAIM_KEY, reviewDispatchClaimOwner('d1'))).toBe(
				false,
			);
		});

		it('never creates a claim on a free slot', async () => {
			expect(await takeOverMergeAutomationClaim(CLAIM_KEY, reviewDispatchClaimOwner('d1'))).toBe(
				false,
			);
			expect(await redis.exists(REDIS_KEY)).toBe(0);
		});
		// Issue #1432's pending-checks wait keeps this claim alive past its first
		// lease; doing so must leave it the merge-automation value a red looks for.
		it('keeps the merge-automation owner across a pending-checks refresh', async () => {
			expect(await claimAsMergeAutomation()).toBe(true);
			await redis.expire(REDIS_KEY, 30);

			await refreshMergeAutomationClaim(CLAIM_KEY, UPDATED_HEAD_CLAIM_TTL_SEC);

			expect(await redis.get(REDIS_KEY)).toBe(MERGE_AUTOMATION_CLAIM_OWNER);
			expect(await redis.ttl(REDIS_KEY)).toBeGreaterThan(UPDATED_HEAD_CLAIM_TTL_SEC - 10);
			expect(await takeOverMergeAutomationClaim(CLAIM_KEY, reviewDispatchClaimOwner('d1'))).toBe(
				true,
			);
		});

		it('re-establishes a lapsed claim under its owner but leaves another holder alone', async () => {
			await refreshMergeAutomationClaim(CLAIM_KEY, UPDATED_HEAD_CLAIM_TTL_SEC);
			expect(await redis.get(REDIS_KEY)).toBe(MERGE_AUTOMATION_CLAIM_OWNER);

			expect(await takeOverMergeAutomationClaim(CLAIM_KEY, reviewDispatchClaimOwner('d1'))).toBe(
				true,
			);
			await redis.expire(REDIS_KEY, 30);
			await refreshMergeAutomationClaim(CLAIM_KEY, UPDATED_HEAD_CLAIM_TTL_SEC);
			expect(await redis.get(REDIS_KEY)).toBe('pr-review:d1');
			expect(await redis.ttl(REDIS_KEY)).toBeLessThanOrEqual(30);
		});
	},
);
