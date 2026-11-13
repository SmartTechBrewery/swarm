import type { ComponentProps } from 'react';
import {
	type ForceReReviewRunState,
	isCappedRequestChanges,
	isManualActionRequired,
} from '@/lib/force-re-review.js';

type RunStatus = 'running' | 'completed' | 'failed' | 'deferred' | 'checkpointed' | 'queued';

interface RunStatusBadgeProps extends ComponentProps<'span'> {
	status: RunStatus;
	/**
	 * When the run hit its wall-clock timeout, name the timeout in the badge so it
	 * reads distinctly from a run that stopped for any other reason. A terminal
	 * kill shows an unambiguous "Timed out" instead of a generic "Failed" (issue
	 * #165) — but a wall-clock kill is normally *resumable* and settles `deferred`
	 * or `checkpointed` rather than `failed` (issue #596), so those two statuses
	 * render it too, keeping their own retry state visible (issue #600).
	 */
	timedOut?: boolean;
	/**
	 * The run has a recorded cancellation origin (`run.cancellation`): an operator
	 * stopped it on purpose — dashboard/API Terminate, or its board card moved to
	 * Backlog (issue #1453) — so it reads **Canceled**, not **Failed**. Only takes
	 * effect with `status === 'failed'`, the status a cancellation settles as.
	 */
	cancelled?: boolean;
	/**
	 * The run's pipeline phase. A completed `review` run with a {@link reviewVerdict}
	 * shows that verdict instead of the generic "Completed" badge (issue #218);
	 * any other phase, or a non-completed status, falls through to the lifecycle
	 * badge so failed/running/deferred/cancelled runs never show a stale verdict.
	 */
	phase?: string;
	/**
	 * The verdict a completed Review run submitted (`approve` / `request-changes`;
	 * rows written before issue #470 can also hold the retired `comment`).
	 * Null/absent for non-review phases and pre-existing rows, which keep the
	 * lifecycle badge (issue #218).
	 */
	reviewVerdict?: string | null;
	/**
	 * This Review run's automation outcome (issue #235) — `manual-intervention-required`
	 * when it submitted the last `request-changes` verdict the review-verdict safety
	 * cap allows. Only takes effect alongside a `request-changes` {@link reviewVerdict}
	 * on a completed Review run; null/absent otherwise keeps the plain verdict badge
	 * (issue #242).
	 */
	reviewAutomationOutcome?: string | null;
	/**
	 * When this Review run's approval was superseded by the pull request's head
	 * moving (issue #1080). Only takes effect alongside an `approve`
	 * {@link reviewVerdict} on a completed Review run, which then reads as
	 * approved-but-superseded rather than as an approval that counted toward the
	 * review cap; null/absent keeps the plain verdict badge.
	 */
	reviewSupersededAt?: string | null;
	/**
	 * This Review run's merge-automation outcome. Read together with
	 * {@link reviewCapSpent} by the shared `isManualActionRequired` predicate: an
	 * approval whose merge was refused (`not-eligible`) on a pull request whose
	 * review allowance is spent is the cap-spent approval stop (issue #1378).
	 */
	reviewMergeOutcome?: string | null;
	/** The server-resolved ledger fact `isCapSpentApproval` reads (issue #1038). */
	reviewCapSpent?: boolean | null;
	/** Which bound made the cap-spent approval stop (issue #1080) — selects the tooltip only. */
	reviewCapStop?: ForceReReviewRunState['reviewCapStop'];
}

interface BadgeConfig {
	text: string;
	classes: string;
	dotClass: string;
	pulse?: boolean;
	/** Native tooltip; used to keep fuller context available for a short `text`. */
	title?: string;
}

