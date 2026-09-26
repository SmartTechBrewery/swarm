import { beforeEach, describe, expect, it, vi } from 'vitest';

type DispatchLookup = { state: string } | undefined;

// A small in-memory stand-in for the four Redis commands the claim uses, so the
// owner-binding decisions (issue #1047) are exercised against state rather than
// against a scripted sequence of replies. The Lua take-over is emulated from its
// arguments; `tests/integration/dispatch/resolve-conflicts-claim.test.ts` runs
// the real script against real Redis.
const { RedisMock, store, set, get, del, evalScript, on, getDispatchById } = vi.hoisted(() => {
	const store = new Map<string, string>();
	const set = vi.fn(async (key: string, value: string, ...args: unknown[]) => {
		if (args.includes('NX') && store.has(key)) return null;
		store.set(key, value);
		return 'OK';
	});
	const get = vi.fn(async (key: string) => store.get(key) ?? null);
	const del = vi.fn(async (key: string) => (store.delete(key) ? 1 : 0));
	const evalScript = vi.fn(
		async (_script: string, _numKeys: number, key: string, expected: string, value: string) => {
			if (store.get(key) !== expected) return 0;
			store.set(key, value);
			return 1;
		},
	);
	const on = vi.fn();
	const RedisMock = vi.fn(() => ({ set, get, del, eval: evalScript, on }));
	const getDispatchById = vi.fn<(id: string) => Promise<DispatchLookup>>();
	return { RedisMock, store, set, get, del, evalScript, on, getDispatchById };
});

vi.mock('ioredis', () => ({ Redis: RedisMock }));
vi.mock('@/db/repositories/dispatchesRepository.js', async (importOriginal) => ({
	ACTIVE_DISPATCH_STATES: (
		await importOriginal<typeof import('@/db/repositories/dispatchesRepository.js')>()
	).ACTIVE_DISPATCH_STATES,
	getDispatchById: (id: string) => getDispatchById(id),
}));

const NS = 'swarm:resolve-conflicts:';
const CLAIM_TTL_SEC = 24 * 60 * 60;
const KEY = 'acme/widgets:42:head123:base456';
const HOLDER = '11111111-1111-4111-8111-111111111111';
const CLAIMANT = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
	vi.resetModules();
	RedisMock.mockClear();
	store.clear();
	set.mockClear();
	get.mockClear();
	del.mockClear();
	evalScript.mockClear();
	on.mockReset();
	getDispatchById.mockReset();
	process.env.REDIS_URL = 'redis://localhost:6379';
});

async function load() {
	return import('@/triggers/resolve-conflicts-dedup.js');
}

