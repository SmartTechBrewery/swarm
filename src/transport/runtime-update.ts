/**
 * Moving a **runtime-based (launcher-run) worker** to a requested release (issue
 * #1302) — the runtime twin of `../worker/self-update.ts`'s `applyUpdateTarget`.
 *
 * A launcher-run daemon has no install root to check out: it runs an immutable,
 * signed runtime from `~/.swarm/runtimes/<version>/`, chosen by the launcher
 * (`../launcher/main.ts`) from the worker's **selected** version. So moving it is
 * three steps and no git: resolve the target to a signed release, make sure that
 * release is installed and verified (`ensureRuntime`, which downloads it at most
 * once per host however many workers ask), and record it as this worker's
 * selection in its `state.json`. The caller (`./worker-update.ts`) then reports
 * `applied` and exits 0, and the supervisor's launcher starts the worker again on
 * the version it now selects. Everything about *when* — the drain precondition, the
 * wait until idle, the report and the exit — stays in `./worker-update.ts`, shared
 * with clone-based workers.
 *
 * What it deliberately does not do:
 *
 *   - **Move to anything but a signed release.** A target is a version (`vX.Y.Z` or
 *     `X.Y.Z`), or the installation's own commit, which names the installation's own
 *     release. A branch, or any other commit, has no signed runtime to install and is
 *     refused rather than guessed at.
 *   - **Look at other workers on this host.** Runtimes are immutable and each worker
 *     selects its own, so nothing another worker is doing can be disturbed by this
 *     one moving, and there is no peer to wait for or refuse on (unlike the shared
 *     install root's `findBusyInstallPeer`).
 *   - **Trust any key but the launcher's.** The signing key is read from
 *     `SWARM_RUNTIME_TRUSTED_KEY`, the path the launcher sets to its own
 *     `minisign.pub`, never from a copy inside the running runtime.
 *
 * It never throws: every outcome is an {@link UpdateOutcome}, as with
 * `applyUpdateTarget`. A failure leaves the worker's selection untouched, so it goes
 * on running — and restarting into — the version it has.
 */

import { readFileSync } from 'node:fs';
import {
	ensureRuntime,
	fetchRuntimeManifest,
	installedRuntime,
} from '../launcher/runtime-store.js';
import { isValidWorkerId, readWorkerState, updateWorkerState } from '../launcher/worker-profile.js';
import type { WorkerBuild } from '../lib/build-identity.js';
import type { UpdateOutcome } from '../worker/self-update.js';
import { isRuntimeVersion, type WorkerRuntimeManifest } from './runtime-manifest.js';

/** The refusal for a target that names no signed release. */
export const NOT_A_RELEASE_REASON =
	'a runtime-based worker moves only to a signed release — name its version (vX.Y.Z)';

/** A commit id, as a target may abbreviate it. Never also read as a version. */
const COMMIT_SHAPE = /^[0-9a-f]{7,64}$/i;

/** `X.Y.Z` or `vX.Y.Z`: a runtime version, starting with a digit. */
const VERSION_SHAPE = /^v?(\d.*)$/;

export interface RuntimeUpdateOptions {
	/** The validated update target. */
	target: string;
	/** This launcher-run worker's id (`SWARM_WORKER_ID`): whose selection to record. */
	workerId: string;
	controlPlaneUrl: string;
	/** The worker credential: a release the control plane has not located yet is looked up only for it. */
	credential: string;
	/** The build this daemon is running, resolved at startup. */
	build: WorkerBuild | undefined;
	/** The launcher's `minisign.pub` (`SWARM_RUNTIME_TRUSTED_KEY`); without it only an installed version is accepted. */
	trustedKeyPath: string | undefined;
	/** Injectable so tests never touch the real home directory, network or clock. */
	homeDir?: string;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
	lockPollMs?: number;
}

type Resolved = { version: string; manifest?: WorkerRuntimeManifest } | { refused: string };

/** Resolve a target to the release version it names, or say why it names none. */
async function resolveTargetVersion(options: RuntimeUpdateOptions): Promise<Resolved> {
	const { target } = options;
	if (COMMIT_SHAPE.test(target)) {
		// The installation's own runtime is the one release a commit can name.
		const own = await fetchRuntimeManifest(options.controlPlaneUrl, {
			fetch: options.fetch,
			bearer: options.credential,
		});
		if ('error' in own)
			return { refused: `${target} could not be resolved to a release: ${own.error}` };
		if (!own.available)
			return { refused: `${target} could not be resolved to a release: ${own.reason}` };
		if (!own.commit.toLowerCase().startsWith(target.toLowerCase()))
			return {
				refused: `${target} is not this installation's own commit (${own.commit}); ${NOT_A_RELEASE_REASON}`,
			};
		return { version: own.version, manifest: own };
	}
	const version = VERSION_SHAPE.exec(target)?.[1];
	if (version && isRuntimeVersion(version)) return { version };
	return { refused: `${target} is not a release version; ${NOT_A_RELEASE_REASON}` };
}

