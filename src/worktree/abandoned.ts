/**
 * The age-based abandoned-worktree sweep (issue #951) — the mechanism that
 * removes one machine's long-untouched `task-<id>` checkouts, and nothing that
 * decides when it runs.
 *
 * **The hole it fills.** `pruneStaleWorktrees` (`./retention.ts`) keeps the
 * `maxWorktrees` most recently touched checkouts and runs every other one through
 * the full reclaim gate (`./reclaim.ts`), which refuses anything dirty or
 * carrying unpushed commits. Both are right for a sweep running minutes after a
 * phase stops, and both are wrong at ten days: a checkout nobody can adopt again
 * is then retained *forever* the moment an interrupted agent left a stray file in
 * it, and "untouched for a long time" is expressible there only as a rank, never
 * as an age. This sweep is the second entry point — age, not rank — and it
 * deliberately **records rather than obeys** the dirty/unpushed pair, which is the
 * whole point of it. Those two checks stay obeyed in `reclaim.ts`, which every
 * other caller still goes through.
 *
 * **What "untouched" means.** {@link resolveLastTouchedMs}: the newest mtime among
 * the worktree directory itself and the checkout's own git metadata — `.git`
 * (a linked worktree's `gitdir:` pointer file) and, when that pointer resolves,
 * `index`, `HEAD` and `logs/HEAD` in the per-worktree git dir. Three consequences,
 * all deliberate:
 *
 * - **The directory mtime alone is too weak in the dangerous direction.** A
 *   directory's mtime moves only when a *top-level* entry is created, removed or
 *   renamed, so an agent editing `src/foo.ts` bumps `src/` and not the worktree
 *   root — and directory mtime alone would then call a checkout holding real
 *   recent work "untouched", which is the one error mode that loses work. Every
 *   SWARM phase stages, commits or checks out, and all three move `index` /
 *   `HEAD` / `logs/HEAD`, so consulting them closes that gap for three `statSync`
 *   calls per candidate.
 * - **A bump that is not real work costs a delayed delete, never a lost one.** A
 *   symlink graft (`node_modules`, `.env`, `cascade` — ai/ARCHITECTURE.md
 *   "Worktree lifecycle"), a top-level build-cache write, or an editor swap file
 *   makes a checkout read as fresh and it simply survives another round. Erring
 *   toward keeping is the same instinct the reclaim gate carries.
 * - **Not a recursive newest-mtime scan.** That is O(repo) per candidate on every
 *   machine in the fleet, and the grafted `node_modules` and build caches it would
 *   have to walk (or special-case) would defeat it anyway.
 *
 * A candidate that stats *nothing* fails closed: it is reported as `ignored` and
 * never removed, matching how `pruneStaleWorktrees` treats an unstattable path.
 *
 * **Liveness is never overridden by age.** A leased or resumable-pinned checkout
 * is kept whatever its age, decided by {@link GitWorktreeManager.evaluateLiveness}
 * — the same code the hourly sweep's gate runs, not a second opinion. The two
 * sweeps also resolve candidates through the same `matchTaskWorktrees`, read the
 * same lease runtime, and call the same idempotent `cleanup`, so a checkout one
 * removed a moment earlier costs the other a log line rather than a failure.
 *
 * `.swarm-state` is left alone: `sweepStaleHostLocalState` is `pruneStaleWorktrees`'
 * own. Every artifact there is already TTL-bounded at 4h/24h, so nothing it holds
 * is still standing at ten days — and removing one would only take the liveness
 * answer away from the gate above.
 *
 * **Nothing calls this yet.** It is the mechanism only, in the shape
 * `src/worker/self-update.ts` took before issue #933 gave it a signal path; the
 * scheduler and the fleet transport are phases 2 and 3 of issue #951.
 */

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { ProjectConfig } from '../config/schema.js';
import { PROJECT_DEFAULTS } from '../config/schema.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import type { LiveBlockedReason } from './reclaim.js';
import { retentionWorktreeRuntime } from './retention.js';
import { matchTaskWorktrees } from './task-worktrees.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SweepAbandonedWorktreesOptions {
	/** Injectable for tests; defaults to the same host-local runtime the retention sweep uses. */
	worktrees?: GitWorktreeManager;
	/** Report what would be removed without removing anything. */
	dryRun?: boolean;
	/** Injectable resumable-pin lookup, exactly as `PruneStaleWorktreesOptions` carries one. */
	isResumablePinned?: (projectId: string, taskId: string) => Promise<boolean>;
	/** Override the project's configured threshold. */
	abandonedAfterDays?: number;
	/** Injectable clock for tests. */
	now?: () => number;
}

/** One removal and why it qualified — the record the `warn` line is built from. */
export interface AbandonedWorktreeRemoval {
	taskId: string;
	path: string;
	/** ISO-8601; the newest signal found — see the module header for what counts as "touched". */
	lastTouchedAt: string;
	ageDays: number;
	/** Recorded, never a gate: this is the work the removal destroyed, and it must not be silent. */
	hadUncommittedChanges: boolean;
	hadUnpushedCommits: boolean;
}

export interface SweepAbandonedWorktreesResult {
	removed: AbandonedWorktreeRemoval[];
	/** Under the threshold — the ordinary outcome for an active project. */
	keptRecent: string[];
	/** Old enough, but leased or pinned. Age never overrides liveness. */
	keptLive: { path: string; reason: LiveBlockedReason }[];
	/** A removal that threw. One checkout must not end the sweep. */
	failed: { path: string; taskId: string; error: string }[];
	/** Not a direct `task-<id>` child of the worktree root, or nothing could be stat'ed for it. */
	ignored: string[];
}

