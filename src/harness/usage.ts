/**
 * Normalized per-run token usage (issue #138) — the shape that crosses both
 * the agent-CLI stdout boundary and the `runs.usage` DB boundary, so it gets a
 * Zod schema (ai/CODING_STANDARDS.md "Zod is the source of truth"); the TS
 * type is inferred from it.
 *
 * Usage extraction is per-CLI (each CLI reports its own output shape, if any
 * — ai/RULES.md §6 "don't assume identical flag/output semantics"). All three
 * CLIs are implemented here: `claude` and `antigravity` each report a terminal
 * record on their own `--output-format stream-json` stream, and `codex` reports
 * a `turn.completed` event on its `--json` stream. Their shapes have nothing in
 * common beyond being NDJSON, so each gets its own decoder module.
 */

import { z } from 'zod';
import type { AgentCli } from './agent-cli.js';
import {
	antigravityErrorDetail,
	antigravityUsageFields,
	findAntigravityConversationId,
	findAntigravityResultEvent,
	formatAntigravityResultError,
	isAntigravityErrorResult,
} from './antigravity-stream.js';
import {
	errorDetail,
	findClaudeResultEvent,
	formatClaudeResultError,
	isClaudeErrorResult,
} from './claude-stream.js';

export const AgentUsageSchema = z.object({
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cacheReadTokens: z.number().int().nonnegative().optional(),
	cacheCreationTokens: z.number().int().nonnegative().optional(),
	reasoningTokens: z.number().int().nonnegative().optional(),
	totalTokens: z.number().int().nonnegative().optional(),
});
export type AgentUsage = z.infer<typeof AgentUsageSchema>;

const CodexUsageSchema = z.object({
	input_tokens: z.number(),
	output_tokens: z.number(),
	cached_input_tokens: z.number().optional(),
	reasoning_output_tokens: z.number().optional(),
});

