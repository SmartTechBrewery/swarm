import { describe, expect, it, vi } from 'vitest';
import {
	awaitDispatchResult,
	deliverDispatchAck,
	deliverDispatchProgress,
	deliverDispatchResult,
	failDispatchResultWait,
	listAwaitedDispatchesForWorker,
	noteWorkerTransportLost,
	noteWorkerTransportRestored,
	resolveDispatchStreamTarget,
	resolveDispatchTargetForRun,
} from '@/router/dispatch-results.js';
import type { TaskAssignmentAck, TaskExecutionResult, TaskProgress } from '@/transport/protocol.js';

const DISPATCH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DISPATCH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** What the control plane recorded when it pushed each dispatch (issue #544 review, F1). */
const WORKER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const WORKER_B = 'bbbbbbbb-0000-4000-8000-000000000002';
// Phase/task ride along since issue #724: a pushed `task-cancel` states them, so
// the registration is where they are recorded.
const TARGET_A = {
	workerId: WORKER_A,
	runId: 'run-a',
	phase: 'implementation' as const,
	taskId: '407',
};
const TARGET_B = { workerId: WORKER_B, runId: 'run-b', phase: 'review' as const, taskId: '408' };

function result(dispatchId: string): TaskExecutionResult {
	return {
		type: 'task-execution-result',
		dispatchId,
		status: 'succeeded',
		phase: 'implementation',
		taskId: '407',
		exitCode: 0,
	};
}

function progress(dispatchId: string): TaskProgress {
	return {
		type: 'task-progress',
		dispatchId,
		phase: 'implementation',
		taskId: '407',
		state: 'branch-provisioned',
	};
}

function ack(dispatchId: string, duplicate = false): TaskAssignmentAck {
	return { type: 'task-assignment-ack', dispatchId, duplicate };
}

describe('dispatch result correlation registry', () => {
	it('resolves the awaiting dispatcher with the delivered result', async () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(true);
		await expect(awaiting.result).resolves.toMatchObject({
			status: 'succeeded',
			dispatchId: DISPATCH_A,
		});
	});

	it('drops a result for a dispatch not awaited here', () => {
		expect(deliverDispatchResult(result('unknown-dispatch'))).toBe(false);
	});

	it('consuming the entry makes a duplicate result frame a no-op', async () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(true);
		await awaiting.result;
		// The second frame finds no waiter — the registration was consumed on delivery.
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(false);
		awaiting.dispose();
	});

	it('routes progress and ack frames to the registered handlers', () => {
		const onProgress = vi.fn();
		const onAck = vi.fn();
		const awaiting = awaitDispatchResult(DISPATCH_B, TARGET_B, { onProgress, onAck });

		deliverDispatchProgress(progress(DISPATCH_B));
		deliverDispatchAck(ack(DISPATCH_B, true));

		expect(onProgress).toHaveBeenCalledWith(
			expect.objectContaining({ state: 'branch-provisioned' }),
		);
		expect(onAck).toHaveBeenCalledWith(expect.objectContaining({ duplicate: true }));
		awaiting.dispose();
	});

	it('progress/ack for an unknown dispatch are no-ops (never throw)', () => {
		expect(() => deliverDispatchProgress(progress('nobody'))).not.toThrow();
		expect(() => deliverDispatchAck(ack('nobody'))).not.toThrow();
	});

	it('dispose unregisters the wait so a later result is dropped', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);
		awaiting.dispose();
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(false);
	});

	it('a re-registration for the same dispatch unblocks the superseded waiter', async () => {
		const first = awaitDispatchResult(DISPATCH_A, { ...TARGET_A, phase: 'review', taskId: '724' });
		const second = awaitDispatchResult(DISPATCH_A, TARGET_A);
		// The earlier waiter must not hang forever — it settles as a benign deferral,
		// naming the phase and task its *own* registration recorded (issue #724) rather
		// than the placeholder that stood in before the entry carried them.
		await expect(first.result).resolves.toMatchObject({
			status: 'deferred',
			phase: 'review',
			taskId: '724',
		});
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(true);
		await expect(second.result).resolves.toMatchObject({ status: 'succeeded' });
		first.dispose();
		second.dispose();
	});
});

/**
 * Ending the wait for a claim the handshake just reaped (issue #719). Without it
 * the durable rows are settled while the awaiting job keeps the project slot for the
 * rest of the lease window — and then settles the same run a second time.
 */
