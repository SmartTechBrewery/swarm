/**
 * The single worktree-reclamation gate (issue #367).
 *
 * Before a new phase treats an existing `task-<id>` checkout as a blocking
 * collision — or a background retention sweep prunes one — SWARM must decide
 * whether that checkout is *safe* to discard. It is safe only when nothing else
 * depends on it: it is not leased by a live run, not pinned by a resumable
 * deferred/failed run, has no uncommitted changes, and has no local commits that
 * were never pushed. Every one of those checks **fails closed** (an error, or an
 * un-resolvable state, counts as "protected"), so an uncertain gate preserves
 * work rather than risking its loss.
 *
 * Both the provision-time collision path (`GitWorktreeManager.provision`) and the
 * retention sweep (`pruneStaleWorktrees`) run through {@link evaluateWorktreeReclaim}
 * so the ordered checks — and the reasons they surface — stay identical.
 */

import { hasResumableDeferredRun } from '../db/repositories/runsRepository.js';
import { isWorktreeLeased } from './worktree-lease.js';

/**
 * Why a preserved checkout may not be discarded. Persisted verbatim onto
 * `runs.recovery.blockedReason` (`src/db/schema/runs.ts`) so the dashboard can
 * render the exact recovery guidance; keep the two unions in sync.
 *
 * - `live-leased` — a live run currently holds the worktree lease.
 * - `resumable-owner` — a deferred/failed run intends to resume this checkout.
 * - `dirty` — the checkout has uncommitted changes (tracked or untracked).
 * - `unpushed` — the checkout has local commits that were never pushed.
 * - `missing-validation` — a recovery precondition (checkout, session id, checkpoint file) is absent.
 * - `checkpoint-divergent` — a checkpoint continuation's checkpoint does not describe a
 *   state this phase can continue from: it does not parse, it names another phase, or it
 *   no longer matches the working tree on disk (`validateCheckpointForContinuation`,
 *   `src/pipeline/checkpoint.ts`).
 */
export type BlockedRecoveryReason =
	| 'dirty'
	| 'unpushed'
	| 'live-leased'
	| 'missing-validation'
	| 'resumable-owner'
	| 'checkpoint-divergent';

/** Thrown when a worktree cannot be safely reclaimed and the phase must settle terminally. */
export class BlockedRecoveryError extends Error {
	constructor(
		readonly reason: BlockedRecoveryReason,
		message: string,
	) {
		super(message);
		this.name = 'BlockedRecoveryError';
	}
}

/**
 * The subset of {@link BlockedRecoveryReason}s the reclaim gate itself can return.
 * `missing-validation` and `checkpoint-divergent` are recovery-gate-only reasons —
 * both describe a *requested* recovery whose preconditions failed, which is not
 * something a reclaim decision about an existing checkout can conclude.
 */
export type ReclaimBlockedReason = Exclude<
	BlockedRecoveryReason,
	'missing-validation' | 'checkpoint-divergent'
>;

/**
 * The gate's verdict: either the checkout is safe to reclaim, or it is protected
 * by a specific, human-describable reason.
 */
export type ReclaimDecision =
	| { safe: true }
	| { safe: false; reason: ReclaimBlockedReason; detail: string };

/** The worktree operations the gate needs — a structural subset of `GitWorktreeManager` (avoids a value import cycle). */
export interface WorktreeSafetyChecker {
	isClean(taskId: string): Promise<boolean>;
	hasUnpushedWork(taskId: string): Promise<boolean>;
}

/** Injectable lookups for the reclaim gate; both default to the real implementations. */
export interface ReclaimGateDeps {
	/** Whether the task's worktree is currently leased by a live run. */
	isLeased?: (projectId: string, taskId: string) => Promise<boolean>;
	/** Whether a resumable deferred/failed run pins the task's checkout. */
	isResumablePinned?: (projectId: string, taskId: string) => Promise<boolean>;
}

/**
 * Run the ordered fail-closed safety checks and return a typed reclaim decision.
 * The order is deliberate — lease → resumable ownership → cleanliness → unpushed
 * commits — so the most authoritative "someone is using this right now" signal
 * wins before the cheaper content checks, and the first protection encountered is
 * the one reported.
 */
export async function evaluateWorktreeReclaim(
	worktrees: WorktreeSafetyChecker,
	projectId: string,
	taskId: string,
	deps: ReclaimGateDeps = {},
): Promise<ReclaimDecision> {
	const isLeased = deps.isLeased ?? isWorktreeLeased;
	const isResumablePinned = deps.isResumablePinned ?? hasResumableDeferredRun;

	if (await isLeased(projectId, taskId)) {
		return { safe: false, reason: 'live-leased', detail: 'is leased by a live run' };
	}
	if (await isResumablePinned(projectId, taskId)) {
		return {
			safe: false,
			reason: 'resumable-owner',
			detail: 'is pinned by a resumable deferred/failed run',
		};
	}
	// isClean/hasUnpushedWork both fail closed internally (dirty / has-unpushed on error).
	if (!(await worktrees.isClean(taskId))) {
		return { safe: false, reason: 'dirty', detail: 'has uncommitted changes' };
	}
	if (await worktrees.hasUnpushedWork(taskId)) {
		return { safe: false, reason: 'unpushed', detail: 'has unpushed commits' };
	}
	return { safe: true };
}
