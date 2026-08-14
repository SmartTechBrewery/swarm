/**
 * Dispatch orchestration (issue #284, ADR-002) — the one seam through which
 * every attempt to start or resume a pipeline phase enters the system. It
 * pairs the durable record (`src/db/repositories/dispatchesRepository.ts`)
 * with its BullMQ wake-up in transactional-outbox order: persist the dispatch
 * first, publish the wake-up second, and let the reconciler
 * (`src/dispatch/reconciler.ts`) re-publish anything a crash left unpublished.
 * The worker acts on a wake-up only after {@link claimDispatchForJob} — so a
 * cancelled, completed, or superseded dispatch is refused at claim time no
 * matter which delivery path (redelivery, delayed retry, slot release,
 * reconciliation) carried it here.
 */

import { hostname } from 'node:os';
import {
	type CreateDispatchInput,
	cancelAllWaitingDispatches,
	cancelWaitingDispatch,
	claimDispatch,
	createDispatch,
	type DispatchRow,
	getActiveDispatchByRunId,
	listAvailabilityWaitsForWorker,
	listTaskInFlightWaits,
	promoteDispatchToImmediateWake,
	selectNextCapacityDispatch,
	supersedeDispatchesByCoalesceKey,
} from '../db/repositories/dispatchesRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { normalizeStoredJobPayload, type SwarmJob, SwarmJobSchema } from '../queue/jobs.js';
import {
	clearPendingJobs,
	enqueueDispatchWakeUp,
	priorityFor,
	removePendingJobById,
} from '../queue/producer.js';

/** This process's dispatch-lease identity — `hostname:pid`. */
export const DISPATCH_LEASE_OWNER = `${hostname()}:${process.pid}`;

/**
 * Deterministic wake-up job id for a dispatch at its current wake sequence.
 * Colon-free (BullMQ reserves `:`); unique per transition into a wakeable
 * state, so republished repairs no-op while stale completed ids never collide.
 */
export function wakeJobId(dispatch: Pick<DispatchRow, 'id' | 'wakeSeq'>): string {
	return `dispatch_${dispatch.id}_w${dispatch.wakeSeq}`;
}

/** The dedup identity a webhook delivery id maps to. */
export function deliveryDedupKey(deliveryId: string): string {
	return `delivery:${deliveryId}`;
}

/**
 * Publish a dispatch's wake-up at its current wake sequence, delayed until its
 * `availableAt`. Idempotent (deterministic job id) and safe to repeat — the
 * reconciler calls this for every wakeable dispatch it finds.
 */
export async function publishDispatchWakeUp(dispatch: DispatchRow): Promise<void> {
	// Normalized so a repaired pre-#385 row publishes under the current job *name*
	// (`scm`, not `github`) and matching payload — observability only, since the
	// worker re-parses the claimed dispatch's stored payload as authoritative.
	const payload: SwarmJob = {
		...normalizeStoredJobPayload(dispatch.jobPayload),
		dispatchId: dispatch.id,
	};
	const delayMs = Math.max(0, dispatch.availableAt.getTime() - Date.now());
	await enqueueDispatchWakeUp(payload, wakeJobId(dispatch), delayMs);
}

/**
 * Create a dispatch and publish its wake-up — the outbox hand-off every
 * enqueue-shaped source uses (webhooks, synthetic self-enqueues, follow-up
 * reviews, manual retries). A dedup conflict returns the existing dispatch and
 * publishes nothing (the original owner's wake-up, or the reconciler, covers
 * it). If publishing fails the dispatch stays durably `pending`/scheduled and
 * the error propagates for the caller to surface; the reconciler repairs it
 * either way.
 */
export async function createAndPublishDispatch(
	input: CreateDispatchInput,
): Promise<{ dispatch: DispatchRow; created: boolean }> {
	const { dispatch, created } = await createDispatch(input);
	if (created) await publishDispatchWakeUp(dispatch);
	return { dispatch, created };
}

/** Why a wake-up was refused at claim time. */
export type DispatchClaimRefusal =
	| 'not-found'
	| 'terminal'
	| 'held-elsewhere'
	| 'duplicate-run-attempt';

