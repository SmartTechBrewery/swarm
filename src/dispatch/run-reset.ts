/**
 * "Reset & restart" (issue #424) — the last-resort operator action for a run
 * that is *wedged*: a row whose dispatch, Redis cancellation flag, worktree
 * lease, and recovery record disagree badly enough that neither "Retry now" nor
 * "Terminate" can move it, and which today can only be freed by hand-editing
 * the database and deleting the checkout.
 *
 * {@link resetRun} brings all of that back to one clean slate and re-dispatches
 * the run's phase from its stored `jobPayload`. It composes existing helpers
 * only — it is a *sequence*, not a new lifecycle — and runs its guards before
 * any mutation, in a fail-closed order:
 *
 *   1. cancel the run's active dispatch, so nothing can claim the run while its
 *      checkout is being torn down (the same "cancel before you touch shared
 *      state" ordering `runs.putBack` uses);
 *   2. clear the Redis cancellation flag, or the worker's start-check would
 *      instantly kill the fresh attempt;
 *   3. settle the checkout + lease (`reconcileTerminatedWorktree`), which the
 *      reset path alone may ask to release a *stale* lease and — with `force`
 *      only — to discard dirty/unpushed work;
 *   4. clear the recovery record and captured session id;
 *   5. create the replacement dispatch, last, so a failure part-way through
 *      leaves the run terminal-and-idle: exactly the state a second `resetRun`
 *      call retries from. The operation is idempotent in that sense.
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
 * was meant to clear. So a **forced** reset also puts `recoveryMode: 'discard'` on
 * the replacement dispatch's payload: the worker that actually holds the checkout
 * honours it in its own recovery gate (`executeRecoveryGate`,
 * `src/pipeline/resume.ts`) before provisioning. A plain reset deliberately carries
 * **no** mode — the worker's ordinary provision-time reclaim gate already *is* the
 * plain-reset contract (reclaim a clean, unleased, unpinned checkout; retain
 * anything protected; take over a lease with no live owner).
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

import {
	cancelClaimedDispatch,
	getActiveDispatchByRunId,
} from '../db/repositories/dispatchesRepository.js';
import { getProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import {
	clearRunRecovery,
	getRunByIdFromDb,
	hasLiveRunForTask,
} from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { clearRunCancellation } from '../queue/cancellation.js';
import { priorityFor, removePendingJobById } from '../queue/producer.js';
import type { TriggerPhase } from '../triggers/types.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import {
	reconcileTerminatedWorktree,
	type TerminationCleanupResult,
} from '../worktree/termination-cleanup.js';
import { cancelDispatchAndWake, createAndPublishDispatch, wakeJobId } from './dispatcher.js';
import { reconstructRetryJob } from './retry-payload.js';

/** Why a reset was refused, machine-readable so each surface maps it to its own error shape. */
export type RunResetRefusal =
	| 'run-not-found'
	| 'project-not-found'
	| 'missing-job-payload'
	| 'running-not-forced'
	| 'dispatch-claimed'
	| 'worktree-teardown-failed'
	| 'already-resetting';

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

export interface ResetRunOptions {
	/**
	 * Allow resetting a live `running` run, cancelling a dispatch a worker has
	 * already claimed, and discarding dirty/unpushed work in the checkout —
	 * wherever that checkout lives, since the discard intent travels on the
	 * replacement dispatch (issue #592). It cannot stop an already-spawned agent
	 * process — only Terminate can — so a forced reset of a live run is a
	 * deliberate operator choice.
	 */
	force?: boolean;
}

export interface ResetRunResult {
	runId: string;
	forced: boolean;
	/** What happened to the run's active dispatch. */
	dispatch: 'none' | 'cancelled' | 'force-cancelled-claimed';
	cancellationCleared: boolean;
	/**
	 * The worktree/lease settlement **on the control-plane host**, verbatim from
	 * `reconcileTerminatedWorktree`. A checkout held by another worker is not
	 * described here — see {@link ResetRunResult.worktreeIntent}.
	 */
	worktree: TerminationCleanupResult;
	/**
	 * What the replacement dispatch instructs the worker holding the checkout to do
	 * with it: `'discard'` (a forced reset — remove it even when it holds dirty or
	 * unpushed work) or `'reclaim'` (a plain reset — the worker's ordinary
	 * provision-time reclaim gate, which retains anything protected).
	 */
	worktreeIntent: 'reclaim' | 'discard';
	recoveryCleared: boolean;
	/**
	 * The machine whose preserved checkout this reset gave up (issue #567), or `null`
	 * when the run was pinned to none. Reset is the operator's deliberate "abandon the
	 * preserved work and start over anywhere" action, and it is the *only* thing that
	 * ends the pinned wait — so the report says plainly which machine's work was
	 * discarded, and the run keeps that as `recovery.abandonedWorkerId`.
	 */
	abandonedPreservedWorkerId: string | null;
	/** The dispatch the phase was re-dispatched on. */
	dispatchId: string;
}

