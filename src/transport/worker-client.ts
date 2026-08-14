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
 *      transport is lost, re-acquiring the lease with a fresh handshake —
 *      presenting the session it already holds so a control-plane restart costs a
 *      round trip rather than the lease TTL (issue #608).
 *
 * **Backoff policy: unreachability and refusal are separate ladders (issue #611).**
 * A single counter advanced by every failure made the wait after a control-plane
 * outage grow with *how long it had been down* rather than with how long it stays
 * down, so a returning router met a daemon parked inside an already-scheduled delay
 * of up to the 30s cap. The retry schedule therefore keys off *who answered*:
 *
 *   - **The control plane answered and refused** — a 409 session conflict, a
 *     capability rejection, a 500 it generated itself — advances the ordinary
 *     ladder (`maxMs`, 30s). A server that is up and saying no is exactly what that
 *     ladder is for, and its shape is deliberately unchanged.
 *   - **Nothing answered** — the request never completed, or the edge answered for
 *     an origin that is not there (`UNREACHABLE_STATUSES`) — advances a *separate*
 *     ladder held to the much lower `unreachableMaxMs` ceiling, and an answer of
 *     any kind clears it. Its length is what bounds the idle gap after the control
 *     plane comes back, so it is capped where a daemon can afford to wait.
 *
 * The lower ceiling is a bound, not a removal: the equal-jitter floor still applies
 * to it, so a fleet reconnecting at once spreads across `[unreachableMaxMs/2,
 * unreachableMaxMs]` and no daemon retries a recovering control plane at a near-zero
 * delay. Resetting the counter outright was the alternative and was rejected for
 * exactly that reason — a 502 *is* a recovering server, and it must not be hammered.
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
import type { WorkerSessionReclaim } from '../identity/worker-session.js';
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
	type TaskCancel,
	type TaskExecutionResult,
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
 * daemon), but recoverable on a reconnect: this daemon normally takes its own
 * lease straight back by presenting it (issue #608), and a 409 that survives that
 * means the lease really is somebody else's now — so the loop drops the proof,
 * backs off, and retries as a plain acquire.
 */
export class WorkerSessionConflictError extends Error {
	constructor(message = 'a worker session is already held by another daemon') {
		super(message);
		this.name = 'WorkerSessionConflictError';
	}
}

/**
 * The declared capability set drops a CLI an enrollment requires (HTTP 409 with
 * `offending` CLIs). Fatal once re-declaring cannot change the answer: retrying
 * with the same too-narrow set only repeats the rejection, so the connect loop
 * re-probes PATH first (`WorkerTransportOptions.refreshCapabilities`) and gives
 * up only when the fresh probe still doesn't have the CLI.
 *
 * The message states what this daemon *declared*, not that the CLI is missing
 * (issue #559). The daemon does not know that: the set may have come from an
 * explicit `SWARM_WORKER_TRANSPORT_CLIS`, and telling an operator to install a
 * CLI that is sitting on their PATH points the investigation at the wrong thing.
 *
 * The control plane's `reason` is a *prefix*, never the whole message: it always
 * sends the same fixed sentence (`src/router/worker-transport.ts`), which names
 * no CLI and offers no next step, and this error is what the daemon dies with —
 * `describeError` renders exactly this string into the fatal log line.
 */
export class WorkerCapabilityConflictError extends Error {
	readonly offending: string[];
	constructor(offending: string[], reason?: string) {
		super(
			`${reason ?? 'declared capabilities drop a CLI an enrollment requires'}: ${offending.join(', ')} — this daemon did not declare it. Check that it runs on this host's PATH, or declare it explicitly with SWARM_WORKER_TRANSPORT_CLIS.`,
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

/**
 * The transient failure of a handshake the control plane never answered: the
 * request did not complete at all, or an edge answered on behalf of an origin that
 * is not there. Retried like any other transient failure, but on the separate,
 * lower-capped ladder (issue #611 — see the module doc), because its length decides
 * how long a daemon idles *after* the control plane is serving again.
 */
export class WorkerTransportUnreachableError extends WorkerTransportTransientError {
	constructor(message: string) {
		super(message);
		this.name = 'WorkerTransportUnreachableError';
	}
}

/**
 * Statuses that mean *nothing behind the edge answered* rather than "the control
 * plane answered and refused": the proxy/gateway family (502/503/504) plus
 * Cloudflare's origin-unreachable codes (520–524, 530), which is what SWARM's own
 * tunnel deployment returns while the router is restarting (`docs/cloudflare-tunnel.md`).
 * Everything else — a 500 the router generated, a 429 it chose to send — is an
 * answer, and keeps the ordinary ladder.
 */
const UNREACHABLE_STATUSES: ReadonlySet<number> = new Set([
	502, 503, 504, 520, 521, 522, 523, 524, 530,
]);

// --- Wire helpers (pure) ----------------------------------------------------

/**
 * Build the handshake request body, stamping the current protocol version.
 *
 * `supportedPhases` is the caller's phase repertoire (issue #467): every daemon
 * passes `SUPPORTED_DB_FREE_PHASES`, which since issue #536 is all six. It
 * stays required rather than defaulted because a default would be a claim the
 * transport made on a caller's behalf: a daemon that later narrows its repertoire
 * would silently keep claiming phases it refuses.
 *
 * `repository` is the checkout this daemon holds (issue #687), omitted entirely
 * when the caller could not identify it — the key is left off the body rather than
 * sent as null, so the request a daemon with an unidentifiable checkout sends is
 * byte-identical to the one a daemon predating the field sends.
 */
export function buildHandshakeRequest(input: {
	credential: string;
	daemonVersion: string;
	hostname: string;
	capabilities: AgentCli[];
	supportedPhases: readonly TaskPhase[];
	repository?: string;
}): HandshakeRequest {
	return HandshakeRequestSchema.parse({
		credential: input.credential,
		daemonVersion: input.daemonVersion,
		hostname: input.hostname,
		capabilities: input.capabilities,
		supportedPhases: [...input.supportedPhases],
		...(input.repository ? { repository: input.repository } : {}),
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
	});
}

/**
 * The handshake request, plus the proof of possession when this daemon already
 * holds a lease (issue #608). A separate pure helper rather than a field on
 * `buildHandshakeRequest`'s input, because the base request is built once up front
 * (and rebuilt only by a capability re-probe) while the proof changes with every
 * successful handshake.
 */
export function withSessionReclaim(
	request: HandshakeRequest,
	reclaim: WorkerSessionReclaim | undefined,
): HandshakeRequest {
	return reclaim ? { ...request, reclaim } : request;
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

/**
 * Reconnect backoff schedule: exponential (base·2^(n-1)), capped, with equal jitter.
 * Two ceilings rather than one (issue #611 — see the module doc): `maxMs` bounds the
 * ladder for a control plane that answered and refused, `unreachableMaxMs` the one
 * for a control plane that answered nothing at all.
 */
export interface BackoffConfig {
	baseMs: number;
	maxMs: number;
	unreachableMaxMs: number;
}

/**
 * `unreachableMaxMs` is a sixth of `maxMs`: the unreachable ladder tops out at a
 * jittered `[2.5s, 5s]`, which is the whole of the delay a worker can still be
 * sitting in when the control plane starts serving again — small enough that a
 * router restart costs a round trip rather than a ladder, wide enough that a fleet's
 * retries stay spread across a 2.5s window instead of arriving together.
 */
export const DEFAULT_BACKOFF: BackoffConfig = {
	baseMs: 1_000,
	maxMs: 30_000,
	unreachableMaxMs: 5_000,
};

/**
 * The schedule for attempts the control plane never answered: the same exponential
 * growth and the same equal-jitter floor, held to the lower `unreachableMaxMs`
 * ceiling so the post-outage wait cannot grow with the length of the outage.
 */
function unreachableBackoff(config: BackoffConfig): BackoffConfig {
	return { ...config, maxMs: config.unreachableMaxMs };
}

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

/** A reconnect wait: which ladder produced it, where that ladder stands, how long to sleep. */
export interface ReconnectStep {
	/** The producing ladder's position, 1-based — what the retry log line reports. */
	attempt: number;
	delayMs: number;
	/** Whether this came from the unreachable ladder rather than the ordinary one. */
	unreachable: boolean;
}

/**
 * The connect loop's pair of reconnect ladders (issue #611 — the policy itself is
 * stated in the module doc). Two counters rather than one, so the length of a
 * control-plane *outage* can never drive the schedule used against a control plane
 * that is up and refusing; and the single place that decides which failure belongs
 * on which ladder, so the loop reads as "step, log, sleep".
 */
export interface ReconnectLadders {
	/** The wait a handshake failure earns, on whichever ladder its class belongs to. */
	forHandshakeFailure(err: unknown): ReconnectStep;
	/** The wait a lost live session earns — always the ordinary ladder's next rung. */
	forSessionLoss(): ReconnectStep;
	/** Clear both: a handshake succeeded, so neither ladder's history applies. */
	reset(): void;
}

/** Build the two ladders over one backoff config and jitter source. */
export function createReconnectLadders(
	config: BackoffConfig,
	random: () => number,
): ReconnectLadders {
	let answeredAttempt = 0;
	let unreachableAttempt = 0;
	const unreachableConfig = unreachableBackoff(config);

	const answered = (): ReconnectStep => {
		// An answer of any kind proves the control plane is reachable, so whatever the
		// unreachable ladder had climbed to is stale.
		unreachableAttempt = 0;
		answeredAttempt += 1;
		return {
			attempt: answeredAttempt,
			delayMs: computeReconnectDelayMs(answeredAttempt, config, random),
			unreachable: false,
		};
	};

	return {
		forHandshakeFailure(err: unknown): ReconnectStep {
			if (!(err instanceof WorkerTransportUnreachableError)) return answered();
			// Deliberately leaves the ordinary ladder where it was: an outage is not a
			// refusal, and must not spend the refusal ladder's rungs on its behalf.
			unreachableAttempt += 1;
			return {
				attempt: unreachableAttempt,
				delayMs: computeReconnectDelayMs(unreachableAttempt, unreachableConfig, random),
				unreachable: true,
			};
		},
		forSessionLoss: answered,
		reset(): void {
			answeredAttempt = 0;
			unreachableAttempt = 0;
		},
	};
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
 * transient — and the transient half splits again on whether the control plane
 * answered at all, which picks the retry ladder). Never logs or echoes the
 * credential — the control plane's error bodies are constant-shape and
 * credential-free by contract.
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
		// No round trip completed at all — the control plane is unreachable rather than
		// refusing (issue #611), so this retries on the lower-capped ladder.
		throw new WorkerTransportUnreachableError(
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
	throw transientErrorForStatus(response.status);
}

/**
 * The transient error a retryable status maps to — the narrower unreachable variant
 * when nothing behind the edge answered, so the connect loop can pick the matching
 * backoff ladder (issue #611).
 */
function transientErrorForStatus(status: number): WorkerTransportTransientError {
	const message = `control plane returned HTTP ${status}`;
	return UNREACHABLE_STATUSES.has(status)
		? new WorkerTransportUnreachableError(message)
		: new WorkerTransportTransientError(message);
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
 * worker→cloud frames (the assignment ack, batched live output, progress, and the
 * terminal execution result) back to the control plane (ADR-003 §2). Serialization
 * is handled here so the handler only ever deals in typed frames.
 *
 * **`send` is best-effort for output and at-least-once for the result** (issue #718).
 * The sink lives for the *process*, not for one WebSocket session: a phase runs
 * independently of the heartbeat loop, so it routinely outlives the session it was
 * pushed on, and the terminal `TaskExecutionResult` is the one frame whose loss is
 * a correctness bug rather than a diagnostic one. A terminal frame that could not be
 * written is therefore **held** and re-sent on the next session; every other frame
 * is dropped (logged) exactly as before.
 *
 * This used to be a closure over one session, justified by "a reconnect re-pushes
 * the assignment and the handler resumes rather than duplicating". **That premise
 * does not cover a dispatch that is already `state='running'`** — which is every
 * dispatch whose phase is executing, i.e. the only case the sink is used in.
 * `handleWorkerStreamOpen` (`../router/worker-transport.ts`) wakes only
 * availability-blocked dispatches, and `listWakeablePendingDispatches`
 * (`../db/repositories/dispatchesRepository.ts`) selects only `retry-scheduled`/
 * `pending` rows, so nothing re-pushes a running dispatch and nothing re-attaches a
 * sink to the run still executing under it. A one-second socket blip therefore
 * discarded the outcome — a *successful* one included — and the dispatch settled
 * ~30 minutes later on the back-channel timer as a worker-liveness timeout.
 *
 * Two properties of the surrounding machinery are what make holding the frame
 * sufficient. The control plane's waiter survives the disconnect untouched (the
 * `pending` entry in `../router/dispatch-results.ts` is cleared only on delivery or
 * supersede — the socket's `onClose` does not touch it), so a result re-sent on the
 * next session lands on the *same* waiter and settles the dispatch normally. And
 * delivery is already consume-once: `deliverDispatchResult` deletes the entry before
 * resolving, so a duplicate terminal frame is a logged no-op. **Exactly-once stays
 * the consumer's property**; the worker deliberately only has to be at-least-once,
 * which is why it re-sends rather than trying to be exactly-once on the wire.
 *
 * Non-terminal frames (`stream-log`, `task-progress`, `task-assignment-ack`) are
 * never queued. Output is unbounded and best-effort by design — a replay buffer for
 * it would be a memory liability with no correctness payoff — while the result queue
 * is one frame per dispatch and bounded at {@link MAX_UNDELIVERED_RESULTS}. What is
 * lost is the run page's output for the affected window, not the run's outcome.
 *
 * **Two residual losses this does not close**, so the fix is not read as total:
 *
 *   1. A frame written into a socket whose peer is already gone but whose `close`
 *      event has not yet fired is still lost — the write succeeds locally and nothing
 *      holds it. That window is sub-second; the observed incident was 12 minutes
 *      past it.
 *   2. A result flushed after the control plane has disposed its waiter is dropped
 *      router-side (bounded by `timeoutMs + RESULT_WAIT_MARGIN_MS`,
 *      `../router/dispatcher.ts`). Phase 2 of issue #718 makes that case say so;
 *      issue #719 shortened it for the one shape that is knowable early — a session
 *      *superseded* by a newer generation, whose claims the next handshake settles
 *      at once (`../router/worker-transport.ts`). A flush racing that settle is the
 *      residual: the daemon holding it is, by definition, one whose reclaim was
 *      refused.
 *
 * "Re-send until acked" was rejected: there is no result ack, and `dispatchId` is
 * stable across a re-dispatch (`reopenDispatchForManualRetry`, `../api/routers/runs.ts`),
 * so an unbounded re-send could settle a *later* attempt with an earlier attempt's
 * outcome. Persisting the queue to disk was rejected for the same reason `heldSession`
 * is in memory only: a restarted daemon has no claim on the old lease, so a queue
 * that outlived the process would re-report into a dispatch the control plane has
 * since re-decided.
 */
export interface AssignmentSink {
	send(frame: WorkerStreamMessage): void;
}

/**
 * How many undelivered terminal results the sink holds — one per dispatch, so this
 * bounds distinct *dispatches* rather than frames. Generous relative to how many
 * phases one daemon runs at once, because the queue only grows while the control
 * plane is unreachable; an eviction is a lost outcome and is logged as an error.
 */
export const MAX_UNDELIVERED_RESULTS = 32;

/**
 * The {@link AssignmentSink} plus the session lifecycle only this module drives.
 * One instance lives for the whole client, and each session attaches the socket it
 * owns and detaches it again when it ends (issue #718 — see {@link AssignmentSink}
 * for why the sink cannot be per-session).
 */
export interface SessionSpanningSink extends AssignmentSink {
	/** A session opened: write through this socket, then flush what is held. */
	attach(socket: TransportSocket): void;
	/** That session ended: hold terminal frames until the next `attach`. */
	detach(socket: TransportSocket): void;
	/**
	 * Consume the undelivered terminal result held for `dispatchId`, if any — how a
	 * re-pushed assignment is answered with the outcome it already has instead of
	 * re-running the phase.
	 */
	takeUndelivered(dispatchId: string): TaskExecutionResult | undefined;
	/** No further session will open — report anything still held, loudly. */
	seal(): void;
}

/**
 * Build the client's one sink. Exported so the queue rules are unit-testable
 * without a socket or a reconnect loop.
 */
export function createAssignmentSink(logger: TransportLogger): SessionSpanningSink {
	/** dispatchId → the terminal result this worker produced and could not deliver. */
	const undelivered = new Map<string, TaskExecutionResult>();
	let current: TransportSocket | undefined;
	let sealed = false;

	/** A log-safe identification of a held result — never its error text or output. */
	const describeResult = (result: TaskExecutionResult): Record<string, unknown> => ({
		dispatchId: result.dispatchId,
		runId: result.runId,
		phase: result.phase,
		status: result.status,
	});

	/** Write on the live socket; `false` when there is none or the write threw. */
	function write(frame: WorkerStreamMessage): boolean {
		if (!current) return false;
		try {
			current.send(JSON.stringify(frame));
			return true;
		} catch (err) {
			// A throwing write is treated as a non-write, so a terminal frame is held
			// rather than counted as delivered.
			logger.warn('failed to send worker frame on transport session', {
				type: frame.type,
				error: err instanceof Error ? err.message : String(err),
			});
			return false;
		}
	}

	function hold(result: TaskExecutionResult): void {
		if (sealed) {
			logger.error('losing a phase result — the worker transport has stopped for good', {
				...describeResult(result),
			});
			return;
		}
		// Last write wins per dispatch, and re-inserting moves the entry to the back of
		// the flush order: a phase reports one terminal result, so a second one for the
		// same dispatch is a later attempt superseding an earlier attempt's outcome.
		undelivered.delete(result.dispatchId);
		undelivered.set(result.dispatchId, result);
		logger.warn('holding a phase result until the next transport session', {
			...describeResult(result),
			held: undelivered.size,
		});
		while (undelivered.size > MAX_UNDELIVERED_RESULTS) {
			const oldest = undelivered.keys().next();
			if (oldest.done) return;
			const evicted = undelivered.get(oldest.value);
			undelivered.delete(oldest.value);
			// `error`, not `warn`: this is a phase outcome that will never reach the
			// control plane, so the dispatch settles on the back-channel timer instead.
			if (evicted) {
				logger.error('dropping an undelivered phase result — the worker result queue is full', {
					...describeResult(evicted),
					limit: MAX_UNDELIVERED_RESULTS,
				});
			}
		}
	}

	/** Deliver held results oldest-first, stopping at the first write that fails. */
	function flush(): void {
		for (const [dispatchId, result] of [...undelivered]) {
			if (!write(result)) return;
			undelivered.delete(dispatchId);
			logger.info('delivered a phase result held across a transport session', {
				...describeResult(result),
			});
		}
	}

	return {
		send(frame: WorkerStreamMessage): void {
			if (frame.type !== 'task-execution-result') {
				// Output and progress are best-effort: dropped, never queued.
				if (!current) {
					logger.warn('dropping worker frame — no live transport session', { type: frame.type });
					return;
				}
				write(frame);
				return;
			}
			if (write(frame)) {
				undelivered.delete(frame.dispatchId);
				return;
			}
			hold(frame);
		},
		attach(socket: TransportSocket): void {
			current = socket;
			flush();
		},
		detach(socket: TransportSocket): void {
			// Identity-checked, like `../router/worker-connections.ts`'s deregister: a
			// stale session's end must not detach the socket that replaced it.
			if (current === socket) current = undefined;
		},
		takeUndelivered(dispatchId: string): TaskExecutionResult | undefined {
			const held = undelivered.get(dispatchId);
			if (held) undelivered.delete(dispatchId);
			return held;
		},
		seal(): void {
			sealed = true;
			for (const result of undelivered.values()) {
				logger.error('abandoning an undelivered phase result — the worker transport stopped', {
					...describeResult(result),
				});
			}
			undelivered.clear();
		},
	};
}

export interface WorkerTransportOptions {
	controlPlaneUrl: string;
	credential: string;
	capabilities: AgentCli[];
	/**
	 * The pipeline phases this daemon can execute (issue #467), declared at
	 * handshake so the control plane never selects it for a phase it would refuse.
	 * `./connect-entry.ts` — the one worker program (issue #551) — passes
	 * `SUPPORTED_DB_FREE_PHASES`.
	 */
	supportedPhases: readonly TaskPhase[];
	/**
	 * The `owner/repo` this daemon's one local checkout is (issue #687), declared at
	 * handshake so the control plane knows which repository the machine can actually
	 * work in — `repoRoot` itself is host-local and never travels. `./connect-entry.ts`
	 * resolves it once from the checkout's `origin` remote; omitted when the checkout
	 * cannot be identified, which declares nothing rather than failing.
	 */
	repository?: string;
	/**
	 * Re-run capability discovery after the control plane rejects the declared set
	 * (issue #559). A PATH probe can miss a CLI that is installed — a loaded
	 * machine, a binary mid-upgrade — and that rejection is otherwise terminal, so
	 * the daemon dies over a hiccup. Supplied only when the set was *discovered*:
	 * an explicit `SWARM_WORKER_TRANSPORT_CLIS` is the operator's declaration and
	 * re-probing would talk over it. Left undefined, a capability conflict stays
	 * immediately fatal.
	 */
	refreshCapabilities?: () => Promise<AgentCli[]>;
	hostname: string;
	daemonVersion: string;
	/** Optional advisory host-health provider, attached to each heartbeat. */
	health?: () => WorkerHealth | undefined;
	/** Reconnect backoff overrides (defaults to {@link DEFAULT_BACKOFF}). */
	backoff?: Partial<BackoffConfig>;
	/**
	 * Called when the control plane pushes a `task-assignment` frame on the live
	 * session (ADR-003 §2). The handler runs the phase and streams results back
	 * through the supplied {@link AssignmentSink}. `./connect-entry.ts` supplies it
	 * ({@link runAssignmentDbFree}); it stays optional so a session-only client —
	 * one that keeps its lease live but executes no work — remains expressible.
	 * Fire-and-forget: the handler runs independently of the heartbeat loop, so a
	 * long phase never blocks lease liveness.
	 */
	onAssignment?: (assignment: TaskAssignment, sink: AssignmentSink) => void;
	/**
	 * Called when the control plane pushes a `task-cancel` frame (issue #549) — the
	 * transport delivery of the dashboard's Terminate action, which a worker with no
	 * `REDIS_URL` cannot learn about any other way. The handler aborts the matching
	 * in-flight run (`cancelAssignment`, `./assignment-execution.ts`).
	 *
	 * **The frame is a question, not only an abort** (issue #724): only this daemon
	 * knows whether the phase is still executing here, so the handler answers a cancel
	 * it cannot apply through the supplied {@link AssignmentSink} — with the terminal
	 * cancelled result, which settles the run as the user termination it is instead of
	 * leaving it on the control plane's back-channel timer. That is why it is handed
	 * the same sink an assignment gets. Left undefined the frame is logged and ignored,
	 * which is exactly how a daemon predating the frame behaves.
	 */
	onCancel?: (cancel: TaskCancel, sink: AssignmentSink) => void;
	/**
	 * Called with each established session, before the stream opens — the only place
	 * a daemon learns the `workerId` it authenticates as, since the credential does
	 * not carry it (issue #689: the checkout lock records it so a second daemon's
	 * refusal can *name* the holder). Worker-side bookkeeping only, so it changes no
	 * wire shape; it fires again on every reconnect, and a handler must therefore be
	 * idempotent. A throwing handler is logged and swallowed rather than killing the
	 * transport — this is not the connection.
	 */
	onSession?: (session: HandshakeResponse) => void;
}

/** How a live session ended, deciding whether the loop reconnects or fails. */
type SessionEnd =
	| { reason: 'disconnect'; message: string }
	| { reason: 'close'; code: number }
	| { reason: 'error'; error: unknown };

/** Normal WebSocket close code sent on a graceful shutdown. */
const WS_NORMAL_CLOSE = 1000;

/**
 * How many times a capability rejection may be answered with a fresh PATH probe
 * before it is taken at face value. Two covers the case this exists for — a probe
 * that missed a CLI once — without letting a flapping PATH reconnect forever.
 */
const MAX_CAPABILITY_REPROBES = 2;

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
	// Rebuilt only when a re-probe widens the declared set (see `reprobeRequest`).
	let request = buildHandshakeRequest(options);

	let stopped = false;
	let activeSocket: TransportSocket | undefined;
	// One sink for the whole client, not one per session: a phase outlives the session
	// it was pushed on, and its terminal result has to survive that (issue #718 — see
	// `AssignmentSink`). Each session attaches its own socket and detaches it again.
	const sink = createAssignmentSink(deps.logger);
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
				// From here on a still-running phase's terminal result is held rather than
				// written into a dead socket (issue #718).
				sink.detach(socket);
				resolve(end);
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
				// A first heartbeat that threw already ended this session, so there is nothing
				// to attach the sink to and no cadence worth starting.
				if (settled) return;
				// Lease first, backlog second: whatever a phase could not report while the
				// socket was down goes out now (issue #718).
				sink.attach(socket);
				heartbeatTimer = setInterval(sendHeartbeat, heartbeatCadenceMs(session.heartbeatTtlMs));
			});
			socket.on('message', (data) => {
				const frame = parseControlFrame(data, deps.logger);
				if (!frame) return;
				// A `disconnect` control frame means the lease can no longer be refreshed
				// (lost/expired/superseded) — end the session so the loop reconnects with a
				// fresh handshake.
				if (frame.type === 'disconnect') {
					finish({ reason: 'disconnect', message: frame.reason });
					return;
				}
				// Everything else is work rather than session liveness: a pushed assignment
				// and the cancellation that stops one, both handed to the executor. They run
				// independently of this session's heartbeat loop, so a long phase never
				// blocks lease liveness — and `heartbeat-ack` needs no action at all.
				routeWorkFrame(frame, options, deps.logger, sink);
			});
			socket.on('close', (code) =>
				finish({ reason: 'close', code: typeof code === 'number' ? code : WS_CLOSE.LEASE_LOST }),
			);
			socket.on('error', (err) => finish({ reason: 'error', error: err }));
		});
	}

	let reprobesLeft = MAX_CAPABILITY_REPROBES;

	/**
	 * Answer a capability rejection by re-probing PATH: a handshake request
	 * carrying the CLI the control plane asked for, or `undefined` when the
	 * rejection stands and the caller should treat it as fatal.
	 *
	 * The rejection stands unless the fresh probe actually *gains* an offending
	 * CLI. That is what keeps the retry bounded and honest — a genuinely missing
	 * CLI fails on the same round trip it always did, and only a probe that
	 * changed its mind buys another attempt (issue #559).
	 */
	async function reprobeRequest(
		err: WorkerCapabilityConflictError,
	): Promise<HandshakeRequest | undefined> {
		if (!options.refreshCapabilities || reprobesLeft <= 0) return undefined;
		reprobesLeft -= 1;
		let refreshed: AgentCli[];
		try {
			refreshed = await options.refreshCapabilities();
		} catch (probeErr) {
			deps.logger.warn('re-probing agent CLIs after a capability rejection failed', {
				error: probeErr instanceof Error ? probeErr.message : String(probeErr),
			});
			return undefined;
		}
		const declared = new Set<string>(request.capabilities);
		const reprobed = new Set<string>(refreshed);
		const gained = err.offending.filter((cli) => !declared.has(cli) && reprobed.has(cli));
		if (gained.length === 0) return undefined;
		deps.logger.warn('re-probe found agent CLIs the handshake was rejected for; re-declaring', {
			gained,
			capabilities: refreshed,
		});
		return buildHandshakeRequest({ ...options, capabilities: refreshed });
	}

	const ladders = createReconnectLadders(backoff, deps.random);

	const done = (async () => {
		let everConnected = false;
		// The lease this daemon currently holds, presented on a reconnect handshake so
		// the control plane recognises its own holder instead of refusing it for the
		// remainder of the TTL (issue #608). In memory only, deliberately: a restarted
		// *daemon* has no claim on the old lease and must acquire afresh.
		let heldSession: WorkerSessionReclaim | undefined;
		try {
			while (!stopped) {
				let session: HandshakeResponse;
				try {
					session = await performHandshake(
						deps,
						urls.sessionUrl,
						withSessionReclaim(request, heldSession),
					);
				} catch (err) {
					if (err instanceof WorkerSessionConflictError && heldSession) {
						// The lease we remembered is genuinely someone else's now — it was
						// re-acquired while we were away, so our token no longer matches. Drop the
						// proof so the next attempt is a plain acquire, and let the normal backoff
						// wait the TTL out.
						deps.logger.warn('reclaim of the previously held worker session was refused', {
							sessionId: heldSession.sessionId,
						});
						heldSession = undefined;
					}
					if (err instanceof WorkerCapabilityConflictError) {
						const refreshedRequest = await reprobeRequest(err);
						if (!refreshedRequest) throw err;
						request = refreshedRequest;
					} else if (isFatalHandshakeError(err, everConnected)) throw err;
					// An outage climbs only the lower-capped ladder (issue #611), so the daemon is
					// never parked in a long delay it earned while nobody was home. `unreachable`
					// names the ladder, so the line says on its face whether the control plane
					// refused this attempt or never answered it.
					const step = ladders.forHandshakeFailure(err);
					deps.logger.warn('worker transport handshake failed; backing off before retry', {
						attempt: step.attempt,
						unreachable: step.unreachable,
						delayMs: step.delayMs,
						error: err instanceof Error ? err.message : String(err),
					});
					if (!(await backoffSleep(step.delayMs))) break;
					continue;
				}

				if (stopped) break;
				everConnected = true;
				ladders.reset();
				deps.logger.info('worker transport session established', {
					workerId: session.workerId,
					sessionId: session.sessionId,
					heartbeatTtlMs: session.heartbeatTtlMs,
					// Which path this handshake took, so the log says on its face whether the
					// reconnect reclaimed the lease it already held or acquired a fresh one.
					reclaimed: heldSession !== undefined,
				});
				heldSession = { sessionId: session.sessionId, fencingToken: session.fencingToken };
				notifySession(session, options, deps.logger);

				const end = await runSession(session);
				if (stopped) break;

				// A `4401` close means the credential/token was rejected at the upgrade —
				// as fatal as a 401 handshake.
				if (end.reason === 'close' && end.code === WS_CLOSE.UNAUTHORIZED) {
					throw new WorkerTransportAuthError(
						'worker transport stream upgrade was rejected (unauthorized)',
					);
				}

				// A lost session steps the ordinary ladder, and both were just cleared by the
				// handshake that opened it, so this is always its first rung. Whether the control
				// plane is *gone* rather than merely done with us is the next handshake's answer
				// to give, and that is what picks the ladder from there on.
				const { delayMs } = ladders.forSessionLoss();
				deps.logger.warn('worker transport session ended; reconnecting', {
					end: describeSessionEnd(end),
					delayMs,
				});
				if (!(await backoffSleep(delayMs))) break;
			}
		} finally {
			// No further session will open, so a result still held here is lost — say so
			// rather than parking it in a map nothing will ever flush (issue #718). In a
			// `finally` so it covers a graceful `stop()` and a fatal handshake error alike.
			sink.seal();
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
 * Whether a handshake error should stop the client rather than be retried. Auth
 * and protocol rejections are always fatal; a plain session conflict is fatal
 * only before the first successful connect (a competing daemon), and recoverable
 * afterward — the reconnect normally reclaims the lease outright (issue #608), and
 * a conflict that survives that means another daemon really took it. A capability
 * rejection is fatal too, but the connect loop gets first refusal on it — it
 * re-probes PATH and only falls through to this classification once the fresh
 * probe agrees the CLI is not there (issue #559).
 */
function isFatalHandshakeError(err: unknown, everConnected: boolean): boolean {
	if (err instanceof WorkerTransportAuthError) return true;
	if (err instanceof WorkerTransportProtocolError) return true;
	if (err instanceof WorkerCapabilityConflictError) return true;
	if (err instanceof WorkerSessionConflictError) return !everConnected;
	return false;
}

/**
 * Hand the established session to the daemon's own bookkeeping
 * ({@link WorkerTransportOptions.onSession}). Guarded, because that handler is not
 * part of the connection: a throw here would otherwise reject the connect loop and
 * take a healthy session down with it.
 */
function notifySession(
	session: HandshakeResponse,
	options: WorkerTransportOptions,
	logger: TransportLogger,
): void {
	if (!options.onSession) return;
	try {
		options.onSession(session);
	} catch (err) {
		logger.warn('worker session handler failed', {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Route the cloud→worker *work* frames — a pushed `TaskAssignment` (ADR-003 §2)
 * and the `TaskCancel` that stops one (issue #549) — to the executor's handlers.
 * Both handlers are optional, because a session-only client keeps its lease live
 * and runs nothing: an unhandled frame is logged and ignored, never an error.
 * `heartbeat-ack` falls through with no action.
 *
 * Either frame is answered from the undelivered queue first when this daemon still
 * holds that dispatch's terminal result: an assignment because re-reporting beats
 * re-running the phase (issue #718), a cancellation because the real outcome beats
 * the synthetic cancellation (issue #724).
 *
 * Module-level rather than inline in the socket's `message` listener so that
 * listener stays a flat frame switch as frames are added.
 */
function routeWorkFrame(
	frame: ControlPlaneMessage,
	options: WorkerTransportOptions,
	logger: TransportLogger,
	sink: SessionSpanningSink,
): void {
	if (frame.type === 'task-assignment') {
		// This daemon already ran the phase and still holds its outcome, so the push is
		// answered with that outcome rather than by running it again (issue #718). Keyed
		// on the *undelivered* set rather than on "this dispatch ever settled here":
		// `dispatchId` is stable across a re-open (`reopenDispatchForManualRetry`,
		// `../api/routers/runs.ts`), so a memory of delivered results would answer a
		// genuine manual retry with the stale outcome it was retrying. `send` re-holds the
		// frame if the write fails, so consuming it here cannot lose it.
		const held = sink.takeUndelivered(frame.dispatchId);
		if (held) {
			logger.warn('re-reporting a phase result the control plane never received', {
				dispatchId: frame.dispatchId,
				runId: frame.runId,
				phase: frame.phase,
				status: held.status,
			});
			sink.send(held);
			return;
		}
		options.onAssignment?.(frame, sink);
		return;
	}
	if (frame.type === 'task-cancel') {
		// This daemon already ran the phase and still holds its real outcome, so the
		// cancellation is answered with *that* rather than with the synthetic one the
		// handler would build (issue #724): a Terminate arriving after the phase actually
		// finished settles the run on its true outcome. Consuming the held frame here
		// cannot lose it — `send` re-holds it if the write fails.
		const held = sink.takeUndelivered(frame.dispatchId);
		if (held) {
			logger.warn(
				'answering a task-cancel with the phase result the control plane never received',
				{
					dispatchId: frame.dispatchId,
					runId: frame.runId,
					status: held.status,
				},
			);
			sink.send(held);
			return;
		}
		if (!options.onCancel) {
			logger.info('ignoring task-cancel — this client runs no assignments', {
				dispatchId: frame.dispatchId,
				runId: frame.runId,
			});
			return;
		}
		options.onCancel(frame, sink);
	}
}

/**
 * Parse a WebSocket frame payload into a known control-plane message, if it is
 * one. An unrecognised frame is a **logged no-op**, never a close: that is what
 * lets the control plane add a cloud→worker frame without a
 * `TRANSPORT_PROTOCOL_VERSION` bump (`task-cancel`, issue #549) — a daemon that
 * predates it keeps its session and simply does nothing. The line names the
 * frame's `type` and nothing else, so it stays useful for diagnosing a version
 * skew without logging frame contents.
 */
function parseControlFrame(
	data: unknown,
	logger: TransportLogger,
): ControlPlaneMessage | undefined {
	const text = frameToText(data);
	if (text === undefined) return undefined;
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		logger.debug('ignoring an unparseable control-plane frame');
		return undefined;
	}
	const parsed = ControlPlaneMessageSchema.safeParse(payload);
	if (!parsed.success) {
		const type = (payload as { type?: unknown } | null)?.type;
		logger.debug('ignoring an unrecognized control-plane frame', {
			type: typeof type === 'string' ? type : undefined,
		});
		return undefined;
	}
	return parsed.data;
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
