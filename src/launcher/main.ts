/**
 * `swarm-launcher` — start a profile-based worker on the runtime version its
 * installation names (issue #1281, phase 2).
 *
 * `swarm-launcher run <workerId>` reads `~/.swarm/workers/<workerId>/profile.json`
 * (`./worker-profile.ts`), asks that worker's control plane which runtime it serves
 * (`fetchRuntimeManifest`), makes sure that exact version is installed and verified
 * under `~/.swarm/runtimes/<version>/` (`ensureRuntime`), and then *becomes* that
 * runtime's daemon. Two profiles pointing at two installations on two versions are
 * two independent daemons, each on its own runtime directory, with no SWARM clone
 * and no `.env` anywhere.
 *
 * Load-bearing rules:
 *
 *   - **The contract with the runtime is only the daemon's existing env vars**:
 *     `SWARM_CONTROL_PLANE_URL`, `SWARM_WORKER_CREDENTIAL`, `SWARM_WORKER_REPO_ROOT`
 *     (`path.delimiter`-separated, primary first) and `SWARM_LOG_FILE`
 *     (`<profileDir>/logs/worker.log`). The four always come from the profile and
 *     overwrite any ambient value; the rest of the environment is carried over,
 *     because `PATH`/`HOME` are what the agent CLIs need and `XPC_SERVICE_NAME` is
 *     half of the supervision read (`../lib/worker-supervision.ts`). The daemon runs
 *     in the profile directory, and nothing passes `--env-file`.
 *   - **A runtime that fails a check is never started.** Every `ensureRuntime`
 *     refusal — size, SHA-256, signature, trusted comment, or no trusted key to
 *     check with — exits 1 naming the check, with no fallback to another version.
 *     The fallback below is for a control plane that gave no answer, not for one
 *     whose answer failed verification.
 *   - **A briefly unreachable control plane does not stop a worker from starting.**
 *     When the manifest cannot be fetched or says `available: false`, the version
 *     recorded in `state.json` the last time this worker started is used if it is
 *     still installed (it was verified when it was installed, and an installed
 *     version is never modified). With none, the launcher exits 1 with the reason.
 *   - **The credential travels in the daemon's environment only** — never in
 *     `argv`, never printed — exactly as `swarm run:worker` passes it.
 *   - **It hands its own process to the daemon** with `process.execve`, for the
 *     reason `../cli/commands/run-worker.ts` gives at length: a supervisor's direct
 *     child must *be* the daemon for it to declare `supervised`. Where `execve` is
 *     missing or refused, it spawns the daemon as a child instead and says so.
 *   - **Bundle-safe**: it imports only `src/launcher/*`, the manifest contract,
 *     `checkout-key`, `local-lock`, `normalizeControlPlaneUrl` and zod — nothing
 *     from the daemon graph (#1283 bundles it).
 *
 * The trusted signing key is `deploy/worker-runtime/minisign.pub` under the
 * launcher's own install root, resolved from `import.meta.url` the way
 * `../cli/_shared/paths.ts` resolves the repo root. Without that file no key is
 * passed, so a version not yet installed fails closed while installed ones start.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
	ensureRuntime,
	fetchRuntimeManifest,
	installedRuntime,
	listInstalledRuntimes,
	runtimesDir,
} from './runtime-store.js';
import {
	isValidWorkerId,
	readWorkerProfile,
	readWorkerState,
	type WorkerProfile,
	workerProfileDir,
	workerProfilePath,
	writeWorkerState,
} from './worker-profile.js';

/** `src/launcher/` and `dist/launcher/` sit at the same depth under the install root. */
export const LAUNCHER_INSTALL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Relative to the launcher's install root. */
export const TRUSTED_KEY_PATH = 'deploy/worker-runtime/minisign.pub';

/** Every variable the launcher sets for the daemon, and the only ones. */
export const DAEMON_ENV_KEYS = [
	'SWARM_CONTROL_PLANE_URL',
	'SWARM_WORKER_CREDENTIAL',
	'SWARM_WORKER_REPO_ROOT',
	'SWARM_LOG_FILE',
] as const;

const PREFIX = 'swarm-launcher';

const USAGE = `swarm-launcher — start a profile-based worker on its installation's runtime

Usage:
  swarm-launcher run <workerId>   become the daemon for ~/.swarm/workers/<workerId>/
  swarm-launcher runtimes         list the runtime versions installed on this host

\`run\` asks the worker's control plane which runtime version it serves, installs
and verifies that version under ~/.swarm/runtimes/<version>/ when it is missing,
and replaces this process with its daemon. The daemon gets the profile's
control-plane URL, credential and checkouts through its usual environment
variables, runs in the profile directory, and logs to <profileDir>/logs/worker.log.
When the control plane cannot be reached, the version this worker last started on
is used if it is still installed. A runtime that fails a check is never started.`;

