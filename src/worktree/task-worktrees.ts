/**
 * Which paths under a project's `worktreeRoot` are its `task-<id>` checkouts —
 * the one rule both worktree sweeps resolve their candidates through (issue #951).
 *
 * Lifted out of `./retention.ts` when the age-based abandoned sweep
 * (`./abandoned.ts`) arrived beside the `maxWorktrees` retention sweep. The two
 * run over the same filesystem with different policies, so the one thing they
 * must not disagree about is *which* checkouts they are deciding about: a second
 * copy of the matcher is a place for that to drift, and a checkout one sweep's
 * rule excluded while the other's admitted it is exactly the fight neither is
 * equipped to notice.
 *
 * The one behavioural change on the way out was tightening "under the root" to
 * "direct child of the root" — see {@link matchTaskWorktrees} for why the looser
 * rule was unsafe for *both* sweeps.
 */

import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const TASK_DIR_PATTERN = /^task-(.+)$/;

/**
 * Canonicalize a path for comparison against the worktree root. `git worktree
 * list --porcelain` reports realpaths (symlinks resolved), so plain `resolve` on
 * our side can miss a match when a component is symlinked (classic case: macOS
 * `/tmp` → `/private/tmp`). Falls back to `resolve` for a path that is not on
 * disk.
 */
export function canonicalizeWorktreePath(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

/** One of a project's per-task checkouts, as reported by git and as it exists on disk. */
export interface TaskWorktree {
	/** The path as the caller supplied it — what a result set reports back. */
	path: string;
	/** The symlink-resolved path; what to `stat` or compare against the root. */
	canonicalPath: string;
	taskId: string;
}

export interface TaskWorktreeScan {
	matched: TaskWorktree[];
	/** Paths that are not a direct `<repoRoot>/<worktreeRoot>/task-<id>` child. */
	ignored: string[];
}

/**
 * Partition `paths` into this project's `task-<id>` checkouts and everything
 * else. Anything that is not a *direct* `task-<id>` child of
 * `<repoRoot>/<worktreeRoot>` is `ignored` — left alone entirely, never a sweep
 * candidate.
 *
 * **Direct child, not descendant.** `GitWorktreeManager` addresses a checkout by
 * task id alone: `worktreePath()` maps an id straight back to
 * `<repoRoot>/<worktreeRoot>/task-<id>`, and `cleanup()` force-removes *that*
 * constructed path. So admitting a nested `…/archive/task-123` as a candidate
 * would let a sweep age and vet the nested checkout, then destroy the direct
 * `task-123` one instead — a checkout that never met the threshold, and whose
 * uncommitted or unpushed work the abandoned sweep does not stop for. Matching
 * exactly what `worktreePath()` can name keeps the checkout aged, checked,
 * removed and logged a single one.
 */
export function matchTaskWorktrees(
	paths: string[],
	repoRoot: string,
	worktreeRoot: string,
): TaskWorktreeScan {
	const rootCanonical = canonicalizeWorktreePath(resolve(repoRoot, worktreeRoot));

	const matched: TaskWorktree[] = [];
	const ignored: string[] = [];
	for (const p of paths) {
		const canonicalPath = canonicalizeWorktreePath(p);
		if (dirname(canonicalPath) !== rootCanonical) {
			ignored.push(p);
			continue;
		}
		const match = basename(canonicalPath).match(TASK_DIR_PATTERN);
		if (!match) {
			ignored.push(p);
			continue;
		}
		matched.push({ path: p, canonicalPath, taskId: match[1] });
	}
	return { matched, ignored };
}
