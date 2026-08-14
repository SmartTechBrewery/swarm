/**
 * Provider-neutral **worker-session** surface — the seam the in-process MVP
 * worker (and, later, the #130 dispatch gate) programs against so it never
 * touches the `worker_sessions` table directly. The lease/heartbeat companion to
 * the worker identity service (`./worker-service.ts`), Phase 2 of the worker
 * slice (ADR-001 "User / worker").
 *
 * Every mutating operation **authenticates the worker by its Phase-1 credential**
 * first (`resolveWorkerByCredential`): an unknown/empty credential is an auth
 * failure, so it throws {@link UnknownWorkerCredentialError} rather than silently
 * no-op'ing. `validateFencingToken` and `getLiveSessionForWorker` are the
 * read-side seams a server-side caller (which already knows the worker id) uses —
 * `#130` calls `validateFencingToken` before it dispatches/advances a run to
 * reject a stale/replaced worker.
 *
 * The heartbeat TTL is read from `SWARM_WORKER_HEARTBEAT_TTL_MS` (default
 * {@link DEFAULT_WORKER_HEARTBEAT_TTL_MS}) and validated as a positive integer,
 * mirroring the sibling worker knobs (`src/worker/runtime-options.ts`); it is
 * resolved once per call and threaded down, and overridable per call so tests can
 * drive expiry deterministically. There is no daemon/network transport here — the
 * MVP worker is in-process, so these are plain in-process service calls.
 */

import {
	acquireLease,
	getLiveSession,
	getRetainedSession,
	heartbeat as heartbeatLease,
	releaseLease,
	setCurrentRun as setCurrentRunRow,
} from '../db/repositories/workerSessionsRepository.js';
import { optionalEnv } from '../lib/env.js';
import { resolveWorkerByCredential } from './worker-service.js';
import type {
	WorkerSession,
	WorkerSessionInstanceId,
	WorkerSessionReclaim,
} from './worker-session.js';

export {
	type WorkerSession,
	WorkerSessionHeldError,
	type WorkerSessionInstanceId,
	type WorkerSessionReclaim,
} from './worker-session.js';

/** Default heartbeat TTL when `SWARM_WORKER_HEARTBEAT_TTL_MS` is unset (60s). */
export const DEFAULT_WORKER_HEARTBEAT_TTL_MS = 60_000;

/**
 * Raised when a raw worker credential does not resolve to any registered worker —
 * an authentication failure on a session operation. A distinct type so callers
 * can tell a bad credential apart from a lease-contention or lookup miss.
 */
export class UnknownWorkerCredentialError extends Error {
	constructor() {
		super('Worker credential did not resolve to a registered worker');
		this.name = 'UnknownWorkerCredentialError';
	}
}

/**
 * Resolve the effective heartbeat TTL in ms from `SWARM_WORKER_HEARTBEAT_TTL_MS`,
 * validating a positive integer like the sibling worker knobs
 * (`src/worker/runtime-options.ts`); throws on a non-positive/non-integer value.
 */
export function resolveHeartbeatTtlMs(
	raw = optionalEnv('SWARM_WORKER_HEARTBEAT_TTL_MS', String(DEFAULT_WORKER_HEARTBEAT_TTL_MS)),
): number {
	const ttl = Number(raw);
	if (!Number.isInteger(ttl) || ttl < 1) {
		throw new Error(`SWARM_WORKER_HEARTBEAT_TTL_MS must be a positive integer, got '${raw}'`);
	}
	return ttl;
}

/** Resolve a worker by its raw credential or throw {@link UnknownWorkerCredentialError}. */
async function authenticateWorker(rawCredential: string): Promise<string> {
	const worker = await resolveWorkerByCredential(rawCredential);
	if (!worker) throw new UnknownWorkerCredentialError();
	return worker.id;
}

/** A freshly acquired lease plus its fencing token — the token the daemon carries thereafter. */
export interface AcquiredSession {
	session: Awaited<ReturnType<typeof acquireLease>>;
	fencingToken: number;
}