type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => unknown;

export interface LauncherDeps {
	/** Injectable so tests never touch the real home directory, network or process. */
	homeDir?: string;
	fetch?: typeof globalThis.fetch;
	/** The ambient environment the daemon's is built from. */
	env?: NodeJS.ProcessEnv;
	/** `null` for a runtime without `process.execve`. */
	execve?: Execve | null;
	chdir?: (dir: string) => void;
	spawnDaemon?: (
		file: string,
		args: string[],
		cwd: string,
		env: NodeJS.ProcessEnv,
	) => Promise<number>;
	/** `null` for none; omitted to read {@link TRUSTED_KEY_PATH}. */
	trustedPublicKey?: string | null;
	execPath?: string;
	now?: () => number;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
}

/** The trusted runtime signing key shipped with the launcher, or `undefined` when there is none. */
export function readTrustedPublicKey(installRoot = LAUNCHER_INSTALL_ROOT): string | undefined {
	const path = join(installRoot, TRUSTED_KEY_PATH);
	if (!existsSync(path)) return undefined;
	try {
		return readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}

function defaultExecve(): Execve | null {
	return typeof process.execve === 'function' ? process.execve.bind(process) : null;
}

/** Spawn the daemon as a child, forward the supervisor's signals, and answer its exit code. */
function defaultSpawnDaemon(
	file: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
): Promise<number> {
	return new Promise((resolvePromise) => {
		const child = spawn(file, args, { cwd, env, stdio: 'inherit' });
		const forward = (signal: NodeJS.Signals) => child.kill(signal);
		process.on('SIGTERM', forward);
		process.on('SIGINT', forward);
		const settle = (code: number) => {
			process.off('SIGTERM', forward);
			process.off('SIGINT', forward);
			resolvePromise(code);
		};
		child.on('error', () => settle(1));
		child.on('exit', (code) => settle(code ?? 1));
	});
}

interface Resolved {
	version: string;
	entrypoint: string;
}

interface Io {
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
}

/**
 * The runtime this worker starts on: the version its control plane names, ensured
 * and verified, or — only when the control plane named none — the version it last
 * started on, while that is still installed.
 */
async function resolveRuntime(
	profile: WorkerProfile,
	deps: LauncherDeps,
	io: Io,
): Promise<Resolved | { error: string }> {
	const manifest = await fetchRuntimeManifest(profile.controlPlaneUrl, { fetch: deps.fetch });
	if ('error' in manifest || !manifest.available) {
		const reason = 'error' in manifest ? manifest.error : manifest.reason;
		const state = readWorkerState(profile.workerId, deps.homeDir);
		const last = state ? installedRuntime(state.lastRuntimeVersion, deps.homeDir) : undefined;
		if (!last)
			return {
				error: `the control plane named no runtime to start (${reason}), and no runtime this worker last started on is installed`,
			};
		io.warn(
			`the control plane named no runtime to start (${reason}); starting v${last.version}, the version this worker last started on`,
		);
		return { version: last.version, entrypoint: last.entrypoint };
	}

	const trustedPublicKey =
		deps.trustedPublicKey === undefined
			? readTrustedPublicKey()
			: (deps.trustedPublicKey ?? undefined);
	const ensured = await ensureRuntime({
		controlPlaneUrl: profile.controlPlaneUrl,
		manifest,
		bearer: profile.credential,
		trustedPublicKey,
		homeDir: deps.homeDir,
		fetch: deps.fetch,
		now: deps.now,
	});
	if ('error' in ensured) return { error: `v${manifest.version} is not started: ${ensured.error}` };
	if (ensured.installed) io.info(`installed and verified v${ensured.version} at ${ensured.dir}`);
	return { version: ensured.version, entrypoint: ensured.entrypoint };
}

async function runWorker(workerId: string, deps: LauncherDeps, io: Io): Promise<number> {
	if (!isValidWorkerId(workerId)) {
		io.error(`${JSON.stringify(workerId)} is not a valid worker id`);
		return 1;
	}
	const profile = readWorkerProfile(workerId, deps.homeDir);
	if (profile === null) {
		io.error(`no profile for worker '${workerId}' (${workerProfilePath(workerId, deps.homeDir)})`);
		return 1;
	}
	if (profile === undefined) {
		io.error(
			`the profile for worker '${workerId}' could not be read: ${workerProfilePath(workerId, deps.homeDir)}`,
		);
		return 1;
	}

	const runtime = await resolveRuntime(profile, deps, io);
	if ('error' in runtime) {
		io.error(runtime.error);
		return 1;
	}

	const now = deps.now ?? Date.now;
	writeWorkerState(
		workerId,
		{ lastRuntimeVersion: runtime.version, startedAt: new Date(now()).toISOString() },
		deps.homeDir,
	);

	const profileDir = workerProfileDir(workerId, deps.homeDir);
	const logsDir = join(profileDir, 'logs');
	mkdirSync(logsDir, { recursive: true, mode: 0o700 });
	const env: NodeJS.ProcessEnv = {
		...(deps.env ?? process.env),
		SWARM_CONTROL_PLANE_URL: profile.controlPlaneUrl,
		SWARM_WORKER_CREDENTIAL: profile.credential,
		SWARM_WORKER_REPO_ROOT: profile.repoRoots.join(delimiter),
		SWARM_LOG_FILE: join(logsDir, 'worker.log'),
	};
	// The worker id, version and checkouts, never the credential.
	io.info(
		`starting worker '${workerId}' on v${runtime.version} for ${profile.repoRoots.join(', ')}…`,
	);
	return becomeDaemon(runtime.entrypoint, profileDir, env, deps, io);
}

/**
 * Replace this process with the daemon, or — where that is unavailable or refused —
 * spawn it as a child and answer its exit code. The reasoning is `run-worker.ts`'s
 * `becomeDaemon`: never fatal, because a worker started behind an extra process is
 * strictly better than one that does not start.
 */
function becomeDaemon(
	entrypoint: string,
	cwd: string,
	env: NodeJS.ProcessEnv,
	deps: LauncherDeps,
	io: Io,
): number | Promise<number> {
	const execPath = deps.execPath ?? process.execPath;
	const execve = deps.execve === undefined ? defaultExecve() : deps.execve;
	let refusal: string;
	if (!execve) {
		refusal = 'this runtime cannot hand its process to the daemon (no process.execve)';
	} else {
		try {
			// `execve` inherits the working directory.
			(deps.chdir ?? process.chdir)(cwd);
			execve(execPath, [execPath, entrypoint], env);
			// Not reachable through POSIX `execve`; read as success rather than starting
			// a second daemon on the strength of an exec that may have half happened.
			return 0;
		} catch (err) {
			refusal = `could not hand this process to the daemon (${err instanceof Error ? err.message : String(err)})`;
		}
	}
	io.warn(`${refusal}; starting the daemon as a child process instead`);
	return (deps.spawnDaemon ?? defaultSpawnDaemon)(execPath, [entrypoint], cwd, env);
}

function listRuntimes(deps: LauncherDeps, io: Io): number {
	const runtimes = listInstalledRuntimes(deps.homeDir);
	if (runtimes.length === 0) {
		io.info(`no runtimes installed under ${runtimesDir(deps.homeDir)}`);
		return 0;
	}
	for (const runtime of runtimes)
		io.info(`v${runtime.version}  ${runtime.commit ?? '(no commit recorded)'}  ${runtime.dir}`);
	return 0;
}

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		options: { help: { type: 'boolean', short: 'h' } },
		allowPositionals: true,
	});
}

export async function run(argv: string[], deps: LauncherDeps = {}): Promise<number> {
	const stdout = deps.stdout ?? ((line: string) => console.log(line));
	const stderr = deps.stderr ?? ((line: string) => console.error(line));
	const io: Io = {
		info: (message) => stdout(`${PREFIX}: ${message}`),
		warn: (message) => stderr(`${PREFIX}: ${message}`),
		error: (message) => stderr(`${PREFIX}: ${message}`),
	};

	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (err) {
		io.error(err instanceof Error ? err.message : String(err));
		return 1;
	}
	const [command, ...rest] = parsed.positionals;
	if (parsed.values.help || command === undefined) {
		stdout(USAGE);
		return parsed.values.help ? 0 : 1;
	}
	if (command === 'run' && rest.length === 1) return runWorker(rest[0], deps, io);
	if (command === 'runtimes' && rest.length === 0) return listRuntimes(deps, io);
	io.error(`unknown command: ${parsed.positionals.join(' ')}`);
	stdout(USAGE);
	return 1;
}
