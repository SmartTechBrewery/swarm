/**
 * Pure view-logic for the "Reset & restart" action (issue #428), split out of
 * the run-detail route so it can be unit-tested without a rendered component
 * (the dashboard package tests helpers only by default — no jsdom; see
 * `dashboard/vitest.config.ts`). The route wires these into the `runs.reset`
 * mutation and its confirmation modal.
 */

/** What happened to the run's active dispatch — mirrors `ResetRunResult['dispatch']`. */
export type ResetDispatchOutcome = 'none' | 'cancelled' | 'cancelled-claimed';

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

/** The steps every reset reports, whatever it ends in — mirrors `ResetRunSteps`. */
interface ResetRunSteps {
	runId: string;
	dispatch: ResetDispatchOutcome;
	cancellationCleared: boolean;
	/** `null` when no local teardown was attempted (the run's project is gone). */
	worktree: ResetWorktreeReport | null;
	/** Why this host's teardown failed, if it did — it no longer stops the reset. */
	worktreeError?: string | null;
	recoveryCleared: boolean;
	/**
	 * The machine whose preserved checkout this reset gave up (issue #567), or null
	 * when the run was pinned to none. Reset is the only action that ends a pinned
	 * wait, so the report says which machine's work was discarded.
	 */
	abandonedPreservedWorkerId?: string | null;
}

/**
 * The per-step report `runs.reset` returns — mirrors `ResetRunResult`. Two
 * endings since issue #744: the ordinary restart, and the terminal settlement a
 * run that cannot be re-dispatched at all gets instead of a refusal.
 */
export type ResetRunReport =
	| (ResetRunSteps & { outcome: 'restarted'; dispatchId: string })
	| (ResetRunSteps & { outcome: 'terminated'; reason: string });

/**
 * Whether a run can be reset. Reset is the last resort for a *wedged* run, and
 * since issue #744 the server refuses none of them: a `failed` run (including one
 * whose recovery is `blocked`), either retry-pending status — `deferred`, or
 * `checkpointed` (issue #503) — and a `running` row, which no longer has to be
 * terminated first. Only `completed` is excluded, because a finished run has
 * nothing to restart. This mirrors the server rather than deciding anything, so
 * the button never offers an action the router would reject nor withholds one it
 * would accept.
 */
export function canResetRun(status: string): boolean {
	return (
		status === 'failed' ||
		status === 'deferred' ||
		status === 'checkpointed' ||
		status === 'running'
	);
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
	return 'The restart was accepted and queued as a fresh dispatch. It takes effect when a worker claims it and the run turns Running — this page updates as soon as it does. If no worker ever picks it up, re-issue it from the CLI with "swarm run reset <runId>", which discards the checkout and restarts the phase exactly as this button does.';
}

/**
 * The confirmation-modal copy. It names every step the mutation performs, since
 * this is the one action that throws away state no other button touches. It no
 * longer offers a choice (issue #744) — a reset always discards — so it *states*
 * the two consequences an operator has to weigh before confirming: the checkout
 * goes with any uncommitted changes and unpushed commits, wherever it lives, and a
 * dispatch a worker claimed a moment ago is cancelled without stopping the agent
 * that dispatch may already have spawned.
 *
 * A `checkpointed` run gets the extra sentence its state earns (issue #503): reset
 * is the only action that discards the recorded checkpoint and returns the spent
 * continuation budget, so restarting one deliberately gives up the remainder
 * "Continue now" would have picked up.
 *
 * A run pinned to a machine gets one more (issue #567), and it is the important one:
 * this is the action that abandons that machine's preserved work, and it is offered
 * — and works — whether or not the machine is reachable, so the copy has to say what
 * is being given up rather than let "restarts this phase" imply a free retry.
 */
export function resetConfirmMessage(status: string, preservedMachine?: string | null): string {
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
	const pinned = preservedMachine
		? ` The work preserved on ${preservedMachine} is abandoned: this run stops waiting for that machine and restarts on any available worker, and that earlier attempt's progress is lost. This works whether or not ${preservedMachine} is currently reachable.`
		: '';
	const work =
		'Uncommitted changes and unpushed commits in the checkout are discarded permanently, on whichever worker holds it — they cannot be recovered. A dispatch a worker has just claimed is cancelled too, and that does not stop an agent process it already spawned.';
	return `${sequence}${pinned} ${work}`;
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

/**
 * One line describing what the reset did to the run's checkout and lease **on the
 * control-plane host** — the only filesystem the server-side teardown can see.
 *
 * `absent` is the case that had to stop reading as an answer (issue #592): on a
 * federated deployment the checkout usually lives on another worker, where "none on
 * disk — nothing to remove" was actively misleading about the very collision the
 * operator was resetting to clear. It now says who settles it instead, and
 * {@link describeResetResult} follows it with the intent that restart carries.
 */
function describeWorktreeOutcome(worktree: ResetWorktreeReport): string {
	switch (worktree.outcome) {
		case 'absent':
			return 'Checkout: none on this host — one held by another worker is settled by that worker when it provisions the restart.';
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
			// Since issue #744 a reset discards, so a retained checkout is one this host's
			// settlement could not free — not one the operator declined to free.
			return `Checkout: retained — ${describeWorktreeReason(worktree.blockedReason)}. The worker holding it discards it when it provisions the restart.`;
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
		case 'cancelled-claimed':
			lines.push(
				'Dispatch: a dispatch a worker had already claimed was cancelled — an agent process it already spawned is not stopped by a reset.',
			);
			break;
	}

	if (result.cancellationCleared) {
		lines.push('Cancellation flag: cleared, so the fresh attempt is not killed at startup.');
	}

	if (result.worktree) {
		lines.push(describeWorktreeOutcome(result.worktree));
	}
	// A teardown throw no longer stops the reset (issue #744), so it is reported: this
	// host's checkout still wants a look, while the restart's own discard intent
	// settles the one that was actually in the way.
	if (result.worktreeError) {
		lines.push(
			`Checkout: this host's teardown failed — ${result.worktreeError}. The reset continued.`,
		);
	}
	// The half of the checkout answer the server-side settlement cannot give (issue
	// #592), because the checkout may be on a worker the control plane cannot reach.
	// Every replacement dispatch carries the discard intent — but a reset that did not
	// restart has no dispatch to carry it.
	if (result.outcome === 'restarted') {
		lines.push(
			'Restart intent: the worker holding the checkout discards it — dirty and unpushed work included — before provisioning.',
		);
	}

	if (result.recoveryCleared) {
		lines.push('Recovery record: cleared.');
	}

	// The one line that reports work *lost*, so it says so plainly rather than
	// hiding behind "recovery record cleared" (issue #567).
	if (result.abandonedPreservedWorkerId) {
		lines.push(
			`Preserved work: discarded — this run is no longer pinned to the machine that held its checkout, and that attempt's progress is not carried over.`,
		);
	}

	lines.push(
		result.outcome === 'terminated'
			? `Not restarted: ${result.reason}`
			: `Restarted: re-dispatched from scratch as dispatch ${result.dispatchId}.`,
	);

	return lines;
}
