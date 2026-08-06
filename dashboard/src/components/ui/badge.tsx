import type { ReactNode } from 'react';

/**
 * The dashboard's one meta pill (`ai/DESIGN_SYSTEM.md` §4), shared by every screen
 * with a short machine-ish label to stamp: the Workers table's declared CLIs, the
 * worker detail view's phase repertoire, and its per-project enrollment status and
 * routing verdict. One geometry everywhere, so the same fact reads identically
 * wherever it appears and nothing is emphasized by being *bigger*.
 *
 * Only the hue varies: the three status hues carry state (approved /
 * awaiting-approval / suspended), and `caution` doubles as the one that
 * promotes a badge in a set (the `planning` phase, issue #467) — the same amber
 * whether or not that instance of `planning` is otherwise flagged unavailable.
 * Reach for a new tone here rather than hand-rolling a second pill.
 */

const BADGE_BASE =
	'px-2 py-0.5 text-[10px] uppercase font-mono font-bold tracking-wider rounded border';

const BADGE_TONES = {
	neutral: 'bg-zinc-850 text-zinc-400 border-zinc-800',
	positive: 'bg-emerald-950/30 text-emerald-300 border-emerald-900/30',
	caution: 'bg-amber-950/20 text-amber-200 border-amber-900/30',
	negative: 'bg-red-950/30 text-red-400 border-red-900/30',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({
	children,
	tone = 'neutral',
	title,
}: {
	children: ReactNode;
	tone?: BadgeTone;
	/** Hover explanation, e.g. what a status word means for dispatch. */
	title?: string;
}) {
	return (
		<span title={title} className={`${BADGE_BASE} ${BADGE_TONES[tone]}`}>
			{children}
		</span>
	);
}
