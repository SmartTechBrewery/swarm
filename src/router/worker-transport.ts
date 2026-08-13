/**
 * Worker↔control-plane transport routes — the router's authenticated
 * worker-session surface (ADR-003 §1). A remote `swarm-cli` daemon reaches the
 * same credential→session→heartbeat service the in-process worker uses
 * (`../identity/worker-session-service.ts`), but over the network via the
 * Cloudflare-tunnel-fronted router instead of an in-process call. Its core job is
 * keeping the `worker_sessions` liveness signal fresh over the wire (which the
 * eligibility gate consumes); under split delivery (ADR-003 §2, issue #407) the
 * same socket also carries the worker→cloud back-channel, which this module routes
 * to the control-plane dispatcher awaiting each dispatch's result
 * (`./dispatch-results.ts`) — the scheduling/eligibility decisions themselves live
 * in the dispatcher (`./dispatcher.ts`), not here.
 *
 * Two routes, both under `/worker`:
 *   - `POST /worker/session` — the handshake (request/response): authenticate the
 *     credential, acquire the fenced lease — reclaiming the daemon's *own* live lease
 *     when it presents the proof (issue #608) — declare the daemon's CLIs and its
 *     checkout's repository, suspend any enrollment that declaration contradicts
 *     (issue #690), return the session.
 *   - `GET /worker/stream` — a WebSocket carrying periodic heartbeat frames that
 *     keep the lease live, releasing it on disconnect — and, since issue #723,
 *     recording that disconnect against the dispatches this router is awaiting on
 *     that worker, so the interruption is legible while it happens rather than
 *     inferred from silence.
 *
 * The request logic is factored out of the socket/HTTP glue into pure,
 * injectable functions (`handleHandshake`, `handleWorkerStreamFrame`) so tests
 * drive them with fake deps and never need a live socket — the same pattern
 * `./webhook-receiver.ts` uses for the webhook surface. Collaborators default to
 * the real session service; tests override them.
 *
 * Credential handling: the raw credential appears only in the handshake body and
 * the stream's `Authorization` header. It is never logged, never placed in a
 * URL, and never reflected in a response body — the same contract
 * `../identity/worker-service.ts` keeps for the persisted credential.
 */

import type { createNodeWebSocket } from '@hono/node-ws';
import type { Hono } from 'hono';
import type { WSContext } from 'hono/ws';

import { promoteAvailabilityWaitsForWorker } from '../dispatch/dispatcher.js';
import type { AgentCli } from '../harness/agent-cli.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '../identity/worker.js';
import {
	type SuspendedMismatchedEnrollment,
	suspendEnrollmentsForMismatchedRepository,
} from '../identity/worker-enrollment-service.js';
import {
	refreshWorkerCapabilities,
	resolveWorkerByCredential,
	WorkerCapabilityReductionError,
} from '../identity/worker-service.js';
import {
	type AcquiredSession,
	acquireSession,
	heartbeat,
	releaseSession,
	resolveHeartbeatTtlMs,
	UnknownWorkerCredentialError,
	validateFencingToken,
	WorkerSessionHeldError,
	type WorkerSessionReclaim,
} from '../identity/worker-session-service.js';
import { logger } from '../lib/logger.js';
import {
	type ControlPlaneMessage,
	HandshakeRequestSchema,
	type StreamLog,
	type TaskAssignmentAck,
	type TaskExecutionResult,
	type TaskProgress,
	TRANSPORT_PROTOCOL_VERSION,
	WorkerStreamMessageSchema,
	WS_CLOSE,
} from '../transport/protocol.js';
import type { TriggerPhase } from '../triggers/types.js';
import {
	type DispatchStreamTarget,
	deliverDispatchAck,
	deliverDispatchProgress,
	deliverDispatchResult,
	noteWorkerTransportLost,
	noteWorkerTransportRestored,
	resolveDispatchStreamTarget,
} from './dispatch-results.js';
import {
	persistControlPlaneNote,
	persistStreamLog,
	TRANSPORT_LOST_NOTE,
	TRANSPORT_RESTORED_NOTE,
} from './stream-log-persistence.js';
import {
	deregisterConnection,
	isWorkerConnected,
	registerConnection,
} from './worker-connections.js';

