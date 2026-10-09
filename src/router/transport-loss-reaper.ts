/**
 * Settle the dispatches an orphaned worker was holding, on the strength of the
 * transport signal rather than the phase-timeout lease (issue #859).
 *
 * The router already knows, within seconds, that a worker's `/worker/stream` has
 * dropped: `onWorkerTransportLost` fires on the close and records the interruption
 * against every dispatch awaited on that worker (`./dispatch-results.ts`,
 * issue #723). Until now the only thing done with that knowledge was one note in
 * each run's output stream. If the worker never came back, the dispatch stayed
 * `running` until the control plane's own result wait gave up at the phase's budget
 * plus the margin, or the 5-minute reconciler reached its expired lease — 34-38
 * minutes in the incident that prompted this. All of it wasted: the orphan holds the
 * PR-scoped hold (issue #850), its task's checkout, and a project capacity slot, so
 * every phase queued behind any of the three defers on a dispatch that will never do
 * anything.
 *
 * The lease is the wrong bound because it is sized to the *phase's* budget, not to
 * worker liveness. The mirror for the opposite case already exists: issue #719 reaps
 * a worker's stale claims the moment it *reconnects*, driven from the handshake that
 * mints a new fencing token. A worker that leaves and stays gone had no equivalent
 * path — the worse case, since nothing but the clock ever ends it. This module is
 * that path.
 *
 * How it decides: arm a grace when the drop is observed, and re-check the facts when
 * it fires — never cancel the timer, exactly as the offline-termination settle does
 * (`./dispatch-cancellation.ts`, issue #827). A worker with a live socket here again
 * is a blip that reconnected and is left alone; a worker still absent has its
 * dispatches ended through the same registry seam both precedents already use
 * (`failOrphanedDispatchResultWait`, beside `failDispatchResultWait`). The grace is measured from the **most recent** drop for
 * each dispatch, not from whichever drop armed the firing timer: every drop arms its
 * own grace and carries the generation that identifies it, so a timer that fires
 * while a newer drop's grace is still running steps aside for it.
 *
 * Why connectivity here and not #827's `worker_sessions` silence heuristic: that
 * module never observed a close — its trigger is a *failed push*, which is ambiguous
 * — so it has to infer liveness from the retained row's `lastHeartbeatAt`. Here the
 * close was observed, and `noteTransportLoss` (`./worker-transport.ts`) already fires
 * only when no replacement socket is registered. "Is there a live socket for this
 * worker here again?" is the direct question, and it needs no Postgres round trip.
 * The single-router MVP assumption both `./worker-connections.ts` and
 * `./dispatch-results.ts` state is what makes that answer complete.
 *
 * **The run is retried automatically (issue #1075).** The synthetic frame is a
 * `deferred` one of kind `transport-lost`, so `adaptResultToPhaseRun` raises an
 * `AgentRunError { kind: 'transport-lost' }` and the shared failure path defers the
 * run through the ordinary deferral machinery: the run is `deferred` with a
 * `nextRetryAt`, the dispatch `retry-scheduled` with wait reason `transport-lost`.
 * The delay and the bound come from that failure type's entry in the automatic-retry
 * registry (`../worker/automatic-retry-policy.ts`): 30 minutes, at most two automatic
 * retries per run on their own counter, after which the run fails for the operator
 * exactly as it did before. The lost worker is recorded on the run
 * (`runs.recovery.transportLostWorkerIds`), and the dispatch gate prefers another
 * eligible worker for the retry. Retry now on the deferred run reopens the same
 * dispatch, so it supersedes the scheduled retry and never creates a second run.
 *
 * The retry is mechanically the operator's Retry now — same run row, same dispatch,
 * fresh session — so it is exactly as safe for a pushing phase as that is: delivery
 * refuses a remote head that drifted from the expected SHA, PR and comment delivery
 * are idempotent per run, and a Planning split is resumable by its run's markers.
 *
 * **A worker that comes back after the retry took over is stopped, not trusted (issue
 * #1073).** The reap ends the control plane's wait. It cannot reach the agent, which keeps running on a
 * machine that only went to sleep. Planning for #568 on `under-control-platform` came
 * back about 12 minutes after the reap, finished the phase, renamed and split the item
 * and moved both cards to Ready. Its `succeeded` result was then dropped, because nothing
 * here was awaiting it. The board said the phase had worked and the run said it had
 * failed, and the move to Ready dispatched nothing, since SWARM's own board writes are
 * loop-suppressed. The card stranded. Two things now keep the late phase off the
 * board:
 *
 * - the reap records each dispatch it ends as an *orphan* of its worker
 *   (`failOrphanedDispatchResultWait`, `./dispatch-results.ts`), and when that worker's
 *   stream reopens {@link stopOrphanedDispatchesOnReturn} pushes it a `task-cancel` for
 *   each, so the agent is stopped instead of finishing a phase nobody will settle;
 * - every delivery call an assignment makes names its dispatch, and the delivery API
 *   refuses one naming an orphan of the calling worker (`./worker-delivery.ts`). The
 *   stop is a push, and a phase may already be in its delivery step when it lands, or
 *   reach a route before its socket is back. The fence covers those cases.
 *
 * The automatic retry reuses the dispatch id (issue #1075), so both are keyed on the
 * worker as well as the dispatch: the back-channel reaches a waiter only with frames
 * from the worker it was pushed to, and an orphan is remembered per dispatch and
 * worker. A retry running on W2 is therefore never resolved by W1's answer to its
 * stop, and W1's delivery calls stay refused while W2's are served. One narrow race
 * is accepted rather than engineered around: when the lost worker is the only
 * eligible one and reconnects at the very moment its retry is pushed back to it, its
 * answer to the stop carries the same dispatch id from the same worker and can reach
 * the new wait.
 *
 * **Until then, a late success is honoured (issue #1076).** #1073 rejected that
 * because it needed a second settle path outside `processJob`, after the run had
 * already failed and posted its failure. The deferral removes both objections: no
 * failure was posted, and the run can be settled by re-entering `processJob` through
 * the same dispatch. So while the dispatch is still waiting for its automatic retry
 * (`retry-scheduled` with wait reason `transport-lost`), the orphan is *trusted*: its
 * returning worker is not told to stop, its delivery calls are served, and a late
 * `succeeded` result is adopted by {@link acceptLateOrphanResult}. That makes the
 * scheduled retry due at once, carrying the result, and `processJob` settles the run
 * succeeded through its ordinary success tail — the next phase for the item and every
 * split child it advanced, merge automation, CI recovery. The phase is not run again
 * and no second run exists. A late failure, or silence, leaves the retry to run when
 * due. Trust ends when the dispatch stops waiting for that retry: when the scheduled
 * retry — or the operator's Retry now — is claimed ({@link endOrphanTrustAtClaim}) and
 * pushed ({@link stopOrphansOfDispatch}), or when the claimed job ends any other way,
 * terminally or deferred for another reason ({@link endOrphanTrustUnlessRetryPending});
 * from then on the orphan is stopped and fenced exactly as above, and a late success
 * is dropped.
 *
 * A router restart inside the window loses the in-memory orphan record, so the late
 * result is dropped and the scheduled retry runs at its due time.
 */

