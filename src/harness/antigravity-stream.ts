/**
 * Antigravity's `--output-format stream-json` protocol — decoded into the
 * readable lines SWARM shows as live run output, plus the terminal `result`
 * record the harness reads a run's final text, conversation id, usage, and
 * status from.
 *
 * `agy` also offers `--output-format json`, but that is defined as a single
 * final document buffered until the process exits — the exact failure mode
 * issue #356 fixed for `claude`, where a long run's live log stayed empty for
 * its whole duration. Streaming mode emits one NDJSON record per event, so
 * progress reaches the run page while the agent is still working.
 *
 * **This is not Claude's stream-json despite the matching flag name**
 * (ai/RULES.md §6). The shapes below are what `agy` 1.1.10 actually printed,
 * verified live on the dev host:
 *
 *   {"event":"init","conversation_id":"…","init":{"cwd":"…","tools":[…]}}
 *   {"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE",
 *      "step_type":"agent_response","text_delta":"STREAM_OK"}}
 *   {"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE",
 *      "step_type":"tool","tool_name":"view_file","tool_info":{…}}}
 *   {"event":"result","result":{"conversation_id":"…","status":"SUCCESS",
 *      "response":"STREAM_OK\n","usage":{"input_tokens":18267,…}}}
 *
 * Two differences from Claude's protocol drive this module's shape:
 *  - agy streams **deltas** (`text_delta`), not whole text blocks, so the
 *    normalizer accumulates and emits only *complete* lines. Forwarding each
 *    delta as its own line would write one `run_output_events` row per few
 *    tokens (`src/worker/live-output.ts` appends per line) — thousands of rows
 *    and an unreadable viewer.
 *  - a *failed* run reports its detail in `result.error`, leaves `response`
 *    empty, and reports `conversation_id` as the empty string (verified live
 *    with a bogus `--model`: `status:"ERROR"`, exit code 1).
 *
 * Only the fields SWARM consumes are modelled (ai/CODING_STANDARDS.md "Zod is
 * the source of truth"); unknown events and unknown fields are ignored so a
 * newer `agy` extending the protocol degrades to "less detail", never to a
 * broken decoder. Tool *parameters* and tool *output* are deliberately never
 * rendered — `tool_info` was observed carrying file paths and command output,
 * which must not reach the run page; only the tool's name and outcome are.
 */

import { z } from 'zod';

/**
 * Prefix of the single line a failed terminal `result` event is rendered as.
 * Load-bearing: failure classification (`./agent-failure.ts`) treats a line
 * with this prefix as a structural error signal rather than as free text an
 * agent might merely be quoting.
 */
export const ANTIGRAVITY_ERROR_PREFIX = 'Antigravity run failed';

/** The `status` value of a run that completed normally. */
const SUCCESS_STATUS = 'SUCCESS';

/** Cap on the rendered detail of a terminal error, so one line stays one line. */
const MAX_ERROR_DETAIL_CHARS = 2_000;

/**
 * Cap on unflushed streamed text held between events. Unlike Claude's decoder —
 * which is fed already-complete lines by the harness's own capped line splitter
 * — this one accumulates deltas across events, so text that never contains a
 * newline would otherwise grow without bound. On overflow the buffer is emitted
 * as-is: the reader sees the text, just split at an arbitrary point.
 */
const MAX_PENDING_TEXT_CHARS = 100_000;

/**
 * Token counts as `agy` reports them. `input_tokens`/`output_tokens` were
 * present on every observed record; the rest are optional so a build that drops
 * one still yields usage instead of none.
 */
const AntigravityUsageSchema = z.object({
	input_tokens: z.number(),
	output_tokens: z.number(),
	thinking_tokens: z.number().optional(),
	cache_read_tokens: z.number().optional(),
	total_tokens: z.number().optional(),
});

/**
 * The terminal `result` record — the last event of a stream, and the only one
 * carrying the run's final text, conversation id, aggregate usage, and status.
 * Everything inside `result` is optional: a failed run reports the same
 * envelope with an empty `response`/`conversation_id` and its detail in
 * `error`.
 */
const AntigravityResultEventSchema = z.object({
	event: z.literal('result'),
	result: z.object({
		conversation_id: z.string().optional(),
		status: z.string().optional(),
		response: z.string().optional(),
		error: z.string().optional(),
		usage: AntigravityUsageSchema.optional(),
	}),
});
export type AntigravityResultEvent = z.infer<typeof AntigravityResultEventSchema>;
export type AntigravityResult = AntigravityResultEvent['result'];

