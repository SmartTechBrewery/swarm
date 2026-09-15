import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worker } from '@/identity/worker.js';
import { deregisterConnection, registerConnection } from '@/router/worker-connections.js';
import {
	pushPendingWorkerUpdate,
	resendPendingWorkerUpdateToWorker,
} from '@/router/worker-update-dispatch.js';

/**
 * The bridge from a recorded update request to a pushed frame (issue #933),
 * re-addressed to the durable queued unit that carries it (issue #972).
 *
 * Two collaborators are mocked and one is not, on the same reasoning
 * `dispatch-cancellation.test.ts` gives: the dispatch promotion and the Postgres
 * read are datastores, while the connected-worker registry is the real one, because
 * *which socket the frame lands on* is the thing under test.
 */

const { promoteWorkerUpdateDispatchForWorker } = vi.hoisted(() => ({
	promoteWorkerUpdateDispatchForWorker: vi.fn<(workerId: string) => Promise<boolean>>(),
}));
vi.mock('@/dispatch/dispatcher.js', () => ({ promoteWorkerUpdateDispatchForWorker }));

const { getWorker } = vi.hoisted(() => ({
	getWorker: vi.fn<(id: string) => Promise<Worker | undefined>>(),
}));
vi.mock('@/identity/worker-service.js', () => ({ getWorker }));

/** WebSocket `readyState`: OPEN. */
const OPEN = 1;

const WORKER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_WORKER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const REQUEST_ID = '66666666-6666-4666-8666-666666666666';
/** A request the row has since moved off — what an id mismatch is written with. */
const OTHER_REQUEST_ID = '77777777-7777-4777-8777-777777777777';
/** Who asked for the update (issue #922) — recorded on the row, never read by the push. */
const REQUESTER_ID = '00000000-0000-4000-8000-0000000000cc';

type FakeWs = WSContext & { send: ReturnType<typeof vi.fn>; readyState: number };

function fakeWs(): FakeWs {
	return { send: vi.fn(), close: vi.fn(), readyState: OPEN } as unknown as FakeWs;
}

function framesOn(ws: FakeWs): Array<Record<string, unknown>> {
	return ws.send.mock.calls.map((call) => JSON.parse(String(call[0])));
}