import {
	adoptLateResultIntoScheduledRetry,
	getDispatchById,
} from '../db/repositories/dispatchesRepository.js';
import { recordRunLateResultAccepted } from '../db/repositories/runsRepository.js';
import { parseDispatchPayload, publishDispatchWakeUp } from '../dispatch/dispatcher.js';
import { resolveHeartbeatTtlMs } from '../identity/worker-session-service.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { SwarmJob } from '../queue/jobs.js';
import type { TaskExecutionResult } from '../transport/protocol.js';
import {
	countDispatchInterruptions,
	type DispatchTransportLoss,
	failOrphanedDispatchResultWait,
	hasTrustedOrphans,
	listOrphanedDispatchesForWorker,
	type OrphanedDispatch,
	resolveDispatchStreamTarget,
	takeOverOrphanedDispatch,
} from './dispatch-results.js';
import {
	LATE_RESULT_ACCEPTED_NOTE,
	persistControlPlaneNote,
	TRANSPORT_LOST_ORPHAN_NOTE,
	TRANSPORT_RETURNED_AFTER_ORPHAN_NOTE,
} from './stream-log-persistence.js';
import { isWorkerConnected, sendToWorker } from './worker-connections.js';
import { offlineSilenceMs } from './worker-liveness.js';

/**
 * What the reaped dispatch, its run row, and the synthetic terminal result all
 * record. Deliberately neither the lease reconciler's "did not report a result
 * within the lease window" nor a cancellation's neutral message, so run history says
 * which of the three actually happened — the same reason issue #719's supersede
 * reason is its own string rather than a shared one.
 */
