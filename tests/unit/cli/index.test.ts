import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/cli/commands/init.js', () => ({ run: vi.fn(async () => 0) }));
vi.mock('@/cli/commands/start.js', () => ({ run: vi.fn(async () => 0) }));
vi.mock('@/cli/commands/stop.js', () => ({ run: vi.fn(async () => 0) }));
vi.mock('@/cli/commands/status.js', () => ({ run: vi.fn(async () => 0) }));
vi.mock('@/cli/commands/logs.js', () => ({ run: vi.fn(async () => 0) }));
vi.mock('@/cli/commands/queue.js', () => ({ run: vi.fn(async () => 0) }));
vi.mock('@/cli/commands/run.js', () => ({ run: vi.fn(async () => 0) }));

import { run as queueRun } from '@/cli/commands/queue.js';
import { run as runCommandRun } from '@/cli/commands/run.js';
import { run as startRun } from '@/cli/commands/start.js';
import { run } from '@/cli/index.js';

describe('cli dispatch', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('dispatches to the matching command with the remaining args', async () => {
		const code = await run(['start', '--build']);
		expect(startRun).toHaveBeenCalledWith(['--build']);
		expect(code).toBe(0);
	});

	it('dispatches queue subcommands', async () => {
		const code = await run(['queue', 'clear']);
		expect(queueRun).toHaveBeenCalledWith(['clear']);
		expect(code).toBe(0);
	});

	it('dispatches run subcommands', async () => {
		const code = await run(['run', 'reset', 'r1']);
		expect(runCommandRun).toHaveBeenCalledWith(['reset', 'r1']);
		expect(code).toBe(0);
	});

	it('prints usage and exits 0 with no command', async () => {
		expect(await run([])).toBe(0);
	});

	it('prints usage and exits 0 for --help', async () => {
		expect(await run(['--help'])).toBe(0);
	});

	it('exits 1 for an unknown command', async () => {
		expect(await run(['frobnicate'])).toBe(1);
	});

	it('catches a command error and exits 1', async () => {
		vi.mocked(startRun).mockRejectedValueOnce(new Error('boom'));
		expect(await run(['start'])).toBe(1);
	});
});