/** A worker row whose `update` state is whatever a case needs it to be. */
function workerWith(update: Worker['update']): Worker {
	return {
		id: WORKER_ID,
		ownerUserId: '22222222-2222-4222-8222-222222222222',
		displayName: 'ada-laptop',
		capabilities: ['claude'],
		probedCapabilities: ['claude'],
		declaredCapabilities: null,
		supportedPhases: ['review'],
		repository: null,
		drainingSince: new Date('2026-09-13T10:00:00Z'),
		build: null,
		update,
		worktreeSweep: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

/** A request still awaiting an answer — what the push exists for. */
function pending(target = 'main'): Worker['update'] {
	return {
		requestId: REQUEST_ID,
		target,
		requestedAt: new Date('2026-09-13T10:05:00Z'),
		requestedByUserId: REQUESTER_ID,
		status: null,
		message: null,
		reportedAt: null,
	};
}

/** A request the machine has already answered: nothing is owed a push. */
function reported(): Worker['update'] {
	return {
		requestId: null,
		target: 'main',
		requestedAt: new Date('2026-09-13T10:05:00Z'),
		requestedByUserId: REQUESTER_ID,
		status: 'applied',
		message: 'Applied.',
		reportedAt: new Date('2026-09-13T10:09:00Z'),
	};
}

let connections: Array<{ workerId: string; ws: FakeWs }> = [];

function connect(workerId: string): FakeWs {
	const ws = fakeWs();
	registerConnection(workerId, ws);
	connections.push({ workerId, ws });
	return ws;
}

beforeEach(() => {
	promoteWorkerUpdateDispatchForWorker.mockReset();
	promoteWorkerUpdateDispatchForWorker.mockResolvedValue(true);
	getWorker.mockReset();
	connections = [];
});

afterEach(() => {
	// The registry is module-level and real, so every test cleans up after itself.
	for (const { workerId, ws } of connections) deregisterConnection(workerId, ws);
});

describe('pushPendingWorkerUpdate', () => {
	it('pushes the pending request to that worker and nobody else', async () => {
		const target = connect(WORKER_ID);
		const bystander = connect(OTHER_WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));

		await expect(pushPendingWorkerUpdate(WORKER_ID, REQUEST_ID)).resolves.toBe('pushed');

		expect(framesOn(target)).toEqual([
			{ type: 'worker-update', requestId: REQUEST_ID, target: 'main' },
		]);
		expect(framesOn(bystander)).toEqual([]);
	});

	// The dispatch names a request; the *row* names the build. So a wake-up that
	// arrives late, twice, or after a re-target cannot push a build the row moved off.
	it('pushes what the row says now, not what the dispatch payload claimed', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending('v2')));

		await pushPendingWorkerUpdate(WORKER_ID, REQUEST_ID);

		expect(framesOn(ws)[0]).toMatchObject({ target: 'v2' });
	});

	// The id match, not a bare presence check: the row has moved on to another
	// request, so this dispatch has nothing left to deliver.
	it('answers superseded when the row waits on a different request', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));

		await expect(pushPendingWorkerUpdate(WORKER_ID, OTHER_REQUEST_ID)).resolves.toBe('superseded');
		expect(framesOn(ws)).toEqual([]);
	});

	it('answers superseded when the request has already been answered', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(reported()));

		await expect(pushPendingWorkerUpdate(WORKER_ID, REQUEST_ID)).resolves.toBe('superseded');
		expect(framesOn(ws)).toEqual([]);
	});

	it('answers superseded when nobody has asked this machine to update', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(null));

		await expect(pushPendingWorkerUpdate(WORKER_ID, REQUEST_ID)).resolves.toBe('superseded');
		expect(framesOn(ws)).toEqual([]);
	});

	it('answers superseded for an unknown worker rather than throwing', async () => {
		getWorker.mockResolvedValue(undefined);

		await expect(pushPendingWorkerUpdate(WORKER_ID, REQUEST_ID)).resolves.toBe('superseded');
	});

	// Not connected here is the *expected* case, since the machine has to be drained
	// before it can be asked: the dispatch waits rather than settling.
	it('answers not-connected when the worker has no socket here', async () => {
		getWorker.mockResolvedValue(workerWith(pending()));

		await expect(pushPendingWorkerUpdate(WORKER_ID, REQUEST_ID)).resolves.toBe('not-connected');
	});
});

describe('resendPendingWorkerUpdateToWorker', () => {
	// One delivery path, not two (issue #972): reconnecting wakes the queued
	// dispatch, which is what pushes — this hook never pushes on its own.
	it("wakes the machine's queued update dispatch and pushes nothing itself", async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));

		resendPendingWorkerUpdateToWorker(WORKER_ID);
		await vi.waitFor(() =>
			expect(promoteWorkerUpdateDispatchForWorker).toHaveBeenCalledExactlyOnceWith(WORKER_ID),
		);

		expect(ws.send).not.toHaveBeenCalled();
		expect(getWorker).not.toHaveBeenCalled();
	});

	// Fire-and-forget by contract: the transport's connection hooks stay synchronous,
	// so a socket that just opened must never fail on this.
	it('swallows a failed promotion rather than throwing into the socket-open hook', async () => {
		connect(WORKER_ID);
		promoteWorkerUpdateDispatchForWorker.mockRejectedValue(new Error('database is down'));

		expect(() => resendPendingWorkerUpdateToWorker(WORKER_ID)).not.toThrow();
		await vi.waitFor(() => expect(promoteWorkerUpdateDispatchForWorker).toHaveBeenCalled());
	});
});