/**
 * Cancel whatever dispatch is currently active for the run. A dispatch a worker
 * claimed between our read and our write loses the conditional cancel — that is
 * a live attempt, so it aborts the reset unless the operator forced it.
 */
async function cancelActiveDispatch(
	runId: string,
	force: boolean,
): Promise<ResetRunResult['dispatch']> {
	const active = await getActiveDispatchByRunId(runId);
	if (!active) return 'none';

	// Neutral wording: the CLI will call this service too, not only the dashboard.
	const reason = `Reset & restart of run "${runId}" requested by an operator`;
	if (await cancelDispatchAndWake(active.id, reason)) return 'cancelled';

	if (!force) {
		throw new RunResetError(
			'dispatch-claimed',
			`Run "${runId}" was just picked up by a worker — refresh to see its attempt, or reset with force to cancel it.`,
		);
	}
	await cancelClaimedDispatch(active.id, reason);
	await removePendingJobById(wakeJobId(active)).catch(() => false);
	return 'force-cancelled-claimed';
}

/**
 * Reset one wedged run and re-dispatch its phase. Throws {@link RunResetError}
 * for every refusal the caller is expected to surface; anything else propagates
 * as an internal failure.
 */
export async function resetRun(
	runId: string,
	options: ResetRunOptions = {},
): Promise<ResetRunResult> {
	const force = options.force === true;

	// Every guard runs before the first mutation, so a refused reset changes nothing.
	const run = await getRunByIdFromDb(runId);
	if (!run) {
		throw new RunResetError('run-not-found', `Run with ID "${runId}" not found`);
	}
	const project = await getProjectByIdFromDb(run.projectId);
	if (!project) {
		throw new RunResetError(
			'project-not-found',
			`Cannot reset run "${runId}" — its project "${run.projectId}" no longer exists.`,
		);
	}
	if (run.status === 'running' && !force) {
		throw new RunResetError(
			'running-not-forced',
			`Run "${runId}" is still running — terminate it first, or reset with force if it is wedged.`,
		);
	}
	if (!run.jobPayload) {
		throw new RunResetError(
			'missing-job-payload',
			`Cannot reset run "${runId}" — it was created without a job payload.`,
		);
	}
	if (run.status === 'running') {
		logger.warn('run reset: forcing a live running run — its agent process may still be writing', {
			runId,
			projectId: run.projectId,
			taskId: run.taskId,
		});
	}

	const dispatch = await cancelActiveDispatch(run.id, force);

	// A stale user-termination flag would make the worker terminate the fresh
	// attempt at its start-check (issue #166); `clearRunCancellation` never throws.
	await clearRunCancellation(run.id);

	let worktree: TerminationCleanupResult;
	try {
		worktree = await reconcileTerminatedWorktree(
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
							runId,
							error: describeError(err),
						});
						return true;
					}
				},
				discardProtectedWork: force,
			},
		);
	} catch (err) {
		throw new RunResetError(
			'worktree-teardown-failed',
			`Reset of run "${runId}" stopped while tearing down its checkout: ${describeError(err)}. Its dispatch is already cancelled and its cancellation flag cleared, so resetting again after fixing the checkout is safe.`,
		);
	}

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

	// A forced reset carries its discard intent to whichever worker holds the
	// checkout (see the module header); a plain one carries none, so the worker's
	// ordinary reclaim gate applies its unchanged protections.
	const worktreeIntent: ResetRunResult['worktreeIntent'] = force ? 'discard' : 'reclaim';
	const job = reconstructRetryJob(
		run.jobPayload,
		run.id,
		run.phase,
		undefined,
		undefined,
		undefined,
		true,
		force ? 'discard' : undefined,
	);
	let dispatchId: string;
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
		dispatchId = created.dispatch.id;
	} catch (err) {
		const message = describeError(err);
		// The one-active-dispatch-per-run unique index: a concurrent reset/retry won.
		if (message.includes('uq_dispatches_active_run') || message.includes('duplicate key')) {
			throw new RunResetError(
				'already-resetting',
				`Run "${runId}" is already being restarted. Refresh to see its current status.`,
			);
		}
		throw err;
	}

	logger.info('run reset complete', {
		runId: run.id,
		projectId: run.projectId,
		taskId: run.taskId,
		phase: run.phase,
		forced: force,
		dispatch,
		worktree: worktree.outcome,
		worktreeIntent,
		abandonedPreservedWorkerId,
		dispatchId,
	});

	return {
		runId: run.id,
		forced: force,
		dispatch,
		cancellationCleared: true,
		worktree,
		worktreeIntent,
		recoveryCleared: true,
		abandonedPreservedWorkerId,
		dispatchId,
	};
}