const STATUS_CONFIGS: Record<RunStatus, BadgeConfig> = {
	running: {
		text: 'Running',
		classes: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
		dotClass: 'bg-blue-400',
		pulse: true,
	},
	completed: {
		text: 'Completed',
		classes: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
		dotClass: 'bg-emerald-400',
	},
	failed: {
		text: 'Failed',
		classes: 'bg-red-500/10 text-red-400 border-red-500/20',
		dotClass: 'bg-red-400',
	},
	deferred: {
		text: 'Deferred',
		classes: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
		dotClass: 'bg-amber-400',
	},
	// The *other* retry-pending status (issue #503): waiting to be continued from
	// its Tier 2 checkpoint, not waiting on quota. It must not read as amber
	// "Deferred", so it takes `sky` — the one status hue `ai/DESIGN_SYSTEM.md` §1
	// documents (and `index.css` light-theme-overrides) that no badge had claimed
	// yet, rather than an invented colour. It shares the blue *family* with
	// "Running" but never the row: this status has no live agent, so it carries no
	// pulse, and the label — not the hue — is what says which state it is. `title`
	// keeps the "why it's waiting" context a one-word label can't.
	checkpointed: {
		text: 'Checkpointed',
		classes: 'bg-sky-500/10 text-sky-400 border-sky-500/20',
		dotClass: 'bg-sky-400',
		title:
			'Stopped with a checkpoint — waiting to be continued from its recorded remainder, not waiting on quota.',
	},
	// Enqueued but not yet picked up (issue #238). Neutral zinc and, crucially, no
	// pulse — it must read as clearly *not running* against the blue pulsing
	// "Running" badge.
	queued: {
		text: 'Queued',
		classes: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
		dotClass: 'bg-zinc-400',
	},
};

const TIMED_OUT_CONFIG: BadgeConfig = {
	text: 'Timed out',
	classes: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
	dotClass: 'bg-orange-400',
};

/**
 * A `failed` run an operator stopped on purpose (issue #1453) — it carries a
 * recorded cancellation origin. Orange is shared with the terminal
 * {@link TIMED_OUT_CONFIG} on purpose: both are terminal stops that are not a
 * genuine failure, which keeps red "Failed" for runs that actually broke. As
 * with `checkpointed` vs. "Running", the label rather than the hue says which.
 */
const CANCELED_CONFIG: BadgeConfig = {
	text: 'Canceled',
	classes: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
	dotClass: 'bg-orange-400',
	title: 'Stopped on purpose by an operator — not a failure.',
};

/**
 * The *resumable* end of a wall-clock kill (issue #600). Killing a run for
 * running too long normally leaves it retryable, so it settles `deferred` or
 * `checkpointed` rather than `failed` (issue #596) — and the plain lifecycle
 * badge would then read as an ordinary rate-limit deferral, leaving the runs
 * list unable to answer "which runs hit the timeout".
 *
 * Each entry keeps its status's own config — hue, dot, and the retry state it
 * encodes — and only re-words the label, so an operator still tells "waiting on
 * quota" from "waiting to continue from a checkpoint" (the distinction
 * `ai/DESIGN_SYSTEM.md` §1 and the `checkpointed` comment above deliberately
 * carry) while the words say why it is waiting. No new hue: the orange
 * {@link TIMED_OUT_CONFIG} stays reserved for the terminal, non-resumable kill.
 */
const TIMED_OUT_RETRY_CONFIGS: Partial<Record<RunStatus, BadgeConfig>> = {
	deferred: {
		...STATUS_CONFIGS.deferred,
		text: 'Timed out · retrying',
		title:
			'Hit its wall-clock timeout — deferred for an automatic retry, not waiting on quota or capacity.',
	},
	checkpointed: {
		...STATUS_CONFIGS.checkpointed,
		text: 'Timed out · checkpointed',
		title:
			'Hit its wall-clock timeout — waiting to be continued from its recorded checkpoint, not waiting on quota.',
	},
};

