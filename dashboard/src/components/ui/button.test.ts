import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buttonClass } from './button.js';

/**
 * The one button recipe, and the guard that keeps it the only one.
 *
 * The composition tests are the cheap half. The half that matters is the sweep
 * below: this consolidation replaced 34 hand-rolled class strings, and nothing
 * about a 35th would look wrong in review — a button copied from the one next to
 * it reads perfectly in its own diff. So the rule is asserted against the source
 * tree rather than trusted to reviewers, exactly as the worker agent's plist
 * assertions are (`tests/unit/worker/worker-agent-lock-guard.test.ts`).
 */
const SRC = fileURLToPath(new URL('../..', import.meta.url));

/** Every `.tsx` under `dashboard/src`, minus the tests and the recipe itself. */
function sourceFiles(dir: string = SRC): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		if (!entry.name.endsWith('.tsx')) return [];
		if (entry.name.includes('.test.') || entry.name === 'button.tsx') return [];
		return [path];
	});
}

/**
 * The four fills only an action button wears. The two solid ones are unambiguous —
 * nothing else on any screen is `bg-violet-600` or `bg-red-600`. The two tinted
 * ones are matched together with their own border, because the tint alone is also
 * a banner's (`bg-red-950/30` warns, `bg-red-950/40 border-red-900/50` is the
 * danger card's entry button) and a guard that fired on banners would be turned off.
 */
const HAND_ROLLED = [
	/bg-violet-600/, // primary
	/bg-red-600/, // danger
	/bg-red-950\/40[^"']*\bborder-red-900\/50\b/, // dangerOutline
	/bg-emerald-500\/10[^"']*\bborder-emerald-500\/20\b/, // success
];

/**
 * The two files that fill with violet without being action buttons: they are
 * **toggles**, where the fill *is* the on state rather than a call to action — the
 * design system's one switch, and the live log's follow-output pin. Neither has a
 * size or a resting colour to share with the recipe. Adding a file here needs that
 * same argument; "it was easier" is the thing this test exists to catch.
 */
const TOGGLES = ['components/ui/toggle-switch.tsx', 'components/runs/live-output-viewer.tsx'];

describe('buttonClass', () => {
	it('composes base, size, and variant', () => {
		const classes = buttonClass('primary', 'md');

		expect(classes).toContain('inline-flex items-center rounded-md');
		expect(classes).toContain('px-4 py-2 text-sm');
		expect(classes).toContain('bg-violet-600');
	});

	it('defaults to the size that lines up with an input', () => {
		// `md` is `py-2 text-sm`, the Input/Select recipe's own geometry, so a button
		// sharing a row with a field matches its height without anyone measuring.
		expect(buttonClass('secondary')).toBe(buttonClass('secondary', 'md'));
		expect(buttonClass('secondary')).toContain('px-4 py-2 text-sm');
	});

	it('keeps size and variant independent', () => {
		// The pairing that broke: a Reset beside a Save was stuck at the small size
		// because "secondary" used to mean a size as well as a colour.
		expect(buttonClass('secondary', 'md')).toContain('px-4 py-2 text-sm');
		expect(buttonClass('primary', 'sm')).toContain('px-3 py-1.5 text-xs');
	});

	it('gives every variant the same disabled treatment', () => {
		for (const variant of ['primary', 'secondary', 'danger', 'success', 'dangerOutline'] as const) {
			expect(buttonClass(variant)).toContain('disabled:opacity-55');
			expect(buttonClass(variant)).toContain('disabled:cursor-not-allowed');
		}
	});
});

describe('no second button recipe', () => {
	it('leaves no action-button colour written by hand anywhere in the dashboard', () => {
		const offenders = sourceFiles()
			.filter((file) => !TOGGLES.some((toggle) => file.endsWith(toggle)))
			.flatMap((file) => {
				const source = readFileSync(file, 'utf8');
				return [...source.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)]
					.map((match) => match[1] ?? match[2] ?? match[3] ?? '')
					.filter((classes) => HAND_ROLLED.some((pattern) => pattern.test(classes)))
					.map((classes) => `${file.slice(SRC.length)}: ${classes.slice(0, 60)}…`);
			})
			.sort();

		// A new button belongs in `BUTTON_VARIANTS`/`BUTTON_SIZES`, not in a className.
		expect(offenders).toEqual([]);
	});
});
