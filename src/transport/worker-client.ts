/**
 * Worker-side transport client — the daemon half of the authenticated
 * worker↔control-plane transport (ADR-003 §1, Phase 2 of issue #391). A remote
 * `swarm-cli` daemon holds **only** its `SWARM_WORKER_CREDENTIAL` and the
 * control-plane base URL (`SWARM_CONTROL_PLANE_URL`) — no `DATABASE_URL`, no
 * `REDIS_URL` — and uses this client to:
 *
 *   1. POST the handshake to `/worker/session`, declaring its locally available
 *      CLIs + hostname/version, and receive the fenced session (`fencingToken`,
 *      `heartbeatTtlMs`);
 *   2. open the authenticated `/worker/stream` WebSocket and send a `heartbeat`
 *      frame every `heartbeatTtlMs / 3` to keep the `worker_sessions` lease live —
 *      the exact liveness signal the eligibility gate consumes;
 *   3. reconnect with exponential backoff (jittered, capped) whenever the
 *      transport is lost, re-acquiring the lease with a fresh handshake.
 *
 * It deliberately imports **nothing** from `../db/*` or the queue: the client is
 * the second front door to the same session service the in-process worker calls
 * directly (`../identity/worker-session-service.ts`), but reached over the network
 * instead of in-process, so a machine running only this client needs no datastore
 * of its own. The wire frames are the shared Zod schemas in `./protocol.ts` (the
 * single source of truth); this module never re-declares a frame shape.
 *
 * The HTTP/WebSocket collaborators (`fetch`, the `ws` `WebSocket`) and the jitter
 * source are injectable so tests drive the reconnect loop with fakes and fake
 * timers and never need a live socket — the same dependency-injection shape the
 * router transport uses (`../router/worker-transport.ts`).
 */

import { WebSocket } from 'ws';

import type { AgentCli } from '../harness/agent-cli.js';
import { logger as defaultLogger } from '../lib/logger.js';
import {
	type ControlPlaneMessage,
	ControlPlaneMessageSchema,
	type HandshakeRequest,
	HandshakeRequestSchema,
	type HandshakeResponse,
	HandshakeResponseSchema,
	type Heartbeat,
	type TaskAssignment,
	type TaskPhase,
	TRANSPORT_PROTOCOL_VERSION,
	type WorkerHealth,
	type WorkerStreamMessage,
	WS_CLOSE,
} from './protocol.js';

// --- Errors ----------------------------------------------------------------

/**
 * The credential was rejected (HTTP 401 on the handshake, or a `4401` stream
 * close). Always fatal: a fresh handshake with the same credential cannot fix a
 * credential the roster does not recognize.
 */
export class WorkerTransportAuthError extends Error {
	constructor(message = 'worker credential was rejected by the control plane') {
		super(message);
		this.name = 'WorkerTransportAuthError';
	}
}

/**
 * The control plane rejected the handshake *request* (HTTP 400) — a malformed
 * body or an unsupported protocol version. Always fatal: the daemon and control
 * plane disagree on the wire contract, which retrying cannot reconcile.
 */
export class WorkerTransportProtocolError extends Error {
	constructor(message = 'control plane rejected the handshake request') {
		super(message);
		this.name = 'WorkerTransportProtocolError';
	}
}

/**
 * A live session for this worker is already held by another daemon (HTTP 409,
 * no `offending` CLIs). Fatal on the *first* connect (a genuinely competing
 * daemon), but recoverable on a reconnect: a stale self-lease from an ungraceful
 * drop expires within the TTL, so the reconnect loop backs off and retries.
 */
export class WorkerSessionConflictError extends Error {
	constructor(message = 'a worker session is already held by another daemon') {
		super(message);
		this.name = 'WorkerSessionConflictError';
	}
}

/**
 * The declared capability set drops a CLI an enrollment requires (HTTP 409 with
 * `offending` CLIs). Always fatal: retrying with the same too-narrow set repeats
 * the rejection; the operator must install/declare the missing CLI.
 */
export class WorkerCapabilityConflictError extends Error {
	readonly offending: string[];
	constructor(offending: string[], message?: string) {
		super(
			message ?? `declared capabilities drop a CLI an enrollment requires: ${offending.join(', ')}`,
		);
		this.name = 'WorkerCapabilityConflictError';
		this.offending = offending;
	}
}

/**
 * A transient handshake failure — a 5xx, an unexpected status, or a network
 * error — that the reconnect loop retries with backoff.
 */
export class WorkerTransportTransientError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkerTransportTransientError';
	}
}

