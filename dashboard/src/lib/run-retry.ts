/**
 * Pure view-logic for the deferred-run "Retry now" action (issue #136), split
 * out of the run-detail route so it can be unit-tested without a rendered
 * component (the dashboard package tests helpers only — no jsdom; see
 * `dashboard/vitest.config.ts`). The route wires these into the tRPC mutation.
 */

/**
 * Whether a run can be retried now. Only a `deferred` run has a pending BullMQ
 * retry job to promote (`runs.retryNow`); a `running` run is already going, and
 * a `completed`/`failed` run has nothing pending to fire. Mirrors the router's
 * `deferred`-only guard so the button never offers an action the server rejects.
 */
export function canRetryRun(status: string): boolean {
	return status === 'deferred' || status === 'failed';
}

/**
 * The three shapes the primary retry action takes (issues #227, #368):
 * - `resume`  — continue the captured CLI session a deferred/preserved run kept.
 * - `recheck` — re-verify a blocked run's protected worktree condition, then
 *               retry from scratch once the operator has resolved it.
 * - `retry`   — start a fresh agent session from scratch.
 */
export type RetryActionKind = 'resume' | 'recheck' | 'retry';

/**
 * Which primary action the run offers. A `deferred` run that still holds a
 * captured `agentSessionId` is one whose pending retry will *continue* that
 * session (the exact condition the router pins the worktree for —
 * `hasResumableDeferredRun`: `status IN ('deferred', 'failed', 'checkpointed') AND
 * (agent_session_id IS NOT NULL OR status = 'checkpointed')`), so it's a "resume"; a terminally `failed` run whose worktree was
 * `preserved` for its captured session is likewise a "resume".
 *
 * A `failed` run whose worktree stayed `blocked` (dirty/unpushed/live-leased/
 * missing-validation/resumable-owner, issue #368) offers a "recheck": the retry payload is
 * identical to a fresh retry — the label only tells the operator that the
 * server's provisioning gate re-verifies the protected condition first and
 * either reclaims the checkout or keeps the refreshed run blocked, so all the
 * safety stays server-side. Every other retryable run relaunches from scratch,
 * so it's a plain "retry". Mirroring the server's own guard keeps a button from
 * ever promising an action the retry path won't perform.
 */
export function retryActionKind(
	status: string,
	agentSessionId: string | null,
	recovery?: { state: 'preserved' | 'recovered' | 'blocked' } | null,
): RetryActionKind {
	if (status === 'deferred' && agentSessionId !== null) return 'resume';
	if (status === 'failed' && recovery?.state === 'preserved') return 'resume';
	if (status === 'failed' && recovery?.state === 'blocked') return 'recheck';
	return 'retry';
}

/**
 * Button label for the primary action. A resume reads "Resume"/"Resuming…"; a
 * blocked run's recheck reads "Recheck and retry"/"Rechecking…"; a fresh retry
 * keeps the original "Retry now"/"Retrying…". The in-flight variant is shown
 * while the mutation is pending.
 */
export function retryButtonLabel(kind: RetryActionKind, isPending: boolean): string {
	if (kind === 'resume') return isPending ? 'Resuming…' : 'Resume';
	if (kind === 'recheck') return isPending ? 'Rechecking…' : 'Recheck and retry';
	return isPending ? 'Retrying…' : 'Retry now';
}
