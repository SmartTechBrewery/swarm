/**
 * Agent-run failure classification — the reusable half of "detect a rate/usage
 * limit and retry the phase once quota is back" (issue #91).
 *
 * The harness ({@link ./agent-cli.ts}) treats a non-zero exit as a normal
 * resolved result and never inspects its output; every pipeline phase then turns
 * that into a generic `... exited with code N` error. That makes a transient
 * usage/session-limit hit — where the agent never got to do any work — look
 * identical to the agent running and producing something wrong, so the worker
 * fails the job terminally instead of waiting out the limit.
 *
 * This module is where the CLI-specific knowledge of *what a limit looks like*
 * lives, mirroring how {@link ./agent-cli.ts} owns the per-CLI flag quirks: it
 * reads an {@link AgentCliResult} and says whether the failure is a `rate-limit`
 * (retry later), a `timeout` (the harness killed it), an `auth` failure (the CLI
 * is logged out), or a plain `error`. For a rate-limit it also lifts the CLI's
 * own "resets …" hint out of the output and, best-effort, resolves it to an
 * absolute instant the worker can defer until.
 *
 * Not every recognised kind is a retry signal: `auth` (issue #343) is terminal
 * and classified purely so the run's headline says *why* — waiting cannot restore
 * a login, only a human re-running `/login` can.
 */

import type { Checkpoint } from '../pipeline/checkpoint.js';
import type { AgentCliResult } from './agent-cli.js';

/** Why an agent run failed, from the worker's point of view. */
export type AgentFailureKind =
	| 'rate-limit'
	| 'capacity'
	| 'auth'
	| 'timeout'
	| 'aborted'
	| 'stalled'
	| 'error'
	| 'worktree-exists'
	| 'blocked-recovery';

export interface AgentFailure {
	kind: AgentFailureKind;
	/**
	 * The CLI's verbatim "resets …" text (e.g. `1:40pm (Europe/Warsaw)`), kept
	 * for logs/PR comments even when {@link retryAfter} can't be resolved.
	 */
	resetHint?: string;
	/**
	 * Best-effort absolute instant the limit resets: the reset the CLI reported
	 * itself ({@link AgentCliResult.rateLimitResetAt}) when it has one, else
	 * parsed from {@link resetHint}. Undefined when neither is available — the
	 * hint carries no timezone, or can't be parsed — and the caller falls back to
	 * a default backoff.
	 */
	retryAfter?: Date;
}

/**
 * Error thrown by a pipeline phase when its agent run failed, carrying the
 * {@link AgentFailure} classification so the worker's consumer can tell a
 * transient rate-limit (defer + retry) apart from a terminal failure without
 * re-parsing a message string.
 */
export class AgentRunError extends Error {
	readonly failure: AgentFailure;
	/**
	 * The failed run's captured result (stdout/stderr, exit code, timing), so the
	 * worker can persist a failed run's output without re-parsing the message.
	 * Optional because the ~10 synthetic `new AgentRunError(msg, failure)` throws
	 * in tests don't have one; in production the error is only ever built via
	 * {@link agentRunError}, which always forwards the `result` it classified, so
	 * `.agent` is populated for every real failure.
	 */
	readonly agent?: AgentCliResult;
	/**
	 * The Tier 2 checkpoint (`docs/CHECKPOINTS.md`) the stopped run left in its
	 * worktree, when that worktree is somewhere the process handling this error
	 * cannot read it: a federated worker parses the file itself and reports it in its
	 * deferral frame (`../transport/protocol.ts`), and the control plane rebuilds the
	 * error with it here. The in-process worker leaves it unset and reads the file
	 * from the checkout it owns — see `deferAgentRunError` (`../worker/consumer.ts`),
	 * which treats the two sources identically from there on.
	 */
	readonly checkpoint?: Checkpoint;
	constructor(
		message: string,
		failure: AgentFailure,
		agent?: AgentCliResult,
		checkpoint?: Checkpoint,
	) {
		super(message);
		this.name = 'AgentRunError';
		this.failure = failure;
		this.agent = agent;
		this.checkpoint = checkpoint;
	}
}