export const TRANSPORT_LOST_ORPHAN_REASON =
	"The worker's transport session was lost and did not return within the grace — settled from that signal, not from the lease window";

/**
 * The `reason` on the `task-cancel` a returning worker is sent for each orphan. It is
 * for the daemon's log only, like a user termination's: the run settled when it was
 * reaped, and whatever the worker answers is dropped.
 */
const ORPHAN_STOP_REASON =
	'the control plane settled this dispatch while the worker was away — stop the phase';

/** The `reason` on the `task-cancel` an orphan is sent when its dispatch moves on without it. */
const ORPHAN_TAKEN_OVER_REASON =
	'the control plane retried this dispatch after the worker was lost — stop the earlier attempt';

/**
 * Arm the bounded reap for the dispatches `workerId`'s drop interrupted.
 *
 * Fire-and-forget by contract, like the connection hook that calls it: returns
 * `void`, does no I/O, and never lets a socket's lifecycle wait on anything. The
 * timer is unreffed so a pending grace cannot hold the process open at shutdown, and
 * it is never cancelled — {@link settleIfTransportStayedLost} decides on the facts as
 * they stand when it fires.
 */
export function reapDispatchesIfTransportStaysLost(
	workerId: string,
	interrupted: DispatchTransportLoss[],
): void {
	// The ordinary case: a worker with nothing in flight here. Nothing to bound.
	if (interrupted.length === 0) return;
	const graceMs = offlineSilenceMs(resolveHeartbeatTtlMs());
	logger.warn("worker transport lost: reaping this worker's dispatches if it stays gone", {
		workerId,
		dispatchIds: interrupted.map((dispatch) => dispatch.dispatchId),
		graceMs,
	});
	const timer = setTimeout(() => {
		settleIfTransportStayedLost(workerId, interrupted, graceMs);
	}, graceMs);
	timer.unref();
}

/**
 * The armed grace, firing. Re-runs the connectivity test rather than trusting the
 * one taken when the socket closed: a blip that reconnected inside the grace is a
 * phase still genuinely executing, and must survive exactly as it does today.
 *
 * Per dispatch, the registration is re-resolved and checked to still name *this*
 * worker. That covers both ways a dispatch can have moved on: it settled inside the
 * grace (its real result arrived, or something else ended the wait), or its id was
 * re-pushed elsewhere — `scheduleDispatchRetry` reuses dispatch ids across attempts,
 * so a later attempt's waiter must never be ended by an older drop's timer.
 *
 * The third way is time rather than identity, and it is why each loss carries its
 * generation (review #5069436530, F1). Connectivity alone answers "is the worker here
 * *now*?", not "has it been gone for the grace" — a worker that dropped, reconnected,
 * and dropped again a moment before this timer fires is absent on both readings, so
 * this timer would settle a dispatch whose real absence is milliseconds old and whose
 * daemon is still climbing its reconnect ladder. Each drop arms its own grace, so
 * deferring to the newest one loses no coverage: the later timer settles the dispatch
 * a full grace after the later drop, which is the guarantee the docs state.
 */