// --- Wire helpers (pure) ----------------------------------------------------

/**
 * Build the handshake request body, stamping the current protocol version.
 *
 * `supportedPhases` is the caller's phase repertoire (issue #467): the DB-free
 * daemon passes `SUPPORTED_DB_FREE_PHASES`, the same-host client passes every
 * phase. It is required here — the two callers genuinely differ, so defaulting it
 * would let the DB-free daemon silently claim phases it refuses.
 */
export function buildHandshakeRequest(input: {
	credential: string;
	daemonVersion: string;
	hostname: string;
	capabilities: AgentCli[];
	supportedPhases: readonly TaskPhase[];
}): HandshakeRequest {
	return HandshakeRequestSchema.parse({
		credential: input.credential,
		daemonVersion: input.daemonVersion,
		hostname: input.hostname,
		capabilities: input.capabilities,
		supportedPhases: [...input.supportedPhases],
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
	});
}

/** Build a heartbeat frame presenting the session's fencing token (+ optional health). */
export function buildHeartbeatFrame(fencingToken: number, health?: WorkerHealth): Heartbeat {
	return { type: 'heartbeat', fencingToken, ...(health ? { health } : {}) };
}

/**
 * Derive the transport endpoints from the control-plane base URL. The handshake
 * rides HTTP(S); the stream rides the matching WebSocket scheme (`http`→`ws`,
 * `https`→`wss`) — the Cloudflare tunnel forwards the upgrade transparently, so a
 * daemon points `SWARM_CONTROL_PLANE_URL` at the same tunnel base URL GitHub's
 * webhooks use. A base path is preserved so the router can be mounted under a
 * sub-path. Throws on a non-http(s) or unparseable URL — a clear config error.
 */
export function deriveTransportUrls(controlPlaneUrl: string): {
	sessionUrl: string;
	streamUrl: string;
} {
	let base: URL;
	try {
		base = new URL(controlPlaneUrl);
	} catch {
		throw new Error(`SWARM_CONTROL_PLANE_URL is not a valid URL: '${controlPlaneUrl}'`);
	}
	if (base.protocol !== 'http:' && base.protocol !== 'https:') {
		throw new Error(`SWARM_CONTROL_PLANE_URL must be an http(s) URL, got '${controlPlaneUrl}'`);
	}
	const httpBase = base.toString().endsWith('/') ? base.toString() : `${base.toString()}/`;
	const wsBase = httpBase.replace(/^http(s?):/, 'ws$1:');
	return {
		sessionUrl: new URL('worker/session', httpBase).toString(),
		streamUrl: new URL('worker/stream', wsBase).toString(),
	};
}

/** Heartbeat cadence: one third of the lease TTL, mirroring the in-process worker. */
export function heartbeatCadenceMs(heartbeatTtlMs: number): number {
	return Math.max(1_000, Math.floor(heartbeatTtlMs / 3));
}

/** Reconnect backoff schedule: exponential (base·2^(n-1)), capped, with equal jitter. */
export interface BackoffConfig {
	baseMs: number;
	maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = { baseMs: 1_000, maxMs: 30_000 };

/**
 * The delay before reconnect attempt `attempt` (1-based). Exponential growth
 * capped at `maxMs`, then equal jitter into `[capped/2, capped]` — the floor keeps
 * a fleet of daemons from stampeding the control plane with near-zero delays while
 * still spreading their retries. `random` is injectable so tests are deterministic.
 */
export function computeReconnectDelayMs(
	attempt: number,
	config: BackoffConfig = DEFAULT_BACKOFF,
	random: () => number = Math.random,
): number {
	const exponential = config.baseMs * 2 ** Math.max(0, attempt - 1);
	const capped = Math.min(config.maxMs, exponential);
	const half = capped / 2;
	return Math.round(half + random() * half);
}

// --- Injectable collaborators ----------------------------------------------

/** Minimal `Response` surface the client reads from a handshake POST. */
export interface FetchResponse {
	status: number;
	json(): Promise<unknown>;
}

/** The subset of `fetch` the handshake uses, injectable for tests. */
export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchResponse>;

/**
 * Minimal socket surface the client drives — satisfied by the `ws` `WebSocket`
 * and by a test fake. `on` mirrors the `ws`/EventEmitter shape; only the four
 * events below are consumed (their argument shapes are documented per event).
 */
export interface TransportSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	/**
	 * Subscribe to a socket event: `open` (no args), `message` (`data`),
	 * `close` (`code`, `reason`), or `error` (`err`). Args arrive untyped —
	 * handlers narrow what they read.
	 */
	on(event: 'open' | 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): void;
}

