/**
 * "Reset & restart" (issue #424) — the last-resort operator action for a run
 * that is *wedged*: a row whose dispatch, Redis cancellation flag, worktree
 * lease, and recovery record disagree badly enough that neither "Retry now" nor
 * "Terminate" can move it, and which today can only be freed by hand-editing
 * the database and deleting the checkout.
 *
 * {@link resetRun} brings all of that back to one clean slate and re-dispatches
 * the run's phase from its stored `jobPayload`. It composes existing helpers
 * only — it is a *sequence*, not a new lifecycle — in this order:
 *
 *   1. cancel the run's active dispatch — claimed or not — so nothing can claim
 *      the run while its checkout is being torn down (the same "cancel before you
 *      touch shared state" ordering `runs.putBack` uses);
 *   2. clear the Redis cancellation flag, or the worker's start-check would
 *      instantly kill the fresh attempt;
 *   3. settle the checkout + lease (`reconcileTerminatedWorktree`), which the
 *      reset path alone may ask to release a *stale* lease and to discard
 *      dirty/unpushed work;
 *   4. clear the recovery record and captured session id;
 *   5. compose the replacement payload as a *first attempt* — no session to resume,
 *      no branch checkpoint, no delivery progress, no inherited recovery mode
 *      (`reconstructResetJob`, issue #741) — and write it back onto the run row,
 *      whose `job_payload` column latches the same resume state the `recovery`
 *      column does and is what a *second* reset (and `runs.retryNow`) reads;
 *   6. create the replacement dispatch, last, so a failure part-way through
 *      leaves the run terminal-and-idle: exactly the state a second `resetRun`
 *      call retries from. The operation is idempotent in that sense.
 *
 * **Reset never refuses and always discards** (issue #744). It is the last-resort
 * action, so an operator reaching for it has already decided the run's state is
 * worthless: there is one button and one command, with no opt-in to forget. It
 * cancels a dispatch a worker claimed a moment ago, tears the checkout down
 * whether it is dirty, unpushed, pinned, or holding a stale `live-leased` marker,
 * and resets a `running` row without it being terminated first. What it still
 * cannot do is stop an already-spawned agent process — both report surfaces say
 * so, and that is the next phase's job. The only two answers that are *not* a
 * restart are the two where restarting is meaningless: an unknown run, and a
 * reset that is already under way ({@link RunResetRefusal}). A run that cannot
 * produce a dispatch at all — no stored payload, or a project that no longer
 * exists — is not refused either: its dispatch, flag and recovery record are
 * cleared exactly the same way and the row is then settled terminally with the
 * stated reason, so it ends idle instead of wedged.
 *
 * Race-safety comes entirely from existing conditional writes — the conditional
 * dispatch cancel, the one-active-dispatch-per-run unique index, and
 * `tryClaimWorktreeLease` at the next provision. No new locks.
 *
 * **Step 3 settles only the checkouts on *this* host — the intent on step 5 settles
 * the rest** (issue #592). `resetRun` runs in the API server, so its
 * `reconcileTerminatedWorktree` call can only ever see the control-plane host's
 * filesystem. That is still exactly right for a checkout the control-plane host's
 * own worker holds, and a harmless no-op otherwise — but in a federated deployment
 * the checkout usually lives on another worker, where the local teardown reports
 * `absent` and the replacement dispatch then fails on the very collision the reset
 * was meant to clear. So every reset also puts `recoveryMode: 'discard'` on the
 * replacement dispatch's payload: the worker that actually holds the checkout
 * honours it in its own recovery gate (`executeRecoveryGate`,
 * `src/pipeline/resume.ts`) before provisioning. That intent is also why a *local*
 * teardown throw is logged and stepped over rather than aborting: the checkout the
 * restart actually has to clear is settled by whichever worker holds it.
 *
 * A synchronous worktree-teardown frame was considered and not taken. `sendToWorker`
 * (`src/router/worker-connections.ts`) is a **router-process-local** map and this
 * service runs in the API server, which has no request channel to the router — only
 * Redis pub/sub (`src/queue/cancellation.ts`) and BullMQ. Adding one would mean
 * inventing a cross-process request/reply mechanism plus a new frame pair purely to
 * reach a worker the replacement dispatch already reaches: worker affinity routes
 * the restart back to the host holding the checkout, which is what makes carrying
 * the intent sufficient.
 *
 * This module deliberately knows nothing about tRPC: the API router (and, later,
 * the CLI) are thin surfaces over it.
 */

