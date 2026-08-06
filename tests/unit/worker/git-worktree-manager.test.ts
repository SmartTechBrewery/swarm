import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The module under test wraps `execFile` in `promisify`. `execFile` is
// callback-style and our mock carries no custom-promisify symbol, so
// `promisify` resolves with whatever we pass as the callback's second arg —
// i.e. `{ stdout, stderr }`. `gitHandler` lets each test decide the outcome of
// every git invocation; `gitCalls` records the exact argv for assertions.
const {
	claimWorktreeLeaseMock,
	releaseWorktreeLeaseMock,
	tryClaimWorktreeLeaseMock,
	isWorktreeLeasedMock,
	readWorktreeLeaseMock,
	takeOverWorktreeLeaseMock,
	hasResumableDeferredRunMock,
	hasLiveRunForTaskMock,
	hasExecutingDispatchForTaskMock,
} = vi.hoisted(() => ({
	claimWorktreeLeaseMock: vi.fn(),
	releaseWorktreeLeaseMock: vi.fn(),
	tryClaimWorktreeLeaseMock: vi.fn(),
	isWorktreeLeasedMock: vi.fn(),
	readWorktreeLeaseMock: vi.fn(),
	takeOverWorktreeLeaseMock: vi.fn(),
	hasResumableDeferredRunMock: vi.fn(),
	hasLiveRunForTaskMock: vi.fn(),
	hasExecutingDispatchForTaskMock: vi.fn(),
}));

vi.mock('@/worktree/worktree-lease.js', () => ({
	claimWorktreeLease: claimWorktreeLeaseMock,
	releaseWorktreeLease: releaseWorktreeLeaseMock,
	tryClaimWorktreeLease: tryClaimWorktreeLeaseMock,
	isWorktreeLeased: isWorktreeLeasedMock,
	readWorktreeLease: readWorktreeLeaseMock,
	takeOverWorktreeLease: takeOverWorktreeLeaseMock,
}));

// Consumed by the reclaim gate (`src/worktree/reclaim.ts`) to detect a resumable
// deferred/failed run pinning a colliding checkout, and by the lease-liveness
// check (`src/worktree/lease-liveness.ts`) to tell a live lease from an orphan.
vi.mock('@/db/repositories/runsRepository.js', () => ({
	hasResumableDeferredRun: hasResumableDeferredRunMock,
	hasLiveRunForTask: hasLiveRunForTaskMock,
}));

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	hasExecutingDispatchForTask: hasExecutingDispatchForTaskMock,
}));

type GitOutcome =
	| { stdout?: string; stderr?: string }
	| Error
	| Promise<{ stdout?: string; stderr?: string }>;
let gitHandler: (args: string[]) => GitOutcome;
const gitCalls: string[][] = [];
const gitOpts: unknown[] = [];

