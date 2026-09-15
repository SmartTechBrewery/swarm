/**
 * The BullMQ producer — since issue #284 (ADR-002) a *wake-up publisher*, not a
 * second business-state machine. Durable dispatch intent lives in Postgres
 * (`src/db/repositories/dispatchesRepository.ts`); jobs on {@link QUEUE_NAME}
 * only deliver "dispatch X is due" to the worker, which acts solely after
 * atomically claiming the dispatch record. Everything that used to introspect
 * or mutate pending queue state (promote-by-run, remove-by-run, coalesced
 * supersede, pending-set snapshots) is retired in favour of dispatch
 * transitions in `src/dispatch/`.
 *
 * Mirrors Cascade's `src/queue/client.ts`: a lazy `Queue` singleton so
 * importing this module is free (no Redis connection until the first enqueue).
 */

import { Job, Queue } from 'bullmq';
import { requireEnv } from '../lib/env.js';
import { parseRedisUrl } from '../lib/redis.js';
import { normalizeStoredJobPayload, QUEUE_NAME, type SwarmJob } from './jobs.js';

let queue: Queue<SwarmJob> | null = null;

/**
 * PM-driven events (`pm` card status changes, plus SCM `work-item`
 * invalidations that dispatch fallback Planning) are demoted below BullMQ's
 * implicit default priority so PR review-lifecycle events (`scm`: opened /
 * checks / reviews) never sit queued behind one. BullMQ ranks 0 (unset) as
 * highest, so review-lifecycle jobs need no override — only PM-driven jobs get
 * pushed down. Without this, a card dragged into Planning/In progress right as a
 * PR opens can leave that PR's review waiting out the whole implementation run
 * in a project running one job at a time (`maxConcurrentJobs`), and even at 2 it
 * still competes for the same limited slots.
 */
export const PM_BOARD_JOB_PRIORITY = 10;

/**
 * A worker self-update is promoted *above* the default (issue #972): it is the
 * shortest job in the system and the one everything else is waiting behind, so a
 * machine asked to update while its queue is full is served first rather than
 * last. The durable dispatch table orders claims by `priority ASC` and its
 * `priority` column is a plain `integer` with no lower bound, so ranking ahead of
 * everything needs no new mechanism — just a negative.
 *
 * **Not handed to BullMQ, deliberately** — see {@link bullMqPriorityOption}.
 */
export const WORKER_UPDATE_JOB_PRIORITY = -10;

/**
 * Normalizes before branching: most callers hand this a payload read straight out
 * of a `jsonb` column (`dispatch.jobPayload`, `run.jobPayload`), which is *typed*
 * {@link SwarmJob} but may still carry a pre-#385/#297 `{ type: 'github' }` /
 * `{ type: 'github-projects' }` envelope — and that envelope matches neither arm,
 * so a resurrected legacy board job would silently fall through to `undefined` →
 * `priority: 0`, BullMQ's *highest*, the exact inversion this demotion exists to
 * prevent. Doing it here rather than at each call site covers every current and
 * future caller.
 *
 * The single place a job's priority is decided, for the dispatch table as well as
 * for BullMQ — which is why the durable write (`requestWorkerUpdate`,
 * `src/db/repositories/workersRepository.ts`) calls it rather than restating the
 * constant.
 */
export function priorityFor(job: SwarmJob): number | undefined {
	const normalized = normalizeStoredJobPayload(job);
	if (normalized.type === 'worker-update') return WORKER_UPDATE_JOB_PRIORITY;
	return normalized.type === 'pm' ||
		(normalized.type === 'scm' && normalized.event.kind === 'work-item')
		? PM_BOARD_JOB_PRIORITY
		: undefined;
}

/**
 * The `priority` option to hand BullMQ for a job {@link priorityFor} ranked — the
 * option itself when the rank is a *demotion*, and **nothing at all** when it
 * ranks above the default.
 *
 * **BullMQ has no tier above unset, and a negative would invert the ordering it
 * asks for.** A BullMQ worker `RPOPLPUSH`es from the plain `wait` list first and
 * only falls through to the prioritized ZSET when `wait` is empty; a job added
 * with no `priority` option goes to `wait`, and a job added with *any* priority —
 * including a negative one, which `Job.addJob` rejects only for non-integers and
 * values above `PRIORITY_LIMIT` — goes to the ZSET. So passing `-10` here would
 * rank the wake-up **behind** every unset-priority wake-up: the exact inversion
 * issue #972 exists to remove. Omitting the option asks for the highest tier
 * BullMQ has, which is what a negative rank means.
 *
 * The durable dispatch table, where ordering actually decides which unit a worker
 * claims, honours the negative directly (`priority ASC`); BullMQ only carries the
 * wake-up.
 */
