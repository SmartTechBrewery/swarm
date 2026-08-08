/**
 * Pure view-logic for the deferred-run "Retry now" action (issue #136), split
 * out of the run-detail route so it can be unit-tested without a rendered
 * component (the dashboard package tests helpers only — no jsdom; see
 * `dashboard/vitest.config.ts`). The route wires these into the tRPC mutation.
 */

/**
 * Whether a run can be retried now. Only a `deferred` run has a pending BullMQ
 * retry job to promote (`runs.retryNow`); a `running` run is already going, and
 * a `completed` run has nothing pending to fire. A `checkpointed` run (issue
 * #503) is the other retry-pending state — its waiting dispatch carries the
 * checkpoint continuation — so the same action fires it early. Mirrors the
 * router's `deferred`/`checkpointed`/`failed` guard so the button never offers an
 * action the server rejects.
 */
export function canRetryRun(status: string): boolean {
	return status === 'deferred' || status === 'failed' || status === 'checkpointed';
}

/**
 * The four shapes the primary retry action takes (issues #227, #368, #503):
 * - `resume`   — continue the captured CLI session a deferred/preserved run kept.
 * - `continue` — run the Tier 2 checkpoint continuation now: a *fresh* session
 *                seeded from the recorded remainder, over the preserved checkout.
 * - `recheck`  — re-verify a blocked run's protected worktree condition, then
 *                retry from scratch once the operator has resolved it.
 * - `retry`    — start a fresh agent session from scratch.
 */
export type RetryActionKind = 'resume' | 'continue' | 'recheck' | 'retry';

/**
 * Which primary action the run offers. A `deferred` run that still holds a
 * captured `agentSessionId` is one whose pending retry will *continue* that
 * session (the exact condition the router pins the worktree for —
 * `hasResumableDeferredRun`: `status IN ('deferred', 'failed', 'checkpointed') AND
 * (agent_session_id IS NOT NULL OR status = 'checkpointed')`), so it's a "resume"; a terminally `failed` run whose worktree was
 * `preserved` for its captured session is likewise a "resume".
 *
 * A `checkpointed` run is a "continue" and deliberately *not* a "resume": it
 * carries no session id by construction, and the server unconditionally sends it
 * through `recoveryMode: 'checkpoint'` — adopting the preserved checkout on the
 * strength of its checkpoint and running a brand-new session seeded from the
 * recorded remainder. Checked before the session test so the two can never be
 * confused by a row that somehow holds both.
 *
 * A `failed` run whose worktree stayed `blocked` (dirty/unpushed/live-leased/
 * missing-validation/resumable-owner/checkpoint-divergent, issues #368, #502) offers a "recheck": the retry payload is
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
	// `state` is optional since issue #567: a run can carry a recovery record that
	// only records where its preserved checkout is, with no recovery state at all.
	recovery?: { state?: 'preserved' | 'recovered' | 'blocked' } | null,
): RetryActionKind {
	if (status === 'checkpointed') return 'continue';
	if (status === 'deferred' && agentSessionId !== null) return 'resume';
	if (status === 'failed' && recovery?.state === 'preserved') return 'resume';
	if (status === 'failed' && recovery?.state === 'blocked') return 'recheck';
	return 'retry';
}

/**
 * Button label for the primary action. A resume reads "Resume"/"Resuming…"; a
 * checkpoint continuation reads "Continue now"/"Continuing…"; a blocked run's
 * recheck reads "Recheck and retry"/"Rechecking…"; a fresh retry keeps the
 * original "Retry now"/"Retrying…". The in-flight variant is shown while the
 * mutation is pending.
 */
export function retryButtonLabel(kind: RetryActionKind, isPending: boolean): string {
	if (kind === 'resume') return isPending ? 'Resuming…' : 'Resume';
	if (kind === 'continue') return isPending ? 'Continuing…' : 'Continue now';
	if (kind === 'recheck') return isPending ? 'Rechecking…' : 'Recheck and retry';
	return isPending ? 'Retrying…' : 'Retry now';
}
