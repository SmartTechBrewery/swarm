import { Queue, Worker } from 'bullmq';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { QUEUE_NAME, type SwarmJob } from '../../../src/queue/jobs.js';
import { closeQueue, enqueueDispatchWakeUp } from '../../../src/queue/producer.js';
import { createMockPmWebhookJob, createMockScmWebhookJob } from '../../helpers/factories.js';

/**
 * The transport half of issue #972's ordering guarantee, against real
 * Redis/BullMQ — the layer a mocked `Queue.add` cannot answer for.
 *
 * The claim is that a machine asked to update while the queue is full is served
 * *first*, and the durable dispatch table's `priority ASC` only delivers it once a
 * wake-up has been dequeued: the control-plane consumer takes jobs off BullMQ before
 * anything consults that column. So what actually decides between an update and work
 * already waiting is which list BullMQ puts each job in and which end it pops from,
 * and that is what these tests drive — one real consumer, one slot, jobs claimed in
 * the order it is handed them.
 */

function redisConnection() {
	const url = new URL(process.env.REDIS_URL ?? '');
	return { host: url.hostname, port: Number(url.port || 6379) };
}

function updateWakeUp(): SwarmJob {
	return {
		type: 'worker-update',
		projectId: 'swarm',
		workerId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
		requestId: '66666666-6666-4666-8666-666666666666',
		target: 'main',
	};
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE || !process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'worker-update wake-up ordering (integration, Redis/BullMQ)',
	() => {
		let inspect: Queue<SwarmJob>;

		beforeEach(async () => {
			inspect ??= new Queue<SwarmJob>(QUEUE_NAME, { connection: redisConnection() });
			await inspect.obliterate({ force: true });
		});

		afterAll(async () => {
			await inspect?.obliterate({ force: true }).catch(() => {});
			await inspect?.close();
			await closeQueue();
		});

		/**
		 * The job ids a single-slot consumer claims, in claim order. One slot on
		 * purpose: with the consumer saturated — the state this ordering exists for —
		 * the next job to free a slot is the next one BullMQ hands out, so a
		 * concurrency of one is that question asked directly.
		 */
		async function claimOrder(count: number): Promise<string[]> {
			const claimed: string[] = [];
			let settle: () => void = () => {};
			const done = new Promise<void>((resolve) => {
				settle = resolve;
			});
			const consumer = new Worker<SwarmJob>(
				QUEUE_NAME,
				async (job) => {
					claimed.push(job.id ?? '');
					if (claimed.length === count) settle();
				},
				{ connection: redisConnection(), concurrency: 1 },
			);
			try {
				await done;
			} finally {
				await consumer.close();
			}
			return claimed;
		}

		// The finding this fixes: an option-less add `LPUSH`es onto `wait`, which is the
		// end a worker does *not* pop from, so the update went out behind everything
		// already queued. `lifo` is what puts it at the head.
		it('claims a worker-update wake-up before wake-ups that were already waiting', async () => {
			await enqueueDispatchWakeUp(createMockScmWebhookJob(), 'dispatch_scm_a_w0', 0);
			await enqueueDispatchWakeUp(createMockScmWebhookJob(), 'dispatch_scm_b_w0', 0);
			await enqueueDispatchWakeUp(updateWakeUp(), 'dispatch_update_w0', 0);

			expect(await claimOrder(3)).toEqual([
				'dispatch_update_w0',
				// The rest keep their own FIFO order — the promotion is the update's alone.
				'dispatch_scm_a_w0',
				'dispatch_scm_b_w0',
			]);
		});

		// The other end of the same ranking: a board-driven job is demoted into BullMQ's
		// prioritized ZSET, which a consumer only reaches once `wait` is empty. Asserted
		// together so a future change cannot fix one end by inverting the other.
		it('keeps the whole ranking: update, then default work, then a demoted board job', async () => {
			await enqueueDispatchWakeUp(createMockPmWebhookJob(), 'dispatch_pm_w0', 0);
			await enqueueDispatchWakeUp(createMockScmWebhookJob(), 'dispatch_scm_w0', 0);
			await enqueueDispatchWakeUp(updateWakeUp(), 'dispatch_update_w0', 0);

			expect(await claimOrder(3)).toEqual([
				'dispatch_update_w0',
				'dispatch_scm_w0',
				'dispatch_pm_w0',
			]);
		});
	},
);
