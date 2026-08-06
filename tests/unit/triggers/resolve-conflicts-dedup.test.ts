import { beforeEach, describe, expect, it, vi } from 'vitest';

const { RedisMock, set, del, on } = vi.hoisted(() => {
	const set = vi.fn();
	const del = vi.fn();
	const on = vi.fn();
	const RedisMock = vi.fn(() => ({ set, del, on }));
	return { RedisMock, set, del, on };
});

vi.mock('ioredis', () => ({ Redis: RedisMock }));

beforeEach(() => {
	vi.resetModules();
	RedisMock.mockClear();
	set.mockReset();
	set.mockResolvedValue('OK');
	del.mockReset();
	del.mockResolvedValue(1);
	on.mockReset();
	process.env.REDIS_URL = 'redis://localhost:6379';
});

const NS = 'swarm:resolve-conflicts:';
const CLAIM_TTL_SEC = 24 * 60 * 60;

describe('resolve-conflicts dedup', () => {
	it('builds a stable key from the PR head/base state', async () => {
		const { buildConflictResolutionKey } = await import('@/triggers/resolve-conflicts-dedup.js');

		expect(buildConflictResolutionKey('acme/widgets', '42', 'head123', 'base456')).toBe(
			'acme/widgets:42:head123:base456',
		);
	});

	it('claims a state once with SET NX EX', async () => {
		const { claimConflictResolution } = await import('@/triggers/resolve-conflicts-dedup.js');

		expect(await claimConflictResolution('acme/widgets:42:head123:base456')).toBe(true);
		expect(set).toHaveBeenCalledWith(
			`${NS}acme/widgets:42:head123:base456`,
			'1',
			'EX',
			CLAIM_TTL_SEC,
			'NX',
		);
	});

	it('refreshes a pending claim without NX and preserves the longer state TTL', async () => {
		const { refreshConflictResolutionClaim } = await import(
			'@/triggers/resolve-conflicts-dedup.js'
		);

		await refreshConflictResolutionClaim('acme/widgets:42:head123:base456', 480);

		expect(set).toHaveBeenCalledWith(
			`${NS}acme/widgets:42:head123:base456`,
			'1',
			'EX',
			CLAIM_TTL_SEC,
		);
	});

	it('swallows refresh errors so the delayed retry remains the safety net', async () => {
		set.mockRejectedValue(new Error('ECONNREFUSED'));
		const { refreshConflictResolutionClaim } = await import(
			'@/triggers/resolve-conflicts-dedup.js'
		);

		await expect(
			refreshConflictResolutionClaim('acme/widgets:42:head123:base456', 480),
		).resolves.toBeUndefined();
	});

	it('releases a skipped claim so the same state can be claimed again', async () => {
		const { claimConflictResolution, releaseConflictResolution } = await import(
			'@/triggers/resolve-conflicts-dedup.js'
		);
		const key = 'acme/widgets:42:head123:base456';

		await claimConflictResolution(key);
		await releaseConflictResolution(key);
		await claimConflictResolution(key);

		expect(del).toHaveBeenCalledWith(`${NS}${key}`);
		expect(set).toHaveBeenCalledTimes(2);
	});
});