/** A structured logger — the shared logger by default; injectable for tests. */
export interface TransportLogger {
	debug(message: string, context?: Record<string, unknown>): void;
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, context?: Record<string, unknown>): void;
}

/** Collaborators, defaulted to the real HTTP/WebSocket stack; tests inject fakes. */
export interface WorkerTransportOverrides {
	fetch: FetchLike;
	createWebSocket: (url: string, headers: Record<string, string>) => TransportSocket;
	random: () => number;
	logger: TransportLogger;
}

function resolveOverrides(overrides: Partial<WorkerTransportOverrides>): WorkerTransportOverrides {
	return {
		fetch:
			overrides.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchResponse>),
		createWebSocket:
			overrides.createWebSocket ??
			((url, headers) => new WebSocket(url, { headers }) as unknown as TransportSocket),
		random: overrides.random ?? Math.random,
		logger: overrides.logger ?? defaultLogger,
	};
}

// --- Handshake --------------------------------------------------------------

/**
 * Perform the HTTP handshake and return the acquired session. Maps each failure
 * status to a typed error the reconnect loop classifies (auth/protocol/capability
 * are fatal, session-conflict is fatal only on first connect, everything else is
 * transient). Never logs or echoes the credential — the control plane's error
 * bodies are constant-shape and credential-free by contract.
 */
