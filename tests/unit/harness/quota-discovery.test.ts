import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock DB/runsRepository
vi.mock('@/db/client.js', () => ({
	getDb: vi.fn().mockReturnValue({
		select: vi.fn().mockReturnThis(),
		from: vi.fn().mockReturnThis(),
		where: vi.fn().mockReturnThis(),
		orderBy: vi.fn().mockReturnThis(),
		limit: vi.fn().mockResolvedValue([]),
	}),
}));

// Mock child_process
const mockSpawn = vi.fn();
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
	spawn: (...args: any[]) => mockSpawn(...args),
	execFile: (...args: any[]) => mockExecFile(...args),
}));

import { resetOutputFormatProbeCache } from '@/harness/antigravity-capabilities.js';
import {
	discoverCliQuotas,
	isBinaryRunnable,
	queryAntigravityQuota,
	queryClaudeQuota,
	queryCodexQuota,
} from '@/harness/quota-discovery.js';

/** `agy --help` on a build that declares the flag (the shape 1.1.10+ prints). */
const AGY_HELP = [
	'Usage of agy:',
	'  --output-format   Output format for print mode (text, json, stream-json) (default text)',
	'  -p                Short alias for --print',
].join('\n');

/** The same help without the flag — how agy 1.1.3 presented itself. */
const AGY_OLD_HELP = ['Usage of agy:', '  -p                Short alias for --print'].join('\n');

/**
 * The real `agy --output-format json -p "/quota"` answer, verified live against
 * agy 1.1.12 (issue #670): a structured `command` block alongside the ordinary
 * print-mode envelope, carrying both independent limit groups.
 */
const AGY_QUOTA_ANSWER = JSON.stringify({
	conversation_id: '',
	status: 'SUCCESS',
	response: '',
	command: {
		name: 'usage',
		data: {
			description: 'Within each group, models share a weekly limit and a 5-hour limit.',
			groups: [
				{
					name: 'Gemini Models',
					description: 'Models within this group: Gemini Flash, Gemini Pro',
					buckets: [
						{
							id: 'gemini-weekly',
							name: 'Weekly Limit Remaining',
							description:
								'You have used some of your weekly limit, it will fully refresh in 6 days.',
							window: 'weekly',
							remaining_fraction: 0.9832651615142822,
							reset_time: '2026-08-18T09:20:47Z',
						},
						{
							id: 'gemini-5h',
							name: 'Five Hour Limit Remaining',
							window: '5h',
							remaining_fraction: 1,
							reset_time: '2026-08-11T21:55:11Z',
						},
					],
				},
				{
					name: 'Claude and GPT models',
					description: 'Models within this group: Claude Opus, Claude Sonnet, GPT-OSS',
					buckets: [
						{
							id: '3p-weekly',
							name: 'Weekly Limit Remaining',
							window: 'weekly',
							remaining_fraction: 1,
							reset_time: '2026-08-18T16:58:40Z',
						},
						{
							id: '3p-5h',
							name: 'Five Hour Limit Remaining',
							window: '5h',
							remaining_fraction: 1,
							reset_time: '2026-08-11T21:58:40Z',
						},
					],
				},
			],
		},
	},
});

/** The real `/credits` answer — a spent account, reporting a zero balance. */
const AGY_CREDITS_ANSWER = JSON.stringify({
	command: {
		name: 'credits',
		data: { remaining_credits: 0, upgrade_uri: 'https://antigravity.google/g1-upgrade' },
	},
});

/**
 * An ordinary print-mode envelope with no `command` block — how a build that
 * predates print-mode slash commands answers, having taken `/quota` for a prompt.
 */
const AGY_PROMPT_ANSWER = JSON.stringify({
	conversation_id: 'f0f2…',
	status: 'SUCCESS',
	response: 'I do not have access to your quota.',
});

/** A print-mode command failure carries its detail in the result envelope. */
const AGY_ERROR_ANSWER = JSON.stringify({
	conversation_id: '',
	status: 'ERROR',
	response: '',
	result: { error: 'Authentication expired' },
});

