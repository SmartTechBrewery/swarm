/**
 * Cross-CLI session resume — the shared half of "defer a rate-limited or
 * timed-out phase and continue it later instead of re-doing its work".
 *
 * Every pipeline phase runs an agent CLI in a worktree; when that run hits a
 * usage/session limit or the wall-clock timeout, the agent may already have done
 * useful work whose reasoning lives in its CLI session (and, for the
 * implementer phases, whose partial edits live in the worktree). Rather than
 * throw both away, the worker defers the phase and retries it with the CLI's own
 * resume mechanism — `claude --resume`, `agy --conversation`, or
 * `codex exec resume` (wired per-CLI in `src/harness/agent-cli.ts`).
 *
 * This module holds the phase-side pieces every phase shares, so the six phases
 * don't each re-implement them: which failures are worth preserving for, how to
 * reuse a preserved checkout, how to thread the session id into the run, and how
 * to skip cleanup when a checkout must survive for the retry. It is CLI-agnostic
 * — the id a run created is captured into {@link AgentCliResult.sessionId} by the
 * harness for all three CLIs, so this code never special-cases one.
 *
 * It also owns both halves of Tier 2's *selection* (`docs/CHECKPOINTS.md`, issue
 * #503): the recovery gate's `'checkpoint'` branch ({@link RecoveryMode}), which
 * adopts a preserved checkout on the strength of the checkpoint file in it rather
 * than a resumable session and therefore always runs fresh, and the predicates that
 * decide when the fallback may be reached at all
 * ({@link checkpointFallbackApplies} / {@link shouldPreserveFailedCheckout}). Those
 * are written so Tier 1 keeps absolute priority: they only *add* a path for stops a
 * resumable session cannot serve.
 */

import type { AgentCliResult } from '@/harness/agent-cli.js';
import type { AgentRunError } from '@/harness/agent-failure.js';
import { logger } from '@/lib/logger.js';
import {
	type Checkpoint,
	tryReadCheckpoint,
	validateCheckpointForContinuation,
} from '@/pipeline/checkpoint.js';
import { isRunCancellationRequested } from '@/queue/cancellation.js';
import type { RecoveryMode } from '@/queue/jobs.js';
import { hasDeliveryProgress } from '@/scm/delivery.js';
import type { TriggerPhase } from '@/triggers/types.js';
import type { GitWorktreeManager, WorktreeHandle } from '@/worker/git-worktree-manager.js';

/** The session inputs every resumable phase accepts, threaded to the agent run. */
export interface PhaseSessionOptions {
	/**
	 * Session UUID to *assign* to a fresh run — only `claude` honors it
	 * (`--session-id`), so it's the worker's `runId`; codex/agy ignore it and have
	 * their id captured post-run instead.
	 */
	sessionId?: string;
	/** Existing session/thread id to *resume* (any CLI). Set on a retry, not a fresh run. */
	resumeSessionId?: string;
	/** The database run id. */
	runId?: string;
}

/**
 * Whether a failed run's worktree should be kept for a resume retry: only when
 * the failure is one the run can meaningfully continue from — a `rate-limit`
 * (quota back later) or a `timeout` (the wall-clock kill may have interrupted
 * work in progress) — *and* the run got far enough to create a session to
 * resume (its id was captured into {@link AgentCliResult.sessionId}). Every
 * other failure (a hard error, an abort, a capacity banner, an instant
 * credential failure) cleans up and retries from scratch as before.
 */
export function shouldPreserveForResume(error: AgentRunError): boolean {
	const kind = error.failure.kind;
	if (kind !== 'rate-limit' && kind !== 'timeout' && kind !== 'stalled') return false;
	return error.agent?.sessionId !== undefined;
}

/**
 * Whether Tier 2 may take over from Tier 1 for this failure
 * (`docs/CHECKPOINTS.md`). Two things must hold, and the first is Tier 1's
 * absolute priority:
 *
 * - The stop was involuntary in a way a continuation can pick up — the same
 *   `rate-limit` / `timeout` / `stalled` set {@link shouldPreserveForResume}
 *   accepts. Nothing else (a hard error, an abort, a capacity banner, a logged-out
 *   CLI) becomes a continuation.
 * - Tier 1 cannot serve it: either the run captured **no** session id, or this
 *   attempt *was* the resume of one and failed anyway — the "session expired or was
 *   pruned" case, where every CLI still reports the id it was asked to resume
 *   (`resolveSessionId`, `src/harness/agent-cli.ts`), so a present id is no longer
 *   evidence that resuming works. Re-resuming it would fail the same way; the
 *   checkpoint takes over instead of the checkout being discarded.
 *
 * A *first*, non-resume failure that did capture a session id is Tier 1's,
 * unchanged — that is the regression this ordering protects.
 */
