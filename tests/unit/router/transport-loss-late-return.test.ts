import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worker } from '@/identity/worker.js';
import type { PMProvider } from '@/pm/types.js';
import {
	awaitDispatchResult,
	deliverDispatchResult,
	isDispatchOrphanedFrom,
	noteWorkerTransportLost,
} from '@/router/dispatch-results.js';
import {
	reapDispatchesIfTransportStaysLost,
	stopOrphanedDispatchesOnReturn,
	TRANSPORT_LOST_ORPHAN_REASON,
} from '@/router/transport-loss-reaper.js';
import { deregisterConnection, registerConnection } from '@/router/worker-connections.js';
import {
	handleAddPmComment,
	handleAddPmLabel,
	handleCreateWorkItem,
	handleMoveWorkItem,
	handleUpdateWorkItem,
	ORPHANED_DISPATCH_DELIVERY_REASON,
	type WorkerDeliveryDeps,
} from '@/router/worker-delivery.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';
import {
	createMockProjectConfig,
	createMockWorkItem,
	toProjectRecord,
} from '../../helpers/factories.js';

/**
 * Issue #1073, end to end on the real registries: the 2026-10-08 incident on
 * `under-control-platform`. Planning for #568 was pushed to a worker whose transport
 * dropped and stayed gone past the grace, so the reap settled the run `failed`. The
 * machine came back 12 minutes later with the agent still running. It then renamed
 * #568, created child #587, labelled both, moved them to Ready and posted the plan
 * comment, and its `succeeded` result was dropped. Both cards stranded in Ready with
 * no run and no dispatch.
 *
 * Only the run-output sink (Postgres) and the TTL source are mocked. The reaper, the
 * result registry, the connection registry and the delivery handlers are real.
 */

const { persistControlPlaneNote } = vi.hoisted(() => ({
	persistControlPlaneNote: vi.fn<(runId: string | undefined, content: string) => void>(),
}));
vi.mock('@/router/stream-log-persistence.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/router/stream-log-persistence.js')>()),
	persistControlPlaneNote,
}));
vi.mock('@/identity/worker-session-service.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/identity/worker-session-service.js')>()),
	resolveHeartbeatTtlMs: () => 60_000,
}));

/** `max(2 × ttl, 2m)` for the mocked 60s TTL — the 120000 ms the incident's log shows. */
const GRACE_MS = 120_000;

const DISPATCH_ID = 'ee14c88f-1f88-4b64-a740-4c308ec011e5';
const RUN_ID = '8bb1eb3f-5097-41f7-98fb-eda865b2656b';
const WORKER_ID = '55555555-5555-4555-8555-555555555555';
/** The worker the automatic retry lands on (issue #1075). */
const RETRY_WORKER_ID = '66666666-6666-4666-8666-666666666666';
const CREDENTIAL = 'karolina-uc-platform-credential';

const PLANNING = { workerId: WORKER_ID, runId: RUN_ID, phase: 'planning' as const, taskId: '568' };

type FakeWs = WSContext & { send: ReturnType<typeof vi.fn>; readyState: number };

