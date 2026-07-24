/**
 * In-process registry of the {@link AbortController} backing each run currently
 * executing in *this* worker, keyed by run id (issue #166). It's the bridge
 * between the cross-process cancellation notification (`src/queue/cancellation.ts`,
 * delivered on the worker's Redis subscriber) and the per-run abort signal
 * threaded into `runPhase`: when a cancellation for a run id arrives, the worker
 * looks the run up here and aborts its controller, which kills the in-flight
 * agent CLI via its existing `AbortSignal` path (SIGTERM→SIGKILL) and lets the
 * phase run its normal worktree/lease cleanup.
 *
 * Single-worker MVP, so an in-memory map suffices; the durable Redis set remains
 * the source of truth for *whether* a run was cancelled (a cancellation that
 * arrives with no controller registered — the worker isn't running that run yet,
 * or already finished it — is a no-op here and is instead caught by the worker's
 * start-check against that set). A multi-worker deployment would route the
 * notification to the owning worker rather than broadcasting.
 */

import { logger } from '../lib/logger.js';
import { isRunCancellationRequested } from '../queue/cancellation.js';

/**
 * Thrown to settle a phase as a terminal, user-initiated cancellation (issue
 * #166) when the durable cancellation marker cannot be consulted at settle time.
 * The in-process path detects a cancellation by re-reading the durable set in
 * `handlePhaseFailure`, but the control-plane transport path (issue #407) settles
 * from a worker's `TaskExecutionResult` *after* the worker already cleared that
 * marker in its own cleanup — so the worker reports the cancellation on the frame
 * (`cancelled: true`) and the control plane raises this to route it through the
 * same terminal-cancelled branch (never a deferral, which would re-run the very
 * phase the user killed).
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
 * Abort the in-flight run with this id, if it's running here. Returns whether a
 * controller was found and aborted — `false` means the run isn't executing in
 * this worker right now (already settled, or not yet picked up), in which case
 * the durable set entry (checked at run start) covers it.
 */
export function abortRun(runId: string): boolean {
	const controller = runControllers.get(runId);
	if (!controller) return false;
	controller.abort();
	return true;
}

/**
 * Link a run's abort controller to the worker's own shutdown signal, so that
 * worker shutdown propagates to the run. Returns the controller and a detach
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