/**
 * Human-readable, semantically-coloured labels for a completed Review run's
 * submitted verdict (issue #218): approval reuses the green "Completed" hue,
 * changes-requested the amber "Deferred" hue, and any other verdict a distinct
 * violet so it reads as neither a pass nor a rejection. The label text — not
 * colour alone — carries the meaning, so the badges stay legible to colour-blind
 * users and screen readers.
 *
 * `comment` is kept as a row here even though SWARM stopped submitting it (issue
 * #470): runs recorded before that still hold the verdict, and their badge would
 * otherwise fall back to the raw key.
 */
const REVIEW_VERDICT_CONFIGS: Record<string, BadgeConfig> = {
	approve: {
		text: 'Approved',
		classes: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
		dotClass: 'bg-emerald-400',
	},
	'request-changes': {
		text: 'Changes requested',
		classes: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
		dotClass: 'bg-amber-400',
	},
	comment: {
		text: 'Commented',
		classes: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
		dotClass: 'bg-violet-400',
	},
};

/**
 * Distinct, high-attention treatment for a completed Review run whose verdict
 * was the last `request-changes` the review-verdict safety cap allows (issue
 * #242): SWARM stopped the automatic Respond-to-review/re-review cycle, so the
 * PR needs a human decision instead of another automatic pass. Reuses the same
 * red "Danger" hue as the lifecycle "Failed" badge — the two never appear on
 * the same row (this only renders for `status === 'completed'`) — rather than
 * introduce an undocumented color. The short visible `text` alone doesn't say
 * *why*, so `title` retains the underlying request-changes context for a hover.
 */
const MANUAL_INTERVENTION_CONFIG: BadgeConfig = {
	text: 'Manual action required',
	classes: 'bg-red-500/10 text-red-400 border-red-500/20',
	dotClass: 'bg-red-400',
	title:
		'Final changes-requested verdict — SWARM stopped automatic re-review; this PR needs a human decision.',
};

/**
 * The *other* review-cap stop (issues #1038, #1378): an approval merge automation
 * refused, on a pull request whose review allowance is spent — nothing will
 * dispatch another review, so it needs a person exactly as the capped
 * `request-changes` verdict does. Same text and hue as
 * {@link MANUAL_INTERVENTION_CONFIG}, so the runs list reads it as the stop the
 * run-detail callout describes rather than as "Approved · superseded"; only the
 * `title` differs, naming the bound that made the stop. Like the callout's copy,
 * neither title names the cap's numeric value.
 */
const CAP_SPENT_APPROVAL_CONFIGS: Record<'verdict-cap' | 'superseded-bound', BadgeConfig> = {
	'verdict-cap': {
		...MANUAL_INTERVENTION_CONFIG,
		title:
			'Approved, but merge automation refused it and the review allowance is spent — open the run to Force re-review.',
	},
	'superseded-bound': {
		...MANUAL_INTERVENTION_CONFIG,
		title:
			"Approved, but the pull request's head moved out from under too many approvals — SWARM stopped reviewing it; open the run to Force re-review.",
	},
};

/**
 * An approval superseded by a head change (issue #1080): the review happened and
 * passed, but the pull request's head moved before it could merge — usually
 * SWARM's own conflict resolution — so it spent no review-cap slot and SWARM
 * reviews the new head instead. Without this the runs list shows several
 * identical "Approved" rows, some of which counted and some of which did not.
 *
 * Re-labelled rather than a new status, as {@link TIMED_OUT_RETRY_CONFIGS} does,
 * and in the neutral zinc hue rather than the approval's green: it is no longer
 * the pull request's standing verdict, and the label — not the hue — says why.
 */
const SUPERSEDED_APPROVAL_CONFIG: BadgeConfig = {
	text: 'Approved · superseded',
	classes: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
	dotClass: 'bg-zinc-400',
	title:
		"Approved, but the pull request's head moved before it merged — this review did not spend a review-cap slot, and SWARM reviews the new head instead.",
};