export type DispatchClaimResult =
	| { claimed: true; dispatch: DispatchRow }
	| { claimed: false; reason: DispatchClaimRefusal };

/**
 * Claim the dispatch behind a dequeued job, or adopt a legacy (dispatch-less)
 * job into the durable model.
 *
 * With a `dispatchId`, this is a straight conditional claim — a terminal
 * dispatch (cancelled/completed/failed/superseded) refuses the wake-up, which
 * is the enforcement point for "cancellation prevents resurrection from every
 * delivery path".
 *
 * Without one (a job enqueued before the dispatch layer, or the router's
 * degraded fallback): when the job carries a `runId` whose run already has an
 * active dispatch (e.g. the startup backfill created it), that dispatch is
 * claimed so the legacy delayed job and the backfilled record resolve to one
 * attempt; otherwise a dispatch row is created directly in `leased` state so
 * the invariants hold for the rest of the run. A dedup conflict on the
 * delivery id likewise claims the existing record.
 */
export async function claimDispatchForJob(
	job: SwarmJob,
	leaseMs: number,
): Promise<DispatchClaimResult> {
	if (job.dispatchId) {
		const dispatch = await claimDispatch(job.dispatchId, DISPATCH_LEASE_OWNER, leaseMs);
		if (dispatch) return { claimed: true, dispatch };
		return { claimed: false, reason: 'terminal' };
	}

	// Legacy adoption. A runId-carrying legacy retry may already have a
	// backfilled active dispatch — claim it rather than create a duplicate.
	if (job.runId) {
		const existing = await getActiveDispatchByRunId(job.runId);
		if (existing) {
			const dispatch = await claimDispatch(existing.id, DISPATCH_LEASE_OWNER, leaseMs);
			if (dispatch) return { claimed: true, dispatch };
			return { claimed: false, reason: 'held-elsewhere' };
		}
	}

	try {
		const { dispatch, created } = await createDispatch({
			projectId: job.projectId,
			jobPayload: job,
			dedupKey: job.deliveryId ? deliveryDedupKey(job.deliveryId) : undefined,
			priority: priorityFor(job) ?? 0,
			source: 'adopted',
			state: 'leased',
			leaseOwner: DISPATCH_LEASE_OWNER,
			leaseExpiresAt: new Date(Date.now() + leaseMs),
			runId: job.runId,
			attempt: job.rateLimitRetryAttempt ?? 0,
		});
		if (created) return { claimed: true, dispatch };
		// Delivery-id conflict: the dispatch layer already tracks this event —
		// claim it so exactly one of the two deliveries proceeds.
		const claimed = await claimDispatch(dispatch.id, DISPATCH_LEASE_OWNER, leaseMs);
		if (claimed) return { claimed: true, dispatch: claimed };
		return { claimed: false, reason: 'held-elsewhere' };
	} catch (err) {
		// The partial unique active-run index: another actor holds an active
		// dispatch for this run — this legacy job is a duplicate attempt.
		logger.warn('dispatch: legacy job adoption refused', {
			projectId: job.projectId,
			runId: job.runId,
			error: describeError(err),
		});
		return { claimed: false, reason: 'duplicate-run-attempt' };
	}
}

/**
 * Schedule a coalesced recheck dispatch: supersede prior waiting dispatches
 * carrying the same `coalesceKey` (their wake-ups are removed best-effort —
 * claim-time refusal covers any that survive), then create and publish the
 * replacement, due after `delayMs`. The replacement's payload carries the
 * bumped `recheckAttempt`, exactly like the BullMQ-era `scheduleCoalescedJob`.
 */
export async function scheduleCoalescedDispatch(
	job: SwarmJob,
	coalesceKey: string,
	delayMs: number,
): Promise<void> {
	const superseded = await supersedeDispatchesByCoalesceKey(coalesceKey);
	for (const row of superseded) {
		await removePendingJobById(wakeJobId(row)).catch(() => false);
	}
	await createAndPublishDispatch({
		projectId: job.projectId,
		jobPayload: job,
		coalesceKey,
		priority: priorityFor(job) ?? 0,
		source: 'recheck',
		waitReason: 'recheck',
		availableAt: new Date(Date.now() + delayMs),
	});
}

