/**
 * **Where a continuation's state actually lives** (issue #567).
 *
 * A preserved checkout is machine-local. A Tier 2 checkpoint file
 * (`docs/CHECKPOINTS.md`), a resumable agent session, and a deterministic-delivery
 * sidecar all sit in `.swarm-workspaces/task-<id>` on the one worker that stopped —
 * none of them has a server-side trace the scheduler could route by. So a
 * continuation dispatched to a *different* eligible worker finds nothing to adopt,
 * provisions a fresh checkout, and runs the phase from scratch at full token cost,
 * with nothing in the run record saying the earlier attempt was discarded.
 *
 * This module holds the one predicate that says whether a dispatch is such a
 * continuation. It is deliberately payload-only and side-effect-free — the gate
 * (`src/worker/eligibility-gate.ts`) narrows candidates to the recorded machine, and
 * `runs.recovery.preservedWorkerId` says which machine that is.
 */

import type { SwarmJob } from '../queue/jobs.js';

/**
 * Whether this dispatch means to continue work left in a preserved checkout, and
 * must therefore run on the machine holding it.
 *
 * The four payload shapes that adopt a checkout, all of which the recovery gate
 * (`src/pipeline/resume.ts`) resolves against the on-disk `task-<id>` directory:
 *
 * - `recoveryMode: 'resume'` — an operator-driven resume of the captured session.
 * - `recoveryMode: 'checkpoint'` — the Tier 2 continuation (issue #503).
 * - `resumeSession` — the *automatic* retry's equivalent of `'resume'`, set by
 *   `deriveRetryJobPayload` on a resumable deferral. Included deliberately: the
 *   rate-limit deferral that motivated this issue re-dispatches through exactly
 *   this flag, so pinning only the operator-driven modes would leave the observed
 *   failure in place.
 * - `resumeDelivery` — reuses the worktree's delivery progress sidecar, which needs
 *   no agent session at all.
 *
 * `recoveryMode: 'fresh'` is the explicit opposite — "start over, reclaiming the
 * checkout" — and is never pinned, so it stays the escape hatch it is. It is checked
 * first so it wins over a stale `resumeSession` a payload might still carry.
 */
export function jobContinuesPreservedCheckout(job: SwarmJob): boolean {
	if (job.recoveryMode === 'fresh') return false;
	return (
		job.recoveryMode === 'resume' ||
		job.recoveryMode === 'checkpoint' ||
		job.resumeSession === true ||
		job.resumeDelivery === true
	);
}

/**
 * Whether a run records **no** machine for its preserved checkout although its last
 * attempt did bind one (issue #954) — the run-row half of the eligibility gate's
 * `preserved-worker-unknown` verdict.
 *
 * A run whose `worker_id` is `NULL` never bound a machine, so nothing could have been
 * recorded and nothing was lost: it is not "unknown", which is the carve-out that keeps
 * an unfederated project's continuations running. `worker_id` is never a substitute
 * pin — it is the *last bind's* worker, so an already mis-routed continuation would name
 * the wrong machine.
 *
 * Shared by the worker's pin read and "Retry now" (issue #1101), so the API restarts or
 * refuses on exactly the rows the gate would refuse.
 */
export function preservedCheckoutMachineUnknown(
	run:
		| { workerId: string | null; recovery: { preservedWorkerId?: string | null } | null }
		| undefined,
): boolean {
	return !run?.recovery?.preservedWorkerId && run?.workerId != null;
}