/** `mtimeMs` of `path`, or `undefined` when it cannot be stat'ed. */
function mtimeMsOf(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * The per-worktree git directory `<worktree>/.git` points at, or `undefined` when
 * `.git` is not a `gitdir:` pointer file (a plain checkout, or unreadable).
 */
function resolveLinkedGitDir(worktreePath: string): string | undefined {
	try {
		const pointer = readFileSync(resolve(worktreePath, '.git'), 'utf8');
		const match = pointer.match(/^gitdir:\s*(.+)$/m);
		if (!match) return undefined;
		const gitDir = match[1].trim();
		return isAbsolute(gitDir) ? gitDir : resolve(worktreePath, gitDir);
	} catch {
		return undefined;
	}
}

/**
 * The newest "this checkout was touched" signal, in epoch ms, or `undefined` when
 * nothing could be stat'ed at all — see the module header for the definition and
 * why it is not a recursive scan.
 */
export function resolveLastTouchedMs(worktreePath: string): number | undefined {
	const candidates: (number | undefined)[] = [
		mtimeMsOf(worktreePath),
		mtimeMsOf(resolve(worktreePath, '.git')),
	];

	const gitDir = resolveLinkedGitDir(worktreePath);
	if (gitDir) {
		for (const entry of ['index', 'HEAD', 'logs/HEAD']) {
			candidates.push(mtimeMsOf(resolve(gitDir, entry)));
		}
	}

	const found = candidates.filter((ms): ms is number => ms !== undefined);
	return found.length > 0 ? Math.max(...found) : undefined;
}

/**
 * Remove every `task-<id>` checkout under this project's `worktreeRoot` that has
 * gone untouched for `worktreeRetention.abandonedAfterDays`, **including** ones
 * holding uncommitted changes or unpushed commits — but never one something is
 * still using.
 */
export async function sweepAbandonedWorktrees(
	project: ProjectConfig,
	options: SweepAbandonedWorktreesOptions = {},
): Promise<SweepAbandonedWorktreesResult> {
	const worktrees =
		options.worktrees ?? new GitWorktreeManager(project, retentionWorktreeRuntime(project));
	const thresholdDays =
		options.abandonedAfterDays ??
		project.worktreeRetention?.abandonedAfterDays ??
		PROJECT_DEFAULTS.abandonedAfterDays;
	const thresholdMs = thresholdDays * MS_PER_DAY;
	const now = options.now?.() ?? Date.now();

	const scan = matchTaskWorktrees(await worktrees.list(), project.repoRoot, project.worktreeRoot);

	const removed: AbandonedWorktreeRemoval[] = [];
	const keptRecent: string[] = [];
	const keptLive: { path: string; reason: LiveBlockedReason }[] = [];
	const failed: { path: string; taskId: string; error: string }[] = [];
	const ignored: string[] = [...scan.ignored];

	for (const { path, canonicalPath, taskId } of scan.matched) {
		const lastTouchedMs = resolveLastTouchedMs(canonicalPath);
		if (lastTouchedMs === undefined) {
			// Fail closed: a checkout we can learn nothing about is never removed.
			logger.warn('abandoned sweep could not date a worktree, ignoring', {
				projectId: project.id,
				taskId,
				path,
			});
			ignored.push(path);
			continue;
		}

		const ageMs = now - lastTouchedMs;
		if (ageMs < thresholdMs) {
			keptRecent.push(path);
			continue;
		}

		// Cheapest first: the age came off a stat already taken, so liveness — which
		// reads the lease store — is only asked about a checkout old enough to matter.
		const liveness = await worktrees.evaluateLiveness(taskId, options.isResumablePinned);
		if (!liveness.safe) {
			keptLive.push({ path, reason: liveness.reason });
			continue;
		}

		// Recorded, not obeyed. Both fail closed toward "there is work here", which is
		// the right direction for a record, and both are paid for only by a checkout
		// actually being removed.
		const hadUncommittedChanges = !(await worktrees.isClean(taskId));
		const hadUnpushedCommits = await worktrees.hasUnpushedWork(taskId);

		if (!options.dryRun) {
			try {
				await worktrees.cleanup(taskId);
			} catch (err) {
				failed.push({ path, taskId, error: describeError(err) });
				logger.warn('abandoned worktree removal failed', {
					projectId: project.id,
					taskId,
					path,
					error: describeError(err),
				});
				continue;
			}
		}

		const removal: AbandonedWorktreeRemoval = {
			taskId,
			path,
			lastTouchedAt: new Date(lastTouchedMs).toISOString(),
			ageDays: ageMs / MS_PER_DAY,
			hadUncommittedChanges,
			hadUnpushedCommits,
		};
		removed.push(removal);

		// `warn`, not `info`: this is the one sweep that can delete unpushed work, so
		// what it destroyed is stated rather than counted.
		logger.warn('abandoned worktree removed', {
			projectId: project.id,
			...removal,
			thresholdDays,
			dryRun: options.dryRun === true,
		});
	}

	logger.debug('abandoned worktree sweep complete', {
		projectId: project.id,
		thresholdDays,
		removed: removed.length,
		keptRecent: keptRecent.length,
		keptLive: keptLive.length,
		failed: failed.length,
		ignored: ignored.length,
	});

	return { removed, keptRecent, keptLive, failed, ignored };
}
