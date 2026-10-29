/**
 * Install a checkout's worker under the host's process supervisor, so it starts at
 * login instead of occupying a terminal tab — what `swarm workers setup` ends with.
 *
 * It adds no supervision model of its own. On macOS it hands the checkout to
 * `bin/swarm-worker-agent install`, the same LaunchAgent installer an operator runs
 * by hand (`docs/launchd-worker-autostart.md`), so the refusals that script makes —
 * a worker already running for the checkout, a missing `swarm` binary — are made
 * once, there, in its own words. Every other platform has no installer yet and is
 * answered as such, so the caller can name the foreground command instead of
 * pretending the worker was started.
 */

import { join } from 'node:path';
import { describeError } from '../../lib/errors.js';
import { runCommand } from './exec.js';
import { REPO_ROOT } from './paths.js';

export type WorkerAutostartResult =
	| { kind: 'installed' }
	| { kind: 'failed'; reason: string }
	| { kind: 'unsupported'; platform: NodeJS.Platform };

/** The installer this package ships beside `swarm` (`package.json` → `bin`). */
const LAUNCHD_INSTALLER = join(REPO_ROOT, 'bin', 'swarm-worker-agent');

export async function installWorkerAutostart(
	repoRoot: string,
	platform: NodeJS.Platform = process.platform,
): Promise<WorkerAutostartResult> {
	if (platform !== 'darwin') return { kind: 'unsupported', platform };
	try {
		const code = await runCommand(LAUNCHD_INSTALLER, ['install', repoRoot]);
		return code === 0
			? { kind: 'installed' }
			: { kind: 'failed', reason: `swarm-worker-agent install exited with code ${code}` };
	} catch (err) {
		return { kind: 'failed', reason: describeError(err) };
	}
}
