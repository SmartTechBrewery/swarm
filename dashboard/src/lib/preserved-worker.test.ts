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
				waitEndsAt: null,
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
				waitEndsAt: null,
			}),
		).toBe('w-1');
	});
});

describe('describePreservedWorker', () => {
	const pinned = (waiting: boolean, waitEndsAt: string | null = null) => ({
		state: 'preserved' as const,
		workerId: 'w-1',
		workerName: 'm3_pro_tp',
		waiting,
		waitEndsAt,
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

	// Issue #1141: a machine that lost its transport under this run is waited for on a
	// bound, so the callout must not promise the wait never ends.
	it('names when SWARM stops waiting for a machine that lost its connection', () => {
		const described = describePreservedWorker(
			pinned(true, '2026-10-28T09:00:00.000Z'),
			(iso) => `<${iso}>`,
		);

		expect(described?.title).toContain('m3_pro_tp');
		expect(described?.body).not.toContain('does not time out');
		expect(described?.body).toContain('lost its connection');
		expect(described?.body).toContain('until <2026-10-28T09:00:00.000Z>');
		expect(described?.body).toContain('Retry now');
		expect(described?.body).toContain('Reset & restart');
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
			waitEndsAt: null,
		});

		expect(described?.title).toBe('Preserved work was discarded');
		expect(described?.body).toContain('m3_pro_tp');
	});
});
