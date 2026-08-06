import type { ReactNode } from 'react';

/**
 * The dashboard's one meta pill (`ai/DESIGN_SYSTEM.md` §4), shared by every screen
 * with a short machine-ish label to stamp: the Workers table's declared CLIs, the
 * worker detail view's phase repertoire, and its per-project enrollment status and
 * routing verdict. One geometry everywhere, so the same fact reads identically
 * wherever it appears and nothing is emphasized by being *bigger*.
 *
 * Only the hue varies, and it always carries *state*: approved / awaiting-approval
 * / suspended, or an allowed phase that currently cannot take work. It is
 * deliberately not a way to promote one member of a set — `caution` used to double
 * as that for the `planning` phase, which is how Planning came to read as a
 * special, differently-trusted thing on two screens (issue #542). Reach for a new
 * tone here rather than hand-rolling a second pill.
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