export function checkpointFallbackApplies(
	error: AgentRunError,
	wasSessionResume: boolean,
): boolean {
	const kind = error.failure.kind;
	if (kind !== 'rate-limit' && kind !== 'timeout' && kind !== 'stalled') return false;
	return wasSessionResume || error.agent?.sessionId === undefined;
}

/**
 * Whether a failed run's worktree must be kept for a Tier 2 *checkpoint*
 * continuation: {@link checkpointFallbackApplies} holds and the checkout carries a
 * parseable checkpoint for this phase to continue from.
 *
 * Deliberately synchronous and shallow — it reads only the hand-off file. Tree
 * validation remains the continuation gate's
 * ({@link validateCheckpointForContinuation}); a phase's `finally` block must not
 * run git to decide whether to clean up. Matching the settle path's file and phase
 * predicate ensures no checkout is retained for a continuation it will decline.
 * Each implementer phase ORs this with
 * {@link shouldPreserveForResume} so the checkout survives whichever tier claims it.
 */
export function shouldPreserveForCheckpoint(
	error: AgentRunError,
	worktreePath: string,
	phase: TriggerPhase,
	wasSessionResume = false,
): boolean {
	if (!checkpointFallbackApplies(error, wasSessionResume)) return false;
	return tryReadCheckpoint(worktreePath)?.phase === phase;
}

/**
 * The whole preservation decision an *implementer* phase's failure path makes:
 * keep the checkout when either tier can continue from it. Tier 1 is asked first
 * and is untouched, so the OR only *adds* the sessionless Tier 2 case — no run
 * that resumes today stops doing so.
 *
 * `resumed` is whether this attempt re-entered an agent session (the flag
 * {@link acquireResumableWorktree} returns), which is what makes a still-present
 * session id stop counting as evidence Tier 1 works. Planning and Review keep
 * calling {@link shouldPreserveForResume} directly: neither writes a checkpoint.
 */
export function shouldPreserveFailedCheckout(
	error: AgentRunError,
	worktreePath: string,
	phase: TriggerPhase,
	resumed: boolean,
): boolean {
	return (
		shouldPreserveForResume(error) ||
		shouldPreserveForCheckpoint(error, worktreePath, phase, resumed)
	);
}

import { existsSync } from 'node:fs';
// The reclaim gate owns the structured blocked-recovery error and its reason
// union so the provision-time collision path and this recovery gate throw one
// shared type (issue #367); re-exported here for existing importers.
import { BlockedRecoveryError, type BlockedRecoveryReason } from '@/worktree/reclaim.js';
import {
	claimWorktreeLease,
	isWorktreeLeased,
	releaseWorktreeLease,
} from '@/worktree/worktree-lease.js';

export { BlockedRecoveryError };

/**
 * Resolve the checked-out branch (or the detached HEAD's SHA) of a preserved
 * checkout, so an adopted handle reports the same `branch`/`detached` pair a
 * freshly provisioned one would. Falls back to a detached `HEAD` when git cannot
 * answer — the checkout is still adoptable; only its label is unknown.
 */
async function resolveReuseHandle(
	worktrees: GitWorktreeManager,
	taskId: string,
	path: string,
): Promise<WorktreeHandle> {
	try {
		const symbolicRef = await (
			worktrees as unknown as { git: (args: string[], cwd?: string) => Promise<string> }
		).git(['symbolic-ref', '--short', '-q', 'HEAD'], path);
		const branch = symbolicRef.trim();
		if (branch) return { taskId, path, branch, detached: false };
		const headSha = await (
			worktrees as unknown as { git: (args: string[], cwd?: string) => Promise<string> }
		).git(['rev-parse', 'HEAD'], path);
		return { taskId, path, branch: headSha.trim(), detached: true };
	} catch {
		return { taskId, path, branch: 'HEAD', detached: true };
	}
}

