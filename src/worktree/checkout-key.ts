/**
 * How host-local state is keyed to a checkout: `~/.swarm/<kind>/<sha256(realpath)>/`.
 *
 * `./checkout-lock.ts` established the convention (issue #689) and
 * `../cli/_shared/worker-credential-cache.ts` is the second thing to use it
 * (issue #788), which is why the derivation lives here rather than in either of
 * them: two modules answering "which directory belongs to this checkout" with
 * their own copy of `sha256(realpath(x))` — each with its own fallback for a path
 * that will not resolve — is exactly the fork `./local-lock.ts` was extracted to
 * prevent one scope down.
 *
 * **Why the realpath is the key.** A checkout reached through a symlink, a
 * relative spelling, or a trailing slash is the same checkout, and host-local
 * state keyed on the spelling would let one working tree hold two locks (or two
 * credential caches). `GitWorktreeManager.canonicalize` canonicalizes for the same
 * reason.
 *
 * **Why it lives under `~/.swarm/`.** Outside every checkout, deliberately: a
 * daemon holds no project config at startup so it knows no `worktreeRoot`, and
 * writing into `<repoRoot>/` would leave untracked state in the operator's own
 * repository — state no project should need a `.gitignore` entry for.
 */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/**
 * The checkout's identity: its realpath, so a symlink, a trailing slash, or a
 * relative spelling all resolve to the same key.
 */
export function canonicalCheckoutPath(repoRoot: string): string {
	const absolute = resolve(repoRoot);
	try {
		return realpathSync(absolute);
	} catch {
		// Unresolvable (not a directory yet, or unreadable): key under the literal
		// path instead. Two callers pointed at the same bad path still agree, and
		// whatever is actually wrong with it surfaces from the code that needs it.
		return absolute;
	}
}

/**
 * `<homeDir>/.swarm/<kind>/<sha256(canonicalCheckoutPath(repoRoot))>` — the
 * host-local state directory for one checkout. It canonicalizes internally so two
 * callers cannot key the same checkout differently; `homeDir` is injectable purely
 * so tests never touch the real home directory.
 */
export function checkoutStateDir(kind: string, repoRoot: string, homeDir?: string): string {
	const canonical = canonicalCheckoutPath(repoRoot);
	return resolve(
		homeDir ?? homedir(),
		'.swarm',
		kind,
		createHash('sha256').update(canonical).digest('hex'),
	);
}