// The distinctive shapes of an agent CLI's own usage/session-limit banner. Kept
// deliberately tight: an ordinary failed run whose output merely *discusses*
// rate limiting (say, a review of code about it) must not be misread as the CLI
// itself being limited. Only the literal "you've hit your … limit" phrasing
// stands on its own; the softer signals — a bare "usage limit" mention, or an
// HTTP `429`/"too many requests" — fire only when a "resets …" line co-occurs.
// Classification only trusts the terminal output window, and the softer
// signals retain this co-occurrence gate as an additional guard against CI logs
// or reviewed code that discusses HTTP 429 handling.
const LIMIT_BANNER_RE = /(?:you've|you have)\s+hit\s+your\s+(?:session|usage|rate)\s+limit/i;
const USAGE_LIMIT_RE = /\b(?:session|usage|rate)[\s-]?limit\b/i;
const RATE_HTTP_RE = /\b(?:429|too many requests)\b/i;
const RESET_RE = /resets?\s+([^\n]+)/i;
// Codex reports selected-model saturation separately from account quota.
const CODEX_CAPACITY_RE = /selected model is at capacity/i;
// Claude / Claude Code surface Anthropic's transient 529 overload — a documented
// temporary-capacity response (platform.claude.com/docs/en/api/errors §529) — as
// an `API Error: 529 Overloaded` banner, or with the raw `overloaded_error` type
// from the JSON error body; Claude Code's retry path prints one such line per
// attempt before giving up (code.claude.com/docs/en/errors). All forms name
// "overloaded", so we anchor on that word — a `529` immediately paired with
// "overloaded", or the literal `overloaded_error` type token — never a bare 529,
// which reviewed code, tool output, or an unrelated log can mention innocuously.
const CLAUDE_CAPACITY_RE = /\b529\s+overloaded\b|\boverloaded_error\b/i;
// The distinctive, CLI-owned forms of an agent CLI's "you are not authenticated"
// banner (issue #343). These are matched only in the terminal output window.
// Broad prose such as "not logged in", "invalid API key", and "failed to
// authenticate" is deliberately excluded: a review or CI log can use those
// phrases without the agent CLI itself being logged out. The real observed
// banners remain covered by their `/login`, OAuth-session, or
// `authentication_error` marker. Like a login banner, they are provider-generic
// rather than tied to a particular CLI.
const AUTH_BANNER_RE =
	/\brun \/login\b|\boauth session expired\b|\bsession expired and could not be refreshed\b|\bauthentication_error\b/i;
// Claude's terminal `result` stream event is rendered as a single
// `Claude run failed (…)` line ({@link ./claude-stream.ts}). That line is a
// structural signal — it exists only because the CLI itself reported the run
// as failed — so a 429/`rate_limit_error` inside it is trusted on its own,
// without the "resets …" co-occurrence the softer free-text signals need.
const CLAUDE_RATE_LIMIT_ERROR_RE = /\b429\b|\brate_limit_error\b/i;
// agy's terminal `result` event reports its own `status`, rendered as a single
// `Antigravity run failed (…)` line ({@link ./antigravity-stream.ts}). Like
// Claude's, that line is structural — it exists only because the CLI itself
// reported the run as failed — so a quota signal inside it is trusted without
// the "resets …" co-occurrence free text needs. agy's exact quota wording is
// *unverified* (only `status:"ERROR"` from a bad `--model` was observed live),
// so the token set stays narrow and structural-only: a miss degrades to
// `error`, a terminal failure, never to a false rate-limit defer.
const ANTIGRAVITY_RATE_LIMIT_ERROR_RE = /\b429\b|\brate_limit\w*\b|\bresource_exhausted\b/i;
// Unstructured provider errors are terminal output; borrowed task/code/CI text
// lives earlier in the transcript. Fifteen non-empty lines comfortably contain
// real banners while keeping those unrelated body matches out of classification.
// Codex's machine-readable error events are an exception: their explicit shape
// lets us safely recognise a capacity failure anywhere in the transcript.
const TERMINAL_TAIL_LINES = 15;
// A clock time optionally followed by a parenthesised IANA timezone, e.g.
// `1:40pm (Europe/Warsaw)` or `13:40 (Europe/Warsaw)`.
const RESET_TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:[^\n(]*\(([^)]+)\))?/i;

function terminalTail(output: string): string {
	return output
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-TERMINAL_TAIL_LINES)
		.join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Codex emits newline-delimited JSON events. Unlike a human-readable capacity
 * banner, these records remain trustworthy even when later stream messages
 * push them out of the terminal-output window.
 */
function hasCodexCapacityEvent(output: string): boolean {
	return output.split('\n').some((line) => {
		try {
			const event = asRecord(JSON.parse(line));
			if (!event) return false;

			if (event.type === 'error') return CODEX_CAPACITY_RE.test(String(event.message ?? ''));
			if (event.type !== 'turn.failed') return false;

			const error = asRecord(event.error);
			return CODEX_CAPACITY_RE.test(String(error?.message ?? ''));
		} catch {
			return false;
		}
	});
}

