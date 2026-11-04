/**
 * `swarm-worker` — the command a clone-free worker host runs (issue #1283, phase 1).
 *
 * It is the entry point of the **launcher package**, `swarm-worker-launcher-<version>.tar.gz`
 * (`bin/build-worker-launcher.js`): the launcher bundled into one file together with
 * the LaunchAgent installer, runnable with nothing but Node >= 22. In a clone it runs
 * from `dist/` after `npm run build`, through the same `bin/swarm-worker.js` shim.
 *
 * `run` and `runtimes` are handed, argv unchanged, to the launcher (`./main.ts`), so
 * they behave and print exactly as `swarm-launcher`'s do. `setup`, `login` and
 * `status` (issue #1311) register a profile worker for the checkout it is run in,
 * renew the operator session, and report each profile's LaunchAgent, runtime and
 * connection (`./setup.ts`, `./login.ts`, `./status.ts`).
 *
 * Load-bearing rules:
 *
 *   - **Bundle-safe**: nothing it reaches imports the daemon graph — `./main.ts`
 *     keeps that rule, and so does `swarm workers`' own code the setup reuses
 *     (`../cli/commands/workers.ts`, which talks to the operator API and holds no
 *     `DATABASE_URL`). The package test fails a bundle that carries the daemon's
 *     dependencies (pg, BullMQ, drizzle, ioredis, ws).
 *   - **No `.env`**: nothing on this path reads or writes one. Each command is
 *     handed its installation's URL (a flag, an answer, or a profile).
 *   - **The package version is the install root's `package.json`**, the root
 *     `./main.ts` anchors on (`LAUNCHER_INSTALL_ROOT`): the package's own manifest
 *     when it runs from the package, SWARM's when it runs from a clone.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type LoginDeps, runLogin } from './login.js';
import { LAUNCHER_INSTALL_ROOT, type LauncherDeps, run as runLauncher } from './main.js';
import { runSetup, type SetupDeps } from './setup.js';
import { runStatus, type StatusDeps } from './status.js';

export const USAGE = `swarm-worker — run a SWARM worker on this host, with no SWARM clone

Usage:
  swarm-worker setup [flags]       register this checkout's host as a worker (--help for flags)
  swarm-worker login [flags]       renew your session on the installation
  swarm-worker status [<workerId>] report each worker's LaunchAgent, runtime and connection
  swarm-worker run <workerId>      become the daemon for ~/.swarm/workers/<workerId>/
  swarm-worker runtimes            list the runtime versions installed on this host
  swarm-worker --version           print this launcher's version

\`setup\` is run in the project checkout the worker is to serve: it signs you in,
picks the project, registers and enrolls the worker, installs its runtime and its
LaunchAgent, and waits for it to connect.

\`run\` and \`runtimes\` are the launcher's own commands (swarm-launcher run|runtimes):
\`run\` starts the worker's profile on the runtime version its installation serves,
installing and verifying it under ~/.swarm/runtimes/<version>/ when it is missing.
Under launchd, swarm-worker-agent install --profile <workerId> runs it at login.`;

export interface SwarmWorkerDeps extends LauncherDeps {
	/** The root whose `package.json` names the version; defaults to the launcher's own. */
	installRoot?: string;
	/** The launcher `run` / `runtimes` are handed to; injectable for tests. */
	launcher?: typeof runLauncher;
	/** The `setup` / `login` / `status` commands; injectable for tests. */
	setup?: (argv: string[], deps?: SetupDeps) => Promise<number>;
	login?: (argv: string[], deps?: LoginDeps) => Promise<number>;
	status?: (argv: string[], deps?: StatusDeps) => Promise<number>;
}

/** The launcher's version, from its install root's `package.json`, or `unknown`. */
export function launcherVersion(installRoot = LAUNCHER_INSTALL_ROOT): string {
	try {
		const { version } = JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8'));
		return typeof version === 'string' && version !== '' ? version : 'unknown';
	} catch {
		return 'unknown';
	}
}

export async function run(argv: string[], deps: SwarmWorkerDeps = {}): Promise<number> {
	const stdout = deps.stdout ?? ((line: string) => console.log(line));
	const stderr = deps.stderr ?? ((line: string) => console.error(line));
	const [command] = argv;
	switch (command) {
		case 'run':
		case 'runtimes': {
			const {
				installRoot: _installRoot,
				launcher = runLauncher,
				setup: _setup,
				login: _login,
				status: _status,
				...launcherDeps
			} = deps;
			return launcher(argv, launcherDeps);
		}
		case 'setup':
			return (deps.setup ?? runSetup)(argv.slice(1));
		case 'login':
			return (deps.login ?? runLogin)(argv.slice(1));
		case 'status':
			return (deps.status ?? runStatus)(argv.slice(1));
		case 'version':
		case '--version':
		case '-v':
			stdout(launcherVersion(deps.installRoot));
			return 0;
		case undefined:
		case 'help':
		case '--help':
		case '-h':
			stdout(USAGE);
			return 0;
		default:
			stderr(`swarm-worker: unknown command: ${argv.join(' ')}`);
			stdout(USAGE);
			return 1;
	}
}
