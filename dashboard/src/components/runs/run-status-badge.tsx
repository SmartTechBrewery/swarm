import type { ComponentProps } from 'react';

type RunStatus = 'running' | 'completed' | 'failed' | 'deferred' | 'checkpointed' | 'queued';

interface RunStatusBadgeProps extends ComponentProps<'span'> {
	status: RunStatus;
	/**
	 * When the run failed specifically because it hit its wall-clock timeout,
	 * render an unambiguous "Timed out" badge instead of a generic "Failed" — so
	 * a run the worker killed for running too long reads distinctly from one that
	 * exited with an error (issue #165).
	 */
	timedOut?: boolean;
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

function resolveBadgeConfig(
	status: RunStatus,
	timedOut: boolean,
	phase: string | undefined,
	reviewVerdict: string | null | undefined,
	reviewAutomationOutcome: string | null | undefined,
): BadgeConfig {
	if (status === 'failed' && timedOut) return TIMED_OUT_CONFIG;
	// A completed Review run shows its verdict rather than "Completed"; anything
	// non-completed (or a review row missing its verdict) keeps lifecycle status.
	if (status === 'completed' && phase === 'review' && reviewVerdict) {
		// The cap-stopping second changes-requested verdict gets its own distinct
		// treatment instead of the ordinary "Changes requested" badge (issue #242).
		if (
			reviewVerdict === 'request-changes' &&
			reviewAutomationOutcome === 'manual-intervention-required'
		) {
			return MANUAL_INTERVENTION_CONFIG;
		}
		return REVIEW_VERDICT_CONFIGS[reviewVerdict] ?? verdictFallbackConfig(reviewVerdict);
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
	phase,
	reviewVerdict,
	reviewAutomationOutcome,
	className = '',
	...props
}: RunStatusBadgeProps) {
	const config = resolveBadgeConfig(
		status,
		timedOut,
		phase,
		reviewVerdict,
		reviewAutomationOutcome,
	);

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