vi.mock('node:child_process', () => ({
	execFile: (
		_cmd: string,
		args: string[],
		opts: unknown,
		cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void,
	) => {
		gitCalls.push(args);
		gitOpts.push(opts);
		const outcome = gitHandler(args);
		if (outcome instanceof Error) {
			cb(outcome);
		} else if (outcome instanceof Promise) {
			outcome.then(
				(res) => cb(null, { stdout: res.stdout ?? '', stderr: res.stderr ?? '' }),
				(err) => cb(err),
			);
		} else {
			cb(null, { stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' });
		}
	},
}));

// Filesystem presence is fully controlled per test via `existingPaths`;
// `realpaths` overrides symlink resolution for the symlink-robustness test
// (default: identity).
let existingPaths: Set<string>;
let realpaths: Map<string, string>;
vi.mock('node:fs', () => ({
	existsSync: (p: string) => existingPaths.has(p),
	realpathSync: (p: string) => {
		const real = realpaths.get(p);
		if (real !== undefined) return real;
		if (existingPaths.has(p)) return p;
		throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
	},
}));

import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { BlockedRecoveryError } from '@/worktree/reclaim.js';

const REPO_ROOT = '/Users/dev/swarm/swarm';
const WORKTREE_14 = `${REPO_ROOT}/.swarm-workspaces/task-14`;

function makeManager(overrides = {}) {
	return new GitWorktreeManager(createMockProjectConfig({ repoRoot: REPO_ROOT, ...overrides }));
}

describe('GitWorktreeManager', () => {
	beforeEach(() => {
		gitCalls.length = 0;
		gitOpts.length = 0;
		gitHandler = (args) => {
			if (args[0] === 'symbolic-ref') return { stdout: 'issue-14\n' };
			return { stdout: '' };
		};
		claimWorktreeLeaseMock.mockReset();
		releaseWorktreeLeaseMock.mockReset();
		// Reclaim-gate defaults: the lease is free to acquire, no live lease, and no
		// resumable run pins the checkout — so a collision reclaims unless a test
		// says otherwise.
		tryClaimWorktreeLeaseMock.mockReset().mockResolvedValue(true);
		isWorktreeLeasedMock.mockReset().mockResolvedValue(false);
		hasResumableDeferredRunMock.mockReset().mockResolvedValue(false);
		// Lease-liveness defaults (issue #427): nothing owns a held lease, and a
		// take-over of one succeeds — only the tests that contend say otherwise.
		hasLiveRunForTaskMock.mockReset().mockResolvedValue(false);
		hasExecutingDispatchForTaskMock.mockReset().mockResolvedValue(false);
		readWorktreeLeaseMock.mockReset().mockResolvedValue('stale-token');
		takeOverWorktreeLeaseMock.mockReset().mockResolvedValue(true);
		// Default world: the repo root exists and is a git repo; no worktrees yet.
		existingPaths = new Set([REPO_ROOT]);
		realpaths = new Map();
	});

	describe('worktreePath', () => {
		it('resolves to <repoRoot>/<worktreeRoot>/task-<id>', () => {
			expect(makeManager().worktreePath('14')).toBe(WORKTREE_14);
		});
	});

	describe('reuse', () => {
		it('does not adopt an existing worktree when its delivery-progress guard rejects it', async () => {
			existingPaths.add(WORKTREE_14);

			await expect(
				makeManager().reuse('14', 'issue-14', false, () => false),
			).resolves.toBeUndefined();
			expect(claimWorktreeLeaseMock).not.toHaveBeenCalled();
		});
	});

	describe('provision', () => {
		it('sanity-checks, fetches, then creates a fresh branch off baseBranch by default', async () => {
			const handle = await makeManager().provision('14');

			expect(gitCalls).toEqual([
				['rev-parse', '--is-inside-work-tree'],
				// The sanity check also confirms this is the *assigned* repo (issue #535).
				['remote', 'get-url', 'origin'],
				['fetch', 'origin'],
				['branch', '--list', 'issue-14'],
				['worktree', 'add', '-b', 'issue-14', WORKTREE_14, 'main'],
			]);
			expect(handle).toEqual({
				taskId: '14',
				path: WORKTREE_14,
				branch: 'issue-14',
				detached: false,
			});
		});

		it('checks out baseBranch in detached HEAD when detach is set (planning phase)', async () => {
			const handle = await makeManager().provision('14', { detach: true });

			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '--detach', WORKTREE_14, 'main']);
			expect(handle).toEqual({
				taskId: '14',
				path: WORKTREE_14,
				branch: 'main',
				detached: true,
			});
		});

		it('detach takes precedence over createBranch and ignores an explicit branch', async () => {
			await makeManager().provision('14', {
				detach: true,
				createBranch: true,
				branch: 'ignored',
				baseBranch: 'develop',
			});
			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '--detach', WORKTREE_14, 'develop']);
		});

		it('checks out an existing branch when createBranch is false (review phase)', async () => {
			const handle = await makeManager().provision('14', {
				createBranch: false,
				branch: 'issue-14-some-feature',
			});

			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', WORKTREE_14, 'issue-14-some-feature']);
			expect(handle.branch).toBe('issue-14-some-feature');
		});

		it('honours explicit branch and baseBranch overrides', async () => {
			await makeManager().provision('14', { branch: 'hotfix', baseBranch: 'develop' });
			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '-b', 'hotfix', WORKTREE_14, 'develop']);
		});

		it('skips the fetch when fetch is false', async () => {
			await makeManager().provision('14', { fetch: false });
			expect(gitCalls.some((c) => c[0] === 'fetch')).toBe(false);
		});

		it('continues (best-effort) when git fetch fails', async () => {
			gitHandler = (args) => (args[0] === 'fetch' ? new Error('no remote') : { stdout: '' });
			const handle = await makeManager().provision('14');
			expect(handle.path).toBe(WORKTREE_14);
			expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(true);
		});

		it('throws when createBranch is false and no branch is given', async () => {
			await expect(makeManager().provision('14', { createBranch: false })).rejects.toThrow(
				/without an explicit 'branch'/,
			);
			expect(gitCalls.some((c) => c[1] === 'add')).toBe(false);
		});

		it('reclaims a safe stale checkout on collision and re-provisions (issue #367)', async () => {
			existingPaths.add(WORKTREE_14);
			const project = createMockProjectConfig({ id: 'project-1', repoRoot: REPO_ROOT });
			const handle = await new GitWorktreeManager(project).provision('14');

			// Atomically acquired the lease, removed the stale checkout, then re-added.
			expect(tryClaimWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '14', expect.any(String));
			expect(gitCalls).toContainEqual(['worktree', 'remove', '--force', WORKTREE_14]);
			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '-b', 'issue-14', WORKTREE_14, 'main']);
			expect(handle.path).toBe(WORKTREE_14);
			expect(releaseWorktreeLeaseMock).not.toHaveBeenCalled();
		});

		it('reclaims through the original provision options (existing branch checkout)', async () => {
			existingPaths.add(WORKTREE_14);
			await makeManager().provision('14', { createBranch: false, branch: 'issue-14-feature' });
			expect(gitCalls).toContainEqual(['worktree', 'remove', '--force', WORKTREE_14]);
			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', WORKTREE_14, 'issue-14-feature']);
		});

		it('blocks (live-leased) without removing when the lease cannot be acquired', async () => {
			existingPaths.add(WORKTREE_14);
			tryClaimWorktreeLeaseMock.mockResolvedValue(false);

			const err = await makeManager()
				.provision('14')
				.catch((e) => e);
			expect(err).toBeInstanceOf(BlockedRecoveryError);
			expect(err.reason).toBe('live-leased');
			expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
			expect(gitCalls.some((c) => c[1] === 'add')).toBe(false);
			// Never acquired, so nothing to release.
			expect(releaseWorktreeLeaseMock).not.toHaveBeenCalled();
		});

		it('reports real provisioning contention when no checkout exists yet', async () => {
			tryClaimWorktreeLeaseMock.mockResolvedValue(false);

			const err = await makeManager()
				.provision('14')
				.catch((error) => error);
			expect(err).toBeInstanceOf(BlockedRecoveryError);
			expect(err.message).toContain('provisioning');
			expect(err.message).toContain('already in progress');
			expect(err.message).not.toContain('existing checkout');
		});

		describe('stale-lease take-over (issue #427)', () => {
			const RUN_ID = 'run-abc';
			// Clean, on a branch, whose upstream is 2 commits behind local HEAD —
			// keyed by `<subcommand> <first arg>` so the handler stays a lookup.
			const UNPUSHED_BRANCH_STDOUT: Record<string, string> = {
				'symbolic-ref --short': 'issue-14\n',
				'rev-parse --abbrev-ref': 'origin/issue-14\n',
				'rev-list --count': '2\n',
			};

			it('adopts an ownerless lease and reclaims the safe checkout behind it', async () => {
				existingPaths.add(WORKTREE_14);
				tryClaimWorktreeLeaseMock.mockResolvedValue(false);
				const project = createMockProjectConfig({ id: 'project-1', repoRoot: REPO_ROOT });

				const handle = await new GitWorktreeManager(project).provision('14', { runId: RUN_ID });

				// Compare-and-set against the token actually observed, not a guess.
				expect(takeOverWorktreeLeaseMock).toHaveBeenCalledWith(
					'project-1',
					'14',
					'stale-token',
					expect.any(String),
				);
				expect(gitCalls).toContainEqual(['worktree', 'remove', '--force', WORKTREE_14]);
				expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '-b', 'issue-14', WORKTREE_14, 'main']);
				expect(handle.path).toBe(WORKTREE_14);
				expect(releaseWorktreeLeaseMock).not.toHaveBeenCalled();
			});

			it('provisions fresh for a bare orphan lease with no checkout on disk', async () => {
				tryClaimWorktreeLeaseMock.mockResolvedValue(false);

				const handle = await makeManager().provision('14', { runId: RUN_ID });

				expect(takeOverWorktreeLeaseMock).toHaveBeenCalled();
				expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
				expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '-b', 'issue-14', WORKTREE_14, 'main']);
				expect(handle.path).toBe(WORKTREE_14);
			});

			it('claims outright when the lease expired between the failed claim and the read', async () => {
				tryClaimWorktreeLeaseMock.mockResolvedValueOnce(false).mockResolvedValue(true);
				readWorktreeLeaseMock.mockResolvedValue(null);

				const handle = await makeManager().provision('14', { runId: RUN_ID });

				expect(takeOverWorktreeLeaseMock).not.toHaveBeenCalled();
				expect(handle.path).toBe(WORKTREE_14);
			});

			it('still blocks (live-leased) when another run for the task is running', async () => {
				existingPaths.add(WORKTREE_14);
				tryClaimWorktreeLeaseMock.mockResolvedValue(false);
				hasLiveRunForTaskMock.mockResolvedValue(true);

				const err = await makeManager()
					.provision('14', { runId: RUN_ID })
					.catch((e) => e);
				expect(err).toBeInstanceOf(BlockedRecoveryError);
				expect(err.reason).toBe('live-leased');
				expect(takeOverWorktreeLeaseMock).not.toHaveBeenCalled();
				expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
				expect(releaseWorktreeLeaseMock).not.toHaveBeenCalled();
			});

			it('still blocks (live-leased) when an executing dispatch owns the task', async () => {
				existingPaths.add(WORKTREE_14);
				tryClaimWorktreeLeaseMock.mockResolvedValue(false);
				hasExecutingDispatchForTaskMock.mockResolvedValue(true);

				const err = await makeManager()
					.provision('14', { runId: RUN_ID })
					.catch((e) => e);
				expect(err.reason).toBe('live-leased');
				expect(takeOverWorktreeLeaseMock).not.toHaveBeenCalled();
				expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
			});

			it('blocks (live-leased) when a concurrent claimant won the take-over race', async () => {
				existingPaths.add(WORKTREE_14);
				tryClaimWorktreeLeaseMock.mockResolvedValue(false);
				takeOverWorktreeLeaseMock.mockResolvedValue(false);

				const err = await makeManager()
					.provision('14', { runId: RUN_ID })
					.catch((e) => e);
				expect(err.reason).toBe('live-leased');
				expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
			});

			it('retains a dirty checkout behind an adopted stale lease', async () => {
				existingPaths.add(WORKTREE_14);
				tryClaimWorktreeLeaseMock.mockResolvedValue(false);
				gitHandler = (args) =>
					args[0] === 'status' && args[1] === '--porcelain'
						? { stdout: ' M file.ts\n' }
						: { stdout: '' };

				const err = await makeManager()
					.provision('14', { runId: RUN_ID })
					.catch((e) => e);
				expect(err).toBeInstanceOf(BlockedRecoveryError);
				expect(err.reason).toBe('dirty');
				expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
				// The adopted lease is handed back under our own token.
				expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('swarm', '14', expect.any(String));
			});

			it('retains a checkout with unpushed commits behind an adopted stale lease', async () => {
				existingPaths.add(WORKTREE_14);
				tryClaimWorktreeLeaseMock.mockResolvedValue(false);
				gitHandler = (args) => ({
					stdout: UNPUSHED_BRANCH_STDOUT[`${args[0]} ${args[1] ?? ''}`.trim()] ?? '',
				});

				const err = await makeManager()
					.provision('14', { runId: RUN_ID })
					.catch((e) => e);
				expect(err.reason).toBe('unpushed');
				expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
				expect(releaseWorktreeLeaseMock).toHaveBeenCalled();
			});

			it('does not consult liveness at all without a runId', async () => {
				existingPaths.add(WORKTREE_14);
				tryClaimWorktreeLeaseMock.mockResolvedValue(false);

				const err = await makeManager()
					.provision('14')
					.catch((e) => e);
				expect(err.reason).toBe('live-leased');
				expect(hasLiveRunForTaskMock).not.toHaveBeenCalled();
				expect(hasExecutingDispatchForTaskMock).not.toHaveBeenCalled();
				expect(takeOverWorktreeLeaseMock).not.toHaveBeenCalled();
			});
		});

		it('blocks (resumable-owner) and releases the held lease without removing', async () => {
			existingPaths.add(WORKTREE_14);
			hasResumableDeferredRunMock.mockResolvedValue(true);
			const project = createMockProjectConfig({ id: 'project-1', repoRoot: REPO_ROOT });

			const err = await new GitWorktreeManager(project).provision('14').catch((e) => e);
			expect(err).toBeInstanceOf(BlockedRecoveryError);
			expect(err.reason).toBe('resumable-owner');
			expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
			expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '14', expect.any(String));
		});

		it('blocks (dirty) and releases the held lease without removing', async () => {
			existingPaths.add(WORKTREE_14);
			gitHandler = (args) =>
				args[0] === 'status' && args[1] === '--porcelain'
					? { stdout: ' M file.ts\n' }
					: { stdout: '' };

			const err = await makeManager()
				.provision('14')
				.catch((e) => e);
			expect(err).toBeInstanceOf(BlockedRecoveryError);
			expect(err.reason).toBe('dirty');
			expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
			expect(releaseWorktreeLeaseMock).toHaveBeenCalled();
		});

		it('blocks (unpushed) and releases the held lease without removing', async () => {
			existingPaths.add(WORKTREE_14);
			// Clean, on a branch, whose upstream is 2 commits behind local HEAD.
			gitHandler = (args) => {
				if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: '' };
				if (args[0] === 'symbolic-ref') return { stdout: 'issue-14\n' };
				if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
					return { stdout: 'origin/issue-14\n' };
				}
				if (args[0] === 'rev-list' && args[1] === '--count') return { stdout: '2\n' };
				return { stdout: '' };
			};

			const err = await makeManager()
				.provision('14')
				.catch((e) => e);
			expect(err).toBeInstanceOf(BlockedRecoveryError);
			expect(err.reason).toBe('unpushed');
			expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
			expect(releaseWorktreeLeaseMock).toHaveBeenCalled();
		});

		it('releases the reclaim lease if re-provisioning fails after removal', async () => {
			existingPaths.add(WORKTREE_14);
			gitHandler = (args) => {
				if (args[0] === 'symbolic-ref') return { stdout: 'issue-14\n' };
				if (args[0] === 'worktree' && args[1] === 'add') {
					return Object.assign(new Error('exit 128'), { stderr: 'boom' });
				}
				return { stdout: '' };
			};
			const project = createMockProjectConfig({ id: 'project-1', repoRoot: REPO_ROOT });

			await expect(new GitWorktreeManager(project).provision('14')).rejects.toThrow(/boom/);
			expect(gitCalls).toContainEqual(['worktree', 'remove', '--force', WORKTREE_14]);
			expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '14', expect.any(String));
		});

		it('throws when the repo root does not exist', async () => {
			existingPaths = new Set();
			await expect(makeManager().provision('14')).rejects.toThrow(/repo root does not exist/);
			expect(gitCalls).toHaveLength(0);
		});

		it('throws when the repo root is not a git repository', async () => {
			gitHandler = (args) =>
				args[0] === 'rev-parse' ? new Error('fatal: not a git repository') : { stdout: '' };
			await expect(makeManager().provision('14')).rejects.toThrow(/Not a git repository/);
		});

		it('surfaces git stderr when worktree add fails', async () => {
			gitHandler = (args) => {
				if (args[1] === 'add') return Object.assign(new Error('exit 128'), { stderr: 'boom' });
				return { stdout: '' };
			};
			await expect(makeManager().provision('14')).rejects.toThrow(/git worktree add.*boom/);
		});

		it('deletes an orphaned local branch (no matching ref on origin) before retrying worktree add', async () => {
			gitHandler = (args) => {
				if (args[0] === 'branch' && args[1] === '--list') return { stdout: '  issue-14\n' };
				if (args[0] === 'ls-remote') return { stdout: '' };
				return { stdout: '' };
			};
			const handle = await makeManager().provision('14');

			expect(gitCalls).toContainEqual(['branch', '--list', 'issue-14']);
			expect(gitCalls).toContainEqual(['ls-remote', '--heads', 'origin', 'issue-14']);
			expect(gitCalls).toContainEqual(['branch', '-D', 'issue-14']);
			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '-b', 'issue-14', WORKTREE_14, 'main']);
			expect(handle.branch).toBe('issue-14');
		});

		it('leaves a local branch alone (and lets worktree add fail) when origin already has a matching ref', async () => {
			gitHandler = (args) => {
				if (args[0] === 'branch' && args[1] === '--list') return { stdout: '  issue-14\n' };
				if (args[0] === 'ls-remote') return { stdout: 'abc123\trefs/heads/issue-14\n' };
				if (args[0] === 'worktree' && args[1] === 'add') {
					return Object.assign(new Error('exit 128'), {
						stderr: "fatal: a branch named 'issue-14' already exists",
					});
				}
				return { stdout: '' };
			};

			await expect(makeManager().provision('14')).rejects.toThrow(/already exists/);
			expect(gitCalls.some((c) => c[0] === 'branch' && c[1] === '-D')).toBe(false);
		});

		it('leaves a local branch alone when the remote check itself fails (cannot verify)', async () => {
			gitHandler = (args) => {
				if (args[0] === 'branch' && args[1] === '--list') return { stdout: '  issue-14\n' };
				if (args[0] === 'ls-remote') return new Error('could not resolve host');
				if (args[0] === 'worktree' && args[1] === 'add') {
					return Object.assign(new Error('exit 128'), {
						stderr: "fatal: a branch named 'issue-14' already exists",
					});
				}
				return { stdout: '' };
			};

			await expect(makeManager().provision('14')).rejects.toThrow(/already exists/);
			expect(gitCalls.some((c) => c[0] === 'branch' && c[1] === '-D')).toBe(false);
		});

		it('skips the orphaned-branch check entirely for detached or existing-branch checkouts', async () => {
			await makeManager().provision('14', { detach: true });
			expect(gitCalls.some((c) => c[0] === 'branch')).toBe(false);

			gitCalls.length = 0;
			await makeManager().provision('14', { createBranch: false, branch: 'issue-14-x' });
			expect(gitCalls.some((c) => c[0] === 'branch')).toBe(false);
		});

		it('claims a worktree lease after successful provision', async () => {
			const project = createMockProjectConfig({ id: 'project-1' });
			const manager = new GitWorktreeManager(project);
			await manager.provision('14');
			expect(claimWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '14', expect.any(String));
		});

		it('concurrent provisions: only one succeeds and a failed loser cannot release the winner lease', async () => {
			existingPaths.add(WORKTREE_14);
			const project = createMockProjectConfig({ id: 'project-1', repoRoot: REPO_ROOT });
			const manager = new GitWorktreeManager(project);

			let activeLeaseToken: string | null = null;

			tryClaimWorktreeLeaseMock.mockImplementation(async (_projId, _tId, token) => {
				if (activeLeaseToken && activeLeaseToken !== token) {
					return false;
				}
				activeLeaseToken = token;
				return true;
			});

			releaseWorktreeLeaseMock.mockImplementation(async (_projId, _tId, token) => {
				if (token && activeLeaseToken === token) {
					activeLeaseToken = null;
				}
			});

			let resolveGitAddA!: () => void;
			const gitAddAPromise = new Promise<void>((resolve) => {
				resolveGitAddA = resolve;
			});

			let callCount = 0;
			gitHandler = (args) => {
				if (args[0] === 'symbolic-ref') return { stdout: 'issue-14\n' };
				if (args[0] === 'worktree' && args[1] === 'add') {
					callCount++;
					if (callCount === 1) {
						return gitAddAPromise.then(() => ({ stdout: '' }));
					}
				}
				return { stdout: '' };
			};

			const promiseA = manager.provision('14');

			await new Promise((r) => setTimeout(r, 10));
			const tokenA = activeLeaseToken;
			expect(tokenA).not.toBeNull();

			const promiseB = manager.provision('14');

			await expect(promiseB).rejects.toThrow(BlockedRecoveryError);
			expect(activeLeaseToken).toBe(tokenA);

			resolveGitAddA();
			const handleA = await promiseA;

			expect(handleA.path).toBe(WORKTREE_14);
			expect(activeLeaseToken).toBe(tokenA);
		});

		it('reclaims a safe pushed checkout and deletes the local branch ref before re-provisioning', async () => {
			existingPaths.add(WORKTREE_14);
			const project = createMockProjectConfig({ id: 'project-1', repoRoot: REPO_ROOT });
			const manager = new GitWorktreeManager(project);

			gitHandler = (args) => {
				if (args[0] === 'symbolic-ref') return { stdout: 'issue-14\n' };
				if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref')
					return { stdout: 'origin/issue-14\n' };
				if (args[0] === 'rev-list' && args[1] === '--count') return { stdout: '0\n' };
				if (args[0] === 'branch' && args[1] === '--list') return { stdout: '  issue-14\n' };
				if (args[0] === 'ls-remote') return { stdout: 'abc123\trefs/heads/issue-14\n' };
				return { stdout: '' };
			};

			const handle = await manager.provision('14');
			expect(handle.path).toBe(WORKTREE_14);
			expect(gitCalls).toContainEqual(['branch', '-D', 'issue-14']);
			expect(gitCalls.at(-1)).toEqual(['worktree', 'add', '-b', 'issue-14', WORKTREE_14, 'main']);
		});

		it('detached HEAD: blocks reclaim/retention if HEAD has unpushed commits, succeeds if reachable', async () => {
			const project = createMockProjectConfig({ id: 'project-1', repoRoot: REPO_ROOT });
			const manager = new GitWorktreeManager(project);

			gitHandler = (args) => {
				if (args[0] === 'symbolic-ref') {
					throw new Error('not a symbolic ref');
				}
				if (args[0] === 'branch' && args[1] === '-r' && args[2] === '--contains') {
					return { stdout: '' };
				}
				return { stdout: '' };
			};

			let hasUnpushed = await manager.hasUnpushedWork('14');
			expect(hasUnpushed).toBe(true);

			gitHandler = (args) => {
				if (args[0] === 'symbolic-ref') {
					throw new Error('not a symbolic ref');
				}
				if (args[0] === 'branch' && args[1] === '-r' && args[2] === '--contains') {
					return { stdout: '  origin/main\n  origin/issue-14\n' };
				}
				return { stdout: '' };
			};

			hasUnpushed = await manager.hasUnpushedWork('14');
			expect(hasUnpushed).toBe(false);

			existingPaths.add(WORKTREE_14);
			gitHandler = (args) => {
				if (args[0] === 'symbolic-ref') {
					throw new Error('not a symbolic ref');
				}
				if (args[0] === 'branch' && args[1] === '-r' && args[2] === '--contains') {
					return { stdout: '' };
				}
				return { stdout: '' };
			};

			const err = await manager.provision('14').catch((e) => e);
			expect(err).toBeInstanceOf(BlockedRecoveryError);
			expect(err.reason).toBe('unpushed');
			expect(gitCalls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false);
		});
	});

	describe('cleanup', () => {
		it('force-removes the worktree when it exists', async () => {
			existingPaths.add(WORKTREE_14);
			await makeManager().cleanup('14');
			expect(gitCalls).toEqual([['worktree', 'remove', '--force', WORKTREE_14]]);
		});

		it('is a no-op when the worktree is already gone', async () => {
			await makeManager().cleanup('14');
			expect(gitCalls).toHaveLength(0);
		});

		it('releases the worktree lease unconditionally', async () => {
			existingPaths.add(WORKTREE_14);
			const project = createMockProjectConfig({ id: 'project-1' });
			const manager = new GitWorktreeManager(project);
			await manager.cleanup('14');
			expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '14');

			// Also when the path does not exist
			existingPaths.delete(WORKTREE_14);
			releaseWorktreeLeaseMock.mockClear();
			await manager.cleanup('14');
			expect(releaseWorktreeLeaseMock).toHaveBeenCalledWith('project-1', '14');
		});
	});

	describe('isClean', () => {
		it('returns true when git status --porcelain is empty', async () => {
			gitHandler = (args) => {
				if (args[0] === 'status' && args[1] === '--porcelain') {
					return { stdout: '' };
				}
				return { stdout: '' };
			};
			const manager = makeManager();
			const result = await manager.isClean('14');
			expect(result).toBe(true);
			const lastCallIndex = gitCalls.findIndex((c) => c[0] === 'status');
			expect(gitOpts[lastCallIndex]).toEqual({ cwd: WORKTREE_14 });
		});

		it('excludes SWARM scratch artifacts so they do not block reclaim', async () => {
			gitHandler = (args) => {
				if (args[0] === 'status' && args[1] === '--porcelain') return { stdout: '' };
				return { stdout: '' };
			};
			const result = await makeManager().isClean('14');
			expect(result).toBe(true);
			expect(gitCalls.find((args) => args[0] === 'status')).toEqual([
				'status',
				'--porcelain',
				'--',
				'.',
				':(exclude)implementation_handoff.json',
				':(exclude)review_handoff.json',
				':(exclude)respond_to_review_handoff.json',
				':(exclude)respond_to_ci_handoff.json',
				':(exclude)resolve_conflicts_handoff.json',
				':(exclude)swarm_checkpoint.json',
				':(exclude).swarm_delivery.json',
			]);
		});

		it('returns false when git status --porcelain is non-empty', async () => {
			gitHandler = (args) => {
				if (args[0] === 'status' && args[1] === '--porcelain') {
					return { stdout: ' M package.json\n?? untracked.txt\n' };
				}
				return { stdout: '' };
			};
			const manager = makeManager();
			const result = await manager.isClean('14');
			expect(result).toBe(false);
		});

		it('returns false and does not throw when the git command errors', async () => {
			gitHandler = (args) => {
				if (args[0] === 'status' && args[1] === '--porcelain') {
					return new Error('git status failed');
				}
				return { stdout: '' };
			};
			const manager = makeManager();
			const result = await manager.isClean('14');
			expect(result).toBe(false);
		});
	});

	describe('list', () => {
		it('returns tracked worktrees excluding the main checkout', async () => {
			gitHandler = () => ({
				stdout: [
					`worktree ${REPO_ROOT}`,
					'HEAD abc123',
					'branch refs/heads/main',
					'',
					`worktree ${WORKTREE_14}`,
					'HEAD def456',
					'branch refs/heads/issue-14',
					'',
				].join('\n'),
			});
			expect(await makeManager().list()).toEqual([WORKTREE_14]);
		});

		it('excludes the main checkout even when repoRoot sits under a symlink', async () => {
			// repoRoot is given via a symlinked path (e.g. /tmp), but git reports the
			// realpath (/private/tmp). Canonicalizing both sides must still match, so
			// the main checkout is not leaked into the list.
			const SYMLINKED_ROOT = '/tmp/swarm/swarm';
			const REAL_ROOT = '/private/tmp/swarm/swarm';
			const REAL_WORKTREE = '/private/tmp/swarm/swarm/.swarm-workspaces/task-14';
			existingPaths = new Set([SYMLINKED_ROOT]);
			realpaths = new Map([[SYMLINKED_ROOT, REAL_ROOT]]);
			gitHandler = () => ({
				stdout: [
					`worktree ${REAL_ROOT}`,
					'HEAD abc123',
					'branch refs/heads/main',
					'',
					`worktree ${REAL_WORKTREE}`,
					'HEAD def456',
					'branch refs/heads/issue-14',
					'',
				].join('\n'),
			});
			expect(await makeManager({ repoRoot: SYMLINKED_ROOT }).list()).toEqual([REAL_WORKTREE]);
		});
	});

	// A remote worker resolves `repoRoot` from its own environment and reuses that
	// one path for every project it is enrolled in, so "is a git repo" is no longer
	// enough — it has to be the *assigned* repo (issue #535 review).
	describe('repo identity', () => {
		function handlerWithRemote(url: string | Error) {
			return (args: string[]) => {
				if (args[0] === 'remote') return url instanceof Error ? url : { stdout: `${url}\n` };
				if (args[0] === 'symbolic-ref') return { stdout: 'issue-14\n' };
				return { stdout: '' };
			};
		}

		it('refuses to provision in a checkout of a different repository', async () => {
			gitHandler = handlerWithRemote('git@github.com:someone-else/other-repo.git');

			await expect(makeManager().provision('14')).rejects.toThrow(
				/is a checkout of 'someone-else\/other-repo'/,
			);
		});

		it.each([
			['scp-style ssh', 'git@github.com:SmartTechBrewery/swarm.git'],
			['ssh url', 'ssh://git@github.com/SmartTechBrewery/swarm.git'],
			['https url', 'https://github.com/SmartTechBrewery/swarm'],
			['mixed case', 'https://github.com/smarttechbrewery/Swarm.git'],
		])('accepts the assigned repository via %s', async (_form, url) => {
			gitHandler = handlerWithRemote(url);

			await expect(makeManager().provision('14')).resolves.toMatchObject({ taskId: '14' });
		});

		it('skips verification when the checkout has no origin remote', async () => {
			// A local-only clone cannot be identified; refusing it would break every
			// fixture and every checkout that has not been pushed anywhere yet.
			gitHandler = handlerWithRemote(new Error('fatal: No such remote'));

			await expect(makeManager().provision('14')).resolves.toMatchObject({ taskId: '14' });
		});
	});
});
