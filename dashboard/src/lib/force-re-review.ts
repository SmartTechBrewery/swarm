/**
 * Pure view-logic for the review-cap stops the run-detail view surfaces, split
 * out of the route the same way `./run-reset.ts` is — so it can be unit-tested
 * without a rendered component, and so the "Force re-review" action's copy lives
 * beside the recovery action whose interaction pattern it follows.
 *
 * It covers **both** cap stops, and since issue #1040 both have a lever on the
 * same `runs.forceReReview` mutation — which continuation the server runs follows
 * from the run's own shape, not from anything the button says. The
 * `request-changes` loop's (issue #511) is gated by {@link canForceReReview}; the
 * approval that merge automation then refused (issue #1038) is recognised by
 * {@link isCapSpentApproval} and gated for action by
 * {@link canForceReviewOfSupersededHead}. The two predicates are mutually
 * exclusive by verdict and each keeps its own confirmation copy, because they
 * promise different work: a corrective response, vs. one review of the pull
 * request's current head.
 */

/** The report `runs.forceReReview` returns — mirrors `ForceReReviewResult`. */
export interface ForceReReviewReport {
	runId: string;
	prNumber: string;
	/** Which continuation the server ran — it decides, from the run's shape (issue #1040). */
	continuation: 'respond-to-review' | 'review';
	headSha: string;
	/** Set only when `continuation === 'review'`: the current head that review targets. */
	reviewHeadSha?: string;
	capOverride: 'granted' | 'already-granted';
	dispatch: 'scheduled' | 'already-scheduled' | 'already-completed' | 'retried';
	dispatchId: string;
	dispatchState?: string;
	dispatchOutcome?: string | null;
	/** Set only when `dispatch === 'retried'`: why the prior attempt didn't count. */
	previousAttemptOutcome?: string | null;
}

/** The run fields the availability rules read — the subset `RunRow` and the API row share. */
export interface ForceReReviewRunState {
	status: string;
	phase: string;
	reviewVerdict?: string | null;
	reviewAutomationOutcome?: string | null;
	/** Read by {@link isCapSpentApproval} alone (issue #1038); optional, so #511's callers are unaffected. */
	reviewMergeOutcome?: string | null;
	/** Likewise — the server-resolved ledger fact, absent on the list read model. */
	reviewCapSpent?: boolean | null;
}

/**
 * The project settings that can disable a forced continuation — one per
 * continuation, because each is gated by the phase it actually dispatches: the
 * corrective sequence by Respond-to-review, the superseded-head review by Review.
 */