describe('failDispatchResultWait', () => {
	const REASON = "The worker's session was superseded by a newer one";

	it('resolves the waiter with a terminal failure carrying the reap’s reason', async () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);

		expect(failDispatchResultWait(DISPATCH_A, REASON)).toBe(true);

		// `failed`, not `deferred`: the dispatcher maps this to a non-deferrable error, so
		// the shared settle writes the same terminal run row the reap wrote rather than
		// flipping it back to `deferred` with a retry date (the #269 orphan shape).
		await expect(awaiting.result).resolves.toEqual({
			type: 'task-execution-result',
			dispatchId: DISPATCH_A,
			status: 'failed',
			// The phase and task the registration recorded (issue #724), not placeholders.
			phase: 'implementation',
			taskId: '407',
			error: REASON,
			reason: REASON,
		});

		awaiting.dispose();
	});

	it('consumes the registration, so a late real result and the run index find nothing', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);

		expect(failDispatchResultWait(DISPATCH_A, REASON)).toBe(true);

		// A frame the superseded daemon somehow still delivers is dropped, exactly as a
		// duplicate result is — the settle is already under way on the reap's reason.
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(false);
		expect(resolveDispatchTargetForRun('run-a')).toBeUndefined();
		expect(resolveDispatchStreamTarget(DISPATCH_A)).toBeUndefined();

		awaiting.dispose();
	});

	it('leaves every other dispatch’s wait registered and deliverable', async () => {
		const onA = awaitDispatchResult(DISPATCH_A, TARGET_A);
		const onB = awaitDispatchResult(DISPATCH_B, TARGET_B);

		expect(failDispatchResultWait(DISPATCH_A, REASON)).toBe(true);

		expect(deliverDispatchResult(result(DISPATCH_B))).toBe(true);
		await expect(onB.result).resolves.toMatchObject({ status: 'succeeded' });

		onA.dispose();
		onB.dispose();
	});

	it('marks the frame cancelled only when asked to (issue #827)', async () => {
		const onA = awaitDispatchResult(DISPATCH_A, TARGET_A);
		const onB = awaitDispatchResult(DISPATCH_B, TARGET_B);

		// The router's own undeliverable user termination: `cancelled: true` is what
		// makes the settle a `RunTerminatedError` rather than a plain terminal failure.
		expect(failDispatchResultWait(DISPATCH_A, REASON, { cancelled: true })).toBe(true);
		await expect(onA.result).resolves.toMatchObject({ status: 'failed', cancelled: true });

		// The superseded-session caller passes no options, and its frame must carry no
		// `cancelled` key at all — a cancelled settle is a different outcome entirely.
		expect(failDispatchResultWait(DISPATCH_B, REASON)).toBe(true);
		expect(await onB.result).not.toHaveProperty('cancelled');

		onA.dispose();
		onB.dispose();
	});

	it('answers false for a dispatch nobody here is awaiting, without throwing', () => {
		// The ordinary reading when this router restarted since the push: the durable
		// dispatch row is then the whole story.
		expect(failDispatchResultWait('unknown-dispatch', REASON)).toBe(false);

		const disposed = awaitDispatchResult(DISPATCH_A, TARGET_A);
		disposed.dispose();
		expect(failDispatchResultWait(DISPATCH_A, REASON)).toBe(false);
	});
});

/**
 * The lookup that authorizes a durable `stream-log` write (issue #544 review, F1):
 * it must answer with what the control plane recorded when it pushed the dispatch,
 * and nothing at all for a dispatch this router is not awaiting.
 */
describe('resolveDispatchStreamTarget', () => {
	it('returns the worker and run recorded at registration', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);

		expect(resolveDispatchStreamTarget(DISPATCH_A)).toEqual({ workerId: WORKER_A, runId: 'run-a' });

		awaiting.dispose();
	});

	it('returns nothing once the wait is disposed, and for an unknown dispatch', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);
		awaiting.dispose();

		expect(resolveDispatchStreamTarget(DISPATCH_A)).toBeUndefined();
		expect(resolveDispatchStreamTarget(DISPATCH_B)).toBeUndefined();
	});
});

/**
 * The reverse index a run cancellation resolves through (issue #549): a
 * cancellation names a run, the transport addresses a worker + dispatch. It must
 * answer only for a dispatch this router is still awaiting, so a settled or
 * never-dispatched run falls back to the durable marker instead of pushing a
 * cancel at whoever happens to hold the id now.
 */
