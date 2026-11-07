/**
 * `swarm run:worker` — start the worker registered for the checkout you are
 * standing in, with nothing to copy or paste (issue #788).
 *
 * It is a **launcher, not a second worker**: the daemon is still
 * `src/transport/connect-entry.ts`, with the same env contract, the same
 * handshake, and the same checkout lock. All this adds is where its two host-local
 * values come from — `SWARM_WORKER_REPO_ROOT` is the operator's invocation
 * directory, and `SWARM_WORKER_CREDENTIAL` comes out of the cache `swarm workers
 * register` / `register-and-enroll` wrote on this machine
 * (`../_shared/worker-credential-cache.ts`). Neither is ever printed here.
 *
 * **It hands its own process to the daemon rather than spawning one.** Where the
 * platform has `process.execve` this command resolves the credential and then
 * *replaces itself* with the daemon, so the process a supervisor started keeps its
 * pid and its parent and simply becomes the worker. That is not a micro-
 * optimisation, it is the whole point: `detectWorkerSupervision`
 * (`../../lib/worker-supervision.ts`) reads `supervised` on macOS for launchd's
 * **direct** child (`XPC_SERVICE_NAME` is inherited by every descendant of any
 * launchd job, so an arbitrary label alone proves nothing and `ppid === 1` is the
 * half that does) — or, since issue #1376, for a job carrying a SWARM worker
 * agent's own label, which is what keeps a host's launchd wrapper from reading
 * `unsupervised`. The old shape — plist → `swarm run:worker` → `npm run
 * dev:worker` → daemon — put two processes between launchd and the daemon, so
 * every machine installed by `bin/swarm-worker-agent` declared `unsupervised`
 * although launchd would in fact restart it. A consumer that refuses on
 * `unsupervised` then refuses that machine: the fleet update introduced by issue
 * #1024 skips one, and issue #997's own module comment predicted exactly this
 * ("on an installation shaped like this one it refuses everything"). Confirmed
 * live on 2026-09-18 — all twelve machines on this installation declared
 * `unsupervised` while running under launchd with `KeepAlive`.
 *
 * Two consequences worth keeping in mind, both improvements:
 *
 * - **Signals reach the daemon.** `runCommand` installs no forwarding, so
 *   launchd's `SIGTERM` used to land on this launcher and the daemon learned of it
 *   only through process-group semantics. After the replacement there is nothing
 *   in between to forward anything.
 * - **No plist has to change.** The fix is in the command every agent already
 *   runs, so an installed LaunchAgent starts declaring `supervised` as soon as the
 *   machine is on a build carrying this and has been restarted — no reinstall, and
 *   nothing for a machine's owner to edit by hand.
 *
 * `process.execve` is POSIX-only and recent (Node 24+), so its absence or failure
 * falls back to the previous spawn. A machine that takes the fallback keeps
 * working exactly as it did; under a SWARM worker agent its label still reads
 * `supervised` (issue #1376), and anywhere else it declares `unsupervised`.
 *
 * `npm run dev:worker` with explicit env vars stays exactly as it was, and is
 * still the path for a remote machine, a process supervisor, or anything else that
 * is not "the machine that registered this worker is the machine running it".
 *
 * Three things make that work with no change to the daemon:
 *
 * - **The injected environment wins over the SWARM checkout's own `.env`.**
 *   `dev:worker` runs `node --env-file-if-exists=.env …`, and Node's `--env-file`
 *   does *not* override a variable already present in the environment. So that
 *   `.env` still supplies `SWARM_CONTROL_PLANE_URL`, while our two values take
 *   precedence over any stale copies of them there. That ordering is the
 *   load-bearing assumption of this command.
 * - **The daemon runs in `REPO_ROOT`** — the SWARM checkout this CLI's own code
 *   lives in — so its `.env` and its `tsx` loader resolve there even though the
 *   operator is standing in a different repository. The replacement therefore
 *   `chdir`s before it execs, since `execve` inherits the working directory.
 * - **The daemon still owns exclusivity.** It takes the checkout lock itself, so a
 *   second `run:worker` in the same checkout is refused by the existing
 *   `CheckoutHeldError` path. This command adds no locking of its own.
 *
 * The credential travels in the child's environment, never in `argv` — the same
 * exposure it already has in `.env`, and unlike an argument it never appears in
 * `ps` output.
 *
 * **A worker holding several checkouts is still started from one** (issue #1059).
 * The invocation directory is the worker's *primary* checkout, and every extra
 * checkout `swarm workers register --extra-checkout` / `add-checkout` recorded in
 * its cache entry follows it in `SWARM_WORKER_REPO_ROOT`, `path.delimiter`-
 * separated — the list the daemon reads (`resolveWorkerRepoRoots`,
 * `../../lib/env.ts`). An extra checkout has no cache entry of its own, so running
 * this command in one gets the same "no worker registered" answer as any other
 * unregistered directory.
 *
 * A git *worktree* of a checkout has its own realpath and therefore its own key,
 * so it has no cache entry and gets the "no worker registered for this checkout"
 * message. That is correct: the daemon must run against the main checkout.
 *
 * A checkout that only a **profile-based worker** serves (issue #1296,
 * `swarm workers setup --profile`) has no cache entry either, but it is not
 * unregistered: it is refused with the `swarm-launcher run <workerId>` that starts
 * it, since the installation that worker serves is its profile's, not this clone's.
 */