/**
 * After a project slot frees, wake the next capacity-blocked dispatch (SCM
 * continuations first when the project opts in — issue #214's policy). No slot
 * is reserved: the woken dispatch re-checks capacity at claim time and re-defers
 * if it lost the race. Best-effort and fully swallowed — a queue hiccup must
 * never turn a settled run into a failed job; the reconciler's periodic
 * promotion is the safety net.
 */
export async function promoteNextCapacityDispatch(
	projectId: string,
	prioritizeContinuations = true,
): Promise<void> {
	try {
		const next = await selectNextCapacityDispatch(projectId, prioritizeContinuations);
		if (!next) return;
		await publishDispatchWakeUp(next);
		logger.debug('dispatch: slot freed — woke capacity-blocked dispatch', {
			projectId,
			dispatchId: next.id,
			taskId: next.taskId,
			phase: next.phase,
			continuation: next.continuation,
		});
	} catch (err) {
		logger.warn('dispatch: capacity promotion failed', {
			projectId,
			error: describeError(err),
		});
	}
}

/**
 * After a phase settles, wake whatever was waiting for *that task's* checkout to
 * free (issue #759) — the task-level sibling of {@link promoteNextCapacityDispatch},
 * and the wake-up that turns the in-flight collision guard from a silent drop into
 * a sequenced hand-off.
 *
 * No re-dating is needed (unlike {@link promoteAvailabilityWaitsForWorker}): these
 * are `pending` rows already eligible now, whose wake-up was never published, so
 * one delay-0 publish under the row's deterministic wake id is enough and a repeat
 * is a queue no-op. A woken dispatch re-runs the guard on claim and re-defers if it
 * lost the race.
 *
 * Best-effort and fully swallowed, exactly like the capacity promotion: it runs off
 * a settled run, which a queue hiccup must never fail — the reconciler's periodic
 * republish (`pending` rows are wakeable unless they wait on project capacity) is
 * the safety net.
 */
export async function promoteTaskInFlightWaits(projectId: string, taskId: string): Promise<number> {
	try {
		const waiting = await listTaskInFlightWaits(projectId, taskId);
		if (waiting.length === 0) return 0;
		for (const dispatch of waiting) {
			await publishDispatchWakeUp(dispatch);
		}
		logger.debug('dispatch: task freed — woke phases waiting for its checkout', {
			projectId,
			taskId,
			promoted: waiting.length,
			phases: waiting.map((row) => row.phase ?? row.id),
		});
		return waiting.length;
	} catch (err) {
		logger.warn('dispatch: task-in-flight promotion failed', {
			projectId,
			taskId,
			error: describeError(err),
		});
		return 0;
	}
}

/** What made a worker available, for the promotion's log line (issue #610). */
export type WorkerAvailabilityCause =
	/** Its authenticated `/worker/stream` socket opened on this router. */
	| 'connected'
	/** A dispatch bound to it settled, releasing its execution claim. */
	| 'capacity-freed';

/**
 * After a worker becomes available — it connected, or a dispatch bound to it
 * settled and released its claim — start the dispatches that were only waiting
 * for exactly that (issue #610).
 *
 * A refusal from the eligibility gate is deferred on the dependency gate's
 * 5-minute cadence, so before this a dispatch sat still next to an idle worker
 * for up to a full interval. This is the availability wait's equivalent of the
 * slot-release scheduling {@link promoteNextCapacityDispatch} does for the
 * concurrency wait — with one real difference: a capacity wait is a `pending`
 * row whose wake-up is simply (re)published, while these are `retry-scheduled`
 * rows that already hold a live *delayed* wake-up, so the stale one has to be
 * dealt with rather than merely overwritten.
 *
 * Hence the per-row order: **remove the delayed wake-up, then re-date the row,
 * then publish the replacement**, so the dispatch never holds two live wake-ups
 * at once. Removing first is safe in every race — a candidate's wake-up is still
 * delayed by construction (`listAvailabilityWaitsForWorker`), and the re-date is
 * refused unless the row is still on that exact wake sequence, so a row that
 * moved on had this wake-up superseded anyway. Whatever a partial failure
 * leaves behind, the reconciler's idempotent republish and the timed re-check
 * are both still underneath it.
 *
 * Best-effort and fully swallowed, exactly like the capacity promotion: this
 * runs off a settled run and off a socket open, and neither may be failed by a
 * queue hiccup. Returns how many dispatches were promoted.
 */
