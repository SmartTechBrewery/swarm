import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #921 — the fan-out's disposition table. The seam under test is the three
 * calls it makes (the row write, the publish, and the liveness read), mocked in the
 * shape `tests/unit/api/routers/workers.test.ts` already mocks them, because what
 * this module decides is *which* of them happen per machine and nothing about what
 * any of them then does.
 */
const { requestWorkerUpdate } = vi.hoisted(() => ({ requestWorkerUpdate: vi.fn() }));
const { getLiveSessionForWorker } = vi.hoisted(() => ({ getLiveSessionForWorker: vi.fn() }));
const { publishDispatchWakeUp } = vi.hoisted(() => ({ publishDispatchWakeUp: vi.fn() }));

vi.mock('@/identity/worker-service.js', () => ({ requestWorkerUpdate }));
vi.mock('@/identity/worker-session-service.js', () => ({ getLiveSessionForWorker }));
vi.mock('@/dispatch/dispatcher.js', () => ({ publishDispatchWakeUp }));

import { fanOutWorkerUpdate, publishWorkerUpdateWakeUp } from '@/api/worker-update-fanout.js';
import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';
import type { WorkerUpdateStatus } from '@/lib/build-identity.js';

const OWNER_ID = '00000000-0000-4000-8000-0000000000aa';
/** Who asked (issue #922) — threaded through to the row write, never derived from the machine. */
const REQUESTER_ID = '00000000-0000-4000-8000-0000000000cc';
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKER_ID = '22222222-2222-4222-8222-222222222222';
const OUTSTANDING_REQUEST_ID = '66666666-6666-4666-8666-666666666666';
const DRAINED_AT = new Date('2026-09-13T10:00:00Z');
const REQUESTED_AT = new Date('2026-09-13T10:05:00Z');

