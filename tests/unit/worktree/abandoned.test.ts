import type { Stats } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SweepClaim } from '@/worker/git-worktree-manager.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import type { LivenessDecision } from '@/worktree/reclaim.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The default runtime reaches these at construction; mock at the boundary so the
// suite stays hermetic even though every test below injects its own manager.
vi.mock('@/db/repositories/runsRepository.js', () => ({
	hasResumableDeferredRun: vi.fn(async () => false),
}));
vi.mock('@/worktree/worktree-lease.js', () => ({
	isWorktreeLeased: vi.fn(async () => false),
	claimWorktreeLease: vi.fn(),
	releaseWorktreeLease: vi.fn(),
}));

const { statSyncMock, readFileSyncMock } = vi.hoisted(() => ({
	statSyncMock: vi.fn(),
	readFileSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs')>();
	return { ...original, statSync: statSyncMock, readFileSync: readFileSyncMock };
});

const { sweepAbandonedWorktrees } = await import('@/worktree/abandoned.js');

const REPO_ROOT = '/Users/dev/swarm/swarm';
const ROOT = `${REPO_ROOT}/.swarm-workspaces`;
const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const now = () => NOW;
const daysAgo = (days: number) => NOW - days * DAY_MS;

class FakeGitWorktreeManager extends GitWorktreeManager {
	private mockList: string[] = [];
	private cleanMap = new Map<string, boolean>();
	private unpushedMap = new Map<string, boolean>();
	private livenessMap = new Map<string, LivenessDecision>();
	private throwOnCleanup = new Set<string>();
	public cleanedUpTasks: string[] = [];
	/** Every lease operation, in order — the claim is only worth anything if it brackets the removal. */
	public leaseLog: string[] = [];

	setWorktreesList(paths: string[]) {
		this.mockList = paths;
	}

	setTaskCleanliness(taskId: string, clean: boolean) {
		this.cleanMap.set(taskId, clean);
	}

	setTaskUnpushed(taskId: string, unpushed: boolean) {
		this.unpushedMap.set(taskId, unpushed);
	}

	setTaskLiveness(taskId: string, decision: LivenessDecision) {
		this.livenessMap.set(taskId, decision);
	}

	failCleanupFor(taskId: string) {
		this.throwOnCleanup.add(taskId);
	}

	override async list(): Promise<string[]> {
		return this.mockList;
	}

	override async isClean(taskId: string): Promise<boolean> {
		return this.cleanMap.get(taskId) ?? true;
	}

	override async hasUnpushedWork(taskId: string): Promise<boolean> {
		return this.unpushedMap.get(taskId) ?? false;
	}

	override async claimForSweep(taskId: string): Promise<SweepClaim> {
		const liveness = this.livenessMap.get(taskId) ?? { safe: true };
		if (!liveness.safe) return liveness;
		this.leaseLog.push(`claim:${taskId}`);
		return { safe: true, token: `token-${taskId}` };
	}

	override async releaseSweepClaim(taskId: string, token: string): Promise<void> {
		this.leaseLog.push(`release:${taskId}:${token}`);
	}

	override async removeCheckoutUnderLease(taskId: string): Promise<void> {
		if (this.throwOnCleanup.has(taskId)) throw new Error(`git worktree remove failed: ${taskId}`);
		this.leaseLog.push(`remove:${taskId}`);
		this.cleanedUpTasks.push(taskId);
	}

	/** The lease-releasing removal, which this sweep must never reach for. */
	override async cleanup(taskId: string): Promise<void> {
		this.leaseLog.push(`cleanup:${taskId}`);
		this.cleanedUpTasks.push(taskId);
	}
}

/**
 * Date every named worktree directory (and nothing else) at `mtimeMs`. The
 * checkout's `.git` is left unreadable, so `resolveLastTouchedMs` falls back to
 * the directory alone — the simple shape most cases below only need one signal of.
 */
function stubDirectoryMtimes(mtimes: Record<string, number>): void {
	statSyncMock.mockImplementation((path: string) => {
		const mtimeMs = mtimes[path];
		if (mtimeMs === undefined) throw new Error(`ENOENT: ${path}`);
		return { mtimeMs } as unknown as Stats;
	});
	readFileSyncMock.mockImplementation((path: string) => {
		throw new Error(`ENOENT: ${path}`);
	});
}

describe('sweepAbandonedWorktrees', () => {
	beforeEach(() => {
		statSyncMock.mockReset();
		readFileSyncMock.mockReset();
	});

	it('removes a dirty checkout the hourly sweep would refuse forever, and records what it destroyed', async () => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-131`]);
		manager.setTaskCleanliness('131', false);
		stubDirectoryMtimes({ [`${ROOT}/task-131`]: daysAgo(14) });

		const result = await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(manager.cleanedUpTasks).toEqual(['131']);
		expect(result.removed).toEqual([
			{
				taskId: '131',
				path: `${ROOT}/task-131`,
				lastTouchedAt: new Date(daysAgo(14)).toISOString(),
				ageDays: 14,
				hadUncommittedChanges: true,
				hadUnpushedCommits: false,
			},
		]);
	});

	// The F1 regression (issue #955 review): the sweep force-removes, so the lease it
	// took has to still be held when the removal happens. Releasing first — which is
	// what `cleanup` does — hands a provisioner the very checkout about to be deleted.
	it('holds the claim across the removal and gives it back only afterwards', async () => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-131`]);
		stubDirectoryMtimes({ [`${ROOT}/task-131`]: daysAgo(14) });

		await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(manager.leaseLog).toEqual(['claim:131', 'remove:131', 'release:131:token-131']);
	});

	// A checkout a provisioner claimed first is reported live, not removed — the
	// answer the claim exists to make true at the moment of the removal rather than
	// only at the moment it was asked for.
	it('keeps a checkout whose lease another provisioner claimed first', async () => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-132`]);
		manager.setTaskLiveness('132', {
			safe: false,
			reason: 'live-leased',
			detail: 'is leased, and the lease was claimed by another provisioner first',
		});
		stubDirectoryMtimes({ [`${ROOT}/task-132`]: daysAgo(40) });

		const result = await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(result.keptLive).toEqual([{ path: `${ROOT}/task-132`, reason: 'live-leased' }]);
		expect(manager.cleanedUpTasks).toEqual([]);
		expect(manager.leaseLog).toEqual([]);
	});

	it.each([
		['a removal that failed', { failed: true, dryRun: false }],
		['a dry run', { failed: false, dryRun: true }],
	])('gives the claim back after %s, so the next dispatch finds its lease free', async (_name, mode) => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-133`]);
		if (mode.failed) manager.failCleanupFor('133');
		stubDirectoryMtimes({ [`${ROOT}/task-133`]: daysAgo(14) });

		await sweepAbandonedWorktrees(project, {
			worktrees: manager,
			now,
			dryRun: mode.dryRun,
		});

		expect(manager.leaseLog.at(-1)).toBe('release:133:token-133');
	});

	it('removes a checkout carrying unpushed commits and records them', async () => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-200`]);
		manager.setTaskUnpushed('200', true);
		stubDirectoryMtimes({ [`${ROOT}/task-200`]: daysAgo(11) });

		const result = await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(manager.cleanedUpTasks).toEqual(['200']);
		expect(result.removed[0]).toMatchObject({
			taskId: '200',
			hadUnpushedCommits: true,
			hadUncommittedChanges: false,
		});
	});

	it('keeps a dirty checkout that is still inside the threshold', async () => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-300`]);
		manager.setTaskCleanliness('300', false);
		stubDirectoryMtimes({ [`${ROOT}/task-300`]: daysAgo(3) });

		const result = await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(result.keptRecent).toEqual([`${ROOT}/task-300`]);
		expect(result.removed).toEqual([]);
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it.each([
		['live-leased', 'is leased by a live run'],
		['resumable-owner', 'is pinned by a resumable deferred/failed run'],
	] as const)('never removes a %s checkout, however old', async (reason, detail) => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-400`]);
		manager.setTaskLiveness('400', { safe: false, reason, detail });
		stubDirectoryMtimes({ [`${ROOT}/task-400`]: daysAgo(30) });

		const result = await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(result.keptLive).toEqual([{ path: `${ROOT}/task-400`, reason }]);
		expect(result.removed).toEqual([]);
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('reads the project threshold rather than hard-coding the default', async () => {
		const project = createMockProjectConfig({
			repoRoot: REPO_ROOT,
			worktreeRetention: { abandonedAfterDays: 3 },
		});
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-500`]);
		stubDirectoryMtimes({ [`${ROOT}/task-500`]: daysAgo(4) });

		const result = await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(result.removed.map((r) => r.taskId)).toEqual(['500']);
	});

	it('reports identical removals without removing anything under dryRun', async () => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-600`]);
		manager.setTaskCleanliness('600', false);
		stubDirectoryMtimes({ [`${ROOT}/task-600`]: daysAgo(20) });

		const result = await sweepAbandonedWorktrees(project, {
			worktrees: manager,
			now,
			dryRun: true,
		});

		expect(manager.cleanedUpTasks).toEqual([]);
		expect(result.removed).toEqual([
			{
				taskId: '600',
				path: `${ROOT}/task-600`,
				lastTouchedAt: new Date(daysAgo(20)).toISOString(),
				ageDays: 20,
				hadUncommittedChanges: true,
				hadUnpushedCommits: false,
			},
		]);
	});

	it('carries on past a removal that throws', async () => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-700`, `${ROOT}/task-701`]);
		manager.failCleanupFor('700');
		stubDirectoryMtimes({
			[`${ROOT}/task-700`]: daysAgo(30),
			[`${ROOT}/task-701`]: daysAgo(30),
		});

		const result = await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(result.failed).toEqual([
			{
				path: `${ROOT}/task-700`,
				taskId: '700',
				error: 'git worktree remove failed: 700',
			},
		]);
		expect(result.removed.map((r) => r.taskId)).toEqual(['701']);
		expect(manager.cleanedUpTasks).toEqual(['701']);
	});

	it('ignores a path outside the worktree root and one not named task-<id>', async () => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList(['/Users/dev/elsewhere/task-800', `${ROOT}/scratch`]);
		stubDirectoryMtimes({
			'/Users/dev/elsewhere/task-800': daysAgo(40),
			[`${ROOT}/scratch`]: daysAgo(40),
		});

		const result = await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(result.ignored).toEqual(['/Users/dev/elsewhere/task-800', `${ROOT}/scratch`]);
		expect(result.removed).toEqual([]);
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	// The candidate the sweep ages must be the checkout `cleanup(taskId)` removes.
	// A nested `archive/task-123` shares the id of the live direct checkout, so
	// admitting it would have destroyed the recent dirty one in its place.
	it('ignores a nested task-<id> path rather than cleaning up the direct checkout sharing its id', async () => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/archive/task-123`, `${ROOT}/task-123`]);
		manager.setTaskCleanliness('123', false);
		stubDirectoryMtimes({
			[`${ROOT}/archive/task-123`]: daysAgo(40),
			[`${ROOT}/task-123`]: daysAgo(1),
		});

		const result = await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(result.ignored).toEqual([`${ROOT}/archive/task-123`]);
		expect(result.keptRecent).toEqual([`${ROOT}/task-123`]);
		expect(result.removed).toEqual([]);
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('fails closed on a candidate nothing can be stat-ed for', async () => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-900`]);
		stubDirectoryMtimes({});

		const result = await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(result.ignored).toEqual([`${ROOT}/task-900`]);
		expect(result.removed).toEqual([]);
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	// The regression test for the definition's dangerous direction: a directory
	// mtime moves only on a *top-level* change, so an agent editing a nested file
	// leaves the root looking untouched while git's own metadata is fresh.
	it('takes the newest signal, so recent git activity keeps a stale-looking directory', async () => {
		const project = createMockProjectConfig({ repoRoot: REPO_ROOT });
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([`${ROOT}/task-1000`]);

		const gitDir = `${REPO_ROOT}/.git/worktrees/task-1000`;
		statSyncMock.mockImplementation((path: string) => {
			if (path === `${ROOT}/task-1000`) return { mtimeMs: daysAgo(20) } as unknown as Stats;
			if (path === `${ROOT}/task-1000/.git`) return { mtimeMs: daysAgo(20) } as unknown as Stats;
			if (path === `${gitDir}/index`) return { mtimeMs: daysAgo(2) } as unknown as Stats;
			throw new Error(`ENOENT: ${path}`);
		});
		readFileSyncMock.mockImplementation((path: string) => {
			if (path === `${ROOT}/task-1000/.git`) return `gitdir: ${gitDir}\n`;
			throw new Error(`ENOENT: ${path}`);
		});

		const result = await sweepAbandonedWorktrees(project, { worktrees: manager, now });

		expect(result.keptRecent).toEqual([`${ROOT}/task-1000`]);
		expect(result.removed).toEqual([]);
		expect(manager.cleanedUpTasks).toEqual([]);
	});
});