export async function promoteAvailabilityWaitsForWorker(
	workerId: string,
	cause: WorkerAvailabilityCause,
): Promise<number> {
	try {
		const waiting = await listAvailabilityWaitsForWorker(workerId);
		if (waiting.length === 0) return 0;
		const promoted: DispatchRow[] = [];
		for (const dispatch of waiting) {
			try {
				await removePendingJobById(wakeJobId(dispatch));
				const updated = await promoteDispatchToImmediateWake(dispatch.id, dispatch.wakeSeq);
				// Claimed, cancelled, or already promoted by another worker's wake-up
				// between the read and here — leave it to whoever won.
				if (!updated) continue;
				await publishDispatchWakeUp(updated);
				promoted.push(updated);
			} catch (err) {
				logger.warn('dispatch: could not wake an availability-blocked dispatch', {
					workerId,
					cause,
					dispatchId: dispatch.id,
					error: describeError(err),
				});
			}
		}
		if (promoted.length > 0) {
			logger.info('dispatch: worker became available — woke availability-blocked dispatches', {
				workerId,
				cause,
				promoted: promoted.length,
				taskIds: promoted.map((row) => row.taskId ?? row.id),
			});
		}
		return promoted.length;
	} catch (err) {
		logger.warn('dispatch: availability promotion failed', {
			workerId,
			cause,
			error: describeError(err),
		});
		return 0;
	}
}

/**
 * Cancel one waiting dispatch and remove its wake-up (best-effort). Returns the
 * cancelled row, or `null` when it was not in a cancellable state.
 */
export async function cancelDispatchAndWake(
	id: string,
	reason: string,
): Promise<DispatchRow | null> {
	const cancelled = await cancelWaitingDispatch(id, reason);
	if (cancelled) await removePendingJobById(wakeJobId(cancelled)).catch(() => false);
	return cancelled;
}

/**
 * Cancel a run's active waiting dispatch, if any — the canonical half of
 * terminating a deferred run. Returns whether a dispatch was cancelled.
 */
export async function cancelDispatchForRun(runId: string, reason: string): Promise<boolean> {
	const active = await getActiveDispatchByRunId(runId);
	if (!active) return false;
	return (await cancelDispatchAndWake(active.id, reason)) !== null;
}

/**
 * The canonical queue-clear: cancel every waiting dispatch first (so no retry,
 * continuation, or reconciliation path can resurrect the work), then drain the
 * queue transport of pending wake-ups and any legacy jobs. Returns both counts.
 */
export async function cancelAllWaitingWork(
	reason: string,
	projectId?: string,
): Promise<{ cancelledDispatches: number; removedJobs: number }> {
	const cancelled = await cancelAllWaitingDispatches(reason, projectId);
	for (const row of cancelled) {
		await removePendingJobById(wakeJobId(row)).catch(() => false);
	}
	// Project-scoped cancels leave other projects' wake-ups in place; the global
	// clear also drains legacy dispatch-less jobs from the transport.
	const removedJobs = projectId === undefined ? await clearPendingJobs() : cancelled.length;
	return { cancelledDispatches: cancelled.length, removedJobs };
}

/**
 * Re-validate a dispatch's stored payload at claim time. The jsonb column is
 * trusted-ish (we wrote it), but it crosses a process boundary and schema
 * versions — validate like any queue payload and thread the dispatch id in.
 */
export function parseDispatchPayload(dispatch: DispatchRow): SwarmJob {
	return { ...SwarmJobSchema.parse(dispatch.jobPayload), dispatchId: dispatch.id };
}
