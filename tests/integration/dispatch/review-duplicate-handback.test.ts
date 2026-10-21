/**
 * A same-phase duplicate Review's hand-back is fenced on ownership (issue #1105,
 * review F1 on #1106) — against the real Redis claim and review-verdict table.
 *
 * The interleaving: D2 claims a head and reserves its verdict slot, then stalls
 * past the claim's five-minute TTL before it is dropped as a duplicate. In that
 * window D3 re-claims the key and its same-head reservation re-points D2's
 * `pending` slot to itself. D2's late hand-back must leave both D3's claim and
 * D3's slot live — an unconditional DEL plus a head-wide abandon would erase
 * D3's ownership, miss its verdict write, and free the head for a duplicate.
 */

import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createDispatch } from '../../../src/db/repositories/dispatchesRepository.js';
import {
	abandonReviewVerdictOwnedBy,
	getReviewVerdictByHead,
	markReviewVerdictSubmitted,
	reserveReviewVerdict,
} from '../../../src/db/repositories/reviewVerdictsRepository.js';
import { parseRedisUrl } from '../../../src/lib/redis.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import {
	buildReviewDispatchKey,
	claimReviewDispatch,
	releaseReviewDispatchHeldBy,
	reviewDispatchClaimOwner,
} from '../../../src/triggers/review-dispatch-dedup.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-review-duplicate-handback';
const REPO = 'acme/review-duplicate-handback';
const PR = '115';
const HEAD = 'c0ffee01';
const CLAIM_KEY = buildReviewDispatchKey(REPO, PR, HEAD);
/** Mirrors the module's own key layout so the test can inspect and clean up. */
const REDIS_KEY = `swarm:review-dedup:${CLAIM_KEY}`;
const SLOT = { projectId: PROJECT_ID, repository: REPO, prNumber: PR, headSha: HEAD };

async function reviewDispatch(): Promise<string> {
	const { dispatch } = await createDispatch({
		projectId: PROJECT_ID,
		jobPayload: { ...createMockScmWebhookJob(), projectId: PROJECT_ID } as SwarmJob,
		source: 'webhook',
		taskId: PR,
		phase: 'review',
		state: 'leased',
	});
	return dispatch.id;
}

/** One trigger evaluation: claim under the dispatch's token, then reserve. */
async function evaluate(dispatchId: string): Promise<boolean> {
	const claimed = await claimReviewDispatch(CLAIM_KEY, 'pr-review', {
		prNumber: PR,
		headSha: HEAD,
		owner: reviewDispatchClaimOwner(dispatchId),
	});
	if (claimed) await reserveReviewVerdict(SLOT, dispatchId);
	return claimed;
}

/** The consumer's duplicate hand-back, as `handBackDuplicateReviewClaims` runs it. */
async function handBack(dispatchId: string): Promise<boolean> {
	const abandoned = await abandonReviewVerdictOwnedBy(SLOT, dispatchId);
	await releaseReviewDispatchHeldBy(CLAIM_KEY, reviewDispatchClaimOwner(dispatchId));
	return abandoned;
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE || !process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'duplicate Review hand-back ownership (integration, Postgres + Redis)',
	() => {
		let redis: Redis;

		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: REPO });
			redis ??= new Redis(parseRedisUrl(process.env.REDIS_URL as string));
			await redis.del(REDIS_KEY);
		});

		afterAll(async () => {
			await redis?.del(REDIS_KEY);
			await redis?.quit();
		});

		it('leaves a later owner’s claim and slot live when the earlier owner hands back late', async () => {
			const d2 = await reviewDispatch();
			const d3 = await reviewDispatch();
			expect(await evaluate(d2)).toBe(true);

			// D2's claim lapses (the TTL, compressed), and D3's evaluation re-claims the
			// key and re-points the same-head pending slot to itself.
			await redis.del(REDIS_KEY);
			expect(await evaluate(d3)).toBe(true);

			// D2 is finally dropped as a duplicate behind D3 and hands back.
			expect(await handBack(d2)).toBe(false);

			expect(await redis.get(REDIS_KEY)).toBe(reviewDispatchClaimOwner(d3));
			expect(await getReviewVerdictByHead(PROJECT_ID, REPO, PR, HEAD)).toMatchObject({
				state: 'pending',
			});
			// D3 still records its verdict, and a further event finds the head claimed.
			expect(await markReviewVerdictSubmitted(SLOT, { verdict: 'approve' })).toBeDefined();
			expect(await evaluate(await reviewDispatch())).toBe(false);
		});

		it('hands back its own claim and slot when nothing re-took them', async () => {
			const d2 = await reviewDispatch();
			expect(await evaluate(d2)).toBe(true);

			expect(await handBack(d2)).toBe(true);

			expect(await redis.get(REDIS_KEY)).toBeNull();
			expect(await getReviewVerdictByHead(PROJECT_ID, REPO, PR, HEAD)).toMatchObject({
				state: 'abandoned',
			});
		});
	},
);
