import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	type Stats,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { pruneStaleWorktrees, retentionWorktreeRuntime } from '@/worktree/retention.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const { hasResumableDeferredRunMock } = vi.hoisted(() => ({
	hasResumableDeferredRunMock: vi.fn(),
}));

vi.mock('@/db/repositories/runsRepository.js', () => ({
	hasResumableDeferredRun: hasResumableDeferredRunMock,
}));

// Mock worktree lease check
const { isWorktreeLeasedMock } = vi.hoisted(() => ({
	isWorktreeLeasedMock: vi.fn(),
}));

vi.mock('@/worktree/worktree-lease.js', () => ({
	isWorktreeLeased: isWorktreeLeasedMock,
	claimWorktreeLease: vi.fn(),
	releaseWorktreeLease: vi.fn(),
}));

// Mock statSync
const { statSyncMock } = vi.hoisted(() => ({
	statSyncMock: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
	const original = await importOriginal<typeof import('node:fs')>();
	return {
		...original,
		statSync: statSyncMock,
	};
});

// A small local stub/fake for GitWorktreeManager
class FakeGitWorktreeManager extends GitWorktreeManager {
	private mockList: string[] = [];
	private cleanMap = new Map<string, boolean>();
	private unpushedMap = new Map<string, boolean>();
	public cleanedUpTasks: string[] = [];

	setWorktreesList(paths: string[]) {
		this.mockList = paths;
	}

	setTaskCleanliness(taskId: string, clean: boolean) {
		this.cleanMap.set(taskId, clean);
	}

	setTaskUnpushed(taskId: string, unpushed: boolean) {
		this.unpushedMap.set(taskId, unpushed);
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

	override async cleanup(taskId: string): Promise<void> {
		this.cleanedUpTasks.push(taskId);
	}
}

describe('pruneStaleWorktrees', () => {
	beforeEach(() => {
		isWorktreeLeasedMock.mockReset();
		isWorktreeLeasedMock.mockResolvedValue(false);
		hasResumableDeferredRunMock.mockReset().mockResolvedValue(false);
		statSyncMock.mockReset();
	});

	it('keeps the maxWorktrees most-recently-touched task-<id> worktrees and prunes the rest', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 2 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
		]);

		// task-3 is newest, task-1 is oldest
		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			if (path.endsWith('task-2')) return { mtimeMs: 2000 } as unknown as Stats;
			if (path.endsWith('task-3')) return { mtimeMs: 3000 } as unknown as Stats;
			throw new Error('Unknown path in statSyncMock');
		});

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toEqual([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
		]);
		expect(result.pruned).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(manager.cleanedUpTasks).toEqual(['1']);
		expect(result.skippedInFlight).toEqual([]);
		expect(result.skippedDirty).toEqual([]);
		expect(result.ignored).toEqual([]);
	});

	it('falls back to PROJECT_DEFAULTS.maxWorktrees when config is omitted', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: undefined,
		});

		const manager = new FakeGitWorktreeManager(project);
		// generate 12 worktrees, 10 should be kept, 2 pruned (since default maxWorktrees is 10)
		const list: string[] = [];
		for (let i = 1; i <= 12; i++) {
			list.push(`/Users/dev/swarm/swarm/.swarm-workspaces/task-${i}`);
		}
		manager.setWorktreesList(list);

		statSyncMock.mockImplementation((path: string) => {
			const num = parseInt(path.split('task-')[1], 10);
			return { mtimeMs: num * 1000 } as unknown as Stats; // task-12 is newest
		});

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toHaveLength(10);
		expect(result.pruned).toEqual([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
		]);
		expect(manager.cleanedUpTasks).toEqual(['2', '1']);
	});

	it('skips (does not prune) an old worktree that is leased, and does not backfill', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 2 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
		]);

		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			if (path.endsWith('task-2')) return { mtimeMs: 2000 } as unknown as Stats;
			if (path.endsWith('task-3')) return { mtimeMs: 3000 } as unknown as Stats;
			throw new Error('Unknown path');
		});

		// task-1 is leased/in-flight
		isWorktreeLeasedMock.mockImplementation(async (_projId, taskId) => taskId === '1');

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toEqual([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
		]);
		expect(result.pruned).toEqual([]);
		expect(result.skippedInFlight).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('skips an old worktree that is dirty', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 2 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
		]);

		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			if (path.endsWith('task-2')) return { mtimeMs: 2000 } as unknown as Stats;
			if (path.endsWith('task-3')) return { mtimeMs: 3000 } as unknown as Stats;
			throw new Error('Unknown path');
		});

		// task-1 is dirty
		manager.setTaskCleanliness('1', false);

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toEqual([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
		]);
		expect(result.pruned).toEqual([]);
		expect(result.skippedDirty).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('skips a clean old worktree that still has unpushed commits (issue #367)', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 2 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
		]);

		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			if (path.endsWith('task-2')) return { mtimeMs: 2000 } as unknown as Stats;
			if (path.endsWith('task-3')) return { mtimeMs: 3000 } as unknown as Stats;
			throw new Error('Unknown path');
		});

		// task-1 is clean but carries unpushed local commits — never prune it.
		manager.setTaskUnpushed('1', true);

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.pruned).toEqual([]);
		expect(result.skippedUnpushed).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(result.skippedDirty).toEqual([]);
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('pins an old worktree while a resumable deferred run is pending', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 1 },
		});
		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
		]);
		statSyncMock.mockImplementation(
			(path: string) => ({ mtimeMs: path.endsWith('task-1') ? 1000 : 2000 }) as Stats,
		);
		hasResumableDeferredRunMock.mockImplementation(async (_projectId, taskId) => taskId === '1');

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.skippedDeferred).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(result.pruned).toEqual([]);
		expect(manager.cleanedUpTasks).toEqual([]);
	});

	it('leaves non-task-<id>-named directories alone and reports them as ignored', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 1 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/issue-10-spike',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
		]);

		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			throw new Error('Should not stat non-task directory');
		});

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(result.ignored).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/issue-10-spike']);
		expect(result.pruned).toEqual([]);
	});

	it('computes same lists on dryRun: true but does not run cleanup', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 2 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
		]);

		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			if (path.endsWith('task-2')) return { mtimeMs: 2000 } as unknown as Stats;
			if (path.endsWith('task-3')) return { mtimeMs: 3000 } as unknown as Stats;
			throw new Error('Unknown path');
		});

		const result = await pruneStaleWorktrees(project, { worktrees: manager, dryRun: true });

		expect(result.kept).toEqual([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-3',
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-2',
		]);
		expect(result.pruned).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(manager.cleanedUpTasks).toEqual([]); // Did NOT clean up
	});

	it('filters out any git-reported worktree path outside repoRoot/worktreeRoot', async () => {
		const project = createMockProjectConfig({
			repoRoot: '/Users/dev/swarm/swarm',
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 1 },
		});

		const manager = new FakeGitWorktreeManager(project);
		manager.setWorktreesList([
			'/Users/dev/swarm/swarm/.swarm-workspaces/task-1',
			'/Users/dev/some-other-place/task-2',
		]);

		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			throw new Error('Should not stat path outside root');
		});

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toEqual(['/Users/dev/swarm/swarm/.swarm-workspaces/task-1']);
		expect(result.ignored).toEqual(['/Users/dev/some-other-place/task-2']);
		expect(result.pruned).toEqual([]);
	});
});