describe('resolve-conflicts dedup', () => {
	it('builds a stable key from the PR head/base state', async () => {
		const { buildConflictResolutionKey } = await load();

		expect(buildConflictResolutionKey('acme/widgets', '42', 'head123', 'base456')).toBe(KEY);
	});

	it('claims a free state with SET NX EX, recording the claiming dispatch as its owner', async () => {
		const { claimConflictResolution } = await load();

		expect(await claimConflictResolution(KEY, CLAIMANT)).toBe(true);
		expect(set).toHaveBeenCalledWith(`${NS}${KEY}`, CLAIMANT, 'EX', CLAIM_TTL_SEC, 'NX');
		expect(getDispatchById).not.toHaveBeenCalled();
	});

	it('refuses a second dispatch while the holder is still active', async () => {
		const { claimConflictResolution } = await load();
		await claimConflictResolution(KEY, HOLDER);

		for (const state of ['pending', 'retry-scheduled', 'leased', 'running']) {
			getDispatchById.mockResolvedValueOnce({ state });
			expect(await claimConflictResolution(KEY, CLAIMANT)).toBe(false);
		}
		expect(store.get(`${NS}${KEY}`)).toBe(HOLDER);
		expect(evalScript).not.toHaveBeenCalled();
	});

	it('takes over a claim whose holder has settled terminally', async () => {
		const { claimConflictResolution } = await load();

		// `superseded` is a `completed` outcome; a reap or a restart settles `failed`.
		for (const state of ['completed', 'failed', 'cancelled']) {
			store.set(`${NS}${KEY}`, HOLDER);
			getDispatchById.mockResolvedValueOnce({ state });

			expect(await claimConflictResolution(KEY, CLAIMANT)).toBe(true);
			expect(getDispatchById).toHaveBeenLastCalledWith(HOLDER);
			expect(store.get(`${NS}${KEY}`)).toBe(CLAIMANT);
		}
		expect(evalScript).toHaveBeenLastCalledWith(
			expect.any(String),
			1,
			`${NS}${KEY}`,
			HOLDER,
			CLAIMANT,
			String(CLAIM_TTL_SEC),
		);
	});

	it('takes over a claim whose holder row no longer exists', async () => {
		const { claimConflictResolution } = await load();
		store.set(`${NS}${KEY}`, HOLDER);
		getDispatchById.mockResolvedValueOnce(undefined);

		expect(await claimConflictResolution(KEY, CLAIMANT)).toBe(true);
		expect(store.get(`${NS}${KEY}`)).toBe(CLAIMANT);
	});

	it('lets exactly one of two claimants replace the same dead holder', async () => {
		const { claimConflictResolution } = await load();
		store.set(`${NS}${KEY}`, HOLDER);
		getDispatchById.mockResolvedValue({ state: 'completed' });
		const rival = '33333333-3333-4333-8333-333333333333';

		const results = await Promise.all([
			claimConflictResolution(KEY, CLAIMANT),
			claimConflictResolution(KEY, rival),
		]);

		expect(results.filter(Boolean)).toHaveLength(1);
		expect([CLAIMANT, rival]).toContain(store.get(`${NS}${KEY}`));
	});

	it('grants the holding dispatch its own claim again without consulting the database', async () => {
		const { claimConflictResolution } = await load();
		await claimConflictResolution(KEY, HOLDER);

		expect(await claimConflictResolution(KEY, HOLDER)).toBe(true);
		expect(getDispatchById).not.toHaveBeenCalled();
	});

	it('claims normally when the held claim lapses between the two reads', async () => {
		set.mockResolvedValueOnce(null);
		const { claimConflictResolution } = await load();

		expect(await claimConflictResolution(KEY, CLAIMANT)).toBe(true);
		expect(set).toHaveBeenCalledTimes(2);
		expect(store.get(`${NS}${KEY}`)).toBe(CLAIMANT);
	});

	it('keeps an ownerless claim written before owners were recorded until its TTL', async () => {
		const { claimConflictResolution } = await load();
		store.set(`${NS}${KEY}`, '1');

		expect(await claimConflictResolution(KEY, CLAIMANT)).toBe(false);
		expect(getDispatchById).not.toHaveBeenCalled();
		expect(store.get(`${NS}${KEY}`)).toBe('1');
	});

	it('fails closed when the holder cannot be read from the database', async () => {
		const { claimConflictResolution } = await load();
		store.set(`${NS}${KEY}`, HOLDER);
		getDispatchById.mockRejectedValueOnce(new Error('connection terminated'));

		expect(await claimConflictResolution(KEY, CLAIMANT)).toBe(false);
		expect(store.get(`${NS}${KEY}`)).toBe(HOLDER);
	});

	it('fails closed on a Redis error', async () => {
		set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		const { claimConflictResolution } = await load();

		expect(await claimConflictResolution(KEY, CLAIMANT)).toBe(false);
	});

	it('refreshes a pending claim without NX, stamps the waiting dispatch and preserves the longer state TTL', async () => {
		const { refreshConflictResolutionClaim } = await load();

		await refreshConflictResolutionClaim(KEY, 480, HOLDER);

		expect(set).toHaveBeenCalledWith(`${NS}${KEY}`, HOLDER, 'EX', CLAIM_TTL_SEC);
	});

	it('swallows refresh errors so the delayed retry remains the safety net', async () => {
		set.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		const { refreshConflictResolutionClaim } = await load();

		await expect(refreshConflictResolutionClaim(KEY, 480, HOLDER)).resolves.toBeUndefined();
	});

	it('releases a skipped claim so the same state can be claimed again', async () => {
		const { claimConflictResolution, releaseConflictResolution } = await load();

		await claimConflictResolution(KEY, HOLDER);
		await releaseConflictResolution(KEY);

		expect(del).toHaveBeenCalledWith(`${NS}${KEY}`);
		expect(await claimConflictResolution(KEY, CLAIMANT)).toBe(true);
		expect(getDispatchById).not.toHaveBeenCalled();
	});
});