/**
 * Acquire the single lease for the worker behind `rawCredential`. Authenticates
 * the worker first, then acquires atomically: a live lease for the same worker is
 * rejected (`WorkerSessionHeldError`), an expired one is re-acquired with a bumped
 * fencing token. The same user may hold independent leases for *different*
 * registered workers — leases are keyed by worker, not by user.
 *
 * `reclaim` is the optional proof that the caller is the lease's *own* holder,
 * reconnecting after the control plane dropped its socket (issue #608): a live
 * lease it matches is re-acquired (with the token still bumped) instead of
 * refused. Credential authentication stays **first** and unchanged — the proof is
 * possession on top of authentication, never instead of it.
 */
export async function acquireSession(
	rawCredential: string,
	ttlMs = resolveHeartbeatTtlMs(),
	reclaim?: WorkerSessionReclaim,
	instanceId?: WorkerSessionInstanceId,
): Promise<AcquiredSession> {
	const workerId = await authenticateWorker(rawCredential);
	const session = instanceId
		? await acquireLease(workerId, ttlMs, reclaim, instanceId)
		: await acquireLease(workerId, ttlMs, reclaim);
	return { session, fencingToken: session.fencingToken };
}

/**
 * Heartbeat the worker's lease. Authenticates the worker, then refreshes its
 * session only when `fencingToken` matches and the lease has not expired.
 * Returns `true` if a live, current-token session was refreshed.
 */
export async function heartbeat(
	rawCredential: string,
	fencingToken: number,
	ttlMs = resolveHeartbeatTtlMs(),
): Promise<boolean> {
	const workerId = await authenticateWorker(rawCredential);
	return heartbeatLease(workerId, fencingToken, ttlMs);
}

/**
 * Gracefully release the worker's lease. Authenticates the worker, then marks the
 * matching active lease as released, clears its current run, and retains the session
 * row and its token counter to preserve fencing-token monotonicity. Only releases
 * when `fencingToken` matches and the session is active. Returns `true` if the
 * session was updated, `false` if the lease was stale, already released, or not found.
 */
export async function releaseSession(
	rawCredential: string,
	fencingToken: number,
): Promise<boolean> {
	const workerId = await authenticateWorker(rawCredential);
	return releaseLease(workerId, fencingToken);
}

/**
 * Set (or clear, with `null`) the run the worker's live session is executing.
 * Authenticates the worker, then updates only a live, current-token session.
 * Returns `true` if such a session was updated.
 */
export async function setCurrentRun(
	rawCredential: string,
	fencingToken: number,
	runId: string | null,
	ttlMs = resolveHeartbeatTtlMs(),
): Promise<boolean> {
	const workerId = await authenticateWorker(rawCredential);
	return setCurrentRunRow(workerId, fencingToken, runId, ttlMs);
}

/**
 * The fencing-token validation seam #130 calls before dispatching/advancing a
 * run: `true` only when the worker has a *live* session whose fencing token
 * equals `token`. A stale token from a replaced worker, an expired lease, or a
 * worker with no session all return `false`. Takes a `workerId` directly — a
 * server-side dispatch already knows which worker it is fencing, and holds no
 * raw credential.
 */
export async function validateFencingToken(
	workerId: string,
	token: number,
	ttlMs = resolveHeartbeatTtlMs(),
): Promise<boolean> {
	const session = await getLiveSession(workerId, ttlMs);
	return session?.fencingToken === token;
}

/** The worker's live session, or `undefined` if it has none / its lease expired. */
export async function getLiveSessionForWorker(
	workerId: string,
	ttlMs = resolveHeartbeatTtlMs(),
): Promise<WorkerSession | undefined> {
	return getLiveSession(workerId, ttlMs);
}

/**
 * The worker's retained session whatever its state — live, expired, or released.
 * A server-side read seam (like {@link validateFencingToken}, it takes a
 * `workerId` and holds no raw credential) for callers that need *last seen* for
 * an offline worker: `lastHeartbeatAt` is when it was last heard from. It says
 * nothing about liveness — {@link getLiveSessionForWorker} remains the single
 * TTL-based online/offline check. `undefined` if the worker never connected.
 */
export async function getRetainedSessionForWorker(
	workerId: string,
): Promise<WorkerSession | undefined> {
	return getRetainedSession(workerId);
}
