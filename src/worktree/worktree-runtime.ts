/**
 * Store-facing operations behind the git-worktree lifecycle. The default
 * runtime keeps the existing Redis/Postgres behaviour; a DB-free worker injects
 * a host-local runtime instead, so importing or constructing the manager does
 * not itself reach either store.
 */

export interface WorktreeRuntime {
	claim(projectId: string, taskId: string, token?: string): Promise<void>;
	tryClaim(projectId: string, taskId: string, token?: string): Promise<boolean>;
	release(projectId: string, taskId: string, token?: string): Promise<void>;
	read(projectId: string, taskId: string): Promise<string | null>;
	takeOver(
		projectId: string,
		taskId: string,
		expectedToken: string,
		token: string,
	): Promise<boolean>;
	isLeased(projectId: string, taskId: string): Promise<boolean>;
	hasLiveOwner(projectId: string, taskId: string, runId?: string): Promise<boolean>;
	isResumablePinned(projectId: string, taskId: string): Promise<boolean>;
	isCancellationRequested(runId: string): Promise<boolean>;
	/** Preserve a checkout for a retry. Store-backed leases already remain held. */
	preserve(projectId: string, taskId: string, runId?: string): Promise<void>;
	/** Drop host-local preservation metadata once no checkout remains to protect. */
	clearPreservation(projectId: string, taskId: string): Promise<void>;
}

/**
 * Existing same-host runtime. Dynamic imports are deliberate: the DB-free
 * executor imports `GitWorktreeManager`, but never loads or calls the modules
 * that own Redis/Postgres unless it selects this default runtime.
 */
export const storeBackedWorktreeRuntime: WorktreeRuntime = {
	async claim(projectId, taskId, token) {
		const { claimWorktreeLease } = await import('./worktree-lease.js');
		if (token === undefined) await claimWorktreeLease(projectId, taskId);
		else await claimWorktreeLease(projectId, taskId, token);
	},
	async tryClaim(projectId, taskId, token) {
		const { tryClaimWorktreeLease } = await import('./worktree-lease.js');
		return tryClaimWorktreeLease(projectId, taskId, token);
	},
	async release(projectId, taskId, token) {
		const { releaseWorktreeLease } = await import('./worktree-lease.js');
		if (token === undefined) await releaseWorktreeLease(projectId, taskId);
		else await releaseWorktreeLease(projectId, taskId, token);
	},
	async read(projectId, taskId) {
		const { readWorktreeLease } = await import('./worktree-lease.js');
		return readWorktreeLease(projectId, taskId);
	},
	async takeOver(projectId, taskId, expectedToken, token) {
		const { takeOverWorktreeLease } = await import('./worktree-lease.js');
		return takeOverWorktreeLease(projectId, taskId, expectedToken, token);
	},
	async isLeased(projectId, taskId) {
		const { isWorktreeLeased } = await import('./worktree-lease.js');
		return isWorktreeLeased(projectId, taskId);
	},
	async hasLiveOwner(projectId, taskId, runId) {
		const { hasLiveWorktreeLeaseOwner } = await import('./lease-liveness.js');
		return hasLiveWorktreeLeaseOwner(projectId, taskId, runId);
	},
	async isResumablePinned(projectId, taskId) {
		const { hasResumableDeferredRun } = await import('../db/repositories/runsRepository.js');
		return hasResumableDeferredRun(projectId, taskId);
	},
	async isCancellationRequested(runId) {
		const { isRunCancellationRequested } = await import('../queue/cancellation.js');
		return isRunCancellationRequested(runId);
	},
	async preserve() {
		// The existing Redis lease remains held until its TTL or a retry adopts it.
	},
	async clearPreservation() {},
};
