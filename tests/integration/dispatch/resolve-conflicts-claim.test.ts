/**
 * The resolve-conflicts claim ends with the dispatch holding it (issue #1047) —
 * against the real dispatcher, Postgres and Redis.
 *
 * The incident: a `resolve-conflicts` dispatch waiting for a worker held its
 * head/base claim, refreshed on every deferral, when a later merge into the base
 * fanned out again and `scheduleCoalescedDispatch` superseded it. The replacement
 * re-entered the handler from scratch, found the claim held and settled
 * `no-trigger` — as did every later check, for the claim's full 24 h TTL. These
 * tests replay that lifecycle through the real dispatch transitions (and the
 * reconciler's lease reap, the other way a holder ends without running) and
 * assert the claim decision the handler would make at each step.
 */

import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import {
	claimDispatch,
	createDispatch,
	type DispatchRow,
	failExpiredDispatchLeases,
	getDispatchById,
	scheduleDispatchRetry,
} from '../../../src/db/repositories/dispatchesRepository.js';
import { dispatches } from '../../../src/db/schema/dispatches.js';
import { scheduleCoalescedDispatch } from '../../../src/dispatch/dispatcher.js';
import { parseRedisUrl } from '../../../src/lib/redis.js';
import { QUEUE_NAME, type SwarmJob } from '../../../src/queue/jobs.js';
import { closeQueue } from '../../../src/queue/producer.js';
import {
	buildConflictResolutionKey,
	claimConflictResolution,
	refreshConflictResolutionClaim,
} from '../../../src/triggers/resolve-conflicts-dedup.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-conflict-claim';
const REPO = 'acme/conflict-claim';
const COALESCE_KEY = `resolve-conflicts:${REPO}:348:main`;
const STATE_KEY = buildConflictResolutionKey(REPO, '348', 'e1626b32', 'fb2eeddf');
/** Mirrors the module's own key layout so the test can clean up after itself. */
const REDIS_KEY = `swarm:resolve-conflicts:${STATE_KEY}`;
const OWNER = 'test-host:1';

function job(overrides: Partial<SwarmJob> = {}): SwarmJob {
	return { ...createMockScmWebhookJob(), projectId: PROJECT_ID, ...overrides } as SwarmJob;
}

/** Another dispatch evaluating the same pull request — a sibling check, or Review's conflict route. */
async function otherDispatch(): Promise<DispatchRow> {
	const { dispatch } = await createDispatch({
		projectId: PROJECT_ID,
		jobPayload: job(),
		source: 'webhook',
	});
	return dispatch;
}

async function waitingOnCoalesceKey(): Promise<DispatchRow> {
	const rows = await getDb()
		.select()
		.from(dispatches)
		.where(eq(dispatches.coalesceKey, COALESCE_KEY));
	const waiting = rows.filter((row) => row.state === 'pending' || row.state === 'retry-scheduled');
	expect(waiting).toHaveLength(1);
	return waiting[0];
}

/** The fan-out's per-PR check, claimed by a worker and deferred for want of one — refreshing its claim. */
async function claimAndDeferForWorker(dispatch: DispatchRow): Promise<void> {
	expect(await claimDispatch(dispatch.id, OWNER, 60_000)).not.toBeNull();
	expect(await claimConflictResolution(STATE_KEY, dispatch.id)).toBe(true);
	await refreshConflictResolutionClaim(STATE_KEY, 480, dispatch.id);
	expect(
		await scheduleDispatchRetry(dispatch.id, {
			jobPayload: job({ continuationDispatchClaimed: true }),
			availableAt: new Date(Date.now() + 300_000),
			waitReason: 'worker-eligibility',
			attempt: 1,
			lastError: 'No enrolled worker with free capacity',
		}),
	).not.toBeNull();
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE || !process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'resolve-conflicts claim lifetime (integration, Postgres + Redis)',
	() => {
		let redis: Redis;
		// Inspection-only handle, so the wake-ups `scheduleCoalescedDispatch` publishes are cleared.
		let queue: Queue<SwarmJob>;

		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: REPO });
			redis ??= new Redis(parseRedisUrl(process.env.REDIS_URL as string));
			queue ??= new Queue<SwarmJob>(QUEUE_NAME, {
				connection: parseRedisUrl(process.env.REDIS_URL as string),
			});
			await redis.del(REDIS_KEY);
			await queue.obliterate({ force: true });
		});

		afterAll(async () => {
			await redis?.del(REDIS_KEY);
			await redis?.quit();
			await queue?.obliterate({ force: true }).catch(() => {});
			await queue?.close();
			await closeQueue();
		});

		it('a superseded holder does not refuse the coalesced replacement that took its place', async () => {
			await scheduleCoalescedDispatch(job({ recheckAttempt: 1 }), COALESCE_KEY, 0);
			const holder = await waitingOnCoalesceKey();
			await claimAndDeferForWorker(holder);

			// While the holder is still waiting, a sibling check stays refused — the
			// claim is still doing its job.
			const sibling = await otherDispatch();
			expect(await claimConflictResolution(STATE_KEY, sibling.id)).toBe(false);

			// Another merge into the base fans out again and supersedes the holder.
			await scheduleCoalescedDispatch(job({ recheckAttempt: 1 }), COALESCE_KEY, 0);
			expect(await getDispatchById(holder.id)).toMatchObject({
				state: 'completed',
				outcome: 'superseded',
			});
			const replacement = await waitingOnCoalesceKey();
			expect(replacement.id).not.toBe(holder.id);

			// The replacement re-enters the handler from scratch — no `runId`, no
			// `continuationDispatchClaimed` — and must still get to dispatch the phase.
			expect(await claimConflictResolution(STATE_KEY, replacement.id)).toBe(true);
			expect(await redis.get(REDIS_KEY)).toBe(replacement.id);
			// …and holds it in turn: the sibling is still refused.
			expect(await claimConflictResolution(STATE_KEY, sibling.id)).toBe(false);
		});

		it('a holder the reconciler reaped does not refuse the next check', async () => {
			const holder = await otherDispatch();
			expect(await claimDispatch(holder.id, OWNER, 1)).not.toBeNull();
			expect(await claimConflictResolution(STATE_KEY, holder.id)).toBe(true);

			const next = await otherDispatch();
			expect(await claimConflictResolution(STATE_KEY, next.id)).toBe(false);

			const reaped = await failExpiredDispatchLeases('dead worker', new Date(Date.now() + 1_000));
			expect(reaped.map((row) => row.id)).toEqual([holder.id]);

			expect(await claimConflictResolution(STATE_KEY, next.id)).toBe(true);
		});

		it('lets exactly one of two checks take over from an ended holder', async () => {
			await scheduleCoalescedDispatch(job(), COALESCE_KEY, 0);
			const holder = await waitingOnCoalesceKey();
			await claimAndDeferForWorker(holder);
			await scheduleCoalescedDispatch(job(), COALESCE_KEY, 0);

			const a = await otherDispatch();
			const b = await otherDispatch();
			const results = await Promise.all([
				claimConflictResolution(STATE_KEY, a.id),
				claimConflictResolution(STATE_KEY, b.id),
			]);

			expect(results.filter(Boolean)).toHaveLength(1);
			expect(await redis.get(REDIS_KEY)).toBe(results[0] ? a.id : b.id);
		});
	},
);
