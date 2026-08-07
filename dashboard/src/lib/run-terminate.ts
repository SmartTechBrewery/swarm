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

/**
 * Button label. `requestOutstanding` — the run-scoped fact that a termination
 * request has been accepted and hasn't taken effect (issue #561) — wins over the
 * mutation's own `isPending`, because it outlives it: the HTTP call answers in
 * milliseconds while the wait for the worker to notice and unwind can run to the
 * run's agent timeout. Naming the *wait* rather than the action is what stops the
 * button reading as one that did nothing.
 */
export function terminateButtonLabel(isPending: boolean, requestOutstanding = false): string {
	if (requestOutstanding) return 'Waiting to stop…';
	return isPending ? 'Terminating…' : 'Terminate';
}

/**
 * What the operator is waiting for once a termination request is accepted
 * (issue #561) — the explanation the disabled button carries, so a slow
 * cancellation reads as "waiting" rather than "broken".
 *
 * `hasDeadline` swaps the closing sentence for the one that fits: a bound the
 * operator can see, or — for a run recording no agent timeout — the CLI escape
 * for a request that may never be delivered, since a `running` run offers no
 * Reset button in the dashboard. The timestamp itself is formatted by the
 * component (like the deferred/checkpointed callouts already do), so this copy
 * stays locale-independent.
 */
export function describeTerminateWait(hasDeadline: boolean): string {
	const base =
		'The termination request was recorded. It takes effect once the run’s worker sees it and aborts the agent — this page updates as soon as the run settles.';
	return hasDeadline
		? `${base} The run’s agent timeout is the outer bound on that wait.`
		: `${base} This run records no agent timeout, so nothing bounds the wait: if it never settles, force it from the CLI with "swarm run reset <runId> --force".`;
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
