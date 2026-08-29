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
 * abandoned dispatch. The one loss that *is* answered here rather than by that
 * timeout is a worker session **superseded** by a newer generation (issue #719):
 * the handshake settles the old generation's durable claims, and the wait behind
 * each one has to end with them (`failDispatchResultWait`) — otherwise the rows are
 * settled while the capacity they occupy stays held for the rest of the window.
 * The second such loss (issue #827) ends through the same seam: a user termination
 * the router could not push to a worker that has since gone silent, which the same
 * function settles as a *cancellation* rather than a plain failure — on that
 * module's own liveness heuristic and its own re-check (`./dispatch-cancellation.ts`),
 * not on anything decided here. What *is* its concern since issue #723 is the transport
 * interruption itself: being the one place that knows who is awaiting a given
 * worker, it records a dropped `/worker/stream` against those dispatches, so an
 * undelivered result can be attributed to the drop rather than to a silent worker.
 *
 * The `Map` is module-private; callers touch it only through the exported
 * functions.
 */

import { logger } from '../lib/logger.js';
import type {
	TaskAssignmentAck,
	TaskExecutionResult,
	TaskPhase,
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

/**
 * Everything this router recorded about a dispatch when it registered the result
 * wait: the {@link DispatchStreamTarget} a durable write is authorized against,
 * plus the phase and task the pushed assignment named.
 *
 * Those last two are here because a `task-cancel` has to carry them (issue #724):
 * a worker that answers a cancel it cannot apply answers with a terminal result
 * frame, and `TaskExecutionResultSchema` requires both. Recorded rather than
 * re-derived — the dispatcher holds them on the trigger it composed the assignment
 * from, and nothing else on this router still has them by the time a cancellation
 * arrives.
 */
export interface DispatchRegistration extends DispatchStreamTarget {
	/** The pipeline phase the pushed assignment names. */
	phase: TaskPhase;
	/** The SCM-derived task id the pushed assignment names. */
	taskId: string;
}

interface PendingDispatch extends DispatchResultHandlers, DispatchRegistration {
	resolve: (result: TaskExecutionResult) => void;
	/** How many times this worker's transport dropped while this dispatch was awaited here. */
	interruptions: number;
	/** When the most recent of those drops was observed. */
	lastInterruptedAt?: Date;
	/**
	 * The `interruptions` count as of the last drop this dispatch was reported
	 * restored for. A worker connects once per socket, and a live socket can be
	 * superseded by another (a reconnect racing its predecessor's close, or a
	 * daemon opening a second socket) without the transport ever having dropped in
	 * between — `handleWorkerStreamOpen` runs for that new socket too, so
	 * `noteWorkerTransportRestored` would otherwise report the same drop restored a
	 * second time. Comparing against `interruptions` instead of a boolean survives
	 * a drop landing while the "already restored" state is still current.
	 */
	restoredThroughInterruptions: number;
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

/**
 * What this router observed happening to the worker's transport while it was
 * awaiting one dispatch (issue #723). A count rather than a flag because the
 * interesting reading is "how flaky was this session", and because a *drop* is
 * what an undelivered result has to be attributed to — the reconnect does not
 * undo it, so nothing here is ever decremented.
 */
export interface TransportInterruptions {
	/** How many `/worker/stream` closes this router saw while awaiting the dispatch. */
	count: number;
	/** When the most recent one was observed; unset when there was none. */
	lastAt?: Date;
}

/** A registered result wait — the promise to await, plus the cleanup that unregisters it. */
export interface AwaitingDispatchResult {
	/** Resolves with the worker's terminal `TaskExecutionResult` for this dispatch. */
	result: Promise<TaskExecutionResult>;
	/**
	 * What happened to the worker's transport while this dispatch was awaited — read
	 * through a closure over the registration rather than by exposing the map, so a
	 * result-wait timeout can name the interruption instead of blaming the worker
	 * for never reporting (`./dispatcher.ts`).
	 */
	interruptions: () => TransportInterruptions;
	/** Remove the registration — always call it (in a `finally`) so a timed-out wait leaks nothing. */
	dispose: () => void;
}

/** One dispatch a transport interruption applies to, and the run whose output stream annotates it. */
export interface InterruptedDispatch {
	dispatchId: string;
	runId?: string;
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
	target: DispatchRegistration,
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
			// The superseded waiter only needs to unblock, but it reports the phase/task
			// its *own* registration named rather than a placeholder (issue #724).
			phase: existing.phase,
			taskId: existing.taskId,
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
		phase: target.phase,
		taskId: target.taskId,
		onProgress: handlers.onProgress,
		onAck: handlers.onAck,
		interruptions: 0,
		restoredThroughInterruptions: 0,
	};
	pending.set(dispatchId, entry);
	if (target.runId !== undefined) byRun.set(target.runId, dispatchId);
	return {
		result,
		// Closed over *this* registration, so a superseded waiter keeps reporting the
		// interruptions its own dispatch saw rather than the newer push's.
		interruptions: () => ({ count: entry.interruptions, lastAt: entry.lastInterruptedAt }),
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

/**
 * End the wait for a dispatch whose durable claim was just settled out from under
 * it — a worker session superseded by a newer generation (issue #719). Returns
 * whether a waiter was found; `false` means no dispatcher here is awaiting it
 * (already settled, or pushed by a router process that has since restarted), and
 * the durable dispatch row is then the whole story.
 *
 * Without this the awaiting job stays parked until `timeoutMs +
 * RESULT_WAIT_MARGIN_MS` (`./dispatcher.ts`) holding the project slot and a BullMQ
 * concurrency slot — the settle would reach the rows and none of the capacity — and
 * it would then settle the same run *again*, as a deferral, over the terminal state
 * the reap wrote.
 *
 * `status: 'failed'` rather than `'deferred'` on purpose: `adaptResultToPhaseRun`
 * maps it to a non-deferrable `AgentRunError`, so the shared settle path writes the
 * same terminal run row the reap just wrote, with the same reason. A `deferred`
 * frame would instead flip that row back to `deferred` with a retry date — via
 * `completeRun`'s unconditional update — while `scheduleDispatchRetry` no-ops on the
 * already-terminal dispatch: the exact #269 orphan shape.
 *
 * The frame reports the phase and task the *registration* named (issue #724), so a
 * synthetic terminal result is indistinguishable in shape from a real one.
 *
 * `cancelled: true` is the *other* reason a wait ends early (issue #827): a user
 * termination this router could not deliver to a worker that then stayed silent
 * past its heartbeat and reconnect windows, so nothing was going to report this
 * dispatch. That frame
 * routes to a `RunTerminatedError` rather than the non-deferrable `AgentRunError`
 * the superseded case maps to, which is what makes the run settle as the user's
 * termination — same columns, same origin — instead of as a plain failure.
 */
export function failDispatchResultWait(
	dispatchId: string,
	reason: string,
	options: { cancelled?: boolean } = {},
): boolean {
	const entry = pending.get(dispatchId);
	// Answered here rather than by `deliverDispatchResult`'s miss branch: a dispatch
	// nobody is awaiting is the ordinary reading on this path, not the anomaly that
	// warn line reports.
	if (!entry) return false;
	return deliverDispatchResult({
		type: 'task-execution-result',
		dispatchId,
		status: 'failed',
		phase: entry.phase,
		taskId: entry.taskId,
		error: reason,
		reason,
		// Spread rather than `cancelled: options.cancelled`: the superseded-session
		// caller's frame must stay exactly the shape it is today, with no key at all.
		...(options.cancelled ? { cancelled: true } : {}),
	});
}

/**
 * Record that `workerId`'s transport dropped against every dispatch this router is
 * awaiting on it, and return those dispatches so the caller can annotate their runs
 * (issue #723). The router knows the moment a socket closes; without this the
 * knowledge died with the socket and a delivered-but-discarded outcome later read as
 * a worker that never reported.
 *
 * Returning the entries rather than writing anything is deliberate: this module has
 * no database dependency and must keep none — the socket handler is what owns the
 * fire-and-forget note (`./stream-log-persistence.ts`).
 */
export function noteWorkerTransportLost(workerId: string): InterruptedDispatch[] {
	const at = new Date();
	const interrupted: InterruptedDispatch[] = [];
	for (const [dispatchId, entry] of pending) {
		if (entry.workerId !== workerId) continue;
		entry.interruptions += 1;
		entry.lastInterruptedAt = at;
		interrupted.push({ dispatchId, runId: entry.runId });
	}
	return interrupted;
}

/**
 * The dispatches `workerId`'s reconnect restores output for: the ones still awaited
 * here whose transport this router already saw drop and has not yet reported
 * restored. `interruptions` itself is never decremented — the count is history, and
 * it is what a later result-wait timeout is attributed to — but
 * `restoredThroughInterruptions` is advanced to it here, so a socket open that
 * follows no new drop (a live session superseded by another socket, e.g. a
 * reconnect racing its predecessor's close) reports nothing the second time. A
 * worker whose transport never dropped while a dispatch was awaited also yields
 * nothing, so an ordinary first connection annotates no run.
 */
export function noteWorkerTransportRestored(workerId: string): InterruptedDispatch[] {
	const restored: InterruptedDispatch[] = [];
	for (const [dispatchId, entry] of pending) {
		if (entry.workerId !== workerId || entry.interruptions === entry.restoredThroughInterruptions) {
			continue;
		}
		entry.restoredThroughInterruptions = entry.interruptions;
		restored.push({ dispatchId, runId: entry.runId });
	}
	return restored;
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

/**
 * Where a dispatch is executing: the worker it was pushed to and the dispatch id
 * itself, plus the phase and task that assignment named — everything a pushed
 * `task-cancel` frame has to state (issue #724).
 */
export interface RunDispatchTarget {
	dispatchId: string;
	workerId: string;
	/** The pipeline phase that dispatch is executing. */
	phase: TaskPhase;
	/** The SCM-derived task id that dispatch is executing. */
	taskId: string;
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
	return { dispatchId, workerId: entry.workerId, phase: entry.phase, taskId: entry.taskId };
}
