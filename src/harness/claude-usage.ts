/**
 * Claude Code's print-mode `/usage` answer, decoded into quota windows (issue #671).
 *
 * Unlike `agy`'s `/quota`, the command carries **no** structured payload — the
 * envelope's `modelUsage` is `{}` and the answer is prose in its `result` field
 * (captured live from Claude Code 2.1.227):
 *
 * ```
 * You are currently using your subscription to power your Claude Code usage
 *
 * Current session: 14% used · resets Aug 11 at 11:59pm (Europe/Warsaw)
 * Current week (all models): 34% used · resets Aug 14 at 4:59pm (Europe/Warsaw)
 * Current week (Fable): 0% used
 * ```
 *
 * That asymmetry shapes the whole module: a percentage is exact, while a reset
 * time is a localized human string carrying **no year**. So a percentage always
 * survives, and a reset time is emitted only once the year it omits resolves to
 * exactly one candidate — an unresolvable one degrades its window to
 * percentage-only rather than failing the read.
 *
 * A line this module doesn't recognize is "no live data", never a parse error:
 * the prose is the only supported source, so a reworded release must degrade the
 * card to the run-derived fallback instead of turning it red.
 */

import type { QuotaWindow } from './quota.js';

/**
 * One reported usage line: a `Current session` / `Current week (…)` label, the
 * percentage consumed, and — optionally — the human reset hint trailing it.
 * Anchored on the label so a prose paragraph that happens to contain a
 * percentage can't be read as a window.
 */
const USAGE_LINE_RE =
	/^\s*(current\s+(session|week)\b[^:]*?)\s*:\s*(\d{1,3}(?:\.\d+)?)%\s+used\b(.*)$/i;

/** The reset hint inside a usage line's trailer (`· resets Aug 14 at 4:59pm (Europe/Warsaw)`). */
const RESET_HINT_RE = /\bresets\s+(.+?)\s*$/i;

/** A reset hint that can be resolved: month, day, 12-hour clock time, IANA zone. */
const RESET_HINT_SHAPE_RE =
	/^([a-z]{3,})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)$/i;

/** The scope of a weekly window that covers every model rather than naming one. */
const ALL_MODELS_SCOPE_RE = /^\s*all\s+models\s*$/i;

const MONTH_PREFIXES = [
	'jan',
	'feb',
	'mar',
	'apr',
	'may',
	'jun',
	'jul',
	'aug',
	'sep',
	'oct',
	'nov',
	'dec',
];

/**
 * How far ahead of now a reset may fall and still be believed. Claude's widest
 * window is a week, so this is deliberately loose — its job is only to be far
 * smaller than the ~365-day gap between two candidate years, which is what makes
 * the year resolution unique rather than a coin flip.
 */
const MAX_RESET_HORIZON_MS = 35 * 24 * 60 * 60 * 1000;

/** Slack for a reset that has just passed, or a host clock running slightly fast. */
const RESET_PAST_TOLERANCE_MS = 60 * 60 * 1000;

interface WallTime {
	year: number;
	/** Zero-based, as `Date.UTC` takes it. */
	month: number;
	day: number;
	hour: number;
	minute: number;
}

/**
 * How far `timeZone` is ahead of UTC at `instant`, or undefined when `Intl`
 * doesn't know the zone — which is how an abbreviation ("CEST") or any other
 * non-IANA name in the prose ends up omitting the reset time instead of
 * resolving to the host's own zone.
 */
function timeZoneOffsetMs(timeZone: string, instant: Date): number | undefined {
	try {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		}).formatToParts(instant);
		const read = (type: Intl.DateTimeFormatPartTypes): number =>
			Number(parts.find((part) => part.type === type)?.value);
		const wall = Date.UTC(
			read('year'),
			read('month') - 1,
			read('day'),
			read('hour'),
			read('minute'),
			read('second'),
		);
		return Number.isNaN(wall) ? undefined : wall - instant.getTime();
	} catch {
		return undefined;
	}
}

/**
 * The instant a wall-clock time in `timeZone` names. Read the zone's offset at
 * the naive interpretation, correct by it, then re-read at the corrected
 * instant: one correction settles a DST transition, because the second read is
 * already on the right side of it.
 */
