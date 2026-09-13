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
const { publishWorkerUpdateRequest } = vi.hoisted(() => ({ publishWorkerUpdateRequest: vi.fn() }));

vi.mock('@/identity/worker-service.js', () => ({ requestWorkerUpdate }));
vi.mock('@/identity/worker-session-service.js', () => ({ getLiveSessionForWorker }));
vi.mock('@/queue/worker-updates.js', () => ({ publishWorkerUpdateRequest }));

import { fanOutWorkerUpdate } from '@/api/worker-update-fanout.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';

const OWNER_ID = '00000000-0000-4000-8000-0000000000aa';
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
		// Out of the dispatch pool, so eligible, unless a case says otherwise.
		drainingSince: DRAINED_AT,
		update: null,
		build: null,
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
			status: null,
			message: null,
			reportedAt: null,
		},
		...overrides,
	});
}

/** A row whose machine has reported an outcome — `requestId` cleared by the report. */
function reported(target: string, status: 'applied' | 'failed', overrides: Partial<Worker> = {}) {
	return makeWorker({
		update: {
			requestId: null,
			target,
			requestedAt: REQUESTED_AT,
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
			status: null,
			message: null,
			reportedAt: null,
		},
	};
}

beforeEach(() => {
	for (const m of [requestWorkerUpdate, getLiveSessionForWorker, publishWorkerUpdateRequest]) {
		m.mockReset();
	}
	// Connected unless a case says otherwise; the write echoes the row back.
	getLiveSessionForWorker.mockResolvedValue({ fencingToken: 1 });
	requestWorkerUpdate.mockImplementation(async (id: string, _requestId: string, target: string) =>
		afterWrite(makeWorker({ id }), target),
	);
});

describe('fanOutWorkerUpdate (issue #921)', () => {
	it('records and publishes for a drained machine with a live session', async () => {
		const entries = await fanOutWorkerUpdate([makeWorker()], 'main');

		expect(requestWorkerUpdate).toHaveBeenCalledWith(WORKER_ID, expect.any(String), 'main');
		expect(publishWorkerUpdateRequest).toHaveBeenCalledExactlyOnceWith(WORKER_ID);
		expect(entries).toMatchObject([
			{ workerId: WORKER_ID, displayName: 'ada-laptop', disposition: 'requested' },
		]);
		expect(entries[0]?.update).toMatchObject({ target: 'main' });
	});

	// Offline is not "skipped": the request is durable on the row, and the router
	// states it again on the machine's next connection.
	it('still records and publishes for a machine with no live session', async () => {
		getLiveSessionForWorker.mockResolvedValue(undefined);

		const entries = await fanOutWorkerUpdate([makeWorker()], 'main');

		expect(entries[0]?.disposition).toBe('queued-offline');
		expect(requestWorkerUpdate).toHaveBeenCalledWith(WORKER_ID, expect.any(String), 'main');
		expect(publishWorkerUpdateRequest).toHaveBeenCalledExactlyOnceWith(WORKER_ID);
	});

	// Issue #933's precondition, unrelaxed — but reported rather than thrown.
	it('skips a machine still in the dispatch pool, writing and publishing nothing', async () => {
		const entries = await fanOutWorkerUpdate([makeWorker({ drainingSince: null })], 'main');

		expect(entries).toMatchObject([{ workerId: WORKER_ID, disposition: 'in-pool', update: null }]);
		expect(requestWorkerUpdate).not.toHaveBeenCalled();
		expect(publishWorkerUpdateRequest).not.toHaveBeenCalled();
	});

	// Re-running the command must not cost a second push, and the id the row waits on
	// has to survive — a report can only ever close the request it names.
	it('leaves an outstanding request for the same target exactly as it is', async () => {
		const entries = await fanOutWorkerUpdate([pending('main')], 'main');

		expect(entries[0]?.disposition).toBe('already-asked');
		expect(entries[0]?.update).toMatchObject({
			requestId: OUTSTANDING_REQUEST_ID,
			target: 'main',
		});
		expect(requestWorkerUpdate).not.toHaveBeenCalled();
		expect(publishWorkerUpdateRequest).not.toHaveBeenCalled();
	});

	// `requestUpdate`'s documented re-issue semantics: a stale request for some other
	// build must not survive a fleet action moving everything to `target`.
	it('overwrites an outstanding request for a different target', async () => {
		const entries = await fanOutWorkerUpdate([pending('v2')], 'main');

		expect(entries[0]?.disposition).toBe('requested');
		expect(requestWorkerUpdate).toHaveBeenCalledWith(WORKER_ID, expect.any(String), 'main');
	});

	// An `applied` machine is never sent back through an apply it has already done.
	it('returns a reported outcome for the same target rather than re-asking', async () => {
		const entries = await fanOutWorkerUpdate([reported('main', 'failed')], 'main');

		expect(entries[0]?.disposition).toBe('answered');
		expect(entries[0]?.update).toMatchObject({
			status: 'failed',
			message: 'npm ci exited 1',
			target: 'main',
		});
		expect(requestWorkerUpdate).not.toHaveBeenCalled();
		expect(publishWorkerUpdateRequest).not.toHaveBeenCalled();
	});

	// An outcome about some other build answers nothing about this one.
	it('asks a machine whose reported outcome names a different target', async () => {
		const entries = await fanOutWorkerUpdate([reported('v2', 'applied')], 'main');

		expect(entries[0]?.disposition).toBe('requested');
		expect(requestWorkerUpdate).toHaveBeenCalledWith(WORKER_ID, expect.any(String), 'main');
	});

	// The headline: one machine's state never refuses the whole call.
	it('reports every machine once, in input order, past a skipped one', async () => {
		const third = '33333333-3333-4333-8333-333333333333';
		const workers = [
			makeWorker({ id: WORKER_ID, displayName: 'ada-laptop', drainingSince: null }),
			makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' }),
			pending('main', { id: third, displayName: 'ada-builder' }),
		];

		const entries = await fanOutWorkerUpdate(workers, 'main');

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
		);
	});

	// A request id names one request to one machine — `recordWorkerUpdateReport`
	// matches on `(worker_id, update_request_id)`, so a shared id would let one
	// machine's report close another's request.
	it('mints a separate request id per machine', async () => {
		await fanOutWorkerUpdate(
			[makeWorker(), makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' })],
			'main',
		);

		const [first, second] = requestWorkerUpdate.mock.calls.map((call) => call[1]);
		expect(first).toEqual(expect.any(String));
		expect(second).not.toBe(first);
	});

	// Deregistered between the caller's read and the write: there is no machine left
	// to report on, and nothing was published for it.
	it('omits a machine that disappeared before its write landed', async () => {
		requestWorkerUpdate.mockResolvedValueOnce(undefined);

		const entries = await fanOutWorkerUpdate(
			[makeWorker(), makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' })],
			'main',
		);

		expect(entries.map((entry) => entry.workerId)).toEqual([OTHER_WORKER_ID]);
		expect(publishWorkerUpdateRequest).toHaveBeenCalledExactlyOnceWith(OTHER_WORKER_ID);
	});

	it('answers an empty fleet with an empty report', async () => {
		expect(await fanOutWorkerUpdate([], 'main')).toEqual([]);
		expect(requestWorkerUpdate).not.toHaveBeenCalled();
	});
});