describe('resolveDispatchTargetForRun', () => {
	it('resolves a run to the dispatch pushed for it, the worker, and the phase it named', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);

		// Phase/task come from the registration (issue #724) — a `task-cancel` states
		// them so the worker can answer one it cannot apply with a terminal result.
		expect(resolveDispatchTargetForRun('run-a')).toEqual({
			dispatchId: DISPATCH_A,
			workerId: WORKER_A,
			phase: 'implementation',
			taskId: '407',
		});

		awaiting.dispose();
	});

	it('returns nothing for an unknown run, a disposed wait, or a delivered result', () => {
		expect(resolveDispatchTargetForRun('run-a')).toBeUndefined();

		const disposed = awaitDispatchResult(DISPATCH_A, TARGET_A);
		disposed.dispose();
		expect(resolveDispatchTargetForRun('run-a')).toBeUndefined();

		const settled = awaitDispatchResult(DISPATCH_B, TARGET_B);
		expect(deliverDispatchResult(result(DISPATCH_B))).toBe(true);
		expect(resolveDispatchTargetForRun('run-b')).toBeUndefined();
		settled.dispose();
	});

	it('a re-push keeps the run pointed at the live registration', () => {
		const first = awaitDispatchResult(DISPATCH_A, TARGET_A);
		const second = awaitDispatchResult(DISPATCH_A, { ...TARGET_A, workerId: WORKER_B });
		// The superseded waiter's own cleanup must not unregister the newer push.
		first.dispose();

		expect(resolveDispatchTargetForRun('run-a')).toEqual({
			dispatchId: DISPATCH_A,
			workerId: WORKER_B,
			phase: 'implementation',
			taskId: '407',
		});

		second.dispose();
		expect(resolveDispatchTargetForRun('run-a')).toBeUndefined();
	});

	it('indexes nothing for a dispatch that opened no run row', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, { ...TARGET_A, runId: undefined });

		expect(resolveDispatchStreamTarget(DISPATCH_A)).toEqual({ workerId: WORKER_A });
		expect(resolveDispatchTargetForRun(DISPATCH_A)).toBeUndefined();

		awaiting.dispose();
	});
});

/**
 * Transport interruption bookkeeping (issue #723). This registry is the only place
 * that knows which dispatches are awaited on a given worker, so it is where a
 * dropped `/worker/stream` gets recorded — and, because it holds no database
 * dependency and must keep none, it *returns* the affected dispatches rather than
 * annotating their runs itself.
 */
