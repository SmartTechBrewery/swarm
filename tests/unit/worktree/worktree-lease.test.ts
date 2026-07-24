import { beforeEach, describe, expect, it, vi } from 'vitest';

const { RedisMock, set, del, exists, get, evalScript, on } = vi.hoisted(() => {
	const set = vi.fn();
	const del = vi.fn();
	const exists = vi.fn();
	const get = vi.fn();
	const evalScript = vi.fn();
	const on = vi.fn();
	const RedisMock = vi.fn(() => ({ set, del, exists, get, eval: evalScript, on }));
	return { RedisMock, set, del, exists, get, evalScript, on };
});

vi.mock('ioredis', () => ({ Redis: RedisMock }));

beforeEach(() => {
	vi.resetModules();
	RedisMock.mockClear();
	set.mockReset();
	set.mockResolvedValue('OK');
	del.mockReset();
	del.mockResolvedValue(1);
	exists.mockReset();
	exists.mockResolvedValue(0);
	get.mockReset();
	get.mockResolvedValue(null);
	evalScript.mockReset();
	evalScript.mockResolvedValue(1);
	on.mockReset();
	process.env.REDIS_URL = 'redis://localhost:6379';
});

const NS = 'swarm:worktree-lease:';

describe('buildLeaseKey', () => {
	it('joins projectId and taskId', async () => {
		const { buildLeaseKey } = await import('@/worktree/worktree-lease.js');
		expect(buildLeaseKey('project-1', 'task-2')).toBe('project-1:task-2');
	});
});

describe('claimWorktreeLease', () => {
	it('claims with SET key 1 EX 14400', async () => {
		const { claimWorktreeLease } = await import('@/worktree/worktree-lease.js');

		await claimWorktreeLease('project-1', 'task-2');

		expect(set).toHaveBeenCalledWith(`${NS}project-1:task-2`, '1', 'EX', 14400);
	});

	it('swallows errors and does not throw', async () => {
		set.mockRejectedValue(new Error('ECONNREFUSED'));
		const { claimWorktreeLease } = await import('@/worktree/worktree-lease.js');

		await expect(claimWorktreeLease('project-1', 'task-2')).resolves.toBeUndefined();
	});
});

describe('releaseWorktreeLease', () => {
	it('deletes the namespaced key', async () => {
		const { releaseWorktreeLease } = await import('@/worktree/worktree-lease.js');

		await releaseWorktreeLease('project-1', 'task-2');

		expect(del).toHaveBeenCalledWith(`${NS}project-1:task-2`);
	});

	it('swallows errors and does not throw', async () => {
		del.mockRejectedValue(new Error('ECONNREFUSED'));
		const { releaseWorktreeLease } = await import('@/worktree/worktree-lease.js');

		await expect(releaseWorktreeLease('project-1', 'task-2')).resolves.toBeUndefined();
	});
});

describe('isWorktreeLeased', () => {
	it('returns true when EXISTS returns 1', async () => {
		exists.mockResolvedValue(1);
		const { isWorktreeLeased } = await import('@/worktree/worktree-lease.js');

		const leased = await isWorktreeLeased('project-1', 'task-2');

		expect(leased).toBe(true);
		expect(exists).toHaveBeenCalledWith(`${NS}project-1:task-2`);
	});

	it('returns false when EXISTS returns 0', async () => {
		exists.mockResolvedValue(0);
		const { isWorktreeLeased } = await import('@/worktree/worktree-lease.js');

		const leased = await isWorktreeLeased('project-1', 'task-2');

		expect(leased).toBe(false);
	});

	it('fails closed (returns true) when the check throws', async () => {
		exists.mockRejectedValue(new Error('ECONNREFUSED'));
		const { isWorktreeLeased } = await import('@/worktree/worktree-lease.js');

		const leased = await isWorktreeLeased('project-1', 'task-2');

		expect(leased).toBe(true);
	});
});

describe('readWorktreeLease', () => {
	it('returns the held token', async () => {
		get.mockResolvedValue('token-abc');
		const { readWorktreeLease } = await import('@/worktree/worktree-lease.js');

		expect(await readWorktreeLease('project-1', 'task-2')).toBe('token-abc');
		expect(get).toHaveBeenCalledWith(`${NS}project-1:task-2`);
	});

	it('returns null when the lease is free', async () => {
		const { readWorktreeLease } = await import('@/worktree/worktree-lease.js');

		expect(await readWorktreeLease('project-1', 'task-2')).toBeNull();
	});

	it('returns null when the read throws', async () => {
		get.mockRejectedValue(new Error('ECONNREFUSED'));
		const { readWorktreeLease } = await import('@/worktree/worktree-lease.js');

		expect(await readWorktreeLease('project-1', 'task-2')).toBeNull();
	});
});

describe('takeOverWorktreeLease', () => {
	it('compare-and-sets the observed token to ours on a fresh TTL', async () => {
		const { takeOverWorktreeLease } = await import('@/worktree/worktree-lease.js');

		expect(await takeOverWorktreeLease('project-1', 'task-2', 'stale', 'mine')).toBe(true);
		expect(evalScript).toHaveBeenCalledWith(
			expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"),
			1,
			`${NS}project-1:task-2`,
			'stale',
			'mine',
			'14400',
		);
	});

	it('fails closed when the lease no longer holds the expected token', async () => {
		evalScript.mockResolvedValue(0);
		const { takeOverWorktreeLease } = await import('@/worktree/worktree-lease.js');

		expect(await takeOverWorktreeLease('project-1', 'task-2', 'stale', 'mine')).toBe(false);
	});

	it('fails closed when the take-over throws', async () => {
		evalScript.mockRejectedValue(new Error('ECONNREFUSED'));
		const { takeOverWorktreeLease } = await import('@/worktree/worktree-lease.js');

		expect(await takeOverWorktreeLease('project-1', 'task-2', 'stale', 'mine')).toBe(false);
	});
});
