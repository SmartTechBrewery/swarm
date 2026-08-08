/**
 * In-process registry of the {@link AbortController} backing each dispatch in
 * flight in *this* process, keyed by run id (issue #166), plus the
 * {@link RunTerminatedError} a worker-reported cancellation settles through.
 *
 * The registry serves the control plane's `processJob`: a cancellation the
 * operator recorded *before* the dispatch reached execution is caught by
 * {@link beginRunCancellationTracking}'s start-check against the durable Redis
 * set, which aborts the controller before an assignment is pushed. Delivering a
 * cancellation to a run already executing is the transport's job, not this map's
 * — `../router/dispatch-cancellation.ts` pushes a `task-cancel` frame to the
 * worker running it (issue #549), which is the only channel a worker with no
 * `REDIS_URL` has. The worker keeps its own copy of this registry for the
 * assignment it is executing (`../transport/assignment-execution.ts`).
 */

import { logger } from '../lib/logger.js';
import { isRunCancellationRequested } from '../queue/cancellation.js';

/**
 * Thrown to settle a phase as a terminal, user-initiated cancellation (issue
 * #166) reported by a worker rather than read from the durable marker. The
 * in-process path detects a cancellation by re-reading the durable set in
 * `handlePhaseFailure`; the control-plane transport path (issue #407) settles from
 * a worker's `TaskExecutionResult` instead, and it is the *worker* that observed
 * the cancellation — since issue #549 it learns of one from a pushed `task-cancel`
 * frame, which is the only channel a worker with no `REDIS_URL` has. So the worker
 * reports it on the frame (`cancelled: true`) and the control plane raises this to
 * route it through the same terminal-cancelled branch (never a deferral, which
 * would re-run the very phase the user killed), independent of what a marker read
 * on the settling side would find.
 */
export class RunTerminatedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RunTerminatedError';
	}
}

const runControllers = new Map<string, AbortController>();

/** Register a run's abort controller so a cancellation for it can reach it. */
export function registerRunController(runId: string, controller: AbortController): void {
	runControllers.set(runId, controller);
}

/** Drop a run's controller once the run settles (called from `processJob`'s finally). */
export function unregisterRunController(runId: string): void {
	runControllers.delete(runId);
}

/**
 * Link a run's abort controller to the process's own shutdown signal, so that
 * shutdown propagates to the run. Returns the controller and a detach
 * callback to clean up the listener once the run settles.
 */
export function linkRunAbortController(signal?: AbortSignal): {
	controller: AbortController;
	detach: () => void;
} {
	const controller = new AbortController();
	if (!signal) {
		return { controller, detach: () => {} };
	}
	const onShutdown = () => controller.abort();
	signal.addEventListener('abort', onShutdown);
	return {
		controller,
		detach: () => signal.removeEventListener('abort', onShutdown),
	};
}

/**
 * Register a run's abort controller and immediately abort if a user cancellation
 * was already requested (e.g. while the run was deferred).
 */
export async function beginRunCancellationTracking(
	runId: string | undefined,
	controller: AbortController,
): Promise<void> {
	if (!runId) return;
	registerRunController(runId, controller);
	if (await isRunCancellationRequested(runId)) {
		logger.info('Run cancellation requested before start, aborting immediately', { runId });
		controller.abort();
	}
}
