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
 * harness for all three CLIs, so this code never special-cases one. Where a CLI
 * difference does bear on the decision ({@link repairSessionId}, which may only
 * offer an *assigned* id to a CLI that accepts one), it asks the harness rather
 * than naming a CLI itself.
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

import {
	type AgentCli,
	type AgentCliResult,
	acceptsAssignedSessionId,
} from '@/harness/agent-cli.js';
import type { AgentRunError } from '@/harness/agent-failure.js';
import { logger } from '@/lib/logger.js';
import {
	type Checkpoint,
	tryReadCheckpoint,
	validateCheckpointForContinuation,
} from '@/pipeline/checkpoint.js';
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

export { BlockedRecoveryError };

/**
 * Resolve the `branch`/`detached` pair for a preserved checkout, so an adopted
 * handle reports what a freshly provisioned one would.
 *
 * **`branch` is the caller's, not git's.** Since issue #558 a checkout can be
 * detached while still *targeting* a branch — provisioning detaches at
 * `origin/<branch>` when another worktree holds the ref — and delivery pushes
 * `<sha>:refs/heads/<handle.branch>`. Reading the label back out of git would
 * answer with the head SHA for exactly those checkouts, so a resumed Implementation
 * would push a branch named after a commit and its adoption probe would look for a
 * PR on that name. The caller always knows the branch it means (`reuseBranch`, or
 * the task branch for Implementation); only *whether* the checkout ended up
 * detached has to be asked of git, because provisioning may have decided that on
 * its own.
 */
