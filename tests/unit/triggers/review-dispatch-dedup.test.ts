import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ioredis so nothing touches a real Redis — capture the constructor and the
// set()/del() calls the helper makes. Hoisted so the vi.mock factory (itself
// hoisted above imports) can reference them.
const { RedisMock, set, del, on, ttl, evalScript } = vi.hoisted(() => {
	const set = vi.fn();
	const del = vi.fn();
	const on = vi.fn();
	const ttl = vi.fn();
	const evalScript = vi.fn();
	const RedisMock = vi.fn(() => ({ set, del, on, ttl, eval: evalScript }));
	return { RedisMock, set, del, on, ttl, evalScript };
});

vi.mock('ioredis', () => ({ Redis: RedisMock }));

// The helper holds a lazy Redis singleton at module scope; resetModules gives
// each test a fresh one so "constructed once" assertions don't cross-pollute.
beforeEach(() => {
	vi.resetModules();
	RedisMock.mockClear();
	set.mockReset();
	set.mockResolvedValue('OK');
	del.mockReset();
	del.mockResolvedValue(1);
	on.mockReset();
	ttl.mockReset();
	ttl.mockResolvedValue(-2);
	evalScript.mockReset();
	evalScript.mockResolvedValue(1);
	process.env.REDIS_URL = 'redis://localhost:6379';
});

const NS = 'swarm:review-dedup:';

describe('buildReviewDispatchKey', () => {
	it('joins owner/repo, PR number, and head SHA', async () => {
		const { buildReviewDispatchKey } = await import('@/triggers/review-dispatch-dedup.js');
		expect(buildReviewDispatchKey('acme/widgets', '42', 'abc123')).toBe('acme/widgets:42:abc123');
	});
});

// Issue #1019 — read only so a declined dispatch can tell the operator which
// slot is held and for how long, instead of blaming their board.
describe('reviewDispatchClaimTtlSec', () => {
	it('reports the live claim\u2019s remaining lease from the namespaced key', async () => {
		ttl.mockResolvedValue(252);
		const { reviewDispatchClaimTtlSec } = await import('@/triggers/review-dispatch-dedup.js');

		await expect(reviewDispatchClaimTtlSec('acme/widgets:42:abc')).resolves.toBe(252);
		expect(ttl).toHaveBeenCalledWith(`${NS}acme/widgets:42:abc`);
	});

	// `-2` (no such key) and `-1` (no expiry) are not waits an operator can sit out.
	it.each([-2, -1, 0])('reports nothing for a TTL of %s', async (answer) => {
		ttl.mockResolvedValue(answer);
		const { reviewDispatchClaimTtlSec } = await import('@/triggers/review-dispatch-dedup.js');

		await expect(reviewDispatchClaimTtlSec('acme/widgets:42:abc')).resolves.toBeUndefined();
	});

	it('reports nothing when the read throws', async () => {
		ttl.mockRejectedValue(new Error('ECONNREFUSED'));
		const { reviewDispatchClaimTtlSec } = await import('@/triggers/review-dispatch-dedup.js');

		await expect(reviewDispatchClaimTtlSec('acme/widgets:42:abc')).resolves.toBeUndefined();
	});
});