function parseJsonLine(line: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function codexAgentMessage(event: Record<string, unknown>): string | undefined {
	if (event.type !== 'item.completed' || !event.item || typeof event.item !== 'object') {
		return undefined;
	}
	const item = event.item as Record<string, unknown>;
	return item.type === 'agent_message' && typeof item.text === 'string' ? item.text : undefined;
}

/**
 * The thread id a `thread.started` event names, or `undefined` for any other
 * event. `codex exec --json` emits `{"type":"thread.started","thread_id":"…"}`
 * as its first event; the thread id is what `codex exec resume <id>` takes to
 * continue the same session (verified live). A resume run re-emits the same id,
 * so reading it on every run keeps the row's session handle current.
 */
function codexThreadId(event: Record<string, unknown>): string | undefined {
	return event.type === 'thread.started' && typeof event.thread_id === 'string'
		? event.thread_id
		: undefined;
}

function collectCodexEvents(stdout: string): {
	rawUsage?: z.infer<typeof CodexUsageSchema>;
	messages: string[];
	sessionId?: string;
} {
	let rawUsage: z.infer<typeof CodexUsageSchema> | undefined;
	let sessionId: string | undefined;
	const messages: string[] = [];
	for (const line of stdout.split('\n')) {
		const event = parseJsonLine(line);
		if (!event) continue;
		sessionId = codexThreadId(event) ?? sessionId;
		if (event.type === 'turn.completed') {
			const parsedUsage = CodexUsageSchema.safeParse(event.usage);
			if (parsedUsage.success) rawUsage = parsedUsage.data;
		}
		const message = codexAgentMessage(event);
		if (message !== undefined) messages.push(message);
	}
	return { rawUsage, messages, sessionId };
}

export interface ParsedAgentOutput {
	/** Normalized token usage, or absent when the CLI's output couldn't be read. */
	usage?: AgentUsage;
	/**
	 * The human-readable text to keep as the run's log (unchanged from the
	 * plain-text stdout the log viewer showed before this feature). Absent
	 * means "keep whatever raw stdout the caller already captured".
	 */
	logText?: string;
	/**
	 * The CLI session/thread id recovered from this run's output, to resume it
	 * later. All three CLIs report one on stdout when running structured:
	 * `claude`'s `session_id`, `codex`'s `thread.started`, and Antigravity's
	 * `conversation_id`. Absent when the *captured* text carried none — an `agy`
	 * too old for `--output-format`, malformed output, a run killed before it got
	 * that far, or a truncated run whose opening event fell outside the retained
	 * window ({@link sessionIdFromLine} backs that last case off the live stream,
	 * and `./antigravity-session.ts` the rest).
	 */
	sessionId?: string;
	/**
	 * For Claude: structural terminal failure info if the run failed structurally
	 * (i.e. with a failed terminal `result` event).
	 */
	claudeFailure?: {
		subtype?: string;
		message?: string;
	};
	/**
	 * For Antigravity: the same signal from its own terminal `result` event — a
	 * `status` other than `SUCCESS`. Kept as a separate field rather than merged
	 * with {@link claudeFailure} because the two CLIs' failure vocabularies
	 * differ (a `subtype` versus a `status`) and classification trusts different
	 * tokens in each.
	 */
	antigravityFailure?: {
		status?: string;
		message?: string;
	};
}

/**
 * Parse `claude -p --output-format stream-json`'s stdout: newline-delimited
 * protocol events whose last `result` record carries the run's final text,
 * session id, and usage ({@link ./claude-stream.ts}). On any failure — no
 * terminal record, malformed lines, a stream cut off mid-record — returns `{}`
 * (usage unavailable, log text falls back to what the caller captured); a parse
 * failure must never turn a successful agent run into a failed one.
 *
 * A *failed* terminal record still yields `logText`: the readable error line,
 * so the reason a run died (a rate limit and its reset hint, an overloaded
 * model) survives into the stored log even when the stream around it was
 * truncated — that text is what failure classification reads.
 */
function parseClaudeOutput(stdout: string): ParsedAgentOutput {
	const event = findClaudeResultEvent(stdout);
	if (!event) return {};

	const isError = isClaudeErrorResult(event);
	const logText = isError
		? formatClaudeResultError(event)
		: event.result?.trim()
			? event.result
			: undefined;
	const sessionId = event.session_id;
	const base: ParsedAgentOutput = {
		...(logText === undefined ? {} : { logText }),
		...(sessionId === undefined ? {} : { sessionId }),
		...(isError
			? {
					claudeFailure: {
						subtype: event.subtype,
						message: [event.result, errorDetail(event.error)]
							.map((part) => part?.replace(/\s+/g, ' ').trim())
							.filter(Boolean)
							.join(' '),
					},
				}
			: {}),
	};
	if (!event.usage) return base;

	const usage = AgentUsageSchema.safeParse({
		inputTokens: event.usage.input_tokens,
		outputTokens: event.usage.output_tokens,
		cacheReadTokens: event.usage.cache_read_input_tokens,
		cacheCreationTokens: event.usage.cache_creation_input_tokens,
	});
	if (!usage.success) return base;

	return { usage: usage.data, ...base };
}

/**
 * Parse `agy --output-format stream-json`'s stdout: newline-delimited events
 * whose terminal `result` record carries the run's final text, conversation id,
 * status, and aggregate usage ({@link ./antigravity-stream.ts}).
 *
 * The conversation id is read separately from the result, because the two can
 * disagree: a *failed* run reports `conversation_id: ""` in its result while
 * the `init` event that opened the stream still names the real one.
 *
 * An `agy` predating `--output-format` prints plain text, which yields no
 * parseable events and so returns `{}` — the same graceful "usage unavailable"
 * result this path returned before, now reached by reading the output's shape
 * instead of by assuming the CLI can't produce one. Never throws: a parse miss
 * must never turn a successful agent run into a failed one.
 */
function parseAntigravityOutput(stdout: string): ParsedAgentOutput {
	const sessionId = findAntigravityConversationId(stdout);
	const result = findAntigravityResultEvent(stdout);
	if (!result) return sessionId === undefined ? {} : { sessionId };

	const isError = isAntigravityErrorResult(result);
	const logText = isError
		? formatAntigravityResultError(result)
		: result.response?.trim()
			? result.response
			: undefined;
	const base: ParsedAgentOutput = {
		...(logText === undefined ? {} : { logText }),
		...(sessionId === undefined ? {} : { sessionId }),
		...(isError
			? { antigravityFailure: { status: result.status, message: antigravityErrorDetail(result) } }
			: {}),
	};
	if (!result.usage) return base;

	const usage = AgentUsageSchema.safeParse(antigravityUsageFields(result.usage));
	if (!usage.success) return base;

	return { usage: usage.data, ...base };
}

/** Parse the JSONL event stream emitted by `codex exec --json`. */
function parseCodexOutput(stdout: string): ParsedAgentOutput {
	const { rawUsage, messages, sessionId } = collectCodexEvents(stdout);
	const logText = messages.length > 0 ? messages.join('\n') : undefined;
	const base = {
		...(logText === undefined ? {} : { logText }),
		...(sessionId === undefined ? {} : { sessionId }),
	};
	if (!rawUsage) return base;

	// Codex input_tokens includes cached input; preserve both reported values
	// independently rather than subtracting cached_input_tokens from the total.
	const usage = AgentUsageSchema.safeParse({
		inputTokens: rawUsage.input_tokens,
		outputTokens: rawUsage.output_tokens,
		cacheReadTokens: rawUsage.cached_input_tokens,
		reasoningTokens: rawUsage.reasoning_output_tokens,
	});
	if (!usage.success) return base;

	return { usage: usage.data, ...base };
}

/**
 * Parse a completed CLI run's captured stdout into normalized usage plus the
 * human-readable text to keep in the run log. Dispatches per `cli`.
 */
export function parseAgentOutput(cli: AgentCli, stdout: string): ParsedAgentOutput {
	switch (cli) {
		case 'claude':
			return parseClaudeOutput(stdout);
		case 'antigravity':
			return parseAntigravityOutput(stdout);
		case 'codex':
			return parseCodexOutput(stdout);
	}
}

/**
 * The session id a *single* raw stdout line names, or `undefined` when it names
 * none. Dispatches per `cli` and recognizes nothing itself: each CLI's event
 * shapes stay defined in its own decoder (ai/RULES.md §6), so this only routes.
 *
 * It exists because neither of the harness's capture buffers can be relied on
 * for the id of a CLI that mints its own: `codex` and `agy` announce it in their
 * *first* event, the head buffer stops growing the moment a chatty run floods
 * `maxOutputBytes`, and the rolling tail that survives such a run holds only its
 * *last* bytes — on a truncated run the two windows never overlap and the
 * opening event falls between them. The harness therefore sniffs each line as it
 * streams (`./agent-cli.ts`), the one window guaranteed to see every line
 * exactly once.
 *
 * `claude` is deliberately `undefined`: SWARM assigns its session id up front
 * with `--session-id` and the harness already falls back to it, so there is
 * nothing here to recover. An unparseable or non-matching line is `undefined`
 * too — never throws, on any CLI.
 */
export function sessionIdFromLine(cli: AgentCli, line: string): string | undefined {
	switch (cli) {
		case 'claude':
			return undefined;
		case 'antigravity':
			return findAntigravityConversationId(line);
		case 'codex': {
			const event = parseJsonLine(line);
			return event ? codexThreadId(event) : undefined;
		}
	}
}
