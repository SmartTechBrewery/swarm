/**
 * The worker **session lease** — the single source of truth for the shape
 * (ai/CODING_STANDARDS.md "Zod is the source of truth"). Where `Worker`
 * (`./worker.ts`) models *where* a user can execute, a worker session models the
 * one **live claim** on that execution environment: at most one session exists
 * per registered worker, so two `swarm-cli` daemons can never drive the same
 * machine at once (ADR-001 "User / worker"). Phase 2 of the worker slice, on top
 * of Phase 1's identity (`./worker-service.ts`).
 *
 * A session carries a **fencing token** — a per-worker monotonic counter bumped
 * every time the lease is (re-)acquired. It is the standard fencing-token
 * pattern for a lease: a stale holder that was replaced (its expired lease
 * re-acquired by a newer daemon) still remembers the old token, so a later
 * dispatch/advance can reject its writes by comparing tokens
 * (`validateFencingToken`, the seam #130 calls). `lastHeartbeatAt` drives
 * expiry: a session is *live* only while its last heartbeat is within the
 * heartbeat TTL, and an expired session may be re-acquired with a bumped token.
 * A *live* one may be re-acquired too, but only by the daemon that already holds
 * it, which proves that by presenting the lease's own `sessionId`/`fencingToken`
 * ({@link WorkerSessionReclaimSchema}, issue #608) — so a control-plane restart
 * costs a reconnecting daemon a round trip rather than the whole TTL, while a
 * genuinely competing daemon is still refused. `currentRunId` is a legacy
 * single-run pointer. Federated capacity is tracked by durable dispatch claims
 * because one worker may have multiple allocations.
 *
 * This is the persisted-row read model; `src/db/schema/workerSessions.ts` is its
 * table and `src/db/repositories/workerSessionsRepository.ts` owns the atomic
 * acquire/heartbeat/release transitions. The domain-level helpers here
 * (`isSessionLive`, `nextFencingToken`, `isReclaimOf`, `isReclaimedSession`) stay
 * dependency-free so the repository, the service, and the transport share one
 * definition of "live", "next token", "the caller's own lease", and "the acquire
 * that handed that lease back".
 */

import { z } from 'zod';

/** The fencing token a brand-new session starts at; bumped on every re-acquire. */
export const INITIAL_FENCING_TOKEN = 1;

/**
 * A worker session lease. `workerId` is a `workers.id` (`uuid`); `id` is the
 * session row's own generated `uuid`. `fencingToken` is a per-worker monotonic
 * counter (starts at {@link INITIAL_FENCING_TOKEN}, bumped on each re-acquire);
 * `lastHeartbeatAt` is the instant expiry is measured from; `currentRunId` is a
 * nullable compatibility pointer into `runs`.
 */
export const WorkerSessionSchema = z.object({
	id: z.string().uuid(),
	workerId: z.string().uuid(),
	instanceId: z.string().uuid().nullable(),
	fencingToken: z.number().int().positive(),
	lastHeartbeatAt: z.date(),
	currentRunId: z.string().uuid().nullable(),
	createdAt: z.date(),
});

export type WorkerSession = z.infer<typeof WorkerSessionSchema>;

/** A memory-only daemon identity carried across its handshakes (issue #719). */
export const WorkerSessionInstanceIdSchema = z.string().uuid();
export type WorkerSessionInstanceId = z.infer<typeof WorkerSessionInstanceIdSchema>;

/**
 * Proof that the caller already holds the lease it is acquiring — the `sessionId`
 * and `fencingToken` the control plane minted for it, which live only in that
 * daemon's memory. Presented on a **reconnect** handshake so a daemon whose socket
 * the control plane dropped (a router restart, redeploy, or crash — nothing
 * released the leases it held) takes its own lease back on the next round trip
 * instead of waiting out the heartbeat TTL (issue #608).
 *
 * Possession of the pair is a sound proof because both values are minted by the
 * control plane in the handshake response and never leave the holder: they are not
 * persisted on the worker, never logged, and never placed in a URL. A second daemon
 * reading the same `SWARM_WORKER_CREDENTIAL` has the credential but not the pair,
 * so it is still refused — and the proof is checked *on top of* credential
 * authentication, never instead of it.
 */
