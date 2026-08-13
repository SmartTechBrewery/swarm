import { describe, expect, it, vi } from 'vitest';
import {
	awaitDispatchResult,
	deliverDispatchAck,
	deliverDispatchProgress,
	deliverDispatchResult,
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
const TARGET_A = { workerId: WORKER_A, runId: 'run-a' };
const TARGET_B = { workerId: WORKER_B, runId: 'run-b' };

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
		const first = awaitDispatchResult(DISPATCH_A, TARGET_A);
		const second = awaitDispatchResult(DISPATCH_A, TARGET_A);
		// The earlier waiter must not hang forever — it settles as a benign deferral.
		await expect(first.result).resolves.toMatchObject({ status: 'deferred' });
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(true);
		await expect(second.result).resolves.toMatchObject({ status: 'succeeded' });
		first.dispose();
		second.dispose();
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

		expect(resolveDispatchStreamTarget(DISPATCH_A)).toEqual(TARGET_A);

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
	it('resolves a run to the dispatch pushed for it and the worker it went to', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, TARGET_A);

		expect(resolveDispatchTargetForRun('run-a')).toEqual({
			dispatchId: DISPATCH_A,
			workerId: WORKER_A,
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
		const first = awaitDispatchResult(DISPATCH_A, { workerId: WORKER_A, runId: 'run-a' });
		const second = awaitDispatchResult(DISPATCH_A, { workerId: WORKER_B, runId: 'run-a' });
		// The superseded waiter's own cleanup must not unregister the newer push.
		first.dispose();

		expect(resolveDispatchTargetForRun('run-a')).toEqual({
			dispatchId: DISPATCH_A,
			workerId: WORKER_B,
		});

		second.dispose();
		expect(resolveDispatchTargetForRun('run-a')).toBeUndefined();
	});

	it('indexes nothing for a dispatch that opened no run row', () => {
		const awaiting = awaitDispatchResult(DISPATCH_A, { workerId: WORKER_A });

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
		const awaiting = awaitDispatchResult(DISPATCH_A, { workerId: WORKER_A });

		expect(noteWorkerTransportLost(WORKER_A)).toEqual([
			{ dispatchId: DISPATCH_A, runId: undefined },
		]);
		expect(awaiting.interruptions().count).toBe(1);

		awaiting.dispose();
	});
});
