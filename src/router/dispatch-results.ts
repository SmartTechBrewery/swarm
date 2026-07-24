/**
 * In-process correlation registry for the control plane's split-delivery
 * back-channel (issue #407, ADR-003 §2). When the router dispatches a phase over
 * the worker transport it pushes a `TaskAssignment` and then waits for the
 * selected worker to report the terminal `TaskExecutionResult` (and, meanwhile,
 * `TaskProgress`/`TaskAssignmentAck`) back over its `/worker/stream` socket. The
 * socket handler (`./worker-transport.ts`) has no idea which BullMQ dispatch job
 * is awaiting a given frame; this registry is the bridge, keyed by `dispatchId`,
 * exactly as `../worker/run-cancellation.ts` bridges a cross-process cancellation
 * to the in-flight run's abort controller.
 *
 * Single-process assumption: the MVP router runs as one process and a worker is
 * connected to exactly one router, so an in-process map is a complete view of who
 * is awaiting what *here*. A worker that never reports (a crash or drop) is not
 * this registry's concern — the dispatcher imposes its own await timeout and the
 * durable dispatch lease reconciler (`../dispatch/reconciler.ts`) reclaims the
 * abandoned dispatch.
 *
 * The `Map` is module-private; callers touch it only through the exported
 * functions.
 */

import { logger } from '../lib/logger.js';
import type {
	TaskAssignmentAck,
	TaskExecutionResult,
	TaskProgress,
} from '../transport/protocol.js';

/** Non-terminal frame handlers a waiting dispatcher may register alongside its result wait. */
export interface DispatchResultHandlers {
	/** Coarse progress (`running` / `branch-provisioned`) for the in-flight assignment. */
	onProgress?: (progress: TaskProgress) => void;
	/** The worker's ack that it accepted the assignment (or is already running it — `duplicate`). */
	onAck?: (ack: TaskAssignmentAck) => void;
}

interface PendingDispatch extends DispatchResultHandlers {
	resolve: (result: TaskExecutionResult) => void;
}

/** dispatchId → the dispatcher awaiting that dispatch's terminal result on this router. */
const pending = new Map<string, PendingDispatch>();

/** A registered result wait — the promise to await, plus the cleanup that unregisters it. */
export interface AwaitingDispatchResult {
	/** Resolves with the worker's terminal `TaskExecutionResult` for this dispatch. */
	result: Promise<TaskExecutionResult>;
	/** Remove the registration — always call it (in a `finally`) so a timed-out wait leaks nothing. */
	dispose: () => void;
}

/**
 * Register interest in a dispatch's back-channel frames before the assignment is
 * pushed, so a fast worker's ack/progress/result can never race ahead of the
 * registration. A second registration for the same `dispatchId` (a re-push of an
 * unsettled dispatch) supersedes the first: the earlier waiter is resolved with a
 * synthetic `deferred` result so its `await` unblocks rather than hanging forever.
 */
export function awaitDispatchResult(
	dispatchId: string,
	handlers: DispatchResultHandlers = {},
): AwaitingDispatchResult {
	const existing = pending.get(dispatchId);
	if (existing) {
		logger.warn('dispatch back-channel: superseding an earlier result wait for the same dispatch', {
			dispatchId,
		});
		existing.resolve({
			type: 'task-execution-result',
			dispatchId,
			status: 'deferred',
			// Phase/task are unknown here; the superseded waiter only needs to unblock.
			phase: 'implementation',
			taskId: dispatchId,
			reason: 'superseded by a newer dispatch of the same record',
			failureKind: 'aborted',
			retryDelayMs: 0,
		});
	}
	let resolve!: (result: TaskExecutionResult) => void;
	const result = new Promise<TaskExecutionResult>((res) => {
		resolve = res;
	});
	pending.set(dispatchId, { resolve, onProgress: handlers.onProgress, onAck: handlers.onAck });
	return {
		result,
		dispose: () => {
			pending.delete(dispatchId);
		},
	};
}

/**
 * Deliver a worker's terminal result to whoever is awaiting that dispatch here.
 * Returns whether a waiter was found — `false` means no dispatcher on this router
 * is awaiting it (already settled, timed out, or delivered to another router), in
 * which case the frame is dropped and the durable dispatch state is authoritative.
 * Consuming the entry (deleting it) makes a duplicate result frame a no-op.
 */
export function deliverDispatchResult(result: TaskExecutionResult): boolean {
	const entry = pending.get(result.dispatchId);
	if (!entry) {
		logger.debug('dispatch back-channel: result for a dispatch not awaited here — dropping', {
			dispatchId: result.dispatchId,
			status: result.status,
		});
		return false;
	}
	pending.delete(result.dispatchId);
	entry.resolve(result);
	return true;
}

/** Route a progress frame to the awaiting dispatcher, if any (a no-op otherwise). */
export function deliverDispatchProgress(progress: TaskProgress): void {
	pending.get(progress.dispatchId)?.onProgress?.(progress);
}

/** Route an assignment ack to the awaiting dispatcher, if any (a no-op otherwise). */
export function deliverDispatchAck(ack: TaskAssignmentAck): void {
	pending.get(ack.dispatchId)?.onAck?.(ack);
}
