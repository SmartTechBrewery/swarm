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

	/**
	 * The scenarios above pin the cases issue #533 names; this pins the two
	 * *properties* they are instances of, against an independent brute-force
	 * maximum. A matching algorithm fails by returning a valid-but-smaller
	 * assignment — no exception, no obviously wrong scenario — so a property check
	 * is what catches an edit that quietly stops augmenting.
	 */
	describe('properties, against a brute-force maximum', () => {
		interface Instance {
			demands: readonly PoolDemand[];
			freeSlots: ReadonlyMap<string, number>;
		}

		/** Deterministic PRNG, so a failing case is reproducible from its seed. */
		function random(seed: number): () => number {
			let state = seed >>> 0;
			return () => {
				state = (state * 1664525 + 1013904223) >>> 0;
				return state / 0x100000000;
			};
		}

		function randomInstance(seed: number): Instance {
			const next = random(seed);
			const workerIds = Array.from({ length: 1 + Math.floor(next() * 4) }, (_, i) => `w${i}`);
			const freeSlots = new Map(workerIds.map((id) => [id, Math.floor(next() * 3)] as const));
			const demands = Array.from({ length: 1 + Math.floor(next() * 6) }, (_, i) =>
				demand(`d${i}`, ...workerIds.filter(() => next() < 0.5)),
			);
			return { demands, freeSlots };
		}

		/** Independent maximum matching by exhaustive search — small inputs only. */
		function bruteForceMax({ demands, freeSlots }: Instance): number {
			const load = new Map<string, number>();
			let best = 0;
			const walk = (index: number, placed: number): void => {
				if (index === demands.length) {
					best = Math.max(best, placed);
					return;
				}
				walk(index + 1, placed);
				for (const workerId of demands[index].eligibleWorkerIds) {
					const used = load.get(workerId) ?? 0;
					if (used >= (freeSlots.get(workerId) ?? 0)) continue;
					load.set(workerId, used + 1);
					walk(index + 1, placed + 1);
					load.set(workerId, used);
				}
			};
			walk(0, 0);
			return best;
		}

		/** Every placement is to an eligible worker, and no worker is oversubscribed. */
		function expectWellFormed(instance: Instance, assigned: Map<string, string>, seed: number) {
			const load = new Map<string, number>();
			for (const [dispatchId, workerId] of assigned) {
				const placed = instance.demands.find((entry) => entry.dispatchId === dispatchId);
				expect(placed?.eligibleWorkerIds, `seed ${seed}`).toContain(workerId);
				load.set(workerId, (load.get(workerId) ?? 0) + 1);
			}
			for (const [workerId, count] of load) {
				expect(count, `seed ${seed}: ${workerId} over capacity`).toBeLessThanOrEqual(
					instance.freeSlots.get(workerId) ?? 0,
				);
			}
		}

		/**
		 * Every prefix of the scheduling order holds as many placements as that prefix
		 * could on its own — the rank-respecting property, stated as something
		 * checkable: serving demands in order never costs an earlier one its slot.
		 */
		function expectPrefixesMaximum(
			instance: Instance,
			assigned: Map<string, string>,
			seed: number,
		) {
			for (let take = 1; take <= instance.demands.length; take++) {
				const prefix = instance.demands.slice(0, take);
				const held = [...assigned.keys()].filter((dispatchId) =>
					prefix.some((entry) => entry.dispatchId === dispatchId),
				).length;
				expect(held, `seed ${seed}: prefix of ${take} is not maximum`).toBe(
					bruteForceMax({ demands: prefix, freeSlots: instance.freeSlots }),
				);
			}
		}

		it('places as many demands as any assignment could, and never at a higher-ranked demand’s expense', () => {
			for (let seed = 1; seed <= 500; seed++) {
				const instance = randomInstance(seed);
				const assigned = assignWorkerPool(instance);
				expectWellFormed(instance, assigned, seed);
				expect(assigned.size, `seed ${seed}: not a maximum matching`).toBe(bruteForceMax(instance));
				expectPrefixesMaximum(instance, assigned, seed);
			}
		});
	});
});
