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

import { isBinaryRunnable, queryCodexQuota } from '@/harness/quota-discovery.js';

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
});