import { delimiter, join } from 'node:path';
import { parseArgs } from 'node:util';
import { listWorkerProfiles } from '../../launcher/worker-profile.js';
import { canonicalCheckoutPath } from '../../worktree/checkout-key.js';
import { runCommand } from '../_shared/exec.js';
import { launcherCommand } from '../_shared/installation-command.js';
import * as out from '../_shared/output.js';
import { REPO_ROOT } from '../_shared/paths.js';
import {
	readWorkerCredentialCache,
	workerCredentialCachePath,
} from '../_shared/worker-credential-cache.js';

const USAGE = `swarm run:worker — start this checkout's registered worker

Usage: swarm run:worker

Becomes the worker daemon for the repository checkout you are standing in,
reading its credential from the local cache that \`swarm workers register\` /
\`register-and-enroll\` wrote on this machine. This process is replaced by the
daemon rather than parenting it, so under launchd or systemd the supervisor's own
job is the worker. Nothing is printed, and
nothing has to be pasted: SWARM_WORKER_REPO_ROOT is the current directory and
SWARM_WORKER_CREDENTIAL comes from the cache.

A worker serving more than one repository is started the same way, from its
primary checkout: every extra checkout recorded with \`swarm workers register
--extra-checkout\` or \`swarm workers add-checkout\` is appended to
SWARM_WORKER_REPO_ROOT after the current directory.

It needs no DATABASE_URL — the daemon is DB-free and so is this launcher. The
SWARM installation's own .env still supplies SWARM_CONTROL_PLANE_URL.

For a remote machine, a process supervisor, or any other setup where the machine
that registered the worker is not the one running it, keep using \`npm run
dev:worker\` with SWARM_WORKER_CREDENTIAL and SWARM_WORKER_REPO_ROOT set
explicitly — that path is unchanged.

A checkout served only by a profile-based worker (swarm workers setup --profile)
is refused here, naming the command that starts it: swarm-launcher run <worker-id>.`;

/**
 * The node arguments that *are* `npm run dev:worker`, stated here because the
 * replacement below has to exec node itself: exec'ing `npm` would put npm back
 * between the supervisor and the daemon, which is the very thing this avoids.
 *
 * Kept in step with the script by `tests/unit/cli/commands/run-worker.test.ts`,
 * which reads `package.json` and fails if the two ever disagree — the drift this
 * duplication would otherwise invite.
 *
 * Paths are absolute so the exec'd process does not depend on having chdir'd
 * correctly for anything but the bare `tsx/esm` specifier, which node resolves
 * from the working directory.
 */
export function daemonNodeArgs(repoRoot: string): string[] {
	return [
		`--env-file-if-exists=${join(repoRoot, '.env')}`,
		'--import',
		'tsx/esm',
		join(repoRoot, 'src/transport/connect-entry.ts'),
	];
}

/** The two ways out of a missing or unusable cache entry, offered with every failure. */
function remedies(): void {
	out.info(
		'  register a worker here: swarm workers register-and-enroll <owner-identifier> <project-id> --name <name> --cli <clis>',
	);
	out.info(
		'  or start the daemon yourself: SWARM_WORKER_CREDENTIAL=<credential> SWARM_WORKER_REPO_ROOT=<checkout> npm run dev:worker',
	);
}

