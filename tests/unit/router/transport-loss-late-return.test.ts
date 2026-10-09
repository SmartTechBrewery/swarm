import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { Worker } from '@/identity/worker.js';
import type { PMProvider } from '@/pm/types.js';
import type { SwarmJob } from '@/queue/jobs.js';
import {
	awaitDispatchResult,
	deliverDispatchResult,
	isDispatchOrphanedFrom,
	noteWorkerTransportLost,
} from '@/router/dispatch-results.js';
import { LATE_RESULT_ACCEPTED_NOTE } from '@/router/stream-log-persistence.js';
import {
	acceptLateOrphanResult,
	endOrphanTrustAtClaim,
	endOrphanTrustUnlessRetryPending,
	reapDispatchesIfTransportStaysLost,
	stopOrphanedDispatchesOnReturn,
	stopOrphansOfDispatch,
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
import { type TaskExecutionResult, TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';
import type { DispatchSelection } from '@/worker/eligibility-gate.js';
import {
	createMockPmWebhookJob,
	createMockProjectConfig,
	createMockScmWebhookJob,
	createMockWorkItem,
	toProjectRecord,
} from '../../helpers/factories.js';

/**
 * Issues #1073 and #1076, end to end on the real registries: the 2026-10-08 incident
 * on `under-control-platform`. Planning for #568 was pushed to a worker whose
 * transport dropped and stayed gone past the grace, so the reap settled the run. The
 * machine came back 12 minutes later with the agent still running. It then renamed
 * #568, created child #587, labelled both, moved them to Ready and posted the plan
 * comment, and its `succeeded` result was dropped. Both cards stranded in Ready with
 * no run and no dispatch.
 *
 * Since #1076 the run is deferred for an automatic retry, and while that retry waits
 * the orphan is trusted: it is not stopped, its board writes land, and its late
 * success is adopted into the retry so `processJob` settles the run with it. Once the
 * retry takes over (or the budget is spent) the #1073 stop and fence apply.
 *
 * Only Postgres (the run-output sink and the dispatch/run rows the adoption reads and
 * writes), the wake-up publish and the TTL source are mocked. The reaper, the result
 * registry, the connection registry and the delivery handlers are real.
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
const {
	getDispatchById,
	adoptLateResultIntoScheduledRetry,
	recordRunLateResultAccepted,
	publishDispatchWakeUp,
} = vi.hoisted(() => ({
	getDispatchById: vi.fn(),
	adoptLateResultIntoScheduledRetry: vi.fn(),
	recordRunLateResultAccepted: vi.fn(),
	publishDispatchWakeUp: vi.fn(),
}));
vi.mock('@/db/repositories/dispatchesRepository.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/db/repositories/dispatchesRepository.js')>()),
	getDispatchById,
	adoptLateResultIntoScheduledRetry,
}));
vi.mock('@/db/repositories/runsRepository.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/db/repositories/runsRepository.js')>()),
	recordRunLateResultAccepted,
}));
vi.mock('@/dispatch/dispatcher.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/dispatch/dispatcher.js')>()),
	publishDispatchWakeUp,
}));

/** `max(2 × ttl, 2m)` for the mocked 60s TTL — the 120000 ms the incident's log shows. */
const GRACE_MS = 120_000;

const DISPATCH_ID = 'ee14c88f-1f88-4b64-a740-4c308ec011e5';
const RUN_ID = '8bb1eb3f-5097-41f7-98fb-eda865b2656b';
const WORKER_ID = '55555555-5555-4555-8555-555555555555';
/** The worker the automatic retry lands on (issue #1075). */
const RETRY_WORKER_ID = '66666666-6666-4666-8666-666666666666';
const CREDENTIAL = 'karolina-uc-platform-credential';

/** What the gate selected for the Planning push: the machine that went to sleep. */
const SELECTION: DispatchSelection = {
	workerId: WORKER_ID,
	workerName: 'karolina_swarm',
	ownerUserId: 'user-karolina',
	target: { cli: 'claude', model: 'opus' },
	targetIndex: 0,
	cli: 'claude',
	skippedClis: [],
};

const PLANNING = {
	workerId: WORKER_ID,
	runId: RUN_ID,
	phase: 'planning' as const,
	taskId: '568',
	selection: SELECTION,
};

/** The deferral the reap's settle stored: Planning for #568, resumed by phase. */
const DEFERRED_PAYLOAD: SwarmJob = {
	...createMockPmWebhookJob({ projectId: 'swarm' }),
	dispatchId: DISPATCH_ID,
	runId: RUN_ID,
	resumePmPhase: 'planning',
	automaticRetryAttempt: 1,
};

/** The dispatch row as phase 1's deferral left it: waiting for its automatic retry. */
function scheduledRetry(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: DISPATCH_ID,
		projectId: 'swarm',
		taskId: '568',
		phase: 'planning',
		repository: null,
		prNumber: null,
		state: 'retry-scheduled',
		waitReason: 'transport-lost',
		outcome: null,
		dedupKey: null,
		coalesceKey: null,
		continuation: false,
		priority: 0,
		attempt: 1,
		wakeSeq: 3,
		availableAt: new Date('2026-10-08T21:16:31Z'),
		jobPayload: DEFERRED_PAYLOAD,
		runId: RUN_ID,
		selectedWorkerId: null,
		workerSessionId: null,
		workerFencingToken: null,
		leaseOwner: null,
		leaseExpiresAt: null,
		lastError: TRANSPORT_LOST_ORPHAN_REASON,
		source: 'webhook',
		createdAt: new Date('2026-10-08T20:30:00Z'),
		updatedAt: new Date('2026-10-08T20:46:31Z'),
		completedAt: null,
		...overrides,
	} as DispatchRow;
}

/** The late phase's result: Planning finished, #568 and its split child #587 in Ready. */
const LATE_SUCCESS: TaskExecutionResult = {
	type: 'task-execution-result',
	dispatchId: DISPATCH_ID,
	runId: RUN_ID,
	status: 'succeeded',
	phase: 'planning',
	taskId: '568',
	exitCode: 0,
	durationMs: 1_500_000,
	movedTo: 'todo',
	advancedItemIds: ['ITEM_587'],
};

const LATE_FAILURE: TaskExecutionResult = {
	type: 'task-execution-result',
	dispatchId: DISPATCH_ID,
	status: 'failed',
	phase: 'planning',
	taskId: '568',
	error: 'agent exited 1',
};

/** A result frame arriving on the worker's socket, as the transport's default sink routes it. */
function frameFrom(workerId: string, result: TaskExecutionResult): boolean {
	return deliverDispatchResult(result, workerId, acceptLateOrphanResult);
}

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

describe('a phase reaped on transport loss that finishes on its reconnected worker (issues #1073, #1076)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		getDispatchById.mockResolvedValue(scheduledRetry());
		adoptLateResultIntoScheduledRetry.mockImplementation(
			async (id: string, _wakeSeq: number, jobPayload: SwarmJob) =>
				scheduledRetry({ id, state: 'pending', waitReason: 'late-result', wakeSeq: 4, jobPayload }),
		);
		recordRunLateResultAccepted.mockResolvedValue(undefined);
		publishDispatchWakeUp.mockResolvedValue(undefined);
	});
	afterEach(() => {
		// The registry is module state: forget whatever orphan a case left behind.
		stopOrphansOfDispatch(DISPATCH_ID, WORKER_ID);
		vi.useRealTimers();
	});

	/** Planning pushed to the worker, its transport lost, the grace expired: deferred. */
	async function reaped(): Promise<void> {
		const awaiting = awaitDispatchResult(DISPATCH_ID, PLANNING);
		// 20:44:31Z — the transport drops; 20:46:31Z — the grace expires and the run is
		// settled as a `transport-lost` deferral, retried automatically later (#1075).
		transportLost();
		await vi.advanceTimersByTimeAsync(GRACE_MS);
		await expect(awaiting.result).resolves.toMatchObject({
			status: 'deferred',
			failureKind: 'transport-lost',
			reason: TRANSPORT_LOST_ORPHAN_REASON,
		});
		awaiting.dispose();
	}

	it('replays #568: the late success settles the run through its scheduled retry, and nothing is refused', async () => {
		await reaped();

		// ~20:58Z — the worker reconnects. Its dispatch is still waiting for the
		// automatic retry, so the late phase is trusted and is not told to stop.
		const returned = fakeWs();
		registerConnection(WORKER_ID, returned);
		stopOrphanedDispatchesOnReturn(WORKER_ID);
		expect(returned.send).not.toHaveBeenCalled();

		// 21:05Z — the late phase renames #568, creates #587 and moves both to Ready.
		// Served: these writes are the run's own if its result is adopted.
		const board = boardSpies();
		expect(await planningDelivery(deliveryDeps(board))).toEqual([200, 200, 200, 200, 200, 200]);
		expect(board.moveWorkItem).toHaveBeenCalledWith('ITEM_568', 'todo');
		expect(board.moveWorkItem).toHaveBeenCalledWith('ITEM_587', 'todo');

		// 21:05:26Z — the late `succeeded` result. Adopted into the scheduled retry: made
		// due now, carrying the result and the machine that ran it.
		expect(frameFrom(WORKER_ID, LATE_SUCCESS)).toBe(false);
		await vi.waitFor(() => expect(publishDispatchWakeUp).toHaveBeenCalledTimes(1));

		expect(adoptLateResultIntoScheduledRetry).toHaveBeenCalledTimes(1);
		const [adoptedId, expectedWakeSeq, payload] = adoptLateResultIntoScheduledRetry.mock.calls[0];
		expect(adoptedId).toBe(DISPATCH_ID);
		expect(expectedWakeSeq).toBe(3);
		expect(payload).toMatchObject({
			type: 'pm',
			runId: RUN_ID,
			dispatchId: DISPATCH_ID,
			// Planning re-resolves itself even though the card is in Ready now.
			resumePmPhase: 'planning',
			adoptedResult: { result: LATE_SUCCESS, selection: SELECTION },
		});
		// A board job never claims an SCM review slot.
		expect(payload.continuationDispatchClaimed).toBeUndefined();
		expect(publishDispatchWakeUp).toHaveBeenCalledWith(
			expect.objectContaining({ id: DISPATCH_ID, state: 'pending', waitReason: 'late-result' }),
		);

		// The run says so, in its output and on its row.
		expect(persistControlPlaneNote).toHaveBeenCalledWith(RUN_ID, LATE_RESULT_ACCEPTED_NOTE);
		expect(recordRunLateResultAccepted).toHaveBeenCalledWith(RUN_ID, WORKER_ID);

		// The result was the late phase's last word: nothing is left to stop or fence,
		// and the adoption's own wake-up — which pushes nothing — has nothing to take over.
		returned.send.mockClear();
		stopOrphanedDispatchesOnReturn(WORKER_ID);
		stopOrphansOfDispatch(DISPATCH_ID, WORKER_ID);
		expect(returned.send).not.toHaveBeenCalled();
		expect(isDispatchOrphanedFrom(WORKER_ID, DISPATCH_ID)).toBe(false);
		deregisterConnection(WORKER_ID, returned);
	});

	it('claims the review slot for an SCM phase, so the adoption is not dropped as a duplicate', async () => {
		const scmPayload: SwarmJob = {
			...createMockScmWebhookJob({ projectId: 'swarm' }),
			runId: RUN_ID,
			dispatchId: DISPATCH_ID,
		};
		getDispatchById.mockResolvedValue(scheduledRetry({ jobPayload: scmPayload }));
		await reaped();

		frameFrom(WORKER_ID, LATE_SUCCESS);
		await vi.waitFor(() => expect(adoptLateResultIntoScheduledRetry).toHaveBeenCalledTimes(1));

		expect(adoptLateResultIntoScheduledRetry.mock.calls[0][2]).toMatchObject({
			continuationDispatchClaimed: true,
		});
	});

	it('drops a late failure and lets the retry run when due: the lost worker is then stopped and fenced', async () => {
		await reaped();
		const returned = fakeWs();
		registerConnection(WORKER_ID, returned);
		stopOrphanedDispatchesOnReturn(WORKER_ID);
		expect(returned.send).not.toHaveBeenCalled();

		// The late phase failed: dropped, and the dispatch is left to its retry.
		expect(frameFrom(WORKER_ID, LATE_FAILURE)).toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(getDispatchById).not.toHaveBeenCalled();
		expect(adoptLateResultIntoScheduledRetry).not.toHaveBeenCalled();

		// 21:16:31Z — the retry is due and pushed to another worker. Its push takes the
		// dispatch over: the lost worker is told to stop now, and fenced from here on.
		stopOrphansOfDispatch(DISPATCH_ID, RETRY_WORKER_ID);
		const retry = awaitDispatchResult(DISPATCH_ID, { ...PLANNING, workerId: RETRY_WORKER_ID });
		expect(JSON.parse(String(returned.send.mock.calls[0][0]))).toMatchObject({
			type: 'task-cancel',
			dispatchId: DISPATCH_ID,
			runId: RUN_ID,
			phase: 'planning',
			taskId: '568',
		});
		const lostBoard = boardSpies();
		expect(await planningDelivery(deliveryDeps(lostBoard))).toEqual([409, 409, 409, 409, 409, 409]);
		for (const write of Object.values(lostBoard)) expect(write).not.toHaveBeenCalled();
		const retryBoard = boardSpies();
		expect(await planningDelivery(deliveryDeps(retryBoard, RETRY_WORKER_ID))).toEqual([
			200, 200, 200, 200, 200, 200,
		]);

		// Its answer to the stop does not resolve the retry's wait, and is not adopted.
		expect(frameFrom(WORKER_ID, { ...LATE_FAILURE, cancelled: true })).toBe(false);
		expect(frameFrom(RETRY_WORKER_ID, LATE_SUCCESS)).toBe(true);
		await expect(retry.result).resolves.toMatchObject({ status: 'succeeded', movedTo: 'todo' });
		retry.dispose();
		expect(adoptLateResultIntoScheduledRetry).not.toHaveBeenCalled();
		deregisterConnection(WORKER_ID, returned);
	});

	it('ends the window on Retry now: the orphan is stopped and a later late success is dropped', async () => {
		await reaped();
		const returned = fakeWs();
		registerConnection(WORKER_ID, returned);

		// The operator presses Retry now; its push lands on another worker and takes over.
		stopOrphansOfDispatch(DISPATCH_ID, RETRY_WORKER_ID);
		const retry = awaitDispatchResult(DISPATCH_ID, { ...PLANNING, workerId: RETRY_WORKER_ID });
		expect(returned.send).toHaveBeenCalledTimes(1);

		// The late success arrives after the takeover: dropped, never adopted, and the
		// retry's wait — the one run — is untouched.
		expect(frameFrom(WORKER_ID, LATE_SUCCESS)).toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(getDispatchById).not.toHaveBeenCalled();
		expect(adoptLateResultIntoScheduledRetry).not.toHaveBeenCalled();
		expect(await stillPending(retry.result)).toBe(true);
		retry.dispose();
		deregisterConnection(WORKER_ID, returned);
	});

	it('drops a late success whose dispatch already moved on before the adoption', async () => {
		// Retry now reopened the dispatch an instant before the frame arrived.
		getDispatchById.mockResolvedValue(
			scheduledRetry({ state: 'pending', waitReason: 'manual-retry' }),
		);
		await reaped();

		frameFrom(WORKER_ID, LATE_SUCCESS);
		await vi.waitFor(() => expect(getDispatchById).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(0);

		expect(adoptLateResultIntoScheduledRetry).not.toHaveBeenCalled();
		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
		expect(recordRunLateResultAccepted).not.toHaveBeenCalled();
		expect(persistControlPlaneNote).not.toHaveBeenCalledWith(RUN_ID, LATE_RESULT_ACCEPTED_NOTE);
	});

	it('drops a late success that loses the compare-and-set race', async () => {
		adoptLateResultIntoScheduledRetry.mockResolvedValue(null);
		await reaped();

		frameFrom(WORKER_ID, LATE_SUCCESS);
		await vi.waitFor(() => expect(adoptLateResultIntoScheduledRetry).toHaveBeenCalledTimes(1));
		await vi.advanceTimersByTimeAsync(0);

		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
		expect(recordRunLateResultAccepted).not.toHaveBeenCalled();
	});

	it('behaves as #1073 once the budget is spent: stopped on return, fenced, late success dropped', async () => {
		await reaped();

		// The run settled terminally instead of deferring; the job's end ends the trust
		// while the worker is still away, so nothing can be pushed yet.
		getDispatchById.mockResolvedValue(scheduledRetry({ state: 'failed', waitReason: null }));
		await endOrphanTrustUnlessRetryPending(DISPATCH_ID);

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

		expect(frameFrom(WORKER_ID, LATE_SUCCESS)).toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(adoptLateResultIntoScheduledRetry).not.toHaveBeenCalled();

		// That result was the late phase's last word, so a later reconnect is not told to
		// stop anything.
		returned.send.mockClear();
		stopOrphanedDispatchesOnReturn(WORKER_ID);
		expect(returned.send).not.toHaveBeenCalled();
		deregisterConnection(WORKER_ID, returned);
	});

	// The review of #1078: a retry claimed and then deferred before it pushes — the gate
	// found no eligible worker, the only one being the machine still asleep — used to
	// leave the orphan trusted while nothing could adopt its result any more.
	it('ends the window at the claim when the retry defers before pushing: stopped on return, fenced, success dropped', async () => {
		await reaped();

		// 21:16:31Z — the retry is claimed with the lost worker still away, and the gate
		// defers it as `worker-eligibility` without pushing anything.
		endOrphanTrustAtClaim(DISPATCH_ID);
		getDispatchById.mockResolvedValue(scheduledRetry({ waitReason: 'worker-eligibility' }));
		await endOrphanTrustUnlessRetryPending(DISPATCH_ID);
		getDispatchById.mockClear();

		// 21:21:31Z — the machine wakes with Planning still running: told to stop, and its
		// board writes refused.
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
		const board = boardSpies();
		expect(await planningDelivery(deliveryDeps(board))).toEqual([409, 409, 409, 409, 409, 409]);
		for (const write of Object.values(board)) expect(write).not.toHaveBeenCalled();

		// Its late success is neither adopted nor served.
		expect(frameFrom(WORKER_ID, LATE_SUCCESS)).toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(getDispatchById).not.toHaveBeenCalled();
		expect(adoptLateResultIntoScheduledRetry).not.toHaveBeenCalled();
		deregisterConnection(WORKER_ID, returned);
	});

	// The re-review of #1078: a connected orphan used to be left trusted from the claim
	// until the push or the job's end, so a retry that deferred before pushing left its
	// board writes served in between, with nothing left to settle its result.
	it('stops and fences a connected orphan at the claim, before the retry can defer without a push', async () => {
		await reaped();
		const returned = fakeWs();
		registerConnection(WORKER_ID, returned);

		// 21:16:31Z — the retry is claimed while the worker is back with Planning still
		// running. The stop goes out at once, and every board write is refused from now.
		endOrphanTrustAtClaim(DISPATCH_ID);
		expect(JSON.parse(String(returned.send.mock.calls[0][0]))).toMatchObject({
			type: 'task-cancel',
			dispatchId: DISPATCH_ID,
			runId: RUN_ID,
			phase: 'planning',
			taskId: '568',
		});
		const board = boardSpies();
		expect(await planningDelivery(deliveryDeps(board))).toEqual([409, 409, 409, 409, 409, 409]);
		for (const write of Object.values(board)) expect(write).not.toHaveBeenCalled();

		// Its late success, arriving while the claimed job is still resolving its task,
		// is neither adopted nor allowed to settle anything.
		expect(frameFrom(WORKER_ID, LATE_SUCCESS)).toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(adoptLateResultIntoScheduledRetry).not.toHaveBeenCalled();

		// The claim then defers (the task is in flight): there is nothing left to stop.
		getDispatchById.mockResolvedValue(scheduledRetry({ waitReason: 'task-in-flight' }));
		await endOrphanTrustUnlessRetryPending(DISPATCH_ID);
		expect(returned.send).toHaveBeenCalledTimes(1);
		deregisterConnection(WORKER_ID, returned);
	});

	it('keeps the trust of an orphan whose job deferred it for its transport-lost retry', async () => {
		await reaped();

		// The job whose push was reaped ends with the dispatch waiting for that retry.
		await endOrphanTrustUnlessRetryPending(DISPATCH_ID);

		const board = boardSpies();
		expect(await planningDelivery(deliveryDeps(board))).toEqual([200, 200, 200, 200, 200, 200]);
		frameFrom(WORKER_ID, LATE_SUCCESS);
		await vi.waitFor(() => expect(adoptLateResultIntoScheduledRetry).toHaveBeenCalledTimes(1));
	});

	it('ends the trust when the dispatch cannot be read after the job', async () => {
		await reaped();
		getDispatchById.mockRejectedValue(new Error('connection terminated'));

		await endOrphanTrustUnlessRetryPending(DISPATCH_ID);

		expect(isDispatchOrphanedFrom(WORKER_ID, DISPATCH_ID)).toBe(true);
	});

	it('pushes the terminal stop at once when the lost worker is already back', async () => {
		await reaped();
		const returned = fakeWs();
		registerConnection(WORKER_ID, returned);

		stopOrphansOfDispatch(DISPATCH_ID);

		expect(JSON.parse(String(returned.send.mock.calls[0][0]))).toMatchObject({
			type: 'task-cancel',
			dispatchId: DISPATCH_ID,
		});
		expect(isDispatchOrphanedFrom(WORKER_ID, DISPATCH_ID)).toBe(true);
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

		// And its result settles the run the ordinary way, not through the adoption.
		expect(frameFrom(WORKER_ID, LATE_SUCCESS)).toBe(true);
		await expect(awaiting.result).resolves.toMatchObject({ status: 'succeeded', movedTo: 'todo' });
		awaiting.dispose();
		expect(adoptLateResultIntoScheduledRetry).not.toHaveBeenCalled();
		deregisterConnection(WORKER_ID, reconnected);
	});
});

/** Whether `result` is still unresolved — a settled wait wins the race. */
async function stillPending(result: Promise<unknown>): Promise<boolean> {
	const sentinel = Symbol('pending');
	return (await Promise.race([result, Promise.resolve(sentinel)])) === sentinel;
}
