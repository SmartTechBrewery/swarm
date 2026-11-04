/**
 * `swarm-worker migrate [<checkout>]` — turn a clone-based worker into a
 * profile-based one, keeping the worker (issue #1313).
 *
 * A clone worker is a `swarm run:worker` started in its checkout by a SWARM clone's
 * LaunchAgent, with its credential in the per-checkout cache
 * (`../cli/_shared/worker-credential-cache.ts`) and its installation in the clone's
 * `.env`. Migrating carries exactly those into `~/.swarm/workers/<id>/profile.json`
 * — the same worker id and credential, the same checkouts (primary first), the
 * same installation — and swaps the clone's agent for a profile agent running this
 * launcher. **Nothing is registered or enrolled**, so the worker id, its
 * enrollments and the operator's stored SCM credentials are the ones it had.
 *
 * Every refusal comes before anything is changed: no cache entry for the checkout,
 * a profile that already serves it for that installation, an installation that
 * cannot be told (or that `--control-plane-url` — which `install.sh` passes —
 * names differently from the clone, since the credential belongs to one of them),
 * and a credential the control plane does not accept. The credential is proved
 * with a worker-authenticated read the installation already serves: a `HEAD` of its
 * own runtime artifact with the credential as bearer. (The manifest route does not
 * authenticate a request for the installation's own version, so it proves nothing.)
 *
 * Then, in order:
 *
 *   1. the profile is written;
 *   2. the runtime is installed and verified (`ensureRuntime`) — a refusal removes
 *      the profile and stops, with the clone worker running as it was;
 *   3. the clone's agent is stopped and removed by the clone's own script
 *      (`<clone>/bin/swarm-worker-agent uninstall <checkout>`), and migrate waits
 *      for its daemon to let go of the checkout lock;
 *   4. the profile agent is installed by this package's script
 *      (`swarm-worker-agent install --profile <id>`) — a failure reinstalls the
 *      clone's agent and removes the profile, and says so;
 *   5. the clone's cache entry is deleted, so `swarm run:worker` in the checkout
 *      cannot start a second copy of the worker.
 *
 * With no clone agent for the checkout (a worker run by hand, or off macOS) steps
 * 3 and 4 are left to the operator: migrate writes the profile, installs the
 * runtime, deletes the cache entry and prints the command that starts the worker.
 *
 * The credential is never printed: not in a refusal, not in the summary.
 */

import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { runCommand } from '../cli/_shared/exec.js';
import { workerAgentCommand, workerDashboardUrl } from '../cli/_shared/installation-command.js';
import * as out from '../cli/_shared/output.js';
import { REPO_ROOT } from '../cli/_shared/paths.js';
import {
	installProfileWorkerAutostart,
	type WorkerAutostartResult,
} from '../cli/_shared/worker-autostart.js';
import {
	readWorkerCredentialCache,
	workerCredentialCachePath,
} from '../cli/_shared/worker-credential-cache.js';
import { profileServingCheckout } from '../cli/commands/workers.js';
import {
	type AvailableWorkerRuntimeManifest,
	WORKER_RUNTIME_ARTIFACTS_PATH,
} from '../transport/runtime-manifest.js';
import { canonicalCheckoutPath, checkoutStateDir } from '../worktree/checkout-key.js';
import { pidIsLive, readJson } from '../worktree/local-lock.js';
import {
	type CloneAgent,
	cloneAgentControlPlaneUrl,
	listCloneAgents,
	type PlistReader,
} from './clone-agent.js';
import { readTrustedPublicKey } from './main.js';
import { defaultPromptIo, missingAnswer, type PromptIo } from './operator-prompts.js';
import {
	type EnsuredRuntime,
	type EnsureRuntimeInput,
	ensureRuntime,
	fetchRuntimeManifest,
	type StoreError,
} from './runtime-store.js';
import { validateControlPlaneUrl } from './setup.js';
import {
	isValidWorkerId,
	readWorkerProfile,
	workerProfileDir,
	workerProfilePath,
	writeWorkerProfile,
} from './worker-profile.js';