function fakeWs(): FakeWs {
	return { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as FakeWs;
}

/** The board, as the delivery API would write it under the project's PM credential. */
function boardSpies() {
	return {
		updateWorkItem: vi.fn().mockResolvedValue(undefined),
		createWorkItem: vi.fn().mockResolvedValue(createMockWorkItem({ id: 'ITEM_587' })),
		addLabel: vi.fn().mockResolvedValue(undefined),
		moveWorkItem: vi.fn().mockResolvedValue(undefined),
		addComment: vi.fn().mockResolvedValue('IC_plan'),
	};
}

/** The delivery API with its real dispatch fence, and the board behind it. */
function deliveryDeps(
	board: ReturnType<typeof boardSpies>,
	workerId = WORKER_ID,
): WorkerDeliveryDeps {
	const record = toProjectRecord(createMockProjectConfig());
	return {
		resolveWorkerByCredential: vi.fn().mockResolvedValue({ id: workerId } as Worker),
		findProjectRecordById: vi.fn().mockResolvedValue(record),
		isWorkerEnrolled: vi.fn().mockResolvedValue(true),
		// The production default: the in-process registry the reap writes.
		isDispatchOrphaned: isDispatchOrphanedFrom,
		buildScmDelivery: vi.fn(),
		buildPmProvider: vi.fn(() => board as unknown as PMProvider),
		reviewLedger: {
			getPriorSubmittedReview: vi.fn(),
			markReviewVerdictSubmitted: vi.fn(),
			abandonReviewVerdict: vi.fn(),
		},
		scheduleFollowUpReview: vi.fn(),
		persistCliQuota: vi.fn(),
		recordWorkerUpdateReport: vi.fn(),
		recordWorktreeSweepReport: vi.fn(),
		advanceWorkerRollout: vi.fn(),
	};
}

/** Planning's delivery step, as the late phase made it, every call naming its dispatch. */
async function planningDelivery(deps: WorkerDeliveryDeps): Promise<number[]> {
	const call = {
		projectId: 'swarm',
		dispatchId: DISPATCH_ID,
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
	};
	const results = [
		await handleUpdateWorkItem(deps, CREDENTIAL, {
			...call,
			itemId: 'ITEM_568',
			title: 'Phase 1 of 2 — the smaller first task',
		}),
		await handleCreateWorkItem(deps, CREDENTIAL, {
			...call,
			title: 'Phase 2 of 2 — the rest',
			description: 'child body',
			status: 'planning',
		}),
		await handleAddPmLabel(deps, CREDENTIAL, { ...call, itemId: 'ITEM_587', name: 'planned' }),
		await handleMoveWorkItem(deps, CREDENTIAL, { ...call, itemId: 'ITEM_587', status: 'todo' }),
		await handleMoveWorkItem(deps, CREDENTIAL, { ...call, itemId: 'ITEM_568', status: 'todo' }),
		await handleAddPmComment(deps, CREDENTIAL, { ...call, itemId: 'ITEM_568', body: 'the plan' }),
	];
	return results.map((result) => result.status);
}

/** The socket close, as the transport's default `onWorkerTransportLost` handles it. */
function transportLost(): void {
	reapDispatchesIfTransportStaysLost(WORKER_ID, noteWorkerTransportLost(WORKER_ID));
}

describe('a phase reaped on transport loss that finishes on its reconnected worker (issue #1073)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});
	afterEach(() => vi.useRealTimers());

	it('is stopped on return, cannot write the board, and its late success is dropped', async () => {
		const awaiting = awaitDispatchResult(DISPATCH_ID, PLANNING);

		// 20:44:31Z — the transport drops; 20:46:31Z — the grace expires and the run is
		// settled as a `transport-lost` deferral, retried automatically later (#1075).
		transportLost();
		await vi.advanceTimersByTimeAsync(GRACE_MS);
		const settled = await awaiting.result;
		expect(settled).toMatchObject({
			status: 'deferred',
			failureKind: 'transport-lost',
			reason: TRANSPORT_LOST_ORPHAN_REASON,
		});
		awaiting.dispose();

		// ~20:58Z — the worker reconnects. Its stream opening tells it to stop the phase.
		const returned = fakeWs();
		registerConnection(WORKER_ID, returned);
		stopOrphanedDispatchesOnReturn(WORKER_ID);
		expect(JSON.parse(String(returned.send.mock.calls[0][0]))).toMatchObject({
			type: 'task-cancel',
			dispatchId: DISPATCH_ID,
			runId: RUN_ID,
			phase: 'planning',
			taskId: '568',
		});

		// 21:05Z — the late phase's board writes, which in the incident renamed #568,
		// created #587 and moved both to Ready. Every one is refused, and the board is
		// never reached, so it still agrees with the run: nothing moved.
		const board = boardSpies();
		const deps = deliveryDeps(board);
		expect(await planningDelivery(deps)).toEqual([409, 409, 409, 409, 409, 409]);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
		for (const write of Object.values(board)) expect(write).not.toHaveBeenCalled();
		const refused = await handleMoveWorkItem(deps, CREDENTIAL, {
			projectId: 'swarm',
			dispatchId: DISPATCH_ID,
			itemId: 'ITEM_568',
			status: 'todo',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
		expect(refused.json).toEqual({ reason: ORPHANED_DISPATCH_DELIVERY_REASON });

		// 21:05:26Z — the late `succeeded` result. Dropped: the run settled once, on the
		// reap, and nothing settles it a second time.
		expect(
			deliverDispatchResult(
				{
					type: 'task-execution-result',
					dispatchId: DISPATCH_ID,
					status: 'succeeded',
					phase: 'planning',
					taskId: '568',
					movedTo: 'todo',
				},
				WORKER_ID,
			),
		).toBe(false);
		expect(await awaiting.result).toBe(settled);

		// That result was the late phase's last word, so the orphan is gone and a later
		// reconnect is not told to stop anything.
		returned.send.mockClear();
		stopOrphanedDispatchesOnReturn(WORKER_ID);
		expect(returned.send).not.toHaveBeenCalled();
		deregisterConnection(WORKER_ID, returned);
	});

	it('leaves a worker that came back inside the grace writing the board as before', async () => {
		const awaiting = awaitDispatchResult(DISPATCH_ID, PLANNING);

		transportLost();
		await vi.advanceTimersByTimeAsync(GRACE_MS / 2);
		const reconnected = fakeWs();
		registerConnection(WORKER_ID, reconnected);
		stopOrphanedDispatchesOnReturn(WORKER_ID);
		await vi.advanceTimersByTimeAsync(GRACE_MS);

		// Not reaped: no stop, and its delivery is served.
		expect(reconnected.send).not.toHaveBeenCalled();
		const board = boardSpies();
		expect(await planningDelivery(deliveryDeps(board))).toEqual([200, 200, 200, 200, 200, 200]);
		expect(board.moveWorkItem).toHaveBeenCalledWith('ITEM_568', 'todo');

		// And its result settles the run the ordinary way.
		expect(
			deliverDispatchResult(
				{
					type: 'task-execution-result',
					dispatchId: DISPATCH_ID,
					status: 'succeeded',
					phase: 'planning',
					taskId: '568',
					movedTo: 'todo',
				},
				WORKER_ID,
			),
		).toBe(true);
		await expect(awaiting.result).resolves.toMatchObject({ status: 'succeeded', movedTo: 'todo' });
		awaiting.dispose();
		deregisterConnection(WORKER_ID, reconnected);
	});

	it('keeps the orphan off its automatic retry on another worker under the same dispatch id (issue #1075)', async () => {
		const awaiting = awaitDispatchResult(DISPATCH_ID, PLANNING);
		transportLost();
		await vi.advanceTimersByTimeAsync(GRACE_MS);
		await expect(awaiting.result).resolves.toMatchObject({ status: 'deferred' });
		awaiting.dispose();

		// The automatic retry reuses the dispatch id and is pushed to another worker.
		const retry = awaitDispatchResult(DISPATCH_ID, { ...PLANNING, workerId: RETRY_WORKER_ID });

		// The lost worker comes back while the retry runs: it is still told to stop.
		const returned = fakeWs();
		registerConnection(WORKER_ID, returned);
		stopOrphanedDispatchesOnReturn(WORKER_ID);
		expect(JSON.parse(String(returned.send.mock.calls[0][0]))).toMatchObject({
			type: 'task-cancel',
			dispatchId: DISPATCH_ID,
			runId: RUN_ID,
		});

		// Its delivery calls are refused, while the retry's worker is served.
		const lostBoard = boardSpies();
		expect(await planningDelivery(deliveryDeps(lostBoard))).toEqual([409, 409, 409, 409, 409, 409]);
		for (const write of Object.values(lostBoard)) expect(write).not.toHaveBeenCalled();
		const retryBoard = boardSpies();
		expect(await planningDelivery(deliveryDeps(retryBoard, RETRY_WORKER_ID))).toEqual([
			200, 200, 200, 200, 200, 200,
		]);

		// Its answer to the stop does not resolve the retry's wait.
		expect(
			deliverDispatchResult(
				{
					type: 'task-execution-result',
					dispatchId: DISPATCH_ID,
					status: 'failed',
					cancelled: true,
					phase: 'planning',
					taskId: '568',
				},
				WORKER_ID,
			),
		).toBe(false);
		expect(
			deliverDispatchResult(
				{
					type: 'task-execution-result',
					dispatchId: DISPATCH_ID,
					status: 'succeeded',
					phase: 'planning',
					taskId: '568',
					movedTo: 'todo',
				},
				RETRY_WORKER_ID,
			),
		).toBe(true);
		await expect(retry.result).resolves.toMatchObject({ status: 'succeeded', movedTo: 'todo' });
		retry.dispose();
		deregisterConnection(WORKER_ID, returned);
	});
});