function settleIfTransportStayedLost(
	workerId: string,
	interrupted: DispatchTransportLoss[],
	graceMs: number,
): void {
	if (isWorkerConnected(workerId)) {
		logger.info('worker transport lost: the worker came back inside the grace — nothing to reap', {
			workerId,
			graceMs,
		});
		return;
	}
	for (const { dispatchId, interruptions } of interrupted) {
		const target = resolveDispatchStreamTarget(dispatchId);
		if (!target || target.workerId !== workerId) continue;
		// A drop after the one this timer was armed for restarts the grace, and armed a
		// timer of its own to enforce it. Ordering makes the comparison sufficient: a
		// later drop can only have raised the count, and a re-push resets it to 0.
		if (countDispatchInterruptions(dispatchId) !== interruptions) {
			logger.info('worker transport lost: the transport dropped again — the later grace decides', {
				workerId,
				dispatchId,
				graceMs,
			});
			continue;
		}
		// Before the settle, so the run's own stream corrects the note that promised
		// output would resume "when it reconnects" — it never did.
		persistControlPlaneNote(target.runId, TRANSPORT_LOST_ORPHAN_NOTE);
		// Remembered as an orphan of this worker, so a late return is stopped and
		// fenced rather than trusted (issue #1073).
		if (failOrphanedDispatchResultWait(dispatchId, TRANSPORT_LOST_ORPHAN_REASON)) {
			logger.warn('worker transport lost: settled a dispatch whose worker never returned', {
				workerId,
				dispatchId,
				runId: target.runId,
				graceMs,
			});
		}
	}
}

/**
 * A worker's stream just reopened: stop every phase this router reaped from it while
 * it was away (issue #1073).
 *
 * Each orphan gets a `task-cancel`, the frame the worker already handles for a
 * termination (issue #549). What it does with it covers every way the late phase can
 * stand:
 * - still running: it aborts the agent;
 * - finished while the socket was down, result held (issue #718): it sends that result;
 * - unknown to it (the daemon restarted, or the phase had already reported): it
 *   answers with a synthetic cancelled result (issue #724).
 * Any of those reaches `deliverDispatchResult`, which drops it and forgets the orphan.
 * A push that fails, because the socket dropped again, leaves the orphan for the next
 * reconnect, and the delivery fence holds in between.
 *
 * Fire-and-forget by contract, like every connection hook (`./worker-transport.ts`):
 * synchronous, no I/O beyond the push and the fire-and-forget run note. It is called
 * before anything that could wake new work for this worker, so the stop goes out
 * first.
 */
export function stopOrphanedDispatchesOnReturn(workerId: string): void {
	for (const orphan of listOrphanedDispatchesForWorker(workerId)) {
		const sent = pushOrphanStop(orphan, ORPHAN_STOP_REASON);
		if (!sent) continue;
		persistControlPlaneNote(orphan.runId, TRANSPORT_RETURNED_AFTER_ORPHAN_NOTE);
		logger.warn('worker transport restored: stopping a phase settled while the worker was away', {
			workerId,
			dispatchId: orphan.dispatchId,
			runId: orphan.runId,
			phase: orphan.phase,
			taskId: orphan.taskId,
		});
	}
}

/** Push one orphan its `task-cancel`, returning whether the worker's socket took it. */
function pushOrphanStop(orphan: OrphanedDispatch, reason: string): boolean {
	return sendToWorker(orphan.workerId, {
		type: 'task-cancel',
		dispatchId: orphan.dispatchId,
		runId: orphan.runId,
		reason,
		// What the worker needs to answer a stop for a phase it no longer runs (issue
		// #724). Taken from the registration recorded at push time, never from the
		// worker.
		phase: orphan.phase,
		taskId: orphan.taskId,
	});
}