export async function run(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: { help: { type: 'boolean', short: 'h' } },
		allowPositionals: false,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	// npm resets its script's cwd to the package root, but preserves the caller's
	// directory in INIT_CWD. The global binary has no INIT_CWD, so cwd remains its
	// invocation checkout. Never use ambient SWARM_WORKER_REPO_ROOT here.
	const repoRoot = canonicalCheckoutPath(process.env.INIT_CWD ?? process.cwd());
	const cached = readWorkerCredentialCache(repoRoot);

	if (cached === null) {
		if (refuseProfileWorkers(repoRoot)) return 1;
		out.error(`no worker registered for this checkout (${repoRoot})`);
		remedies();
		return 1;
	}
	if (cached === undefined) {
		out.error(
			`this checkout's cached worker credential could not be read: ${workerCredentialCachePath(repoRoot)}`,
		);
		remedies();
		return 1;
	}

	// `repoRoot` rather than `cached.repoRoot`: they agree by construction (both are
	// the realpath the cache key was derived from), and the stored field is a
	// human-readable record for an operator reading an opaque `<sha256>` directory,
	// exactly as `CheckoutLockOwner.repoRoot` is. The primary checkout leads, which is
	// what makes it the primary one to the daemon.
	const repoRoots = [repoRoot, ...(cached.extraRepoRoots ?? [])];
	// The worker id and every checkout, never the credential.
	out.step(`starting worker '${cached.workerId}' for ${repoRoots.join(', ')}…`);
	const env = {
		SWARM_WORKER_REPO_ROOT: repoRoots.join(delimiter),
		SWARM_WORKER_CREDENTIAL: cached.credential,
	};

	// Become the daemon rather than parenting it, so a supervisor's job *is* the
	// worker (see this module's header).
	const refusal = becomeDaemon(env);
	if (refusal === undefined) return 0;

	// Platform refusal or a bad exec: say so once and spawn, which is what every
	// machine did before this existed. Never fatal — a worker that starts behind a
	// needless extra process is strictly better than one that does not start.
	out.warn(`${refusal}; starting the daemon as a child process instead`);
	return runCommand('npm', ['run', 'dev:worker'], { cwd: REPO_ROOT, env });
}

/**
 * A checkout served only by a profile-based worker (issue #1296) is started by
 * `swarm-launcher run <workerId>`, not from here: that worker's installation is the
 * one its profile names, which need not be the one this clone's `.env` does. So
 * this names the launcher command and refuses, rather than claiming nothing is
 * registered. Answers whether it refused.
 */
function refuseProfileWorkers(repoRoot: string): boolean {
	const serving = listWorkerProfiles().filter(({ profile }) =>
		profile?.repoRoots.includes(repoRoot),
	);
	if (serving.length === 0) return false;
	out.error(
		`this checkout (${repoRoot}) is served by a profile-based worker, which swarm run:worker does not start`,
	);
	for (const { workerId, profile } of serving) {
		out.info(
			`  start it with: ${launcherCommand()} run ${workerId} (serves ${profile?.controlPlaneUrl})`,
		);
	}
	return true;
}

/**
 * Replace this process with the daemon, and answer `undefined` once it is no longer
 * ours to speak for.
 *
 * A successful `execve` does not return at all, so the only way out of here is a
 * refusal — which is what the return value carries, ready to print. The one
 * remaining path, a runtime that returns without either replacing or throwing, is
 * not reachable through POSIX `execve` (it replaces the image or sets `errno`, which
 * Node raises); it is read as success rather than falling through to the spawn,
 * because a second daemon started on the strength of an exec that may have half
 * happened is the worse of the two guesses.
 *
 * The whole environment is carried over, not just the two values this command
 * resolved: `XPC_SERVICE_NAME` is half of what the macOS supervision read looks at,
 * and `PATH`/`HOME` are what the daemon and the agent CLIs it spawns need.
 */
function becomeDaemon(env: Record<string, string>): string | undefined {
	if (typeof process.execve !== 'function') {
		return 'this runtime cannot hand its process to the daemon (no process.execve)';
	}
	try {
		// `execve` inherits the working directory, and the daemon's `.env` and its `tsx`
		// loader both resolve from the SWARM checkout rather than the served one.
		process.chdir(REPO_ROOT);
		process.execve(process.execPath, [process.execPath, ...daemonNodeArgs(REPO_ROOT)], {
			...process.env,
			...env,
		});
	} catch (err) {
		return `could not hand this process to the daemon (${err instanceof Error ? err.message : String(err)})`;
	}
	return undefined;
}
