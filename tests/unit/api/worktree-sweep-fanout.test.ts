import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #956 — the fleet sweep fan-out's disposition table. The seam under test is
 * the three calls it makes (the row write, the publish, and the liveness read),
 * mocked the way `tests/unit/api/worker-update-fanout.test.ts` mocks its own,
 * because what this module decides is *which* of them happen per machine and
 * nothing about what any of them then does.
 */
const { requestWorktreeSweep } = vi.hoisted(() => ({ requestWorktreeSweep: vi.fn() }));
const { getLiveSessionForWorker } = vi.hoisted(() => ({ getLiveSessionForWorker: vi.fn() }));
const { publishWorktreeSweepRequest } = vi.hoisted(() => ({
	publishWorktreeSweepRequest: vi.fn(),
}));

vi.mock('@/identity/worker-service.js', () => ({ requestWorktreeSweep }));
vi.mock('@/identity/worker-session-service.js', () => ({ getLiveSessionForWorker }));
vi.mock('@/queue/worker-sweeps.js', () => ({ publishWorktreeSweepRequest }));

import { fanOutWorktreeSweep } from '@/api/worktree-sweep-fanout.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';

const OWNER_ID = '00000000-0000-4000-8000-0000000000aa';
const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WORKER_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_WORKER_ID = '33333333-3333-4333-8333-333333333333';
const OUTSTANDING_REQUEST_ID = '66666666-6666-4666-8666-666666666666';
const REQUESTED_AT = new Date('2026-09-07T03:00:00Z');

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
		// No draining precondition here, unlike the update fan-out: a sweep disturbs
		// no in-flight run, so a machine in the dispatch pool is asked like any other.
		drainingSince: null,
		update: null,
		worktreeSweep: null,
		build: null,
		supervision: 'unknown',
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

/** A row carrying a sweep request nobody has answered yet. */
function pending(overrides: Partial<Worker> = {}): Worker {
	return makeWorker({
		worktreeSweep: {
			requestId: OUTSTANDING_REQUEST_ID,
			requestedAt: REQUESTED_AT,
			status: null,
			reportedAt: null,
			result: null,
		},
		...overrides,
	});
}

/**
 * What the row looks like after this fan-out's own write landed: a fresh request
 * pair, with whatever outcome the machine had already reported left standing —
 * which is what `requestWorktreeSweep` writes since issue #956, and the reason the
 * post-write state here is the whole answer, unlike the update fan-out's own write.
 */
function afterWrite(worker: Worker): Worker {
	return {
		...worker,
		worktreeSweep: {
			requestId: 'written-request-id',
			requestedAt: REQUESTED_AT,
			status: worker.worktreeSweep?.status ?? null,
			reportedAt: worker.worktreeSweep?.reportedAt ?? null,
			result: worker.worktreeSweep?.result ?? null,
		},
	};
}

beforeEach(() => {
	for (const m of [requestWorktreeSweep, getLiveSessionForWorker, publishWorktreeSweepRequest]) {
		m.mockReset();
	}
	// Connected unless a case says otherwise; the write lands and echoes the row back.
	getLiveSessionForWorker.mockResolvedValue({ fencingToken: 1 });
	requestWorktreeSweep.mockImplementation(async (id: string) => afterWrite(makeWorker({ id })));
});