/** Title-case a hyphenated verdict key for a label ('some-verdict' → 'Some verdict'). */
function humanizeVerdict(verdict: string): string {
	const spaced = verdict.replace(/-/g, ' ');
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Fallback violet badge for any verdict not in {@link REVIEW_VERDICT_CONFIGS}. */
function verdictFallbackConfig(verdict: string): BadgeConfig {
	return {
		text: humanizeVerdict(verdict),
		classes: 'bg-violet-500/10 text-violet-400 border-violet-500/20',
		dotClass: 'bg-violet-400',
	};
}

/** Everything {@link resolveBadgeConfig} reads — the badge's own props, minus presentation. */
type BadgeInput = Pick<
	RunStatusBadgeProps,
	| 'status'
	| 'phase'
	| 'reviewVerdict'
	| 'reviewAutomationOutcome'
	| 'reviewSupersededAt'
	| 'reviewMergeOutcome'
	| 'reviewCapSpent'
	| 'reviewCapStop'
> & { timedOut: boolean; cancelled: boolean };

/**
 * A completed Review run's verdict badge. Both review-cap stops read "Manual
 * action required" — the capped changes-requested verdict (issue #242) and the
 * cap-spent approval (issue #1378) — decided by the very predicate the run-detail
 * view uses, and checked before "superseded" because a superseded-bound stop is
 * both.
 */
function reviewVerdictConfig(
	input: BadgeInput & { phase: string; reviewVerdict: string },
): BadgeConfig {
	if (isManualActionRequired(input)) {
		return isCappedRequestChanges(input)
			? MANUAL_INTERVENTION_CONFIG
			: CAP_SPENT_APPROVAL_CONFIGS[input.reviewCapStop ?? 'verdict-cap'];
	}
	if (input.reviewVerdict === 'approve' && input.reviewSupersededAt) {
		return SUPERSEDED_APPROVAL_CONFIG;
	}
	return REVIEW_VERDICT_CONFIGS[input.reviewVerdict] ?? verdictFallbackConfig(input.reviewVerdict);
}

function resolveBadgeConfig(input: BadgeInput): BadgeConfig {
	const { status, timedOut, cancelled, phase, reviewVerdict } = input;
	// The operator's stop is why the run ended, so it outranks a timeout flag.
	if (status === 'failed' && cancelled) return CANCELED_CONFIG;
	if (status === 'failed' && timedOut) return TIMED_OUT_CONFIG;
	// A resumable wall-clock kill settles deferred/checkpointed, so the timeout
	// has to be legible on those rows too — as their own hue, re-labelled.
	if (timedOut) {
		const retryConfig = TIMED_OUT_RETRY_CONFIGS[status];
		if (retryConfig) return retryConfig;
	}
	// A completed Review run shows its verdict rather than "Completed"; anything
	// non-completed (or a review row missing its verdict) keeps lifecycle status.
	if (status === 'completed' && phase === 'review' && reviewVerdict) {
		return reviewVerdictConfig({ ...input, phase, reviewVerdict });
	}
	return (
		STATUS_CONFIGS[status] ?? {
			text: status,
			classes: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
			dotClass: 'bg-zinc-400',
		}
	);
}

export function RunStatusBadge({
	status,
	timedOut = false,
	cancelled = false,
	phase,
	reviewVerdict,
	reviewAutomationOutcome,
	reviewSupersededAt,
	reviewMergeOutcome,
	reviewCapSpent,
	reviewCapStop,
	className = '',
	...props
}: RunStatusBadgeProps) {
	const config = resolveBadgeConfig({
		status,
		timedOut,
		cancelled,
		phase,
		reviewVerdict,
		reviewAutomationOutcome,
		reviewSupersededAt,
		reviewMergeOutcome,
		reviewCapSpent,
		reviewCapStop,
	});

	return (
		<span
			title={config.title}
			className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold border ${config.classes} ${className}`}
			{...props}
		>
			<span
				className={`h-1.5 w-1.5 rounded-full ${config.dotClass} ${config.pulse ? 'animate-pulse' : ''}`}
			/>
			{config.text}
		</span>
	);
}
