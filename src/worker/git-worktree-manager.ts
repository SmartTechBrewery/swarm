/**
 * Provisions and tears down the per-task git worktrees SWARM runs agents inside
 * (PROJECT.md §4, ai/ARCHITECTURE.md "Worktree lifecycle"). Each task gets an
 * isolated checkout under `<repoRoot>/<worktreeRoot>/task-<id>/` so the automated
 * agent and the human developer can work the same repository at once without
 * stepping on each other's index — the worktree shares the main repo's `.git`, so
 * creation is near-instant and costs no network.
 *
 * Scope (SWARM-14): the git worktree add/remove lifecycle plus the sanity-check +
 * fetch that precede it (§4.2 steps 1, 2, 5). Environment grafting — symlinking
 * `node_modules`, `.env`, and build caches into the worktree (§4.2 step 3) — is a
 * separate task (SWARM-15); `provision` exposes a seam for it (see the note there)
 * rather than implementing it here.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from '../config/schema.js';
import { logger } from '../lib/logger.js';
import { hasLiveWorktreeLeaseOwner } from '../worktree/lease-liveness.js';
import { BlockedRecoveryError, evaluateWorktreeReclaim } from '../worktree/reclaim.js';
import {
	claimWorktreeLease,
	readWorktreeLease,
	releaseWorktreeLease,
	takeOverWorktreeLease,
	tryClaimWorktreeLease,
} from '../worktree/worktree-lease.js';

const execFileAsync = promisify(execFile);

/**
 * Canonicalize a path for equality comparison. `git worktree list --porcelain`
 * reports realpaths (symlinks resolved), so plain `resolve` on our side can miss
 * a match when a component is symlinked (classic case: macOS `/tmp` →
 * `/private/tmp`) — which would leak the main checkout into `list()`. Falls back
 * to `resolve` for a path that doesn't exist on disk yet.
 */
