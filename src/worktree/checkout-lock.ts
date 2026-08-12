/**
 * One worker per checkout (issue #689).
 *
 * The session lease (`../identity/worker-session.ts`) already allows at most one
 * live session per *registered* worker, so two daemons cannot share one
 * credential. It says nothing about two daemons holding two *different*
 * credentials while pointing at the same `SWARM_WORKER_REPO_ROOT`: both would run
 * `git worktree add` against the same main repository and contend on its
 * `index.lock`. The control plane cannot police that — `repoRoot` is deliberately
 * host-local and never travels, and two checkouts of one repository (on one
 * machine or two) are legitimate capacity — so the resource being protected is the
 * *checkout*, and the guard has to be host-local.
 *
 * **Where the lock lives.** `~/.swarm/checkout-locks/<sha256(realpath(repoRoot))>/`
 * with an `owner.json` inside it. Not inside the checkout: the daemon holds no
 * project config at startup, so it does not know a project's `worktreeRoot` (which
 * is what makes `./host-local-runtime.ts`'s `<repoRoot>/<worktreeRoot>/.swarm-state`
 * reachable), and writing to `<repoRoot>/.swarm-state` would leave an untracked
 * directory in the operator's own repository. The key hashes the **realpath**, so
 * the lock is keyed to the checkout rather than to the spelling of the path that
 * reached it (the same reason `GitWorktreeManager.canonicalize` exists).
 *
 * **Why it needs its own TTL.** `LEASE_TTL_MS` next door is 4h and never
 * refreshed, sized for one agent run; a worker process lives for days, so reusing
 * it would leave a crashed daemon's checkout blocked for hours. This lock is short
 * and *refreshed* instead: the holder rewrites `refreshedAt` every
 * {@link CHECKOUT_LOCK_REFRESH_MS}, so a lapsed timestamp means a departed daemon
 * rather than a long-running one. Liveness (a pid check) stays the fast path — a
 * crashed or killed daemon's lock is reclaimable at once — and the timestamp is the
 * backstop for the recycled pid liveness cannot see (`./local-lock.ts`).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { isExpired, pathOlderThan, pidIsLive, readJson } from './local-lock.js';

/**
 * How long a checkout lock survives without a refresh. Short on purpose: it bounds
 * how long a dead daemon's checkout stays blocked when its pid has been recycled by
 * an unrelated process, which is the only case liveness gets wrong.
 */
export const CHECKOUT_LOCK_TTL_MS = 15 * 60 * 1000;

/** Refresh cadence — a third of the TTL, so two refreshes may be lost before it lapses. */
export const CHECKOUT_LOCK_REFRESH_MS = Math.floor(CHECKOUT_LOCK_TTL_MS / 3);

const CheckoutLockOwnerSchema = z.object({
	/** The canonical checkout path, recorded for the operator reading an opaque `<sha256>` directory. */
	repoRoot: z.string().min(1),
	pid: z.number().int().positive(),
	hostname: z.string().min(1),
	/**
	 * The registered worker the holder authenticates as — `null` until its first
	 * handshake answers with one, which is when the daemon first learns it.
	 */
	workerId: z.string().min(1).nullable(),
	createdAt: z.string().datetime(),
	refreshedAt: z.string().datetime(),
});
export type CheckoutLockOwner = z.infer<typeof CheckoutLockOwnerSchema>;

/**
 * A live worker already holds the checkout. A distinct class so the daemon
 * entrypoint can refuse with an actionable message instead of a stack trace.
 */
export class CheckoutHeldError extends Error {
	/** The holder's record — absent when its `owner.json` could not be read. */
	readonly holder: CheckoutLockOwner | undefined;
	readonly repoRoot: string;
	readonly lockDir: string;