import type { ProjectConfig } from '../config/schema.js';
import {
	cancelClaimedDispatch,
	getActiveDispatchByRunId,
} from '../db/repositories/dispatchesRepository.js';
import { getProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import {
	clearRunRecovery,
	failRunFromStatus,
	getRunByIdFromDb,
	hasLiveRunForTask,
	updateRunJobPayload,
} from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { clearRunCancellation } from '../queue/cancellation.js';
import type { SwarmJob } from '../queue/jobs.js';
import { priorityFor, removePendingJobById } from '../queue/producer.js';
import type { TriggerPhase } from '../triggers/types.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import {
	reconcileTerminatedWorktree,
	type TerminationCleanupResult,
} from '../worktree/termination-cleanup.js';
import { cancelDispatchAndWake, createAndPublishDispatch, wakeJobId } from './dispatcher.js';
import { reconstructResetJob } from './retry-payload.js';

/**
 * Why a reset was refused, machine-readable so each surface maps it to its own
 * error shape. Only two survive (issue #744), and neither leaves a run un-reset:
 * there is nothing to reset, or a reset *is* already happening. Every former
 * refusal that could strand a wedged run — a live `running` row, a dispatch a
 * worker claimed first, a checkout teardown that threw, a missing payload, a
 * deleted project — is now an outcome instead.
 */
export type RunResetRefusal = 'run-not-found' | 'already-resetting';

/** A refused reset. Its `message` is already operator-facing; surfaces re-use it verbatim. */
export class RunResetError extends Error {
	constructor(
		readonly reason: RunResetRefusal,
		message: string,
	) {
		super(message);
		this.name = 'RunResetError';
	}
}

/** The steps every reset performs, whatever it ends in. */
interface ResetRunSteps {
	runId: string;
	/** What happened to the run's active dispatch. */
	dispatch: 'none' | 'cancelled' | 'cancelled-claimed';
	cancellationCleared: boolean;
	/**
	 * The worktree/lease settlement **on the control-plane host**, verbatim from
	 * `reconcileTerminatedWorktree` — or `null` when no teardown was attempted,
	 * which happens only when the run's project is gone and there is nothing to
	 * build a `GitWorktreeManager` from. A checkout held by another worker is never
	 * described here; the replacement dispatch's `'discard'` intent settles that one.
	 */
	worktree: TerminationCleanupResult | null;
	/**
	 * Why the local teardown failed, or `null` when it did not (issue #744). A throw
	 * here is reported and stepped over rather than aborting the reset: the checkout
	 * that actually has to be cleared may live on another worker, which the restart's
	 * own discard intent reaches.
	 */
	worktreeError: string | null;
	recoveryCleared: boolean;
	/**
	 * The machine whose preserved checkout this reset gave up (issue #567), or `null`
	 * when the run was pinned to none. Reset is the operator's deliberate "abandon the
	 * preserved work and start over anywhere" action, and it is the *only* thing that
	 * ends the pinned wait — so the report says plainly which machine's work was
	 * discarded, and the run keeps that as `recovery.abandonedWorkerId`.
	 */
	abandonedPreservedWorkerId: string | null;
}

/**
 * How the reset ended. `'restarted'` is the ordinary answer; `'terminated'` is the
 * one for a run that cannot produce a dispatch at all (issue #744) — its state was
 * cleared just the same, and the row was then settled `failed` with `reason`, which
 * is why it could not be restarted. That is deliberately not a refusal: refusing
 * would leave the wedged run exactly as it was, which is the thing reset exists to
 * end.
 */
export type ResetRunResult =
	| (ResetRunSteps & { outcome: 'restarted'; dispatchId: string })
	| (ResetRunSteps & { outcome: 'terminated'; reason: string });

/**
 * Cancel whatever dispatch is currently active for the run, claimed or not
 * (issue #744). A dispatch a worker claimed between our read and our write loses
 * the conditional cancel; it is then cancelled outright and its wake-up dropped,
 * because a reset's whole premise is that this attempt is not worth keeping.
 */
async function cancelActiveDispatch(runId: string): Promise<ResetRunSteps['dispatch']> {
	const active = await getActiveDispatchByRunId(runId);
	if (!active) return 'none';

	// Neutral wording: the CLI calls this service too, not only the dashboard.
	const reason = `Reset & restart of run "${runId}" requested by an operator`;
	if (await cancelDispatchAndWake(active.id, reason)) return 'cancelled';

	await cancelClaimedDispatch(active.id, reason);
	await removePendingJobById(wakeJobId(active)).catch(() => false);
	return 'cancelled-claimed';
}

