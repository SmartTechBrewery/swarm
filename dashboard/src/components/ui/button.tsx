/**
 * The dashboard's one button recipe (`ai/DESIGN_SYSTEM.md` §4).
 *
 * Every action button on every screen resolves its classes here: Save Changes and
 * Reset, a modal's confirm and its Cancel, a table row's inline action, the danger
 * cards' entry and confirm. Before this there were **34 distinct class strings**
 * across 90 buttons — the same violet primary spelled six ways (`opacity-50` vs
 * `55`, `ring-1` vs `ring-2`, `shadow-violet-650/10` vs `950/10`, one with no
 * disabled state at all), the same zinc secondary ten ways, and two panels each
 * keeping their own private copy of both. The drift was not visible to whoever
 * wrote the next one, which is exactly how it grew: a hand-rolled button looks
 * right beside the one it was copied from and wrong beside the one it was not.
 *
 * **Size is an axis of its own, and it is the one that actually broke.** A Save /
 * Reset pair had a `md` primary next to an `sm` secondary, because the design
 * system's two recipes each carried a size and nobody had said the two facts were
 * separable. They are: a button is sized by what it stands beside — its sibling
 * action, or the input it shares a row with — and coloured by what it does. So the
 * pair is `(variant, size)` here, and a secondary at `md` is an ordinary thing to
 * ask for rather than a hand-edited copy of the small one.
 *
 * **A class helper rather than a `<Button>` component**, unlike {@link Badge} and
 * `ToggleSwitch` next door. Those wrap an element with no API of its own; a button
 * carries `type`, `disabled`, `onClick`, `form`, `aria-*`, a ref, and sometimes a
 * layout class of its own from the row it sits in — so a component here would be
 * mostly prop forwarding, and every call site that needed one more attribute would
 * be a reason to reach past it. The rule is the same either way: never write these
 * classes by hand, and add a variant or a size here when something genuinely new
 * is needed.
 */

/** What the button *does*, which is what decides its colour. */
const BUTTON_VARIANTS = {
	/** The screen's affirmative action: submit, create, save, confirm. */
	primary:
		'font-semibold text-white bg-violet-600 hover:bg-violet-500 focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 shadow-lg shadow-violet-650/10',
	/**
	 * Everything beside a primary, and every action that is not the reason its
	 * screen exists: Cancel, Reset, Clear search, a row's inline action.
	 * `hover:text-zinc-100` rather than `hover:text-white`, so hover stays
	 * theme-aware instead of pinned white in Light.
	 */
	secondary:
		'font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 hover:text-zinc-100 focus:ring-2 focus:ring-violet-500',
	/** The filled confirm of something destructive — inside the modal, never on the page. */
	danger:
		'font-semibold text-white bg-red-600 hover:bg-red-500 focus:ring-2 focus:ring-offset-2 focus:ring-red-500',
	/**
	 * A button that has already succeeded and stays on screen saying so — the
	 * credential panels' `Verify` once the secret verified. It is a *button* rather
	 * than a badge because it remains pressable (verify again), so it needs a button's
	 * geometry and a state's hue.
	 */
	success:
		'font-medium text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 hover:bg-emerald-500/15 focus:ring-2 focus:ring-emerald-500',
	/**
	 * The destructive action's *entry* button, which only opens the modal that then
	 * carries the filled `danger` confirm. Outlined rather than filled precisely so
	 * the two do not look like the same click.
	 */
	dangerOutline:
		'font-semibold text-red-200 bg-red-950/40 border border-red-900/50 hover:bg-red-900/40 focus:ring-1 focus:ring-red-500',
} as const;

/**
 * How large it is, which is decided by what it stands next to — not by what it
 * does. `md` matches the Input/Select recipe's `py-2 text-sm`, so a button sharing
 * a row with one lines up with it; `sm` is the table-and-toolbar default; `xs` is
 * for a dense row of chips inside a card.
 */
const BUTTON_SIZES = {
	xs: 'gap-1 px-2 py-1 text-[11px]',
	sm: 'gap-1.5 px-3 py-1.5 text-xs',
	md: 'gap-2 px-4 py-2 text-sm',
} as const;

const BUTTON_BASE =
	'inline-flex items-center rounded-md transition-colors cursor-pointer focus:outline-none disabled:opacity-55 disabled:cursor-not-allowed';

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;
export type ButtonSize = keyof typeof BUTTON_SIZES;

/**
 * The classes for one button. Pass the result straight to `className`, appending
 * only *layout* of the caller's own (`w-full`, a margin, an absolute position) —
 * never another colour, weight, or padding, which is what this exists to stop.
 */
export function buttonClass(variant: ButtonVariant, size: ButtonSize = 'md'): string {
	return `${BUTTON_BASE} ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]}`;
}