/**
 * End the trusted window for `dispatchId` and stop its orphans (issue #1076): the
 * automatic retry is being pushed to `newWorkerId` (`./dispatcher.ts`), or, with no
 * worker named, the dispatch settled without one — terminally, or deferred for some
 * other reason ({@link endOrphanTrustUnlessRetryPending}).
 *
 * Each orphan that was still trusted is told to stop now if its worker is connected.
 * One that is not is fenced from here on and stopped when it reconnects
 * ({@link stopOrphanedDispatchesOnReturn}), exactly as under #1073. An orphan on the
 * retry's own worker is forgotten instead (`takeOverOrphanedDispatch`). Synchronous
 * and I/O-free beyond the push, so the dispatcher can call it right before its own.
 */
export function stopOrphansOfDispatch(dispatchId: string, newWorkerId?: string): void {
	for (const orphan of takeOverOrphanedDispatch(dispatchId, newWorkerId)) {
		const sent = pushOrphanStop(orphan, ORPHAN_TAKEN_OVER_REASON);
		logger.warn(
			newWorkerId
				? "automatic retry taking over: stopping the lost worker's earlier attempt"
				: "transport-lost dispatch moved on without its retry: stopping the lost worker's attempt",
			{
				dispatchId,
				runId: orphan.runId,
				workerId: orphan.workerId,
				newWorkerId,
				stopSent: sent,
			},
		);
	}
}

/**
 * The scheduled retry of `dispatchId` was just claimed (issue #1076): from here on the
 * late attempt can no longer be adopted — the dispatch has left `retry-scheduled` —
 * so its trusted window ends.
 *
 * Only orphans whose worker is disconnected lose their trust here. They are fenced at
 * once and stopped when they reconnect, which is what keeps a retry that defers
 * before pushing (the gate finds no eligible worker, the task is in flight) from
 * leaving them free to write while nothing will settle their result. A connected
 * orphan is left to what the claim leads to: the push forgets it when the retry goes
 * back to its own worker, whose running phase then answers the new wait, and stops it
 * when the retry goes elsewhere; a claim that ends without a push stops it in
 * {@link endOrphanTrustUnlessRetryPending}. Stopping it here instead would race the
 * push of the same dispatch id to the same worker, whose answer to the stop would
 * settle the new wait.
 */
export function endOrphanTrustAtClaim(dispatchId: string): void {
	const distrusted = takeOverOrphanedDispatch(
		dispatchId,
		undefined,
		(orphan) => !isWorkerConnected(orphan.workerId),
	);
	for (const orphan of distrusted) {
		logger.info('automatic retry claimed: fencing the lost worker until it reconnects', {
			dispatchId,
			runId: orphan.runId,
			workerId: orphan.workerId,
		});
	}
}

/**
 * Once a claimed dispatch's job has run its course, end the trusted window of any
 * orphan still trusted unless the dispatch is again waiting for a transport-lost
 * automatic retry (issue #1076) — the one state a late success can still be adopted
 * from. That covers every way the claim can end without the push taking the orphans
 * over: a terminal settle (the retry budget is spent, a skip, a failure before the
 * push) and a deferral for any other wait reason (`worker-eligibility`,
 * `task-in-flight`, …), which the adoption would refuse anyway.
 *
 * A deferral this very job made because *its* push lost its transport keeps the new
 * orphan trusted, which is the point. Never throws: a failed read ends the trust,
 * because a fenced orphan is the safe side of the trade (#1073's behaviour).
 */
export async function endOrphanTrustUnlessRetryPending(dispatchId: string): Promise<void> {
	if (!hasTrustedOrphans(dispatchId)) return;
	try {
		const dispatch = await getDispatchById(dispatchId);
		if (dispatch?.state === 'retry-scheduled' && dispatch.waitReason === 'transport-lost') {
			return;
		}
	} catch (err) {
		logger.warn('late result: failed to read the dispatch after its job — ending trust', {
			dispatchId,
			error: describeError(err),
		});
	}
	stopOrphansOfDispatch(dispatchId);
}