export async function performHandshake(
	deps: WorkerTransportOverrides,
	sessionUrl: string,
	request: HandshakeRequest,
): Promise<HandshakeResponse> {
	let response: FetchResponse;
	try {
		response = await deps.fetch(sessionUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(request),
		});
	} catch (err) {
		throw new WorkerTransportTransientError(
			`control plane handshake request failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (response.status === 200) {
		const parsed = HandshakeResponseSchema.safeParse(await response.json().catch(() => undefined));
		if (!parsed.success) {
			throw new WorkerTransportProtocolError(
				'control plane returned an unrecognized handshake response',
			);
		}
		return parsed.data;
	}

	const body = ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
	const reason = typeof body.reason === 'string' ? body.reason : undefined;

	if (response.status === 401) throw new WorkerTransportAuthError(reason);
	if (response.status === 400) throw new WorkerTransportProtocolError(reason);
	if (response.status === 409) {
		const offending = Array.isArray(body.offending)
			? (body.offending as unknown[]).map(String)
			: undefined;
		if (offending && offending.length > 0) {
			throw new WorkerCapabilityConflictError(offending, reason);
		}
		throw new WorkerSessionConflictError(reason);
	}
	throw new WorkerTransportTransientError(`control plane returned HTTP ${response.status}`);
}

// --- Client -----------------------------------------------------------------

/** A running transport client. */
export interface WorkerTransportClient {
	/**
	 * Resolves when the client is gracefully stopped (`stop()`); rejects with a
	 * fatal, non-recoverable error (bad credential, protocol mismatch, capability
	 * rejection, or a session held by a competing daemon on first connect).
	 */
	readonly done: Promise<void>;
	/** Gracefully release the session via a normal WebSocket close, then settle `done`. */
	stop(): Promise<void>;
}

/**
 * The channel an {@link WorkerTransportOptions.onAssignment} handler uses to send
 * worker→cloud frames (the assignment ack, batched live output, progress, and
 * the terminal execution result) back on the live session socket. `send` is a
 * best-effort write: once the session ends it drops the frame (logged), because a
 * reconnect re-pushes the assignment and the handler resumes rather than
 * duplicating (ADR-003 §2). Serialization is handled here so the handler only
 * ever deals in typed frames.
 */
export interface AssignmentSink {
	send(frame: WorkerStreamMessage): void;
}

export interface WorkerTransportOptions {
	controlPlaneUrl: string;
	credential: string;
	capabilities: AgentCli[];
	/**
	 * The pipeline phases this daemon can execute (issue #467), declared at
	 * handshake so the control plane never selects it for a phase it would refuse.
	 * The DB-free remote daemon passes `SUPPORTED_DB_FREE_PHASES`; the same-host
	 * dispatch client passes every phase.
	 */
	supportedPhases: readonly TaskPhase[];
	hostname: string;
	daemonVersion: string;
	/** Optional advisory host-health provider, attached to each heartbeat. */
	health?: () => WorkerHealth | undefined;
	/** Reconnect backoff overrides (defaults to {@link DEFAULT_BACKOFF}). */
	backoff?: Partial<BackoffConfig>;
	/**
	 * Called when the control plane pushes a `task-assignment` frame on the live
	 * session (ADR-003 §2). The handler runs the phase and streams results back
	 * through the supplied {@link AssignmentSink}. Left undefined by the
	 * session-only remote client (`./connect-entry.ts`), which keeps its lease live
	 * but executes no work; the in-process transport-dispatch client
	 * (`../worker/transport-client.ts`) supplies it. Fire-and-forget: the handler
	 * runs independently of the heartbeat loop, so a long phase never blocks lease
	 * liveness.
	 */
	onAssignment?: (assignment: TaskAssignment, sink: AssignmentSink) => void;
}

/** How a live session ended, deciding whether the loop reconnects or fails. */
type SessionEnd =
	| { reason: 'disconnect'; message: string }
	| { reason: 'close'; code: number }
	| { reason: 'error'; error: unknown };

/** Normal WebSocket close code sent on a graceful shutdown. */
const WS_NORMAL_CLOSE = 1000;

/**
 * Connect and keep a live worker session, reconnecting on transport loss until
 * {@link WorkerTransportClient.stop} is called. Returns immediately with a handle;
 * the connect loop runs in the background on `done`.
 */
export function connectWorkerTransport(
	options: WorkerTransportOptions,
	overrides: Partial<WorkerTransportOverrides> = {},
): WorkerTransportClient {
	const deps = resolveOverrides(overrides);
	const urls = deriveTransportUrls(options.controlPlaneUrl);
	const backoff: BackoffConfig = { ...DEFAULT_BACKOFF, ...options.backoff };
	// Validated once up front so a bad capability set fails loudly before any I/O.
	const request = buildHandshakeRequest(options);

	let stopped = false;
	let activeSocket: TransportSocket | undefined;
	let resolveStopped: (() => void) | undefined;
	const stoppedSignal = new Promise<void>((resolve) => {
		resolveStopped = resolve;
	});

	/** Sleep `ms`, resolving early (to `false`) if `stop()` fires meanwhile. */
	function backoffSleep(ms: number): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				resolve(true);
			}, ms);
			void stoppedSignal.then(() => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(false);
			});
		});
	}

	/** Open the stream, heartbeat until it ends, and report how it ended. */
	function runSession(session: HandshakeResponse): Promise<SessionEnd> {
		return new Promise<SessionEnd>((resolve) => {
			const socket = deps.createWebSocket(urls.streamUrl, {
				authorization: `Bearer ${options.credential}`,
				'x-fencing-token': String(session.fencingToken),
			});
			activeSocket = socket;
			let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
			let settled = false;

			const finish = (end: SessionEnd): void => {
				if (settled) return;
				settled = true;
				if (heartbeatTimer) clearInterval(heartbeatTimer);
				if (activeSocket === socket) activeSocket = undefined;
				resolve(end);
			};

			// The back-channel a task-assignment handler writes its ack/output/result
			// frames through. Best-effort: once the session has ended the frame is
			// dropped (a reconnect re-pushes the assignment — ADR-003 §2).
			const sink: AssignmentSink = {
				send(frame: WorkerStreamMessage): void {
					if (settled) {
						deps.logger.warn('dropping worker frame — transport session already ended', {
							type: frame.type,
						});
						return;
					}
					try {
						socket.send(JSON.stringify(frame));
					} catch (err) {
						deps.logger.warn('failed to send worker frame on transport session', {
							type: frame.type,
							error: err instanceof Error ? err.message : String(err),
						});
					}
				},
			};

			socket.on('open', () => {
				// stop() may have fired while the socket was connecting.
				if (stopped) {
					socket.close(WS_NORMAL_CLOSE, 'worker shutting down');
					return;
				}
				const sendHeartbeat = (): void => {
					try {
						socket.send(
							JSON.stringify(buildHeartbeatFrame(session.fencingToken, options.health?.())),
						);
					} catch (err) {
						finish({ reason: 'error', error: err });
					}
				};
				// Refresh the lease immediately so a short TTL can't lapse in the gap
				// between the handshake and the first cadence tick.
				sendHeartbeat();
				heartbeatTimer = setInterval(sendHeartbeat, heartbeatCadenceMs(session.heartbeatTtlMs));
			});
			socket.on('message', (data) => {
				const frame = parseControlFrame(data);
				if (!frame) return;
				// A `disconnect` control frame means the lease can no longer be refreshed
				// (lost/expired/superseded) — end the session so the loop reconnects with a
				// fresh handshake.
				if (frame.type === 'disconnect') {
					finish({ reason: 'disconnect', message: frame.reason });
					return;
				}
				// A pushed assignment (ADR-003 §2): hand it to the executor, which streams
				// its results back through `sink`. Runs independently of this session's
				// heartbeat loop, so a long phase never blocks lease liveness.
				if (frame.type === 'task-assignment') {
					options.onAssignment?.(frame, sink);
					return;
				}
				// `heartbeat-ack` needs no action.
			});
			socket.on('close', (code) =>
				finish({ reason: 'close', code: typeof code === 'number' ? code : WS_CLOSE.LEASE_LOST }),
			);
			socket.on('error', (err) => finish({ reason: 'error', error: err }));
		});
	}

	const done = (async () => {
		let attempt = 0;
		let everConnected = false;
		while (!stopped) {
			let session: HandshakeResponse;
			try {
				session = await performHandshake(deps, urls.sessionUrl, request);
			} catch (err) {
				if (isFatalHandshakeError(err, everConnected)) throw err;
				attempt += 1;
				const delayMs = computeReconnectDelayMs(attempt, backoff, deps.random);
				deps.logger.warn('worker transport handshake failed; backing off before retry', {
					attempt,
					delayMs,
					error: err instanceof Error ? err.message : String(err),
				});
				if (!(await backoffSleep(delayMs))) break;
				continue;
			}

			if (stopped) break;
			everConnected = true;
			attempt = 0;
			deps.logger.info('worker transport session established', {
				workerId: session.workerId,
				sessionId: session.sessionId,
				heartbeatTtlMs: session.heartbeatTtlMs,
			});

			const end = await runSession(session);
			if (stopped) break;

			// A `4401` close means the credential/token was rejected at the upgrade —
			// as fatal as a 401 handshake.
			if (end.reason === 'close' && end.code === WS_CLOSE.UNAUTHORIZED) {
				throw new WorkerTransportAuthError(
					'worker transport stream upgrade was rejected (unauthorized)',
				);
			}

			attempt += 1;
			const delayMs = computeReconnectDelayMs(attempt, backoff, deps.random);
			deps.logger.warn('worker transport session ended; reconnecting', {
				end: describeSessionEnd(end),
				delayMs,
			});
			if (!(await backoffSleep(delayMs))) break;
		}
	})();

	return {
		done,
		async stop(): Promise<void> {
			if (stopped) {
				await done.catch(() => {});
				return;
			}
			stopped = true;
			resolveStopped?.();
			// A normal close makes the control plane release the lease promptly rather
			// than waiting out the TTL (the server's `onClose` → `releaseSession`).
			activeSocket?.close(WS_NORMAL_CLOSE, 'worker shutting down');
			await done.catch(() => {});
		},
	};
}

/**
 * Whether a handshake error should stop the client rather than be retried. Auth,
 * protocol, and capability rejections are always fatal; a plain session conflict
 * is fatal only before the first successful connect (a competing daemon), and
 * recoverable afterward (a stale self-lease that expires within the TTL).
 */
function isFatalHandshakeError(err: unknown, everConnected: boolean): boolean {
	if (err instanceof WorkerTransportAuthError) return true;
	if (err instanceof WorkerTransportProtocolError) return true;
	if (err instanceof WorkerCapabilityConflictError) return true;
	if (err instanceof WorkerSessionConflictError) return !everConnected;
	return false;
}

/** Parse a WebSocket frame payload into a known control-plane message, if it is one. */
function parseControlFrame(data: unknown): ControlPlaneMessage | undefined {
	const text = frameToText(data);
	if (text === undefined) return undefined;
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		return undefined;
	}
	const parsed = ControlPlaneMessageSchema.safeParse(payload);
	return parsed.success ? parsed.data : undefined;
}

/** Normalize a WebSocket message payload (string or binary) to a string frame. */
function frameToText(data: unknown): string | undefined {
	if (typeof data === 'string') return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
	if (ArrayBuffer.isView(data)) {
		return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
	}
	return undefined;
}

/** A log-safe summary of how a session ended (never carries frame internals). */
function describeSessionEnd(end: SessionEnd): string {
	switch (end.reason) {
		case 'disconnect':
			return `disconnect: ${end.message}`;
		case 'close':
			return `socket closed (code ${end.code})`;
		case 'error':
			return `socket error: ${end.error instanceof Error ? end.error.message : String(end.error)}`;
	}
}