	constructor(input: { holder?: CheckoutLockOwner; repoRoot: string; lockDir: string }) {
		super(
			`${describeHolder(input.holder)} already holds the checkout at '${input.repoRoot}'. ` +
				'Only one worker may run against a checkout, because both would drive git in the same ' +
				'main repository. Stop that daemon, or point SWARM_WORKER_REPO_ROOT at a separate ' +
				`checkout for this one (lock: ${input.lockDir}).`,
		);
		this.name = 'CheckoutHeldError';
		this.holder = input.holder;
		this.repoRoot = input.repoRoot;
		this.lockDir = input.lockDir;
	}
}

/** Name the holder — by its worker id when known, since that is what an operator can act on. */
function describeHolder(holder: CheckoutLockOwner | undefined): string {
	if (!holder) return 'A worker whose lock record is unreadable';
	const who = holder.workerId
		? `Worker '${holder.workerId}'`
		: // Before its first handshake a daemon has no worker id to name, so the pid is
			// all there is to point an operator at.
			'A worker that has not completed its handshake yet';
	return `${who} (pid ${holder.pid} on ${holder.hostname}, last refreshed ${holder.refreshedAt})`;
}

/** The lock this process holds, for as long as it keeps refreshing it. */
export interface CheckoutLock {
	/** Where the lock lives — logged so an operator can find (and, if truly stale, remove) it. */
	readonly lockDir: string;
	/** The record this process last wrote. */
	readonly holder: CheckoutLockOwner;
	/**
	 * Restamp `refreshedAt`. Returns `false` when this process no longer holds the
	 * lock — another daemon reclaimed it after the refresh lapsed — so the caller can
	 * say so rather than silently stomping the new holder's record.
	 */
	refresh(): boolean;
	/** Record the worker id the handshake answered with. Same return contract as {@link refresh}. */
	annotate(workerId: string): boolean;
	/** Drop the lock, making the checkout immediately re-acquirable. A no-op if it is not ours. */
	release(): void;
}

export interface AcquireCheckoutLockOptions {
	/** The checkout to lock — `SWARM_WORKER_REPO_ROOT` (default cwd) on the daemon. */
	repoRoot: string;
	/** Injectable so tests never touch the real home directory. */
	homeDir?: string;
	hostname?: string;
	pid?: number;
	now?: () => number;
	isPidLive?: (pid: number) => boolean;
}

/**
 * Take the host-local lock on `repoRoot`, or throw {@link CheckoutHeldError}.
 *
 * `mkdirSync` on the lock directory is the atomic `SET NX` equivalent
 * (`./host-local-runtime.ts` claims per-task checkouts the same way). On `EEXIST`
 * the existing owner decides: our own record is adopted, a reclaimable one is
 * removed and the create retried **once**, and a live one is refused. The single
 * retry stands in for that module's takeover guard — the contending set here is
 * daemon startups on one checkout rather than per-task provisioners, so losing the
 * retry simply means the daemon that won owns it.
 */
