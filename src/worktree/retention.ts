import { realpathSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import type { ProjectConfig } from '../config/schema.js';
import { PROJECT_DEFAULTS } from '../config/schema.js';
import { type DispatchMode, resolveDispatchMode } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import { createHostLocalWorktreeRuntime } from './host-local-runtime.js';
import { storeBackedWorktreeRuntime, type WorktreeRuntime } from './worktree-runtime.js';

/**
 * The lease/pin store the sweep must read — **the same one this host's worker
 * writes**, or the reclaim gate answers about markers nobody sets (issue #551).
 *
 * In `in-process` mode the worker holds the Redis lease, so the store-backed
 * default is right. In `transport` mode every worker — this host's included, now
 * that it runs `src/transport/connect-entry.ts` over loopback — writes atomic
 * filesystem leases and preservation pins under `<repoRoot>/<worktreeRoot>/.swarm-state`
 * instead (`./host-local-runtime.ts`, ADR-004's 2026-08-06 amendment). A sweep
 * still asking Redis would find every checkout unleased and prune one out from
 * under a live phase — the sweep runs in the API server (`src/api/maintenance.ts`,
 * issue #550) and the CLI (`swarm worktrees prune`), both on this same filesystem.
 *
 * `isOwnerLive` answers `true` deliberately. It is consulted only for a lease
 * whose recorded pid is *this* process's, and this process holds no leases of its
 * own — so such a lease is a recycled-pid coincidence, and the reclaim gate's
 * fail-closed rule (`./reclaim.ts`) says skip the prune rather than risk a live
 * checkout. `ownerId` is likewise never written: nothing here claims or takes over.
 */
export function retentionWorktreeRuntime(
	project: ProjectConfig,
	dispatchMode: DispatchMode = resolveDispatchMode(),
): WorktreeRuntime {
	if (dispatchMode !== 'transport') return storeBackedWorktreeRuntime;
	return createHostLocalWorktreeRuntime({
		repoRoot: project.repoRoot,
		worktreeRoot: project.worktreeRoot,
		ownerId: `worktree-retention-sweep:${process.pid}`,
		isOwnerLive: () => true,
	});
}

export interface PruneStaleWorktreesOptions {
	/** Injectable for tests; defaults to `new GitWorktreeManager(project)`. */
	worktrees?: GitWorktreeManager;
	/** Report what would happen without actually removing anything. */
	dryRun?: boolean;
	/** Injectable deferred-session pin lookup for tests. */
	isDeferredPinned?: (projectId: string, taskId: string) => Promise<boolean>;
}

export interface PruneStaleWorktreesResult {
	kept: string[];
	pruned: string[];
	skippedInFlight: string[];
	skippedDirty: string[];
	/** Worktrees left alone because they carry local commits never pushed to origin (issue #367). */
	skippedUnpushed: string[];
	skippedDeferred: string[];
	/** Worktrees under worktreeRoot that don't match `task-<id>` — left alone entirely (see plan's scope note on legacy worktrees). */
	ignored: string[];
}

const TASK_DIR_PATTERN = /^task-(.+)$/;

interface MatchedEntry {
	path: string;
	taskId: string;
	mtimeMs: number;
}

function canonicalize(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return resolve(p);
	}
}

function getMatchedEntries(
	paths: string[],
	normalizedRoot: string,
	ignored: string[],
): MatchedEntry[] {
	const matchedEntries: MatchedEntry[] = [];
	for (const p of paths) {
		const canonicalPath = canonicalize(p);
		if (!canonicalPath.startsWith(normalizedRoot)) {
			ignored.push(p);
			continue;
		}

		const baseName = basename(canonicalPath);
		const match = baseName.match(TASK_DIR_PATTERN);
		if (!match) {
			ignored.push(p);
			continue;
		}

		const taskId = match[1];
		try {
			const stat = statSync(canonicalPath);
			matchedEntries.push({
				path: p,
				taskId,
				mtimeMs: stat.mtimeMs,
			});
		} catch (err) {
			logger.warn('Failed to stat worktree path, ignoring', { path: p, error: String(err) });
			ignored.push(p);
		}
	}
	return matchedEntries;
}

