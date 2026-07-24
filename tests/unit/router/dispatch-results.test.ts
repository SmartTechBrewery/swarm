import { describe, expect, it, vi } from 'vitest';
import {
	awaitDispatchResult,
	deliverDispatchAck,
	deliverDispatchProgress,
	deliverDispatchResult,
} from '@/router/dispatch-results.js';
import type { TaskAssignmentAck, TaskExecutionResult, TaskProgress } from '@/transport/protocol.js';

const DISPATCH_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DISPATCH_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
		const awaiting = awaitDispatchResult(DISPATCH_A);
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
		const awaiting = awaitDispatchResult(DISPATCH_A);
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(true);
		await awaiting.result;
		// The second frame finds no waiter — the registration was consumed on delivery.
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(false);
		awaiting.dispose();
	});

	it('routes progress and ack frames to the registered handlers', () => {
		const onProgress = vi.fn();
		const onAck = vi.fn();
		const awaiting = awaitDispatchResult(DISPATCH_B, { onProgress, onAck });

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
		const awaiting = awaitDispatchResult(DISPATCH_A);
		awaiting.dispose();
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(false);
	});

	it('a re-registration for the same dispatch unblocks the superseded waiter', async () => {
		const first = awaitDispatchResult(DISPATCH_A);
		const second = awaitDispatchResult(DISPATCH_A);
		// The earlier waiter must not hang forever — it settles as a benign deferral.
		await expect(first.result).resolves.toMatchObject({ status: 'deferred' });
		expect(deliverDispatchResult(result(DISPATCH_A))).toBe(true);
		await expect(second.result).resolves.toMatchObject({ status: 'succeeded' });
		first.dispose();
		second.dispose();
	});
});