/**
 * The adoption hook a trusted orphan's late `succeeded` result is handed to (issue
 * #1076, `deliverDispatchResult` in `./dispatch-results.ts`). Fire-and-forget by
 * contract, like every frame handler's hook: the work is queued and any failure is
 * logged, so the socket never waits on Postgres.
 */
export function acceptLateOrphanResult(
	orphan: OrphanedDispatch,
	result: TaskExecutionResult,
): void {
	void adoptLateOrphanResult(orphan, result).catch((err) => {
		logger.error('late result: failed to adopt — the automatic retry goes ahead', {
			dispatchId: orphan.dispatchId,
			workerId: orphan.workerId,
			runId: orphan.runId,
			error: describeError(err),
		});
	});
}

/**
 * Adopt the late success into the dispatch's scheduled automatic retry: compare-and-set
 * it from `retry-scheduled`/`transport-lost` to `pending`, due now and carrying the
 * result (`adoptLateResultIntoScheduledRetry`), then publish its wake-up. `processJob`
 * then settles the run with the result rather than pushing the phase again.
 *
 * A miss is dropped with a line: the retry already took over, the operator retried
 * or cancelled, or the run settled terminally — whichever got there first owns the
 * dispatch. Only the worker's own result is ever adopted: the frame reached this hook
 * from the orphan record keyed by the socket's authenticated worker.
 */
async function adoptLateOrphanResult(
	orphan: OrphanedDispatch,
	result: TaskExecutionResult,
): Promise<void> {
	const context = {
		dispatchId: orphan.dispatchId,
		workerId: orphan.workerId,
		runId: orphan.runId,
	};
	if (!orphan.selection) {
		logger.warn('late result: no recorded selection for the orphan — dropping', context);
		return;
	}
	const dispatch = await getDispatchById(orphan.dispatchId);
	if (dispatch?.state !== 'retry-scheduled' || dispatch.waitReason !== 'transport-lost') {
		logger.warn(
			'late result: the dispatch is no longer waiting for its automatic retry — dropping',
			{
				...context,
				state: dispatch?.state,
				waitReason: dispatch?.waitReason,
			},
		);
		return;
	}
	const job = parseDispatchPayload(dispatch);
	const payload: SwarmJob = {
		...job,
		adoptedResult: { result: { ...result, status: 'succeeded' }, selection: orphan.selection },
		// The reaped attempt still holds its PR+SHA review-dispatch slot, so the
		// SCM continuation handlers must reuse it rather than drop this as a
		// duplicate inside the claim's TTL — as the pre-run waits do.
		...(job.type === 'scm' ? { continuationDispatchClaimed: true } : {}),
	};
	const adopted = await adoptLateResultIntoScheduledRetry(dispatch.id, dispatch.wakeSeq, payload);
	if (!adopted) {
		logger.warn(
			'late result: the automatic retry moved on before the result was adopted — dropping',
			context,
		);
		return;
	}
	persistControlPlaneNote(orphan.runId, LATE_RESULT_ACCEPTED_NOTE);
	if (orphan.runId) {
		try {
			await recordRunLateResultAccepted(orphan.runId, orphan.workerId);
		} catch (err) {
			logger.warn('late result: failed to record it on the run (continuing)', {
				...context,
				error: describeError(err),
			});
		}
	}
	try {
		await publishDispatchWakeUp(adopted);
	} catch (err) {
		logger.warn('late result: failed to publish the wake-up (reconciler will repair)', {
			...context,
			error: describeError(err),
		});
	}
	logger.warn(
		'late result: a lost worker reported success before its retry — settling the run with it',
		context,
	);
}