/**
 * Write the reset's clean payload back onto the run row (issue #741). The dispatch
 * payload is authoritative at claim time, but the row's own `job_payload` keeps
 * whatever resume latches the wedged attempt stored until a worker claims this
 * restart and `resetRunToRunning` overwrites it — and that column is what a
 * *second* reset and `runs.retryNow`'s reconstruct-from-row path read. So it is
 * sanitised here, before the replacement dispatch exists, or the state the reset
 * was called to clear survives its own fix.
 *
 * Best-effort on purpose: the restart itself is already clean, so a failed write
 * must never turn a reset — the last-resort action — into a refusal.
 */
async function sanitizeStoredJobPayload(runId: string, job: SwarmJob): Promise<void> {
	try {
		await updateRunJobPayload(runId, job);
	} catch (err) {
		logger.warn('run reset: could not sanitise the run row’s stored payload', {
			runId,
			error: describeError(err),
		});
	}
}

/**
 * Settle the run's checkout and worktree lease **on this host**, discarding
 * whatever protection it holds. Never throws (issue #744): the checkout the
 * restart actually has to clear may live on another worker, which honours the
 * replacement dispatch's own `'discard'` intent, so a local failure is reported
 * on the result rather than stopping the reset.
 */
async function settleLocalWorktree(
	run: { id: string; projectId: string; taskId: string },
	project: ProjectConfig,
): Promise<Pick<ResetRunSteps, 'worktree' | 'worktreeError'>> {
	try {
		const worktree = await reconcileTerminatedWorktree(
			new GitWorktreeManager(project),
			run.projectId,
			run.taskId,
			// A reset restarts from scratch: nothing is preserved for resume, and the
			// run's own lease (if it still holds one) is exactly what we are clearing.
			null,
			false,
			{
				hasLiveOwner: async (projectId, taskId) => {
					try {
						return await hasLiveRunForTask(projectId, taskId, run.id);
					} catch (err) {
						// Fail closed — an unreadable DB must not license a reclaim.
						logger.warn('run reset: live-owner lookup failed; treating the lease as owned', {
							runId: run.id,
							error: describeError(err),
						});
						return true;
					}
				},
				discardProtectedWork: true,
			},
		);
		return { worktree, worktreeError: null };
	} catch (err) {
		const worktreeError = describeError(err);
		logger.warn('run reset: local checkout teardown failed; restarting anyway', {
			runId: run.id,
			projectId: run.projectId,
			taskId: run.taskId,
			error: worktreeError,
		});
		return { worktree: null, worktreeError };
	}
}

/**
 * Create the dispatch the reset restarts on, last of all the writes. Losing the
 * one-active-dispatch-per-run unique index means a concurrent reset or retry
 * already created it, which is the one refusal a reset that got this far can
 * still answer with: a restart *is* happening, so this call is idempotent rather
 * than owed a second dispatch.
 */
async function createReplacementDispatch(
	run: { id: string; projectId: string; taskId: string; phase: string },
	job: SwarmJob,
): Promise<string> {
	try {
		const created = await createAndPublishDispatch({
			projectId: run.projectId,
			jobPayload: job,
			priority: priorityFor(job) ?? 0,
			source: 'manual',
			waitReason: 'manual-retry',
			runId: run.id,
			taskId: run.taskId,
			phase: run.phase as TriggerPhase,
		});
		return created.dispatch.id;
	} catch (err) {
		const message = describeError(err);
		if (message.includes('uq_dispatches_active_run') || message.includes('duplicate key')) {
			throw new RunResetError(
				'already-resetting',
				`Run "${run.id}" is already being restarted. Refresh to see its current status.`,
			);
		}
		throw err;
	}
}

/**
 * Reset one wedged run and re-dispatch its phase. Throws {@link RunResetError}
 * for the two refusals a caller surfaces (an unknown run, a reset already under
 * way); anything else propagates as an internal failure. Every other ending is a
 * {@link ResetRunResult} — `'restarted'`, or `'terminated'` for a run nothing
 * could be re-dispatched from.
 */
