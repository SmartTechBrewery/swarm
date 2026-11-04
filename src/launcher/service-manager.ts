/**
 * The **service-manager seam** (issue #1323): what supervises a profile worker on
 * this host, so it starts at login, survives a reboot, and is started again after
 * the daemon exits for an ADR-006/007 update.
 *
 * Two managers, picked by platform:
 *
 *   - **launchd** (macOS) — a thin wrapper around `bin/swarm-worker-agent … --profile
 *     <id>`, the LaunchAgent installer the package already ships. Nothing about the
 *     macOS behaviour is re-implemented here: the script's refusals, plist and
 *     wording stay its own.
 *   - **Task Scheduler** (Windows) — a per-user "at log on" task running
 *     `swarm-worker service-run <id>`, a keep-alive loop standing in for launchd's
 *     `KeepAlive` (`./windows-task.ts`, `./service-run.ts`).
 *
 * Every other platform has none, and callers name the foreground command instead.
 * `swarm-worker setup`, `swarm-worker status`, `swarm-worker agent` and `swarm
 * workers setup --profile` all reach the manager through {@link resolveServiceManager}
 * rather than branching on the platform themselves.
 *
 * Bundle-safe like the rest of `src/launcher/`: only `node:*`, `../cli/_shared/*`
 * helpers the launcher already carries, and launcher modules.
 */

import { join } from 'node:path';
import { runCommand } from '../cli/_shared/exec.js';
import { workerAgentCommand } from '../cli/_shared/installation-command.js';
import { REPO_ROOT } from '../cli/_shared/paths.js';
import type { WorkerAutostartResult } from '../cli/_shared/worker-autostart.js';
import { describeError } from '../lib/errors.js';
import {
	captureCommand,
	createWindowsTaskManager,
	type ExecResult,
	type WindowsTaskDeps,
} from './windows-task.js';

export interface WorkerServiceManager {
	/** The supervisor's name, for messages: `launchd` or `Task Scheduler`. */
	readonly name: string;
	/** Install (or reinstall) the worker's service and start it. */
	install(workerId: string): Promise<WorkerAutostartResult>;
	/** Stop and remove it, printing its own report; answers an exit code. */
	uninstall(workerId: string): Promise<number>;
	/** Its own report, captured for `swarm-worker status`. */
	status(workerId: string): Promise<{ output: string; installed: boolean }>;
	/** Follow its logs until interrupted; answers an exit code. */
	logs(workerId: string): Promise<number>;
}

/** The LaunchAgent installer this installation ships (`package.json` → `bin`). */
export function launchdInstallerPath(root = REPO_ROOT): string {
	return join(root, 'bin', 'swarm-worker-agent');
}

/** `swarm-worker-agent <args>`, its exit code read as installed or failed. */
export async function runLaunchdInstaller(
	args: string[],
	run: typeof runCommand = runCommand,
): Promise<WorkerAutostartResult> {
	try {
		const code = await run(launchdInstallerPath(), args);
		return code === 0
			? { kind: 'installed' }
			: { kind: 'failed', reason: `swarm-worker-agent install exited with code ${code}` };
	} catch (err) {
		return { kind: 'failed', reason: describeError(err) };
	}
}

export interface ServiceManagerDeps {
	/** Runs a command with inherited stdio and answers its exit code. */
	runCommand?: typeof runCommand;
	/** Captures a command's output, for `status`. */
	capture?: (file: string, args: string[]) => Promise<ExecResult>;
	/** The Windows manager's own dependencies. */
	windows?: WindowsTaskDeps;
}

/** launchd: every action is `swarm-worker-agent <action> --profile <id>`. */
function createLaunchdManager(deps: ServiceManagerDeps): WorkerServiceManager {
	const run = deps.runCommand ?? runCommand;
	const capture = deps.capture ?? captureCommand;
	const inherit = async (action: string, workerId: string) => {
		try {
			return await run(launchdInstallerPath(), [action, '--profile', workerId]);
		} catch (err) {
			console.error(`swarm-worker: ${describeError(err)}`);
			return 1;
		}
	};
	return {
		name: 'launchd',
		install: (workerId) => runLaunchdInstaller(['install', '--profile', workerId], run),
		uninstall: (workerId) => inherit('uninstall', workerId),
		logs: (workerId) => inherit('logs', workerId),
		status: async (workerId) => {
			const { output, code } = await capture(launchdInstallerPath(), [
				'status',
				'--profile',
				workerId,
			]);
			return { output, installed: code === 0 };
		},
	};
}

/** The host's service manager — launchd on macOS, Task Scheduler on Windows — or `null`. */
export function resolveServiceManager(
	platform: NodeJS.Platform = process.platform,
	deps: ServiceManagerDeps = {},
): WorkerServiceManager | null {
	if (platform === 'darwin') return createLaunchdManager(deps);
	if (platform === 'win32') return createWindowsTaskManager(deps.windows);
	return null;
}

/**
 * The command a printed hint names for the worker's service: `swarm-worker-agent`
 * (this installation's) on macOS, `swarm-worker agent` on Windows. Elsewhere there
 * is none, and `swarm-worker agent` is what says so.
 */
export function serviceCommand(platform: NodeJS.Platform = process.platform): string {
	return platform === 'darwin' ? workerAgentCommand() : 'swarm-worker agent';
}
