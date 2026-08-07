/**
 * Pure view-logic for the "Reset & restart" action (issue #428), split out of
 * the run-detail route so it can be unit-tested without a rendered component
 * (the dashboard package tests helpers only by default — no jsdom; see
 * `dashboard/vitest.config.ts`). The route wires these into the `runs.reset`
 * mutation and its confirmation modal.
 */

/** What happened to the run's active dispatch — mirrors `ResetRunResult['dispatch']`. */
export type ResetDispatchOutcome = 'none' | 'cancelled' | 'force-cancelled-claimed';

/**
 * The checkout/lease settlement the mutation reports back, mirroring
 * `TerminationCleanupResult` (`src/worktree/termination-cleanup.ts`). Declared
 * structurally here rather than imported, the same way `dashboard/src/types/runs.ts`
 * mirrors the server's schemas — the dashboard doesn't pull in worker modules.
 * `blockedReason`/`discarded` stay `string` so a new server-side reason renders
 * (as its raw key) instead of failing to typecheck; the route passes the real
 * mutation result in, so a renamed *field* still breaks the build.
 */
export type ResetWorktreeReport =
	| { outcome: 'absent' }
	| { outcome: 'preserved'; agentSessionId: string }
	| { outcome: 'removed'; discarded?: string; staleLeaseReleased?: true }
	| { outcome: 'blocked'; blockedReason: string };

/** The per-step report `runs.reset` returns — mirrors `ResetRunResult`. */
export interface ResetRunReport {
	runId: string;
	forced: boolean;
	dispatch: ResetDispatchOutcome;
	cancellationCleared: boolean;
	worktree: ResetWorktreeReport;
	recoveryCleared: boolean;
	dispatchId: string;
}

/**
 * Whether a run can be reset. Reset is the last resort for a *wedged* run, so it
 * is offered exactly where the run is stuck but no longer live: a `failed` run
 * (including one whose recovery is `blocked`) and either retry-pending status —
 * `deferred`, or `checkpointed` (issue #503) — whose waiting dispatch can't get
 * it moving. A `running` run should be terminated first and a `completed` one has
 * nothing to restart — mirroring the server's own guard (`resetRun` refuses a
 * `running` run unless forced, and nothing else) so the button never offers an
 * action the router would reject, nor withholds one it would accept.
 */
export function canResetRun(status: string): boolean {
	return status === 'failed' || status === 'deferred' || status === 'checkpointed';
}

/**
 * Button label. `requestOutstanding` — the run-scoped fact that a restart has
 * been accepted and hasn't taken effect (issue #561) — wins over the mutation's
 * own `isPending`, which only ever covers the HTTP round-trip: `runs.reset`
 * returns as soon as the replacement dispatch exists, long before a worker
 * claims it and the row turns Running. Naming the *wait* is what stops the
 * button reading as one that did nothing.
 */
export function resetButtonLabel(isPending: boolean, requestOutstanding = false): string {
	if (requestOutstanding) return 'Waiting to restart…';
	return isPending ? 'Resetting…' : 'Reset & restart';
}

/**
 * What the operator is waiting for once a restart is accepted (issue #561) — the
 * explanation the disabled button carries, so a restart nothing has picked up yet
 * reads as "queued" rather than "broken".
 *
 * The CLI escape is named because a restart no worker ever claims leaves this
 * button disabled and (on a `failed` run) no Terminate button to re-issue from,
 * so the dashboard alone cannot clear it — better to say so than to leave a
 * dead-looking control.
 */
export function describeRestartWait(): string {
	return 'The restart was accepted and queued as a fresh dispatch. It takes effect when a worker claims it and the run turns Running — this page updates as soon as it does. If no worker ever picks it up, re-issue it from the CLI with "swarm run reset <runId>". Use "--force" only if you intend to discard dirty or unpushed work in the run’s checkout.';
}