async function processCandidateEntries(
	candidates: MatchedEntry[],
	worktrees: GitWorktreeManager,
	options: PruneStaleWorktreesOptions,
	pruned: string[],
	skippedInFlight: string[],
	skippedDirty: string[],
	skippedUnpushed: string[],
	skippedDeferred: string[],
): Promise<void> {
	for (const candidate of candidates) {
		const { path, taskId } = candidate;
		// Share the provision-time reclaim gate (issue #367) so retention preserves
		// exactly the same protected checkouts, in the same order, and additionally
		// never prunes one carrying unpushed commits.
		const decision = await worktrees.evaluateReclaim(taskId, options.isDeferredPinned);
		if (!decision.safe) {
			switch (decision.reason) {
				case 'live-leased':
					skippedInFlight.push(path);
					break;
				case 'resumable-owner':
					skippedDeferred.push(path);
					break;
				case 'dirty':
					skippedDirty.push(path);
					break;
				case 'unpushed':
					skippedUnpushed.push(path);
					break;
			}
			continue;
		}
		if (!options.dryRun) {
			await worktrees.cleanup(taskId);
		}
		pruned.push(path);
	}
}

export async function pruneStaleWorktrees(
	project: ProjectConfig,
	options: PruneStaleWorktreesOptions = {},
): Promise<PruneStaleWorktreesResult> {
	const worktrees =
		options.worktrees ?? new GitWorktreeManager(project, retentionWorktreeRuntime(project));
	const paths = await worktrees.list();

	const kept: string[] = [];
	const pruned: string[] = [];
	const skippedInFlight: string[] = [];
	const skippedDirty: string[] = [];
	const skippedUnpushed: string[] = [];
	const skippedDeferred: string[] = [];
	const ignored: string[] = [];

	const worktreeRootCanonical = canonicalize(resolve(project.repoRoot, project.worktreeRoot));
	const normalizedRoot = worktreeRootCanonical.endsWith(sep)
		? worktreeRootCanonical
		: worktreeRootCanonical + sep;

	const matchedEntries = getMatchedEntries(paths, normalizedRoot, ignored);

	// Sort matched entries by mtimeMs descending (most recently touched first)
	matchedEntries.sort((a, b) => b.mtimeMs - a.mtimeMs);

	const maxWorktrees = project.worktreeRetention?.maxWorktrees ?? PROJECT_DEFAULTS.maxWorktrees;

	const keptEntries = matchedEntries.slice(0, maxWorktrees);
	const candidateEntries = matchedEntries.slice(maxWorktrees);

	for (const entry of keptEntries) {
		kept.push(entry.path);
	}

	await processCandidateEntries(
		candidateEntries,
		worktrees,
		options,
		pruned,
		skippedInFlight,
		skippedDirty,
		skippedUnpushed,
		skippedDeferred,
	);

	logger.debug('worktree retention sweep complete', {
		projectId: project.id,
		kept: kept.length,
		pruned: pruned.length,
		skippedInFlight: skippedInFlight.length,
		skippedDirty: skippedDirty.length,
		skippedUnpushed: skippedUnpushed.length,
		skippedDeferred: skippedDeferred.length,
		ignored: ignored.length,
	});

	for (const dirtyPath of skippedDirty) {
		logger.warn('worktree skipped during retention sweep — has uncommitted changes', {
			projectId: project.id,
			path: dirtyPath,
		});
	}

	for (const unpushedPath of skippedUnpushed) {
		logger.warn('worktree skipped during retention sweep — has unpushed commits', {
			projectId: project.id,
			path: unpushedPath,
		});
	}

	return {
		kept,
		pruned,
		skippedInFlight,
		skippedDirty,
		skippedUnpushed,
		skippedDeferred,
		ignored,
	};
}
