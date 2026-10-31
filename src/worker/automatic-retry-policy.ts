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
 *
 * Beside the per-kind registry sits one policy keyed by what a terminal failure
 * leaves behind rather than by its kind: {@link PRESERVED_WORK_RETRY_POLICY}
 * (issue #1257), the last chance a run holding preserved work gets before it goes to
 * the operator.
 */

import type { ProjectConfig } from '../config/schema.js';
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
	 * (`runs.recovery.transportLostWorkerIds`) — unless the run's work is preserved on
	 * that machine, in which case the retry carries the continuation and stays pinned
	 * to it (issue #1138). Two retries: a run whose worker keeps vanishing needs a
	 * human to look at the fleet.
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

/**
 * The one automatic retry of a run that failed **terminally while holding preserved
 * work** (issue #1257) — a Tier 2 checkpoint, a resumable delivery, a resumable
 * session or a provisioned Implementation branch.
 *
 * Not keyed by a failure kind, because what qualifies a run is the work it leaves
 * behind rather than how it stopped: a transient stop whose own budget ran out (most
 * often a spent checkpoint continuation budget) or a control plane that answered a
 * delivery with a server error. Such a run used to wait for an operator, which at
 * night left every ticket blocked on it standing still until morning. One retry after
 * a cool-down continues the preserved work on the machine holding it, exactly as Retry
 * now would; a second terminal failure goes to the operator, saying it was already
 * retried. Its own counter (`SwarmJob.preservedWorkRetryAttempt`), so a lost transport
 * earlier in the run cannot spend it.
 *
 * `delayMs` is the default: a project may change it, or turn the retry off, under
 * `pipeline.preservedWorkRetry` ({@link preservedWorkRetryPolicyFor}).
 */
export const PRESERVED_WORK_RETRY_POLICY: AutomaticRetryPolicy = {
	delayMs: 45 * 60 * 1000,
	maxAttempts: 1,
	waitReason: 'preserved-work-retry',
	label: 'failed holding preserved work',
};

/**
 * The preserved-work retry policy for `project`, with its own delay applied, or
 * `undefined` when the project turned the retry off.
 */
export function preservedWorkRetryPolicyFor(
	project: Pick<ProjectConfig, 'pipeline'>,
): AutomaticRetryPolicy | undefined {
	const config = project.pipeline?.preservedWorkRetry;
	if (config?.enabled === false) return undefined;
	return config?.delayMinutes === undefined
		? PRESERVED_WORK_RETRY_POLICY
		: { ...PRESERVED_WORK_RETRY_POLICY, delayMs: config.delayMinutes * 60 * 1000 };
}