interface AgyResponses {
	help?: string;
	quota?: string | Error;
	credits?: string | Error;
}

/** Route the mocked `execFile` by the arguments each `agy` probe passes. */
function mockAgy(responses: AgyResponses = {}): void {
	mockExecFile.mockImplementation((...args: unknown[]) => {
		const cliArgs: string[] = Array.isArray(args[1]) ? args[1] : [];
		const cb = args[args.length - 1] as (err: unknown, result?: unknown) => void;
		const reply = (value: string | Error | undefined) =>
			value instanceof Error ? cb(value) : cb(null, { stdout: value ?? '', stderr: '' });

		if (cliArgs.includes('--help')) return reply(responses.help ?? AGY_HELP);
		if (cliArgs.includes('/quota')) return reply(responses.quota ?? AGY_QUOTA_ANSWER);
		if (cliArgs.includes('/credits')) return reply(responses.credits ?? AGY_CREDITS_ANSWER);
		// `--version` (and the bare fallback probe): the binary exists and runs.
		return cb(null, { stdout: 'agy 1.1.12', stderr: '' });
	});
}

/** A codex app-server that fails to spawn, so `discoverCliQuotas` settles fast. */
function mockCodexAppServerUnavailable(): void {
	mockSpawn.mockImplementation(() => {
		const child = Object.assign(new EventEmitter(), {
			stdin: { write: vi.fn() },
			stdout: new EventEmitter(),
			kill: vi.fn(),
		});
		setImmediate(() => child.emit('error', new Error('spawn codex ENOENT')));
		return child;
	});
}

/** The arguments of the probe that carried `slashCommand`, if one ran. */
function probeArgsFor(slashCommand: string): string[] | undefined {
	const call = mockExecFile.mock.calls.find(
		(args: unknown[]) => Array.isArray(args[1]) && args[1].includes(slashCommand),
	);
	return call?.[1] as string[] | undefined;
}

/**
 * The real envelope of
 * `claude --safe-mode --no-session-persistence --output-format json -p "/usage"`,
 * captured verbatim from Claude Code 2.1.227 (issue #671). Two things it pins:
 * the answer is prose in `result` with `modelUsage: {}` and `num_turns: 0` — no
 * structured payload and no agent turn — and a reset time is a localized human
 * string carrying no year.
 */
const CAPTURED_CLAUDE_USAGE_ENVELOPE = `{"is_error":false,"duration_api_ms":0,"num_turns":0,"stop_reason":null,"session_id":"741e4504-803b-418e-a2c1-6fafb305b9db","total_cost_usd":0,"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{},"permission_denials":[],"fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subtype":"success","result":"You are currently using your subscription to power your Claude Code usage\\n\\nCurrent session: 14% used · resets Aug 11 at 11:59pm (Europe/Warsaw)\\nCurrent week (all models): 34% used · resets Aug 14 at 4:59pm (Europe/Warsaw)\\nCurrent week (Fable): 0% used\\n\\nWhat's contributing to your limits usage?\\nApproximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.\\n\\nLast 24h · 1793 requests · 30 sessions\\n  63% of your usage was at >150k context\\n\\nLast 7d · 15692 requests · 197 sessions\\n  68% of your usage was at >150k context\\n  13% of your usage came from sessions active for 8+ hours\\n  Top skills: /solve-issue 5%, /respond-to-re-review 1%, /write-issue 1%\\n  Top subagents: solve-issue 1%\\n  Top MCP servers: context7 1%","type":"result","duration_ms":543,"uuid":"40bd76ea-caa1-4596-b363-9af197face2b"}`;

/** The captured envelope with its prose swapped, so a variant keeps every real field. */
function claudeUsageEnvelope(report: string): string {
	return JSON.stringify({ ...JSON.parse(CAPTURED_CLAUDE_USAGE_ENVELOPE), result: report });
}

/** `execFile`'s node-style callback, as the mocked module receives it. */
type ExecFileCallback = (err: unknown, stdout: unknown, stderr: unknown) => void;