describe('fanOutWorktreeSweep (issue #956)', () => {
	it('records and publishes for a machine with a live session', async () => {
		const entries = await fanOutWorktreeSweep([makeWorker()]);

		expect(requestWorktreeSweep).toHaveBeenCalledWith(WORKER_ID, expect.any(String));
		expect(publishWorktreeSweepRequest).toHaveBeenCalledExactlyOnceWith(WORKER_ID);
		expect(entries).toMatchObject([
			{ workerId: WORKER_ID, displayName: 'ada-laptop', disposition: 'requested' },
		]);
		expect(entries[0]?.worktreeSweep).toMatchObject({ requestId: 'written-request-id' });
	});

	// Offline is not "skipped": the request is durable on the row, and the router
	// states it again on the machine's next connection. This is the whole of "a
	// worker offline when the signal goes out is not skipped forever".
	it('still records and publishes for a machine with no live session', async () => {
		getLiveSessionForWorker.mockResolvedValue(undefined);

		const entries = await fanOutWorktreeSweep([makeWorker()]);

		expect(entries[0]?.disposition).toBe('queued-offline');
		expect(entries[0]?.worktreeSweep).toMatchObject({ requestId: 'written-request-id' });
		expect(requestWorktreeSweep).toHaveBeenCalledWith(WORKER_ID, expect.any(String));
		expect(publishWorktreeSweepRequest).toHaveBeenCalledExactlyOnceWith(WORKER_ID);
	});

	// Re-asking would mint a new request id for a sweep the machine may be running
	// right now, and only the request it names can ever be closed by its report.
	it('leaves an outstanding request exactly as it is', async () => {
		const entries = await fanOutWorktreeSweep([pending()]);

		expect(entries[0]?.disposition).toBe('already-asked');
		expect(entries[0]?.worktreeSweep).toMatchObject({ requestId: OUTSTANDING_REQUEST_ID });
		expect(requestWorktreeSweep).not.toHaveBeenCalled();
		expect(publishWorktreeSweepRequest).not.toHaveBeenCalled();
	});

	// A machine that has *answered* carries no outstanding request, so next week's
	// fan-out asks it again — which is the point of a weekly schedule. Asking must
	// not cost the answer: the entry still carries last week's sweep beside the
	// request just recorded, which is what `swarm workers sweeps` reads.
	it('asks a machine that already reported a previous sweep, and keeps that report', async () => {
		const reportedAt = new Date('2026-09-07T03:04:00Z');
		const answered = makeWorker({
			worktreeSweep: {
				requestId: null,
				requestedAt: REQUESTED_AT,
				status: 'swept',
				reportedAt,
				result: {
					removed: [],
					removedCount: 0,
					keptLiveCount: 2,
					failedCount: 0,
					message: 'nothing was old enough',
				},
			},
		});
		requestWorktreeSweep.mockImplementation(async () => afterWrite(answered));

		const entries = await fanOutWorktreeSweep([answered]);

		expect(entries[0]?.disposition).toBe('requested');
		expect(requestWorktreeSweep).toHaveBeenCalledWith(WORKER_ID, expect.any(String));
		expect(entries[0]?.worktreeSweep).toMatchObject({
			requestId: 'written-request-id',
			status: 'swept',
			reportedAt,
		});
	});

	// The headline: one machine's state never refuses the whole call, and the report
	// lines up with the list it was handed.
	it('reports every machine once, in input order', async () => {
		const workers = [
			makeWorker({ id: WORKER_ID, displayName: 'ada-laptop' }),
			pending({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' }),
			makeWorker({ id: THIRD_WORKER_ID, displayName: 'ada-builder' }),
		];

		const entries = await fanOutWorktreeSweep(workers);

		expect(entries.map((entry) => [entry.workerId, entry.disposition])).toEqual([
			[WORKER_ID, 'requested'],
			[OTHER_WORKER_ID, 'already-asked'],
			[THIRD_WORKER_ID, 'requested'],
		]);
		expect(requestWorktreeSweep.mock.calls.map((call) => call[0])).toEqual([
			WORKER_ID,
			THIRD_WORKER_ID,
		]);
	});

	// A request id names one request to one machine — `recordWorktreeSweepReport`
	// matches on `(worker_id, worktree_sweep_request_id)`, so a shared id would let
	// one machine's report close another's request.
	it('mints a separate request id per machine', async () => {
		await fanOutWorktreeSweep([
			makeWorker(),
			makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' }),
		]);

		const [first, second] = requestWorktreeSweep.mock.calls.map((call) => call[1]);
		expect(first).toEqual(expect.any(String));
		expect(second).not.toBe(first);
	});

	// Deregistered between the caller's read and the write: there is no machine left
	// to report on, and nothing was published for it.
	it('omits a machine that disappeared before its write landed', async () => {
		requestWorktreeSweep.mockResolvedValueOnce(undefined);

		const entries = await fanOutWorktreeSweep([
			makeWorker(),
			makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' }),
		]);

		expect(entries.map((entry) => entry.workerId)).toEqual([OTHER_WORKER_ID]);
		expect(publishWorktreeSweepRequest).toHaveBeenCalledExactlyOnceWith(OTHER_WORKER_ID);
	});

	// The acceptance criterion the unattended caller depends on: a failure on one
	// machine does not fail the sweep for the rest of the fleet. The failed machine
	// is left out of the report rather than given a fourth disposition — no durable
	// state was reached that one of the three would describe.
	it('keeps asking the rest of the fleet past a write that throws', async () => {
		requestWorktreeSweep.mockRejectedValueOnce(new Error('database unreachable'));

		const entries = await fanOutWorktreeSweep([
			makeWorker(),
			makeWorker({ id: OTHER_WORKER_ID, displayName: 'ada-desktop' }),
		]);

		expect(entries.map((entry) => entry.workerId)).toEqual([OTHER_WORKER_ID]);
		expect(requestWorktreeSweep).toHaveBeenCalledTimes(2);
		expect(publishWorktreeSweepRequest).toHaveBeenCalledExactlyOnceWith(OTHER_WORKER_ID);
	});

	it('answers an empty fleet with an empty report rather than an error', async () => {
		await expect(fanOutWorktreeSweep([])).resolves.toEqual([]);
		expect(requestWorktreeSweep).not.toHaveBeenCalled();
	});
});