export const WorkerSessionReclaimSchema = z.object({
	sessionId: z.string().uuid(),
	fencingToken: z.number().int().positive(),
});

export type WorkerSessionReclaim = z.infer<typeof WorkerSessionReclaimSchema>;

/**
 * Whether `reclaim` proves possession of `session` — an exact match on *both* the
 * session's own id and its current fencing token. Pure, so the acquire transaction
 * and its tests share one definition, exactly as {@link isSessionLive} is shared.
 * `undefined` (no proof presented) is always `false`: a competing daemon, and a
 * restarted daemon that lost the pair, must both stay refused.
 *
 * Matching the token as well as the id is what makes a *superseded* holder's stale
 * proof fail: once anyone re-acquires, the row's token has moved past the one that
 * daemon remembers.
 */
export function isReclaimOf(
	session: { id: string; fencingToken: number },
	reclaim: WorkerSessionReclaim | undefined,
): boolean {
	return (
		reclaim !== undefined &&
		reclaim.sessionId === session.id &&
		reclaim.fencingToken === session.fencingToken
	);
}

/**
 * The next fencing token after `current` — the single named place the monotonic
 * bump lives, so the acquire transaction and its tests agree on it. Tokens only
 * ever move forward, never reused, so a replaced holder's token can never again
 * validate as current.
 */
export function nextFencingToken(current: number): number {
	return current + 1;
}

/**
 * Whether `session` is the lease `reclaim` proved possession of, re-acquired —
 * i.e. whether the acquire that produced it took {@link isReclaimOf}'s reclaim
 * branch (issue #719). The replace branch keeps the row's own `id` and bumps the
 * token by exactly one ({@link nextFencingToken}), so the returned session plus
 * the proof the caller presented identify the branch without the repository
 * having to report it.
 *
 * The one thing a caller needs this for is telling "the same daemon is back, and
 * its phase may still be executing" apart from "a new generation took this worker
 * over", so a reap of the previous generation's execution claims can never fire on
 * a reconnecting daemon. `undefined` (no proof) and a stale proof are both
 * `false`: a *restarted* daemon lost the pair with its memory, and a superseded
 * holder's remembered token is more than one behind. A first-ever insert is
 * `false` too — it mints a fresh row `id`, which no proof can name.
 */
export function isReclaimedSession(
	session: { id: string; fencingToken: number },
	reclaim: WorkerSessionReclaim | undefined,
): boolean {
	return (
		reclaim !== undefined &&
		reclaim.sessionId === session.id &&
		session.fencingToken === nextFencingToken(reclaim.fencingToken)
	);
}

/**
 * Whether a session whose last heartbeat was `lastHeartbeatAt` is still *live*
 * at `now` under a `ttlMs` heartbeat TTL: live while strictly less than the TTL
 * has elapsed, expired once the elapsed time reaches it. Pure so the repository's
 * SQL liveness guard and the TTL-boundary unit tests share one definition.
 */
export function isSessionLive(lastHeartbeatAt: Date, ttlMs: number, now: Date): boolean {
	return now.getTime() - lastHeartbeatAt.getTime() < ttlMs;
}

/**
 * Raised when a live session already holds the lease for a worker and a second
 * `acquireLease` is attempted — the "one live session per registered worker"
 * invariant. A distinct type (not a bare `Error`) so the CLI/daemon can tell a
 * lease contention apart from an unexpected failure and surface a retry hint.
 */
export class WorkerSessionHeldError extends Error {
	constructor(public readonly workerId: string) {
		super(`A live session already holds the lease for worker ${workerId}`);
		this.name = 'WorkerSessionHeldError';
	}
}