export const MIGRATE_USAGE = `swarm-worker migrate — move a clone-based worker onto this launcher

Usage:
  swarm-worker migrate [<checkout>] [--control-plane-url <url>] [--yes]

Run it on the worker's machine, in (or naming) the checkout the clone worker was
registered in. It keeps the worker — the same id, credential, checkouts,
enrollments and source-control token — and moves it from the SWARM clone's
LaunchAgent to a profile in ~/.swarm/workers/<id>/ run by this launcher, which
gets runtime updates from its installation from then on. Nothing is registered.

  --control-plane-url <url>  The installation the worker belongs to. Read from the
                             clone's LaunchAgent and .env otherwise; must agree.
  --yes, -y                  Skip the confirmation.

Restarting the worker interrupts a run in progress, which is retried as on any
daemon restart — drain the worker first if that matters.`;

/** How long migrate waits for the clone's daemon to let go of its checkouts. */
export const RELEASE_TIMEOUT_MS = 60_000;
const RELEASE_POLL_MS = 500;

export interface MigrateDeps {
	io?: PromptIo;
	/** For the runtime manifest, the credential proof and the runtime artifact. */
	fetch?: typeof globalThis.fetch;
	ensureRuntime?: (input: EnsureRuntimeInput) => Promise<EnsuredRuntime | StoreError>;
	/** Runs a command with inherited stdio, resolving its exit code (the clone's agent script). */
	runCommand?: (command: string, args: string[]) => Promise<number>;
	installAutostart?: (workerId: string) => Promise<WorkerAutostartResult>;
	readPlist?: PlistReader;
	/** `null` for none; omitted to read the launcher's own `minisign.pub`. */
	trustedPublicKey?: string | null;
	/** Where this launcher is installed; the root its agent runs from. */
	installRoot?: string;
	platform?: NodeJS.Platform;
	pidIsLive?: (pid: number) => boolean;
	cwd?: string;
	homeDir?: string;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	releaseTimeoutMs?: number;
}