/**
 * Issue #551/#553: every worker runs the DB-free entrypoint, so it writes
 * host-local filesystem leases rather than the Redis one the retired in-process
 * worker held — and the sweep (in the API server, `src/api/maintenance.ts`, and in
 * `swarm worktrees prune`) has to read the store the worker actually writes, or it
 * would find every checkout unleased and prune one out from under a live phase.
 */
describe('retentionWorktreeRuntime', () => {
	let repoRoot: string;

	beforeEach(() => {
		// realpath'd so the sweep's own canonicalization agrees with these paths on
		// macOS, where `/var/folders/...` is a symlink to `/private/var/folders/...`.
		repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-retention-')));
	});
	afterEach(() => {
		rmSync(repoRoot, { recursive: true, force: true });
	});

	/** Write the lease a live host-local phase holds for `taskId`. */
	function writeHostLocalLease(project: { id: string; worktreeRoot: string }, taskId: string) {
		const key = createHash('sha256').update(`${project.id}\0${taskId}`).digest('hex');
		const lock = resolve(repoRoot, project.worktreeRoot, '.swarm-state', `${key}.lock`);
		mkdirSync(lock, { recursive: true });
		writeFileSync(
			join(lock, 'owner.json'),
			`${JSON.stringify({
				token: 'lease-token',
				ownerId: 'dispatch-1',
				ownerKey: 'run-1',
				// pid 1 is always alive and is never this process, so the lease is judged
				// live by the cross-process path rather than by the in-flight set.
				pid: 1,
				createdAt: new Date().toISOString(),
				projectId: project.id,
				taskId,
			})}\n`,
			'utf8',
		);
	}

	it('skips a checkout held by a live host-local lease instead of pruning it', async () => {
		const project = createMockProjectConfig({
			repoRoot,
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 1 },
		});
		const taskPath = (taskId: string) => resolve(repoRoot, '.swarm-workspaces', `task-${taskId}`);
		for (const taskId of ['1', '2']) mkdirSync(taskPath(taskId), { recursive: true });
		writeHostLocalLease(project, '1');

		const manager = new FakeGitWorktreeManager(project, retentionWorktreeRuntime(project));
		manager.setWorktreesList([taskPath('1'), taskPath('2')]);
		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			if (path.endsWith('task-2')) return { mtimeMs: 2000 } as unknown as Stats;
			throw new Error(`Unexpected stat of ${path}`);
		});
		// Nothing consults Redis on this path — the lease it would report is irrelevant.
		isWorktreeLeasedMock.mockResolvedValue(false);

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.kept).toEqual([taskPath('2')]);
		expect(result.skippedInFlight).toEqual([taskPath('1')]);
		expect(result.pruned).toEqual([]);
		expect(manager.cleanedUpTasks).toEqual([]);
		expect(isWorktreeLeasedMock).not.toHaveBeenCalled();
	});

	it('prunes an unleased checkout on the same host-local store', async () => {
		const project = createMockProjectConfig({
			repoRoot,
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 1 },
		});
		const taskPath = (taskId: string) => resolve(repoRoot, '.swarm-workspaces', `task-${taskId}`);
		for (const taskId of ['1', '2']) mkdirSync(taskPath(taskId), { recursive: true });

		const manager = new FakeGitWorktreeManager(project, retentionWorktreeRuntime(project));
		manager.setWorktreesList([taskPath('1'), taskPath('2')]);
		statSyncMock.mockImplementation((path: string) => {
			if (path.endsWith('task-1')) return { mtimeMs: 1000 } as unknown as Stats;
			if (path.endsWith('task-2')) return { mtimeMs: 2000 } as unknown as Stats;
			throw new Error(`Unexpected stat of ${path}`);
		});

		const result = await pruneStaleWorktrees(project, { worktrees: manager });

		expect(result.pruned).toEqual([taskPath('1')]);
		expect(manager.cleanedUpTasks).toEqual(['1']);
	});

	// Nothing else sweeps these: every TTL in `host-local-runtime.ts` is evaluated by the
	// next provisioner for that same task, so a task never dispatched again keeps its
	// coordination debris forever (issue #721). This sweep already runs hourly.
	it('sweeps an expired host-local coordination artifact, and removes none under dryRun', async () => {
		const project = createMockProjectConfig({
			repoRoot,
			worktreeRoot: '.swarm-workspaces',
			worktreeRetention: { maxWorktrees: 1 },
		});
		// A preservation pin for a task nothing will dispatch again, well past its 24h TTL.
		const taskId = '555';
		const key = createHash('sha256').update(`${project.id}\0${taskId}`).digest('hex');
		const stateRoot = resolve(repoRoot, '.swarm-workspaces', '.swarm-state');
		const pin = join(stateRoot, `${key}.pin.json`);
		mkdirSync(stateRoot, { recursive: true });
		writeFileSync(
			pin,
			`${JSON.stringify({
				ownerKey: 'run-555',
				createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
				projectId: project.id,
				taskId: '555',
			})}\n`,
			'utf8',
		);

		const manager = new FakeGitWorktreeManager(project, retentionWorktreeRuntime(project));
		manager.setWorktreesList([]);

		const dry = await pruneStaleWorktrees(project, { worktrees: manager, dryRun: true });
		expect(dry.sweptState).toEqual([pin]);
		expect(existsSync(pin)).toBe(true);

		const result = await pruneStaleWorktrees(project, { worktrees: manager });
		expect(result.sweptState).toEqual([pin]);
		expect(existsSync(pin)).toBe(false);
	});
});
