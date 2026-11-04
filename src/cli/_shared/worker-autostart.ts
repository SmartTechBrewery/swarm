/**
 * Install a checkout's worker under the host's process supervisor, so it starts at
 * login instead of occupying a terminal tab — what `swarm workers setup` ends with.
 * A profile-based worker (`setup --profile`, issue #1297) is installed through the
 * launcher's service-manager seam (`../../launcher/service-manager.ts`, issue
 * #1323): on macOS that is `swarm-worker-agent install --profile <worker-id>`, whose
 * agent runs this installation's `swarm-worker run <worker-id>`; on Windows it is a
 * per-user Task Scheduler "at log on" task running `swarm-worker service-run`.
 *
 * It adds no supervision model of its own. On macOS it hands the checkout to
 * `bin/swarm-worker-agent install`, the same LaunchAgent installer an operator runs
 * by hand (`docs/launchd-worker-autostart.md`), so the refusals that script makes —
 * a worker already running for the checkout, a missing `node` — are made once,
 * there, in its own words. Because the installer is this checkout's own, the agent
 * it writes runs this checkout's CLI — and therefore this checkout's `.env` and
 * control plane — whatever `swarm` is on `PATH`. A clone worker on any other
 * platform, and a profile worker on one the seam has no manager for, is answered as
 * unsupported, so the caller can name the foreground command instead of pretending
 * the worker was started.
 */

import { resolveServiceManager, runLaunchdInstaller } from '../../launcher/service-manager.js';

export type WorkerAutostartResult =
	| {
			kind: 'installed';
			/** Who supervises it, for the report — `launchd` when absent. */
			supervisor?: string;
			/** The command its status/install hints name — `swarm-worker-agent` when absent. */
			serviceCommand?: string;
	  }
	| { kind: 'failed'; reason: string; serviceCommand?: string }
	| { kind: 'unsupported'; platform: NodeJS.Platform };

export async function installWorkerAutostart(
	repoRoot: string,
	platform: NodeJS.Platform = process.platform,
): Promise<WorkerAutostartResult> {
	if (platform !== 'darwin') return { kind: 'unsupported', platform };
	return await runLaunchdInstaller(['install', repoRoot]);
}

/**
 * The profile variant: hand the worker id to the platform's service manager, which
 * reads the profile itself (and refuses one it cannot read, or whose checkouts a
 * running daemon already holds).
 */
export async function installProfileWorkerAutostart(
	workerId: string,
	platform: NodeJS.Platform = process.platform,
): Promise<WorkerAutostartResult> {
	const manager = resolveServiceManager(platform);
	if (!manager) return { kind: 'unsupported', platform };
	return await manager.install(workerId);
}
