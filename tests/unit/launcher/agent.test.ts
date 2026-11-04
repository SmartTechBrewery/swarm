/**
 * `swarm-worker agent` (issue #1323): routed to the host's service manager, with the
 * manager and the LaunchAgent script faked.
 */

import { describe, expect, it, vi } from 'vitest';
import { runAgent } from '@/launcher/agent.js';
import { launchdInstallerPath, type WorkerServiceManager } from '@/launcher/service-manager.js';

function fakeManager(overrides: Partial<WorkerServiceManager> = {}): WorkerServiceManager {
	return {
		name: 'Task Scheduler',
		install: vi.fn(async () => ({ kind: 'installed' as const })),
		uninstall: vi.fn(async () => 0),
		status: vi.fn(async () => ({ output: 'Status: Running', installed: true })),
		logs: vi.fn(async () => 0),
		...overrides,
	};
}

function io() {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) };
}

describe('swarm-worker agent', () => {
	it.each([
		['install', ['install', '--profile', 'w-1']],
		['status', ['status', '--profile', 'w-1']],
		['update', ['update']],
	])('hands %s to swarm-worker-agent verbatim on macOS', async (_action, argv) => {
		const runCommand = vi.fn(async () => 5);
		const manager = fakeManager();

		expect(await runAgent(argv, { platform: 'darwin', manager, runCommand })).toBe(5);

		expect(runCommand).toHaveBeenCalledExactlyOnceWith(launchdInstallerPath(), argv);
		expect(manager.install).not.toHaveBeenCalled();
	});

	it('routes install, uninstall, status and logs to the Windows manager', async () => {
		const manager = fakeManager();
		const runCommand = vi.fn();
		const streams = io();
		const deps = { platform: 'win32' as const, manager, runCommand, ...streams };

		expect(await runAgent(['install', '--profile', 'w-1'], deps)).toBe(0);
		expect(await runAgent(['uninstall', '--profile', 'w-1'], deps)).toBe(0);
		expect(await runAgent(['status', '--profile', 'w-1'], deps)).toBe(0);
		expect(await runAgent(['logs', '--profile', 'w-1'], deps)).toBe(0);

		for (const method of ['install', 'uninstall', 'status', 'logs'] as const)
			expect(manager[method]).toHaveBeenCalledExactlyOnceWith('w-1');
		expect(streams.out).toEqual(['Status: Running']);
		expect(runCommand).not.toHaveBeenCalled();
	});

	it('prints a failed Windows install’s reason and exits 1', async () => {
		const manager = fakeManager({
			install: vi.fn(async () => ({ kind: 'failed' as const, reason: 'access denied' })),
		});
		const streams = io();
		expect(
			await runAgent(['install', '--profile', 'w-1'], { platform: 'win32', manager, ...streams }),
		).toBe(1);
		expect(streams.err).toEqual(['swarm-worker agent: access denied']);
	});

	it('exits 1 for the status of a worker with no task', async () => {
		const manager = fakeManager({
			status: vi.fn(async () => ({
				output: 'no agent installed for worker w-1',
				installed: false,
			})),
		});
		const streams = io();
		expect(
			await runAgent(['status', '--profile', 'w-1'], { platform: 'win32', manager, ...streams }),
		).toBe(1);
		expect(streams.err).toEqual(['swarm-worker agent: no agent installed for worker w-1']);
	});

	it('refuses update for a profile worker on Windows', async () => {
		const manager = fakeManager();
		const streams = io();
		expect(
			await runAgent(['update', '--profile', 'w-1'], { platform: 'win32', manager, ...streams }),
		).toBe(1);
		expect(streams.err[0]).toMatch(/update restarts clone agents only/);
	});

	it.each([
		['darwin', fakeManager()],
		['win32', fakeManager()],
	] as const)('requires --profile on %s', async (platform, manager) => {
		const runCommand = vi.fn();
		const streams = io();
		expect(await runAgent(['install'], { platform, manager, runCommand, ...streams })).toBe(1);
		expect(streams.err).toEqual(['swarm-worker agent: install needs --profile <workerId>']);
		expect(runCommand).not.toHaveBeenCalled();
	});

	it('names the foreground command where there is no service manager', async () => {
		const streams = io();
		expect(
			await runAgent(['install', '--profile', 'w-1'], {
				platform: 'linux',
				manager: null,
				...streams,
			}),
		).toBe(1);
		expect(streams.err).toEqual([
			'swarm-worker agent: linux has no supported service manager — run the worker with: swarm-worker run w-1',
		]);
	});

	it('prints the usage for an unknown action and exits 1', async () => {
		const streams = io();
		expect(
			await runAgent(['restart'], { platform: 'win32', manager: fakeManager(), ...streams }),
		).toBe(1);
		expect(streams.out[0]).toMatch(/^swarm-worker agent — /);
		expect(streams.err).toEqual(['swarm-worker agent: unknown action: restart']);
	});
});
