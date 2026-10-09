/**
 * The registry of failure types SWARM retries **automatically** after a delay of
 * their own (issue #1075).
 *
 * Kept apart from the long-standing deferrable kinds (`rate-limit`, `capacity`,
 * `aborted`, `timeout`, `stalled`, `commit-unavailable` — `isDeferrable` in
 * `./consumer.ts`) on purpose. Those are transient by nature and share one retry
 * budget and one delay rule. The kinds listed here used to be **terminal**: the run
 * failed and only an operator's Retry brought it back. Each is admitted into the
 * deferral machinery deliberately, with its own delay, its own bound and its own
 * wait reason, so that adding one is a reviewed decision recorded here rather than a
 * new branch in the consumer.
 *
 * A failure kind not in the registry behaves exactly as it did before. One past its
 * budget falls through to the same terminal path it always took, so it stays failed
 * for the operator.
 *
 * Adding a type takes four edits: a new `AgentFailureKind`, an entry here, a
 * `DispatchWaitReason` member (and its mirrors in `../queue/queued-runs.ts` and the
 * dashboard), and that wait reason's Queue label.
 */

import type { DispatchWaitReason } from '../db/repositories/dispatchesRepository.js';
import type { AgentFailureKind } from '../harness/agent-failure.js';

/** How one retryable failure type is retried. */
export interface AutomaticRetryPolicy {
	/** How long after the failure the retry is due. */
	delayMs: number;
	/**
	 * How many automatic retries one run gets for this failure type, counted on the
	 * job's own `automaticRetryAttempt` rather than the rate-limit budget, so earlier
	 * deferrals of another kind cannot spend it. A manual Retry now or Reset starts a
	 * fresh budget.
	 */
	maxAttempts: number;
	/** The dispatch row's wait reason while the retry is pending. */
	waitReason: DispatchWaitReason;
	/** The failure, as the deferral log line names it. */
	label: string;
}

/** Every failure type retried automatically, with its policy. */
export const AUTOMATIC_RETRY_POLICIES: Partial<Record<AgentFailureKind, AutomaticRetryPolicy>> = {
	/**
	 * The worker's transport was lost and did not return within the grace (issue
	 * #859). Thirty minutes gives a machine that only dropped off the network time to
	 * come back, and the retry prefers a different eligible worker anyway
	 * (`runs.recovery.transportLostWorkerIds`). Two retries: a run whose worker keeps
	 * vanishing needs a human to look at the fleet.
	 */
	'transport-lost': {
		delayMs: 30 * 60 * 1000,
		maxAttempts: 2,
		waitReason: 'transport-lost',
		label: "worker's connection lost",
	},
};

/** The automatic-retry policy for `kind`, or `undefined` when it is not retried automatically. */
export function automaticRetryPolicyFor(
	kind: AgentFailureKind | 'delivery' | undefined,
): AutomaticRetryPolicy | undefined {
	if (kind === undefined || kind === 'delivery') return undefined;
	return AUTOMATIC_RETRY_POLICIES[kind];
}
