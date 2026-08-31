import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	awaitDispatchResult,
	deliverDispatchResult,
	noteWorkerTransportLost,
} from '@/router/dispatch-results.js';
import { TRANSPORT_LOST_ORPHAN_NOTE } from '@/router/stream-log-persistence.js';
import {
	reapDispatchesIfTransportStaysLost,
	TRANSPORT_LOST_ORPHAN_REASON,
} from '@/router/transport-loss-reaper.js';
import { deregisterConnection, registerConnection } from '@/router/worker-connections.js';

// The run's output stream is Postgres; mock the sink so the corrective note is
// assertable without a database. The two registries the reaper composes
// (`dispatch-results`, `worker-connections`) are real — this test is about how they
// compose, exactly as the sibling cancellation test drives them.
const { persistControlPlaneNote } = vi.hoisted(() => ({
	persistControlPlaneNote: vi.fn<(runId: string | undefined, content: string) => void>(),
}));
vi.mock('@/router/stream-log-persistence.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/router/stream-log-persistence.js')>()),
	persistControlPlaneNote,
}));

// The grace is derived from the heartbeat TTL, so the service that resolves it is
// mocked to a fixed value rather than left to the environment.
vi.mock('@/identity/worker-session-service.js', () => ({
	resolveHeartbeatTtlMs: () => HEARTBEAT_TTL_MS,
}));

/** The TTL the mocked service reports, matching `DEFAULT_WORKER_HEARTBEAT_TTL_MS`. */
const HEARTBEAT_TTL_MS = 60_000;

/**
 * The grace the reaper waits out: `max(2 × ttl, 2m)`. Kept here as the literal the
 * production helper resolves to, so a change to either is caught rather than tracked.
 */
const GRACE_MS = 120_000;

/** WebSocket `readyState`: OPEN. */
const OPEN = 1;

const DISPATCH_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DISPATCH_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_RUN_ID = '44444444-4444-4444-8444-444444444444';
const WORKER_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_WORKER_ID = '66666666-6666-4666-8666-666666666666';

/**
 * The live incident's shape: a Respond-to-review dispatch, awaited here, whose
 * worker's transport dropped and never came back.
 */
const REGISTRATION = {
	workerId: WORKER_ID,
	runId: RUN_ID,
	phase: 'respond-to-review' as const,
	taskId: '118',
};

type FakeWs = WSContext & { send: ReturnType<typeof vi.fn>; readyState: number };

function fakeWs(): FakeWs {
	return { send: vi.fn(), close: vi.fn(), readyState: OPEN } as unknown as FakeWs;
}

/** Whether `result` is still unresolved — a settled wait wins the race. */
async function stillPending(result: Promise<unknown>): Promise<boolean> {
	const sentinel = Symbol('pending');
	return (await Promise.race([result, Promise.resolve(sentinel)])) === sentinel;
}

/**
 * The socket close, as the transport observes it: record the interruption against
 * every dispatch awaited on the worker, then arm the reap with what came back —
 * what `defaultDeps().onWorkerTransportLost` does.
 */
function transportLost(workerId: string): void {
	reapDispatchesIfTransportStaysLost(workerId, noteWorkerTransportLost(workerId));
}