/** Compute a timezone's UTC offset (ms) at a given instant via the Intl trick. */
function tzOffsetMs(instant: Date, timeZone: string): number {
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
	const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
	const asUtc = Date.UTC(
		get('year'),
		get('month') - 1,
		get('day'),
		get('hour'),
		get('minute'),
		get('second'),
	);
	return asUtc - instant.getTime();
}

/** The UTC instant whose wall-clock reading in `timeZone` is the given Y-M-D H:M. */
function zonedWallTimeToUtc(
	year: number,
	month1: number,
	day: number,
	hour24: number,
	minute: number,
	timeZone: string,
): Date {
	const naiveUtc = Date.UTC(year, month1 - 1, day, hour24, minute, 0);
	return new Date(naiveUtc - tzOffsetMs(new Date(naiveUtc), timeZone));
}

/**
 * Resolve a "resets …" hint like `1:40pm (Europe/Warsaw)` to the next instant
 * that wall-clock time occurs in that timezone, relative to `now`. Returns
 * undefined if the hint lacks a timezone or anything fails to parse — the reset
 * time is unknowable without the zone, and a wrong guess is worse than a
 * default backoff. Never throws (an invalid timezone makes Intl throw).
 */
function parseRetryAfter(hint: string, now: Date): Date | undefined {
	try {
		const match = RESET_TIME_RE.exec(hint);
		if (!match) return undefined;
		const [, rawHour, rawMinute, meridiem, timeZone] = match;
		if (!timeZone) return undefined;

		let hour = Number(rawHour);
		const minute = rawMinute ? Number(rawMinute) : 0;
		if (meridiem) {
			const pm = meridiem.toLowerCase() === 'pm';
			if (hour === 12) hour = pm ? 12 : 0;
			else if (pm) hour += 12;
		}
		if (hour > 23 || minute > 59) return undefined;

		// Today's date *in the target zone* — the reset time is a wall clock there.
		const dateParts = new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).formatToParts(now);
		const get = (type: string): number => Number(dateParts.find((p) => p.type === type)?.value);
		let target = zonedWallTimeToUtc(get('year'), get('month'), get('day'), hour, minute, timeZone);
		// A reset that already passed today means the next occurrence is tomorrow.
		// Adding a fixed 24h (rather than re-deriving tomorrow's wall time) can skew
		// the instant by an hour across a DST boundary — harmless here: the reset is
		// only a hint, and the consumer buffers + clamps the delay to [6min, 6h].
		if (target.getTime() <= now.getTime()) {
			target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
		}
		return target;
	} catch {
		return undefined;
	}
}

/**
 * Classify a failed agent run. `now` is injectable so the reset-time parse is
 * deterministic under test. A timed-out run is a `timeout` regardless of what it
 * printed (the harness killing it is the authoritative cause); next, a run the
 * harness's `signal` cancelled is `aborted` — this is the worker's own
 * shutdown (e.g. a dev `--watch` restart, or a graceful SIGTERM/SIGINT)
 * deliberately killing an in-flight run, not the agent failing on its own, and
 * it must be checked before scanning output: an aborted run's stdout/stderr is
 * typically empty or cut off mid-line, so there is nothing meaningful to scan
 * anyway (confirmed live: a `claude` run killed this way exited 143 with empty
 * output and `signal: null`, since it trapped SIGTERM and called `process.exit`
 * itself rather than being torn down by the OS — {@link AgentCliResult.aborted}
 * exists precisely because `result.signal` can't be trusted to reflect this).
 * Next, a provider-capacity error is `capacity`, matched per CLI so one CLI's
 * provider error can't be triggered by another CLI merely quoting or discussing
 * the text: Codex's structured `error` / `turn.failed` events anywhere in its
 * output, or its terminal `selected model is at capacity` banner; and Claude's
 * terminal `529 Overloaded` / `overloaded_error` banner. A recognisable terminal
 * limit banner is then a `rate-limit` — as is a quota signal reported by a CLI's
 * own structural terminal failure record (Claude's failed `result` event, or
 * Antigravity's non-`SUCCESS` `status`), which needs no reset hint to be trusted.
 * Then a CLI's own "not authenticated" banner is `auth` — recognised for its
 * message, not to retry, and checked before the trailing stall marker so an
 * unauthenticated run cannot be deferred and resumed onto a login only a human
 * can restore. Otherwise a stalled run is classified as `stalled`, and
 * everything else is a plain `error`.
 */