function parseMigrateArgs(argv: string[]) {
	return parseArgs({
		args: argv,
		options: {
			'control-plane-url': { type: 'string' },
			yes: { type: 'boolean', short: 'y' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	});
}

export async function runMigrate(argv: string[], deps: MigrateDeps = {}): Promise<number> {
	let parsed: ReturnType<typeof parseMigrateArgs>;
	try {
		parsed = parseMigrateArgs(argv);
	} catch (err) {
		return fail(`swarm-worker migrate: ${err instanceof Error ? err.message : String(err)}`);
	}
	const { values, positionals } = parsed;
	if (values.help) {
		console.log(MIGRATE_USAGE);
		return 0;
	}
	if (positionals.length > 1) return fail('swarm-worker migrate takes at most one <checkout>');

	const plan = await planMigration(positionals[0], values['control-plane-url'], deps);
	if (typeof plan === 'number') return plan;
	if (!(await confirm(plan, values.yes ?? false, deps))) return 1;
	return await migrate(plan, deps);
}

/** Everything migrate has learned before it changes anything. */
interface MigrationPlan {
	checkout: string;
	workerId: string;
	credential: string;
	/** Primary first. */
	repoRoots: string[];
	controlPlaneUrl: string;
	manifest: AvailableWorkerRuntimeManifest;
	/** `undefined` for a clone worker no LaunchAgent runs. */
	agent: CloneAgent | undefined;
	cachePath: string;
	installRoot: string;
}

/**
 * The worker, its clone, its installation and its runtime — or an exit code with
 * the refusal printed. Nothing is written by anything here.
 */
async function planMigration(
	positional: string | undefined,
	flagUrl: string | undefined,
	deps: MigrateDeps,
): Promise<MigrationPlan | number> {
	const checkout = canonicalCheckoutPath(positional ?? deps.cwd ?? process.cwd());
	const worker = readClonedWorker(checkout, deps.homeDir);
	if (typeof worker === 'number') return worker;

	const platform = deps.platform ?? process.platform;
	const agents =
		platform === 'darwin'
			? await listCloneAgents({ homeDir: deps.homeDir, readPlist: deps.readPlist })
			: [];
	const agent = agents.find((candidate) => candidate.checkout === checkout);
	const installRoot = canonicalCheckoutPath(deps.installRoot ?? REPO_ROOT);
	if (agent && canonicalCheckoutPath(agent.cloneRoot) === installRoot)
		return fail(
			`swarm-worker migrate: this swarm-worker runs from ${installRoot}, the very clone the worker is being moved off — run the one install.sh installs: curl -fsSL <installation>/install.sh | sh -s -- migrate`,
		);

	const url = resolveInstallation(checkout, agent, flagUrl);
	if ('error' in url) return fail(url.error);
	const controlPlaneUrl = url.value;
	if (refuseExistingProfile(worker.workerId, worker.repoRoots, controlPlaneUrl, deps.homeDir))
		return 1;

	const manifest = await servedRuntime(controlPlaneUrl, worker.credential, deps.fetch);
	if (typeof manifest === 'number') return manifest;
	return { ...worker, checkout, controlPlaneUrl, manifest, agent, installRoot };
}

/** The clone worker cached for `checkout`, or an exit code with the refusal printed. */
function readClonedWorker(
	checkout: string,
	homeDir: string | undefined,
): Pick<MigrationPlan, 'workerId' | 'credential' | 'repoRoots' | 'cachePath'> | number {
	const cachePath = workerCredentialCachePath(checkout, homeDir);
	const cached = readWorkerCredentialCache(checkout, homeDir);
	if (cached === null)
		return fail(
			`swarm-worker migrate: no clone-based worker is registered for ${checkout} (no credential cache at ${cachePath}) — run it in the checkout the worker was registered in; to add a new worker here, run swarm-worker setup`,
		);
	if (cached === undefined)
		return fail(
			`swarm-worker migrate: the worker credential cache at ${cachePath} could not be read, so there is no worker to carry over`,
		);
	if (!isValidWorkerId(cached.workerId))
		return fail(
			`swarm-worker migrate: the cached worker id ${JSON.stringify(cached.workerId)} cannot name a profile directory`,
		);
	return {
		workerId: cached.workerId,
		credential: cached.credential,
		repoRoots: [checkout, ...(cached.extraRepoRoots ?? [])],
		cachePath,
	};
}

/**
 * Refuse when a profile already serves one of the worker's checkouts for its
 * installation, or the worker already has a profile. Answers whether it refused.
 */
function refuseExistingProfile(
	workerId: string,
	repoRoots: string[],
	controlPlaneUrl: string,
	homeDir: string | undefined,
): boolean {
	for (const root of repoRoots) {
		const serving = profileServingCheckout(root, controlPlaneUrl, homeDir);
		if (serving === undefined) continue;
		fail(
			`swarm-worker migrate: worker ${serving}'s profile already serves ${root} for ${controlPlaneUrl} — there is nothing to migrate it to`,
		);
		return true;
	}
	if (readWorkerProfile(workerId, homeDir) === null) return false;
	fail(
		`swarm-worker migrate: worker ${workerId} already has a profile at ${workerProfilePath(workerId, homeDir)} — check it with swarm-worker status ${workerId}`,
	);
	return true;
}

/**
 * The runtime the installation serves, once the worker's credential is proved
 * against it — or an exit code with the refusal printed.
 */
async function servedRuntime(
	controlPlaneUrl: string,
	credential: string,
	fetchImpl: typeof globalThis.fetch | undefined,
): Promise<AvailableWorkerRuntimeManifest | number> {
	const manifest = await fetchRuntimeManifest(controlPlaneUrl, { fetch: fetchImpl });
	if ('error' in manifest)
		return fail(`swarm-worker migrate: ${manifest.error} — nothing was changed`);
	if (!manifest.available)
		return fail(
			`swarm-worker migrate: ${controlPlaneUrl} serves no worker runtime yet (${manifest.reason}), so a profile worker could not start — nothing was changed`,
		);
	const proof = await proveCredential(controlPlaneUrl, credential, manifest, fetchImpl);
	if (proof) return fail(`swarm-worker migrate: ${proof} — nothing was changed`);
	return manifest;
}

/**
 * The installation the worker belongs to: the clone agent's, checked against
 * `--control-plane-url` when both are known; the flag's alone when no agent says.
 */
function resolveInstallation(
	checkout: string,
	agent: CloneAgent | undefined,
	flag: string | undefined,
): { value: string } | { error: string } {
	const fromClone = agent ? cloneAgentControlPlaneUrl(agent) : undefined;
	const fromFlag = flag?.trim() || undefined;
	const raw = fromClone ?? fromFlag;
	if (!raw)
		return {
			error: agent
				? `swarm-worker migrate: the clone at ${agent.cloneRoot} names no SWARM_CONTROL_PLANE_URL (in its .env or its LaunchAgent) — pass --control-plane-url <url>`
				: `swarm-worker migrate: no clone LaunchAgent serves ${checkout}, so which installation the worker belongs to cannot be read — pass --control-plane-url <url>`,
		};
	const resolved = validateControlPlaneUrl(raw);
	if ('error' in resolved)
		return { error: `swarm-worker migrate: ${fromClone ? "the clone's " : ''}${resolved.error}` };
	if (!fromClone || !fromFlag) return resolved;
	const flagUrl = validateControlPlaneUrl(fromFlag);
	if ('error' in flagUrl) return { error: `swarm-worker migrate: ${flagUrl.error}` };
	if (flagUrl.value === resolved.value) return resolved;
	return {
		error: `swarm-worker migrate: the worker for ${checkout} belongs to ${resolved.value} (its clone at ${agent?.cloneRoot}), not ${flagUrl.value} — its credential is only good on its own installation; run the install.sh ${resolved.value} serves`,
	};
}

/**
 * Prove the control plane accepts the worker's credential, before anything is
 * changed: a `HEAD` of the installation's own runtime artifact, which authenticates
 * a worker credential before it looks at anything else. `undefined` when it does;
 * otherwise why not.
 */
async function proveCredential(
	controlPlaneUrl: string,
	credential: string,
	manifest: AvailableWorkerRuntimeManifest,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | undefined> {
	const url = new URL(
		`${WORKER_RUNTIME_ARTIFACTS_PATH}/${encodeURIComponent(manifest.artifact.name)}`,
		controlPlaneUrl,
	);
	let response: Response;
	try {
		response = await fetchImpl(url, {
			method: 'HEAD',
			headers: { authorization: `Bearer ${credential}` },
			redirect: 'error',
		});
	} catch (err) {
		return `could not reach ${url.origin} to check the worker's credential: ${err instanceof Error ? err.message : String(err)}`;
	}
	if (response.status === 401 || response.status === 403)
		return `${url.origin} does not accept the cached worker credential (HTTP ${response.status}) — the worker may have been deleted, or belong to another installation`;
	if (!response.ok)
		return `could not check the worker's credential: ${WORKER_RUNTIME_ARTIFACTS_PATH} answered HTTP ${response.status}`;
	return undefined;
}

/** Say what is about to happen, warn about a run in flight, and ask — unless `--yes`. */
async function confirm(plan: MigrationPlan, yes: boolean, deps: MigrateDeps): Promise<boolean> {
	out.info(`worker ${plan.workerId} on ${plan.controlPlaneUrl}`);
	out.info(`  checkouts: ${plan.repoRoots.join(', ')}`);
	out.info(
		plan.agent
			? `  now runs from the clone at ${plan.agent.cloneRoot} (LaunchAgent ${plan.agent.label})`
			: '  no clone LaunchAgent runs it on this machine',
	);
	out.info(
		`  will run from ${plan.installRoot} on runtime v${plan.manifest.version}, its profile in ${workerProfileDir(plan.workerId, deps.homeDir)}`,
	);
	out.warn(
		`restarting the worker interrupts a run in progress, which is retried as on any daemon restart — to avoid that, drain it first (${workerDashboardUrl(plan.controlPlaneUrl, plan.workerId)}) and migrate once it is idle`,
	);
	if (yes) return true;
	const io = deps.io ?? defaultPromptIo();
	if (!io.isTTY) {
		out.error(missingAnswer('migrate', 'a confirmation', '--yes'));
		return false;
	}
	const answer = (await io.ask('Migrate this worker? [y/N] ')).trim().toLowerCase();
	if (answer === 'y' || answer === 'yes') return true;
	out.info('nothing was changed');
	return false;
}

/** Steps 1–5, with the rollback a failed install calls for. */
async function migrate(plan: MigrationPlan, deps: MigrateDeps): Promise<number> {
	const { workerId, agent, checkout } = plan;
	const run = deps.runCommand ?? runCommand;
	const profilePath = writeWorkerProfile({
		workerId,
		controlPlaneUrl: plan.controlPlaneUrl,
		credential: plan.credential,
		repoRoots: plan.repoRoots,
		homeDir: deps.homeDir,
		now: deps.now,
	});
	out.info(`wrote ${profilePath}`);
	const removeProfile = () =>
		rmSync(workerProfileDir(workerId, deps.homeDir), { recursive: true, force: true });

	const trustedPublicKey =
		deps.trustedPublicKey === undefined
			? readTrustedPublicKey()
			: (deps.trustedPublicKey ?? undefined);
	const runtime = await (deps.ensureRuntime ?? ensureRuntime)({
		controlPlaneUrl: plan.controlPlaneUrl,
		manifest: plan.manifest,
		bearer: plan.credential,
		trustedPublicKey,
		homeDir: deps.homeDir,
		fetch: deps.fetch,
	});
	if ('error' in runtime) {
		removeProfile();
		return fail(
			`swarm-worker migrate: runtime v${plan.manifest.version} was not installed — ${runtime.error}; the profile was removed and the clone worker left as it was`,
		);
	}
	out.info(
		runtime.installed
			? `installed and verified runtime v${runtime.version}`
			: `runtime v${runtime.version} is already installed`,
	);

	if (!agent) {
		removeCacheEntry(plan);
		out.info(`worker ${workerId} is ready to run from ${plan.installRoot}.`);
		out.info(
			`  stop the clone worker you started by hand for ${checkout}, then start it with: swarm-worker run ${workerId}`,
		);
		out.info(`  or, under launchd: ${workerAgentCommand()} install --profile ${workerId}`);
		return 0;
	}

	const cloneScript = join(agent.cloneRoot, 'bin', 'swarm-worker-agent');
	const uninstallFailure = await runCloneScript(run, cloneScript, ['uninstall', checkout]);
	if (uninstallFailure) {
		removeProfile();
		return fail(
			`swarm-worker migrate: ${cloneScript} uninstall ${checkout} failed (${uninstallFailure}); the profile was removed and the clone worker left as it was`,
		);
	}
	await waitForRelease(plan.repoRoots, deps);

	const installed = await (deps.installAutostart ?? installProfileWorkerAutostart)(workerId);
	if (installed.kind !== 'installed') {
		const reason =
			installed.kind === 'failed' ? installed.reason : `${installed.platform} has no launchd`;
		const restoreFailure = await runCloneScript(run, cloneScript, ['install', checkout]);
		removeProfile();
		out.error(`swarm-worker migrate: the profile LaunchAgent was not installed — ${reason}`);
		out.info(
			restoreFailure === undefined
				? `  rolled back: the clone's LaunchAgent was reinstalled and the profile removed, so worker ${workerId} runs from ${agent.cloneRoot} as before`
				: `  the profile was removed, but the clone's LaunchAgent could not be reinstalled (${restoreFailure}) — reinstall it with: ${cloneScript} install ${checkout}`,
		);
		return 1;
	}

	removeCacheEntry(plan);
	reportMigrated(plan, await otherAgentsOfClone(agent, deps));
	return 0;
}

/**
 * Run the clone's agent script: `undefined` when it exited 0, otherwise why not —
 * its exit code, or the reason it could not be run at all.
 */
async function runCloneScript(
	run: (command: string, args: string[]) => Promise<number>,
	command: string,
	args: string[],
): Promise<string | undefined> {
	try {
		const code = await run(command, args);
		return code === 0 ? undefined : `exit code ${code}`;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

const LockHolderSchema = z.object({ pid: z.number().int().positive() });

/**
 * Wait for the clone's daemon to let go of every checkout it held, as the
 * installer's own guard reads a lock: by its holder's pid being alive. A lock still
 * held when the time is up is left to that guard, whose refusal rolls back.
 */
async function waitForRelease(repoRoots: string[], deps: MigrateDeps): Promise<void> {
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const live = deps.pidIsLive ?? pidIsLive;
	const deadline = now() + (deps.releaseTimeoutMs ?? RELEASE_TIMEOUT_MS);
	const held = () =>
		repoRoots.some((root) => {
			const holder = readJson(
				join(checkoutStateDir('checkout-locks', root, deps.homeDir), 'owner.json'),
				LockHolderSchema,
			);
			return holder ? live(holder.pid) : false;
		});
	if (!held()) return;
	out.info('waiting for the clone worker to stop…');
	while (held() && now() < deadline) await sleep(RELEASE_POLL_MS);
}

/** Delete the clone's cache entry, so the clone cannot start the worker a second time. */
function removeCacheEntry(plan: MigrationPlan): void {
	try {
		rmSync(dirname(plan.cachePath), { recursive: true, force: true });
	} catch (err) {
		out.warn(
			`could not delete ${plan.cachePath} (${err instanceof Error ? err.message : String(err)}) — delete it, or swarm run:worker in ${plan.checkout} would start this worker a second time`,
		);
	}
}

/** The clone agents still running the clone the migrated worker ran from. */
async function otherAgentsOfClone(agent: CloneAgent, deps: MigrateDeps): Promise<CloneAgent[]> {
	const clone = canonicalCheckoutPath(agent.cloneRoot);
	const agents = await listCloneAgents({ homeDir: deps.homeDir, readPlist: deps.readPlist });
	return agents.filter(
		(other) => other.label !== agent.label && canonicalCheckoutPath(other.cloneRoot) === clone,
	);
}

function reportMigrated(plan: MigrationPlan, others: CloneAgent[]): void {
	const clone = plan.agent?.cloneRoot ?? '';
	out.info(
		`worker ${plan.workerId} now runs from ${plan.installRoot} and no longer needs ${clone}; its id, enrollments and source-control token are unchanged.`,
	);
	if (others.length === 0)
		out.info(`  nothing else on this machine runs ${clone}, so it can be deleted.`);
	else {
		out.info(`  ${clone} is still run by:`);
		for (const other of others) out.info(`    ${other.label} (${other.checkout})`);
		out.info('  migrate each of them (swarm-worker migrate <checkout>) before deleting it.');
	}
	out.info(`  check it with: swarm-worker status ${plan.workerId}`);
}

function fail(message: string): number {
	out.error(message);
	return 1;
}