export async function resetRun(runId: string): Promise<ResetRunResult> {
	const run = await getRunByIdFromDb(runId);
	if (!run) {
		throw new RunResetError('run-not-found', `Run with ID "${runId}" not found`);
	}
	// Scoped to the repository the *run* recorded, not the project's default entry
	// (issue #684 phase 2): the `GitWorktreeManager` built from this below tears down
	// the checkout the run actually held, whose branch names come from that
	// repository's own `baseBranch`/`branchPrefix`. A project that no longer owns it
	// throws out of the read rather than falling back.
	const project = await getProjectByIdFromDb(run.projectId, run.repository);

	// The two states that cannot produce a replacement dispatch (issue #744). Neither
	// refuses: the run's dispatch, flag and recovery record are cleared below exactly
	// as they would be for a restart, and the row is then settled terminally with this
	// reason — a wedged run ends idle rather than staying wedged with an error message.
	const jobPayload = run.jobPayload;
	const terminalReason =
		jobPayload === null
			? `Reset could not restart run "${runId}": it was created without a job payload, so there is no phase to re-dispatch. Its dispatch, cancellation flag and recovery record were cleared and the run was settled as failed.`
			: !project
				? `Reset could not restart run "${runId}": its project "${run.projectId}" no longer exists, so there is nothing to re-dispatch it against. Its dispatch, cancellation flag and recovery record were cleared and the run was settled as failed.`
				: null;

	if (run.status === 'running') {
		logger.warn(
			'run reset: resetting a live running run — its agent process may still be writing',
			{
				runId,
				projectId: run.projectId,
				taskId: run.taskId,
			},
		);
	}

	const dispatch = await cancelActiveDispatch(run.id);

	// A stale user-termination flag would make the worker terminate the fresh
	// attempt at its start-check (issue #166); `clearRunCancellation` never throws.
	await clearRunCancellation(run.id);

	// Skipped only when the project is gone, since the manager is built from it. The
	// restart's own `'discard'` intent is what settles a checkout on another host
	// anyway, so this is the local half of the answer in both cases.
	const { worktree, worktreeError } = project
		? await settleLocalWorktree(run, project)
		: { worktree: null, worktreeError: null };

	// Always cleared, even when the checkout was retained: the run is restarting,
	// and the fresh attempt's provisioning gate re-records a blocked reason if the
	// collision survives.
	//
	// This is also what releases the preserved-checkout pin (issue #567) — and note
	// that nothing above needed the pinned machine to participate: the dispatch is
	// cancelled control-plane side and the local checkout reconciliation is a no-op
	// for a checkout that lives on another host. That is deliberate, since the whole
	// point of the escape hatch is to work while that machine is unreachable.
	const abandonedPreservedWorkerId = run.recovery?.preservedWorkerId ?? null;
	await clearRunRecovery(run.id);

	const steps: ResetRunSteps = {
		runId: run.id,
		dispatch,
		cancellationCleared: true,
		worktree,
		worktreeError,
		recoveryCleared: true,
		abandonedPreservedWorkerId,
	};

	if (terminalReason !== null || jobPayload === null) {
		// The second half is redundant — a null payload is already a terminal reason —
		// but it is what narrows `jobPayload` for the restart path below.
		const reason = terminalReason ?? `Reset could not restart run "${runId}".`;
		await failRunFromStatus(run.id, reason);
		logger.warn('run reset settled the run terminally instead of restarting it', {
			runId: run.id,
			projectId: run.projectId,
			taskId: run.taskId,
			phase: run.phase,
			dispatch,
			reason,
		});
		return { ...steps, outcome: 'terminated', reason };
	}

	// A *first attempt*, not a retry (issue #741): the stored payload's resume latches
	// — a session to re-enter, delivery progress, a provisioned task branch, a recovery
	// mode an earlier attempt chose — are all dropped, and the only mode carried is this
	// reset's own `'discard'`. Inheriting them is what made every reset of a run whose
	// payload held `implementationBranchProvisioned` re-provision against a branch that
	// did not exist.
	const job = reconstructResetJob(jobPayload, run.id, run.phase, 'discard');
	await sanitizeStoredJobPayload(run.id, job);
	const dispatchId = await createReplacementDispatch(run, job);

	logger.info('run reset complete', {
		runId: run.id,
		projectId: run.projectId,
		taskId: run.taskId,
		phase: run.phase,
		dispatch,
		worktree: worktree?.outcome ?? 'not-attempted',
		worktreeError,
		abandonedPreservedWorkerId,
		dispatchId,
	});

	return { ...steps, outcome: 'restarted', dispatchId };
}
