import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
	execFile: (...args: unknown[]) => mockExecFile(...args),
}));

import { probeBinary } from '@/harness/binary-probe.js';

/** `execFile`'s node-style callback, always its last argument. */
type ExecFileCallback = (err: unknown, stdout: unknown, stderr: unknown) => void;

/** Settle the promisified `execFile` call `mockExecFile` was invoked with. */
function settle(args: unknown[], err: unknown, stdout: unknown = null): void {
	(args[args.length - 1] as ExecFileCallback)(err, stdout, '');
}

/** Drive the promisified `execFile` callback with a success. */
function succeed(): void {
	mockExecFile.mockImplementation((...args: unknown[]) => settle(args, null, { stdout: '1.0.0' }));
}

/** Fail the next `execFile` call with `err`. */
function failWith(err: unknown): void {
	mockExecFile.mockImplementation((...args: unknown[]) => settle(args, err));
}

/** The error shape `execFile` reports when its own timeout kills the child. */
const TIMEOUT_ERROR = Object.assign(new Error('spawn timed out'), {
	killed: true,
	code: null,
	signal: 'SIGTERM',
});

describe('probeBinary', () => {
	beforeEach(() => {
		mockExecFile.mockReset();
	});

	it('reports present when the probe runs', async () => {
		succeed();
		await expect(probeBinary('claude')).resolves.toBe('present');
	});

	it('reports absent only on ENOENT', async () => {
		failWith(Object.assign(new Error('not found'), { code: 'ENOENT' }));
		await expect(probeBinary('missing-cli')).resolves.toBe('absent');
	});

	// The bug in issue #559: a timed-out probe used to be indistinguishable from a
	// binary that is not installed, so a loaded machine declared an installed CLI
	// absent and the daemon died on the handshake.
	it('reports indeterminate when the probe times out', async () => {
		failWith(TIMEOUT_ERROR);
		await expect(probeBinary('claude')).resolves.toBe('indeterminate');
	});

	it('reports indeterminate on a spawn ETIMEDOUT', async () => {
		failWith(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
		await expect(probeBinary('claude')).resolves.toBe('indeterminate');
	});

	it('does not re-run a timed-out binary without arguments', async () => {
		failWith(TIMEOUT_ERROR);
		await probeBinary('claude');
		expect(mockExecFile).toHaveBeenCalledTimes(1);
	});

	it('confirms a binary that exits non-zero with a bare invocation', async () => {
		mockExecFile
			.mockImplementationOnce((...args: unknown[]) =>
				settle(args, Object.assign(new Error('unknown flag'), { code: 1 })),
			)
			.mockImplementationOnce((...args: unknown[]) => settle(args, null, { stdout: 'usage' }));
		await expect(probeBinary('agy')).resolves.toBe('present');
		expect(mockExecFile).toHaveBeenCalledTimes(2);
	});

	it('reports indeterminate when the confirming bare invocation times out', async () => {
		mockExecFile
			.mockImplementationOnce((...args: unknown[]) =>
				settle(args, Object.assign(new Error('unknown flag'), { code: 1 })),
			)
			.mockImplementationOnce((...args: unknown[]) => settle(args, TIMEOUT_ERROR));
		await expect(probeBinary('agy')).resolves.toBe('indeterminate');
	});

	it('passes the requested timeout budget through', async () => {
		succeed();
		await probeBinary('claude', { timeoutMs: 15_000 });
		expect(mockExecFile).toHaveBeenCalledWith(
			'claude',
			['--version'],
			expect.objectContaining({ timeout: 15_000 }),
			expect.any(Function),
		);
	});
});
