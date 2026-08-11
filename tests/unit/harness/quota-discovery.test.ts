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

import {
	discoverCliQuotas,
	isBinaryRunnable,
	queryClaudeQuota,
	queryCodexQuota,
} from '@/harness/quota-discovery.js';

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
		it('negotiates JSON-RPC initialize and rateLimits read successfully', async () => {
			const mockStdin = {
				write: vi.fn(),
			};
			const mockStdout = new EventEmitter();
			const mockChild = Object.assign(new EventEmitter(), {
				stdin: mockStdin,
				stdout: mockStdout,
				kill: vi.fn(),
			});

			mockSpawn.mockReturnValue(mockChild);

			const promise = queryCodexQuota();

			// Simulate initialize response from app-server
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

			// Expect initialize sent
			expect(mockStdin.write).toHaveBeenCalledWith(
				expect.stringContaining('"method":"initialize"'),
			);

			// Simulate rateLimits/read response
			mockStdout.emit(
				'data',
				Buffer.from(
					`${JSON.stringify({
						jsonrpc: '2.0',
						id: 2,
						result: {
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
						},
					})}\n`,
				),
			);

			const result = await promise;
			expect(result.status).toBe('available');
			expect(result.remainingPercentage).toBe(55);
			expect(result.plan).toBe('plus');
			expect(result.credits).toBe('balance: 12, resets: 2');
			expect(result.windows).toHaveLength(1);
			expect(result.windows?.[0]).toEqual({
				name: 'Primary (5-hour)',
				durationMins: 300,
				usedPercent: 45,
				resetsAt: new Date(1700000000 * 1000).toISOString(),
			});
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
		beforeEach(() => {
			// Codex's app-server probe isn't the subject here — fail it fast so the
			// loop reaches its own fallback branch without waiting on a timeout.
			mockSpawn.mockImplementation(() => {
				throw new Error('codex app-server unavailable in test');
			});
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