function makeWorker(overrides: Partial<Worker> = {}): Worker {
	return {
		id: WORKER_ID,
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude'],
		probedCapabilities: ['claude'],
		declaredCapabilities: null,
		supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
		repository: null,
		hostname: null,
		// Out of the dispatch pool, so eligible, unless a case says otherwise.
		drainingSince: DRAINED_AT,
		update: null,
		version: null,
		worktreeSweep: null,
		build: null,
		supervision: 'unknown',
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

/** A row carrying an update request nobody has answered yet. */
function pending(target: string, overrides: Partial<Worker> = {}): Worker {
	return makeWorker({
		update: {
			requestId: OUTSTANDING_REQUEST_ID,
			target,
			requestedAt: REQUESTED_AT,
			requestedByUserId: REQUESTER_ID,
			status: null,
			message: null,
			reportedAt: null,
		},
		...overrides,
	});
}

/** A row whose machine has reported an outcome — `requestId` cleared by the report. */
function reported(target: string, status: WorkerUpdateStatus, overrides: Partial<Worker> = {}) {
	return makeWorker({
		update: {
			requestId: null,
			target,
			requestedAt: REQUESTED_AT,
			requestedByUserId: REQUESTER_ID,
			status,
			message: status === 'failed' ? 'npm ci exited 1' : 'restarting',
			reportedAt: new Date('2026-09-13T10:09:00Z'),
		},
		...overrides,
	});
}

/** What the row looks like after this fan-out's own write landed. */
function afterWrite(worker: Worker, target: string): Worker {
	return {
		...worker,
		update: {
			requestId: 'written-request-id',
			target,
			requestedAt: REQUESTED_AT,
			requestedByUserId: REQUESTER_ID,
			status: null,
			message: null,
			reportedAt: null,
		},
	};
}

/**
 * The durable unit the write now creates beside the row and the run (issue #972)
 * — what the fan-out publishes a wake-up for.
 */
function dispatchFor(workerId: string): DispatchRow {
	return { id: `dispatch-${workerId}`, wakeSeq: 0, availableAt: new Date(0) } as DispatchRow;
}

beforeEach(() => {
	for (const m of [requestWorkerUpdate, getLiveSessionForWorker, publishDispatchWakeUp]) {
		m.mockReset();
	}
	// Connected unless a case says otherwise; the write lands and echoes the row back.
	getLiveSessionForWorker.mockResolvedValue({ fencingToken: 1 });
	requestWorkerUpdate.mockImplementation(
		async (id: string, _requestId: string, target: string) => ({
			outcome: 'requested',
			worker: afterWrite(makeWorker({ id }), target),
			runId: `run-${id}`,
			dispatch: dispatchFor(id),
		}),
	);
});

// Issue #972 — the outbox half, shared with the single-machine mutation.
describe('publishWorkerUpdateWakeUp', () => {
	// Never throws: the dispatch is durable before this runs, so a failed publish
	// costs promptness and nothing else — failing the mutation over it would tell
	// the operator their request did not land when it did.
	it('swallows a publish failure rather than failing the mutation that recorded the request', async () => {
		publishDispatchWakeUp.mockRejectedValue(new Error('redis is down'));

		await expect(publishWorkerUpdateWakeUp(dispatchFor(WORKER_ID))).resolves.toBeUndefined();
	});
});

describe('fanOutWorkerUpdate (issue #921)', () => {
	it('records and publishes for a drained machine with a live session', async () => {
		const entries = await fanOutWorkerUpdate([makeWorker()], 'main', REQUESTER_ID);

		expect(requestWorkerUpdate).toHaveBeenCalledWith(
			WORKER_ID,
			expect.any(String),
			'main',
			REQUESTER_ID,
		);
		expect(publishDispatchWakeUp).toHaveBeenCalledExactlyOnceWith(dispatchFor(WORKER_ID));
		expect(entries).toMatchObject([
			{ workerId: WORKER_ID, displayName: 'ada-laptop', disposition: 'requested' },
		]);
		expect(entries[0]?.update).toMatchObject({ target: 'main' });
	});

	// Offline is not "skipped": the request is durable on the row, and the router
	// states it again on the machine's next connection.
	it('still records and publishes for a machine with no live session', async () => {
		getLiveSessionForWorker.mockResolvedValue(undefined);

		const entries = await fanOutWorkerUpdate([makeWorker()], 'main', REQUESTER_ID);

		expect(entries[0]?.disposition).toBe('queued-offline');
		expect(requestWorkerUpdate).toHaveBeenCalledWith(
			WORKER_ID,
			expect.any(String),
			'main',
			REQUESTER_ID,
		);
		expect(publishDispatchWakeUp).toHaveBeenCalledExactlyOnceWith(dispatchFor(WORKER_ID));
	});

	// Issue #933's precondition, unrelaxed — but reported rather than thrown.
	it('skips a machine still in the dispatch pool, writing and publishing nothing', async () => {
		const entries = await fanOutWorkerUpdate(
			[makeWorker({ drainingSince: null })],
			'main',
			REQUESTER_ID,
		);

		expect(entries).toMatchObject([{ workerId: WORKER_ID, disposition: 'in-pool', update: null }]);
		expect(requestWorkerUpdate).not.toHaveBeenCalled();
		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
	});

	// Re-running the command must not cost a second push, and the id the row waits on
	// has to survive — a report can only ever close the request it names.
	it('leaves an outstanding request for the same target exactly as it is', async () => {
		const entries = await fanOutWorkerUpdate([pending('main')], 'main', REQUESTER_ID);

		expect(entries[0]?.disposition).toBe('already-asked');
		expect(entries[0]?.update).toMatchObject({
			requestId: OUTSTANDING_REQUEST_ID,
			target: 'main',
		});
		expect(requestWorkerUpdate).not.toHaveBeenCalled();
		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
	});

	// `requestUpdate`'s documented re-issue semantics: a stale request for some other
	// build must not survive a fleet action moving everything to `target`.
	it('overwrites an outstanding request for a different target', async () => {
		const entries = await fanOutWorkerUpdate([pending('v2')], 'main', REQUESTER_ID);

		expect(entries[0]?.disposition).toBe('requested');
		expect(requestWorkerUpdate).toHaveBeenCalledWith(
			WORKER_ID,
			expect.any(String),
			'main',
			REQUESTER_ID,
		);
	});

	// An `applied` machine is never sent back through an apply it has already done.
	it('returns a reported outcome for the same target rather than re-asking', async () => {
		const entries = await fanOutWorkerUpdate([reported('main', 'failed')], 'main', REQUESTER_ID);

		expect(entries[0]?.disposition).toBe('answered');
		expect(entries[0]?.update).toMatchObject({
			status: 'failed',
			message: 'npm ci exited 1',
			target: 'main',
		});
		expect(requestWorkerUpdate).not.toHaveBeenCalled();
		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
	});

	// An outcome about some other build answers nothing about this one.
	it('asks a machine whose reported outcome names a different target', async () => {
		const entries = await fanOutWorkerUpdate([reported('v2', 'applied')], 'main', REQUESTER_ID);

		expect(entries[0]?.disposition).toBe('requested');
		expect(requestWorkerUpdate).toHaveBeenCalledWith(
			WORKER_ID,
			expect.any(String),
			'main',
			REQUESTER_ID,
		);
	});

	// The headline: one machine's state never refuses the whole call.
	it('reports every machine once, in input order, past a skipped one', async () => {
		const third = '33333333-3333-4333-8333-333333333333';
		const workers = [
			makeWorker({ id: WORKER_ID, displayName: 'ada-laptop', drainingSince: null }),
			makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' }),
			pending('main', { id: third, displayName: 'ada-builder' }),
		];

		const entries = await fanOutWorkerUpdate(workers, 'main', REQUESTER_ID);

		expect(entries.map((entry) => [entry.workerId, entry.disposition])).toEqual([
			[WORKER_ID, 'in-pool'],
			[OTHER_WORKER_ID, 'requested'],
			[third, 'already-asked'],
		]);
		// The un-drained machine did not stop the eligible one being asked.
		expect(requestWorkerUpdate).toHaveBeenCalledExactlyOnceWith(
			OTHER_WORKER_ID,
			expect.any(String),
			'main',
			REQUESTER_ID,
		);
	});

	// A request id names one request to one machine — `recordWorkerUpdateReport`
	// matches on `(worker_id, update_request_id)`, so a shared id would let one
	// machine's report close another's request.
	it('mints a separate request id per machine', async () => {
		await fanOutWorkerUpdate(
			[makeWorker(), makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' })],
			'main',
			REQUESTER_ID,
		);

		const [first, second] = requestWorkerUpdate.mock.calls.map((call) => call[1]);
		expect(first).toEqual(expect.any(String));
		expect(second).not.toBe(first);
	});

	// Deregistered between the caller's read and the write: there is no machine left
	// to report on, and nothing was published for it.
	it('omits a machine that disappeared before its write landed', async () => {
		requestWorkerUpdate.mockResolvedValueOnce({ outcome: 'not-found' });

		const entries = await fanOutWorkerUpdate(
			[makeWorker(), makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' })],
			'main',
			REQUESTER_ID,
		);

		expect(entries.map((entry) => entry.workerId)).toEqual([OTHER_WORKER_ID]);
		expect(publishDispatchWakeUp).toHaveBeenCalledExactlyOnceWith(dispatchFor(OTHER_WORKER_ID));
	});

	// The reason the snapshot check above is an optimisation and not the guarantee
	// (issue #942 review, F1): a fleet action reads its machines once and then writes
	// to them one at a time, so an `undrain` from another session can land in between.
	// The write's own draining predicate is what declines it, and the machine is
	// reported exactly as an already-in-pool one is.
	it('reports a machine undrained between the read and its write as in-pool', async () => {
		const stillInPool = makeWorker({ drainingSince: null });
		requestWorkerUpdate.mockResolvedValueOnce({ outcome: 'in-pool', worker: stillInPool });

		const entries = await fanOutWorkerUpdate([makeWorker()], 'main', REQUESTER_ID);

		expect(requestWorkerUpdate).toHaveBeenCalledWith(
			WORKER_ID,
			expect.any(String),
			'main',
			REQUESTER_ID,
		);
		expect(entries).toMatchObject([
			{ workerId: WORKER_ID, displayName: 'ada-laptop', disposition: 'in-pool', update: null },
		]);
		// Nothing was recorded, so nothing may be pushed: the daemon must not be told to
		// restart a machine that is back in the dispatch pool.
		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
	});

	// Issue #971 — an update is recorded as a run in the machine's own project, so a
	// machine enrolled in none is reported rather than thrown for: one machine's state
	// never refuses the whole call.
	it('reports a machine enrolled in no project, writing and publishing nothing', async () => {
		requestWorkerUpdate.mockResolvedValueOnce({ outcome: 'no-project', worker: makeWorker() });

		const entries = await fanOutWorkerUpdate([makeWorker()], 'main', REQUESTER_ID);

		expect(entries).toMatchObject([
			{ workerId: WORKER_ID, displayName: 'ada-laptop', disposition: 'no-project', update: null },
		]);
		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
	});

	// Issue #997 — the daemon applies an update by exiting, so a machine that declared
	// nothing will start it again is reported rather than asked and lost. Reported like
	// `no-project`: one machine's state never refuses the whole call.
	it('reports a machine that declared it is unsupervised, writing and publishing nothing', async () => {
		const entries = await fanOutWorkerUpdate(
			[makeWorker({ supervision: 'unsupervised' })],
			'main',
			REQUESTER_ID,
		);

		expect(entries).toMatchObject([
			{ workerId: WORKER_ID, displayName: 'ada-laptop', disposition: 'unsupervised' },
		]);
		// Not asked at all: the snapshot already knows the answer, so there is no write
		// to decline and nothing to wake the machine for.
		expect(requestWorkerUpdate).not.toHaveBeenCalled();
		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
	});

	// The same disposition when the declaration only comes back from the write — a
	// machine that reconnected unsupervised between the caller's read and this write.
	it('reports a machine the write declined as unsupervised', async () => {
		requestWorkerUpdate.mockResolvedValueOnce({
			outcome: 'unsupervised',
			worker: makeWorker({ supervision: 'unsupervised' }),
		});

		const entries = await fanOutWorkerUpdate([makeWorker()], 'main', REQUESTER_ID);

		expect(entries).toMatchObject([
			{ workerId: WORKER_ID, disposition: 'unsupervised', update: null },
		]);
		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
	});

	// `unknown` is a real answer meaning the declaration could not be read — an older
	// daemon, a machine that has never connected, a platform these reads do not cover —
	// so it must never be refused, or a missing fact would block an operator who knows
	// better. `makeWorker` already declares `unknown`, which is why every other case
	// above is asked.
	it('asks a machine declaring unknown supervision exactly as a supervised one', async () => {
		const entries = await fanOutWorkerUpdate(
			[makeWorker({ supervision: 'unknown' }), makeWorker({ id: OTHER_WORKER_ID })],
			'main',
			REQUESTER_ID,
		);

		expect(entries.map((entry) => entry.disposition)).toEqual(['requested', 'requested']);
		expect(requestWorkerUpdate).toHaveBeenCalledTimes(2);
	});

	// Ordered behind the draining check, and the repository orders the pair the same
	// way: the drain is the remedy the operator has to reach for either way.
	it('reports a machine that is both in the pool and unsupervised as in-pool', async () => {
		const entries = await fanOutWorkerUpdate(
			[makeWorker({ drainingSince: null, supervision: 'unsupervised' })],
			'main',
			REQUESTER_ID,
		);

		expect(entries.map((entry) => entry.disposition)).toEqual(['in-pool']);
	});

	it('carries on past a machine that declared it is unsupervised', async () => {
		const entries = await fanOutWorkerUpdate(
			[
				makeWorker({ supervision: 'unsupervised' }),
				makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' }),
			],
			'main',
			REQUESTER_ID,
		);

		expect(entries.map((entry) => [entry.workerId, entry.disposition])).toEqual([
			[WORKER_ID, 'unsupervised'],
			[OTHER_WORKER_ID, 'requested'],
		]);
		expect(publishDispatchWakeUp).toHaveBeenCalledExactlyOnceWith(dispatchFor(OTHER_WORKER_ID));
	});

	it('carries on past a machine enrolled in no project', async () => {
		requestWorkerUpdate.mockResolvedValueOnce({ outcome: 'no-project', worker: makeWorker() });

		const entries = await fanOutWorkerUpdate(
			[makeWorker(), makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' })],
			'main',
			REQUESTER_ID,
		);

		expect(entries.map((entry) => [entry.workerId, entry.disposition])).toEqual([
			[WORKER_ID, 'no-project'],
			[OTHER_WORKER_ID, 'requested'],
		]);
		expect(publishDispatchWakeUp).toHaveBeenCalledExactlyOnceWith(dispatchFor(OTHER_WORKER_ID));
	});

	// The raced machine must not take the rest of the fleet with it, exactly as a
	// machine that was in the pool from the start does not.
	it('carries on past a machine the write declined', async () => {
		requestWorkerUpdate.mockResolvedValueOnce({
			outcome: 'in-pool',
			worker: makeWorker({ drainingSince: null }),
		});

		const entries = await fanOutWorkerUpdate(
			[makeWorker(), makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' })],
			'main',
			REQUESTER_ID,
		);

		expect(entries.map((entry) => [entry.workerId, entry.disposition])).toEqual([
			[WORKER_ID, 'in-pool'],
			[OTHER_WORKER_ID, 'requested'],
		]);
		expect(publishDispatchWakeUp).toHaveBeenCalledExactlyOnceWith(dispatchFor(OTHER_WORKER_ID));
	});

	// A machine that is not asked costs no session lookup — the liveness read decides
	// only the *word* reported for a machine the write actually accepted.
	it('reads no live session for a machine it does not ask', async () => {
		await fanOutWorkerUpdate([makeWorker({ drainingSince: null })], 'main', REQUESTER_ID);

		expect(getLiveSessionForWorker).not.toHaveBeenCalled();
	});

	// Issue #922 — the requester is threaded to the durable write rather than inferred
	// from the machine's owner, because the two are different people the moment an
	// installation administrator asks.
	it('records who asked on every machine it writes to', async () => {
		await fanOutWorkerUpdate(
			[makeWorker(), makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' })],
			'main',
			REQUESTER_ID,
		);

		expect(requestWorkerUpdate.mock.calls.map((call) => [call[0], call[3]])).toEqual([
			[WORKER_ID, REQUESTER_ID],
			[OTHER_WORKER_ID, REQUESTER_ID],
		]);
	});

	// A recorded request resets `update_status`, so the state the entry carries is the
	// *new* request with no outcome beside it — never the answer the machine gave to
	// an earlier one.
	it('carries the new request, not the outcome a machine had reported before', async () => {
		const entries = await fanOutWorkerUpdate([reported('v2', 'declined')], 'main', REQUESTER_ID);

		expect(entries[0]).toMatchObject({ disposition: 'requested' });
		expect(entries[0]?.update).toMatchObject({ target: 'main', status: null });
	});

	it('answers an empty fleet with an empty report', async () => {
		expect(await fanOutWorkerUpdate([], 'main', REQUESTER_ID)).toEqual([]);
		expect(requestWorkerUpdate).not.toHaveBeenCalled();
	});
});