export function classifyAgentFailure(result: AgentCliResult, now: Date = new Date()): AgentFailure {
	if (result.timedOut) return { kind: 'timeout' };
	if (result.aborted) return { kind: 'aborted' };

	const output = `${result.stdout}\n${result.stderr}`;
	const trimmed = output.trim();

	const tail = terminalTail(output);
	if (
		result.cli === 'codex' &&
		(hasCodexCapacityEvent(result.rawStdout ?? output) || CODEX_CAPACITY_RE.test(tail))
	)
		return { kind: 'capacity' };
	if (result.cli === 'claude' && CLAUDE_CAPACITY_RE.test(tail)) return { kind: 'capacity' };

	const hasClaudeRateLimit =
		result.cli === 'claude' &&
		result.claudeFailure !== undefined &&
		(CLAUDE_RATE_LIMIT_ERROR_RE.test(result.claudeFailure.subtype ?? '') ||
			CLAUDE_RATE_LIMIT_ERROR_RE.test(result.claudeFailure.message ?? ''));
	const hasAntigravityRateLimit =
		result.cli === 'antigravity' &&
		result.antigravityFailure !== undefined &&
		(ANTIGRAVITY_RATE_LIMIT_ERROR_RE.test(result.antigravityFailure.status ?? '') ||
			ANTIGRAVITY_RATE_LIMIT_ERROR_RE.test(result.antigravityFailure.message ?? ''));
	const resetMatch = RESET_RE.exec(tail);
	const isRateLimited =
		LIMIT_BANNER_RE.test(tail) ||
		hasClaudeRateLimit ||
		hasAntigravityRateLimit ||
		((USAGE_LIMIT_RE.test(tail) || RATE_HTTP_RE.test(tail)) && resetMatch !== null);

	if (isRateLimited) {
		const resetHint = resetMatch?.[1]?.trim() || undefined;
		return {
			kind: 'rate-limit',
			resetHint,
			// The CLI's own reported reset instant wins over the parsed hint: it is
			// exact, where a hint without a timezone can't be resolved at all.
			retryAfter:
				result.rateLimitResetAt ?? (resetHint ? parseRetryAfter(resetHint, now) : undefined),
		};
	}

	// An unauthenticated CLI is terminal, not transient: no amount of waiting
	// restores a login, so this is recognised for the headline's sake rather than
	// to retry. Rate-limit signals return above because a structural quota result
	// or terminal limit banner is more specific; auth still outranks the generic
	// trailing stall marker below. `timedOut`/`aborted` still win above both.
	if (AUTH_BANNER_RE.test(tail)) return { kind: 'auth' };

	// The CLI's own give-up-waiting phrasing (matched case-insensitively). Checked
	// after timeout/abort and recognised provider conditions, so a trailing stall
	// marker cannot hide a rate-limit or capacity banner. We match narrowly: only
	// when the phrase is the entire output or its trailing line, to avoid false
	// positives from borrowed text (e.g. CI logs in respond-to-ci).
	if (/timeout waiting for response$/i.test(trimmed)) return { kind: 'stalled' };

	return { kind: 'error' };
}

/**
 * The reason marker each recognised kind splices into the phase's message. A
 * kind absent from the table (a plain `error`, or a non-agent kind like
 * `worktree-exists`) leaves the stem as the phase built it.
 */
const FAILURE_REASONS: Partial<Record<AgentFailureKind, string>> = {
	timeout: ' (timed out)',
	'rate-limit': ' (rate limited)',
	capacity: ' (model at capacity)',
	aborted: ' (aborted)',
	stalled: ' (stalled)',
	auth: ' (authentication failed)',
};

/**
 * Build the {@link AgentRunError} a pipeline phase throws on a non-zero exit.
 * `prefix` is the phase-specific stem (`Review agent (claude) exited with code
 * 1`) and `tail` its suffix (` for PR #90`); this splices in a reason marker so
 * the message reads `… exited with code 1 (rate limited) for PR #90`, and
 * attaches the classification for the consumer to act on.
 */
export function agentRunError(
	result: AgentCliResult,
	prefix: string,
	tail = '',
	now: Date = new Date(),
): AgentRunError {
	const failure = classifyAgentFailure(result, now);
	const reason = FAILURE_REASONS[failure.kind] ?? '';
	return new AgentRunError(`${prefix}${reason}${tail}`, failure, result);
}