/**
 * Release the lease this gate claimed and return the error to throw. Every mode's
 * failure path after the claim goes through here: a blocked recovery must not
 * leave the checkout marked in-use by a run that is about to settle terminally.
 * Returns rather than throws so call sites read `throw await releaseAndBlock(…)`,
 * which is what lets the compiler narrow the branch that follows.
 */
async function releaseAndBlock(
	projectId: string,
	taskId: string,
	reason: BlockedRecoveryReason,
	message: string,
): Promise<BlockedRecoveryError> {
	await releaseWorktreeLease(projectId, taskId);
	return new BlockedRecoveryError(reason, message);
}

/**
 * The `'fresh'` branch: discard the checkout so the retry starts over — but only
 * once it is provably safe to, which is to say it holds neither uncommitted
 * changes nor unpushed commits.
 */
async function reclaimForFreshRetry(
	worktrees: GitWorktreeManager,
	taskId: string,
	projectId: string,
	path: string,
): Promise<void> {
	if (!(await worktrees.isClean(taskId)))
		throw await releaseAndBlock(
			projectId,
			taskId,
			'dirty',
			`Worktree for task '${taskId}' has uncommitted changes.`,
		);
	if (await worktrees.hasUnpushedWork(taskId))
		throw await releaseAndBlock(
			projectId,
			taskId,
			'unpushed',
			`Worktree for task '${taskId}' has unpushed commits.`,
		);

	logger.info(
		'recovery: worktree is clean and has no unpushed work — removing it for fresh retry',
		{ taskId, path },
	);
	await worktrees.cleanup(taskId);
}

/**
 * The `'checkpoint'` branch (Tier 2, `docs/CHECKPOINTS.md`): there is no session
 * to re-enter, so the checkpoint file left in the checkout *is* the hand-off.
 * Adopt the checkout only once that file proves it describes this phase and the
 * tree actually on disk.
 */
async function adoptCheckpointContinuation(
	worktrees: GitWorktreeManager,
	taskId: string,
	projectId: string,
	path: string,
	phase: TriggerPhase,
): Promise<{ reuseHandle: WorktreeHandle; checkpoint: Checkpoint }> {
	const validation = await validateCheckpointForContinuation(path, phase);
	if (!validation.valid)
		throw await releaseAndBlock(
			projectId,
			taskId,
			validation.reason,
			`Cannot continue task '${taskId}' (${phase}) from a checkpoint — ${validation.detail}.`,
		);
	return {
		reuseHandle: await resolveReuseHandle(worktrees, taskId, path),
		checkpoint: validation.checkpoint,
	};
}

/**
 * Decide whether `phase` may adopt the preserved `task-<id>` checkout, and under
 * which contract. Returns the handle to adopt (or `null` to provision afresh),
 * plus — for a `'checkpoint'` continuation — the validated checkpoint the caller
 * seeds the agent's prompt from.
 *
 * `phase` is what a `'checkpoint'` continuation validates the checkpoint against:
 * a task's checkout is reused across phases, so the file must name the phase about
 * to adopt it.
 */
export async function executeRecoveryGate(
	worktrees: GitWorktreeManager,
	taskId: string,
	recoveryMode: RecoveryMode | undefined,
	expectedSessionId: string | undefined,
	projectId: string,
	phase: TriggerPhase,
): Promise<{ reuseHandle: WorktreeHandle | null; checkpoint?: Checkpoint }> {
	const path = worktrees.worktreePath(taskId);
	const exists = existsSync(path);

	if (!exists) {
		if (recoveryMode === 'resume') {
			throw new BlockedRecoveryError(
				'missing-validation',
				`Cannot resume task '${taskId}' — worktree checkout does not exist.`,
			);
		}
		if (recoveryMode === 'checkpoint') {
			throw new BlockedRecoveryError(
				'missing-validation',
				`Cannot continue task '${taskId}' from a checkpoint — worktree checkout does not exist.`,
			);
		}
		return { reuseHandle: null };
	}

	const leased = await isWorktreeLeased(projectId, taskId);
	if (leased && !recoveryMode) {
		throw new BlockedRecoveryError(
			'live-leased',
			`Worktree for task '${taskId}' is leased by a live run.`,
		);
	}

	await claimWorktreeLease(projectId, taskId);

	if (recoveryMode === 'resume') {
		if (!expectedSessionId)
			throw await releaseAndBlock(
				projectId,
				taskId,
				'missing-validation',
				`Cannot resume task '${taskId}' — missing expected session ID.`,
			);
		return { reuseHandle: await resolveReuseHandle(worktrees, taskId, path) };
	}

	if (recoveryMode === 'checkpoint')
		return adoptCheckpointContinuation(worktrees, taskId, projectId, path, phase);

	if (recoveryMode === 'fresh') await reclaimForFreshRetry(worktrees, taskId, projectId, path);

	return { reuseHandle: null };
}

