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
	});
});