// The application-defined WebSocket close codes are part of the wire contract, so
// they live in the protocol module (the single source of truth for every frame)
// alongside the frame schemas — re-exported here for this module's existing
// consumers/tests.
export { WS_CLOSE };

/** `upgradeWebSocket` handle produced by `createNodeWebSocket` (typed via its return). */
type UpgradeWebSocket = ReturnType<typeof createNodeWebSocket>['upgradeWebSocket'];

/** Human-readable disconnect reason when a heartbeat can no longer refresh the lease. */
const LEASE_LOST_REASON =
	'session lease is no longer live (lost, expired, or superseded by a newer daemon)';

/**
 * Collaborators the transport depends on, defaulted to the real session service
 * so production wiring is a bare `registerWorkerTransport(app, upgradeWebSocket)`;
 * tests inject fakes. Mirrors `WebhookReceiverDeps` in `./webhook-receiver.ts`.
 */
export interface WorkerTransportDeps {
	resolveWorkerByCredential: (rawCredential: string) => Promise<Worker | undefined>;
	acquireSession: (
		rawCredential: string,
		ttlMs: number,
		reclaim?: WorkerSessionReclaim,
	) => Promise<AcquiredSession>;
	heartbeat: (rawCredential: string, fencingToken: number, ttlMs: number) => Promise<boolean>;
	releaseSession: (rawCredential: string, fencingToken: number) => Promise<boolean>;
	refreshWorkerCapabilities: (
		id: string,
		capabilities: AgentCli[],
		supportedPhases: TriggerPhase[],
		repository: string | null,
	) => Promise<Worker | undefined>;
	/**
	 * Police the worker's existing enrollments against the repository it just
	 * declared (issue #690) — suspending any whose project is a different repository.
	 * Called only when a repository *was* declared, and only after the declaration is
	 * persisted, so it acts on what the row now says. It never creates or activates
	 * an enrollment: a declaration is the machine's statement, and enrollment stays a
	 * human decision (ADR-001).
	 */
	suspendEnrollmentsForMismatchedRepository: (
		workerId: string,
		declaredRepository: string,
	) => Promise<SuspendedMismatchedEnrollment[]>;
	resolveHeartbeatTtlMs: () => number;
	validateFencingToken: (workerId: string, token: number, ttlMs?: number) => Promise<boolean>;
	/**
	 * Split-delivery back-channel sinks (ADR-003 §2, issue #407): route a worker's
	 * assignment ack / progress / terminal result to the control-plane dispatcher
	 * awaiting it (`./dispatch-results.ts`). Defaulted to the in-process registry;
	 * a unit test injects fakes. A frame for a dispatch not awaited here is a no-op.
	 */
	deliverDispatchResult: (result: TaskExecutionResult) => boolean;
	deliverDispatchProgress: (progress: TaskProgress) => void;
	deliverDispatchAck: (ack: TaskAssignmentAck) => void;
	/**
	 * Write a batch of streamed agent output to the run's output stream
	 * (`./stream-log-persistence.ts`). The control plane owns this write for every
	 * worker — a federated one has no database to make it itself. Fire-and-forget
	 * by contract: it returns `void` so the frame handler never blocks on Postgres.
	 */
	persistStreamLog: (frame: StreamLog, runId: string | undefined) => void;
	/**
	 * The worker and run this router recorded when it pushed a dispatch
	 * (`./dispatch-results.ts`). `undefined` for a dispatch not awaited here. It is
	 * what authorizes a `stream-log`: the frame names its own run, and a durable
	 * write must not take that on trust.
	 */
	resolveDispatchStreamTarget: (dispatchId: string) => DispatchStreamTarget | undefined;
	/**
	 * A worker just became reachable here — wake the dispatches that were deferred
	 * only because none was (issue #610, `../dispatch/dispatcher.ts`). Fire-and-
	 * forget by contract: it returns `void` so opening a socket never waits on
	 * Postgres or Redis, and the promotion swallows its own failures.
	 */
	onWorkerAvailable: (workerId: string) => void;
	/**
	 * This worker's transport just dropped / just came back (issue #723). The router
	 * is the only place that knows either moment, so it records the interruption
	 * against every dispatch it is awaiting on that worker and writes one note into
	 * each of their runs' output streams — otherwise a run whose output is simply not
	 * reaching the control plane reads exactly like one that stopped progressing.
	 * Fire-and-forget by contract, like `onWorkerAvailable`: both return `void` so a
	 * socket's lifecycle never waits on Postgres.
	 */
	onWorkerTransportLost: (workerId: string) => void;
	onWorkerTransportRestored: (workerId: string) => void;
}

