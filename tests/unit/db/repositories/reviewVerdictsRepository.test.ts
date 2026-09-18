import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client.js', () => ({ getDb: vi.fn() }));

import {
	hasReviewInFlightAbove,
	isLastPermittedVerdict,
	isReviewAllowanceSpent,
	type PullRequestReviewSlot,
	REVIEW_VERDICT_CAP,
} from '@/db/repositories/reviewVerdictsRepository.js';

/**
 * The module's pure cap predicates (issue #1038) — `reserveReviewVerdict`'s own
 * arithmetic, extracted so a reader can reach the writer's conclusion without the
 * advisory lock. Both are pure, so they test without a database; the only stub
 * here is `getDb`, which the module's readers construct their queries from at
 * call time and which nothing below reaches.
 */

function slot(overrides: Partial<PullRequestReviewSlot> = {}): PullRequestReviewSlot {
	return {
		ordinal: 1,
		state: 'submitted',
		headSha: 'abc123',
		capOverrideGrantedAt: null,
		capOverrideConsumedAt: null,
		// Only a `pending` slot's owner liveness means anything, so every case that
		// depends on it says so at the call site rather than inheriting it here.
		dispatchActive: false,
		...overrides,
	};
}

/** A full allowance: one submitted slot per permitted verdict, each at its own head. */
function spentSlots(): PullRequestReviewSlot[] {
	return Array.from({ length: REVIEW_VERDICT_CAP }, (_, i) =>
		slot({ ordinal: i + 1, headSha: `head-${i}` }),
	);
}

describe('isReviewAllowanceSpent', () => {
	it('reports allowance left while fewer than the cap have been submitted', () => {
		expect(isReviewAllowanceSpent([])).toBe(false);
		expect(isReviewAllowanceSpent(spentSlots().slice(0, REVIEW_VERDICT_CAP - 1))).toBe(false);
	});

	it('reports the allowance spent once the cap has been submitted', () => {
		expect(isReviewAllowanceSpent(spentSlots())).toBe(true);
	});

	// Issue #511: a grant is an extra slot the next reservation may take, so a pull
	// request holding one has allowance left — until that reservation spends it.
	it('reports allowance left on an unconsumed operator grant, and spent once consumed', () => {
		const slots = spentSlots();
		slots[REVIEW_VERDICT_CAP - 1] = {
			...slots[REVIEW_VERDICT_CAP - 1],
			capOverrideGrantedAt: new Date(),
		};
		expect(isReviewAllowanceSpent(slots)).toBe(false);

		slots[REVIEW_VERDICT_CAP - 1] = {
			...slots[REVIEW_VERDICT_CAP - 1],
			capOverrideConsumedAt: new Date(),
		};
		expect(isReviewAllowanceSpent(slots)).toBe(true);
	});

	// A reservation that submitted nothing is not a verdict, exactly as the writer
	// counts it: only `submitted` rows are charged against the cap.
	it('does not count a pending slot toward the cap', () => {
		const slots = spentSlots();
		slots[REVIEW_VERDICT_CAP - 1] = { ...slots[REVIEW_VERDICT_CAP - 1], state: 'pending' };
		expect(isReviewAllowanceSpent(slots)).toBe(false);
	});
});

describe('isLastPermittedVerdict', () => {
	it('recognises the highest submitted ordinal', () => {
		expect(isLastPermittedVerdict(spentSlots(), REVIEW_VERDICT_CAP)).toBe(true);
	});

	it('refuses an earlier verdict on the same pull request', () => {
		expect(isLastPermittedVerdict(spentSlots(), 1)).toBe(false);
	});

	it('refuses a run that was never ledgered', () => {
		expect(isLastPermittedVerdict(spentSlots(), null)).toBe(false);
	});

	it('answers false when nothing has been submitted at all', () => {
		expect(isLastPermittedVerdict([slot({ state: 'pending' })], 1)).toBe(false);
	});

	// A later reservation that has not submitted yet must not demote the verdict
	// that is still the pull request's latest.
	it('ignores a pending slot above the highest submitted one', () => {
		const slots = [...spentSlots(), slot({ ordinal: REVIEW_VERDICT_CAP + 1, state: 'pending' })];
		expect(isLastPermittedVerdict(slots, REVIEW_VERDICT_CAP)).toBe(true);
	});
});

describe('hasReviewInFlightAbove', () => {
	/**
	 * The state an operator's grant leaves behind the moment it is redeemed: the
	 * allowance reads spent, the grant is consumed, the last verdict is still this
	 * run's — and a Review is already running on the extra slot it bought.
	 */
	function grantedFollowUpSlots(dispatchActive = true): PullRequestReviewSlot[] {
		const slots = spentSlots();
		slots[REVIEW_VERDICT_CAP - 1] = {
			...slots[REVIEW_VERDICT_CAP - 1],
			capOverrideGrantedAt: new Date(),
			capOverrideConsumedAt: new Date(),
		};
		return [...slots, slot({ ordinal: REVIEW_VERDICT_CAP + 1, state: 'pending', dispatchActive })];
	}

	it('recognises the granted review a consumed override put in flight', () => {
		expect(hasReviewInFlightAbove(grantedFollowUpSlots(), REVIEW_VERDICT_CAP)).toBe(true);
	});

	// The three clauses the run-detail read model ANDs together: without the third,
	// a run an operator has already acted on still reports as the cap stop.
	it('is what separates a redeemed grant from a genuine stop', () => {
		const inFlight = grantedFollowUpSlots();
		expect(isReviewAllowanceSpent(inFlight)).toBe(true);
		expect(isLastPermittedVerdict(inFlight, REVIEW_VERDICT_CAP)).toBe(true);
		expect(hasReviewInFlightAbove(inFlight, REVIEW_VERDICT_CAP)).toBe(true);
	});

	// The other half of the same question: a reservation whose dispatch settled
	// terminally without submitting is a relic, and the capped pull request will
	// never make the next reservation that would clear it — so the run it stopped
	// at must go on reading as stopped.
	it('refuses a pending slot whose owning dispatch is no longer due to run', () => {
		const stale = grantedFollowUpSlots(false);
		expect(isReviewAllowanceSpent(stale)).toBe(true);
		expect(isLastPermittedVerdict(stale, REVIEW_VERDICT_CAP)).toBe(true);
		expect(hasReviewInFlightAbove(stale, REVIEW_VERDICT_CAP)).toBe(false);
	});

	it('answers false on a capped pull request with nothing reserved', () => {
		expect(hasReviewInFlightAbove(spentSlots(), REVIEW_VERDICT_CAP)).toBe(false);
	});

	// Only a *later* reservation can displace this verdict; an earlier pending slot
	// is a relic the writer abandons, not a review that supersedes it.
	it('ignores a pending slot at or below the ordinal asked about', () => {
		const slots = [...spentSlots(), slot({ ordinal: REVIEW_VERDICT_CAP, state: 'pending' })];
		expect(hasReviewInFlightAbove(slots, REVIEW_VERDICT_CAP)).toBe(false);
	});

	it('answers false for a run that was never ledgered', () => {
		expect(hasReviewInFlightAbove(grantedFollowUpSlots(), null)).toBe(false);
	});
});