describe('claimReviewDispatch', () => {
	it('claims with SET NX EX on the namespaced key and returns true', async () => {
		const { claimReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		const claimed = await claimReviewDispatch('acme/widgets:42:abc', 'pr-review', {
			prNumber: '42',
			headSha: 'abc',
		});

		expect(claimed).toBe(true);
		expect(set).toHaveBeenCalledWith(`${NS}acme/widgets:42:abc`, 'pr-review', 'EX', 300, 'NX');
	});

	// Issue #1105: the owner token, when given, is the stored value the
	// owner-fenced release compares against.
	it('stores the owner token as the claim value when one is given', async () => {
		const { claimReviewDispatch, reviewDispatchClaimOwner } = await import(
			'@/triggers/review-dispatch-dedup.js'
		);

		await claimReviewDispatch('acme/widgets:42:abc', 'pr-review', {
			prNumber: '42',
			headSha: 'abc',
			owner: reviewDispatchClaimOwner('dispatch-7'),
		});

		expect(set).toHaveBeenCalledWith(
			`${NS}acme/widgets:42:abc`,
			'pr-review:dispatch-7',
			'EX',
			300,
			'NX',
		);
	});

	// Issue #1430: merge automation's updated-head claim takes its longer lease in
	// the claim itself, so the owner token it is recognised by is never rewritten.
	it('takes the lease a holder asks for in the same SET NX', async () => {
		const { claimReviewDispatch, MERGE_AUTOMATION_CLAIM_OWNER } = await import(
			'@/triggers/review-dispatch-dedup.js'
		);

		await claimReviewDispatch('acme/widgets:42:abc', 'merge-automation', {
			prNumber: '42',
			headSha: 'abc',
			owner: MERGE_AUTOMATION_CLAIM_OWNER,
			ttlSec: 900,
		});

		expect(set).toHaveBeenCalledExactlyOnceWith(
			`${NS}acme/widgets:42:abc`,
			'merge-automation',
			'EX',
			900,
			'NX',
		);
	});

	it('returns false when the key is already claimed (SET NX returns null)', async () => {
		set.mockResolvedValue(null);
		const { claimReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		const claimed = await claimReviewDispatch('acme/widgets:42:abc', 'pr-review', {
			prNumber: '42',
			headSha: 'abc',
		});

		expect(claimed).toBe(false);
	});

	it('fails closed (returns false) when the Redis call throws', async () => {
		set.mockRejectedValue(new Error('ECONNREFUSED'));
		const { claimReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		const claimed = await claimReviewDispatch('acme/widgets:42:abc', 'pr-review', {
			prNumber: '42',
			headSha: 'abc',
		});

		expect(claimed).toBe(false);
	});

	it('fails closed when REDIS_URL is unset (client construction throws)', async () => {
		process.env.REDIS_URL = '';
		const { claimReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		const claimed = await claimReviewDispatch('acme/widgets:42:abc', 'pr-review', {
			prNumber: '42',
			headSha: 'abc',
		});

		expect(claimed).toBe(false);
		expect(set).not.toHaveBeenCalled();
	});

	it('reuses the one Redis singleton across claims', async () => {
		const { claimReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		await claimReviewDispatch('acme/widgets:1:a', 'pr-review', { prNumber: '1', headSha: 'a' });
		await claimReviewDispatch('acme/widgets:2:b', 'pr-review', { prNumber: '2', headSha: 'b' });

		expect(RedisMock).toHaveBeenCalledOnce();
		expect(set).toHaveBeenCalledTimes(2);
	});

	// The fail-fast mechanism is exactly two things: capping retries so an
	// unreachable Redis rejects instead of hanging, and an 'error' listener so
	// reconnect failures don't crash the process. Pin both to the constructor.
	it('constructs the client fail-fast: caps retries and registers an error listener', async () => {
		const { claimReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		await claimReviewDispatch('acme/widgets:1:a', 'pr-review', { prNumber: '1', headSha: 'a' });

		expect(RedisMock).toHaveBeenCalledOnce();
		expect(RedisMock).toHaveBeenCalledWith(expect.objectContaining({ maxRetriesPerRequest: 1 }));
		expect(on).toHaveBeenCalledWith('error', expect.any(Function));
	});
});

describe('releaseReviewDispatch', () => {
	it('deletes the namespaced key', async () => {
		const { releaseReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		await releaseReviewDispatch('acme/widgets:42:abc');

		expect(del).toHaveBeenCalledWith(`${NS}acme/widgets:42:abc`);
	});

	it('swallows Redis errors (TTL is the safety net)', async () => {
		del.mockRejectedValue(new Error('ECONNREFUSED'));
		const { releaseReviewDispatch } = await import('@/triggers/review-dispatch-dedup.js');

		await expect(releaseReviewDispatch('acme/widgets:42:abc')).resolves.toBeUndefined();
	});
});

// Issue #1105: a late hand-back must not erase a claim a later dispatch re-took
// after this one's lapsed.
describe('releaseReviewDispatchHeldBy', () => {
	it('compare-and-deletes the namespaced key against the owner token', async () => {
		const { releaseReviewDispatchHeldBy } = await import('@/triggers/review-dispatch-dedup.js');

		await releaseReviewDispatchHeldBy('acme/widgets:42:abc', 'pr-review:dispatch-7');

		expect(evalScript).toHaveBeenCalledWith(
			expect.stringContaining('v == ARGV[1] or v == ARGV[1] .. ARGV[2]'),
			1,
			`${NS}acme/widgets:42:abc`,
			'pr-review:dispatch-7',
			// The owner's token still matches once marked as taken without checks (#1270).
			':no-checks',
		);
		expect(del).not.toHaveBeenCalled();
	});

	it('swallows Redis errors (TTL is the safety net)', async () => {
		evalScript.mockRejectedValue(new Error('ECONNREFUSED'));
		const { releaseReviewDispatchHeldBy } = await import('@/triggers/review-dispatch-dedup.js');

		await expect(
			releaseReviewDispatchHeldBy('acme/widgets:42:abc', 'pr-review:dispatch-7'),
		).resolves.toBeUndefined();
	});
});

/**
 * The extend-without-re-claiming counterpart: a deferred continuation, a running
 * CI fix, and the `no-fix` hand-over all hold the slot for longer than the
 * default TTL and re-enter without re-claiming.
 */
describe('refreshReviewDispatchClaim', () => {
	it('sets the namespaced key with the requested TTL and no NX', async () => {
		const { refreshReviewDispatchClaim } = await import('@/triggers/review-dispatch-dedup.js');

		await refreshReviewDispatchClaim('acme/widgets:42:abc', 2100);

		// No `NX`: the point is to extend (or re-establish) the hold, not to lose it
		// to a claim that already exists — including this holder's own.
		expect(set).toHaveBeenCalledWith(`${NS}acme/widgets:42:abc`, 'pr-review-pending', 'EX', 2100);
	});

	it('swallows Redis errors (TTL is the safety net)', async () => {
		set.mockRejectedValue(new Error('ECONNREFUSED'));
		const { refreshReviewDispatchClaim } = await import('@/triggers/review-dispatch-dedup.js');

		await expect(refreshReviewDispatchClaim('acme/widgets:42:abc', 2100)).resolves.toBeUndefined();
	});
});

/**
 * Issue #1270 — a Review dispatched on a head reporting no checks marks its claim,
 * so a red event that meets it can tell it from a genuine duplicate.
 */
describe('markReviewDispatchClaimedWithoutChecks', () => {
	it('appends the mark to the live value, keeping its TTL', async () => {
		const { markReviewDispatchClaimedWithoutChecks } = await import(
			'@/triggers/review-dispatch-dedup.js'
		);

		await markReviewDispatchClaimedWithoutChecks('acme/widgets:42:abc');

		expect(evalScript).toHaveBeenCalledWith(
			expect.stringContaining("'XX', 'KEEPTTL'"),
			1,
			`${NS}acme/widgets:42:abc`,
			':no-checks',
		);
		expect(set).not.toHaveBeenCalled();
	});

	it('swallows Redis errors', async () => {
		evalScript.mockRejectedValue(new Error('ECONNREFUSED'));
		const { markReviewDispatchClaimedWithoutChecks } = await import(
			'@/triggers/review-dispatch-dedup.js'
		);

		await expect(
			markReviewDispatchClaimedWithoutChecks('acme/widgets:42:abc'),
		).resolves.toBeUndefined();
	});
});

describe('reviewClaimedWithoutChecksTtlSec', () => {
	it('reports the lease of a claim carrying the mark', async () => {
		evalScript.mockResolvedValue(180);
		const { reviewClaimedWithoutChecksTtlSec } = await import(
			'@/triggers/review-dispatch-dedup.js'
		);

		await expect(reviewClaimedWithoutChecksTtlSec('acme/widgets:42:abc')).resolves.toBe(180);
		expect(evalScript).toHaveBeenCalledWith(
			expect.any(String),
			1,
			`${NS}acme/widgets:42:abc`,
			':no-checks',
		);
	});

	// A lease about to lapse is still that holder's.
	it('reports a zero lease as held', async () => {
		evalScript.mockResolvedValue(0);
		const { reviewClaimedWithoutChecksTtlSec } = await import(
			'@/triggers/review-dispatch-dedup.js'
		);

		await expect(reviewClaimedWithoutChecksTtlSec('acme/widgets:42:abc')).resolves.toBe(0);
	});

	// -2: unmarked or missing; -1: no expiry — neither is a lapse to wait for.
	it.each([-2, -1])('reports nothing for %s', async (answer) => {
		evalScript.mockResolvedValue(answer);
		const { reviewClaimedWithoutChecksTtlSec } = await import(
			'@/triggers/review-dispatch-dedup.js'
		);

		await expect(reviewClaimedWithoutChecksTtlSec('acme/widgets:42:abc')).resolves.toBeUndefined();
	});

	it('reports nothing when the read throws', async () => {
		evalScript.mockRejectedValue(new Error('ECONNREFUSED'));
		const { reviewClaimedWithoutChecksTtlSec } = await import(
			'@/triggers/review-dispatch-dedup.js'
		);

		await expect(reviewClaimedWithoutChecksTtlSec('acme/widgets:42:abc')).resolves.toBeUndefined();
	});
});

/**
 * Issue #1430 — a red event takes over merge automation's updated-head claim, and
 * no other holder's, for the one CI fix the red needs.
 */
describe('takeOverMergeAutomationClaim', () => {
	it('compare-and-sets the namespaced key from the merge-automation owner, keeping its TTL', async () => {
		const { takeOverMergeAutomationClaim } = await import('@/triggers/review-dispatch-dedup.js');

		await expect(
			takeOverMergeAutomationClaim('acme/widgets:42:abc', 'pr-review:dispatch-7'),
		).resolves.toBe(true);

		expect(evalScript).toHaveBeenCalledWith(
			expect.stringContaining("'XX', 'KEEPTTL'"),
			1,
			`${NS}acme/widgets:42:abc`,
			'merge-automation',
			'pr-review:dispatch-7',
		);
		expect(set).not.toHaveBeenCalled();
	});

	it('reports a loss when the slot has another holder or none', async () => {
		evalScript.mockResolvedValue(0);
		const { takeOverMergeAutomationClaim } = await import('@/triggers/review-dispatch-dedup.js');

		await expect(
			takeOverMergeAutomationClaim('acme/widgets:42:abc', 'pr-review:dispatch-7'),
		).resolves.toBe(false);
	});

	// Fails closed: keeping the duplicate drop is cheaper than a second CI fix.
	it('reports a loss when Redis fails', async () => {
		evalScript.mockRejectedValue(new Error('ECONNREFUSED'));
		const { takeOverMergeAutomationClaim } = await import('@/triggers/review-dispatch-dedup.js');

		await expect(
			takeOverMergeAutomationClaim('acme/widgets:42:abc', 'pr-review:dispatch-7'),
		).resolves.toBe(false);
	});
});

/**
 * Issue #1432 meets #1430 — keeping merge automation's updated-head claim alive
 * while that head's checks are pending must not rewrite its owner token, or a red
 * on the head could no longer take the claim over for its CI fix.
 */
describe('refreshMergeAutomationClaim', () => {
	it('extends the namespaced key only under the merge-automation owner, never with a plain SET', async () => {
		const { refreshMergeAutomationClaim } = await import('@/triggers/review-dispatch-dedup.js');

		await refreshMergeAutomationClaim('acme/widgets:42:abc', 900);

		expect(evalScript).toHaveBeenCalledWith(
			expect.stringContaining("redis.call('expire', KEYS[1], ARGV[2])"),
			1,
			`${NS}acme/widgets:42:abc`,
			'merge-automation',
			'900',
		);
		expect(set).not.toHaveBeenCalled();
	});

	it('swallows a Redis failure', async () => {
		evalScript.mockRejectedValue(new Error('ECONNREFUSED'));
		const { refreshMergeAutomationClaim } = await import('@/triggers/review-dispatch-dedup.js');

		await expect(refreshMergeAutomationClaim('acme/widgets:42:abc', 900)).resolves.toBeUndefined();
	});
});