export interface ForceReReviewPipeline {
	respondToReview?: { enabled?: boolean };
	review?: { enabled?: boolean };
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

/**
 * Whether this run is the *other* review-cap stop (issue #1038): a completed
 * Review that **approved**, whose approval merge automation then refused, on a
 * pull request whose review allowance is spent. Nothing will dispatch another
 * review for it — the `pr-review` trigger's cap gate skips, and the recovery
 * sweep classifies it `capped` — so it needs a person.
 *
 * Deliberately *not* a variant of {@link canForceReReview}: that predicate is the
 * `request-changes` loop's (issue #511) and must keep answering exactly as it
 * does. The two are mutually exclusive by verdict.
 *
 * It claims only what the row proves. `not-eligible` covers five refusals — the
 * superseded reviewed head this is usually about, plus draft, closed, a
 * dismissed approval and changes requested since — and telling them apart means
 * matching a provider's own message text, which shared code must not do. The
 * merge callout rendered below already names the provider's cause; this one
 * names the consequence.
 */
export function isCapSpentApproval(run: ForceReReviewRunState): boolean {
	return (
		run.status === 'completed' &&
		run.phase === 'review' &&
		run.reviewVerdict === 'approve' &&
		run.reviewMergeOutcome === 'not-eligible' &&
		run.reviewCapSpent === true
	);
}

/**
 * Whether the superseded-head review can be forced for this run (issue #1040):
 * the cap stop {@link isCapSpentApproval} recognises, on a project that still has
 * Review enabled. Mirrors the server's own two gates for that branch, so the
 * button never offers an action the router would refuse outright.
 *
 * It deliberately stops there. Whether the head actually moved is a fact only the
 * provider holds, and the server reads it once per click rather than on every
 * render of this page; a run whose merge was refused for one of `not-eligible`'s
 * other causes therefore still shows the button and is answered with the
 * `head-unchanged` refusal, which names the real cause.
 */
export function canForceReviewOfSupersededHead(
	run: ForceReReviewRunState,
	pipeline?: ForceReReviewPipeline,
): boolean {
	return isCapSpentApproval(run) && pipeline?.review?.enabled !== false;
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
 * The confirmation-modal copy for the *other* continuation (issue #1040). Same
 * job as {@link forceReReviewConfirmMessage} and deliberately a separate string:
 * this force schedules no response at all, so promising one would misdescribe
 * what the operator is about to start.
 */
export function forceReviewOfSupersededHeadConfirmMessage(prNumber?: string | null): string {
	const pr = prNumber ? `PR #${prNumber}` : 'this PR';
	return (
		`This bypasses SWARM's review safety cap for ${pr} once: it grants one extra review slot and ` +
		"reviews the pull request's current head — the commit that superseded the one this run approved. " +
		'Nothing already running is interrupted, and if that review requests changes the cap stops the ' +
		'cycle again.'
	);
}

/**
 * The success report, one line per durable step, in the order `forceReReview`
 * performs them. Operators use this to tell a force that actually scheduled work
 * from one that found the continuation already under way (a second click, a
 * refresh), and from one that found a *dead* prior attempt — one that never
 * actually started the run it promised (e.g. a stale worker refused it) — and
 * scheduled a fresh one in its place (`dispatch === 'retried'`).
 *
 * Branched on `continuation` (issue #1040), because the two forces schedule
 * different work and the report must name what the operator will actually see: a
 * corrective response whose follow-up review comes later, or one review of a
 * named commit with nothing queued behind it.
 */
export function describeForceReReviewResult(result: ForceReReviewReport): string[] {
	const capLine =
		result.capOverride === 'granted'
			? 'Review cap: one extra review slot granted for this PR.'
			: 'Review cap: an extra review slot was already granted for this review.';

	if (result.continuation === 'review') {
		// The head is part of every line that names scheduled work: the whole point of
		// this force is *which* commit gets reviewed.
		const at = result.reviewHeadSha ? ` at \`${result.reviewHeadSha}\`` : '';
		return [
			capLine,
			result.dispatch === 'scheduled'
				? `Review: scheduled for PR #${result.prNumber}${at} as dispatch ${result.dispatchId}.`
				: result.dispatch === 'retried'
					? `Review: the previous forced attempt never actually started one${result.previousAttemptOutcome ? ` (${result.previousAttemptOutcome})` : ''} — scheduled a fresh attempt for PR #${result.prNumber}${at} as dispatch ${result.dispatchId}.`
					: result.dispatch === 'already-completed'
						? `Review: prior forced dispatch ${result.dispatchId} already completed${result.dispatchOutcome ? ` (${result.dispatchOutcome})` : ''} — check the PR for its review.`
						: `Review: already scheduled for PR #${result.prNumber}${at} as dispatch ${result.dispatchId} — nothing duplicated.`,
		];
	}

	const dispatchLine =
		result.dispatch === 'scheduled'
			? `Respond-to-review: scheduled for PR #${result.prNumber} as dispatch ${result.dispatchId}.`
			: result.dispatch === 'retried'
				? `Respond-to-review: the previous forced attempt never actually started one${result.previousAttemptOutcome ? ` (${result.previousAttemptOutcome})` : ''} — scheduled a fresh attempt as dispatch ${result.dispatchId}.`
				: result.dispatch === 'already-completed'
					? `Respond-to-review: prior forced dispatch ${result.dispatchId} already completed${result.dispatchOutcome ? ` (${result.dispatchOutcome})` : ''}.`
					: `Respond-to-review: already scheduled for PR #${result.prNumber} as dispatch ${result.dispatchId} — nothing duplicated.`;

	return [
		capLine,
		dispatchLine,
		result.dispatch === 'already-completed'
			? 'Re-review: the corrective response already ran — check the PR for its follow-up review.'
			: 'Re-review: runs automatically once the response pushes a commit.',
	];
}
