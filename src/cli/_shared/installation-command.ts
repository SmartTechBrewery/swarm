/**
 * How to name *this* installation's `swarm` / `swarm-worker-agent` / `swarm-launcher`
 * in a command the CLI prints for the operator to run next (issue #1221).
 *
 * One machine can serve two installations (docs/onboarding-worker.md → "Serving a
 * second installation from the same machine"). Only one of them can be the bare
 * `swarm` on `PATH` — whichever was `npm link`ed — so a follow-up printed as bare
 * `swarm workers …` by the *other* one would run that installation's CLI against
 * its own `.env` and control plane: the step fails, or lands somewhere else. So the
 * bare name is printed only when the first `swarm` on `PATH` resolves to this
 * installation's own `bin/` file, which keeps the single-installation output exactly
 * as it was; anything else — another installation, no entry, an unreadable one —
 * gets the absolute form, which reaches this installation from any directory.
 *
 * Never throws: a hint is advice, and failing to word it must not fail the command
 * printing it.
 */

import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { normalizeControlPlaneUrl } from './operator-session-cache.js';
import { REPO_ROOT } from './paths.js';

/**
 * `swarm`, or `node <install-root>/bin/swarm.js` when `PATH`'s `swarm` is another installation's.
 *
 * The launcher package (issue #1283) ships no `bin/swarm.js`, so from it the bare
 * `swarm` — a SWARM checkout's CLI — is the only form that can name a command that
 * exists (issue #1311). A hint printed from the package should prefer the worker's
 * dashboard page ({@link workerDashboardUrl}) wherever it knows the installation.
 */
export function swarmCommand(
	env: NodeJS.ProcessEnv = process.env,
	installRoot = REPO_ROOT,
): string {
	if (isLauncherPackage(installRoot)) return 'swarm';
	const own = join(installRoot, 'bin', 'swarm.js');
	return resolvesToOwn('swarm', own, env) ? 'swarm' : `node ${shellQuote(own)}`;
}

/**
 * Whether `installRoot` is the clone-free launcher package (issue #1283): it ships
 * `bin/swarm-worker.js` and no `bin/swarm.js`, so it has no `swarm` CLI to name.
 */
export function isLauncherPackage(installRoot = REPO_ROOT): boolean {
	return (
		!existsSync(join(installRoot, 'bin', 'swarm.js')) &&
		existsSync(join(installRoot, 'bin', 'swarm-worker.js'))
	);
}

/**
 * A worker's page on the installation's dashboard, which the API server serves at
 * the control plane's own URL: where its enrollment is approved and consented, its
 * operator credential set and the worker deleted — the steps a launcher-package
 * host has no `swarm` CLI for (issue #1311).
 */
export function workerDashboardUrl(controlPlaneUrl: string, workerId: string): string {
	return `${normalizeControlPlaneUrl(controlPlaneUrl)}/workers/${encodeURIComponent(workerId)}`;
}

/**
 * `swarm-launcher`, or `node <install-root>/bin/swarm-launcher.js` when `PATH`'s is
 * another installation's — the command a profile-based worker is started with
 * (issue #1296), named exactly as {@link swarmCommand} names `swarm`.
 *
 * The launcher package (issue #1283) ships no `swarm-launcher.js`: its command is
 * `swarm-worker`, whose `run <worker-id>` is the same launcher. So an install root
 * without the one but with the other is named by `swarm-worker` instead (issue
 * #1311), and a hint printed by `swarm-worker setup` names a command that exists.
 */
export function launcherCommand(
	env: NodeJS.ProcessEnv = process.env,
	installRoot = REPO_ROOT,
): string {
	const own = join(installRoot, 'bin', 'swarm-launcher.js');
	const packaged = join(installRoot, 'bin', 'swarm-worker.js');
	if (!existsSync(own) && existsSync(packaged))
		return resolvesToOwn('swarm-worker', packaged, env)
			? 'swarm-worker'
			: `node ${shellQuote(packaged)}`;
	return resolvesToOwn('swarm-launcher', own, env) ? 'swarm-launcher' : `node ${shellQuote(own)}`;
}

/** `swarm-worker-agent`, or `<install-root>/bin/swarm-worker-agent` when `PATH`'s is another installation's. */
export function workerAgentCommand(
	env: NodeJS.ProcessEnv = process.env,
	installRoot = REPO_ROOT,
): string {
	const own = join(installRoot, 'bin', 'swarm-worker-agent');
	return resolvesToOwn('swarm-worker-agent', own, env) ? 'swarm-worker-agent' : shellQuote(own);
}

/** Whether the first executable `name` on `env.PATH` is, after every symlink, `own`. */
function resolvesToOwn(name: string, own: string, env: NodeJS.ProcessEnv): boolean {
	try {
		const onPath = firstOnPath(name, env.PATH ?? '');
		return onPath !== undefined && realpathSync(onPath) === realpathSync(own);
	} catch {
		return false;
	}
}

/** The first executable `name` across `path`'s entries — the one a shell would run. */
function firstOnPath(name: string, path: string): string | undefined {
	for (const dir of path.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Not here, or not executable — a shell would keep looking too.
		}
	}
	return undefined;
}

/** Single-quote a path for a POSIX shell, unless it is made only of characters that need none. */
function shellQuote(path: string): string {
	return /^[A-Za-z0-9_./-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}
