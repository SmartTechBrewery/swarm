/**
 * `swarm run:worker` — start the worker registered for the checkout you are
 * standing in, with nothing to copy or paste (issue #788).
 *
 * It is a **launcher, not a second worker**: the daemon is still
 * `src/transport/connect-entry.ts` started by `npm run dev:worker`, with the same
 * env contract, the same handshake, and the same checkout lock. All this adds is
 * where its two host-local values come from — `SWARM_WORKER_REPO_ROOT` is the
 * operator's invocation directory, and `SWARM_WORKER_CREDENTIAL` comes out of the
 * cache `swarm workers register` / `register-and-enroll` wrote on this machine
 * (`../_shared/worker-credential-cache.ts`). Neither is ever printed here.
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
 * - **The child is spawned in `REPO_ROOT`** — the SWARM checkout this CLI's own
 *   code lives in — so the npm script and its `.env` resolve there even though the
 *   operator is standing in a different repository (`commands/start.ts` spawns
 *   `npm run db:migrate` the same way).
 * - **The daemon still owns exclusivity.** It takes the checkout lock itself, so a
 *   second `run:worker` in the same checkout is refused by the existing
 *   `CheckoutHeldError` path. This command adds no locking of its own.
 *
 * The credential travels in the child's environment, never in `argv` — the same
 * exposure it already has in `.env`, and unlike an argument it never appears in
 * `ps` output.
 *
 * A git *worktree* of a checkout has its own realpath and therefore its own key,
 * so it has no cache entry and gets the "no worker registered for this checkout"
 * message. That is correct: the daemon must run against the main checkout.
 */

import { parseArgs } from 'node:util';
import { canonicalCheckoutPath } from '../../worktree/checkout-key.js';
import { runCommand } from '../_shared/exec.js';
import * as out from '../_shared/output.js';
import { REPO_ROOT } from '../_shared/paths.js';
import {
	readWorkerCredentialCache,
	workerCredentialCachePath,
} from '../_shared/worker-credential-cache.js';

const USAGE = `swarm run:worker — start this checkout's registered worker

Usage: swarm run:worker

Starts the worker daemon (npm run dev:worker) for the repository checkout you are
standing in, reading its credential from the local cache that \`swarm workers
register\` / \`register-and-enroll\` wrote on this machine. Nothing is printed, and
nothing has to be pasted: SWARM_WORKER_REPO_ROOT is the current directory and
SWARM_WORKER_CREDENTIAL comes from the cache.

It needs no DATABASE_URL — the daemon is DB-free and so is this launcher. The
SWARM installation's own .env still supplies SWARM_CONTROL_PLANE_URL.

For a remote machine, a process supervisor, or any other setup where the machine
that registered the worker is not the one running it, keep using \`npm run
dev:worker\` with SWARM_WORKER_CREDENTIAL and SWARM_WORKER_REPO_ROOT set
explicitly — that path is unchanged.`;

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

	// The worker id and the checkout, never the credential.
	out.step(`starting worker '${cached.workerId}' for ${repoRoot}…`);
	return runCommand('npm', ['run', 'dev:worker'], {
		cwd: REPO_ROOT,
		// `repoRoot` rather than `cached.repoRoot`: they agree by construction (both
		// are the realpath the cache key was derived from), and the stored field is a
		// human-readable record for an operator reading an opaque `<sha256>`
		// directory, exactly as `CheckoutLockOwner.repoRoot` is.
		env: { SWARM_WORKER_REPO_ROOT: repoRoot, SWARM_WORKER_CREDENTIAL: cached.credential },
	});
}
