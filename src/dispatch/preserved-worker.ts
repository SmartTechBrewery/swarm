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
 * The five payload shapes that depend on machine-local state. The first four adopt a
 * checkout, and the recovery gate (`src/pipeline/resume.ts`) resolves them against the
 * on-disk `task-<id>` directory:
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
 * - `implementationBranchProvisioned` — Implementation reuses the task branch an
 *   earlier attempt provisioned (`createBranch: false`) instead of cutting it (issue
 *   #1197). Until the attempt pushes, that branch exists only in the repository of
 *   the machine that created it, so any other worker fails on `invalid reference`.
 *
 * `recoveryMode: 'fresh'` is the explicit opposite — "start over, reclaiming the
 * checkout" — and is never pinned on its own, so it stays the escape hatch it is. It
 * is checked after the branch premise, because `'fresh'` reclaims only the checkout:
 * the phase still provisions against the existing branch, which is just as
 * machine-local. It is checked before the other three, so it wins over a stale
 * `resumeSession` a payload might still carry. "Reset & restart" strips the branch
 * premise along with the rest of the recovery intent (issue #741), so it is still the
 * way to start over anywhere.
 */
export function jobContinuesPreservedCheckout(job: SwarmJob): boolean {
	if (job.implementationBranchProvisioned === true) return true;
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

/** Which preserved state a continuation adopts (issue #1138) — see {@link preservedContinuationKind}. */
export type PreservedContinuationKind = 'checkpoint' | 'session' | 'delivery' | 'branch';

/**
 * Which kind of continuation this dispatch is, or `undefined` when it is not one
 * (issue #1138). {@link jobContinuesPreservedCheckout} stays the single authority on
 * *whether* a job continues a preserved checkout; this only names *which* preserved
 * state it adopts, so a deferral that cannot re-derive its recovery intent (a lost
 * worker transport reports nothing about the attempt) can carry it instead and keep
 * the run row describing the same continuation.
 */
export function preservedContinuationKind(job: SwarmJob): PreservedContinuationKind | undefined {
	if (!jobContinuesPreservedCheckout(job)) return undefined;
	// `'fresh'` adopts nothing but the provisioned branch (issue #1197).
	if (job.recoveryMode === 'fresh') return 'branch';
	if (job.recoveryMode === 'checkpoint') return 'checkpoint';
	if (job.recoveryMode === 'resume' || job.resumeSession === true) return 'session';
	if (job.resumeDelivery === true) return 'delivery';
	return 'branch';
}

/**
 * How long a pinned continuation waits for its preserved machine when that machine
 * **lost its transport under this run** (issue #1141), before handing the run to the
 * operator. #567's wait for a machine that is merely busy has no bound, because that
 * machine will come back; one that dropped off mid-run may not, and an unbounded wait
 * for it leaves the work invisible to everybody. A day is long enough to outlast a
 * reboot, a network outage or a laptop closed overnight. Deliberately a constant, not
 * a setting.
 */
export const LOST_TRANSPORT_PRESERVED_WAIT_MS = 24 * 60 * 60 * 1000;

/**
 * When the bounded wait for a pinned machine that lost its transport ends (issue
 * #1141), or `undefined` when this dispatch's wait for its pin is #567's unbounded one.
 *
 * Bounded only while **both** halves hold: the payload records the loss this dispatch
 * re-attempts ({@link SwarmJob.preservedWorkerLostTransportAt}, which an attempt that
 * ran past the gate never passes on), and the run lists the pinned machine among those
 * whose transport was lost under it. The window is measured from that loss, so a wait
 * re-checked across many deferrals still ends at the same instant. Shared by the
 * worker's gate and the run-detail read (`runs.getById`), so the callout states the
 * same ending the worker enforces.
 */
export function lostTransportPreservedWaitEndsAt(
	job: Pick<SwarmJob, 'preservedWorkerLostTransportAt'>,
	run:
		| {
				recovery: {
					preservedWorkerId?: string | null;
					transportLostWorkerIds?: string[] | null;
				} | null;
		  }
		| undefined,
): Date | undefined {
	const workerId = run?.recovery?.preservedWorkerId;
	if (!workerId || !run?.recovery?.transportLostWorkerIds?.includes(workerId)) return undefined;
	const lostAt = job.preservedWorkerLostTransportAt
		? Date.parse(job.preservedWorkerLostTransportAt)
		: Number.NaN;
	if (Number.isNaN(lostAt)) return undefined;
	return new Date(lostAt + LOST_TRANSPORT_PRESERVED_WAIT_MS);
}
