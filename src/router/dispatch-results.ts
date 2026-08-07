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

/**
 * Who the control plane actually pushed a dispatch to, and which run row it opened
 * for it. Recorded at registration so a back-channel write can be authorized
 * against what *this router* did, rather than against what an inbound frame claims
 * about itself — the same "identity comes from the server side, never the request
 * body" rule `./worker-delivery.ts` follows for the HTTP delivery API.
 */
export interface DispatchStreamTarget {
	/** The worker the assignment was pushed to. */
	workerId: string;
	/** The run row this dispatch's attempt opened, when it has one. */
	runId?: string;
}

interface PendingDispatch extends DispatchResultHandlers, DispatchStreamTarget {
	resolve: (result: TaskExecutionResult) => void;
}

/** dispatchId → the dispatcher awaiting that dispatch's terminal result on this router. */
const pending = new Map<string, PendingDispatch>();

/**
 * runId → dispatchId, the reverse index over the same registrations. It answers
 * the one question the pushing side cannot: a run cancellation names a *run*
 * (`../queue/cancellation.ts` keys on the immutable run id), while the transport
 * addresses a *worker* and a *dispatch* — so cancelling a run executing on a
 * connected worker means resolving one to the other (`./dispatch-cancellation.ts`,
 * issue #549). Maintained strictly alongside `pending`, so a dispatch this router
 * is no longer awaiting is not resolvable here either.
 */
const byRun = new Map<string, string>();

/** Drop `runId`'s index entry, but only while it still points at `dispatchId`. */
function unindexRun(dispatchId: string, runId: string | undefined): void {
	if (runId !== undefined && byRun.get(runId) === dispatchId) byRun.delete(runId);
}

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
	target: DispatchStreamTarget,
	handlers: DispatchResultHandlers = {},
): AwaitingDispatchResult {
	const existing = pending.get(dispatchId);
	if (existing) {
		logger.warn('dispatch back-channel: superseding an earlier result wait for the same dispatch', {
			dispatchId,
		});
		unindexRun(dispatchId, existing.runId);
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
	const entry: PendingDispatch = {
		resolve,
		workerId: target.workerId,
		runId: target.runId,
		onProgress: handlers.onProgress,
		onAck: handlers.onAck,
	};
	pending.set(dispatchId, entry);
	if (target.runId !== undefined) byRun.set(target.runId, dispatchId);
	return {
		result,
		dispose: () => {
			// Identity-checked, like `./worker-connections.ts`'s deregister: a superseded
			// waiter's own `dispose` must not unregister the newer registration that
			// replaced it, nor take its run index down with it.
			if (pending.get(dispatchId) !== entry) return;
			pending.delete(dispatchId);
			unindexRun(dispatchId, target.runId);
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
		// `warn`, not `debug`: a dropped terminal result means the run it belongs to is
		// no longer being settled by anyone, so it waits out `RESULT_WAIT_MARGIN_MS` and
		// lands as a timeout however well the phase actually went. The benign readings
		// (already settled, or awaited on another router) are worth the line too — a
		// second router settling SWARM's dispatches is itself something to know about.
		logger.warn('dispatch back-channel: result for a dispatch not awaited here — dropping', {
			dispatchId: result.dispatchId,
			status: result.status,
		});
		return false;
	}
	pending.delete(result.dispatchId);
	unindexRun(result.dispatchId, entry.runId);
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

/**
 * The worker and run the control plane recorded for a dispatch it is awaiting
 * here, or `undefined` when no dispatcher on this router is awaiting it.
 *
 * This is the authorization seam for the one back-channel frame that performs a
 * **durable write** — `stream-log`, whose rows land in `run_output_events`
 * (`./stream-log-persistence.ts`). Every other frame on the socket is either
 * lease-scoped or resolves against a waiter that discards it, so trusting the
 * frame's own ids costs nothing; a write does not have that property. The caller
 * compares `workerId` against the socket's authenticated worker and persists under
 * the `runId` recorded here, so the frame's own `runId` is advisory.
 */
export function resolveDispatchStreamTarget(dispatchId: string): DispatchStreamTarget | undefined {
	const entry = pending.get(dispatchId);
	if (!entry) return undefined;
	return { workerId: entry.workerId, runId: entry.runId };
}

/** Where a dispatch is executing: the worker it was pushed to and the dispatch id itself. */
export interface RunDispatchTarget {
	dispatchId: string;
	workerId: string;
}

/**
 * The dispatch this router pushed for `runId` and the worker it went to, or
 * `undefined` when no dispatch for that run is awaited here — it already settled,
 * was never dispatched from this router, or is queued/deferred rather than
 * executing (issue #549). A miss is an ordinary answer, not an error: the durable
 * cancellation marker still governs a run that is not executing on a connected
 * worker.
 */
export function resolveDispatchTargetForRun(runId: string): RunDispatchTarget | undefined {
	const dispatchId = byRun.get(runId);
	if (dispatchId === undefined) return undefined;
	const entry = pending.get(dispatchId);
	if (!entry) return undefined;
	return { dispatchId, workerId: entry.workerId };
}