function canonicalize(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/**
 * Actionable text for a blocked collision — names why the existing checkout is
 * protected and how an operator resolves it, so the reason reaches the run row,
 * the board/PR comment, and the logs rather than an opaque "already exists".
 */
function collisionMessage(taskId: string, path: string, detail: string): string {
	return (
		`Worktree collision for task '${taskId}' at ${path}: the existing checkout ${detail}, ` +
		'so SWARM will not reclaim it automatically. Inspect it, push or discard any work, then ' +
		'remove it (`git worktree remove` or `swarm worktrees prune`) before re-running.'
	);
}

/** A provisioned worktree — the handle callers hold onto for the task's lifetime. */
export interface WorktreeHandle {
	/** The task identifier this worktree was provisioned for (usually the issue number). */
	taskId: string;
	/** Absolute path to the worktree checkout. */
	path: string;
	/**
	 * The branch checked out in the worktree. For a `detach`ed worktree there is no
	 * branch — this holds the ref the detached HEAD was placed at (the base branch).
	 */
	branch: string;
	/** True when the worktree is in detached HEAD (see {@link ProvisionOptions.detach}). */
	detached: boolean;
}

/** Options for {@link GitWorktreeManager.provision}. */
export interface ProvisionOptions {
	/**
	 * Branch to check out in the worktree. Defaults to `<branchPrefix><taskId>`
	 * (SWARM's `issue-<n>` convention, from the project config) when creating a
	 * branch; **required** when `createBranch` is false (there's no sensible
	 * default for an existing checkout target).
	 */
	branch?: string;
	/**
	 * When true (the default), cut `branch` fresh off `baseBranch` — the
	 * implementation-phase flow. When false, check out an existing `branch` (e.g.
	 * a PR branch for the review / respond-to-review phases).
	 */
	createBranch?: boolean;
	/** Ref the new branch is cut from when `createBranch` is true. Defaults to the project's `baseBranch`. */
	baseBranch?: string;
	/**
	 * Check out `baseBranch` in **detached HEAD** instead of on a branch — for a
	 * read-only phase (Planning: explore the code, write `proposed_plan.md`, throw
	 * the checkout away) that must not create or hold a task branch. It sidesteps
	 * two problems a branch would cause here: `git worktree add <path> main` refuses
	 * because `main` is already checked out in the primary tree, and cutting a fresh
	 * `issue-<n>` branch would both collide with the implementation phase (which
	 * wants that branch) and leave an orphan branch that breaks a re-run. Detached
	 * HEAD claims no branch, so cleanup is just `worktree remove` with nothing to
	 * delete. Takes precedence over `createBranch`; `branch` is ignored when set.
	 */
	detach?: boolean;
	/**
	 * Run `git fetch origin` before creating the worktree so the branch is cut
	 * from up-to-date refs (§4.2 step 1). Defaults to true; the fetch is
	 * best-effort — a failure (e.g. no remote yet) is logged, not fatal.
	 */
	fetch?: boolean;
	/**
	 * The run this provisioning belongs to. Used only by the collision gate, to
	 * tell a lease held by a *different* live run from an orphan left behind by a
	 * crashed or already-settled one — including this run's own dead previous
	 * attempt (issue #427). Omitting it keeps the strictly fail-closed behaviour:
	 * any held lease blocks.
	 */
	runId?: string;
}

/** Manages the git-worktree lifecycle for one SWARM project. Construct one per project. */
export class GitWorktreeManager {
	constructor(private readonly project: ProjectConfig) {}

	/** Absolute path to the worktree for `taskId` — `<repoRoot>/<worktreeRoot>/task-<id>` (§4.1). */
	worktreePath(taskId: string): string {
		return resolve(this.project.repoRoot, this.project.worktreeRoot, `task-${taskId}`);
	}

	/** Reclaim an existing preserved checkout, or return undefined when it is gone. */
	async reuse(
		taskId: string,
		branch: string,
		detached: boolean,
		isReusable?: (path: string) => boolean,
	): Promise<WorktreeHandle | undefined> {
		const path = this.worktreePath(taskId);
		if (!existsSync(path)) return undefined;
		if (isReusable && !isReusable(path)) return undefined;
		await claimWorktreeLease(this.project.id, taskId);
		return { taskId, path, branch, detached };
	}

	/**
	 * Provision an isolated worktree for `taskId` and return its handle.
	 *
	 * Throws if the project's `repoRoot` isn't a git repository. When a worktree
	 * for this task already exists, {@link reclaimStaleCheckout} decides its fate:
	 * a safe stale checkout (unleased, unpinned, clean, no unpushed commits) is
	 * removed and provisioning continues under a held lease; anything protected
	 * throws {@link BlockedRecoveryError} so the run settles terminally instead of
	 * clobbering work.
	 *
	 * A lease that is held but has **no live owner** — a crashed or already-settled
	 * run never released it — is taken over rather than treated as `live-leased`
	 * (issue #427); the checkout behind it then goes through the very same reclaim
	 * gate, so dirty/unpushed/pinned work is still retained, never force-removed.
	 */
	async provision(taskId: string, options: ProvisionOptions = {}): Promise<WorktreeHandle> {
		await this.assertGitRepo();

		if (options.fetch !== false) {
			await this.fetch();
		}

		const path = this.worktreePath(taskId);
		const leaseToken = randomUUID();
		const acquired = await this.acquireProvisionLease(taskId, leaseToken, options.runId);
		if (!acquired) {
			throw new BlockedRecoveryError(
				'live-leased',
				collisionMessage(taskId, path, 'is leased by a live run'),
			);
		}

		let reclaimedBranch: string | null = null;
		try {
			if (existsSync(path)) {
				try {
					const branchName = (
						await this.git(['symbolic-ref', '--short', '-q', 'HEAD'], path)
					).trim();
					if (branchName) {
						reclaimedBranch = branchName;
					}
				} catch {
					// detached HEAD or other error, leave it null
				}

				const decision = await evaluateWorktreeReclaim(this, this.project.id, taskId, {
					isLeased: async () => false,
				});
				if (!decision.safe) {
					throw new BlockedRecoveryError(
						decision.reason,
						collisionMessage(taskId, path, decision.detail),
					);
				}
				logger.info('worktree collision: reclaiming safe stale checkout', { taskId, path });
				await this.removeWorktreeCheckout(path);
			}

			if (reclaimedBranch) {
				try {
					await this.git(['branch', '-D', reclaimedBranch]);
				} catch (_err) {
					// Ignore failures to delete the branch (e.g. if it didn't exist or was already deleted)
				}
			}

			return await this.createFreshWorktree(taskId, path, options, leaseToken);
		} catch (err) {
			await releaseWorktreeLease(this.project.id, taskId, leaseToken);
			throw err;
		}
	}

	/**
	 * Hold the task lease under `token` for the duration of a provision, or report
	 * that someone else legitimately owns it.
	 *
	 * The plain `SET NX` claim is tried first, so the uncontended and the genuinely
	 * contended cases behave exactly as they did before #427. Only when that fails
	 * does this ask whether the lease still *has* an owner: with a live run or an
	 * executing dispatch for the task, it blocks as before; with none, the lease is
	 * an orphan and is adopted by compare-and-set against the token actually
	 * observed — so a provisioner that claimed it in between still wins the race and
	 * this caller blocks instead. Every uncertain outcome returns `false`.
	 */
	private async acquireProvisionLease(
		taskId: string,
		token: string,
		runId?: string,
	): Promise<boolean> {
		if (await tryClaimWorktreeLease(this.project.id, taskId, token)) return true;
		if (await hasLiveWorktreeLeaseOwner(this.project.id, taskId, runId)) return false;

		const staleToken = await readWorktreeLease(this.project.id, taskId);
		// Expired or released between the claim and the read — it is simply free now.
		if (staleToken === null) return await tryClaimWorktreeLease(this.project.id, taskId, token);

		const takenOver = await takeOverWorktreeLease(this.project.id, taskId, staleToken, token);
		if (takenOver) {
			logger.warn('worktree lease: took over an orphaned lease with no live owner', {
				projectId: this.project.id,
				taskId,
				staleToken,
				runId,
			});
		}
		return takenOver;
	}

	/**
	 * Resolve the branch/detach options and run `git worktree add` at `path`,
	 * claiming the lease once the checkout exists. Split out of {@link provision} so
	 * the collision/lease-lifecycle wrapper there stays simple; a failure here
	 * propagates to that wrapper, which releases a reclaim-held lease.
	 */
	private async createFreshWorktree(
		taskId: string,
		path: string,
		options: ProvisionOptions,
		leaseToken: string,
	): Promise<WorktreeHandle> {
		const baseBranch = options.baseBranch ?? this.project.baseBranch;
		const createBranch = options.createBranch ?? true;
		if (!options.detach && !createBranch && options.branch === undefined) {
			throw new Error(
				`Cannot check out an existing branch for task '${taskId}' without an explicit 'branch' — pass ProvisionOptions.branch when createBranch is false`,
			);
		}

		const detached = options.detach ?? false;
		// Detached HEAD has no branch; the handle reports the base ref it points at.
		const branch = detached
			? baseBranch
			: (options.branch ?? `${this.project.branchPrefix}${taskId}`);

		if (createBranch && !detached) {
			await this.reapOrphanedBranch(branch);
		}

		const args = ['worktree', 'add'];
		if (detached) {
			args.push('--detach', path, baseBranch);
		} else if (createBranch) {
			args.push('-b', branch, path, baseBranch);
		} else {
			args.push(path, branch);
		}

		logger.debug('Provisioning worktree', { taskId, path, branch, createBranch, detached });
		await this.git(args);

		await claimWorktreeLease(this.project.id, taskId, leaseToken);

		// SWARM-15 grafts untracked build state (node_modules, .env, caches) in here
		// via symlinks before the agent runs; git-tracked files (incl. the committed
		// `cascade` symlink) are already checked out by `git worktree add`.

		return { taskId, path, branch, detached };
	}

	/**
	 * Remove the worktree for `taskId` (§4.2 step 5). Idempotent: a missing
	 * worktree is a no-op (logged), not an error — "already gone" is the desired
	 * end state, not a bug (ai/CODING_STANDARDS.md "Error handling").
	 *
	 * Uses `--force` because the agent's uncommitted scratch (or a running process's
	 * open files) would otherwise block removal; the agent pushes anything worth
	 * keeping before cleanup runs.
	 */
	async cleanup(taskId: string): Promise<void> {
		const path = this.worktreePath(taskId);
		await releaseWorktreeLease(this.project.id, taskId);
		if (!existsSync(path)) {
			logger.warn('Worktree cleanup skipped — path does not exist', { taskId, path });
			return;
		}
		logger.debug('Removing worktree', { taskId, path });
		await this.removeWorktreeCheckout(path);
	}

	/**
	 * Force-remove just the worktree checkout, without touching the lease. Shared
	 * by {@link cleanup} (which releases the lease first) and the collision-reclaim
	 * path (which must *keep* the lease held across removal and re-provisioning).
	 * `--force` because the agent's uncommitted scratch or a running process's open
	 * files would otherwise block removal; the reclaim gate has already verified
	 * there is nothing worth keeping.
	 */
	private async removeWorktreeCheckout(path: string): Promise<void> {
		await this.git(['worktree', 'remove', '--force', path]);
	}

	/**
	 * Whether the worktree for `taskId` has no uncommitted changes (tracked or
	 * untracked) — `git status --porcelain` in the worktree itself, not the main
	 * repo root. Fails CLOSED on any error (missing worktree, git failure): treats
	 * it as *not* clean, so a caller using this as a prune safety gate skips
	 * rather than risks discarding someone's in-progress work.
	 */
	async isClean(taskId: string): Promise<boolean> {
		const path = this.worktreePath(taskId);
		try {
			const stdout = await this.git(['status', '--porcelain'], path);
			return stdout.trim().length === 0;
		} catch (err) {
			logger.warn('worktree cleanliness check failed — treating as dirty', {
				taskId,
				path,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	async hasUnpushedWork(taskId: string): Promise<boolean> {
		const path = this.worktreePath(taskId);
		try {
			let branchName = '';
			try {
				branchName = (await this.git(['symbolic-ref', '--short', '-q', 'HEAD'], path)).trim();
			} catch {
				// detached HEAD or other error in symbolic-ref
			}

			if (!branchName) {
				// Detached HEAD state.
				// Find if any remote tracking branch contains HEAD.
				let containsOutput = '';
				try {
					containsOutput = await this.git(['branch', '-r', '--contains', 'HEAD'], path);
				} catch {
					// failing closed
					return true;
				}
				const lines = containsOutput
					.split('\n')
					.map((l) => l.trim())
					.filter((l) => l.length > 0);
				const hasRemoteUpstream = lines.some((line) => line.startsWith('origin/'));
				return !hasRemoteUpstream;
			}

			let upstream: string | null = null;
			try {
				upstream = (await this.git(['rev-parse', '--abbrev-ref', '@{u}'], path)).trim();
			} catch {
				// no upstream tracking branch
			}

			if (upstream) {
				const countStr = (
					await this.git(['rev-list', '--count', `${upstream}..HEAD`], path)
				).trim();
				return parseInt(countStr, 10) > 0;
			}

			// check if origin has a branch of the same name
			let remoteBranch: string | null = null;
			try {
				await this.git(
					['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branchName}`],
					path,
				);
				remoteBranch = `origin/${branchName}`;
			} catch {
				// remote branch does not exist
			}

			if (remoteBranch) {
				const countStr = (
					await this.git(['rev-list', '--count', `${remoteBranch}..HEAD`], path)
				).trim();
				return parseInt(countStr, 10) > 0;
			}

			// compare against base branch
			const base = this.project.baseBranch;
			let baseRef = `origin/${base}`;
			try {
				await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`], path);
			} catch {
				baseRef = base;
			}

			const countStr = (await this.git(['rev-list', '--count', `${baseRef}..HEAD`], path)).trim();
			return parseInt(countStr, 10) > 0;
		} catch (err) {
			logger.warn('worktree unpushed work check failed — treating as having unpushed work', {
				taskId,
				path,
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * `cleanup()` only removes the worktree checkout, never the branch `provision`
	 * cut for it (§4.2 step 5 is silent on branches on purpose — a *successful*
	 * Implementation run needs `issue-<id>` to still exist locally so Review /
	 * Respond-to-review / Respond-to-CI can check it out again later). But that
	 * means a run that fails *before* pushing leaves a dangling local branch that
	 * blocks every retry with `fatal: a branch named '<x>' already exists`
	 * (confirmed live on #75). Delete that orphan, but only when it's provably
	 * safe to: if `origin` already has a matching ref, a PR may depend on it, so
	 * this leaves it alone and lets the `worktree add` failure below surface
	 * instead of risking real pushed work. Same caution on an `ls-remote` failure
	 * (network/config issue, can't verify either way) — assume the worst and skip.
	 */
	private async reapOrphanedBranch(branch: string): Promise<void> {
		const localExists = (await this.git(['branch', '--list', branch])).trim().length > 0;
		if (!localExists) return;

		let remoteHasIt: boolean;
		try {
			remoteHasIt = (await this.git(['ls-remote', '--heads', 'origin', branch])).trim().length > 0;
		} catch {
			remoteHasIt = true;
		}
		if (remoteHasIt) return;

		logger.warn('Deleting orphaned local branch left over from a previous failed run', { branch });
		await this.git(['branch', '-D', branch]);
	}

	/**
	 * Absolute paths of the worktrees git currently tracks for this repo, excluding
	 * the main checkout — the source of truth for reconciling orphaned sandboxes.
	 */
	async list(): Promise<string[]> {
		const stdout = await this.git(['worktree', 'list', '--porcelain']);
		const mainRoot = canonicalize(this.project.repoRoot);
		const paths: string[] = [];
		for (const line of stdout.split('\n')) {
			if (!line.startsWith('worktree ')) continue;
			const worktree = canonicalize(line.slice('worktree '.length).trim());
			if (worktree !== mainRoot) paths.push(worktree);
		}
		return paths;
	}

	/** Verify `repoRoot` exists and is a git working tree (§4.2 step 1). */
	private async assertGitRepo(): Promise<void> {
		if (!existsSync(this.project.repoRoot)) {
			throw new Error(`Project repo root does not exist: ${this.project.repoRoot}`);
		}
		try {
			await this.git(['rev-parse', '--is-inside-work-tree']);
		} catch {
			throw new Error(`Not a git repository: ${this.project.repoRoot}`);
		}
	}

	/** Best-effort `git fetch origin` — a failure (no remote, offline) is logged, not thrown. */
	private async fetch(): Promise<void> {
		try {
			await this.git(['fetch', 'origin']);
		} catch (err) {
			logger.warn('git fetch origin failed — continuing with local refs', {
				repoRoot: this.project.repoRoot,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	 * Run a git command in the project's repo root (or custom cwd) and return its stdout.
	 * Uses argv (not a shell string) so task IDs / branch names can't inject shell
	 * syntax. Throws with the captured stderr on a non-zero exit.
	 */
	private async git(args: string[], cwd?: string): Promise<string> {
		try {
			const { stdout } = await execFileAsync('git', args, { cwd: cwd ?? this.project.repoRoot });
			return stdout;
		} catch (err) {
			const stderr =
				typeof err === 'object' && err !== null && 'stderr' in err
					? String((err as { stderr: unknown }).stderr)
					: '';
			const message = stderr.trim() || (err instanceof Error ? err.message : String(err));
			throw new Error(`git ${args.join(' ')} failed: ${message}`);
		}
	}
}
