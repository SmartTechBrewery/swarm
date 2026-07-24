/**
 * The stale-lease take-over against real Redis (issue #427).
 *
 * `takeOverWorktreeLease` is a Lua compare-and-set, and the unit tests can only
 * assert the script text handed to a mocked `eval` — which proves nothing about
 * whether the script does what the comment claims, nor that ioredis' return value
 * coerces to the `1` the code compares against. This suite runs it for real:
 * matching token wins, mismatched token loses (so a concurrent provisioner that
 * legitimately claimed the lease is never robbed), a vanished key loses, and a
 * successful take-over refreshes the TTL.
 */

import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseRedisUrl } from '@/lib/redis.js';
import {
	claimWorktreeLease,
	readWorktreeLease,
	releaseWorktreeLease,
	takeOverWorktreeLease,
} from '@/worktree/worktree-lease.js';

const PROJECT_ID = 'lease-takeover-proj';
const TASK_ID = '427';
/** Mirrors the module's own key layout so the test can inspect the TTL directly. */
const KEY = `swarm:worktree-lease:${PROJECT_ID}:${TASK_ID}`;

describe.skipIf(!process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'takeOverWorktreeLease (integration, real Redis)',
	() => {
		let redis: Redis;

		beforeEach(async () => {
			redis ??= new Redis(parseRedisUrl(process.env.REDIS_URL as string));
			await redis.del(KEY);
		});

		afterAll(async () => {
			await redis?.del(KEY);
			await redis?.quit();
		});

		it('adopts the lease when the observed token still holds it, and refreshes the TTL', async () => {
			await claimWorktreeLease(PROJECT_ID, TASK_ID, 'stale-token');
			// Age the lease so a refreshed TTL is distinguishable from the original.
			await redis.expire(KEY, 60);

			expect(await takeOverWorktreeLease(PROJECT_ID, TASK_ID, 'stale-token', 'fresh-token')).toBe(
				true,
			);
			expect(await readWorktreeLease(PROJECT_ID, TASK_ID)).toBe('fresh-token');
			expect(await redis.ttl(KEY)).toBeGreaterThan(60);
		});

		it('refuses when another provisioner claimed the lease after it was read', async () => {
			await claimWorktreeLease(PROJECT_ID, TASK_ID, 'someone-elses-token');

			expect(await takeOverWorktreeLease(PROJECT_ID, TASK_ID, 'stale-token', 'fresh-token')).toBe(
				false,
			);
			// The rightful holder keeps it.
			expect(await readWorktreeLease(PROJECT_ID, TASK_ID)).toBe('someone-elses-token');
		});

		it('refuses when the lease vanished between the read and the take-over', async () => {
			expect(await takeOverWorktreeLease(PROJECT_ID, TASK_ID, 'stale-token', 'fresh-token')).toBe(
				false,
			);
			expect(await readWorktreeLease(PROJECT_ID, TASK_ID)).toBeNull();
		});

		it('reports a free lease as null once released', async () => {
			await claimWorktreeLease(PROJECT_ID, TASK_ID, 'tok');
			await releaseWorktreeLease(PROJECT_ID, TASK_ID, 'tok');

			expect(await readWorktreeLease(PROJECT_ID, TASK_ID)).toBeNull();
		});
	},
);