/** The `/usage` invocation among the mocked `execFile` calls, if the probe ran. */
function claudeUsageCall(): string[] | undefined {
	return mockExecFile.mock.calls.find((args) => (args[1] as string[])?.includes('/usage'))?.[1];
}

/**
 * Answer `claude --version` (the PATH probe) and the `/usage` probe, so the
 * mocked `execFile` serves both `isBinaryRunnable` and the quota read.
 */
function stubClaudeProbes(usageStdout: string | Error): void {
	mockExecFile.mockImplementation((...args: unknown[]) => {
		const argv = (args[1] ?? []) as string[];
		const cb = args[args.length - 1] as ExecFileCallback;
		if (!argv.includes('/usage')) {
			cb(null, { stdout: '2.1.227 (Claude Code)', stderr: '' }, '');
			return;
		}
		if (usageStdout instanceof Error) cb(usageStdout, null, null);
		else cb(null, { stdout: usageStdout, stderr: '' }, '');
	});
}

/** Read the live windows of a `/usage` answer at a fixed instant. */
async function readClaudeQuota(report: string, now = '2026-08-11T18:05:00.000Z') {
	stubClaudeProbes(claudeUsageEnvelope(report));
	vi.useFakeTimers();
	try {
		vi.setSystemTime(new Date(now));
		return await queryClaudeQuota();
	} finally {
		vi.useRealTimers();
	}
}

