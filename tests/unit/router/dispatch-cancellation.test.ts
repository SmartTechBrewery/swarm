import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cancelRunOnWorker,
	DEFAULT_OFFLINE_WORKER_CANCEL_TIMEOUT_MS,
	resolveOfflineWorkerCancelTimeoutMs,
	subscribeDispatchCancellations,
} from '@/router/dispatch-cancellation.js';
import { awaitDispatchResult, deliverDispatchResult } from '@/router/dispatch-results.js';
import { deregisterConnection, registerConnection } from '@/router/worker-connections.js';

// The pub/sub half is Redis; mock it so the bridge from a cancellation
// notification to a pushed frame is testable without a live datastore. The two
// registries it reads are real — this test is about how they compose.
const { subscribeToRunCancellations } = vi.hoisted(() => ({
	subscribeToRunCancellations:
		vi.fn<(onCancel: (runId: string) => void) => { close: () => Promise<void> }>(),
}));
vi.mock('@/queue/cancellation.js', () => ({
	subscribeToRunCancellations,
	// The module now names the neutral terminal wording itself (issue #827).
	RUN_CANCELLED_MESSAGE: 'Run cancelled after a cancellation request.',
}));

// The other half of the offline check (issue #827) is a Postgres read; mock it so
// "does this worker hold a live session at all" is drivable from the test.
const { getLiveSessionForWorker } = vi.hoisted(() => ({
	getLiveSessionForWorker: vi.fn<(workerId: string) => Promise<unknown>>(),
}));
vi.mock('@/identity/worker-session-service.js', () => ({ getLiveSessionForWorker }));

/** The neutral message the settled run records — the same string the mock exports. */
const RUN_CANCELLED_MESSAGE = 'Run cancelled after a cancellation request.';

/** Stand-in for a `worker_sessions` row that is still live. */
const LIVE_SESSION = { id: 'session-1', workerId: 'w', fencingToken: 7 };

/** WebSocket `readyState`: OPEN. */
const OPEN = 1;

const DISPATCH_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RUN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const WORKER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_WORKER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

/**
 * What the dispatcher recorded when it pushed this dispatch. Phase and task are
 * part of it since issue #724: the pushed frame states them so the worker can
 * answer a cancel it cannot apply with a terminal result naming both.
 */
const REGISTRATION = {
	workerId: WORKER_ID,
	runId: RUN_ID,
	phase: 'review' as const,
	taskId: '724',
};

type FakeWs = WSContext & { send: ReturnType<typeof vi.fn>; readyState: number };

function fakeWs(): FakeWs {
	return { send: vi.fn(), close: vi.fn(), readyState: OPEN } as unknown as FakeWs;
}

/** Pushed frames, parsed back out of the fake socket. */
function framesOn(ws: FakeWs): Array<Record<string, unknown>> {
	return ws.send.mock.calls.map((call) => JSON.parse(String(call[0])));
}

/** Whether `awaiting.result` is still unresolved — a settled wait wins the race. */
async function stillPending(result: Promise<unknown>): Promise<boolean> {
	const sentinel = Symbol('pending');
	return (await Promise.race([result, Promise.resolve(sentinel)])) === sentinel;
}

