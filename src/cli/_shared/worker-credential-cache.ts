/**
 * The per-checkout worker credential cache (issue #788).
 *
 * `workers.credential_hash` is a one-way SHA-256 (`src/db/schema/workers.ts`), so
 * the raw credential `swarm workers register` prints exists exactly once. Until
 * now that meant an operator re-typed it — out of one terminal's scrollback into
 * another command's environment — every time the daemon on *their own machine*
 * needed restarting. Since a worker is permanently bound to one checkout
 * (`../../worktree/checkout-lock.ts`), "which credential belongs to the repository
 * I am standing in" is a question the machine that ran `register` can answer for
 * itself: it leaves the answer here, and `../commands/run-worker.ts` reads it.
 *
 * **Where it lives.** `~/.swarm/worker-credentials/<sha256(realpath(repoRoot))>/credential.json`
 * — the same host-local convention the checkout lock uses, derived from the same
 * helper (`../../worktree/checkout-key.ts`) rather than a second copy of it. Never
 * inside the checkout, so no project needs a `.gitignore` entry for it.
 *
 * **The credential is at rest on disk**, which it already was in the worker's
 * `.env`, at the same owner-only expectation. This is the stricter of the two:
 * `700` on the directory and `600` on the file, both set explicitly rather than
 * left to the process umask, and nothing ever prints the value back — `register`
 * names the *path* it wrote, and `run:worker` names neither.
 *
 * Only the operator CLI reads or writes this. The daemon deliberately does not:
 * its env contract is unchanged, and a remote machine (or a process supervisor)
 * still gets the credential from the line `register` prints.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { canonicalCheckoutPath, checkoutStateDir } from '../../worktree/checkout-key.js';
import { readJson } from '../../worktree/local-lock.js';

/** The cache directory's `kind` under `~/.swarm/`, sibling to `checkout-locks`. */
const CACHE_KIND = 'worker-credentials';

const CREDENTIAL_FILE = 'credential.json';

export const WorkerCredentialCacheSchema = z.object({
	workerId: z.string().min(1),
	credential: z.string().min(1),
	/** The canonical checkout path, recorded for an operator reading an opaque `<sha256>` directory. */
	repoRoot: z.string().min(1),
	registeredAt: z.string().datetime(),
});
export type WorkerCredentialCache = z.infer<typeof WorkerCredentialCacheSchema>;

/** `~/.swarm/worker-credentials/<sha256(realpath(repoRoot))>/credential.json`. */
export function workerCredentialCachePath(repoRoot: string, homeDir?: string): string {
	return resolve(checkoutStateDir(CACHE_KIND, repoRoot, homeDir), CREDENTIAL_FILE);
}

export interface WriteWorkerCredentialCacheInput {
	repoRoot: string;
	workerId: string;
	credential: string;
	/** Injectable so tests never touch the real home directory or clock. */
	homeDir?: string;
	now?: () => number;
}

/**
 * Write (or replace) this checkout's cache entry and return the path written.
 *
 * Re-registering in the same checkout replaces the file: the newest credential is
 * the live one, and the previous worker's is unrecoverable anyway. The write goes
 * through a temporary file and a `rename` — the same shape the checkout lock's
 * `rewrite` uses — so a concurrent reader never sees a half-written record.
 */
export function writeWorkerCredentialCache(input: WriteWorkerCredentialCacheInput): string {
	const now = input.now ?? Date.now;
	const dir = checkoutStateDir(CACHE_KIND, input.repoRoot, input.homeDir);
	const path = resolve(dir, CREDENTIAL_FILE);

	// `~/.swarm/worker-credentials/` is created owner-only and then chmod'ed
	// explicitly, so the result does not depend on the process umask or on a
	// pre-existing directory's mode. `~/.swarm` itself is deliberately left alone —
	// `checkout-locks/` shares it, and its mode is not this module's to decide.
	mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
	chmodSync(dirname(dir), 0o700);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);

	const record: WorkerCredentialCache = {
		workerId: input.workerId,
		credential: input.credential,
		// The same canonicalization the directory name is derived from, so the recorded
		// path and the `<sha256>` it sits under can never disagree about which checkout
		// this is.
		repoRoot: canonicalCheckoutPath(input.repoRoot),
		registeredAt: new Date(now()).toISOString(),
	};
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
	renameSync(temp, path);
	// After the rename, in case the file it replaced had a laxer mode.
	chmodSync(path, 0o600);
	return path;
}

/**
 * `null` — no entry for this checkout (the actionable "register here first" case).
 * `undefined` — an entry exists but could not be read or does not match the schema,
 * which is a different problem and gets its own message.
 */
export function readWorkerCredentialCache(
	repoRoot: string,
	homeDir?: string,
): WorkerCredentialCache | null | undefined {
	return readJson(workerCredentialCachePath(repoRoot, homeDir), WorkerCredentialCacheSchema);
}