describe('transport interruption bookkeeping', () => {
	it('marks only the dropped worker’s dispatches, and returns them with their runs', () => {
		const onA = awaitDispatchResult(DISPATCH_A, TARGET_A);
		const onB = awaitDispatchResult(DISPATCH_B, TARGET_B);

		expect(noteWorkerTransportLost(WORKER_A)).toEqual([{ dispatchId: DISPATCH_A, runId: 'run-a' }]);

		expect(onA.interruptions()).toMatchObject({ count: 1 });
		expect(onA.interruptions().lastAt).toBeInstanceOf(Date);
		// The other worker's dispatch is untouched — one machine dropping says nothing
		// about another.
		expect(onB.interruptions()).toEqual({ count: 0, lastAt: undefined });

		onA.dispose();
		onB.dispose();
	});

	it('accumulates over repeated drops — a reconnect does not undo one', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);

		noteWorkerTransportLost(WORKER_A);
		expect(noteWorkerTransportRestored(WORKER_A)).toEqual([
			{ dispatchId: DISPATCH_A, runId: 'run-a' },
		]);
		noteWorkerTransportLost(WORKER_A);

		expect(awaiting.interruptions().count).toBe(2);

		awaiting.dispose();
	});

	it('restores nothing for a worker whose transport never dropped', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);

		// An ordinary first connection must annotate no run.
		expect(noteWorkerTransportRestored(WORKER_A)).toEqual([]);

		awaiting.dispose();
	});

	it('reports a restoration only once per drop — a superseding socket with no new drop restores nothing', () => {
		// Review #4929792793 F1: a live socket superseded by another (a reconnect
		// racing its predecessor's close, or a second daemon connection) calls
		// `handleWorkerStreamOpen` again with no transport loss in between. That must
		// not re-emit the restoration note for a dispatch already reported restored.
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);

		noteWorkerTransportLost(WORKER_A);
		expect(noteWorkerTransportRestored(WORKER_A)).toEqual([
			{ dispatchId: DISPATCH_A, runId: 'run-a' },
		]);
		// A second socket open for the same worker, with no intervening drop.
		expect(noteWorkerTransportRestored(WORKER_A)).toEqual([]);

		// A fresh drop makes the dispatch reportable again.
		noteWorkerTransportLost(WORKER_A);
		expect(noteWorkerTransportRestored(WORKER_A)).toEqual([
			{ dispatchId: DISPATCH_A, runId: 'run-a' },
		]);

		awaiting.dispose();
	});

	it('reports nothing for a worker this router is awaiting no dispatch on', () => {
		expect(noteWorkerTransportLost(WORKER_A)).toEqual([]);
		expect(noteWorkerTransportRestored(WORKER_A)).toEqual([]);
	});

	// The bookkeeping lives on the entry, so it dies with the entry — there is no
	// separate cleanup to forget on a dispatch that reports normally.
	it('drops the bookkeeping with the entry on delivery, supersede and dispose', async () => {
		const delivered = awaitDispatchResult(DISPATCH_A, TARGET_A);
		noteWorkerTransportLost(WORKER_A);
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(true);
		await delivered.result;
		expect(noteWorkerTransportLost(WORKER_A)).toEqual([]);
		delivered.dispose();

		const superseded = awaitDispatchResult(DISPATCH_A, TARGET_A);
		noteWorkerTransportLost(WORKER_A);
		const replacement = awaitDispatchResult(DISPATCH_A, TARGET_A);
		await superseded.result;
		// The re-push starts clean: the newer registration never saw that drop, while
		// the superseded waiter keeps reporting what its own dispatch saw.
		expect(replacement.interruptions().count).toBe(0);
		expect(superseded.interruptions().count).toBe(1);

		replacement.dispose();
		expect(noteWorkerTransportLost(WORKER_A)).toEqual([]);
	});

	it('reports a dispatch with no run row, so the count still reaches the failure', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, { ...TARGET_A, runId: undefined });

		expect(noteWorkerTransportLost(WORKER_A)).toEqual([
			{ dispatchId: DISPATCH_A, runId: undefined },
		]);
		expect(awaiting.interruptions().count).toBe(1);

		awaiting.dispose();
	});
});

/**
 * Issue #827 (review #5058049296 F1). The unfiltered view the interruption
 * bookkeeping above narrows: a worker whose socket comes back has to be told about a
 * termination recorded while it was down, and whether *this* router ever saw the
 * transport drop is beside the point — the marker is durable, and the terminate may
 * have been requested against a router that had already given up on the socket.
 */
describe('listAwaitedDispatchesForWorker', () => {
	it('lists that worker’s dispatches with their runs, and no other worker’s', () => {
		const onA = awaitDispatchResult(DISPATCH_A, TARGET_A);
		const onB = awaitDispatchResult(DISPATCH_B, TARGET_B);

		expect(listAwaitedDispatchesForWorker(WORKER_A)).toEqual([
			{ dispatchId: DISPATCH_A, runId: 'run-a' },
		]);
		expect(listAwaitedDispatchesForWorker(WORKER_B)).toEqual([
			{ dispatchId: DISPATCH_B, runId: 'run-b' },
		]);

		onA.dispose();
		onB.dispose();
	});

	// Unlike `noteWorkerTransportRestored`, an undropped transport is not a reason to
	// skip a dispatch: the push that missed may never have involved a drop this router
	// observed at all.
	it('lists a dispatch whose transport this router never saw drop', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);

		expect(listAwaitedDispatchesForWorker(WORKER_A)).toEqual([
			{ dispatchId: DISPATCH_A, runId: 'run-a' },
		]);
		// And it keeps listing it, however many times a socket opens — the marker read
		// is what decides whether anything is pushed, not this list.
		expect(listAwaitedDispatchesForWorker(WORKER_A)).toHaveLength(1);

		awaiting.dispose();
	});

	it('lists nothing once the dispatch is no longer awaited here', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);
		awaiting.dispose();

		expect(listAwaitedDispatchesForWorker(WORKER_A)).toEqual([]);
	});
});
