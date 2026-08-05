/**
 * Pure view-logic for the "Terminate" action (issue #166), split out of the
 * run-detail route so it can be unit-tested without a rendered component (the
 * dashboard package tests helpers only — no jsdom; see `dashboard/vitest.config.ts`). The route
 * wires these into the tRPC mutation and confirmation modal.
 */

/**
 * Whether a run can be terminated. Only an in-flight run has something to stop: a
 * `running` run has a live agent to abort, and either retry-pending status —
 * `deferred`, or `checkpointed` (issue #503) — has a waiting dispatch to cancel.
 * A `completed`/`failed` run is already terminal — nothing to do — mirroring the
 * router's guard (`isRetryPendingStatus`, which is what makes the server settle a
 * checkpointed row down the same branch as a deferred one) so the button never
 * offers an action the server would no-op.
 */
export function canTerminateRun(status: string): boolean {
	return status === 'running' || status === 'deferred' || status === 'checkpointed';
}

/** Confirm-button label: reads "Terminating…" while the mutation is pending. */
export function terminateButtonLabel(isPending: boolean): string {
	return isPending ? 'Terminating…' : 'Terminate';
}

/**
 * The confirmation-modal copy, tailored to the run's state so the user knows
 * exactly what stops: a `running` run kills its agent, a `deferred` run cancels
 * its scheduled retry, and a `checkpointed` run gives up the checkpoint
 * continuation its preserved checkout was being kept for (issue #503) — the one
 * case where terminating abandons recorded, unfinished work rather than a plain
 * retry. All three finalize the run as failed with a user-termination reason and
 * can't be undone.
 */
export function terminateConfirmMessage(status: string): string {
	if (status === 'checkpointed') {
		return "This cancels the scheduled continuation and marks the run failed, abandoning the work its checkpoint still lists as remaining. This can't be undone.";
	}
	if (status === 'deferred') {
		return "This cancels the run's scheduled retry and marks it failed. This can't be undone.";
	}
	return "This stops the running agent immediately and marks the run failed. This can't be undone.";
}
