/**
 * How long the `pr-review` trigger (`handlers/review.ts`) waits for a head to
 * reach a final state — the `state-pending` recheck budget — in one module, so
 * the handler that spends it and the `no-fix` recovery that sizes its claim TTL
 * to outlast it (`src/dispatch/ci-no-fix-recovery.ts`) derive it the same way
 * without that composition-root module importing the handler.
 *
 * The allowance was first sized for checks-API lag (~10 min, "well beyond any
 * real lag"). Past it a *webhook-driven* review is re-triggered anyway by the
 * fresh `checks` webhook every completing suite emits, so there the cap only
 * stops a pathological self-reschedule loop. That argument does **not** cover
 * the synthetic follow-up Review a `fixed` Respond-to-review enqueues
 * (`src/pipeline/follow-up-review.ts`, issue #241): SWARM enqueues that one
 * itself and no later webhook is guaranteed, so exhausting this budget there
 * does drop a legitimate review. Which is why a *failed read* never spends it
 * (issue #720), and why it is now per project (issue #1083): real CI runs
 * outlast the lag allowance — `under-control-platform`'s `Verify` reaches
 * ~13 minutes — so a project whose CI takes longer sets
 * `pipeline.review.checksWaitMinutes` instead of seeing spurious `failed`
 * Review runs and dropped follow-ups.
 */

import type { ProjectConfig } from '../config/schema.js';

/** How long to wait before re-querying check state when the answer is not final yet. */
export const RECHECK_DELAY_MS = 30_000;

/** Today's allowance, kept as the default: 20 rechecks at {@link RECHECK_DELAY_MS}. */
export const DEFAULT_CHECKS_WAIT_MINUTES = 10;

/** The project's effective wait for a head to reach a final state, in minutes. */
export function resolveChecksWaitMinutes(project: ProjectConfig): number {
	return project.pipeline?.review?.checksWaitMinutes ?? DEFAULT_CHECKS_WAIT_MINUTES;
}

/** The `state-pending` recheck cap that wait buys at {@link RECHECK_DELAY_MS}. */
export function stateRecheckCap(project: ProjectConfig): number {
	return Math.ceil((resolveChecksWaitMinutes(project) * 60_000) / RECHECK_DELAY_MS);
}