/**
 * The confirmation-modal copy. It names every step the mutation performs, since
 * this is the one action that throws away state no other button touches, and
 * changes its second half with the `force` opt-in: without it a dirty/unpushed
 * checkout is retained rather than removed, with it that work is gone for good.
 *
 * A `checkpointed` run gets the extra sentence its state earns (issue #503): reset
 * is the only action that discards the recorded checkpoint and returns the spent
 * continuation budget, so restarting one deliberately gives up the remainder
 * "Continue now" would have picked up.
 */
export function resetConfirmMessage(status: string, discardWork: boolean): string {
	const scope =
		status === 'checkpointed'
			? "This cancels the run's scheduled continuation and its active dispatch"
			: status === 'deferred'
				? "This cancels the run's scheduled retry and its active dispatch"
				: "This cancels the run's active dispatch";
	const checkpoint =
		status === 'checkpointed'
			? ' Its checkpoint and spent continuation count are cleared too, so the remainder it recorded is not carried over.'
			: '';
	const sequence = `${scope}, removes its checkout and releases the worktree lease, clears its recovery record, and restarts this phase from scratch with a fresh agent session.${checkpoint}`;
	const work = discardWork
		? 'Uncommitted changes and unpushed commits in the checkout are discarded permanently — they cannot be recovered.'
		: 'Uncommitted changes and unpushed commits are kept: a checkout holding either is retained instead of removed.';
	return `${sequence} ${work}`;
}

/** Operator-facing wording for a protected-checkout reason (dirty/unpushed/leased). */
function describeWorktreeReason(reason: string): string {
	switch (reason) {
		case 'dirty':
			return 'uncommitted changes';
		case 'unpushed':
			return 'unpushed commits';
		case 'live-leased':
			return 'a lease held by another live run';
		default:
			return reason;
	}
}

/** One line describing what the reset did to the run's checkout and lease. */
function describeWorktreeOutcome(worktree: ResetWorktreeReport): string {
	switch (worktree.outcome) {
		case 'absent':
			return 'Checkout: none on disk — nothing to remove.';
		case 'preserved':
			return 'Checkout: kept for its saved agent session; the lease was released.';
		case 'removed': {
			if (worktree.discarded && worktree.staleLeaseReleased) {
				return `Checkout: removed — ${describeWorktreeReason(worktree.discarded)} discarded as requested; a stale worktree lease was released.`;
			}
			if (worktree.discarded) {
				return `Checkout: removed — ${describeWorktreeReason(worktree.discarded)} discarded as requested.`;
			}
			if (worktree.staleLeaseReleased) {
				return 'Checkout: removed; a stale worktree lease no live run owned was released.';
			}
			return 'Checkout: removed and its lease released.';
		}
		case 'blocked':
			return `Checkout: retained — ${describeWorktreeReason(worktree.blockedReason)}. The restarted run re-checks it before provisioning.`;
	}
}

/**
 * The success report, one line per step, in the order `resetRun` performs them.
 * Operators use this to tell a reset that actually freed the checkout from one
 * that restarted the run but left protected work behind.
 */
export function describeResetResult(result: ResetRunReport): string[] {
	const lines: string[] = [];

	switch (result.dispatch) {
		case 'none':
			lines.push('Dispatch: none was active.');
			break;
		case 'cancelled':
			lines.push('Dispatch: the active dispatch was cancelled.');
			break;
		case 'force-cancelled-claimed':
			lines.push(
				'Dispatch: a worker-claimed dispatch was force-cancelled — an agent process it already spawned is not stopped by a reset.',
			);
			break;
	}

	if (result.cancellationCleared) {
		lines.push('Cancellation flag: cleared, so the fresh attempt is not killed at startup.');
	}

	lines.push(describeWorktreeOutcome(result.worktree));

	if (result.recoveryCleared) {
		lines.push('Recovery record: cleared.');
	}

	lines.push(`Restarted: re-dispatched from scratch as dispatch ${result.dispatchId}.`);

	return lines;
}
