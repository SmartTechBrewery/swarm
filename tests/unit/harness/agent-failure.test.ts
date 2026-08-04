import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError, agentRunError, classifyAgentFailure } from '@/harness/agent-failure.js';

function result(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 1,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 1000,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
		...overrides,
	};
}

// A fixed reference instant so the reset-time parse is deterministic. This is
// 2026-07-07T10:00:00Z, i.e. 12:00 in Europe/Warsaw (UTC+2 in July).
const NOW = new Date('2026-07-07T10:00:00Z');
const CAPACITY_TRANSCRIPT = readFileSync(
	new URL('../../fixtures/agent-failure/codex-capacity-transcript.txt', import.meta.url),
	'utf8',
);
const CLAUDE_529_TRANSCRIPT = readFileSync(
	new URL('../../fixtures/agent-failure/claude-529-overloaded-transcript.txt', import.meta.url),
	'utf8',
);
const CLAUDE_529_REPEATED_TRANSCRIPT = readFileSync(
	new URL('../../fixtures/agent-failure/claude-529-repeated-transcript.txt', import.meta.url),
	'utf8',
);

describe('classifyAgentFailure', () => {
	it('classifies the observed Claude session-limit banner as rate-limit', () => {
		const failure = classifyAgentFailure(
			result({ stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n" }),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.resetHint).toBe('1:40pm (Europe/Warsaw)');
	});

	it('resolves the reset hint to the next occurrence of that wall-clock time in its zone', () => {
		const failure = classifyAgentFailure(
			result({ stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n" }),
			NOW,
		);
		// 1:40pm Warsaw (UTC+2 in July) == 11:40Z, later today than NOW (10:00Z).
		expect(failure.retryAfter?.toISOString()).toBe('2026-07-07T11:40:00.000Z');
	});

	it('rolls a reset time that already passed today to tomorrow', () => {
		// 9:00am Warsaw == 07:00Z, before NOW (10:00Z) → next is tomorrow.
		const failure = classifyAgentFailure(
			result({ stdout: 'usage limit reached — resets 9:00am (Europe/Warsaw)\n' }),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.retryAfter?.toISOString()).toBe('2026-07-08T07:00:00.000Z');
	});

	it('detects a rate-limit from stderr too (429 co-occurring with a reset line)', () => {
		// An HTTP 429 is only a limit signal when a "resets …" line co-occurs — that
		// pairing is the CLI's own banner, not borrowed text. The scan reads stdout
		// and stderr as one blob, so the reset can arrive on either stream.
		const failure = classifyAgentFailure(
			result({ stderr: 'HTTP 429 Too Many Requests\nresets 1:40pm (Europe/Warsaw)' }),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.resetHint).toBe('1:40pm (Europe/Warsaw)');
	});

	it('does not treat a bare HTTP 429 (no reset line) as a rate-limit', () => {
		// A standalone 429 with no reset hint is a plain error — it may well be the
		// CLI's own transport hiccup, but without the reset banner it's
		// indistinguishable from borrowed text and must fail fast, not defer.
		expect(classifyAgentFailure(result({ stderr: 'HTTP 429 Too Many Requests' }), NOW).kind).toBe(
			'error',
		);
	});

	it('does not treat a Docker Hub 429 in CI logs as the CLI being rate-limited', () => {
		// The respond-to-ci phase feeds the agent CI logs; a Docker Hub pull-rate
		// 429 in that borrowed output must not defer + retry the phase 6× — the
		// exact false positive the co-occurrence gate guards against.
		const failure = classifyAgentFailure(
			result({
				stdout:
					'toomanyrequests: You have reached your pull rate limit.\n' +
					'  See https://www.docker.com/increase-rate-limit\n' +
					'Error: process completed with exit code 1.',
			}),
			NOW,
		);
		expect(failure.kind).toBe('error');
	});

	it('leaves retryAfter undefined when the hint carries no timezone', () => {
		const failure = classifyAgentFailure(
			result({ stdout: "You've hit your usage limit · resets 1:40pm\n" }),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.resetHint).toBe('1:40pm');
		expect(failure.retryAfter).toBeUndefined();
	});

	it('leaves retryAfter undefined for an unparseable timezone', () => {
		const failure = classifyAgentFailure(
			result({ stdout: "You've hit your session limit · resets 1:40pm (Not/AZone)\n" }),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.retryAfter).toBeUndefined();
	});

	it('does not misread ordinary output that merely mentions rate limiting', () => {
		// A failed run whose output discusses the concept, without the CLI's own
		// banner or a "resets …" line, must stay a plain error.
		const failure = classifyAgentFailure(
			result({ stdout: 'The code should add a rate limit to the API endpoint.\n' }),
			NOW,
		);
		expect(failure.kind).toBe('error');
	});

	it('classifies a terminal Codex capacity error despite borrowed rate-limit text', () => {
		const failure = classifyAgentFailure(
			result({ cli: 'codex', stdout: CAPACITY_TRANSCRIPT }),
			NOW,
		);
		expect(failure).toEqual({ kind: 'capacity' });
	});

	it.each([
		'{"type":"error","message":"Selected model is at capacity. Please try a different model."}',
		'{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}',
	])('classifies Codex structured capacity event %s anywhere in captured output', (event) => {
		const output = [
			'{"type":"item.completed","item":{"type":"reasoning"}}',
			'Codex completed useful analysis before the provider failure.',
			event,
			...Array(16).fill('{"type":"item.completed","item":{"type":"message"}}'),
			'Error: process completed with exit code 1.',
		].join('\n');

		expect(classifyAgentFailure(result({ cli: 'codex', stdout: output }), NOW)).toEqual({
			kind: 'capacity',
		});
	});

	it('ignores borrowed limit and reset signals outside the terminal window', () => {
		const body = ['usage limit reached — resets 1:40pm (Europe/Warsaw)', ...Array(16).fill('work')];
		const failure = classifyAgentFailure(
			result({ stdout: `${body.join('\n')}\nTypeError: boom` }),
			NOW,
		);
		expect(failure.kind).toBe('error');
	});

	it('prioritizes a capacity banner over rate-limit wording in the terminal window', () => {
		const failure = classifyAgentFailure(
			result({ cli: 'codex', stderr: 'usage limit resets 1:40pm\nSelected model is at capacity' }),
			NOW,
		);
		expect(failure).toEqual({ kind: 'capacity' });
	});

	it('prioritizes a capacity banner over a trailing response-stall marker', () => {
		const failure = classifyAgentFailure(
			result({
				cli: 'codex',
				stderr: 'Selected model is at capacity\nError: timeout waiting for response',
			}),
			NOW,
		);
		expect(failure).toEqual({ kind: 'capacity' });
	});

	it('does not classify a non-Codex run as capacity even when the phrase appears in output', () => {
		// A Claude/Antigravity run can quote or discuss the Codex capacity phrase
		// in code, test fixtures, or review text. Without the cli gate this would
		// be misclassified as 'capacity', deferring the job and ultimately telling
		// the user to change their model instead of reporting the real failure.
		for (const cli of ['claude', 'antigravity'] as const) {
			const failure = classifyAgentFailure(
				result({ cli, stderr: 'ERROR: Selected model is at capacity.' }),
				NOW,
			);
			expect(failure.kind).toBe('error');
		}
	});

	it('leaves a non-capacity Codex turn.failed event as a terminal error', () => {
		const failure = classifyAgentFailure(
			result({
				cli: 'codex',
				stderr: '{"type":"turn.failed","error":{"message":"Connection closed unexpectedly."}}',
			}),
			NOW,
		);
		expect(failure).toEqual({ kind: 'error' });
	});

	it('classifies the observed Claude 529 overload banner as capacity', () => {
		// The literal terminal banner from run cdbba4f7… (issue #229): Anthropic's
		// documented temporary-overload response. Transient → defer + retry, not a
		// terminal failure that clears the session/worktree.
		const failure = classifyAgentFailure(
			result({ cli: 'claude', stderr: 'API Error: 529 Overloaded. Try again in a moment.' }),
			NOW,
		);
		expect(failure).toEqual({ kind: 'capacity' });
	});

	it('classifies a Claude overloaded_error type as capacity', () => {
		// The raw JSON error type Anthropic returns with a 529, on its own.
		const failure = classifyAgentFailure(
			result({
				cli: 'claude',
				stdout: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
			}),
			NOW,
		);
		expect(failure).toEqual({ kind: 'capacity' });
	});

	it('classifies the observed Claude 529 transcript as capacity despite borrowed 429/reset text', () => {
		const failure = classifyAgentFailure(
			result({ cli: 'claude', stdout: CLAUDE_529_TRANSCRIPT }),
			NOW,
		);
		expect(failure).toEqual({ kind: 'capacity' });
	});

	it("classifies Claude Code's repeated-529 retry transcript as capacity", () => {
		const failure = classifyAgentFailure(
			result({ cli: 'claude', stdout: CLAUDE_529_REPEATED_TRANSCRIPT }),
			NOW,
		);
		expect(failure).toEqual({ kind: 'capacity' });
	});

	// Claude's terminal `result` stream event reaches classification as one
	// rendered `Claude run failed (…)` line (issue #356) — a structural signal,
	// so it doesn't need the "resets …" co-occurrence free text does.
	it('classifies a streamed Claude 429 as rate-limit, with its reset time', () => {
		const failure = classifyAgentFailure(
			result({
				cli: 'claude',
				stdout:
					'Claude run failed (error_during_execution): API Error: 429 rate_limit_error; resets 1:40pm (Europe/Warsaw)',
				claudeFailure: {
					subtype: 'error_during_execution',
					message: 'API Error: 429 rate_limit_error; resets 1:40pm (Europe/Warsaw)',
				},
			}),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.resetHint).toBe('1:40pm (Europe/Warsaw)');
		expect(failure.retryAfter?.toISOString()).toBe('2026-07-07T11:40:00.000Z');
	});

	it('prefers the reset instant the CLI reported over the parsed text hint', () => {
		// Claude's `rate_limit_event` carries an exact epoch; the human hint needs a
		// timezone to resolve at all, so the reported instant wins when both exist.
		const failure = classifyAgentFailure(
			result({
				cli: 'claude',
				stdout: 'Claude run failed (error_during_execution): 429; resets 1:40pm (Europe/Warsaw)',
				rateLimitResetAt: new Date('2026-07-07T13:00:00Z'),
				claudeFailure: {
					subtype: 'error_during_execution',
					message: '429; resets 1:40pm (Europe/Warsaw)',
				},
			}),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.resetHint).toBe('1:40pm (Europe/Warsaw)');
		expect(failure.retryAfter?.toISOString()).toBe('2026-07-07T13:00:00.000Z');
	});

	it('classifies a streamed Claude 429 that reported no reset time as rate-limit', () => {
		const failure = classifyAgentFailure(
			result({
				cli: 'claude',
				stdout: 'Claude run failed (error_during_execution): API Error: 429 rate_limit_error',
				claudeFailure: {
					subtype: 'error_during_execution',
					message: 'API Error: 429 rate_limit_error',
				},
			}),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.retryAfter).toBeUndefined();
		expect(
			agentRunError(
				result({
					cli: 'claude',
					stdout: 'Claude run failed (x): 429',
					claudeFailure: {
						subtype: 'x',
						message: '429',
					},
				}),
				'Run',
			).message,
		).toBe('Run (rate limited)');
	});

	it('classifies a streamed Claude 529 as capacity, not a rate limit', () => {
		const failure = classifyAgentFailure(
			result({
				cli: 'claude',
				stdout: 'Claude run failed (error_during_execution): API Error: 529 Overloaded',
			}),
			NOW,
		);
		expect(failure).toEqual({ kind: 'capacity' });
	});

	it('does not read a 429 an agent merely mentioned as a streamed Claude rate limit', () => {
		// Only the rendered terminal-failure line is trusted: assistant progress
		// discussing HTTP 429 handling (this very change, say) stays a plain error.
		const failure = classifyAgentFailure(
			result({
				cli: 'claude',
				stdout: 'Tool completed: Read\nAdded a test for the HTTP 429 path.\nTool started: Bash',
			}),
			NOW,
		);
		expect(failure.kind).toBe('error');
	});

	it('does not classify assistant text matching display prefix and containing 429 as rate-limit', () => {
		// An assistant text event starts with "Claude run failed" and mentions "429",
		// but there is no terminal failure result. It must be classified as a plain error.
		const failure = classifyAgentFailure(
			result({
				cli: 'claude',
				stdout: 'Claude run failed (analysis): HTTP 429 is covered by this test',
			}),
			NOW,
		);
		expect(failure.kind).toBe('error');
	});

	it('retains rate-limit classification for an actual failed terminal result', () => {
		const failure = classifyAgentFailure(
			result({
				cli: 'claude',
				stdout: 'Claude run failed (error_during_execution): API Error: 429 rate_limit_error',
				claudeFailure: {
					subtype: 'error_during_execution',
					message: 'API Error: 429 rate_limit_error',
				},
			}),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
	});

	it('keeps timeout and abort ahead of a streamed Claude rate limit', () => {
		const stdout = 'Claude run failed (error_during_execution): API Error: 429 rate_limit_error';
		const claudeFailure = {
			subtype: 'error_during_execution',
			message: 'API Error: 429 rate_limit_error',
		};
		expect(
			classifyAgentFailure(result({ cli: 'claude', stdout, claudeFailure, timedOut: true }), NOW),
		).toEqual({
			kind: 'timeout',
		});
		expect(
			classifyAgentFailure(result({ cli: 'claude', stdout, claudeFailure, aborted: true }), NOW),
		).toEqual({
			kind: 'aborted',
		});
	});

	// agy's terminal `result` event reports its own `status`; a non-SUCCESS one is
	// a structural signal (issue #465), so a quota token inside it is trusted
	// without the "resets …" co-occurrence free text needs.
	it('classifies a structural Antigravity quota failure as rate-limit with no reset hint', () => {
		for (const message of [
			'RESOURCE_EXHAUSTED: quota exceeded for model gemini-3.5-flash',
			'API error 429: too many requests',
			'rate_limit_exceeded for this project',
		]) {
			const failure = classifyAgentFailure(
				result({
					cli: 'antigravity',
					stdout: `Antigravity run failed (ERROR): ${message}`,
					antigravityFailure: { status: 'ERROR', message },
				}),
				NOW,
			);
			expect(failure.kind).toBe('rate-limit');
			expect(failure.retryAfter).toBeUndefined();
		}
	});

	it('leaves an ordinary structural Antigravity failure a plain error', () => {
		// The live shape from a bogus --model: a real structural failure carrying no
		// quota signal must stay terminal, not defer the job waiting for a reset.
		const failure = classifyAgentFailure(
			result({
				cli: 'antigravity',
				stdout:
					'Antigravity run failed (ERROR): invalid model selection (--model "nope"): model nope is not recognized',
				antigravityFailure: {
					status: 'ERROR',
					message: 'invalid model selection (--model "nope"): model nope is not recognized',
				},
			}),
			NOW,
		);
		expect(failure).toEqual({ kind: 'error' });
	});

	it('does not read a 429 an agy run merely mentioned as a structural rate limit', () => {
		// Without the structural field there is no CLI verdict, only transcript text
		// — an agent that reviewed HTTP 429 handling must not defer its own job.
		const failure = classifyAgentFailure(
			result({
				cli: 'antigravity',
				stdout: 'Tool completed: view_file\nAdded a test for the HTTP 429 path.',
			}),
			NOW,
		);
		expect(failure.kind).toBe('error');
	});

	it('keeps timeout and abort ahead of a structural Antigravity rate limit', () => {
		const stdout = 'Antigravity run failed (ERROR): RESOURCE_EXHAUSTED';
		const antigravityFailure = { status: 'ERROR', message: 'RESOURCE_EXHAUSTED' };
		expect(
			classifyAgentFailure(
				result({ cli: 'antigravity', stdout, antigravityFailure, timedOut: true }),
				NOW,
			),
		).toEqual({ kind: 'timeout' });
		expect(
			classifyAgentFailure(
				result({ cli: 'antigravity', stdout, antigravityFailure, aborted: true }),
				NOW,
			),
		).toEqual({ kind: 'aborted' });
	});

	it('does not let one CLI structural failure fire on another CLI', () => {
		// Each structural matcher is gated on its own `cli`, so a claude run can't
		// be classified by an antigravity field and vice versa.
		expect(
			classifyAgentFailure(
				result({
					cli: 'claude',
					stdout: 'something went wrong',
					antigravityFailure: { status: 'ERROR', message: 'RESOURCE_EXHAUSTED' },
				}),
				NOW,
			).kind,
		).toBe('error');
		expect(
			classifyAgentFailure(
				result({
					cli: 'antigravity',
					stdout: 'something went wrong',
					claudeFailure: { subtype: 'error', message: 'API Error: 429 rate_limit_error' },
				}),
				NOW,
			).kind,
		).toBe('error');
	});

	it('does not classify a bare 529 with no "overloaded" as Claude capacity', () => {
		// The issue forbids a bare-status-code matcher: reviewed code, tool output,
		// or a quoted HTTP number can mention 529 innocuously. Only 529 paired with
		// "overloaded" (or the overloaded_error type) is the provider banner.
		for (const text of [
			'HTTP 529 returned by the upstream proxy',
			'the retry policy handles 5xx codes including 529',
			'assert(res.status !== 529)',
		]) {
			expect(classifyAgentFailure(result({ cli: 'claude', stderr: text }), NOW).kind).toBe('error');
		}
	});

	it('does not classify a non-Claude run as capacity even when 529 Overloaded appears', () => {
		// Symmetric to the Codex gate: a Codex/Antigravity run reviewing code or logs
		// about Anthropic's 529 must not be read as that CLI itself being overloaded.
		for (const cli of ['codex', 'antigravity'] as const) {
			const failure = classifyAgentFailure(
				result({ cli, stderr: 'API Error: 529 Overloaded. Try again in a moment.' }),
				NOW,
			);
			expect(failure.kind).toBe('error');
		}
	});

	it('does not classify a Claude 529 overload banner outside the terminal window', () => {
		// A 529 the agent quoted earlier in the transcript (then continued past) is
		// borrowed text, not the run's terminal cause — it must stay a plain error.
		const body = ['API Error: 529 Overloaded. Try again in a moment.', ...Array(16).fill('work')];
		const failure = classifyAgentFailure(
			result({ cli: 'claude', stdout: `${body.join('\n')}\nTypeError: boom` }),
			NOW,
		);
		expect(failure.kind).toBe('error');
	});

	// The CLI being logged out (issue #343): terminal, but recognised so the run's
	// headline says so instead of a bare "exited with code 1".
	it.each([
		'Failed to authenticate: OAuth session expired and could not be refreshed',
		'Not logged in · Please run /login',
		'Invalid API key · Please run /login',
		'{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
	])('classifies the observed auth banner %s as auth', (banner) => {
		expect(classifyAgentFailure(result({ stdout: banner }), NOW)).toEqual({ kind: 'auth' });
	});

	it('classifies the observed two-line OAuth and login banner as auth', () => {
		expect(
			classifyAgentFailure(
				result({
					stdout:
						'Failed to authenticate: OAuth session expired and could not be refreshed\n' +
						'Not logged in · Please run /login',
				}),
				NOW,
			),
		).toEqual({ kind: 'auth' });
	});

	it('detects an auth banner on stderr too', () => {
		// The scan reads stdout and stderr as one blob, so the banner can arrive on
		// either stream — the real incident printed it to stderr.
		expect(
			classifyAgentFailure(result({ stderr: 'Not logged in · Please run /login' }), NOW),
		).toEqual({ kind: 'auth' });
	});

	it('keeps timeout and abort ahead of an auth banner', () => {
		const stdout = 'Failed to authenticate: OAuth session expired and could not be refreshed';
		expect(classifyAgentFailure(result({ stdout, timedOut: true }), NOW)).toEqual({
			kind: 'timeout',
		});
		expect(classifyAgentFailure(result({ stdout, aborted: true }), NOW)).toEqual({
			kind: 'aborted',
		});
	});

	it('prioritizes structural Claude and Antigravity quota failures over an auth banner', () => {
		const authBanner = 'Not logged in · Please run /login';
		expect(
			classifyAgentFailure(
				result({
					cli: 'claude',
					stdout: authBanner,
					claudeFailure: { subtype: 'rate_limit_error', message: 'rate_limit_error' },
				}),
				NOW,
			),
		).toEqual({ kind: 'rate-limit', resetHint: undefined, retryAfter: undefined });
		expect(
			classifyAgentFailure(
				result({
					cli: 'antigravity',
					stdout: authBanner,
					antigravityFailure: { status: 'RESOURCE_EXHAUSTED', message: 'quota' },
				}),
				NOW,
			),
		).toEqual({ kind: 'rate-limit', resetHint: undefined, retryAfter: undefined });
	});

	it('prioritizes a terminal rate-limit banner over an auth banner', () => {
		const failure = classifyAgentFailure(
			result({
				stdout:
					'Invalid API key · Please run /login\n' +
					"you've hit your session limit — resets 1:40pm (Europe/Warsaw)",
			}),
			NOW,
		);
		expect(failure.kind).toBe('rate-limit');
		expect(failure.resetHint).toBe('1:40pm (Europe/Warsaw)');
		expect(failure.retryAfter?.toISOString()).toBe('2026-07-07T11:40:00.000Z');
	});

	it('prioritizes an auth banner over a trailing response-stall marker', () => {
		// A definite cause beats the generic give-up marker (as capacity already
		// does): classified `stalled`, this run would be deferred *and resumed* while
		// the CLI is still logged out.
		const failure = classifyAgentFailure(
			result({
				stdout:
					'Failed to authenticate: OAuth session expired and could not be refreshed\n' +
					'Error: timeout waiting for response',
			}),
			NOW,
		);
		expect(failure).toEqual({ kind: 'auth' });
	});

	it('does not classify an auth banner outside the terminal window as auth', () => {
		// An auth line the agent quoted earlier in the transcript (then continued
		// past) is borrowed text, not the run's terminal cause.
		const body = [
			'Failed to authenticate: OAuth session expired and could not be refreshed',
			...Array(16).fill('work'),
		];
		expect(
			classifyAgentFailure(result({ stdout: `${body.join('\n')}\nTypeError: boom` }), NOW).kind,
		).toBe('error');
	});

	it('does not misread borrowed CI or reviewed-code text about authentication as auth', () => {
		// respond-to-ci feeds the agent CI logs and review phases read code about
		// login handling; neither is the CLI reporting itself logged out. The bare
		// "authentication failed" phrasing git/CI prints is deliberately unmatched.
		for (const text of [
			"remote: Authentication failed for 'https://github.com/acme/repo.git'\n" +
				'Error: process completed with exit code 1.',
			'The handler should return 401 when the api key is invalid.',
			'expect(res.body.error).toBe("authentication required")',
			'npm ERR! Failed to authenticate with the registry\nTypeError: cannot read property of undefined',
			'Reviewed src/auth/session.ts: the handler returns 401 when the caller is Not logged in.',
			'The configuration is rejected for an Invalid API key.',
		]) {
			expect(classifyAgentFailure(result({ stdout: text }), NOW).kind).toBe('error');
		}
	});

	it('keeps a trailing stall marker ahead of borrowed auth prose', () => {
		const failure = classifyAgentFailure(
			result({
				stdout:
					'Reviewed src/auth/session.ts: the handler returns 401 when the caller is Not logged in.\n' +
					'Error: timeout waiting for response',
			}),
			NOW,
		);
		expect(failure).toEqual({ kind: 'stalled' });
	});

	it('treats a timed-out run as a timeout regardless of its output', () => {
		const failure = classifyAgentFailure(
			result({ exitCode: null, timedOut: true, stdout: "you've hit your session limit" }),
			NOW,
		);
		expect(failure.kind).toBe('timeout');
	});

	it('classifies an ordinary non-zero exit as a plain error', () => {
		expect(classifyAgentFailure(result({ stderr: 'TypeError: boom' }), NOW).kind).toBe('error');
	});

	it('treats an aborted run as aborted regardless of its output', () => {
		// A run the harness's `signal` cancelled (e.g. the worker's own shutdown)
		// must not be read as a rate-limit even if leftover buffered text happens
		// to contain limit-like phrasing.
		const failure = classifyAgentFailure(
			result({ aborted: true, stdout: "you've hit your session limit" }),
			NOW,
		);
		expect(failure.kind).toBe('aborted');
	});

	it('prioritizes timeout over aborted when both are somehow set', () => {
		expect(classifyAgentFailure(result({ timedOut: true, aborted: true }), NOW).kind).toBe(
			'timeout',
		);
	});

	it('classifies whole-output stall as stalled', () => {
		const failure = classifyAgentFailure(
			result({ stdout: 'Error: timeout waiting for response\n' }),
			NOW,
		);
		expect(failure.kind).toBe('stalled');
	});

	it('classifies trailing-line stall as stalled', () => {
		const failure = classifyAgentFailure(
			result({
				stdout: ' narration line 1\nnarration line 2\nError: timeout waiting for response\n',
			}),
			NOW,
		);
		expect(failure.kind).toBe('stalled');
	});

	it('does not classify mid-transcript stall occurrence as stalled', () => {
		const failure = classifyAgentFailure(
			result({
				stdout:
					'Error: timeout waiting for response\n' + 'Error: process completed with exit code 1.',
			}),
			NOW,
		);
		expect(failure.kind).toBe('error');
	});

	it('prioritizes timeout and aborted over a stall phrase', () => {
		const timedOutFailure = classifyAgentFailure(
			result({ timedOut: true, stdout: 'Error: timeout waiting for response' }),
			NOW,
		);
		expect(timedOutFailure.kind).toBe('timeout');

		const abortedFailure = classifyAgentFailure(
			result({ aborted: true, stdout: 'Error: timeout waiting for response' }),
			NOW,
		);
		expect(abortedFailure.kind).toBe('aborted');
	});
});

describe('agentRunError', () => {
	it('wraps the classification and marks the reason in the message', () => {
		const err = agentRunError(
			result({ stdout: "You've hit your session limit · resets 1:40pm (Europe/Warsaw)\n" }),
			'Review agent (claude) exited with code 1',
			' for PR #90',
			NOW,
		);
		expect(err).toBeInstanceOf(AgentRunError);
		expect(err.message).toBe('Review agent (claude) exited with code 1 (rate limited) for PR #90');
		expect(err.failure.kind).toBe('rate-limit');
	});

	it('notes a timeout and preserves the plain message for an ordinary error', () => {
		expect(agentRunError(result({ timedOut: true }), 'x exited', ' for y', NOW).message).toBe(
			'x exited (timed out) for y',
		);
		expect(agentRunError(result(), 'x exited', ' for y', NOW).message).toBe('x exited for y');
	});

	it('notes an abort', () => {
		const err = agentRunError(result({ aborted: true }), 'x exited', ' for y', NOW);
		expect(err.message).toBe('x exited (aborted) for y');
		expect(err.failure.kind).toBe('aborted');
	});

	it('notes model capacity', () => {
		const err = agentRunError(
			result({ cli: 'codex', stderr: 'ERROR: Selected model is at capacity.' }),
			'Implementation agent (codex) exited with code 1',
			' for task 136',
			NOW,
		);
		expect(err.message).toBe(
			'Implementation agent (codex) exited with code 1 (model at capacity) for task 136',
		);
		expect(err.failure).toEqual({ kind: 'capacity' });
	});

	it('notes a stall', () => {
		const err = agentRunError(
			result({ stdout: 'Error: timeout waiting for response' }),
			'x exited',
			' for y',
			NOW,
		);
		expect(err.message).toBe('x exited (stalled) for y');
		expect(err.failure.kind).toBe('stalled');
	});

	it('notes an authentication failure', () => {
		// The real incident's headline (issue #343, run 17b9b573…): the operator sees
		// what to do without opening the raw run output. Every phase builds its stem
		// this way, so the suffix reaches all six.
		const err = agentRunError(
			result({ stdout: 'Not logged in · Please run /login' }),
			'Implementation agent (claude) exited with code 1',
			" for task '337'",
			NOW,
		);
		expect(err.message).toBe(
			"Implementation agent (claude) exited with code 1 (authentication failed) for task '337'",
		);
		expect(err.failure).toEqual({ kind: 'auth' });
	});

	it('attaches the failed run result so its output can be persisted', () => {
		const failed = result({ exitCode: 1, stdout: 'partial work', stderr: 'boom' });
		const err = agentRunError(failed, 'x exited', ' for y', NOW);
		expect(err.agent).toBe(failed);
		expect(err.agent?.stdout).toBe('partial work');
		expect(err.agent?.stderr).toBe('boom');
	});

	it('leaves .agent undefined when the error is constructed directly', () => {
		const err = new AgentRunError('synthetic', { kind: 'error' });
		expect(err.agent).toBeUndefined();
	});
});
