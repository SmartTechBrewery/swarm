import { describe, expect, it } from 'vitest';
import { describePreservedWorker, preservedWorkerLabel } from './preserved-worker.js';

// Issue #567. A pinned run waits with no timeout, so what this copy says is the
// only thing separating "waiting for m3_pro_tp" from "wedged" for an operator.
describe('preservedWorkerLabel', () => {
	it('prefers the machine display name', () => {
		expect(
			preservedWorkerLabel({
				state: 'preserved',
				workerId: 'w-1',
				workerName: 'm3_pro_tp',
				waiting: true,
			}),
		).toBe('m3_pro_tp');
	});

	it('falls back to the id when the worker row no longer resolves', () => {
		expect(
			preservedWorkerLabel({
				state: 'preserved',
				workerId: 'w-1',
				workerName: null,
				waiting: false,
			}),
		).toBe('w-1');
	});
});

describe('describePreservedWorker', () => {
	const pinned = (waiting: boolean) => ({
		state: 'preserved' as const,
		workerId: 'w-1',
		workerName: 'm3_pro_tp',
		waiting,
	});

	it('says nothing for a run with no recorded machine', () => {
		expect(describePreservedWorker(null)).toBeNull();
		expect(describePreservedWorker(undefined)).toBeNull();
	});

	it('names the machine, the unbounded wait, and the way out while it is waiting', () => {
		const described = describePreservedWorker(pinned(true));

		expect(described?.title).toContain('m3_pro_tp');
		expect(described?.body).toContain('does not time out');
		expect(described?.body).toContain('Reset & restart');
		// The escape hatch must read as available even while the machine is gone —
		// that is precisely when an operator reaches for it.
		expect(described?.body).toContain('offline');
	});

	it('never promises an unbounded wait for a run merely pinned, not blocked on the pin', () => {
		// The common case right after any rate limit: the run is `deferred` with a
		// recorded machine and a retry on a timer. Claiming that wait never expires
		// would be plainly false, so the copy is keyed on the server's flag.
		const described = describePreservedWorker(pinned(false));

		expect(described?.title).toContain('m3_pro_tp');
		expect(described?.body).not.toContain('does not time out');
	});

	it('records after the fact that a restart discarded the preserved work', () => {
		const described = describePreservedWorker({
			state: 'abandoned',
			workerId: 'w-1',
			workerName: 'm3_pro_tp',
			waiting: false,
		});

		expect(described?.title).toBe('Preserved work was discarded');
		expect(described?.body).toContain('m3_pro_tp');
	});
});