describe('quota-discovery', () => {
	beforeEach(() => {
		mockSpawn.mockReset();
		mockExecFile.mockReset();
		resetOutputFormatProbeCache();
	});

	describe('isBinaryRunnable', () => {
		it('returns true if execFile runs successfully', async () => {
			mockExecFile.mockImplementation((...args: any[]) => {
				const cb = args[args.length - 1];
				cb(null, { stdout: 'version 1.0' }, '');
			});
			const result = await isBinaryRunnable('claude');
			expect(result).toBe(true);
		});

		it('returns false if execFile fails with ENOENT', async () => {
			mockExecFile.mockImplementation((...args: any[]) => {
				const cb = args[args.length - 1];
				cb({ code: 'ENOENT' }, null, null);
			});
			const result = await isBinaryRunnable('missing-cli');
			expect(result).toBe(false);
		});
	});

	describe('queryCodexQuota', () => {
		/** Drive one app-server exchange: initialize, then the given `rateLimits/read` result. */
		function runExchange(rateLimitsResult: unknown) {
			const mockStdin = { write: vi.fn() };
			const mockStdout = new EventEmitter();
			const mockChild = Object.assign(new EventEmitter(), {
				stdin: mockStdin,
				stdout: mockStdout,
				kill: vi.fn(),
			});

			mockSpawn.mockReturnValue(mockChild);

			const promise = queryCodexQuota();

			mockStdout.emit(
				'data',
				Buffer.from(
					`${JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						result: {
							userAgent: 'test',
							codexHome: '/home',
							platformFamily: 'unix',
							platformOs: 'macos',
						},
					})}\n`,
				),
			);

			mockStdout.emit(
				'data',
				Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id: 2, result: rateLimitsResult })}\n`),
			);

			return { promise, mockStdin };
		}

		it('negotiates JSON-RPC initialize and rateLimits read successfully', async () => {
			const { promise, mockStdin } = runExchange({
				rateLimits: {
					limitId: 'codex',
					planType: 'plus',
					primary: {
						usedPercent: 45,
						windowDurationMins: 300,
						resetsAt: 1700000000,
					},
					credits: {
						balance: '12',
					},
				},
				rateLimitResetCredits: {
					availableCount: 2,
				},
			});

			expect(mockStdin.write).toHaveBeenCalledWith(
				expect.stringContaining('"method":"initialize"'),
			);

			const result = await promise;
			expect(result.status).toBe('available');
			expect(result.remainingPercentage).toBe(55);
			expect(result.plan).toBe('plus');
			expect(result.credits).toBe('balance: 12, resets: 2');
			expect(result.windows).toHaveLength(1);
			expect(result.windows?.[0]).toEqual({
				name: '5-hour',
				sourceSlot: 'primary',
				durationMins: 300,
				usedPercent: 45,
				resetsAt: new Date(1700000000 * 1000).toISOString(),
			});
		});

		// The live `codex-cli 0.147.0` shape (issue #669): hourly sessions are gone, so the
		// only window Codex reports is a weekly one, and it arrives in the `primary` slot.
		it('labels a weekly window in the primary slot from its reported duration', async () => {
			const { promise } = runExchange({
				rateLimits: {
					limitId: 'codex',
					limitName: null,
					primary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: 1787046281 },
					secondary: null,
					credits: { hasCredits: false, unlimited: false, balance: '0' },
					planType: 'plus',
					rateLimitReachedType: null,
				},
			});

			const result = await promise;
			expect(result.status).toBe('available');
			expect(result.windows).toEqual([
				{
					name: 'Weekly',
					sourceSlot: 'primary',
					durationMins: 10080,
					usedPercent: 28,
					resetsAt: new Date(1787046281 * 1000).toISOString(),
				},
			]);
			expect(result.remainingPercentage).toBe(72);
			expect(result.resetTime).toBe(new Date(1787046281 * 1000).toISOString());
		});

		it('names each slot from its own duration and reports the most-used window', async () => {
			const { promise } = runExchange({
				rateLimits: {
					limitId: 'codex',
					planType: 'pro',
					primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1700000000 },
					secondary: { usedPercent: 80, windowDurationMins: 10080, resetsAt: 1700600000 },
				},
			});

			const result = await promise;
			expect(result.windows).toMatchObject([
				{ name: '5-hour', sourceSlot: 'primary' },
				{ name: 'Weekly', sourceSlot: 'secondary' },
			]);
			expect(result.remainingPercentage).toBe(20);
			expect(result.resetTime).toBe(new Date(1700600000 * 1000).toISOString());
		});

		it('falls back to a neutral name when no duration is reported', async () => {
			const { promise } = runExchange({
				rateLimits: {
					limitId: 'codex',
					primary: { usedPercent: 5 },
					secondary: null,
				},
			});

			const result = await promise;
			expect(result.windows).toEqual([
				{
					name: 'Usage limit',
					sourceSlot: 'primary',
					durationMins: undefined,
					usedPercent: 5,
					resetsAt: undefined,
				},
			]);
		});

		it('returns error if app-server fails during initialize', async () => {
			const mockStdin = { write: vi.fn() };
			const mockStdout = new EventEmitter();
			const mockChild = Object.assign(new EventEmitter(), {
				stdin: mockStdin,
				stdout: mockStdout,
				kill: vi.fn(),
			});

			mockSpawn.mockReturnValue(mockChild);

			const promise = queryCodexQuota();

			mockStdout.emit(
				'data',
				Buffer.from(
					`${JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						error: { code: -32600, message: 'Invalid request' },
					})}\n`,
				),
			);

			const result = await promise;
			expect(result.status).toBe('error');
			expect(result.error).toContain('Initialize error');
		});
	});

	describe('queryAntigravityQuota', () => {
		it('reports every window of both limit groups from the /quota answer', async () => {
			mockAgy();

			const result = await queryAntigravityQuota();

			expect(result?.status).toBe('available');
			// Both groups, both of their windows each — they move independently, so
			// none of the four may be collapsed away or picked between.
			expect(result?.windows).toEqual([
				{
					name: 'Gemini Models — Weekly',
					durationMins: 10080,
					usedPercent: 2,
					resetsAt: '2026-08-18T09:20:47Z',
				},
				{
					name: 'Gemini Models — 5-hour',
					durationMins: 300,
					usedPercent: 0,
					resetsAt: '2026-08-11T21:55:11Z',
				},
				{
					name: 'Claude and GPT models — Weekly',
					durationMins: 10080,
					usedPercent: 0,
					resetsAt: '2026-08-18T16:58:40Z',
				},
				{
					name: 'Claude and GPT models — 5-hour',
					durationMins: 300,
					usedPercent: 0,
					resetsAt: '2026-08-11T21:58:40Z',
				},
			]);
			// `remaining_fraction` is remaining, `usedPercent` is used — the headline
			// tracks the tightest window rather than whichever group came first.
			expect(result?.remainingPercentage).toBe(98);
			expect(result?.resetTime).toBe('2026-08-18T09:20:47Z');
		});

		it('surfaces a zero credit balance as zero rather than as missing data', async () => {
			mockAgy();

			await expect(queryAntigravityQuota()).resolves.toMatchObject({ credits: 'balance: 0' });
		});

		it('passes --output-format before -p, with the slash command last', async () => {
			mockAgy();

			await queryAntigravityQuota();

			// agy's `-p` is a value flag: a flag between it and the prompt is
			// swallowed as the prompt (ai/RULES.md §6).
			expect(probeArgsFor('/quota')).toEqual(['--output-format', 'json', '-p', '/quota']);
			expect(probeArgsFor('/credits')).toEqual(['--output-format', 'json', '-p', '/credits']);
		});

		it('never probes a build whose help does not declare --output-format', async () => {
			mockAgy({ help: AGY_OLD_HELP });

			await expect(queryAntigravityQuota()).resolves.toBeUndefined();
			expect(probeArgsFor('/quota')).toBeUndefined();
		});

		it('keeps the fallback when the build answers without a command block', async () => {
			mockAgy({ quota: AGY_PROMPT_ANSWER });

			// The observed capability, not a version compare: no block, no live read —
			// and no second probe spent on a binary that just showed it cannot answer.
			await expect(queryAntigravityQuota()).resolves.toBeUndefined();
			await expect(queryAntigravityQuota()).resolves.toBeUndefined();
			expect(
				mockExecFile.mock.calls.filter(
					(args: unknown[]) => Array.isArray(args[1]) && args[1].includes('/quota'),
				),
			).toHaveLength(1);
			expect(probeArgsFor('/credits')).toBeUndefined();
		});

		it('reports an error envelope instead of treating it as an unsupported command', async () => {
			mockAgy({
				quota: Object.assign(new Error('agy exited 1'), { code: 1, stdout: AGY_ERROR_ANSWER }),
			});

			await expect(queryAntigravityQuota()).resolves.toMatchObject({
				status: 'error',
				error: expect.stringContaining('Authentication expired'),
			});
		});

		it('reports why a probe that timed out failed', async () => {
			mockAgy({ quota: Object.assign(new Error('timed out'), { killed: true }) });

			const result = await queryAntigravityQuota();

			expect(result?.status).toBe('error');
			expect(result?.error).toContain('/quota probe failed');
			expect(result?.error).toContain('timed out');
		});

		it('reports why a probe that could not spawn failed', async () => {
			mockAgy({ quota: Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }) });

			await expect(queryAntigravityQuota()).resolves.toMatchObject({ status: 'error' });
		});

		it('keeps the window data when only the credits probe fails', async () => {
			mockAgy({ credits: Object.assign(new Error('timed out'), { killed: true }) });

			const result = await queryAntigravityQuota();

			expect(result?.status).toBe('available');
			expect(result?.credits).toBeUndefined();
			expect(result?.windows).toHaveLength(4);
		});
	});

	describe('queryClaudeQuota', () => {
		it('reads the session and weekly windows out of the captured /usage prose', async () => {
			stubClaudeProbes(CAPTURED_CLAUDE_USAGE_ENVELOPE);
			vi.useFakeTimers();
			try {
				vi.setSystemTime(new Date('2026-08-11T18:05:00.000Z'));
				const result = await queryClaudeQuota();

				expect(result.status).toBe('available');
				// `Current week (Fable): 0% used` is dropped: an untouched model-scoped
				// limit would only add a 100%-remaining row to the card.
				expect(result.windows).toEqual([
					{ name: 'Current session', usedPercent: 14, resetsAt: '2026-08-11T21:59:00.000Z' },
					{
						name: 'Current week (all models)',
						usedPercent: 34,
						resetsAt: '2026-08-14T14:59:00.000Z',
					},
				]);
				// The weekly window is the binding one, so it — not the fresher session
				// window — is what the snapshot's headline numbers report.
				expect(result.remainingPercentage).toBe(66);
				expect(result.resetTime).toBe('2026-08-14T14:59:00.000Z');
			} finally {
				vi.useRealTimers();
			}
		});

		it('probes without persisting a session or loading project customizations', async () => {
			stubClaudeProbes(CAPTURED_CLAUDE_USAGE_ENVELOPE);

			await queryClaudeQuota();

			expect(claudeUsageCall()).toEqual([
				'--safe-mode',
				'--no-session-persistence',
				'--output-format',
				'json',
				'-p',
				'/usage',
			]);
		});

		it('surfaces a model-scoped weekly window once it has been used', async () => {
			const result = await readClaudeQuota(
				[
					'Current session: 14% used · resets Aug 11 at 11:59pm (Europe/Warsaw)',
					'Current week (all models): 34% used · resets Aug 14 at 4:59pm (Europe/Warsaw)',
					'Current week (Fable): 12% used',
					'Current week (Sonnet): 0% used',
				].join('\n'),
			);

			expect(result.windows?.map((window) => window.name)).toEqual([
				'Current session',
				'Current week (all models)',
				'Current week (Fable)',
			]);
			expect(result.windows?.[2]).toEqual({ name: 'Current week (Fable)', usedPercent: 12 });
		});

		it('resolves the year the prose omits from the reset being near', async () => {
			const result = await readClaudeQuota(
				'Current week (all models): 12% used · resets Jan 2 at 5pm (Europe/Warsaw)',
				'2026-12-30T10:00:00.000Z',
			);

			expect(result.windows?.[0]?.resetsAt).toBe('2027-01-02T16:00:00.000Z');
		});

		it('degrades an unresolvable reset time to a percentage-only window', async () => {
			const result = await readClaudeQuota(
				[
					// An abbreviation is not an IANA zone, so the instant it names is unknown.
					'Current session: 14% used · resets Aug 11 at 11:59pm (CEST)',
					// Further away than any window Claude reports — a stale or wrong hint.
					'Current week (all models): 34% used · resets Nov 14 at 4:59pm (Europe/Warsaw)',
				].join('\n'),
			);

			expect(result.status).toBe('available');
			expect(result.windows).toEqual([
				{ name: 'Current session', usedPercent: 14 },
				{ name: 'Current week (all models)', usedPercent: 34 },
			]);
			expect(result.windows?.[0]).not.toHaveProperty('resetsAt');
			expect(result.windows?.[1]).not.toHaveProperty('resetsAt');
		});

		it('reports no live data when the answer carries no recognized usage line', async () => {
			const result = await readClaudeQuota(
				'You are currently using your subscription to power your Claude Code usage\n\nUsage details are unavailable right now.',
			);

			expect(result.status).toBe('unavailable');
			expect(result.error).toContain('no recognized usage window');
			expect(result.windows).toBeUndefined();
		});

		it('reports no live data when the output is not the print-mode envelope', async () => {
			stubClaudeProbes("error: unknown option '--no-session-persistence'");

			const result = await queryClaudeQuota();

			expect(result.status).toBe('unavailable');
			expect(result.error).toContain('no usage report');
		});

		it('reports no live data when the run itself errored', async () => {
			stubClaudeProbes(
				JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }),
			);

			const result = await queryClaudeQuota();

			expect(result.status).toBe('unavailable');
			expect(result.error).toContain('no usage report');
		});

		it('reports an error when the probe cannot run', async () => {
			stubClaudeProbes(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));

			const result = await queryClaudeQuota();

			expect(result.status).toBe('error');
			expect(result.error).toContain('spawn claude ENOENT');
		});

		it('names a timed-out probe as such', async () => {
			stubClaudeProbes(Object.assign(new Error('Command failed'), { killed: true }));

			const result = await queryClaudeQuota();

			expect(result.status).toBe('error');
			expect(result.error).toContain('timed out after 15000ms');
		});
	});

	describe('discoverCliQuotas', () => {
		const antigravitySnapshot = async () => {
			const snapshots = await discoverCliQuotas();
			return snapshots.find((snapshot) => snapshot.cli === 'antigravity');
		};

		beforeEach(() => {
			mockCodexAppServerUnavailable();
		});

		it('publishes Antigravity as a live snapshot carrying its windows', async () => {
			mockAgy();

			const snapshot = await antigravitySnapshot();

			expect(snapshot).toMatchObject({
				cli: 'antigravity',
				status: 'available',
				source: 'live',
				remainingPercentage: 98,
				credits: 'balance: 0',
			});
			expect(snapshot?.windows).toHaveLength(4);
			expect(snapshot?.error).toBeUndefined();
		});

		it('keeps the run-derived fallback, with no error, when agy cannot answer', async () => {
			mockAgy({ help: AGY_OLD_HELP });

			const snapshot = await antigravitySnapshot();

			expect(snapshot).toMatchObject({ status: 'available', source: 'fallback' });
			expect(snapshot?.error).toBeUndefined();
			expect(snapshot?.windows).toBeUndefined();
		});

		it('does not retry a command that already answered as an ordinary prompt', async () => {
			mockAgy({ quota: AGY_PROMPT_ANSWER });

			await antigravitySnapshot();
			await antigravitySnapshot();

			expect(
				mockExecFile.mock.calls.filter(
					(args: unknown[]) => Array.isArray(args[1]) && args[1].includes('/quota'),
				),
			).toHaveLength(1);
		});

		it('degrades to the fallback and records why when the probe fails', async () => {
			mockAgy({ quota: Object.assign(new Error('timed out'), { killed: true }) });

			const snapshot = await antigravitySnapshot();

			expect(snapshot).toMatchObject({ status: 'error', source: 'fallback' });
			expect(snapshot?.error).toContain('/quota probe failed');
		});

		it('records the command error when agy exits with an error envelope', async () => {
			mockAgy({
				quota: Object.assign(new Error('agy exited 1'), { code: 1, stdout: AGY_ERROR_ANSWER }),
			});

			const snapshot = await antigravitySnapshot();

			expect(snapshot).toMatchObject({ status: 'error', source: 'fallback' });
			expect(snapshot?.error).toContain('Authentication expired');
		});

		it('skips the live probe entirely when a cheap discovery is asked for', async () => {
			mockAgy();

			const snapshots = await discoverCliQuotas(true);

			expect(snapshots.find((snapshot) => snapshot.cli === 'antigravity')).toMatchObject({
				status: 'available',
				source: 'fallback',
			});
			expect(probeArgsFor('/quota')).toBeUndefined();
		});

		it('reports claude as a live snapshot carrying its usage windows', async () => {
			stubClaudeProbes(CAPTURED_CLAUDE_USAGE_ENVELOPE);

			const snapshots = await discoverCliQuotas();
			const claude = snapshots.find((snapshot) => snapshot.cli === 'claude');

			expect(claude?.status).toBe('available');
			expect(claude?.source).toBe('live');
			expect(claude?.windows).toHaveLength(2);
			expect(claude?.remainingPercentage).toBe(66);
		});

		it('degrades to the run-derived fallback and records why the probe did not answer', async () => {
			stubClaudeProbes(claudeUsageEnvelope('Usage details are unavailable right now.'));

			const snapshots = await discoverCliQuotas();
			const claude = snapshots.find((snapshot) => snapshot.cli === 'claude');

			// Today's behaviour, not an error: an operator on a build or auth mode that
			// cannot answer keeps the run-derived card rather than a red diagnostic row.
			expect(claude?.status).toBe('available');
			expect(claude?.source).toBe('fallback');
			expect(claude?.windows).toBeUndefined();
			expect(claude?.error).toContain('no recognized usage window');
		});

		it('skips the live claude probe on a cheap pass', async () => {
			stubClaudeProbes(CAPTURED_CLAUDE_USAGE_ENVELOPE);

			const snapshots = await discoverCliQuotas(true);

			expect(claudeUsageCall()).toBeUndefined();
			expect(snapshots.find((snapshot) => snapshot.cli === 'claude')?.source).toBe('fallback');
		});
	});
});