/** The opening record, and the earliest place the conversation id appears. */
const AntigravityInitEventSchema = z.object({
	event: z.literal('init'),
	conversation_id: z.string().optional(),
});

/**
 * A progress record. `text_delta` is a fragment of the agent's response, not a
 * whole message; `tool_name` names an in-flight tool (its `tool_info` payload
 * is deliberately unmodelled — see the module header).
 */
const AntigravityStepUpdateEventSchema = z.object({
	event: z.literal('step_update'),
	step_update: z.object({
		conversation_id: z.string().optional(),
		step_index: z.number().optional(),
		state: z.string().optional(),
		step_type: z.string().optional(),
		text_delta: z.string().optional(),
		tool_name: z.string().optional(),
	}),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Parse one NDJSON line, or undefined when it isn't a JSON object. */
function parseEvent(line: string): Record<string, unknown> | undefined {
	try {
		return asRecord(JSON.parse(line));
	} catch {
		return undefined;
	}
}

/**
 * True when a terminal `result` event reports a failed run. A **missing**
 * status is not a failure: mirroring `isClaudeErrorResult`, a future shape
 * change must degrade to "less detail", never turn healthy runs into failed
 * ones. Observed values: `SUCCESS` and `ERROR`.
 */
export function isAntigravityErrorResult(result: AntigravityResult): boolean {
	return result.status !== undefined && result.status.trim().toUpperCase() !== SUCCESS_STATUS;
}

/** The textual signals a failed result carries, collapsed onto one line. */
export function antigravityErrorDetail(result: AntigravityResult): string {
	return [result.error, result.response]
		.map((part) => part?.replace(/\s+/g, ' ').trim())
		.filter(Boolean)
		.join(' ')
		.slice(0, MAX_ERROR_DETAIL_CHARS);
}

/**
 * Render a failed terminal `result` event as exactly one line. It carries every
 * textual signal the event had (its status, its `error` detail, whatever
 * `response` text it managed), because that text is what tells a rate limit, a
 * bad model selection, and an ordinary failure apart downstream
 * (`./agent-failure.ts`).
 */
export function formatAntigravityResultError(result: AntigravityResult): string {
	const status = result.status?.trim() || 'error';
	return `${ANTIGRAVITY_ERROR_PREFIX} (${status}): ${antigravityErrorDetail(result) || 'no detail reported'}`;
}

/**
 * The terminal `result` record of a captured stream, or undefined when the run
 * never produced one (killed, timed out, or its record fell outside the
 * retained window). Scans line by line and ignores anything unparseable, so a
 * capture that starts mid-record — the rolling tail the harness keeps when a
 * chatty run floods its head buffer — still yields the record it contains.
 */
export function findAntigravityResultEvent(stdout: string): AntigravityResult | undefined {
	let found: AntigravityResult | undefined;
	for (const line of stdout.split('\n')) {
		const event = parseEvent(line);
		if (!event || event.event !== 'result') continue;
		const parsed = AntigravityResultEventSchema.safeParse(event);
		if (parsed.success) found = parsed.data.result;
	}
	return found;
}

/**
 * The conversation id this run used — the value `agy --conversation <id>` takes
 * to resume it. Read from the *first* record that names a non-empty one: `init`
 * carries it before any work happens, but a rolling tail that lost the opening
 * line still recovers it from a `step_update` or from the terminal `result`.
 *
 * The empty-string guard is load-bearing rather than defensive: a failed run
 * reports `conversation_id: ""` (verified live), and storing that as a session
 * handle would make a later resume attempt pass `--conversation ""`.
 */
export function findAntigravityConversationId(stdout: string): string | undefined {
	for (const line of stdout.split('\n')) {
		const event = parseEvent(line);
		if (!event) continue;
		const id =
			AntigravityInitEventSchema.safeParse(event).data?.conversation_id ??
			AntigravityStepUpdateEventSchema.safeParse(event).data?.step_update.conversation_id ??
			AntigravityResultEventSchema.safeParse(event).data?.result.conversation_id;
		if (id) return id;
	}
	return undefined;
}

export interface AntigravityStreamNormalizer {
	/**
	 * Readable display lines for one raw stdout line — zero for protocol records
	 * SWARM doesn't surface (init, non-textual steps, unknown events), and zero
	 * for a text delta that hasn't completed a line yet.
	 */
	translate(line: string): string[];
}

/**
 * Stateful decoder for one run's stream. It holds three things across events:
 * the partial line still being streamed, the text of the step currently
 * streaming (so a successful terminal `result` — which repeats it — isn't shown
 * twice), and which step that text belongs to.
 */
export function createAntigravityStreamNormalizer(): AntigravityStreamNormalizer {
	let pending = '';
	let stepText = '';
	let textStepIndex: number | undefined;
	let sawTextDelta = false;

	/** Emit whatever complete lines `pending` now holds, keeping the remainder. */
	const takeCompleteLines = (): string[] => {
		const lines: string[] = [];
		let idx = pending.indexOf('\n');
		while (idx !== -1) {
			const line = pending.slice(0, idx).trimEnd();
			if (line) lines.push(line);
			pending = pending.slice(idx + 1);
			idx = pending.indexOf('\n');
		}
		if (pending.length > MAX_PENDING_TEXT_CHARS) {
			lines.push(pending);
			pending = '';
		}
		return lines;
	};

	/** Emit the unterminated remainder — a step finished, so it's a whole line. */
	const flushPending = (): string[] => {
		const line = pending.trimEnd();
		pending = '';
		return line ? [line] : [];
	};

	const stepLines = (event: Record<string, unknown>): string[] => {
		const parsed = AntigravityStepUpdateEventSchema.safeParse(event);
		if (!parsed.success) return [];
		const step = parsed.data.step_update;
		const lines: string[] = [];

		if (typeof step.text_delta === 'string' && step.step_type === 'agent_response') {
			// A delta belonging to a new step ends the previous one's text; only the
			// most recent step's text is compared against the terminal `response`.
			if (step.step_index !== textStepIndex) {
				lines.push(...flushPending());
				stepText = '';
				textStepIndex = step.step_index;
			}
			sawTextDelta = true;
			stepText += step.text_delta;
			pending += step.text_delta;
			lines.push(...takeCompleteLines());
		}

		// A tool's name and outcome are reported; its `tool_info` payload never is.
		// Any in-flight text is flushed first so the log keeps its real ordering.
		if (step.step_type === 'tool' && step.tool_name) {
			lines.push(...flushPending());
			if (step.state === 'ACTIVE') lines.push(`Tool started: ${step.tool_name}`);
			else if (step.state === 'DONE') lines.push(`Tool completed: ${step.tool_name}`);
			return lines;
		}

		// A finished step's text is complete even without a trailing newline.
		if (step.state === 'DONE') lines.push(...flushPending());
		return lines;
	};

	const resultLines = (event: Record<string, unknown>): string[] => {
		const parsed = AntigravityResultEventSchema.safeParse(event);
		if (!parsed.success) return [];
		const result = parsed.data.result;
		const lines = flushPending();
		if (isAntigravityErrorResult(result)) return [...lines, formatAntigravityResultError(result)];
		const text = result.response?.trim();
		// Suppress the echo only when this run actually streamed the same text;
		// a run whose deltas never arrived must still get its answer logged.
		if (!text || (sawTextDelta && text === stepText.trim())) return lines;
		return [
			...lines,
			...text
				.split('\n')
				.map((line) => line.trimEnd())
				.filter(Boolean),
		];
	};

	return {
		translate(raw: string): string[] {
			const line = raw.trim();
			if (!line) return [];
			const event = parseEvent(line);
			if (!event) {
				// Plain text on stdout is a CLI message printed outside the protocol (a
				// startup or auth failure, or the `timeout waiting for response` line
				// failure classification keys its `stalled` verdict off) and is kept
				// verbatim. A JSON-shaped line that didn't parse is a truncated or
				// oversized protocol record — dropped, so no raw protocol fragment ever
				// reaches the run page.
				return line.startsWith('{') || line.startsWith('[') ? [] : [line];
			}
			switch (event.event) {
				case 'step_update':
					return stepLines(event);
				case 'result':
					return resultLines(event);
				// `init` carries only the cwd and the tool inventory — nothing a reader
				// needs, and the id is extracted structurally elsewhere.
				default:
					return [];
			}
		},
	};
}

/** Normalize `agy`'s reported usage into the shared cross-CLI shape's fields. */
export function antigravityUsageFields(
	usage: z.infer<typeof AntigravityUsageSchema>,
): Record<string, number | undefined> {
	// Every value is kept exactly as reported — never derive one by subtracting
	// another (the same rule the codex path follows).
	return {
		inputTokens: usage.input_tokens,
		outputTokens: usage.output_tokens,
		reasoningTokens: usage.thinking_tokens,
		cacheReadTokens: usage.cache_read_tokens,
		totalTokens: usage.total_tokens,
	};
}