export function acquireCheckoutLock(options: AcquireCheckoutLockOptions): CheckoutLock {
	const now = options.now ?? Date.now;
	const isLive = options.isPidLive ?? pidIsLive;
	const pid = options.pid ?? process.pid;
	const host = options.hostname ?? hostname();
	const repoRoot = canonicalRepoRoot(options.repoRoot);
	const lockDir = resolve(
		options.homeDir ?? homedir(),
		'.swarm',
		'checkout-locks',
		createHash('sha256').update(repoRoot).digest('hex'),
	);
	const ownerPath = resolve(lockDir, 'owner.json');

	/** Whether a record left in `lockDir` belongs to this very process. */
	function isOurs(current: CheckoutLockOwner | null | undefined): boolean {
		return current?.pid === pid && current?.hostname === host;
	}

	function reclaimable(current: CheckoutLockOwner | null | undefined): boolean {
		// No readable owner at all — a corrupt write, or a crash in the microseconds
		// between `mkdir` and the write. Neither offers an owner to prove dead, so the
		// directory's own age is the only thing that can decide (`unreadableLockIsFresh`
		// next door reasons the same way).
		if (!current) return pathOlderThan(lockDir, CHECKOUT_LOCK_TTL_MS, now());
		if (!isLive(current.pid)) return true;
		return isExpired(current.refreshedAt, CHECKOUT_LOCK_TTL_MS, now());
	}

	function record(createdAt: string | undefined, workerId: string | null): CheckoutLockOwner {
		const at = new Date(now()).toISOString();
		return { repoRoot, pid, hostname: host, workerId, createdAt: createdAt ?? at, refreshedAt: at };
	}

	/** Create the lock directory and its owner file, or report nothing on `EEXIST`. */
	function tryCreate(): CheckoutLockOwner | undefined {
		try {
			mkdirSync(lockDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
			throw error;
		}
		const created = record(undefined, null);
		try {
			writeFileSync(ownerPath, `${JSON.stringify(created)}\n`, { encoding: 'utf8', flag: 'wx' });
		} catch (error) {
			rmSync(lockDir, { recursive: true, force: true });
			throw error;
		}
		return created;
	}

	function acquire(): CheckoutLockOwner {
		mkdirSync(dirname(lockDir), { recursive: true });
		const created = tryCreate();
		if (created) return created;

		const current = readJson(ownerPath, CheckoutLockOwnerSchema);
		// Our own lock: adopting it keeps acquisition idempotent within a process
		// instead of having this daemon refuse itself.
		if (current && isOurs(current)) return current;
		if (!reclaimable(current)) {
			throw new CheckoutHeldError({ holder: current ?? undefined, repoRoot, lockDir });
		}
		rmSync(lockDir, { recursive: true, force: true });
		const reclaimed = tryCreate();
		if (reclaimed) return reclaimed;
		// A concurrent startup won the re-create. It legitimately owns the checkout
		// now, so report it as the holder rather than as a race.
		throw new CheckoutHeldError({
			holder: readJson(ownerPath, CheckoutLockOwnerSchema) ?? undefined,
			repoRoot,
			lockDir,
		});
	}

	let owner = acquire();

	/**
	 * Rewrite the owner record — but only while it is still ours. `rename` rather
	 * than a plain overwrite so a concurrent reader never sees a half-written file.
	 */
	function rewrite(workerId: string | null): boolean {
		const current = readJson(ownerPath, CheckoutLockOwnerSchema);
		if (!current || !isOurs(current)) return false;
		const next = record(current.createdAt, workerId);
		const temp = `${ownerPath}.${pid}.tmp`;
		try {
			writeFileSync(temp, `${JSON.stringify(next)}\n`, 'utf8');
			renameSync(temp, ownerPath);
		} catch {
			// The lock was reclaimed between the read and the write. Report the loss
			// instead of throwing: this runs on the daemon's refresh timer, where an
			// exception would take down a worker over a lock it no longer holds.
			return false;
		}
		owner = next;
		return true;
	}

	return {
		lockDir,
		get holder(): CheckoutLockOwner {
			return owner;
		},
		refresh(): boolean {
			return rewrite(owner.workerId);
		},
		annotate(workerId: string): boolean {
			return rewrite(workerId);
		},
		release(): void {
			const current = readJson(ownerPath, CheckoutLockOwnerSchema);
			if (!isOurs(current)) return;
			rmSync(lockDir, { recursive: true, force: true });
		},
	};
}

/**
 * The checkout's identity for locking purposes: its realpath, so a symlink, a
 * trailing slash, or a relative spelling all resolve to the same lock.
 */
function canonicalRepoRoot(repoRoot: string): string {
	const absolute = resolve(repoRoot);
	try {
		return realpathSync(absolute);
	} catch {
		// Unresolvable (not a directory yet, or unreadable): lock under the literal
		// path instead. Two daemons pointed at the same bad path still collide, and
		// whatever is actually wrong with it surfaces from the code that needs it.
		return absolute;
	}
}