function zonedWallTimeToInstant(wall: WallTime, timeZone: string): Date | undefined {
	const naive = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
	const asIfUtc = new Date(naive);
	// `Date.UTC` rolls an impossible date over (Feb 30 → Mar 1/2) rather than
	// rejecting it, so a nonsense day must be caught by the round trip.
	if (asIfUtc.getUTCMonth() !== wall.month || asIfUtc.getUTCDate() !== wall.day) return undefined;
	const guess = timeZoneOffsetMs(timeZone, asIfUtc);
	if (guess === undefined) return undefined;
	const candidate = new Date(naive - guess);
	const actual = timeZoneOffsetMs(timeZone, candidate);
	return actual === undefined || actual === guess ? candidate : new Date(naive - actual);
}

/**
 * Resolve a reset hint to an ISO instant, or undefined when it can't be resolved
 * unambiguously.
 *
 * The hint names no year, so each candidate year is tested against the one thing
 * known about a *live* reset: it is near. At most one candidate can land inside
 * the accepted window (they are a year apart, the window is ~35 days wide), so
 * this resolves the missing year rather than guessing it — and a hint that fits
 * no candidate, names an unknown zone, or isn't shaped like a date at all yields
 * nothing instead of a plausible-looking wrong instant.
 */
function resolveResetInstant(hint: string, now: Date): string | undefined {
	const match = RESET_HINT_SHAPE_RE.exec(hint.trim());
	if (!match) return undefined;
	const month = MONTH_PREFIXES.indexOf(match[1].slice(0, 3).toLowerCase());
	const day = Number(match[2]);
	const hour12 = Number(match[3]);
	if (month === -1 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12) return undefined;
	const minute = match[4] === undefined ? 0 : Number(match[4]);
	if (minute > 59) return undefined;
	const hour = (hour12 % 12) + (match[5].toLowerCase() === 'pm' ? 12 : 0);
	const timeZone = match[6].trim();
	const reference = now.getUTCFullYear();
	for (const year of [reference - 1, reference, reference + 1]) {
		const instant = zonedWallTimeToInstant({ year, month, day, hour, minute }, timeZone);
		if (!instant) return undefined;
		const delta = instant.getTime() - now.getTime();
		if (delta >= -RESET_PAST_TOLERANCE_MS && delta <= MAX_RESET_HORIZON_MS) {
			return instant.toISOString();
		}
	}
	return undefined;
}

/**
 * Whether a window is scoped to one model (`Current week (Fable)`) rather than
 * to the whole weekly allowance (`Current week (all models)`, `Current session`).
 */
function isModelScoped(kind: string, name: string): boolean {
	if (kind.toLowerCase() !== 'week') return false;
	const scope = /\(([^)]*)\)/.exec(name)?.[1];
	return scope !== undefined && !ALL_MODELS_SCOPE_RE.test(scope);
}

/**
 * The windows Claude's `/usage` prose reports, or undefined when it carries no
 * recognizable usage line at all — a build or auth mode that answers something
 * else, which the caller reads as "no live data".
 *
 * Windows keep the label Claude itself printed and carry **no** `durationMins`:
 * the prose states no window duration, and inventing one would let the
 * dashboard's derived `(5h)`/`(7d)` suffix contradict the name beside it — the
 * mislabelling issue #669 fixes for Codex. `now` is injected so the year
 * resolution above is testable against captured output.
 */
export function parseClaudeUsageReport(report: string, now: Date): QuotaWindow[] | undefined {
	const windows: QuotaWindow[] = [];
	for (const line of report.split('\n')) {
		const match = USAGE_LINE_RE.exec(line);
		if (!match) continue;
		const usedPercent = Number(match[3]);
		if (usedPercent > 100) continue;
		const name = match[1].replace(/\s+/g, ' ').trim();
		// Claude lists every model-scoped weekly limit, used or not. An untouched
		// one is real but says nothing, so surfacing it would fill the card with
		// 100%-remaining rows.
		if (usedPercent === 0 && isModelScoped(match[2], name)) continue;
		const hint = RESET_HINT_RE.exec(match[4])?.[1];
		const resetsAt = hint === undefined ? undefined : resolveResetInstant(hint, now);
		windows.push({ name, usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) });
	}
	return windows.length > 0 ? windows : undefined;
}

/**
 * The window that will block the next run first — the least remaining allowance,
 * whichever period it belongs to. The snapshot's headline
 * `remainingPercentage`/`resetTime` come from it rather than from a fixed slot,
 * so an exhausted weekly limit isn't hidden behind a fresh session window.
 */
export function bindingUsageWindow(windows: QuotaWindow[]): QuotaWindow | undefined {
	return windows.reduce<QuotaWindow | undefined>(
		(worst, window) =>
			worst === undefined || (window.usedPercent ?? 0) > (worst.usedPercent ?? 0) ? window : worst,
		undefined,
	);
}
