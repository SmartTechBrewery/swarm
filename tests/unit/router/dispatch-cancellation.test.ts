import type { WSContext } from 'hono/ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cancelRunOnWorker,
	subscribeDispatchCancellations,
} from '@/router/dispatch-cancellation.js';
import { awaitDispatchResult } from '@/router/dispatch-results.js';
import { deregisterConnection, registerConnection } from '@/router/worker-connections.js';

// The pub/sub half is Redis; mock it so the bridge from a cancellation
// notification to a pushed frame is testable without a live datastore. The two
// registries it reads are real — this test is about how they compose.
const { subscribeToRunCancellations } = vi.hoisted(() => ({
	subscribeToRunCancellations:
		vi.fn<(onCancel: (runId: string) => void) => { close: () => Promise<void> }>(),
}));
vi.mock('@/queue/cancellation.js', () => ({ subscribeToRunCancellations }));

/** WebSocket `readyState`: OPEN. */
const OPEN = 1;

const DISPATCH_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RUN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WORKER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_WORKER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

type FakeWs = WSContext & { send: ReturnType<typeof vi.fn>; readyState: number };

function fakeWs(): FakeWs {
	return { send: vi.fn(), close: vi.fn(), readyState: OPEN } as unknown as FakeWs;
}

/** Pushed frames, parsed back out of the fake socket. */
function framesOn(ws: FakeWs): Array<Record<string, unknown>> {
	return ws.send.mock.calls.map((call) => JSON.parse(String(call[0])));
}

describe('cancelRunOnWorker', () => {
	beforeEach(() => vi.clearAllMocks());

	it('pushes exactly one task-cancel to the worker executing the run', () => {
		const ws = fakeWs();
		registerConnection(WORKER_ID, ws);
		const awaiting = awaitDispatchResult(DISPATCH_ID, { workerId: WORKER_ID, runId: RUN_ID });

		expect(cancelRunOnWorker(RUN_ID)).toBe(true);

		const frames = framesOn(ws);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: 'task-cancel',
			dispatchId: DISPATCH_ID,
			runId: RUN_ID,
		});
		// Log context only — the run's terminal wording stays the control plane's
		// neutral `RUN_CANCELLED_MESSAGE` (issue #305).
		expect(String(frames[0].reason)).not.toMatch(/user|dashboard/i);

		awaiting.dispose();
		deregisterConnection(WORKER_ID, ws);
	});

	it('pushes nothing for a run this router is not executing', () => {
		const ws = fakeWs();
		registerConnection(WORKER_ID, ws);

		expect(cancelRunOnWorker(RUN_ID)).toBe(false);
		expect(ws.send).not.toHaveBeenCalled();

		deregisterConnection(WORKER_ID, ws);
	});

	it('pushes nothing once the dispatch has settled', () => {
		const ws = fakeWs();
		registerConnection(WORKER_ID, ws);
		const awaiting = awaitDispatchResult(DISPATCH_ID, { workerId: WORKER_ID, runId: RUN_ID });
		awaiting.dispose();

		expect(cancelRunOnWorker(RUN_ID)).toBe(false);
		expect(ws.send).not.toHaveBeenCalled();

		deregisterConnection(WORKER_ID, ws);
	});

	it('addresses the worker the dispatch was pushed to, not another connected one', () => {
		const target = fakeWs();
		const bystander = fakeWs();
		registerConnection(WORKER_ID, target);
		registerConnection(OTHER_WORKER_ID, bystander);
		const awaiting = awaitDispatchResult(DISPATCH_ID, { workerId: WORKER_ID, runId: RUN_ID });

		expect(cancelRunOnWorker(RUN_ID)).toBe(true);
		expect(framesOn(target)).toHaveLength(1);
		expect(bystander.send).not.toHaveBeenCalled();

		awaiting.dispose();
		deregisterConnection(WORKER_ID, target);
		deregisterConnection(OTHER_WORKER_ID, bystander);
	});

	it('reports false rather than throwing when the worker is no longer connected', () => {
		const awaiting = awaitDispatchResult(DISPATCH_ID, { workerId: WORKER_ID, runId: RUN_ID });

		expect(cancelRunOnWorker(RUN_ID)).toBe(false);

		awaiting.dispose();
	});
});

describe('subscribeDispatchCancellations', () => {
	beforeEach(() => vi.clearAllMocks());

	it('forwards each notification to the executing worker', async () => {
		const close = vi.fn(async () => {});
		subscribeToRunCancellations.mockImplementation(() => ({ close }));
		const ws = fakeWs();
		registerConnection(WORKER_ID, ws);
		const awaiting = awaitDispatchResult(DISPATCH_ID, { workerId: WORKER_ID, runId: RUN_ID });

		const subscription = subscribeDispatchCancellations();
		const notify = subscribeToRunCancellations.mock.calls[0][0];
		notify(RUN_ID);
		// A run nothing here dispatched must not produce a second push.
		notify('99999999-9999-4999-8999-999999999999');

		expect(framesOn(ws)).toHaveLength(1);
		await subscription.close();
		expect(close).toHaveBeenCalledTimes(1);

		awaiting.dispose();
		deregisterConnection(WORKER_ID, ws);
	});
});