/**
 * Acquire a phase's worktree, reusing a preserved checkout for either an agent
 * session retry or a delivery retry. Delivery reuse additionally requires its
 * progress sidecar, so an unrelated stale checkout is never adopted. `resumed`
 * reports whether an agent *session* was resumed; `deliveryResumed` reports a
 * verified deterministic-delivery continuation; `checkpoint` is set only for a
 * `'checkpoint'` continuation, which resumes no session (`resumed: false`) and
 * carries its hand-off in the returned checkpoint instead.
 */
export async function acquireResumableWorktree(
	worktrees: GitWorktreeManager,
	taskId: string,
	phase: TriggerPhase,
	reuseBranch: string,
	reuseDetached: boolean,
	resumeSessionId: string | undefined,
	provisionFresh: () => Promise<WorktreeHandle>,
	resumeDelivery = false,
	recoveryMode?: RecoveryMode,
	projectId?: string,
): Promise<{
	handle: WorktreeHandle;
	resumed: boolean;
	deliveryResumed: boolean;
	checkpoint?: Checkpoint;
}> {
	if (recoveryMode) {
		const { reuseHandle, checkpoint } = await executeRecoveryGate(
			worktrees,
			taskId,
			recoveryMode,
			resumeSessionId,
			projectId ?? (worktrees as unknown as { project: { id: string } }).project.id,
			phase,
		);
		if (reuseHandle) {
			return {
				handle: reuseHandle,
				resumed: recoveryMode !== 'checkpoint',
				deliveryResumed: false,
				checkpoint,
			};
		}
	}

	const reused = resumeDelivery
		? await worktrees.reuse(taskId, reuseBranch, reuseDetached, hasDeliveryProgress)
		: resumeSessionId
			? await worktrees.reuse(taskId, reuseBranch, reuseDetached)
			: undefined;
	if (reused)
		return {
			handle: reused,
			resumed: resumeSessionId !== undefined,
			deliveryResumed: resumeDelivery,
		};
	return { handle: await provisionFresh(), resumed: false, deliveryResumed: false };
}

/**
 * The `sessionId`/`resumeSessionId` to hand a single agent run: resume the prior
 * session when its checkout was reused, otherwise assign a fresh id. Never both
 * — a run either continues an existing session or starts a new one.
 *
 * A `'checkpoint'` continuation is the third case, and it is unconditional: it
 * carries **no** resume id and always gets a fresh `sessionId`, because its
 * hand-off is the checkpoint file rather than a CLI session. That is also what
 * makes it CLI-agnostic — the continuation may run on a different engine than the
 * deferred run did, so there is no session it *could* re-enter.
 */
export function sessionRunArgs(
	session: PhaseSessionOptions,
	resumed: boolean,
	recoveryMode?: RecoveryMode,
): PhaseSessionOptions {
	if (recoveryMode === 'checkpoint')
		return { sessionId: session.sessionId, resumeSessionId: undefined };
	return {
		sessionId: resumed ? undefined : session.sessionId,
		resumeSessionId: resumed ? session.resumeSessionId : undefined,
	};
}

export async function cleanupUnlessPreserved(
	worktrees: GitWorktreeManager,
	taskId: string,
	preserveForResume: boolean,
	phaseName: string,
	runId?: string,
): Promise<void> {
	try {
		const isCancelled = runId ? await isRunCancellationRequested(runId) : false;
		if (preserveForResume || isCancelled) {
			logger.debug(`${phaseName}: preserving worktree for agent session resume`, { taskId, runId });
			return;
		}
		await worktrees.cleanup(taskId);
	} catch (error) {
		logger.error(`${phaseName}: worktree cleanup failed`, {
			taskId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Re-export for phases that annotate their captured result. */
export type { AgentCliResult };
