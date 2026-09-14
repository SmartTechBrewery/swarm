import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worker } from '@/identity/worker.js';
import { deregisterConnection, registerConnection } from '@/router/worker-connections.js';
import {
	pushPendingWorkerUpdate,
	resendPendingWorkerUpdateToWorker,
	subscribeWorkerUpdateDispatch,
} from '@/router/worker-update-dispatch.js';

/**
 * The bridge from a recorded update request to a pushed frame (issue #933).
 *
 * Two collaborators are mocked and one is not, on the same reasoning
 * `dispatch-cancellation.test.ts` gives: the Redis subscription and the Postgres
 * read are datastores, while the connected-worker registry is the real one, because
 * *which socket the frame lands on* is the thing under test.
 */

const { subscribeToWorkerUpdateRequests, closeWorkerUpdateRedis } = vi.hoisted(() => ({
	subscribeToWorkerUpdateRequests:
		vi.fn<(onRequest: (workerId: string) => void) => { close: () => Promise<void> }>(),
	closeWorkerUpdateRedis: vi.fn<() => Promise<void>>(),
}));
vi.mock('@/queue/worker-updates.js', () => ({
	subscribeToWorkerUpdateRequests,
	closeWorkerUpdateRedis,
}));

const { getWorker } = vi.hoisted(() => ({
	getWorker: vi.fn<(id: string) => Promise<Worker | undefined>>(),
}));
vi.mock('@/identity/worker-service.js', () => ({ getWorker }));

/** WebSocket `readyState`: OPEN. */
const OPEN = 1;

const WORKER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_WORKER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const REQUEST_ID = '66666666-6666-4666-8666-666666666666';
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
	subscribeToWorkerUpdateRequests.mockReset();
	closeWorkerUpdateRedis.mockReset();
	closeWorkerUpdateRedis.mockResolvedValue(undefined);
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

		await expect(pushPendingWorkerUpdate(WORKER_ID)).resolves.toBe(true);

		expect(framesOn(target)).toEqual([
			{ type: 'worker-update', requestId: REQUEST_ID, target: 'main' },
		]);
		expect(framesOn(bystander)).toEqual([]);
	});

	// The channel carries a worker id and nothing else, so a message that arrives
	// late, twice, or after a re-target cannot push a build the row has moved off.
	it('pushes what the row says now, not what a notification claimed', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending('v2')));

		await pushPendingWorkerUpdate(WORKER_ID);

		expect(framesOn(ws)[0]).toMatchObject({ target: 'v2' });
	});

	it('pushes nothing when the request has already been answered', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(reported()));

		await expect(pushPendingWorkerUpdate(WORKER_ID)).resolves.toBe(false);
		expect(framesOn(ws)).toEqual([]);
	});

	it('pushes nothing when nobody has asked this machine to update', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(null));

		await expect(pushPendingWorkerUpdate(WORKER_ID)).resolves.toBe(false);
		expect(framesOn(ws)).toEqual([]);
	});

	it('answers false for an unknown worker rather than throwing', async () => {
		getWorker.mockResolvedValue(undefined);

		await expect(pushPendingWorkerUpdate(WORKER_ID)).resolves.toBe(false);
	});

	// Not connected here is the *expected* case, since the machine has to be drained
	// before it can be asked: the request stays on the row for the reconnect hook.
	it('leaves the request pending when the worker has no socket here', async () => {
		getWorker.mockResolvedValue(workerWith(pending()));

		await expect(pushPendingWorkerUpdate(WORKER_ID)).resolves.toBe(false);
	});
});

describe('resendPendingWorkerUpdateToWorker', () => {
	// The notification fires once, so the socket opening is where a request recorded
	// while the machine was away is stated again.
	it('pushes a pending request when the worker reconnects', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));

		resendPendingWorkerUpdateToWorker(WORKER_ID);
		await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());

		expect(framesOn(ws)[0]).toMatchObject({ type: 'worker-update', requestId: REQUEST_ID });
	});

	// Fire-and-forget by contract: the transport's connection hooks stay synchronous,
	// so a socket that just opened must never fail on this.
	it('swallows a failed read rather than throwing into the socket-open hook', async () => {
		connect(WORKER_ID);
		getWorker.mockRejectedValue(new Error('database is down'));

		expect(() => resendPendingWorkerUpdateToWorker(WORKER_ID)).not.toThrow();
		await vi.waitFor(() => expect(getWorker).toHaveBeenCalled());
	});
});

describe('subscribeWorkerUpdateDispatch', () => {
	it('turns each notification into a push to the worker it names', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));
		let notify: ((workerId: string) => void) | undefined;
		subscribeToWorkerUpdateRequests.mockImplementation((onRequest) => {
			notify = onRequest;
			return { close: async () => {} };
		});

		const subscription = subscribeWorkerUpdateDispatch();
		notify?.(WORKER_ID);
		await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());

		expect(framesOn(ws)[0]).toMatchObject({ type: 'worker-update', target: 'main' });
		await subscription.close();
	});

	// Both halves, not just the subscriber: it is a duplicate of the shared client, so
	// quitting only the duplicate leaves the router on an open Redis socket.
	it('closes the subscriber and the shared client so the router can shut down cleanly', async () => {
		const close = vi.fn().mockResolvedValue(undefined);
		subscribeToWorkerUpdateRequests.mockReturnValue({ close });

		await subscribeWorkerUpdateDispatch().close();

		expect(close).toHaveBeenCalledTimes(1);
		expect(closeWorkerUpdateRedis).toHaveBeenCalledTimes(1);
	});
});