/** The version this daemon is running: its own stamp, or what the launcher started it on. */
function runningVersion(options: RuntimeUpdateOptions): string | undefined {
	if (options.build?.version) return options.build.version;
	const state = readWorkerState(options.workerId, options.homeDir);
	return state?.lastRuntimeVersion;
}

function readTrustedKey(path: string | undefined): string | undefined {
	if (!path) return undefined;
	try {
		return readFileSync(path, 'utf8');
	} catch {
		// `ensureRuntime` refuses to install with no key and says so.
		return undefined;
	}
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Move this launcher-run worker to the release `options.target` names. Never
 * throws; see the module header for every outcome.
 */
export async function applyRuntimeUpdate(options: RuntimeUpdateOptions): Promise<UpdateOutcome> {
	const previousCommit = options.build?.commit ?? 'unknown';
	// Every failure leaves the selection untouched and publishes no version, so
	// nothing needs rolling back.
	const failed = (reason: string): UpdateOutcome => ({
		status: 'failed',
		stage: 'install',
		reason,
		rolledBack: true,
		previousCommit,
		outputTail: '',
	});
	try {
		return await applyRuntimeUpdateUnguarded(options, previousCommit, failed);
	} catch (err) {
		return failed(`Moving this worker's runtime failed unexpectedly: ${errorMessage(err)}`);
	}
}

/** How a running version is named in operator-facing prose. */
function describeVersion(version: string | undefined, fallback: string): string {
	return version ? `v${version}` : fallback;
}

async function applyRuntimeUpdateUnguarded(
	options: RuntimeUpdateOptions,
	previousCommit: string,
	failed: (reason: string) => UpdateOutcome,
): Promise<UpdateOutcome> {
	if (!isValidWorkerId(options.workerId))
		return {
			status: 'refused',
			reason: `SWARM_WORKER_ID ${JSON.stringify(options.workerId)} is not a valid worker id, so this worker's runtime selection cannot be recorded`,
		};

	const resolved = await resolveTargetVersion(options);
	if ('refused' in resolved) return { status: 'refused', reason: resolved.refused };
	const { version } = resolved;

	const running = runningVersion(options);
	if (running === version)
		return {
			status: 'already-current',
			commit:
				options.build?.commit ?? installedRuntime(version, options.homeDir)?.commit ?? 'unknown',
		};
	const stays = `This worker stays on ${describeVersion(running, 'the runtime it has')}.`;

	const manifest =
		resolved.manifest ??
		(await fetchRuntimeManifest(options.controlPlaneUrl, {
			fetch: options.fetch,
			version,
			bearer: options.credential,
		}));
	if ('error' in manifest)
		return { status: 'refused', reason: `v${version} could not be resolved: ${manifest.error}` };
	if (!manifest.available)
		return { status: 'refused', reason: `v${version} has no signed release: ${manifest.reason}` };

	const ensured = await ensureRuntime({
		controlPlaneUrl: options.controlPlaneUrl,
		manifest,
		bearer: options.credential,
		trustedPublicKey: readTrustedKey(options.trustedKeyPath),
		homeDir: options.homeDir,
		fetch: options.fetch,
		now: options.now,
		lockPollMs: options.lockPollMs,
	});
	if ('error' in ensured)
		return failed(`v${manifest.version} was not installed: ${ensured.error}. ${stays}`);

	const recorded = updateWorkerState(
		options.workerId,
		{ selectedVersion: manifest.version },
		options.homeDir,
	);
	if (!recorded)
		return failed(
			`v${manifest.version} is installed, but this worker's launcher state could not be ${recorded === null ? 'found' : 'read'}, so it was not selected. ${stays}`,
		);

	const how = ensured.installed ? 'downloaded and verified here' : 'already installed on this host';
	return {
		status: 'applied',
		commit: manifest.commit,
		previousCommit,
		message:
			`Applied: this worker now selects runtime v${manifest.version} (${manifest.commit}), ${how}; ` +
			`it was on ${describeVersion(running, 'an unidentified runtime')} (${previousCommit}). ` +
			'The daemon is restarting into it.',
	};
}

/**
 * The update mechanism for this daemon: {@link applyRuntimeUpdate} when the launcher
 * started it (it sets `SWARM_WORKER_ID`), otherwise `undefined`, which leaves
 * `./worker-update.ts` on the install root's git path.
 */
export function runtimeUpdateApply(
	env: NodeJS.ProcessEnv,
	context: Pick<RuntimeUpdateOptions, 'controlPlaneUrl' | 'credential' | 'build'>,
): ((target: string) => Promise<UpdateOutcome>) | undefined {
	const workerId = env.SWARM_WORKER_ID?.trim();
	if (!workerId) return undefined;
	const trustedKeyPath = env.SWARM_RUNTIME_TRUSTED_KEY?.trim() || undefined;
	return (target) => applyRuntimeUpdate({ ...context, target, workerId, trustedKeyPath });
}