function bullMqPriorityOption(job: SwarmJob): { priority?: number } {
	const priority = priorityFor(job);
	return priority !== undefined && priority > 0 ? { priority } : {};
}

/**
 * Lazily construct the shared producer queue. `REDIS_URL` is read here, not at
 * module load, so a process that imports this module without ever enqueuing
 * (e.g. a unit test) never needs Redis configured.
 */
function getQueue(): Queue<SwarmJob> {
	if (!queue) {
		queue = new Queue<SwarmJob>(QUEUE_NAME, {
			connection: parseRedisUrl(requireEnv('REDIS_URL')),
			defaultJobOptions: {
				// Only infrastructure failures throw out of the worker's `processJob`
				// (unknown project, worktree/graft/spawn) — and all of those throw
				// *before* the agent CLI runs, so a bounded retry can't re-run a
				// non-idempotent agent. Agent failures are returned as an outcome, not
				// thrown, precisely so they don't trigger these retries. A retried
				// delivery re-claims its own dispatch lease (same owner), so the retry
				// is admitted by the dispatch layer too.
				attempts: 3,
				backoff: { type: 'exponential', delay: 5_000 },
				// Keep Redis from growing unbounded; keep enough history to debug.
				removeOnComplete: { age: 24 * 60 * 60, count: 100 },
				removeOnFail: { age: 7 * 24 * 60 * 60 },
			},
		});
	}
	return queue;
}

/**
 * Enqueue a legacy (dispatch-less) job. Retained only as the router's degraded
 * fallback for when the dispatch table is unavailable mid-deploy (the worker
 * adopts such a job into a dispatch record at dequeue — `ADR-002`). All normal
 * enqueue paths go through `src/dispatch/dispatcher.ts`.
 *
 * `deliveryId` (the provider's per-delivery id) is used as the BullMQ job id when
 * present so a redelivered webhook dedupes while the completed job is retained.
 */
export async function enqueueJob(job: SwarmJob): Promise<string | undefined> {
	const priorityOpt = bullMqPriorityOption(job);
	const opts =
		job.deliveryId || priorityOpt.priority !== undefined
			? { ...(job.deliveryId ? { jobId: job.deliveryId } : {}), ...priorityOpt }
			: undefined;
	const added = await getQueue().add(job.type, job, opts);
	return added.id;
}

/**
 * Publish a dispatch wake-up: the one queue write the dispatch layer performs.
 * `jobId` is deterministic per (dispatch, wake sequence) — `dispatch_<id>_w<seq>`
 * — so a repair re-publish is a BullMQ no-op while a completed stale wake-up
 * can never suppress a fresh one (every transition back into a wakeable state
 * bumps the sequence). The payload is carried for observability and legacy
 * parsing; the worker treats the claimed dispatch row's stored payload as
 * authoritative.
 */
export async function enqueueDispatchWakeUp(
	job: SwarmJob,
	jobId: string,
	delayMs: number,
): Promise<string | undefined> {
	const added = await getQueue().add(job.type, job, {
		jobId,
		...(delayMs > 0 ? { delay: delayMs } : {}),
		...bullMqPriorityOption(job),
	});
	return added.id;
}

/**
 * Best-effort removal of a pending (waiting/prioritized/delayed) wake-up job by
 * its deterministic id — cancellation cleanup, never a correctness requirement:
 * a wake-up that survives is refused at dispatch-claim time anyway. Returns
 * whether a pending job was removed; an active/finished job is left alone.
 */
export async function removePendingJobById(jobId: string): Promise<boolean> {
	const job = await Job.fromId(getQueue(), jobId);
	if (!job) return false;
	const state = await job.getState();
	if (state === 'active' || state === 'completed' || state === 'failed') return false;
	await job.remove();
	return true;
}

/**
 * Remove every job that has not started processing — queue-transport cleanup
 * used by the canonical `swarm queue clear` *after* it cancels the durable
 * dispatch records, and to drain legacy (dispatch-less) jobs. Active jobs are
 * deliberately excluded: cancelling a live run requires the run-cancellation
 * path so its worker and durable records stay consistent.
 */
export async function clearPendingJobs(): Promise<number> {
	const q = getQueue();
	const [waiting, prioritized, delayed] = await Promise.all([
		q.getWaiting(),
		q.getPrioritized(),
		q.getDelayed(),
	]);
	const jobs = [...waiting, ...prioritized, ...delayed];
	await Promise.all(jobs.map((job) => job.remove()));
	return jobs.length;
}

/**
 * Close the producer connection — called from process shutdown handlers so the
 * process exits cleanly instead of hanging on an open Redis socket. A no-op
 * if nothing was ever enqueued (the queue is created lazily).
 */
export async function closeQueue(): Promise<void> {
	if (queue) {
		await queue.close();
		queue = null;
	}
}
