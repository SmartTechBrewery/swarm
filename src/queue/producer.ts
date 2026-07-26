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
 * PM-driven events (`github-projects` card status changes, plus SCM `work-item`
 * invalidations that dispatch fallback Planning) are demoted below BullMQ's
 * implicit default priority so PR review-lifecycle events (`scm`: opened /
 * checks / reviews) never sit queued behind one. BullMQ ranks 0 (unset) as
 * highest, so review-lifecycle jobs need no override — only PM-driven jobs get
 * pushed down. Without this, a card dragged into Planning/In progress right as a
 * PR opens can leave that PR's review waiting out the whole implementation run
 * under `SWARM_WORKER_CONCURRENCY=1`, and even at 2 it still competes for the
 * same limited slots.
 */
export const PM_BOARD_JOB_PRIORITY = 10;

/**
 * Normalizes before branching: most callers hand this a payload read straight out
 * of a `jsonb` column (`dispatch.jobPayload`, `run.jobPayload`), which is *typed*
 * {@link SwarmJob} but may still carry the pre-#385 `{ type: 'github' }` envelope
 * — and that envelope matches neither arm, so a resurrected legacy board job would
 * silently fall through to `undefined` → `priority: 0`, BullMQ's *highest*, the
 * exact inversion this demotion exists to prevent. Doing it here rather than at
 * each call site covers every current and future caller.
 */
export function priorityFor(job: SwarmJob): number | undefined {
	const normalized = normalizeStoredJobPayload(job);
	return normalized.type === 'github-projects' ||
		(normalized.type === 'scm' && normalized.event.kind === 'work-item')
		? PM_BOARD_JOB_PRIORITY
		: undefined;
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
	const priority = priorityFor(job);
	const opts =
		job.deliveryId || priority !== undefined
			? {
					...(job.deliveryId ? { jobId: job.deliveryId } : {}),
					...(priority !== undefined ? { priority } : {}),
				}
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
	const priority = priorityFor(job);
	const added = await getQueue().add(job.type, job, {
		jobId,
		...(delayMs > 0 ? { delay: delayMs } : {}),
		...(priority !== undefined ? { priority } : {}),
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
