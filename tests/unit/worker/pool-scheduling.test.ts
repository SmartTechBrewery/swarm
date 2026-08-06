import { describe, expect, it } from 'vitest';

import { assignWorkerPool, type PoolDemand, selectPooledWorker } from '@/worker/pool-scheduling.js';

/** One free slot on each named worker — the one-slot machines issue #533 describes. */
function oneSlotEach(...workerIds: string[]): Map<string, number> {
	return new Map(workerIds.map((id) => [id, 1]));
}

function demand(dispatchId: string, ...eligibleWorkerIds: string[]): PoolDemand {
	return { dispatchId, eligibleWorkerIds };
}

describe('assignWorkerPool', () => {
	it('does not spend a scarce worker on a phase that has an alternative', () => {
		// Issue #533's live incident: Planning can only run on A, Review on either.
		// Serving Review first — the order that broke it — must still leave A for
		// Planning, because Review can be re-homed onto B.
		const assignment = assignWorkerPool({
			demands: [demand('review', 'A', 'B'), demand('planning', 'A')],
			freeSlots: oneSlotEach('A', 'B'),
		});

		expect(assignment.get('planning')).toBe('A');
		expect(assignment.get('review')).toBe('B');
	});

	it('reaches the same assignment when the constrained phase is served first', () => {
		const assignment = assignWorkerPool({
			demands: [demand('planning', 'A'), demand('review', 'A', 'B')],
			freeSlots: oneSlotEach('A', 'B'),
		});

		expect(assignment.get('planning')).toBe('A');
		expect(assignment.get('review')).toBe('B');
	});

	it('spreads competing dispatches across the pool instead of piling onto one worker', () => {
		// Both are eligible everywhere: each still gets its own slot, which is what
		// stops a second dispatch from losing the atomic claim and deferring.
		const assignment = assignWorkerPool({
			demands: [demand('first', 'A', 'B'), demand('second', 'A', 'B')],
			freeSlots: oneSlotEach('A', 'B'),
		});

		expect(assignment.get('first')).toBe('A');
		expect(assignment.get('second')).toBe('B');
	});

	it('fills a multi-slot worker up to its free allocation', () => {
		const assignment = assignWorkerPool({
			demands: [demand('first', 'A'), demand('second', 'A'), demand('third', 'A')],
			freeSlots: new Map([['A', 2]]),
		});

		expect(assignment.get('first')).toBe('A');
		expect(assignment.get('second')).toBe('A');
		expect(assignment.has('third')).toBe(false);
	});

	it('keeps a higher-ranked demand placed when a later one cannot be served', () => {
		// Rank is the caller's queue ordering; a later demand may re-home an earlier
		// one, never unplace it.
		const assignment = assignWorkerPool({
			demands: [demand('ranked-first', 'A'), demand('ranked-second', 'A')],
			freeSlots: oneSlotEach('A'),
		});

		expect(assignment.get('ranked-first')).toBe('A');
		expect(assignment.has('ranked-second')).toBe(false);
	});

	it('re-homes a chain of incumbents to place a constrained demand', () => {
		// first → A, second → B, then a C-less third arrives needing B: second moves to
		// C, and every demand runs. The augmenting-path search is what finds that.
		const assignment = assignWorkerPool({
			demands: [demand('first', 'A'), demand('second', 'A', 'B', 'C'), demand('third', 'B')],
			freeSlots: oneSlotEach('A', 'B', 'C'),
		});

		expect(assignment.get('first')).toBe('A');
		expect(assignment.get('second')).toBe('C');
		expect(assignment.get('third')).toBe('B');
	});

	it('ignores workers with no free slot and demands nothing can serve', () => {
		const assignment = assignWorkerPool({
			demands: [demand('busy-only', 'A'), demand('nothing')],
			freeSlots: new Map([
				['A', 0],
				['B', 1],
			]),
		});

		expect(assignment.size).toBe(0);
	});
});

describe('selectPooledWorker', () => {
	it('returns this dispatch’s share of the matching', () => {
		const worker = selectPooledWorker(
			{
				demands: [demand('planning', 'A'), demand('review', 'A', 'B')],
				freeSlots: oneSlotEach('A', 'B'),
			},
			'review',
		);

		expect(worker).toBe('B');
	});

	it('returns undefined when every worker it could use went to a higher-ranked demand', () => {
		// The caller reads that as "no preference" and keeps its own pick: the demand
		// that won the slot may be a dispatch whose wake-up has not fired yet, and
		// idling a free worker for it would trade a real run for a speculative one.
		const worker = selectPooledWorker(
			{
				demands: [demand('ranked-first', 'A'), demand('ranked-second', 'A')],
				freeSlots: oneSlotEach('A'),
			},
			'ranked-second',
		);

		expect(worker).toBeUndefined();
	});
});
