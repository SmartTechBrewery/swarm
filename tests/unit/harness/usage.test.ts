import { describe, expect, it } from 'vitest';
import { parseAgentOutput, selfTimeoutFromLine, sessionIdFromLine } from '@/harness/usage.js';
import {
	CODEX_USAGE_LIMIT_ERROR_LINE,
	CODEX_USAGE_LIMIT_LOG_TEXT,
	CODEX_USAGE_LIMIT_MESSAGE,
	CODEX_USAGE_LIMIT_TRANSCRIPT,
	CODEX_USAGE_LIMIT_TURN_FAILED_LINE,
} from '../../helpers/codex-usage-limit.js';

/** One `claude -p --output-format stream-json` transcript. */
const claudeStream = (...events: unknown[]): string =>
	`${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const claudeInit = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'opus' };
const claudeText = (text: string) => ({
	type: 'assistant',
	message: { role: 'assistant', content: [{ type: 'text', text }] },
});

/** One `agy --output-format stream-json` transcript. */
const agyStream = (...events: unknown[]): string =>
	`${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const agyInit = (conversationId: string) => ({
	event: 'init',
	conversation_id: conversationId,
	init: { cwd: '/scratch', tools: ['view_file'] },
});

describe('parseAgentOutput', () => {
	describe('claude', () => {
		it('normalizes a full usage block and extracts the readable result text', () => {
			const stdout = claudeStream(claudeInit, claudeText('Here is the final answer.'), {
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: 'Here is the final answer.',
				usage: {
					input_tokens: 1234,
					output_tokens: 567,
					cache_read_input_tokens: 89,
					cache_creation_input_tokens: 10,
				},
			});

			expect(parseAgentOutput('claude', stdout)).toEqual({
				usage: {
					inputTokens: 1234,
					outputTokens: 567,
					cacheReadTokens: 89,
					cacheCreationTokens: 10,
				},
				logText: 'Here is the final answer.',
			});
		});

		it('validates with only input/output tokens, leaving optional fields absent', () => {
			const stdout = claudeStream({
				type: 'result',
				subtype: 'success',
				result: 'done',
				usage: { input_tokens: 10, output_tokens: 5 },
			});

			expect(parseAgentOutput('claude', stdout)).toEqual({
				usage: { inputTokens: 10, outputTokens: 5 },
				logText: 'done',
			});
		});

		it('captures session_id from the terminal result event as sessionId', () => {
			const stdout = claudeStream({
				type: 'result',
				subtype: 'success',
				result: 'done',
				session_id: '11111111-2222-3333-4444-555555555555',
				usage: { input_tokens: 10, output_tokens: 5 },
			});
			expect(parseAgentOutput('claude', stdout).sessionId).toBe(
				'11111111-2222-3333-4444-555555555555',
			);
		});

		it('keeps the readable text when the terminal event reports no usage', () => {
			const stdout = claudeStream({
				type: 'result',
				subtype: 'success',
				result: 'done, no usage reported',
			});
			expect(parseAgentOutput('claude', stdout)).toEqual({ logText: 'done, no usage reported' });
		});

		it('renders a failed terminal event as the log text, keeping usage and session', () => {
			const stdout = claudeStream(claudeText('Working on it.'), {
				type: 'result',
				subtype: 'error_during_execution',
				is_error: true,
				result: 'API Error: 429 rate limit; resets 1:40pm (Europe/Warsaw)',
				session_id: 'sess-9',
				usage: { input_tokens: 10, output_tokens: 5 },
			});

			expect(parseAgentOutput('claude', stdout)).toEqual({
				usage: { inputTokens: 10, outputTokens: 5 },
				logText:
					'Claude run failed (error_during_execution): API Error: 429 rate limit; resets 1:40pm (Europe/Warsaw)',
				sessionId: 'sess-9',
				claudeFailure: {
					subtype: 'error_during_execution',
					message: 'API Error: 429 rate limit; resets 1:40pm (Europe/Warsaw)',
				},
			});
		});

		it('skips malformed and unknown stream lines without losing the terminal event', () => {
			const stdout = [
				'not json at all',
				'{"type":"assistant","message":{"content":[{"type":"text"',
				JSON.stringify({ type: 'stream_event', event: { type: 'ping' } }),
				JSON.stringify({
					type: 'result',
					subtype: 'success',
					result: 'done',
					usage: { input_tokens: 1, output_tokens: 2 },
				}),
			].join('\n');

			expect(parseAgentOutput('claude', stdout)).toEqual({
				usage: { inputTokens: 1, outputTokens: 2 },
				logText: 'done',
			});
		});

		it('parses a bounded tail that starts mid-record but still holds the terminal event', () => {
			const full = claudeStream(claudeText('hello'), {
				type: 'result',
				subtype: 'success',
				result: 'done',
				usage: { input_tokens: 1, output_tokens: 2 },
			});
			// The rolling tail the harness keeps begins wherever the byte budget fell.
			expect(parseAgentOutput('claude', full.slice(20))).toEqual({
				usage: { inputTokens: 1, outputTokens: 2 },
				logText: 'done',
			});
		});

		it('returns {} when the stream carries no terminal result event', () => {
			expect(parseAgentOutput('claude', claudeStream(claudeInit, claudeText('hi')))).toEqual({});
		});

		it('returns {} for a truncated terminal event', () => {
			const truncated = JSON.stringify({
				type: 'result',
				result: 'partial',
				usage: { input_tokens: 1, output_tokens: 2 },
			}).slice(0, 20);

			expect(parseAgentOutput('claude', truncated)).toEqual({});
		});
	});

	describe('codex', () => {
		it('normalizes the captured JSONL usage event and extracts readable text', () => {
			const stdout = [
				'{"type":"thread.started","thread_id":"019f4f7e-..."}',
				'{"type":"turn.started"}',
				'{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}',
				'{"type":"turn.completed","usage":{"input_tokens":12201,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}',
			].join('\n');

			expect(parseAgentOutput('codex', stdout)).toEqual({
				usage: {
					inputTokens: 12201,
					outputTokens: 5,
					cacheReadTokens: 9984,
					reasoningTokens: 0,
				},
				logText: 'pong',
				sessionId: '019f4f7e-...',
			});
		});

		it('captures the thread id from the thread.started event as sessionId', () => {
			const stdout = [
				'{"type":"thread.started","thread_id":"019f57a7-cf1b-72d3-b887-63758a10f3a8"}',
				'{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}',
			].join('\n');
			expect(parseAgentOutput('codex', stdout).sessionId).toBe(
				'019f57a7-cf1b-72d3-b887-63758a10f3a8',
			);
		});

		it('accepts input/output-only usage', () => {
			const stdout = '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}';
			expect(parseAgentOutput('codex', stdout)).toEqual({
				usage: { inputTokens: 10, outputTokens: 5 },
			});
		});

		it('keeps readable text when usage is missing', () => {
			const stdout = '{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}';
			expect(parseAgentOutput('codex', stdout)).toEqual({ logText: 'pong' });
		});

		it('skips malformed and truncated JSONL without throwing', () => {
			expect(parseAgentOutput('codex', 'not json\n{"type":"turn.completed"')).toEqual({});
		});

		it('uses the last valid turn usage and joins agent messages', () => {
			const stdout = [
				'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
				'{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
				'{"type":"item.completed","item":{"type":"agent_message","text":"second"}}',
				'{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}',
			].join('\n');

			expect(parseAgentOutput('codex', stdout)).toEqual({
				usage: { inputTokens: 3, outputTokens: 4 },
				logText: 'first\nsecond',
			});
		});

		// Codex's terminal failure record is dropped from `logText` (only
		// `agent_message` items survive), so it is carried separately for failure
		// classification — issue #963, where a quota hit read as a terminal error.
		it('reports a top-level error event as codexFailure', () => {
			expect(parseAgentOutput('codex', CODEX_USAGE_LIMIT_ERROR_LINE).codexFailure).toEqual({
				message: CODEX_USAGE_LIMIT_MESSAGE,
			});
		});

		it('reports a turn.failed event as codexFailure on its own', () => {
			expect(parseAgentOutput('codex', CODEX_USAGE_LIMIT_TURN_FAILED_LINE).codexFailure).toEqual({
				message: CODEX_USAGE_LIMIT_MESSAGE,
			});
		});

		it('keeps the captured quota failure while logText stays the agent messages', () => {
			// The regression pin: the observed run's banner must survive the same
			// parse that discards it from the log.
			expect(parseAgentOutput('codex', CODEX_USAGE_LIMIT_TRANSCRIPT)).toEqual({
				logText: CODEX_USAGE_LIMIT_LOG_TEXT,
				codexFailure: { message: CODEX_USAGE_LIMIT_MESSAGE },
			});
		});

		it('leaves codexFailure undefined for a clean run', () => {
			const stdout = [
				'{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}',
				'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}',
			].join('\n');
			expect(parseAgentOutput('codex', stdout).codexFailure).toBeUndefined();
		});

		it.each([
			'{"type":"turn.failed"}',
			'{"type":"turn.failed","error":null}',
			'{"type":"turn.failed","error":"boom"}',
			'{"type":"turn.failed","error":{"message":42}}',
			'{"type":"error"}',
			'{"type":"error","message":{"detail":"boom"}}',
		])('leaves codexFailure undefined for the malformed record %s', (line) => {
			expect(parseAgentOutput('codex', line).codexFailure).toBeUndefined();
		});
	});

	describe('antigravity', () => {
		it('normalizes the terminal result usage, text, and conversation id', () => {
			const stdout = agyStream(
				agyInit('d42f7419-1111-2222-3333-444455556666'),
				{
					event: 'step_update',
					step_update: { step_index: 2, state: 'DONE', step_type: 'agent_response' },
				},
				{
					event: 'result',
					result: {
						conversation_id: 'd42f7419-1111-2222-3333-444455556666',
						status: 'SUCCESS',
						response: 'STREAM_OK\n',
						usage: {
							input_tokens: 18267,
							output_tokens: 28,
							thinking_tokens: 22,
							cache_read_tokens: 0,
							total_tokens: 18295,
						},
					},
				},
			);

			expect(parseAgentOutput('antigravity', stdout)).toEqual({
				usage: {
					inputTokens: 18267,
					outputTokens: 28,
					reasoningTokens: 22,
					cacheReadTokens: 0,
					totalTokens: 18295,
				},
				logText: 'STREAM_OK\n',
				sessionId: 'd42f7419-1111-2222-3333-444455556666',
			});
		});

		it('accepts input/output-only usage, leaving optional fields absent', () => {
			const stdout = agyStream({
				event: 'result',
				result: {
					status: 'SUCCESS',
					response: 'ok',
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			});
			expect(parseAgentOutput('antigravity', stdout)).toEqual({
				usage: { inputTokens: 10, outputTokens: 5 },
				logText: 'ok',
			});
		});

		it('renders a failed status as the log text and a structural failure', () => {
			// The live shape from agy 1.1.10 with a bogus --model: the detail lands in
			// `error`, `response` is empty, and `conversation_id` is the empty string.
			const stdout = agyStream(agyInit('ef894758-aaaa-bbbb-cccc-ddddeeeeffff'), {
				event: 'result',
				result: {
					conversation_id: '',
					status: 'ERROR',
					response: '',
					error: 'invalid model selection (--model "nope"):\n  model nope is not recognized',
					usage: { input_tokens: 0, output_tokens: 0 },
				},
			});

			expect(parseAgentOutput('antigravity', stdout)).toEqual({
				usage: { inputTokens: 0, outputTokens: 0 },
				logText:
					'Antigravity run failed (ERROR): invalid model selection (--model "nope"): model nope is not recognized',
				// The empty conversation_id is rejected in favour of the init event's.
				sessionId: 'ef894758-aaaa-bbbb-cccc-ddddeeeeffff',
				antigravityFailure: {
					status: 'ERROR',
					message: 'invalid model selection (--model "nope"): model nope is not recognized',
				},
			});
		});

		it('recovers the conversation id from a tail that lost the init event', () => {
			// The rolling tail the harness keeps starts wherever the byte budget fell,
			// so the opening `init` record can be gone or half-eaten. Every
			// `step_update` repeats the id, and that is what has to carry the resume.
			const full = agyStream(
				agyInit('d42f7419-1111-2222-3333-444455556666'),
				{
					event: 'step_update',
					step_update: {
						conversation_id: 'd42f7419-1111-2222-3333-444455556666',
						step_index: 2,
						state: 'DONE',
						step_type: 'agent_response',
					},
				},
				// A failed result reports an empty id, so it cannot be the source here.
				{ event: 'result', result: { conversation_id: '', status: 'SUCCESS', response: 'done' } },
			);
			const tail = full.slice(40);
			expect(tail).not.toContain('"event":"init"');
			expect(parseAgentOutput('antigravity', tail).sessionId).toBe(
				'd42f7419-1111-2222-3333-444455556666',
			);
		});

		it('returns {} for the plain text an agy without --output-format prints', () => {
			expect(parseAgentOutput('antigravity', 'Here is your answer.\nAll done.\n')).toEqual({});
		});

		it('skips malformed and truncated records without throwing', () => {
			const stdout = [
				'not json at all',
				'{"event":"step_update","step_update":{"text_delta":"half',
				JSON.stringify({ event: 'unknown_future_event', payload: {} }),
				JSON.stringify({
					event: 'result',
					result: {
						status: 'SUCCESS',
						response: 'done',
						usage: { input_tokens: 1, output_tokens: 2 },
					},
				}),
			].join('\n');

			expect(parseAgentOutput('antigravity', stdout)).toEqual({
				usage: { inputTokens: 1, outputTokens: 2 },
				logText: 'done',
			});
		});
	});
});

describe('sessionIdFromLine', () => {
	// The one-line sniff the harness runs over the live stdout stream, for the ids
	// a truncated run loses from both of its capture buffers (issue #867).
	it('reads a codex thread id off its opening event', () => {
		expect(
			sessionIdFromLine(
				'codex',
				'{"type":"thread.started","thread_id":"019f57a7-cf1b-72d3-b887-63758a10f3a8"}',
			),
		).toBe('019f57a7-cf1b-72d3-b887-63758a10f3a8');
	});

	it('reads an antigravity conversation id off any record that names one', () => {
		expect(sessionIdFromLine('antigravity', JSON.stringify(agyInit('conv-1')))).toBe('conv-1');
		expect(
			sessionIdFromLine(
				'antigravity',
				JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-1' } }),
			),
		).toBe('conv-1');
		// The empty id a failed run reports must never become a resume handle.
		expect(
			sessionIdFromLine(
				'antigravity',
				JSON.stringify({ event: 'result', result: { conversation_id: '', status: 'ERROR' } }),
			),
		).toBeUndefined();
	});

	it('answers undefined for claude, whose id SWARM assigns up front', () => {
		expect(
			sessionIdFromLine('claude', JSON.stringify({ type: 'system', session_id: 'sess-1' })),
		).toBeUndefined();
	});

	it('answers undefined for a non-matching or malformed line, on every CLI', () => {
		for (const cli of ['claude', 'antigravity', 'codex'] as const) {
			expect(sessionIdFromLine(cli, '{"type":"turn.completed","usage":{}}')).toBeUndefined();
			expect(sessionIdFromLine(cli, '{"type":"thread.started","thread_id":')).toBeUndefined();
			expect(sessionIdFromLine(cli, 'plain text, not protocol')).toBeUndefined();
			expect(sessionIdFromLine(cli, '')).toBeUndefined();
		}
	});
});

describe('selfTimeoutFromLine', () => {
	// The stderr twin of the sniff above (issue #1000): a CLI that ends its own turn
	// exits 0, so its notice is the only evidence the run was cut short.
	const AGY_PRINT_TIMEOUT =
		'[agy] print timeout after 5m0s with turn in progress; returning partial output';

	it('returns agy’s notice verbatim, so the cause can reach the operator', () => {
		expect(selfTimeoutFromLine('antigravity', AGY_PRINT_TIMEOUT)).toBe(AGY_PRINT_TIMEOUT);
		// Whatever budget it was given: #999 now passes the phase's own, which agy
		// echoes back in its own units.
		expect(
			selfTimeoutFromLine(
				'antigravity',
				'[agy] print timeout after 31m0s with turn in progress; returning partial output',
			),
		).toBe('[agy] print timeout after 31m0s with turn in progress; returning partial output');
	});

	it('trims the line, so a marker recovered mid-stream carries no stray whitespace', () => {
		expect(selfTimeoutFromLine('antigravity', `  ${AGY_PRINT_TIMEOUT}  \r`)).toBe(
			AGY_PRINT_TIMEOUT,
		);
	});

	it('requires both halves of the phrase', () => {
		// Deliberately narrow: a miss degrades to the pre-#1000 behaviour rather than
		// to a false timeout deferral, so text that merely mentions a print timeout —
		// a CI log in respond-to-ci, a reviewed diff — must not match.
		expect(selfTimeoutFromLine('antigravity', 'print timeout after 5m0s')).toBeUndefined();
		expect(selfTimeoutFromLine('antigravity', 'the turn is still in progress')).toBeUndefined();
		expect(
			selfTimeoutFromLine('antigravity', 'we should handle the print timeout case'),
		).toBeUndefined();
	});

	it('recognises nothing for claude or codex, neither of which declares a self-timeout', () => {
		// Matched per CLI so one CLI's wording cannot classify another's run (#999
		// checked both against their own `--help`).
		expect(selfTimeoutFromLine('claude', AGY_PRINT_TIMEOUT)).toBeUndefined();
		expect(selfTimeoutFromLine('codex', AGY_PRINT_TIMEOUT)).toBeUndefined();
	});

	it('answers undefined for an ordinary line, on every CLI', () => {
		for (const cli of ['claude', 'antigravity', 'codex'] as const) {
			expect(selfTimeoutFromLine(cli, 'plain text, not a notice')).toBeUndefined();
			expect(selfTimeoutFromLine(cli, '')).toBeUndefined();
		}
	});
});