describe('reapDispatchesIfTransportStaysLost (issue #859)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	it('settles a dispatch whose worker never returns, inside the grace', async () => {
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		transportLost(WORKER_ID);
		await vi.advanceTimersByTimeAsync(GRACE_MS);

		// Terminal `failed` with no `cancelled` key: a plain failure, not a
		// termination, so nothing re-dispatches it.
		await expect(awaiting.result).resolves.toEqual({
			type: 'task-execution-result',
			dispatchId: DISPATCH_ID,
			status: 'failed',
			phase: 'respond-to-review',
			taskId: '118',
			error: TRANSPORT_LOST_ORPHAN_REASON,
			reason: TRANSPORT_LOST_ORPHAN_REASON,
		});
		expect(persistControlPlaneNote).toHaveBeenCalledWith(RUN_ID, TRANSPORT_LOST_ORPHAN_NOTE);
	});

	it('bounds the settle by worker liveness, not by the phase — nothing fires early', async () => {
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		transportLost(WORKER_ID);
		await vi.advanceTimersByTimeAsync(GRACE_MS - 1);

		expect(await stillPending(awaiting.result)).toBe(true);
		expect(persistControlPlaneNote).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(await stillPending(awaiting.result)).toBe(false);
	});

	it('leaves a blip alone: a worker that reconnects inside the grace is not reaped', async () => {
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		transportLost(WORKER_ID);
		await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
		const reconnected = fakeWs();
		registerConnection(WORKER_ID, reconnected);
		await vi.advanceTimersByTimeAsync(GRACE_MS * 4);

		expect(await stillPending(awaiting.result)).toBe(true);
		expect(persistControlPlaneNote).not.toHaveBeenCalled();
		awaiting.dispose();
		deregisterConnection(WORKER_ID, reconnected);
	});

	it('touches only the dispatches that drop interrupted', async () => {
		const orphan = awaitDispatchResult(DISPATCH_ID, REGISTRATION);
		const elsewhere = awaitDispatchResult(OTHER_DISPATCH_ID, {
			workerId: OTHER_WORKER_ID,
			runId: OTHER_RUN_ID,
			phase: 'review' as const,
			taskId: '119',
		});

		transportLost(WORKER_ID);
		await vi.advanceTimersByTimeAsync(GRACE_MS);

		expect(await stillPending(orphan.result)).toBe(false);
		expect(await stillPending(elsewhere.result)).toBe(true);
		expect(persistControlPlaneNote).toHaveBeenCalledTimes(1);
		expect(persistControlPlaneNote).not.toHaveBeenCalledWith(OTHER_RUN_ID, expect.anything());
		elsewhere.dispose();
	});

	it('is a no-op for a dispatch that settled inside the grace', async () => {
		const awaiting = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		transportLost(WORKER_ID);
		// The worker came back on another router, or the result had already been
		// delivered: the wait ends on its own before the grace elapses.
		deliverDispatchResult({
			type: 'task-execution-result',
			dispatchId: DISPATCH_ID,
			status: 'succeeded',
			phase: 'respond-to-review',
			taskId: '118',
		});
		await vi.advanceTimersByTimeAsync(GRACE_MS);

		await expect(awaiting.result).resolves.toMatchObject({ status: 'succeeded' });
		expect(persistControlPlaneNote).not.toHaveBeenCalled();
	});

	it('does not settle a dispatch id re-pushed to another worker inside the grace', async () => {
		const first = awaitDispatchResult(DISPATCH_ID, REGISTRATION);

		transportLost(WORKER_ID);
		// `scheduleDispatchRetry` reuses dispatch ids across attempts: the re-push
		// supersedes the first waiter (resolving it `deferred`) and names a new worker.
		const second = awaitDispatchResult(DISPATCH_ID, {
			...REGISTRATION,
			workerId: OTHER_WORKER_ID,
			runId: OTHER_RUN_ID,
		});
		await vi.advanceTimersByTimeAsync(GRACE_MS);

		await expect(first.result).resolves.toMatchObject({ status: 'deferred' });
		expect(await stillPending(second.result)).toBe(true);
		expect(persistControlPlaneNote).not.toHaveBeenCalled();
		second.dispose();
	});

	it('records a reason distinguishable from a lease expiry and from a termination', () => {
		expect(TRANSPORT_LOST_ORPHAN_REASON).toContain("worker's transport session was lost");
		// The three reasons this must stay distinct from, as string literals: the lease
		// reconciler's and the supersede's are module-private constants
		// (`@/dispatch/reconciler.js`), and exporting either only to assert here would
		// widen that module's surface for a test.
		expect(TRANSPORT_LOST_ORPHAN_REASON).not.toBe(
			'Worker lease expired without the dispatch settling — reconciled as failed (dead worker or crashed phase)',
		);
		expect(TRANSPORT_LOST_ORPHAN_REASON).not.toBe(
			"The worker's session was superseded by a newer one while this phase was executing — settled from that signal, not from the lease window",
		);
		expect(TRANSPORT_LOST_ORPHAN_REASON).not.toBe('Run cancelled after a cancellation request.');
	});
});