function defaultDeps(): WorkerTransportDeps {
	return {
		resolveWorkerByCredential,
		acquireSession,
		heartbeat,
		releaseSession,
		refreshWorkerCapabilities,
		suspendEnrollmentsForMismatchedRepository,
		resolveHeartbeatTtlMs,
		validateFencingToken,
		deliverDispatchResult,
		deliverDispatchProgress,
		deliverDispatchAck,
		persistStreamLog,
		resolveDispatchStreamTarget,
		onWorkerAvailable: (workerId) => {
			void promoteAvailabilityWaitsForWorker(workerId, 'connected');
		},
		onWorkerTransportLost: (workerId) => {
			for (const dispatch of noteWorkerTransportLost(workerId)) {
				persistControlPlaneNote(dispatch.runId, TRANSPORT_LOST_NOTE);
			}
		},
		onWorkerTransportRestored: (workerId) => {
			for (const dispatch of noteWorkerTransportRestored(workerId)) {
				persistControlPlaneNote(dispatch.runId, TRANSPORT_RESTORED_NOTE);
			}
		},
	};
}

/** A handshake outcome: the HTTP status and the JSON body to return. */
export interface HandshakeResult {
	status: 200 | 400 | 401 | 409;
	json: Record<string, unknown>;
}

/**
 * The handshake, as a pure function of its deps and the raw request body:
 * validate → authenticate → acquire lease → declare CLIs and repository → police
 * enrollments against that repository → return the session.
 * Returns the status/body for the route to send; never throws for an expected
 * failure (bad request, bad credential, lease held, capability reduction), and
 * never reflects the credential in the body. The enrollment-policing pass is the
 * one step whose failure is swallowed rather than reported: it is housekeeping on
 * the control plane's side of the connection, not a condition of connecting.
 */