describe('cancelRunOnWorker', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default to a still-leased worker, which is the unchanged best-effort path.
		getLiveSessionForWorker.mockResolvedValue(LIVE_SESSION);
	});
	afterEach(() => vi.useRealTimers());

	it('pushes exactly one task-cancel to the worker executing the run', () => {
		const ws = fakeWs();
		registerConnection(WORKER_ID, ws);
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		expect(cancelRunOnWorker(RUN_ID)).toBe(true);

		const frames = framesOn(ws);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: 'task-cancel',
			dispatchId: DISPATCH_ID,
			runId: RUN_ID,
			// From the registration, never from anything the worker claims — they are what
			// lets the worker answer a cancel it cannot apply (issue #724).
			phase: 'review',
			taskId: '724',
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
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);
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
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		expect(cancelRunOnWorker(RUN_ID)).toBe(true);
		expect(framesOn(target)).toHaveLength(1);
		expect(bystander.send).not.toHaveBeenCalled();

		awaiting.dispose();
		deregisterConnection(WORKER_ID, target);
		deregisterConnection(OTHER_WORKER_ID, bystander);
	});

	it('reports false rather than throwing when the worker is no longer connected', () => {
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		expect(cancelRunOnWorker(RUN_ID)).toBe(false);

		awaiting.dispose();
	});

	it('settles a terminated run whose worker holds no live session (issue #827)', async () => {
		vi.useFakeTimers();
		// No socket registered *and* no `worker_sessions` row: the phase cannot be
		// executing anywhere, so waiting out the phase's agent timeout settles nothing.
		getLiveSessionForWorker.mockResolvedValue(undefined);
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		expect(cancelRunOnWorker(RUN_ID)).toBe(false);
		await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_WORKER_CANCEL_TIMEOUT_MS);

		expect(getLiveSessionForWorker).toHaveBeenCalledWith(WORKER_ID);
		// `cancelled: true` is what routes this to `RunTerminatedError` and so to the
		// same settle a worker-reported cancellation gets; the phase and task come from
		// the registration, as every synthetic terminal frame's do (issue #724).
		await expect(awaiting.result).resolves.toEqual({
			type: 'task-execution-result',
			dispatchId: DISPATCH_ID,
			status: 'failed',
			phase: 'review',
			taskId: '724',
			error: RUN_CANCELLED_MESSAGE,
			reason: RUN_CANCELLED_MESSAGE,
			cancelled: true,
		});

		awaiting.dispose();
	});

	it('leaves the wait alone when the worker still holds a live session', async () => {
		vi.useFakeTimers();
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		expect(cancelRunOnWorker(RUN_ID)).toBe(false);
		await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_WORKER_CANCEL_TIMEOUT_MS * 5);

		// The push merely missed a leased worker: it may reconnect and report, and only
		// it knows whether the phase is still executing there.
		expect(await stillPending(awaiting.result)).toBe(true);

		awaiting.dispose();
	});

	it('leaves the wait alone when the worker session cannot be read', async () => {
		vi.useFakeTimers();
		// Fail safe: an unreadable session is not proof of absence.
		getLiveSessionForWorker.mockRejectedValue(new Error('connection terminated'));
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		expect(cancelRunOnWorker(RUN_ID)).toBe(false);
		await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_WORKER_CANCEL_TIMEOUT_MS * 5);

		expect(await stillPending(awaiting.result)).toBe(true);

		awaiting.dispose();
	});

	it('arms nothing when the push succeeded', async () => {
		vi.useFakeTimers();
		const ws = fakeWs();
		registerConnection(WORKER_ID, ws);
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		expect(cancelRunOnWorker(RUN_ID)).toBe(true);
		await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_WORKER_CANCEL_TIMEOUT_MS * 5);

		// The worker owns the terminal state of a dispatch it acknowledged the cancel for.
		expect(getLiveSessionForWorker).not.toHaveBeenCalled();
		expect(await stillPending(awaiting.result)).toBe(true);

		awaiting.dispose();
		deregisterConnection(WORKER_ID, ws);
	});

	it('arms nothing for a run this router is not executing', async () => {
		vi.useFakeTimers();
		expect(cancelRunOnWorker(RUN_ID)).toBe(false);
		await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_WORKER_CANCEL_TIMEOUT_MS);

		expect(getLiveSessionForWorker).not.toHaveBeenCalled();
	});

	it('lets a real result win, leaving the late timer a no-op', async () => {
		vi.useFakeTimers();
		getLiveSessionForWorker.mockResolvedValue(undefined);
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		expect(cancelRunOnWorker(RUN_ID)).toBe(false);
		expect(
			deliverDispatchResult({
				type: 'task-execution-result',
				dispatchId: DISPATCH_ID,
				status: 'succeeded',
				phase: 'review',
				taskId: '724',
				exitCode: 0,
			}),
		).toBe(true);
		await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_WORKER_CANCEL_TIMEOUT_MS);

		// Delivering consumed the registration, so the timer found nothing to settle.
		await expect(awaiting.result).resolves.toMatchObject({ status: 'succeeded' });

		awaiting.dispose();
	});
});

describe('resolveOfflineWorkerCancelTimeoutMs', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('defaults to one minute when the variable is unset', () => {
		vi.stubEnv('SWARM_OFFLINE_WORKER_CANCEL_TIMEOUT_MS', '');
		expect(resolveOfflineWorkerCancelTimeoutMs()).toBe(60_000);
		expect(DEFAULT_OFFLINE_WORKER_CANCEL_TIMEOUT_MS).toBe(60_000);
	});

	it('accepts a configured positive integer', () => {
		expect(resolveOfflineWorkerCancelTimeoutMs('5000')).toBe(5000);
	});

	it.each(['0', '-1', 'abc', '1.5'])('rejects %s, naming the variable', (raw) => {
		expect(() => resolveOfflineWorkerCancelTimeoutMs(raw)).toThrow(
			'SWARM_OFFLINE_WORKER_CANCEL_TIMEOUT_MS',
		);
	});
});

describe('subscribeDispatchCancellations', () => {
	beforeEach(() => vi.clearAllMocks());

	it('forwards each notification to the executing worker', async () => {
		const close = vi.fn(async () => {});
		subscribeToRunCancellations.mockImplementation(() => ({ close }));
		const ws = fakeWs();
		registerConnection(WORKER_ID, ws);
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

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
