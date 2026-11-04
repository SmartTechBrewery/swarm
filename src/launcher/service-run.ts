/**
 * `swarm-worker service-run <workerId>` — the keep-alive loop a Windows Task
 * Scheduler task runs (issue #1323; `./windows-task.ts`). Internal: an operator
 * never types it, the task's action does.
 *
 * It is launchd's `KeepAlive` + `ThrottleInterval 30`, done by hand, because Task
 * Scheduler starts nothing again once its action exits 0 — and exit 0 is exactly
 * how a daemon hands itself back to its supervisor after an ADR-006/007 update. So
 * the loop starts `swarm-worker run <workerId>` as a child, waits for it, and starts
 * it again {@link THROTTLE_MS} later, whatever its exit code. Each start is a
 * **fresh launcher process**, which is what puts the runtime the daemon just
 * selected into service.
 *
 * It records its own pid in `<profileDir>/service.pid` — what `swarm-worker agent
 * uninstall` kills the process tree from, since `schtasks /End` leaves the tree
 * running — and appends the child's output and its own timestamped lines to
 * `<profileDir>/logs/service.log` (the daemon keeps writing `worker.log` itself).
 * SIGINT / SIGTERM / SIGBREAK stop the child and then the loop.
 *
 * Nothing resolves a `PATH` here, unlike `agent_path()` in `bin/swarm-worker-agent`:
 * a logon task runs in the user's own logon environment, whose `PATH` already holds
 * the per-user `node`, `git` and agent CLIs.
 */

import { spawn } from 'node:child_process';
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { LAUNCHER_INSTALL_ROOT } from './main.js';
import { SERVICE_LOG_FILE, SERVICE_PID_FILE } from './windows-task.js';
import { isValidWorkerId, workerProfileDir } from './worker-profile.js';

/** How long the loop waits before starting the worker again — the plist's `ThrottleInterval`. */
export const THROTTLE_MS = 30_000;

/** A started worker: how it ends, and how to stop it. */
export interface ServiceChild {
	exited: Promise<number>;
	kill(signal?: NodeJS.Signals): void;
}

export interface ServiceRunDeps {
	/** Injectable so tests never touch the real home directory, process or clock. */
	homeDir?: string;
	execPath?: string;
	launcherRoot?: string;
	pid?: number;
	spawnChild?: (
		file: string,
		args: string[],
		options: { cwd: string; logFd: number },
	) => ServiceChild;
	/** Waits `ms`, or less once `signal` aborts. */
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	now?: () => number;
	/** Registers the stop handler; answers how to unregister it. */
	onSignal?: (handler: (signal: NodeJS.Signals) => void) => () => void;
	/** Stop after this many starts — for tests; unbounded by default. */
	maxRuns?: number;
	stderr?: (line: string) => void;
}

function defaultSpawnChild(
	file: string,
	args: string[],
	{ cwd, logFd }: { cwd: string; logFd: number },
): ServiceChild {
	const child = spawn(file, args, { cwd, stdio: ['ignore', logFd, logFd], windowsHide: true });
	const exited = new Promise<number>((resolve) => {
		child.once('error', () => resolve(1));
		child.once('exit', (code) => resolve(code ?? 1));
	});
	return { exited, kill: (signal) => child.kill(signal) };
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		signal.addEventListener('abort', done, { once: true });
		function done() {
			clearTimeout(timer);
			signal.removeEventListener('abort', done);
			resolve();
		}
	});
}

function defaultOnSignal(handler: (signal: NodeJS.Signals) => void): () => void {
	const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
	if (process.platform === 'win32') signals.push('SIGBREAK');
	for (const signal of signals) process.on(signal, handler);
	return () => {
		for (const signal of signals) process.off(signal, handler);
	};
}

export async function runService(argv: string[], deps: ServiceRunDeps = {}): Promise<number> {
	const stderr = deps.stderr ?? ((line: string) => console.error(line));
	const [workerId, ...extra] = argv;
	if (workerId === undefined || extra.length > 0 || !isValidWorkerId(workerId)) {
		stderr('usage: swarm-worker service-run <workerId>');
		return 1;
	}
	const dir = workerProfileDir(workerId, deps.homeDir);
	const logDir = join(dir, 'logs');
	mkdirSync(logDir, { recursive: true });
	const pidPath = join(dir, SERVICE_PID_FILE);
	const pid = String(deps.pid ?? process.pid);
	const now = deps.now ?? Date.now;
	const logFd = openSync(join(logDir, SERVICE_LOG_FILE), 'a');
	const log = (message: string) =>
		writeSync(logFd, `${new Date(now()).toISOString()} swarm-worker service-run: ${message}\n`);

	writeFileSync(pidPath, `${pid}\n`);
	try {
		await keepAlive(workerId, dir, logFd, log, deps);
	} finally {
		log('stopped');
		closeSync(logFd);
		removeOwnPidFile(pidPath, pid);
	}
	return 0;
}

/** Start the worker, wait for it, and start it again {@link THROTTLE_MS} later — until stopped. */
async function keepAlive(
	workerId: string,
	dir: string,
	logFd: number,
	log: (message: string) => void,
	deps: ServiceRunDeps,
): Promise<void> {
	const entry = join(deps.launcherRoot ?? LAUNCHER_INSTALL_ROOT, 'bin', 'swarm-worker.js');
	const execPath = deps.execPath ?? process.execPath;
	const spawnChild = deps.spawnChild ?? defaultSpawnChild;
	const sleep = deps.sleep ?? defaultSleep;
	const maxRuns = deps.maxRuns ?? Number.POSITIVE_INFINITY;
	const wake = new AbortController();
	let stopping = false;
	let child: ServiceChild | undefined;
	const unregister = (deps.onSignal ?? defaultOnSignal)((signal) => {
		stopping = true;
		log(`${signal} received — stopping`);
		child?.kill(signal);
		wake.abort();
	});
	try {
		for (let runs = 1; !stopping; runs++) {
			log(`starting worker ${workerId}`);
			child = spawnChild(execPath, [entry, 'run', workerId], { cwd: dir, logFd });
			const code = await child.exited;
			child = undefined;
			log(`worker ${workerId} exited with code ${code}`);
			if (stopping || runs >= maxRuns) return;
			log(`starting it again in ${THROTTLE_MS / 1000}s`);
			await sleep(THROTTLE_MS, wake.signal);
		}
	} finally {
		unregister();
	}
}

/** Remove the pid file only while it is still ours: a reinstall may have started the next loop. */
function removeOwnPidFile(pidPath: string, pid: string): void {
	try {
		if (readFileSync(pidPath, 'utf8').trim() === pid) rmSync(pidPath, { force: true });
	} catch {
		// Already gone.
	}
}