export async function handleHandshake(
	deps: WorkerTransportDeps,
	body: unknown,
): Promise<HandshakeResult> {
	const parsed = HandshakeRequestSchema.safeParse(body);
	if (!parsed.success) {
		return { status: 400, json: { authenticated: false, reason: 'invalid handshake request' } };
	}
	const request = parsed.data;

	// A version mismatch is a clean, explicit rejection rather than a frame the
	// two sides would silently misparse later on the stream.
	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION) {
		return {
			status: 400,
			json: {
				authenticated: false,
				reason: 'unsupported protocol version',
				protocolVersion: TRANSPORT_PROTOCOL_VERSION,
			},
		};
	}

	// Authenticate before touching the lease so an unknown credential is a clean
	// 401 (constant-shape body — the credential is never reflected back).
	const worker = await deps.resolveWorkerByCredential(request.credential);
	if (!worker) {
		return { status: 401, json: { authenticated: false } };
	}

	const ttlMs = deps.resolveHeartbeatTtlMs();

	let session: AcquiredSession;
	try {
		// `request.reclaim` is the daemon's proof that it already holds this lease
		// (issue #608). A live lease it matches exactly is handed back — with the fencing
		// token still bumped and the run pointer cleared — so a control-plane restart
		// costs a reconnecting worker a round trip instead of the whole heartbeat TTL.
		//
		// Two invariants this rests on, both already holding here:
		//   - a reclaim while a live socket for that worker is still registered (a
		//     half-open connection) bumps the token, so the old socket's next heartbeat
		//     cannot refresh the lease → `disconnect` + 4408 in
		//     `handleWorkerStreamFrame`, and `registerConnection` evicts it as soon as
		//     the new socket registers. One live session per worker survives;
		//   - the new socket's upgrade check (`validateFencingToken` → `getLiveSession`)
		//     passes immediately, since the row is unreleased with a just-written heartbeat.
		session = await deps.acquireSession(request.credential, ttlMs, request.reclaim);
	} catch (err) {
		// A live lease held by *another* daemon for this worker — the caller either
		// presented no proof of possession or one that no longer matches the row.
		if (err instanceof WorkerSessionHeldError) {
			return {
				status: 409,
				json: { authenticated: false, reason: 'worker session already held' },
			};
		}
		// Defensive: the credential resolved above, so this should not fire — but a
		// concurrent deletion could make acquire disagree. Treat it as an auth failure.
		if (err instanceof UnknownWorkerCredentialError) {
			return { status: 401, json: { authenticated: false } };
		}
		throw err;
	}

	// Declare the daemon's CLIs and phases only after proving this daemon holds the
	// lease, so a second daemon cannot mutate the roster's capabilities while another
	// owns the session. If the declared set drops a CLI an enrollment needs, release
	// the lease we just took (so a corrected retry isn't blocked by a held session)
	// and report the offending CLIs.
	//
	// A daemon that omits `supportedPhases` predates the field (issue #467), so it is
	// recorded as supporting every phase — the dispatcher's behaviour before phases
	// were declarable. Normalizing here, at the boundary, is what keeps the
	// eligibility gate free of a "declaration unknown" case.
	//
	// `repository` (issue #687) is normalized at the same boundary but in the opposite
	// direction: an omitted field records NULL, which *clears* whatever an earlier
	// daemon declared. The row states the checkout of the program currently operating
	// it, so a daemon re-pointed at a checkout it cannot identify — or an older build
	// that cannot state one — must not leave the previous statement standing for the
	// later guards to act on. For a row that never carried one that write is a no-op
	// NULL, i.e. exactly today's behaviour.
	try {
		await deps.refreshWorkerCapabilities(
			worker.id,
			request.capabilities,
			request.supportedPhases ?? [...DEFAULT_WORKER_SUPPORTED_PHASES],
			request.repository ?? null,
		);
	} catch (err) {
		if (err instanceof WorkerCapabilityReductionError) {
			await deps.releaseSession(request.credential, session.fencingToken).catch(() => {});
			return {
				status: 409,
				json: {
					authenticated: false,
					reason: 'declared capabilities drop a CLI an enrollment requires',
					offending: err.offending,
				},
			};
		}
		throw err;
	}

	// Only now that the declaration is persisted — the pass acts on what the row says.
	await policeEnrollmentsAgainstDeclaration(deps, worker.id, request.repository);

	return {
		status: 200,
		json: {
			authenticated: true,
			workerId: worker.id,
			sessionId: session.session.id,
			fencingToken: session.fencingToken,
			heartbeatTtlMs: ttlMs,
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		},
	};
}

/**
 * Suspend the enrollments the repository this daemon just declared contradicts
 * (issue #690): one written against a different repository — created before the
 * machine declared anything, or before it was re-pointed at another checkout — is
 * suspended, so the roster states why no work is routed there instead of leaving an
 * operator to read the reason off refused assignments.
 *
 * **Never throws, and never blocks the handshake.** Policing enrollments is
 * housekeeping on the control plane's side of the connection, not a condition of
 * connecting, so a failure is logged and the session still comes back — the daemon's
 * own pre-flight check (issue #688) refuses a mismatched assignment regardless. The
 * suspension itself blocks only *future* dispatch (`isRoutable`), never a phase
 * already running.
 *
 * A daemon that declared nothing is skipped entirely: an unidentifiable checkout
 * must not suspend enrollments an operator deliberately created.
 */
