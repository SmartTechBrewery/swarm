/**
 * `swarm-worker service-run` (issue #1323): the keep-alive loop a Windows task runs,
 * under a temporary home with the child process, the sleep and the signals faked.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runService, type ServiceChild, THROTTLE_MS } from '@/launcher/service-run.js';
import { workerProfileDir } from '@/launcher/worker-profile.js';

const WORKER_ID = 'w-1';
const NOW = Date.parse('2026-11-04T12:00:00.000Z');
let home: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-service-run-')));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

const pidFile = () => join(workerProfileDir(WORKER_ID, home), 'service.pid');
const serviceLog = () =>
	readFileSync(join(workerProfileDir(WORKER_ID, home), 'logs', 'service.log'), 'utf8');

/** A child per exit code, recording how each was started. */
function children(codes: number[]) {
	const started: Array<{ file: string; args: string[]; cwd: string }> = [];
	const spawnChild = vi.fn((file: string, args: string[], { cwd }: { cwd: string }) => {
		started.push({ file, args, cwd });
		const code = codes[started.length - 1] ?? 0;
		return { exited: Promise.resolve(code), kill: vi.fn() } satisfies ServiceChild;
	});
	return { spawnChild, started };
}

describe('swarm-worker service-run', () => {
	it('starts the worker again after it exits 0 and after it fails, throttled', async () => {
		const { spawnChild, started } = children([0, 3, 0]);
		const sleep = vi.fn(async () => {});
		let pidWhileRunning = '';
		spawnChild.mockImplementationOnce((file, args, { cwd }) => {
			pidWhileRunning = readFileSync(pidFile(), 'utf8');
			started.push({ file, args, cwd });
			return { exited: Promise.resolve(0), kill: vi.fn() };
		});

		const code = await runService([WORKER_ID], {
			homeDir: home,
			execPath: '/usr/bin/node',
			launcherRoot: '/opt/launcher',
			pid: 4242,
			now: () => NOW,
			spawnChild,
			sleep,
			onSignal: () => () => {},
			maxRuns: 3,
		});

		expect(code).toBe(0);
		expect(started).toHaveLength(3);
		expect(started[0]).toEqual({
			file: '/usr/bin/node',
			args: [join('/opt/launcher', 'bin', 'swarm-worker.js'), 'run', WORKER_ID],
			cwd: workerProfileDir(WORKER_ID, home),
		});
		expect(sleep).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(THROTTLE_MS, expect.any(AbortSignal));
		// A fingerprint, not a bare pid: enough to tell this loop from a later owner of 4242.
		expect(JSON.parse(pidWhileRunning)).toEqual({
			pid: 4242,
			workerId: WORKER_ID,
			startedAt: new Date(NOW).toISOString(),
		});
		expect(existsSync(pidFile())).toBe(false);
		const log = serviceLog();
		expect(log).toContain('exited with code 3');
		expect(log).toContain('starting it again in 30s');
		expect(log).toContain('stopped');
	});

	it('stops the child and the loop on a signal', async () => {
		let stop: (signal: NodeJS.Signals) => void = () => {};
		const kill = vi.fn();
		let exit: (code: number) => void = () => {};
		const spawnChild = vi.fn(() => ({
			exited: new Promise<number>((resolve) => {
				exit = resolve;
			}),
			kill,
		}));
		const unregister = vi.fn();

		const running = runService([WORKER_ID], {
			homeDir: home,
			pid: 4242,
			spawnChild,
			sleep: async () => {},
			onSignal: (handler) => {
				stop = handler;
				return unregister;
			},
		});
		await vi.waitFor(() => expect(spawnChild).toHaveBeenCalled());
		stop('SIGTERM');
		expect(kill).toHaveBeenCalledWith('SIGTERM');
		exit(1);

		expect(await running).toBe(0);
		expect(spawnChild).toHaveBeenCalledTimes(1);
		expect(unregister).toHaveBeenCalled();
		expect(existsSync(pidFile())).toBe(false);
		expect(serviceLog()).toContain('SIGTERM received — stopping');
	});

	it('leaves a pid file the next loop has since written', async () => {
		const next = JSON.stringify({ pid: 4242, workerId: WORKER_ID, startedAt: 'later' });
		const spawnChild = vi.fn(() => {
			// A reinstall started the next loop, which recycled this one's pid.
			writeFileSync(pidFile(), `${next}\n`);
			return { exited: Promise.resolve(0), kill: vi.fn() } satisfies ServiceChild;
		});

		await runService([WORKER_ID], {
			homeDir: home,
			pid: 4242,
			now: () => NOW,
			spawnChild,
			sleep: async () => {},
			onSignal: () => () => {},
			maxRuns: 1,
		});

		expect(readFileSync(pidFile(), 'utf8')).toBe(`${next}\n`);
	});

	it.each([[[]], [['../evil']], [['w-1', 'extra']]])('refuses %j', async (argv) => {
		const stderr = vi.fn();
		expect(await runService(argv, { homeDir: home, stderr })).toBe(1);
		expect(stderr).toHaveBeenCalledWith('usage: swarm-worker service-run <workerId>');
	});
});
