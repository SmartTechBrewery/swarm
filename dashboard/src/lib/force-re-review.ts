/**
 * Pure view-logic for the "Force re-review" action (issue #511), split out of
 * the run-detail route the same way `./run-reset.ts` is — so it can be
 * unit-tested without a rendered component, and so the action's copy lives
 * beside the recovery action whose interaction pattern it follows.
 *
 * The route wires these into the `runs.forceReReview` mutation and its
 * confirmation modal.
 */

/** The report `runs.forceReReview` returns — mirrors `ForceReReviewResult`. */
export interface ForceReReviewReport {
	runId: string;
	prNumber: string;
	headSha: string;
	capOverride: 'granted' | 'already-granted';
	dispatch: 'scheduled' | 'already-scheduled' | 'already-completed' | 'retried';
	dispatchId: string;
	dispatchState?: string;
	dispatchOutcome?: string | null;
	/** Set only when `dispatch === 'retried'`: why the prior attempt didn't count. */
	previousAttemptOutcome?: string | null;
}

/** The run fields the availability rule reads — the subset `RunRow` and the API row share. */
export interface ForceReReviewRunState {
	status: string;
	phase: string;
	reviewVerdict?: string | null;
	reviewAutomationOutcome?: string | null;
}

/** The project setting that can disable the forced corrective sequence. */
export interface ForceReReviewPipeline {
	respondToReview?: { enabled?: boolean };
}

/**
 * Whether a run can have its re-review forced: exactly the state the run-detail
 * view renders as "Manual action required" — a completed Review run whose
 * `request-changes` verdict was the last the review safety cap allows, so SWARM
 * deliberately enqueued no further Respond-to-review. Mirrors the server's own
 * guard (`forceReReview` refuses anything else) so the button never offers an
 * action the router would reject.
 */
export function canForceReReview(
	run: ForceReReviewRunState,
	pipeline?: ForceReReviewPipeline,
): boolean {
	return (
		run.status === 'completed' &&
		run.phase === 'review' &&
		run.reviewVerdict === 'request-changes' &&
		run.reviewAutomationOutcome === 'manual-intervention-required' &&
		pipeline?.respondToReview?.enabled !== false
	);
}

/** Confirm-button label: reads "Scheduling…" while the mutation is pending. */
export function forceReReviewButtonLabel(isPending: boolean): string {
	return isPending ? 'Scheduling…' : 'Force re-review';
}

/**
 * The confirmation-modal copy. Like "Reset & restart"'s, it names what the
 * mutation actually does — this is a deliberate override of a safety cap, so the
 * operator should see both halves (the response *and* the review it re-opens)
 * before confirming.
 */
export function forceReReviewConfirmMessage(prNumber?: string | null): string {
	const pr = prNumber ? `PR #${prNumber}` : 'this PR';
	return (
		`This bypasses SWARM's review safety cap for ${pr} once: it grants one extra review slot and ` +
		'starts the normal corrective sequence — a Respond-to-review run, then a new Review of whatever ' +
		'it pushes. Nothing already running is interrupted, and if that review again requests changes the ' +
		'cap stops the cycle again.'
	);
}

/**
 * The success report, one line per durable step, in the order `forceReReview`
 * performs them. Operators use this to tell a force that actually scheduled work
 * from one that found the cycle already continued (a second click, a refresh),
 * and from one that found a *dead* prior attempt — one that never actually
 * started Respond-to-review (e.g. a stale worker refused it) — and scheduled a
 * fresh one in its place (`dispatch === 'retried'`).
 */
export function describeForceReReviewResult(result: ForceReReviewReport): string[] {
	const dispatchLine =
		result.dispatch === 'scheduled'
			? `Respond-to-review: scheduled for PR #${result.prNumber} as dispatch ${result.dispatchId}.`
			: result.dispatch === 'retried'
				? `Respond-to-review: the previous forced attempt never actually started one${result.previousAttemptOutcome ? ` (${result.previousAttemptOutcome})` : ''} — scheduled a fresh attempt as dispatch ${result.dispatchId}.`
				: result.dispatch === 'already-completed'
					? `Respond-to-review: prior forced dispatch ${result.dispatchId} already completed${result.dispatchOutcome ? ` (${result.dispatchOutcome})` : ''}.`
					: `Respond-to-review: already scheduled for PR #${result.prNumber} as dispatch ${result.dispatchId} — nothing duplicated.`;

	return [
		result.capOverride === 'granted'
			? 'Review cap: one extra review slot granted for this PR.'
			: 'Review cap: an extra review slot was already granted for this review.',
		dispatchLine,
		result.dispatch === 'already-completed'
			? 'Re-review: the corrective response already ran — check the PR for its follow-up review.'
			: 'Re-review: runs automatically once the response pushes a commit.',
	];
}
