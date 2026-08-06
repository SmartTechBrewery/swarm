import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ioredis so nothing touches a real Redis. The helper claims via a
// MULTI/EXEC pipeline — `multi()` returns a chainable that records incr()/expire()
// and resolves on exec() — so the mock mirrors that fluent shape. `incr`/`expire`
// are spies on the chain; `execResult` is what exec() resolves to (the per-command
// `[err, res]` tuples). Hoisted so the vi.mock factory (itself hoisted above
// imports) can reference them.
const { RedisMock, incr, eval_, expire, exec, on, setExecResult } = vi.hoisted(() => {
	let execResult: unknown = [
		[null, 1],
		[null, 1],
	];
	const setExecResult = (r: unknown) => {
		execResult = r;
	};
	const exec = vi.fn(() => Promise.resolve(execResult));
	const eval_ = vi.fn().mockResolvedValue(1);
	const chain = { incr: vi.fn(), expire: vi.fn(), exec };
	chain.incr.mockReturnValue(chain);
	chain.expire.mockReturnValue(chain);
	const multi = vi.fn(() => chain);
	const on = vi.fn();
	const RedisMock = vi.fn(() => ({ multi, eval: eval_, on }));
	return { RedisMock, incr: chain.incr, eval_, expire: chain.expire, exec, on, setExecResult };
});

vi.mock('ioredis', () => ({ Redis: RedisMock }));

// The helper holds a lazy Redis singleton at module scope; resetModules gives
// each test a fresh one so "constructed once" assertions don't cross-pollute.
beforeEach(() => {
	vi.resetModules();
	RedisMock.mockClear();
	// Clear call history but keep the chain-returning behaviour so `.incr().expire()`
	// stays fluent; exec() defaults to a successful INCR→1, EXPIRE→1 pair.
	incr.mockClear();
	eval_.mockClear();
	eval_.mockResolvedValue(1);
	expire.mockClear();
	exec.mockClear();
	setExecResult([
		[null, 1],
		[null, 1],
	]);
	on.mockReset();
	process.env.REDIS_URL = 'redis://localhost:6379';
});

// Mirror the exec() result an ioredis MULTI produces: `[err, value]` tuples, the
// first being the INCR result. Only the INCR count varies across these cases.
const execOk = (incrValue: number) => [
	[null, incrValue],
	[null, 1],
];

const NS = 'swarm:respond-to-ci-attempts:';
const CTX = { prNumber: '42', headSha: 'abc' };

describe('buildRespondToCiAttemptKey', () => {
	it('joins owner/repo and PR number', async () => {
		const { buildRespondToCiAttemptKey } = await import('@/triggers/respond-to-ci-attempts.js');
		expect(buildRespondToCiAttemptKey('acme/widgets', '42')).toBe('acme/widgets:42');
	});
});

describe('claimRespondToCiAttempt', () => {
	it('increments the namespaced key and refreshes its TTL atomically, and allows an attempt under the cap', async () => {
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');

		const claim = await claimRespondToCiAttempt('acme/widgets:42', CTX);

		expect(claim).toEqual({ allowed: true, attempt: 1 });
		// INCR and EXPIRE are queued on one MULTI so a crash can't split them.
		expect(incr).toHaveBeenCalledWith(`${NS}acme/widgets:42`);
		expect(expire).toHaveBeenCalledWith(`${NS}acme/widgets:42`, 3600);
		expect(exec).toHaveBeenCalledOnce();
	});

	it('allows the attempt exactly at the cap', async () => {
		setExecResult(execOk(3));
		const { claimRespondToCiAttempt, MAX_FIX_ATTEMPTS } = await import(
			'@/triggers/respond-to-ci-attempts.js'
		);
		expect(MAX_FIX_ATTEMPTS).toBe(3);
		expect(await claimRespondToCiAttempt('acme/widgets:42', CTX)).toEqual({
			allowed: true,
			attempt: 3,
		});
	});

	it('denies the attempt once the counter exceeds the cap', async () => {
		setExecResult(execOk(4));
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		expect(await claimRespondToCiAttempt('acme/widgets:42', CTX)).toEqual({
			allowed: false,
			attempt: 4,
		});
	});

	it('fails OPEN (allows) when the MULTI/EXEC rejects — a blip must not disable CI-fix', async () => {
		exec.mockRejectedValueOnce(new Error('ECONNREFUSED'));
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		expect(await claimRespondToCiAttempt('acme/widgets:42', CTX)).toEqual({
			allowed: true,
			attempt: 0,
		});
	});

	it('fails OPEN when the MULTI is discarded (exec resolves null)', async () => {
		setExecResult(null);
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		expect(await claimRespondToCiAttempt('acme/widgets:42', CTX)).toEqual({
			allowed: true,
			attempt: 0,
		});
	});

	it('fails OPEN when the INCR command itself errored inside the MULTI', async () => {
		setExecResult([
			[new Error('WRONGTYPE'), null],
			[null, 1],
		]);
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		expect(await claimRespondToCiAttempt('acme/widgets:42', CTX)).toEqual({
			allowed: true,
			attempt: 0,
		});
	});

	it('fails open when REDIS_URL is unset (client construction throws)', async () => {
		process.env.REDIS_URL = '';
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		expect(await claimRespondToCiAttempt('acme/widgets:42', CTX)).toEqual({
			allowed: true,
			attempt: 0,
		});
		expect(incr).not.toHaveBeenCalled();
	});

	it('reuses the one Redis singleton across claims', async () => {
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		await claimRespondToCiAttempt('acme/widgets:1', { prNumber: '1', headSha: 'a' });
		await claimRespondToCiAttempt('acme/widgets:2', { prNumber: '2', headSha: 'b' });
		expect(RedisMock).toHaveBeenCalledOnce();
		expect(incr).toHaveBeenCalledTimes(2);
	});

	it('constructs the client fail-fast: caps retries and registers an error listener', async () => {
		const { claimRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		await claimRespondToCiAttempt('acme/widgets:1', { prNumber: '1', headSha: 'a' });
		expect(RedisMock).toHaveBeenCalledWith(expect.objectContaining({ maxRetriesPerRequest: 1 }));
		expect(on).toHaveBeenCalledWith('error', expect.any(Function));
	});
});

describe('releaseRespondToCiAttempt', () => {
	it('atomically returns a skipped pre-gate attempt without deleting a concurrent later claim', async () => {
		const { releaseRespondToCiAttempt } = await import('@/triggers/respond-to-ci-attempts.js');
		await releaseRespondToCiAttempt('acme/widgets:42');
		expect(eval_).toHaveBeenCalledWith(
			expect.stringContaining("redis.call('GET'"),
			1,
			`${NS}acme/widgets:42`,
		);
	});
});