async function policeEnrollmentsAgainstDeclaration(
	deps: WorkerTransportDeps,
	workerId: string,
	declaredRepository: string | undefined,
): Promise<void> {
	if (!declaredRepository) return;
	try {
		await deps.suspendEnrollmentsForMismatchedRepository(workerId, declaredRepository);
	} catch (err) {
		logger.warn('worker handshake: policing enrollments against the declaration failed', {
			workerId,
			repository: declaredRepository,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/** Per-connection context threaded into every stream-frame decision. */
export interface WorkerStreamContext {
	/** The raw credential from the upgrade's `Authorization` header. */
	credential: string;
	/** The heartbeat TTL resolved once when the stream opened. */
	ttlMs: number;
	/** The fencing token bound to this WebSocket at upgrade time. */
	fencingToken: number;
	/**
	 * The worker this socket authenticated as, resolved once at upgrade. Present so
	 * a frame that performs a durable write can be checked against the identity the
	 * connection proved, rather than against ids the frame supplies itself.
	 */
	workerId: string;
}

/**
 * What the socket glue should do with one inbound frame — a pure value so
 * `handleWorkerStreamFrame` is unit-testable without a live socket:
 *   - `ack`        → send `message`, keep the socket open;
 *   - `disconnect` → send `message` (a `disconnect` control frame), then close
 *     with `code`;
 *   - `close`      → close with `code`/`reason`, no frame sent.
 *
 * `ack`/`disconnect` carry the `fencingToken` the frame presented so the socket
 * glue can remember it and release exactly that lease on a graceful close.
 */
export type WorkerStreamAction =
	| { action: 'ack'; fencingToken: number; message: ControlPlaneMessage }
	| { action: 'disconnect'; fencingToken: number; code: number; message: ControlPlaneMessage }
	| { action: 'close'; code: number; reason: string }
	| { action: 'ignore' };

/**
 * Decide what to do with one inbound stream frame — pure, so tests drive it with
 * fake deps and a raw string. An unparseable frame closes (4400). A `heartbeat`
 * frame refreshes the lease: a refreshed lease acks; a lease that can no longer
 * be refreshed (lost/expired/superseded) sends a `disconnect` frame and closes
 * (4408). The split-delivery back-channel frames (assignment ack, coarse progress,
 * execution result — ADR-003 §2, issue #407) are routed to the control-plane
 * dispatcher awaiting that dispatch's result (`./dispatch-results.ts`) and keep the
 * socket open; a `stream-log` goes to the run-output sink
 * (`./stream-log-persistence.ts`), which the control plane owns for every worker.
 * None of these touch the lease.
 */
export async function handleWorkerStreamFrame(
	deps: WorkerTransportDeps,
	ctx: WorkerStreamContext,
	rawFrame: string,
): Promise<WorkerStreamAction> {
	let payload: unknown;
	try {
		payload = JSON.parse(rawFrame);
	} catch {
		return { action: 'close', code: WS_CLOSE.MALFORMED_FRAME, reason: 'malformed frame' };
	}

	const parsed = WorkerStreamMessageSchema.safeParse(payload);
	if (!parsed.success) {
		return { action: 'close', code: WS_CLOSE.MALFORMED_FRAME, reason: 'malformed frame' };
	}

	const frame = parsed.data;
	// Route the split-delivery back-channel frames (ADR-003 §2, issue #407) to the
	// control-plane dispatcher awaiting this dispatch's result on this router, then
	// keep the socket open — they carry no fencing token and never touch the lease.
	// A frame for a dispatch not awaited here (already settled, or on another
	// router) is a no-op. Lease liveness rides the heartbeat handled below.
	if (frame.type === 'task-execution-result') {
		deps.deliverDispatchResult(frame);
		return { action: 'ignore' };
	}
	if (frame.type === 'task-progress') {
		deps.deliverDispatchProgress(frame);
		return { action: 'ignore' };
	}
	if (frame.type === 'task-assignment-ack') {
		deps.deliverDispatchAck(frame);
		return { action: 'ignore' };
	}
	if (frame.type === 'stream-log') {
		// Persist the batch to `run_output_events` here rather than on the worker:
		// a federated worker holds no `DATABASE_URL`, so this is the only place a
		// remote run's live output can be written at all, and the same-host executor
		// no longer writes it locally — so there is no second copy. The call returns
		// immediately (the write runs on the run's own chain), keeping the socket
		// non-blocking, and the frame still resolves to `ignore` so the connection
		// lifecycle is untouched.
		//
		// **Authorized against what this router pushed, never against the frame.**
		// This is the only back-channel frame that writes durably, and it names its
		// own `runId`; every other frame either carries the lease or resolves against
		// a waiter that discards it, so trusting their ids costs nothing. Here it
		// would make any authenticated worker credential a write handle on any run
		// of any project — so the batch is persisted only when this router is
		// awaiting that dispatch AND pushed it to *this* socket's worker, and it is
		// written under the run id the router recorded, not the one the frame claims.
		const target = deps.resolveDispatchStreamTarget(frame.dispatchId);
		if (!target || target.workerId !== ctx.workerId) {
			logger.warn('stream-log for a dispatch this router did not push here — dropping', {
				dispatchId: frame.dispatchId,
				workerId: ctx.workerId,
				awaited: !!target,
			});
			return { action: 'ignore' };
		}
		deps.persistStreamLog(frame, target.runId);
		return { action: 'ignore' };
	}
	if (frame.fencingToken !== ctx.fencingToken) {
		return {
			action: 'close',
			code: WS_CLOSE.LEASE_LOST,
			reason: 'fencing token mismatch',
		};
	}
	const refreshed = await deps.heartbeat(ctx.credential, frame.fencingToken, ctx.ttlMs);
	if (!refreshed) {
		return {
			action: 'disconnect',
			fencingToken: frame.fencingToken,
			code: WS_CLOSE.LEASE_LOST,
			message: { type: 'disconnect', reason: LEASE_LOST_REASON },
		};
	}
	return { action: 'ack', fencingToken: frame.fencingToken, message: { type: 'heartbeat-ack' } };
}

/** Extract the raw credential from an `Authorization: Bearer <credential>` header. */
function extractBearerCredential(authorization: string | undefined): string | undefined {
	if (!authorization) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
	return match ? match[1] : undefined;
}

/** Normalize a WebSocket message payload (string or binary) to a string frame. */
function frameToString(data: unknown): string {
	if (typeof data === 'string') return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
	}
	return String(data);
}

/** Apply a {@link WorkerStreamAction} to a live socket. */
function applyStreamAction(ws: WSContext, action: WorkerStreamAction): void {
	switch (action.action) {
		case 'ack':
			ws.send(JSON.stringify(action.message));
			return;
		case 'disconnect':
			ws.send(JSON.stringify(action.message));
			ws.close(action.code, action.message.type === 'disconnect' ? action.message.reason : '');
			return;
		case 'close':
			ws.close(action.code, action.reason);
			return;
		case 'ignore':
			return;
	}
}

/**
 * Run one fire-and-forget connection-lifecycle hook. Registration has already
 * happened by the time any of these run, and it is the part connectivity depends
 * on, so a hook that fails must not take the socket down with it: it is logged and
 * swallowed, and each hook is guarded separately so one failing does not skip the
 * next.
 */
function runConnectionHook(what: string, workerId: string, hook: () => void): void {
	try {
		hook();
	} catch (err) {
		logger.warn(`worker transport: ${what} failed`, {
			workerId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * An authenticated `/worker/stream` socket opened: record it as the worker's live
 * transport, wake the work that was only waiting for a machine like this one, and
 * annotate the runs whose output this session restores.
 *
 * Factored out of the socket glue for the same reason `handleHandshake` and
 * `handleWorkerStreamFrame` are — a test drives it with a fake `WSContext` and
 * fake hooks — and kept here rather than inside `registerConnection` so the
 * connected-worker registry keeps owning no scheduling decision of its own.
 *
 * This is the *first* of the two moments a worker becomes available (issue #610);
 * the other is a dispatch bound to it settling (`../worker/consumer.ts`). It is
 * also the moment a dropped transport comes back (issue #723) — which annotates
 * only the runs whose dispatch this router already saw interrupted, so an ordinary
 * first connection writes nothing. Both are fire-and-forget: the socket must open
 * regardless of what Postgres or Redis are doing.
 */
export function handleWorkerStreamOpen(
	deps: WorkerTransportDeps,
	workerId: string,
	ws: WSContext,
): void {
	registerConnection(workerId, ws);
	// The timed re-check still starts the waiting work if this nudge fails.
	runConnectionHook('waking availability-blocked dispatches', workerId, () =>
		deps.onWorkerAvailable(workerId),
	);
	runConnectionHook('noting the restored transport session', workerId, () =>
		deps.onWorkerTransportRestored(workerId),
	);
}

/**
 * Wire the two transport routes onto the router's Hono `app`. `upgradeWebSocket`
 * is the handle from `createNodeWebSocket({ app })` (constructed in the router
 * entry point so `injectWebSocket` binds the same server). Pass `overrides` to
 * substitute collaborators in tests; omit for production wiring.
 */
export function registerWorkerTransport(
	app: Hono,
	upgradeWebSocket: UpgradeWebSocket,
	overrides: Partial<WorkerTransportDeps> = {},
): void {
	const deps = { ...defaultDeps(), ...overrides };

	app.post('/worker/session', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ authenticated: false, reason: 'invalid handshake request' }, 400);
		}
		const result = await handleHandshake(deps, body);
		return c.json(result.json, result.status);
	});

	// Resolve the worker once at upgrade and return its id (not just a boolean) so
	// the socket handlers can key the connected-worker registry by it. `undefined`
	// means the upgrade is not authenticated.
	async function authenticateUpgrade(
		deps: WorkerTransportDeps,
		credential: string | undefined,
		fencingToken: number,
		ttlMs: number,
	): Promise<string | undefined> {
		if (!credential || Number.isNaN(fencingToken)) return undefined;
		try {
			const worker = await deps.resolveWorkerByCredential(credential);
			if (!worker) return undefined;
			const valid = await deps.validateFencingToken(worker.id, fencingToken, ttlMs);
			return valid ? worker.id : undefined;
		} catch (err) {
			logger.error('worker transport upgrade authentication failed', {
				error: err instanceof Error ? err.message : String(err),
			});
			return undefined;
		}
	}

	app.get(
		'/worker/stream',
		upgradeWebSocket(async (c) => {
			// Authenticate the upgrade from the bearer credential. The factory runs
			// before the socket opens; an unknown/absent credential yields handlers
			// that close the connection the moment it opens (4401).
			const credential = extractBearerCredential(c.req.header('authorization'));
			const fencingTokenStr = c.req.header('x-fencing-token');
			const fencingToken = fencingTokenStr ? Number.parseInt(fencingTokenStr, 10) : NaN;
			const ttlMs = deps.resolveHeartbeatTtlMs();

			// The resolved worker id when authenticated, else `undefined`. Checked
			// directly in each handler (rather than a separate boolean) so TypeScript
			// narrows it to `string` past the guard — the registry keys on it.
			const workerId = await authenticateUpgrade(deps, credential, fencingToken, ttlMs);
			const safeCredential = credential ?? '';

			// One loss note per socket, recorded by whichever handler observes the drop
			// first: `onError` is routinely followed by `onClose` for the same socket, and
			// a single drop must record a single interruption. Per-connection state, since
			// this closure runs once per upgrade.
			let lossNoted = false;
			function noteTransportLoss(id: string): void {
				// Only when this socket was still the live one. A superseded socket's stale
				// close — its replacement registered first, so `deregisterConnection` was a
				// no-op — must write no note: nothing was interrupted, the worker is here.
				if (lossNoted || isWorkerConnected(id)) return;
				lossNoted = true;
				runConnectionHook('noting the lost transport session', id, () =>
					deps.onWorkerTransportLost(id),
				);
			}

			return {
				onOpen(_evt, ws) {
					if (workerId === undefined) {
						ws.close(WS_CLOSE.UNAUTHORIZED, 'unauthorized');
						return;
					}
					// Record this socket as the live transport for the worker so the control
					// plane can push to it (a prior socket for the same worker is superseded
					// — a newer daemon wins, see `registerConnection`), then promote whatever
					// was waiting for a worker to become available.
					handleWorkerStreamOpen(deps, workerId, ws);
				},
				async onMessage(evt, ws) {
					if (workerId === undefined) {
						ws.close(WS_CLOSE.UNAUTHORIZED, 'unauthorized');
						return;
					}
					try {
						const action = await handleWorkerStreamFrame(
							deps,
							{ credential: safeCredential, ttlMs, fencingToken, workerId },
							frameToString(evt.data),
						);
						applyStreamAction(ws, action);
						// A `disconnect`/`close` action closes the socket, so drop it from the
						// registry now rather than waiting for the async `onClose`. Identity-
						// checked, so it can't evict a socket that has since been replaced.
						// `ack` and `ignore` both leave the socket open — a back-channel frame
						// (task-execution-result, task-progress, task-assignment-ack, stream-log)
						// resolves to `ignore` and must not deregister a connection that never
						// closed, or the worker reads as disconnected the moment it reports a
						// phase's result, wedging every later dispatch to it (`worker-unavailable`)
						// until the process reconnects.
						if (action.action === 'disconnect' || action.action === 'close') {
							deregisterConnection(workerId, ws);
						}
					} catch (err) {
						logger.error('worker transport stream onMessage failed', {
							error: err instanceof Error ? err.message : String(err),
						});
						ws.close(WS_CLOSE.LEASE_LOST, 'heartbeat processing failed');
						deregisterConnection(workerId, ws);
					}
				},
				async onClose(_evt, ws) {
					if (workerId === undefined || !credential) return;
					// Drop this socket from the connected-worker registry (identity-checked,
					// so a stale close can't evict a newer socket), then free the lease
					// promptly rather than waiting out the TTL. An ungraceful drop with no
					// prior heartbeat still expires via the TTL — the existing mechanism.
					// Best-effort: log, don't throw.
					deregisterConnection(workerId, ws);
					// After the deregister, so "is this worker still reachable here?" answers
					// about the *replacement* socket rather than about the one closing.
					noteTransportLoss(workerId);
					try {
						await deps.releaseSession(credential, fencingToken);
					} catch (err) {
						logger.warn('worker transport lease release on disconnect failed', {
							error: err instanceof Error ? err.message : String(err),
						});
					}
				},
				onError(evt, ws) {
					// Deregister on a socket error too, so a connection that errors out
					// without a clean close doesn't linger in the registry — and record the
					// interruption here as well, since an errored socket may never deliver a
					// clean `onClose`.
					if (workerId !== undefined) {
						deregisterConnection(workerId, ws);
						noteTransportLoss(workerId);
					}
					logger.warn('worker transport stream error', {
						error:
							evt instanceof Error
								? evt.message
								: evt && typeof evt === 'object' && 'message' in evt
									? String((evt as Record<string, unknown>).message)
									: String(evt),
					});
				},
			};
		}),
	);
}
