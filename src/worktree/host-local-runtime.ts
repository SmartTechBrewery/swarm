/**
 * Host-local worktree coordination for a DB/Redis-free remote worker.
 *
 * **Every artifact this module writes carries an expiry.** The Redis lease it
 * replaces had a 4h TTL (`./worktree-lease.ts`), and that TTL is not incidental:
 * issue #427 exists because a held lease with no owner and no expiry wedged every
 * later run for a task until it lapsed. A file on disk has no TTL of its own, so
 * each artifact records `createdAt` and every reader treats an expired one as
 * reclaimable. Liveness (a pid check, or this process's own in-flight set) is the
 * *fast* path; the timestamp is the backstop for what liveness cannot see — a
 * reused pid, a crash between two syscalls, a truncated write.
 *
 * Expiring an artifact never force-removes work: the reclaim gate behind this one
 * (`./reclaim.ts`) still refuses a checkout that is dirty or carries unpushed
 * commits, so the worst an expiry can do is stop a *marker* from blocking.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { BlockedRecoveryError } from './reclaim.js';
import type { WorktreeRuntime } from './worktree-runtime.js';

/**
 * Mirrors `LEASE_TTL_SEC` in `./worktree-lease.ts` — long enough to outlive the
 * longest realistic single-phase agent run, so it only ever fires on an artifact
 * whose owner is genuinely gone.
 */
const LEASE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * The preservation pin stands in for `hasResumableDeferredRun`, whose truth lives
 * in a database this worker cannot read — so it cannot learn that the pinning run
 * was retried, settled, or reset ("Reset & restart", `src/dispatch/run-reset.ts`).
 * Without an expiry the pin would block every *other* run for the task forever.
 * Deliberately longer than the lease: a deferred run may legitimately be resumed
 * hours later, and a lapsed pin still leaves dirty/unpushed protection intact.
 */
const PIN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A takeover is a few syscalls, so a guard older than this is debris from a
 * process that died mid-takeover rather than a contended one. Without this the
 * guard is the one artifact with no recovery at all: `tryClaim` refuses on sight
 * of it and `takeOver` cannot re-create it, so the task stays wedged until an
 * operator deletes the directory by hand — on a machine the instance admin may
 * not even have access to.
 */
const TAKEOVER_GUARD_TTL_MS = 5 * 60 * 1000;

/**
 * What {@link WorktreeRuntime.read} reports for a lease file that exists but
 * cannot be parsed. It is deliberately not `null` (which means "free"), so the
 * provision gate keeps treating the slot as occupied and resolves it through the
 * compare-and-set takeover rather than claiming it outright.
 */
export const UNREADABLE_LEASE_TOKEN = 'unreadable-host-local-lease';

const LocalLeaseSchema = z.object({
	token: z.string().min(1),
	ownerId: z.string().min(1),
	ownerKey: z.string().min(1),
	pid: z.number().int().positive(),
	createdAt: z.string().datetime(),
	/** Recorded for the operator staring at an opaque `<sha256>.lock` directory. */
	projectId: z.string().min(1).optional(),
	taskId: z.string().min(1).optional(),
});
type LocalLease = z.infer<typeof LocalLeaseSchema>;

const LocalPinSchema = z.object({
	ownerKey: z.string().min(1),
	createdAt: z.string().datetime(),
	projectId: z.string().min(1).optional(),
	taskId: z.string().min(1).optional(),
});

/** Written inside the takeover guard directory so a crashed guard is detectable. */
const GuardHolderSchema = z.object({
	pid: z.number().int().positive(),
	createdAt: z.string().datetime(),
});

export interface HostLocalWorktreeRuntimeOptions {
	repoRoot: string;
	worktreeRoot: string;
	/** The dispatch currently executing in this process. */
	ownerId: string;
	/** Stable run id used to let that run adopt its own preserved checkout. */
	runId?: string;
	isOwnerLive(ownerId: string): boolean;
	shutdownSignal?: AbortSignal;
}

function stateKey(projectId: string, taskId: string): string {
	return createHash('sha256').update(`${projectId}\0${taskId}`).digest('hex');
}

/**
 * `null` — absent. `undefined` — present but unparseable, which is *not* the same
 * answer: an absent artifact is free, an unreadable one is occupied by something
 * this process cannot identify.
 */
function readJson<T>(path: string, schema: z.ZodType<T>): T | null | undefined {
	if (!existsSync(path)) return null;
	try {
		return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
	} catch {
		return undefined;
	}
}

/** An unparseable or missing timestamp counts as expired — it cannot be trusted to bound anything. */
function isExpired(createdAt: string, ttlMs: number, now = Date.now()): boolean {
	const at = Date.parse(createdAt);
	if (Number.isNaN(at)) return true;
	return now - at > ttlMs;
}

/** Fallback age for an artifact whose own timestamp is unreadable or was never written. */
function pathOlderThan(path: string, ttlMs: number, now = Date.now()): boolean {
	try {
		return now - statSync(path).mtimeMs > ttlMs;
	} catch {
		// Vanished underneath us — treat as gone rather than as protected.
		return true;
	}
}

function pidIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Atomic directory creation is the local equivalent of Redis `SET NX`. A
 * takeover guard serializes stale-lock replacement across daemon processes, so
 * two provisioners cannot both remove or adopt one checkout.
 */
export function createHostLocalWorktreeRuntime(
	options: HostLocalWorktreeRuntimeOptions,
): WorktreeRuntime {
	const stateRoot = resolve(options.repoRoot, options.worktreeRoot, '.swarm-state');
	const ownerKey = options.runId ?? options.ownerId;

	function paths(projectId: string, taskId: string) {
		const key = stateKey(projectId, taskId);
		return {
			lock: resolve(stateRoot, `${key}.lock`),
			owner: resolve(stateRoot, `${key}.lock`, 'owner.json'),
			pin: resolve(stateRoot, `${key}.pin.json`),
			takeover: resolve(stateRoot, `${key}.takeover`),
			takeoverHolder: resolve(stateRoot, `${key}.takeover`, 'holder.json'),
		};
	}

	function ownerIsLive(owner: LocalLease): boolean {
		// This process knows the truth about its own dispatches, so the in-flight set
		// outranks the TTL: a phase that legitimately outruns it is still live.
		if (owner.pid === process.pid) return options.isOwnerLive(owner.ownerId);
		// Cross-process, `pid` is only a heuristic (it can be recycled), so the
		// timestamp bounds how long a stale lease can impersonate a live one.
		if (isExpired(owner.createdAt, LEASE_TTL_MS)) return false;
		return pidIsLive(owner.pid);
	}

	/** Whether an unparseable lease file may still be standing in for a live owner. */
	function unreadableLockIsFresh(projectId: string, taskId: string): boolean {
		return !pathOlderThan(paths(projectId, taskId).lock, LEASE_TTL_MS);
	}

	function writeOwner(path: string, token: string, projectId: string, taskId: string): void {
		const owner: LocalLease = {
			token,
			ownerId: options.ownerId,
			ownerKey,
			pid: process.pid,
			createdAt: new Date().toISOString(),
			projectId,
			taskId,
		};
		writeFileSync(path, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx' });
	}

	function clearOwnPin(projectId: string, taskId: string): void {
		const pinPath = paths(projectId, taskId).pin;
		const pin = readJson(pinPath, LocalPinSchema);
		if (pin?.ownerKey === ownerKey) rmSync(pinPath, { force: true });
	}

	/**
	 * Drop a takeover guard whose holder is provably gone. Called before both
	 * gates that the guard blocks, so recovery needs no operator and no sweeper —
	 * the next provisioner for the task performs it.
	 */
	function reapStaleTakeoverGuard(projectId: string, taskId: string): void {
		const path = paths(projectId, taskId);
		if (!existsSync(path.takeover)) return;
		const holder = readJson(path.takeoverHolder, GuardHolderSchema);
		if (holder) {
			// Our own guard — we are inside that takeover, never reap it.
			if (holder.pid === process.pid) return;
			if (pidIsLive(holder.pid) && !isExpired(holder.createdAt, TAKEOVER_GUARD_TTL_MS)) return;
		} else if (!pathOlderThan(path.takeover, TAKEOVER_GUARD_TTL_MS)) {
			// No readable holder yet: either a guard mid-creation (a live race we must
			// not disturb) or a crash between `mkdir` and the write. Only age tells
			// them apart, so wait out the grace window before deciding.
			return;
		}
		rmSync(path.takeover, { recursive: true, force: true });
	}

	/**
	 * Whether the lease observed as `expectedToken` may be adopted. Called while
	 * holding the takeover guard, so the answer cannot change underneath it.
	 *
	 * The unreadable case is the one worth spelling out: a corrupt lease file offers
	 * no token to compare and no owner to prove dead, so it is adopted only once it
	 * has outlived the TTL. Before that the caller gets `contended` — "could not be
	 * verified" — rather than a claim that some live phase holds it.
	 */
	function mayAdopt(projectId: string, taskId: string, expectedToken: string): boolean {
		const current = readJson(paths(projectId, taskId).owner, LocalLeaseSchema);
		if (current === undefined) {
			return expectedToken === UNREADABLE_LEASE_TOKEN && !unreadableLockIsFresh(projectId, taskId);
		}
		if (!current) return false;
		return current.token === expectedToken && !ownerIsLive(current);
	}

	/**
	 * Drop a lock directory that never got its `owner.json`. Only a crash in the
	 * microseconds between `mkdir` and the write can produce one, and it is
	 * otherwise unrecoverable: `tryClaim` fails `EEXIST` forever while `read`
	 * reports the slot free, so the provision gate returns `contended` without ever
	 * reaching the takeover path.
	 */
	function reapAbandonedLock(projectId: string, taskId: string): void {
		const path = paths(projectId, taskId);
		if (!existsSync(path.lock) || existsSync(path.owner)) return;
		if (!pathOlderThan(path.lock, TAKEOVER_GUARD_TTL_MS)) return;
		rmSync(path.lock, { recursive: true, force: true });
	}

	const runtime: WorktreeRuntime = {
		async tryClaim(projectId, taskId, token = '1') {
			const path = paths(projectId, taskId);
			mkdirSync(stateRoot, { recursive: true });
			reapStaleTakeoverGuard(projectId, taskId);
			reapAbandonedLock(projectId, taskId);
			if (existsSync(path.takeover)) return false;
			try {
				mkdirSync(path.lock);
				try {
					writeOwner(path.owner, token, projectId, taskId);
				} catch (error) {
					rmSync(path.lock, { recursive: true, force: true });
					throw error;
				}
				clearOwnPin(projectId, taskId);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
				throw error;
			}
		},
		async claim(projectId, taskId, token = '1') {
			if (await runtime.tryClaim(projectId, taskId, token)) return;
			const path = paths(projectId, taskId);
			const current = readJson(path.owner, LocalLeaseSchema);
			if (current?.ownerId === options.ownerId) {
				clearOwnPin(projectId, taskId);
				return;
			}
			if (
				current &&
				!ownerIsLive(current) &&
				(await runtime.takeOver(projectId, taskId, current.token, token))
			) {
				return;
			}
			// Classified, not raw: `reuse()` and the recovery gate (`src/pipeline/resume.ts`)
			// were written against the store-backed lease, which is best-effort and never
			// throws. A plain Error here would settle the run without a
			// `runs.recovery.blockedReason`, so the dashboard could not say why.
			throw new BlockedRecoveryError(
				'live-leased',
				`Worktree for task '${taskId}' is held by another provisioner on this host. ` +
					'Wait for it to finish, then re-run the task.',
			);
		},
		async release(projectId, taskId, token) {
			const path = paths(projectId, taskId);
			const current = readJson(path.owner, LocalLeaseSchema);
			if (!current || current.ownerId !== options.ownerId) return;
			if (token !== undefined && current.token !== token) return;
			rmSync(path.lock, { recursive: true, force: true });
		},
		async read(projectId, taskId) {
			const current = readJson(paths(projectId, taskId).owner, LocalLeaseSchema);
			if (current === null) return null;
			return current?.token ?? UNREADABLE_LEASE_TOKEN;
		},
		async takeOver(projectId, taskId, expectedToken, token) {
			const path = paths(projectId, taskId);
			reapStaleTakeoverGuard(projectId, taskId);
			try {
				mkdirSync(path.takeover);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
				throw error;
			}
			try {
				writeFileSync(
					path.takeoverHolder,
					`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
					{ encoding: 'utf8', flag: 'wx' },
				);
				if (!mayAdopt(projectId, taskId, expectedToken)) return false;
				rmSync(path.lock, { recursive: true, force: true });
				try {
					mkdirSync(path.lock);
				} catch (error) {
					// A `tryClaim` that read the guard a moment before we created it can slip
					// in here. It legitimately owns the lock now, so lose the race quietly
					// rather than throwing an unclassified error out of the gate.
					if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
					throw error;
				}
				writeOwner(path.owner, token, projectId, taskId);
				clearOwnPin(projectId, taskId);
				return true;
			} finally {
				rmSync(path.takeover, { recursive: true, force: true });
			}
		},
		async isLeased(projectId, taskId) {
			const current = readJson(paths(projectId, taskId).owner, LocalLeaseSchema);
			if (current === null) return false;
			// Unreadable: keep the reclaim gate conservative while the lock could still
			// belong to a live phase, but stop protecting it once the TTL has passed.
			if (current === undefined) return unreadableLockIsFresh(projectId, taskId);
			return ownerIsLive(current);
		},
		async hasLiveOwner(projectId, taskId) {
			const current = readJson(paths(projectId, taskId).owner, LocalLeaseSchema);
			if (current === null) return false;
			// An unreadable lease cannot be attributed to a live phase — saying it can is
			// how the gate reported "a live run holds this" for a run that did not exist
			// (issue #427). Let the compare-and-set takeover be the decider instead.
			if (current === undefined) return false;
			return ownerIsLive(current);
		},
		async isResumablePinned(projectId, taskId) {
			const path = paths(projectId, taskId);
			const pin = readJson(path.pin, LocalPinSchema);
			if (pin === null) return false;
			if (pin === undefined) return !pathOlderThan(path.pin, PIN_TTL_MS);
			if (pin.ownerKey === ownerKey) return false;
			return !isExpired(pin.createdAt, PIN_TTL_MS);
		},
		async isCancellationRequested() {
			return options.shutdownSignal?.aborted === true;
		},
		async preserve(projectId, taskId) {
			const path = paths(projectId, taskId);
			mkdirSync(stateRoot, { recursive: true });
			const temp = `${path.pin}.${randomUUID()}.tmp`;
			writeFileSync(
				temp,
				`${JSON.stringify({
					ownerKey,
					createdAt: new Date().toISOString(),
					projectId,
					taskId,
				})}\n`,
				'utf8',
			);
			renameSync(temp, path.pin);
			await runtime.release(projectId, taskId);
		},
		async clearPreservation(projectId, taskId) {
			rmSync(paths(projectId, taskId).pin, { force: true });
		},
	};

	return runtime;
}
