import { describe, expect, it } from 'vitest';
import { classifyDispatchClaim, type DispatchClaim } from '@/dispatch/claim-liveness.js';

const NOW = new Date('2026-09-16T09:52:00.000Z');

function claim(overrides: Partial<DispatchClaim> = {}): DispatchClaim {
	return {
		state: 'leased',
		// An hour out — well inside `DISPATCH_CLAIM_LEASE_MS`.
		leaseExpiresAt: new Date(NOW.getTime() + 3_600_000),
		...overrides,
	};
}

describe('classifyDispatchClaim', () => {
	it('reads a queued dispatch as waiting', () => {
		for (const state of ['pending', 'retry-scheduled'] as const) {
			expect(classifyDispatchClaim(claim({ state }), NOW)).toBe('waiting');
		}
	});

	it('reads a claim whose lease still holds as executing', () => {
		// The boundary PR #1021's review (F1) settled: the verdict is the *lease* and
		// nothing else. A partitioned daemon keeps its agent running and holds its
		// terminal result for the next session (issue #718), so no amount of transport
		// silence may license a second run of a phase whose lease has not lapsed.
		for (const state of ['leased', 'running'] as const) {
			expect(classifyDispatchClaim(claim({ state }), NOW)).toBe('executing');
		}
	});

	it('reads a lapsed lease as stale, in either executing state', () => {
		// The shape the lease-expiry sweep would reap on its next pass; the operator
		// should not have to wait for that cadence (issue #1017).
		const lapsed = { leaseExpiresAt: new Date(NOW.getTime() - 1) };
		for (const state of ['leased', 'running'] as const) {
			expect(classifyDispatchClaim(claim({ ...lapsed, state }), NOW)).toBe('stale');
		}
	});

	it('treats a lease expiring exactly now as lapsed', () => {
		expect(classifyDispatchClaim(claim({ leaseExpiresAt: NOW }), NOW)).toBe('stale');
	});

	it('reads a claim with no lease at all as stale', () => {
		expect(classifyDispatchClaim(claim({ leaseExpiresAt: null }), NOW)).toBe('stale');
	});
});