async function resolveReuseHandle(
	worktrees: GitWorktreeManager,
	taskId: string,
	path: string,
	branch: string,
): Promise<WorktreeHandle> {
	try {
		const symbolicRef = await (
			worktrees as unknown as { git: (args: string[], cwd?: string) => Promise<string> }
		).git(['symbolic-ref', '--short', '-q', 'HEAD'], path);
		return { taskId, path, branch, detached: symbolicRef.trim() === '' };
	} catch {
		// Git could not answer; the checkout is still adoptable and the branch it
		// targets is the caller's premise either way.
		return { taskId, path, branch, detached: true };
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
	worktrees: GitWorktreeManager,
	taskId: string,
	reason: BlockedRecoveryReason,
	message: string,
): Promise<BlockedRecoveryError> {
	await worktrees.releaseLease(taskId);
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
	path: string,
): Promise<void> {
	if (!(await worktrees.isClean(taskId)))
		throw await releaseAndBlock(
			worktrees,
			taskId,
			'dirty',
			`Worktree for task '${taskId}' has uncommitted changes.`,
		);
	if (await worktrees.hasUnpushedWork(taskId))
		throw await releaseAndBlock(
			worktrees,
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
 * The `'discard'` branch (issue #592): the operator forced a reset, so the
 * checkout goes regardless of what it holds. This is the *only* path that removes
 * uncommitted changes or unpushed commits without asking — `'fresh'` above still
 * refuses both — and it exists because a `force` reset issued on the control plane
 * has no other way to reach a checkout on a different worker: the intent travels
 * on the replacement dispatch and is honoured here, by the host that actually
 * holds the directory.
 *
 * Logged at `warn` naming the task and the path, mirroring `termination-cleanup.ts`'s
 * discard logging, so destroyed work is always attributable to a request.
 */
async function discardCheckout(
	worktrees: GitWorktreeManager,
	taskId: string,
	path: string,
): Promise<void> {
	logger.warn(
		'recovery: discarding the preserved checkout on operator request — reset with force',
		{
			taskId,
			path,
		},
	);
	await worktrees.cleanup(taskId);
}

/**
 * The `'checkpoint'` branch (Tier 2, `docs/CHECKPOINTS.md`): there is no session
 * to re-enter, so the checkpoint file left in the checkout *is* the hand-off.
 * Adopt the checkout only once that file proves it describes this phase and the
 * tree actually on disk.
 *
 * `branch` reaches the guard as well as the adopted handle: a divergence reports
 * whether a git stash on the task's branch holds the work the tree is missing
 * (issue #705), and the branch it means is the caller's premise for the same
 * reason {@link resolveReuseHandle} takes it rather than asking git.
 */
async function adoptCheckpointContinuation(
	worktrees: GitWorktreeManager,
	taskId: string,
	path: string,
	phase: TriggerPhase,
	branch: string,
): Promise<{ reuseHandle: WorktreeHandle; checkpoint: Checkpoint }> {
	const validation = await validateCheckpointForContinuation(path, phase, branch);
	if (!validation.valid)
		throw await releaseAndBlock(
			worktrees,
			taskId,
			validation.reason,
			`Cannot continue task '${taskId}' (${phase}) from a checkpoint — ${validation.detail}.`,
		);
	return {
		reuseHandle: await resolveReuseHandle(worktrees, taskId, path, branch),
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
	phase: TriggerPhase,
	/** The branch the adopted checkout targets — see {@link resolveReuseHandle}. */
	branch: string,
): Promise<{ reuseHandle: WorktreeHandle | null; checkpoint?: Checkpoint }> {
	const path = worktrees.worktreePath(taskId);
	const exists = existsSync(path);

	if (!exists) {
		// "on this worker" because that is the operator's actual next question: a
		// retry can be routed to a different host than the one holding the checkout
		// (Planning is affinity-exempt — see ai/ARCHITECTURE.md), so "pruned" and
		// "ran somewhere else" are different problems with the same symptom.
		if (recoveryMode === 'resume') {
			throw new BlockedRecoveryError(
				'missing-validation',
				`Cannot resume task '${taskId}' — worktree checkout does not exist on this worker.`,
			);
		}
		if (recoveryMode === 'checkpoint') {
			throw new BlockedRecoveryError(
				'missing-validation',
				`Cannot continue task '${taskId}' from a checkpoint — worktree checkout does not exist on this worker.`,
			);
		}
		return { reuseHandle: null };
	}

	const leased = await worktrees.isLeased(taskId);
	if (leased && !recoveryMode) {
		throw new BlockedRecoveryError(
			'live-leased',
			`Worktree for task '${taskId}' is leased by a live run.`,
		);
	}

	await worktrees.claimLease(taskId);

	if (recoveryMode === 'resume') {
		if (!expectedSessionId)
			throw await releaseAndBlock(
				worktrees,
				taskId,
				'missing-validation',
				`Cannot resume task '${taskId}' — missing expected session ID.`,
			);
		return { reuseHandle: await resolveReuseHandle(worktrees, taskId, path, branch) };
	}

	if (recoveryMode === 'checkpoint')
		return adoptCheckpointContinuation(worktrees, taskId, path, phase, branch);

	if (recoveryMode === 'fresh') await reclaimForFreshRetry(worktrees, taskId, path);
	if (recoveryMode === 'discard') await discardCheckout(worktrees, taskId, path);

	return { reuseHandle: null };
}

/**
 * Say so, loudly, when a phase is about to start over on a task whose previous
 * attempt left work behind (issue #591).
 *
 * Falling through to `provisionFresh()` while a preserved checkout — or a
 * checkpoint inside it — still exists is how a continuation gets lost with no
 * signal at all: the intent that would have adopted it was dropped somewhere
 * upstream, the checkout is either reclaimed or reported as a generic collision,
 * and the run silently re-does work it had already done. Nothing here changes what
 * happens; it makes a lost continuation attributable to the task, phase and run it
 * happened to, instead of surfacing three layers away as a worktree error.
 *
 * Deliberately not a throw: an unrequested start-over is legal (a fresh dispatch
 * for a task whose old checkout is still lying around). An *explicitly* requested
 * recovery that cannot be served still fails terminally in the gate above, and
 * that stays the correct outcome.
 *
 * **Two levels, because a directory existing is weaker evidence than a hand-off.**
 * All this can see synchronously is whether the path is there — which a plain
 * stale leftover from a completed run also satisfies, and warning on those would
 * dilute exactly the signal this exists to sharpen. A **checkpoint** is different:
 * it is an explicit hand-off some continuation was supposed to adopt, so its
 * presence here means one was definitively lost. That case warns, which is what
 * makes "a lost continuation is always attributable" (issue #591's stated purpose)
 * true; a checkout with no hand-off is recorded at `info` instead.
 */
export function warnStartingOverOnPreservedWork(
	worktrees: GitWorktreeManager,
	taskId: string,
	phase: TriggerPhase,
	runId: string | undefined,
): void {
	const path = worktrees.worktreePath(taskId);
	if (!existsSync(path)) return;
	const checkpoint = tryReadCheckpoint(path);
	const context = {
		taskId,
		phase,
		runId,
		worktreePath: path,
		hasCheckpoint: checkpoint !== undefined,
		checkpointPhase: checkpoint?.phase,
	};
	if (checkpoint) {
		logger.warn(
			'recovery: starting over while a checkpointed checkout still exists — the recorded hand-off is not being continued',
			context,
		);
		return;
	}
	logger.info(
		'recovery: starting over while a preserved checkout still exists — any work in it is not being continued',
		context,
	);
}

/**
 * Acquire a phase's worktree, reusing a preserved checkout for either an agent
 * session retry or a delivery retry. Delivery reuse additionally requires its
 * progress sidecar, so an unrelated stale checkout is never adopted. `resumed`
 * reports whether an agent *session* was resumed; `deliveryResumed` reports a
 * verified deterministic-delivery continuation; `checkpoint` is set only for a
 * `'checkpoint'` continuation, which resumes no session (`resumed: false`) and
 * carries its hand-off in the returned checkpoint instead.
 *
 * `runId` is carried for the start-over warning alone
 * ({@link warnStartingOverOnPreservedWork}); the provisioning call the caller
 * passes in threads its own.
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
	runId?: string,
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
			phase,
			reuseBranch,
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
	warnStartingOverOnPreservedWork(worktrees, taskId, phase, runId);
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

/**
 * The session a *second* run against the same worktree may resume — a phase's
 * repair pass, re-running the agent against a validator's own complaint.
 *
 * Three candidates, in order: the id the first run actually reported
 * ({@link AgentCliResult.sessionId}, captured per CLI by the harness), then the
 * id this phase resumed with, and — only on a CLI that accepts one
 * ({@link acceptsAssignedSessionId}) — the id SWARM *assigned*. An assigned id
 * on a self-minting CLI names a session that harness never created, so offering
 * it does not continue the review, it kills the pass: `codex exec resume` exits
 * 1 on "no rollout found for thread id" without reaching the model (issue #865).
 *
 * `undefined` therefore means "run the pass, but do not resume": the hand-off to
 * repair and the checkout its evidence came from are both still on disk, so the
 * pass is not wasted, and a fresh session is strictly better than a resume
 * certain to be refused.
 */
export function repairSessionId(
	cli: AgentCli,
	agent: AgentCliResult,
	session: PhaseSessionOptions,
	resumed: boolean,
): string | undefined {
	if (agent.sessionId) return agent.sessionId;
	if (resumed) return session.resumeSessionId;
	return acceptsAssignedSessionId(cli) ? session.sessionId : undefined;
}

export async function cleanupUnlessPreserved(
	worktrees: GitWorktreeManager,
	taskId: string,
	preserveForResume: boolean,
	phaseName: string,
	runId?: string,
): Promise<void> {
	// Bracketed by logs because this runs in the phase's `finally`, *after* the last
	// board write and *before* the worker reports its result — so on a phase that
	// completed its delivery and then never reported, the pair "entering"/"done" is
	// what distinguishes a phase still stuck in here from one that returned and
	// failed to send. Both are `debug`: this is a per-run, per-phase pair, not noise
	// worth promoting.
	logger.debug(`${phaseName}: settling the worktree`, { taskId, runId, preserveForResume });
	try {
		const isCancelled = runId ? await worktrees.isCancellationRequested(runId) : false;
		if (preserveForResume || isCancelled) {
			logger.debug(`${phaseName}: preserving worktree for agent session resume`, { taskId, runId });
			await worktrees.preserve(taskId, runId);
			return;
		}
		await worktrees.cleanup(taskId);
		logger.debug(`${phaseName}: worktree settled`, { taskId, runId });
	} catch (error) {
		logger.error(`${phaseName}: worktree cleanup failed`, {
			taskId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Re-export for phases that annotate their captured result. */
export type { AgentCliResult };
