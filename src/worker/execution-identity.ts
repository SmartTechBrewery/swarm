/**
 * The authenticated worker-host identity threaded through every federated
 * dispatch attempt — the fenced `worker_sessions` lease a dispatch is claimed
 * against.
 *
 * A worker no longer acquires that lease itself: since issue #553 every worker
 * runs the DB-free transport entrypoint, whose handshake makes the control plane
 * acquire the session on its behalf (`../identity/worker-session-service.ts`, via
 * `../router/worker-transport.ts`). The control plane then reads the *selected*
 * worker's live session here to bind the claim (`resolveSelectedWorkerIdentity`,
 * `../router/dispatcher.ts`), which is why this is a shape rather than a handle.
 */
export interface WorkerExecutionIdentity {
	workerId: string;
	sessionId: string;
	fencingToken: number;
	heartbeatTtlMs: number;
}
