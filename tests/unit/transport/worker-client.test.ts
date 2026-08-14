import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toNonSecretProjectConfig } from '@/config/project-config-slice.js';
import type { AgentCli } from '@/harness/agent-cli.js';
import { SUPPORTED_DB_FREE_PHASES } from '@/transport/assignment-execution.js';
import {
	type StreamLog,
	type TaskExecutionResult,
	type TaskPhase,
	TRANSPORT_PROTOCOL_VERSION,
	WS_CLOSE,
} from '@/transport/protocol.js';
import {
	type AssignmentSink,
	buildHandshakeRequest,
	buildHeartbeatFrame,
	computeReconnectDelayMs,
	connectWorkerTransport,
	createAssignmentSink,
	createReconnectLadders,
	DEFAULT_BACKOFF,
	deriveTransportUrls,
	type FetchResponse,
	heartbeatCadenceMs,
	MAX_UNDELIVERED_RESULTS,
	performHandshake,
	type TransportSocket,
	WorkerCapabilityConflictError,
	WorkerSessionConflictError,
	WorkerTransportAuthError,
	type WorkerTransportOverrides,
	WorkerTransportProtocolError,
	WorkerTransportTransientError,
	WorkerTransportUnreachableError,
	withSessionReclaim,
} from '@/transport/worker-client.js';
import { ALL_TRIGGER_PHASES } from '@/triggers/types.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CREDENTIAL = 'raw-worker-credential-secret';
const DISPATCH_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_DISPATCH_ID = '66666666-6666-4666-8666-666666666666';

/** A recorded log line, so the abandonment/eviction levels can be asserted. */
interface LoggedLine {
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
	context?: Record<string, unknown>;
}

function recordingLogger(): WorkerTransportOverrides['logger'] & { lines: LoggedLine[] } {
	const lines: LoggedLine[] = [];
	const at =
		(level: LoggedLine['level']) =>
		(message: string, context?: Record<string, unknown>): void => {
			lines.push({ level, message, context });
		};
	return {
		lines,
		debug: at('debug'),
		info: at('info'),
		warn: at('warn'),
		error: at('error'),
	};
}

/** A well-formed pushed assignment, so the reconnect loop's frame route is exercised. */
const ASSIGNMENT_FRAME = {
	type: 'task-assignment' as const,
	protocolVersion: TRANSPORT_PROTOCOL_VERSION,
	dispatchId: DISPATCH_ID,
	runId: RUN_ID,
	phase: 'implementation' as const,
	taskId: '718',
	projectConfig: toNonSecretProjectConfig(createMockProjectConfig()),
	targetBranch: 'issue-718',
	systemPrompt: 'Implement it.',
	target: { cli: 'claude' as const },
};

/** The terminal frame whose loss issue #718 is about. */
function resultFrame(overrides: Partial<TaskExecutionResult> = {}): TaskExecutionResult {
	return {
		type: 'task-execution-result',
		dispatchId: DISPATCH_ID,
		runId: RUN_ID,
		status: 'succeeded',
		phase: 'implementation',
		taskId: '718',
		exitCode: 0,
		timedOut: false,
		durationMs: 1_103_701,
		...overrides,
	};
}

function handshakeResponseBody(fencingToken: number, heartbeatTtlMs = 60_000) {
	return {
		authenticated: true,
		workerId: WORKER_ID,
		sessionId: SESSION_ID,
		fencingToken,
		heartbeatTtlMs,
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
	};
}

function jsonResponse(status: number, body: unknown): FetchResponse {
	return { status, json: async () => body };
}

const silentLogger: WorkerTransportOverrides['logger'] = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

describe('buildHandshakeRequest', () => {
	it('stamps the protocol version and carries the declared fields', () => {
		const request = buildHandshakeRequest({
			credential: CREDENTIAL,
			daemonVersion: '0.1.0',
			hostname: 'ada-laptop',
			capabilities: ['claude', 'codex'],
			supportedPhases: ALL_TRIGGER_PHASES,
		});
		expect(request).toEqual({
			credential: CREDENTIAL,
			daemonVersion: '0.1.0',
			hostname: 'ada-laptop',
			capabilities: ['claude', 'codex'],
			supportedPhases: [...ALL_TRIGGER_PHASES],
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
	});

	// A daemon that declares a strict subset must have it carried verbatim (issue
	// #467), so the control plane never selects it for a phase it refuses. Today's
	// DB-free daemon declares every phase (`SUPPORTED_DB_FREE_PHASES`, issue #536), so
	// the narrowed set here is a *pre-#536* daemon's — the version skew this must keep
	// handling, and the reason the field is not simply assumed to be complete.
	it('carries a narrowed phase set verbatim without widening it', () => {
		const legacyDbFreePhases: TaskPhase[] = [
			'respond-to-ci',
			'resolve-conflicts',
			'implementation',
			'review',
			'respond-to-review',
		];
		const request = buildHandshakeRequest({
			credential: CREDENTIAL,
			daemonVersion: '0.1.0',
			hostname: 'ada-laptop',
			capabilities: ['claude'],
			supportedPhases: legacyDbFreePhases,
		});
		expect(request.supportedPhases).toEqual(legacyDbFreePhases);
		expect(request.supportedPhases).not.toContain('planning');
	});

	it('carries today’s DB-free repertoire, which is every phase (issue #536)', () => {
		const request = buildHandshakeRequest({
			credential: CREDENTIAL,
			daemonVersion: '0.1.0',
			hostname: 'ada-laptop',
			capabilities: ['claude'],
			supportedPhases: [...SUPPORTED_DB_FREE_PHASES],
		});
		expect(request.supportedPhases).toEqual([...SUPPORTED_DB_FREE_PHASES]);
		expect(request.supportedPhases).toContain('planning');
	});

	it('rejects an empty phase set (a daemon that can run nothing is a bug)', () => {
		expect(() =>
			buildHandshakeRequest({
				credential: CREDENTIAL,
				daemonVersion: '0.1.0',
				hostname: 'ada-laptop',
				capabilities: ['claude'],
				supportedPhases: [],
			}),
		).toThrow();
	});

	// Issue #687 — the checkout this daemon holds. Carried when known, and the key is
	// left off the body entirely when not, so a daemon whose checkout has no
	// identifiable `origin` sends exactly the request a daemon predating the field does.
	it('carries the declared repository, normalised', () => {
		const request = buildHandshakeRequest({
			credential: CREDENTIAL,
			daemonVersion: '0.1.0',
			hostname: 'ada-laptop',
			capabilities: ['claude'],
			supportedPhases: ALL_TRIGGER_PHASES,
			repository: 'SmartTechBrewery/Swarm.git',
		});
		expect(request.repository).toBe('smarttechbrewery/swarm');
	});

	it('omits the repository key entirely when the checkout could not be identified', () => {
		const request = buildHandshakeRequest({
			credential: CREDENTIAL,
			daemonVersion: '0.1.0',
			hostname: 'ada-laptop',
			capabilities: ['claude'],
			supportedPhases: ALL_TRIGGER_PHASES,
			repository: undefined,
		});
		expect(request).not.toHaveProperty('repository');
	});

	it('rejects an empty capability set (the protocol requires at least one CLI)', () => {
		expect(() =>
			buildHandshakeRequest({
				credential: CREDENTIAL,
				daemonVersion: '0.1.0',
				hostname: 'ada-laptop',
				capabilities: [],
				supportedPhases: ALL_TRIGGER_PHASES,
			}),
		).toThrow();
	});
});

describe('withSessionReclaim', () => {
	const request = buildHandshakeRequest({
		credential: CREDENTIAL,
		daemonVersion: '0.1.0',
		hostname: 'ada-laptop',
		capabilities: ['claude'],
		supportedPhases: ALL_TRIGGER_PHASES,
	});

	it('passes the request through untouched when this daemon holds no lease', () => {
		expect(withSessionReclaim(request, undefined)).toEqual(request);
		expect(withSessionReclaim(request, undefined)).not.toHaveProperty('reclaim');
	});

	it('attaches the held session as the proof of possession', () => {
		const reclaim = { sessionId: SESSION_ID, fencingToken: 4 };
		expect(withSessionReclaim(request, reclaim)).toEqual({ ...request, reclaim });
		// The base request is left alone, so a capability re-probe's rebuild still wins.
		expect(request).not.toHaveProperty('reclaim');
	});
});

describe('buildHeartbeatFrame', () => {
	it('presents the fencing token, omitting health when absent', () => {
		expect(buildHeartbeatFrame(7)).toEqual({ type: 'heartbeat', fencingToken: 7 });
	});

	it('attaches health telemetry when provided', () => {
		expect(buildHeartbeatFrame(7, { cpuLoadPercent: 12 })).toEqual({
			type: 'heartbeat',
			fencingToken: 7,
			health: { cpuLoadPercent: 12 },
		});
	});
});

describe('deriveTransportUrls', () => {
	it('maps an http base to ws for the stream', () => {
		expect(deriveTransportUrls('http://localhost:3100')).toEqual({
			sessionUrl: 'http://localhost:3100/worker/session',
			streamUrl: 'ws://localhost:3100/worker/stream',
		});
	});

	it('maps an https base to wss and tolerates a trailing slash', () => {
		expect(deriveTransportUrls('https://swarm.example.com/')).toEqual({
			sessionUrl: 'https://swarm.example.com/worker/session',
			streamUrl: 'wss://swarm.example.com/worker/stream',
		});
	});

	it('preserves a base path so the router can be mounted under a sub-path', () => {
		expect(deriveTransportUrls('https://host/base')).toEqual({
			sessionUrl: 'https://host/base/worker/session',
			streamUrl: 'wss://host/base/worker/stream',
		});
	});

	it('throws on an unparseable or non-http(s) URL', () => {
		expect(() => deriveTransportUrls('not a url')).toThrow(/not a valid URL/);
		expect(() => deriveTransportUrls('ftp://host')).toThrow(/http\(s\) URL/);
	});
});

describe('heartbeatCadenceMs', () => {
	it('is one third of the TTL, floored at 1s', () => {
		expect(heartbeatCadenceMs(60_000)).toBe(20_000);
		expect(heartbeatCadenceMs(900)).toBe(1_000);
	});
});

describe('computeReconnectDelayMs', () => {
	const cfg = DEFAULT_BACKOFF;

	it('grows exponentially and caps at maxMs (equal-jitter floor with random=0)', () => {
		expect(computeReconnectDelayMs(1, cfg, () => 0)).toBe(500);
		expect(computeReconnectDelayMs(2, cfg, () => 0)).toBe(1_000);
		expect(computeReconnectDelayMs(3, cfg, () => 0)).toBe(2_000);
		// 1000 * 2^5 = 32000, capped to 30000, half = 15000.
		expect(computeReconnectDelayMs(6, cfg, () => 0)).toBe(15_000);
		expect(computeReconnectDelayMs(20, cfg, () => 0)).toBe(15_000);
	});

	it('never exceeds maxMs and stays within the jitter band', () => {
		for (let attempt = 1; attempt <= 12; attempt += 1) {
			const high = computeReconnectDelayMs(attempt, cfg, () => 0.999999);
			const low = computeReconnectDelayMs(attempt, cfg, () => 0);
			expect(high).toBeLessThanOrEqual(cfg.maxMs);
			expect(low).toBeLessThanOrEqual(high);
			expect(low).toBeGreaterThanOrEqual(Math.floor(cfg.baseMs / 2));
		}
	});
});

// Issue #611: the two ladders, and which failure belongs on which. A control plane
// that answers and refuses keeps the ordinary 30s schedule; one that answers nothing
// climbs a separate, lower-capped one, so the wait after an outage is bounded by that
// ceiling rather than by how long the outage lasted.
describe('createReconnectLadders', () => {
	const unanswered = new WorkerTransportUnreachableError('control plane returned HTTP 502');
	const refusal = new WorkerTransportTransientError('control plane returned HTTP 500');

	it('holds the unreachable ladder to its own lower ceiling, jitter floor intact', () => {
		const ladders = createReconnectLadders(DEFAULT_BACKOFF, () => 0);
		const delays = Array.from(
			{ length: 20 },
			() => ladders.forHandshakeFailure(unanswered).delayMs,
		);
		expect(delays.slice(0, 4)).toEqual([500, 1_000, 2_000, 2_500]);
		for (const delayMs of delays) {
			expect(delayMs).toBeLessThanOrEqual(DEFAULT_BACKOFF.unreachableMaxMs);
			// Stampede protection survives the lower cap: no daemon ever retries a
			// recovering control plane at a near-zero delay.
			expect(delayMs).toBeGreaterThanOrEqual(DEFAULT_BACKOFF.baseMs / 2);
		}
		const spread = Array.from({ length: 20 }, (_, i) =>
			createReconnectLadders(DEFAULT_BACKOFF, () => i / 20).forHandshakeFailure(unanswered),
		);
		expect(new Set(spread.map((step) => step.delayMs)).size).toBeGreaterThan(1);
	});

	it('does not let an outage advance the refusal ladder', () => {
		const ladders = createReconnectLadders(DEFAULT_BACKOFF, () => 0);
		for (let i = 0; i < 40; i += 1) ladders.forHandshakeFailure(unanswered);
		// The control plane comes back and refuses: the ordinary ladder is still at its
		// first rung, not at the ceiling a single shared counter would have reached.
		expect(ladders.forHandshakeFailure(refusal)).toEqual({
			attempt: 1,
			delayMs: 500,
			unreachable: false,
		});
	});

	it('keeps the refusal ladder’s existing shape, and clears the unreachable one on any answer', () => {
		const ladders = createReconnectLadders(DEFAULT_BACKOFF, () => 0);
		const refusals = [1, 2, 3].map(() => ladders.forHandshakeFailure(refusal).delayMs);
		expect(refusals).toEqual([500, 1_000, 2_000]);
		// Those answers proved the control plane reachable, so a fresh outage starts at
		// the bottom of the unreachable ladder...
		expect(ladders.forHandshakeFailure(unanswered).delayMs).toBe(500);
		// ...while the refusal ladder carries on from exactly where it was.
		expect(ladders.forHandshakeFailure(refusal).attempt).toBe(4);
	});

	it('steps the ordinary ladder for a lost session, and clears both on a success', () => {
		const ladders = createReconnectLadders(DEFAULT_BACKOFF, () => 0);
		expect(ladders.forSessionLoss()).toEqual({ attempt: 1, delayMs: 500, unreachable: false });
		ladders.forHandshakeFailure(unanswered);
		ladders.reset();
		expect(ladders.forSessionLoss().attempt).toBe(1);
		expect(ladders.forHandshakeFailure(unanswered).attempt).toBe(1);
	});
});

describe('performHandshake', () => {
	function depsWith(fetch: WorkerTransportOverrides['fetch']): WorkerTransportOverrides {
		return {
			fetch,
			createWebSocket: () => ({}) as unknown as TransportSocket,
			random: () => 0,
			logger: silentLogger,
		};
	}

	const request = buildHandshakeRequest({
		credential: CREDENTIAL,
		daemonVersion: '0.1.0',
		hostname: 'ada-laptop',
		capabilities: ['claude'],
		supportedPhases: ALL_TRIGGER_PHASES,
	});

	it('returns the parsed session on 200 and sends the credential only in the body', async () => {
		const fetch = vi.fn().mockResolvedValue(jsonResponse(200, handshakeResponseBody(9)));
		const deps = depsWith(fetch);
		const session = await performHandshake(deps, 'http://cp/worker/session', request);

		expect(session).toEqual(handshakeResponseBody(9));
		const [url, init] = fetch.mock.calls[0];
		expect(url).toBe('http://cp/worker/session');
		expect(init.method).toBe('POST');
		expect(init.headers['content-type']).toBe('application/json');
		expect(init.body).toContain(CREDENTIAL);
	});

	it('maps 401 to a fatal auth error without echoing the credential', async () => {
		const deps = depsWith(vi.fn().mockResolvedValue(jsonResponse(401, { authenticated: false })));
		const err = await performHandshake(deps, 'http://cp/worker/session', request).catch((e) => e);
		expect(err).toBeInstanceOf(WorkerTransportAuthError);
		expect(String((err as Error).message)).not.toContain(CREDENTIAL);
	});

	it('maps 400 to a protocol error', async () => {
		const deps = depsWith(
			vi.fn().mockResolvedValue(jsonResponse(400, { reason: 'unsupported protocol version' })),
		);
		await expect(
			performHandshake(deps, 'http://cp/worker/session', request),
		).rejects.toBeInstanceOf(WorkerTransportProtocolError);
	});

	it('maps a plain 409 to a session conflict', async () => {
		const deps = depsWith(
			vi.fn().mockResolvedValue(jsonResponse(409, { reason: 'worker session already held' })),
		);
		await expect(
			performHandshake(deps, 'http://cp/worker/session', request),
		).rejects.toBeInstanceOf(WorkerSessionConflictError);
	});

	it('maps a 409 carrying offending CLIs to a capability conflict', async () => {
		const deps = depsWith(
			vi
				.fn()
				.mockResolvedValue(
					jsonResponse(409, { reason: 'declared capabilities drop a CLI', offending: ['codex'] }),
				),
		);
		const err = await performHandshake(deps, 'http://cp/worker/session', request).catch((e) => e);
		expect(err).toBeInstanceOf(WorkerCapabilityConflictError);
		expect((err as WorkerCapabilityConflictError).offending).toEqual(['codex']);
		// The control plane's reason is a prefix, not the whole message: it always
		// sends the same CLI-less sentence, and this string is the daemon's fatal
		// log line, so the offending CLI and the next step have to survive it.
		expect((err as Error).message).toContain('declared capabilities drop a CLI');
		expect((err as Error).message).toContain('codex');
		expect((err as Error).message).toContain('SWARM_WORKER_TRANSPORT_CLIS');
	});

	// Issue #611: the transient half splits on whether anything actually answered,
	// because that is what picks the retry ladder.
	it.each([
		502, 503, 504, 522, 530,
	])('maps HTTP %i — an edge answering for an origin that is not there — to unreachable', async (status) => {
		const deps = depsWith(vi.fn().mockResolvedValue(jsonResponse(status, {})));
		const err = await performHandshake(deps, 'http://cp/worker/session', request).catch((e) => e);
		expect(err).toBeInstanceOf(WorkerTransportUnreachableError);
		expect((err as Error).message).toContain(`HTTP ${status}`);
	});

	it('maps a request that never completed to an unreachable failure', async () => {
		const deps = depsWith(vi.fn().mockRejectedValue(new Error('fetch failed')));
		const err = await performHandshake(deps, 'http://cp/worker/session', request).catch((e) => e);
		expect(err).toBeInstanceOf(WorkerTransportUnreachableError);
		expect((err as Error).message).toContain('fetch failed');
	});

	it('leaves a status the control plane generated itself on the ordinary transient class', async () => {
		const deps = depsWith(vi.fn().mockResolvedValue(jsonResponse(500, {})));
		const err = await performHandshake(deps, 'http://cp/worker/session', request).catch((e) => e);
		expect(err).toBeInstanceOf(WorkerTransportTransientError);
		expect(err).not.toBeInstanceOf(WorkerTransportUnreachableError);
	});

	it('treats an unrecognized 200 body as a protocol mismatch', async () => {
		const deps = depsWith(vi.fn().mockResolvedValue(jsonResponse(200, { authenticated: true })));
		await expect(
			performHandshake(deps, 'http://cp/worker/session', request),
		).rejects.toBeInstanceOf(WorkerTransportProtocolError);
	});
});

/** A controllable in-memory socket standing in for the `ws` WebSocket. */
class FakeSocket implements TransportSocket {
	readonly sent: string[] = [];
	closedWith: { code?: number; reason?: string } | undefined;
	private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();

	constructor(
		readonly url: string,
		readonly headers: Record<string, string>,
	) {}

	send(data: string): void {
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		if (this.closedWith) return;
		this.closedWith = { code, reason };
		this.dispatch('close', code ?? 1000, Buffer.from(reason ?? ''));
	}

	on(event: string, listener: (...args: unknown[]) => void): void {
		const existing = this.listeners.get(event) ?? [];
		existing.push(listener);
		this.listeners.set(event, existing);
	}

	private dispatch(event: string, ...args: unknown[]): void {
		for (const listener of this.listeners.get(event) ?? []) listener(...args);
	}

	// Test drivers:
	emitOpen(): void {
		this.dispatch('open');
	}
	emitMessage(frame: unknown): void {
		this.dispatch('message', Buffer.from(JSON.stringify(frame)));
	}
	emitDrop(code = 1006): void {
		this.dispatch('close', code, Buffer.from(''));
	}
}

// Issue #718: the sink lives for the process, so a terminal result produced while the
// socket is down is held and delivered on the next session. Nothing else is queued —
// output is unbounded and best-effort by design.
describe('createAssignmentSink', () => {
	const streamLog: StreamLog = {
		type: 'stream-log',
		dispatchId: DISPATCH_ID,
		runId: RUN_ID,
		lines: [
			{ stream: 'stdout' as const, content: 'building', emittedAt: '2026-08-13T12:13:13.433Z' },
		],
	};
	const progress = {
		type: 'task-progress' as const,
		dispatchId: DISPATCH_ID,
		runId: RUN_ID,
		phase: 'implementation' as const,
		taskId: '718',
		state: 'running' as const,
	};
	const ack = {
		type: 'task-assignment-ack' as const,
		dispatchId: DISPATCH_ID,
		runId: RUN_ID,
		duplicate: false,
	};

	function sent(socket: FakeSocket): unknown[] {
		return socket.sent.map((frame) => JSON.parse(frame));
	}

	it('holds a terminal result with no live session and drops every other frame', () => {
		const logger = recordingLogger();
		const sink = createAssignmentSink(logger);

		sink.send(streamLog);
		sink.send(progress);
		sink.send(ack);
		sink.send(resultFrame());

		const socket = new FakeSocket('ws://cp/worker/stream', {});
		sink.attach(socket);
		// Only the result survived the gap — the three best-effort frames were never queued.
		expect(sent(socket)).toEqual([resultFrame()]);
		expect(
			logger.lines
				.filter((line) => line.message.startsWith('dropping worker frame'))
				.map((line) => line.context?.type),
		).toEqual(['stream-log', 'task-progress', 'task-assignment-ack']);
	});

	it('flushes held results oldest-first and exactly once', () => {
		const sink = createAssignmentSink(silentLogger);
		sink.send(resultFrame({ dispatchId: OTHER_DISPATCH_ID, status: 'failed', error: 'boom' }));
		sink.send(resultFrame());

		const first = new FakeSocket('ws://cp/worker/stream', {});
		sink.attach(first);
		expect(sent(first).map((frame) => (frame as TaskExecutionResult).dispatchId)).toEqual([
			OTHER_DISPATCH_ID,
			DISPATCH_ID,
		]);

		// The worker is at-least-once, not fire-and-forget: what it delivered it does not
		// keep re-sending on every later session.
		sink.detach(first);
		const second = new FakeSocket('ws://cp/worker/stream', {});
		sink.attach(second);
		expect(second.sent).toEqual([]);
	});

	it('preserves a failure’s exit metadata verbatim across the gap', () => {
		const sink = createAssignmentSink(silentLogger);
		const failure = resultFrame({
			status: 'failed',
			error: "Implementation agent (claude) exited with code 1 for task '718'",
			exitCode: 1,
			signal: null,
			timedOut: false,
			failureKind: 'agent',
		});
		sink.send(failure);

		const socket = new FakeSocket('ws://cp/worker/stream', {});
		sink.attach(socket);
		expect(sent(socket)).toEqual([failure]);
	});

	it('treats a throwing write as a non-write: the result is held, the log line is not', () => {
		const sink = createAssignmentSink(silentLogger);
		const broken = new FakeSocket('ws://cp/worker/stream', {});
		broken.send = () => {
			throw new Error('write after end');
		};
		sink.attach(broken);

		sink.send(streamLog);
		sink.send(resultFrame());

		const healthy = new FakeSocket('ws://cp/worker/stream', {});
		sink.detach(broken);
		sink.attach(healthy);
		expect(sent(healthy)).toEqual([resultFrame()]);
	});

	it('stops flushing at the first failed write, keeping the rest held', () => {
		const sink = createAssignmentSink(silentLogger);
		sink.send(resultFrame({ dispatchId: OTHER_DISPATCH_ID }));
		sink.send(resultFrame());

		const failing = new FakeSocket('ws://cp/worker/stream', {});
		let writes = 0;
		failing.send = () => {
			writes += 1;
			if (writes > 1) throw new Error('socket closed mid-flush');
		};
		sink.attach(failing);
		expect(writes).toBe(2);

		sink.detach(failing);
		const healthy = new FakeSocket('ws://cp/worker/stream', {});
		sink.attach(healthy);
		expect(sent(healthy).map((frame) => (frame as TaskExecutionResult).dispatchId)).toEqual([
			DISPATCH_ID,
		]);
	});

	it('does not let a superseded session’s detach unhook the socket that replaced it', () => {
		const sink = createAssignmentSink(silentLogger);
		const stale = new FakeSocket('ws://cp/worker/stream', {});
		const live = new FakeSocket('ws://cp/worker/stream', {});
		sink.attach(stale);
		sink.attach(live);

		sink.detach(stale);
		sink.send(resultFrame());
		expect(sent(live)).toEqual([resultFrame()]);
	});

	it('re-reports a held result through takeUndelivered, then has nothing left to give', () => {
		const sink = createAssignmentSink(silentLogger);
		sink.send(resultFrame());

		const held = sink.takeUndelivered(DISPATCH_ID);
		expect(held).toEqual(resultFrame());
		expect(sink.takeUndelivered(DISPATCH_ID)).toBeUndefined();
		expect(sink.takeUndelivered(OTHER_DISPATCH_ID)).toBeUndefined();
	});

	it('replaces rather than grows the queue when one dispatch reports twice', () => {
		const sink = createAssignmentSink(silentLogger);
		sink.send(resultFrame({ status: 'deferred', retryDelayMs: 1_000 }));
		sink.send(resultFrame());

		const socket = new FakeSocket('ws://cp/worker/stream', {});
		sink.attach(socket);
		expect(sent(socket)).toEqual([resultFrame()]);
	});

	it('bounds the queue, logging the evicted result as an error', () => {
		const logger = recordingLogger();
		const sink = createAssignmentSink(logger);
		for (let i = 0; i <= MAX_UNDELIVERED_RESULTS; i += 1) {
			sink.send(resultFrame({ dispatchId: `dispatch-${i}`, taskId: String(i) }));
		}

		const evictions = logger.lines.filter((line) => line.message.includes('result queue is full'));
		expect(evictions).toHaveLength(1);
		expect(evictions[0].level).toBe('error');
		expect(evictions[0].context).toMatchObject({
			dispatchId: 'dispatch-0',
			runId: RUN_ID,
			phase: 'implementation',
			status: 'succeeded',
		});

		const socket = new FakeSocket('ws://cp/worker/stream', {});
		sink.attach(socket);
		expect(socket.sent).toHaveLength(MAX_UNDELIVERED_RESULTS);
		expect(sink.takeUndelivered('dispatch-0')).toBeUndefined();
	});

	it('seals loudly: what is still held is named, and a later result is not silently kept', () => {
		const logger = recordingLogger();
		const sink = createAssignmentSink(logger);
		sink.send(resultFrame());
		sink.seal();

		const abandoned = logger.lines.filter((line) => line.message.includes('abandoning'));
		expect(abandoned).toHaveLength(1);
		expect(abandoned[0].level).toBe('error');
		expect(abandoned[0].context).toMatchObject({
			dispatchId: DISPATCH_ID,
			runId: RUN_ID,
			phase: 'implementation',
			status: 'succeeded',
		});

		logger.lines.length = 0;
		sink.send(resultFrame({ dispatchId: OTHER_DISPATCH_ID, status: 'failed' }));
		expect(logger.lines.filter((line) => line.level === 'error')).toHaveLength(1);
		expect(sink.takeUndelivered(OTHER_DISPATCH_ID)).toBeUndefined();
	});
});

describe('connectWorkerTransport (reconnect loop)', () => {
	let sockets: FakeSocket[];
	let fetch: ReturnType<typeof vi.fn>;
	let createWebSocket: WorkerTransportOverrides['createWebSocket'];

	const options = {
		controlPlaneUrl: 'http://localhost:3100',
		credential: CREDENTIAL,
		capabilities: ['claude'] as const,
		supportedPhases: ALL_TRIGGER_PHASES,
		hostname: 'ada-laptop',
		daemonVersion: '0.1.0',
	};

	function overrides(): Partial<WorkerTransportOverrides> {
		// random=0 → the equal-jitter floor, a deterministic delay for the schedule.
		return { fetch, createWebSocket, random: () => 0, logger: silentLogger };
	}

	// Flush the microtask queue so the loop advances past awaited fetch/json.
	async function flush(): Promise<void> {
		for (let i = 0; i < 8; i += 1) await Promise.resolve();
	}

	beforeEach(() => {
		vi.useFakeTimers();
		sockets = [];
		fetch = vi.fn();
		createWebSocket = (url, headers) => {
			const socket = new FakeSocket(url, headers);
			sockets.push(socket);
			return socket;
		};
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('handshakes, opens the stream, and sends a heartbeat frame carrying the fencing token', async () => {
		fetch.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await flush();

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0][0]).toBe('http://localhost:3100/worker/session');
		expect(sockets).toHaveLength(1);
		expect(sockets[0].url).toBe('ws://localhost:3100/worker/stream');
		expect(sockets[0].headers.authorization).toBe(`Bearer ${CREDENTIAL}`);
		expect(sockets[0].headers['x-fencing-token']).toBe('4');

		sockets[0].emitOpen();
		expect(JSON.parse(sockets[0].sent[0])).toEqual({ type: 'heartbeat', fencingToken: 4 });

		await client.stop();
		await expect(client.done).resolves.toBeUndefined();
	});

	it('reconnects with backoff after the socket drops, re-acquiring the lease', async () => {
		fetch
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)))
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(5)));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await flush();
		sockets[0].emitOpen();

		// Transport lost: the loop schedules a backoff (attempt 1 → 500ms with random 0).
		sockets[0].emitDrop(1006);
		await flush();
		expect(fetch).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(500);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(sockets).toHaveLength(2);
		expect(sockets[1].headers['x-fencing-token']).toBe('5');

		// Issue #608: the first handshake had nothing to reclaim; the reconnect presents
		// the session it holds, so the control plane recognises its own holder instead of
		// refusing it until the lease TTL lapses.
		expect(JSON.parse(String(fetch.mock.calls[0][1].body))).not.toHaveProperty('reclaim');
		expect(JSON.parse(String(fetch.mock.calls[1][1].body)).reclaim).toEqual({
			sessionId: SESSION_ID,
			fencingToken: 4,
		});

		await client.stop();
	});

	// A 409 that survives the reclaim means the lease really is another daemon's now
	// (it was re-acquired while we were away, so our token no longer matches). The
	// proof is dropped and the next attempt is a plain acquire — still not fatal,
	// because this client had connected.
	it('drops the held proof when the reclaim is refused, then re-acquires fresh', async () => {
		fetch
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)))
			.mockResolvedValueOnce(jsonResponse(409, { reason: 'worker session already held' }))
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(9)));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await flush();
		sockets[0].emitOpen();

		sockets[0].emitDrop(1006);
		await flush();
		await vi.advanceTimersByTimeAsync(500);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetch.mock.calls[1][1].body)).reclaim).toEqual({
			sessionId: SESSION_ID,
			fencingToken: 4,
		});

		await vi.advanceTimersByTimeAsync(1_000);
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(JSON.parse(String(fetch.mock.calls[2][1].body))).not.toHaveProperty('reclaim');
		const instanceIds = fetch.mock.calls.map(
			([, init]) => JSON.parse(String(init.body)).instanceId as string,
		);
		expect(instanceIds[0]).toMatch(/^[0-9a-f-]{36}$/);
		expect(new Set(instanceIds)).toEqual(new Set([instanceIds[0]]));
		expect(sockets).toHaveLength(2);

		await client.stop();
		await expect(client.done).resolves.toBeUndefined();
	});

	// The handshake is the only place a daemon learns the worker id it authenticates
	// as, and the checkout lock records it so a second daemon's refusal can name the
	// holder (issue #689). It fires per session, so a reconnect re-states it.
	it('hands every established session to the daemon’s own bookkeeping', async () => {
		fetch
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)))
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(5)));
		const seen: string[] = [];
		const client = connectWorkerTransport(
			{
				...options,
				capabilities: ['claude'],
				onSession: (session) => seen.push(session.workerId),
			},
			overrides(),
		);
		await flush();
		expect(seen).toEqual([WORKER_ID]);

		sockets[0].emitOpen();
		sockets[0].emitDrop(1006);
		await flush();
		await vi.advanceTimersByTimeAsync(500);
		expect(seen).toEqual([WORKER_ID, WORKER_ID]);

		await client.stop();
	});

	// That handler is bookkeeping, not the connection — a throw from it must not take
	// a healthy session down with it.
	it('keeps the session alive when the session handler throws', async () => {
		fetch.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)));
		const client = connectWorkerTransport(
			{
				...options,
				capabilities: ['claude'],
				onSession: () => {
					throw new Error('checkout lock vanished');
				},
			},
			overrides(),
		);
		await flush();
		expect(sockets).toHaveLength(1);

		await client.stop();
		await expect(client.done).resolves.toBeUndefined();
	});

	it('reconnects when the control plane sends a disconnect control frame', async () => {
		fetch
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)))
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(5)));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await flush();
		sockets[0].emitOpen();

		sockets[0].emitMessage({ type: 'disconnect', reason: 'lease lost' });
		await flush();
		await vi.advanceTimersByTimeAsync(500);
		expect(fetch).toHaveBeenCalledTimes(2);

		await client.stop();
	});

	it('fails fatally when the stream upgrade is rejected (4401 close)', async () => {
		fetch.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		const settled = client.done.catch((e) => e);
		await flush();
		sockets[0].emitOpen();
		sockets[0].emitDrop(WS_CLOSE.UNAUTHORIZED);

		await expect(settled).resolves.toBeInstanceOf(WorkerTransportAuthError);
	});

	it('retries a transient handshake failure then connects', async () => {
		fetch
			.mockResolvedValueOnce(jsonResponse(503, {}))
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await flush();
		expect(sockets).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(500);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(sockets).toHaveLength(1);

		await client.stop();
	});

	// Issue #611's acceptance criterion, pinned end to end: what a worker waits once
	// the control plane is reachable again must not scale with how long it was
	// unreachable. A single shared counter put a two-minute outage at the 30s ceiling,
	// so the daemon idled there after the router was already serving.
	it('pins the post-outage reconnect to the unreachable cap, however long the outage lasted', async () => {
		const TICK_MS = 100;
		const GIVE_UP_MS = 120_000;

		/** Advance the fake clock in small ticks until one more handshake is attempted. */
		async function tickUntilAttempt(mock: ReturnType<typeof vi.fn>): Promise<number> {
			const before = mock.mock.calls.length;
			let elapsedMs = 0;
			while (mock.mock.calls.length === before && elapsedMs < GIVE_UP_MS) {
				await vi.advanceTimersByTimeAsync(TICK_MS);
				elapsedMs += TICK_MS;
			}
			return elapsedMs;
		}

		/**
		 * Run a daemon through an outage of `outageMs` — an edge answering 502 for an
		 * origin that is not there — and report the gap the ladder has reached by then
		 * (the delay a returning control plane finds it sitting in) plus how long it
		 * actually idles once the control plane starts serving.
		 */
		async function outageProbe(
			outageMs: number,
		): Promise<{ retryGapMs: number; idleAfterRecoveryMs: number }> {
			const seen: FakeSocket[] = [];
			const outageFetch = vi.fn().mockResolvedValue(jsonResponse(502, {}));
			const client = connectWorkerTransport(
				{ ...options, capabilities: ['claude'] },
				{
					fetch: outageFetch,
					createWebSocket: (url, headers) => {
						const socket = new FakeSocket(url, headers);
						seen.push(socket);
						return socket;
					},
					random: () => 0,
					logger: silentLogger,
				},
			);
			await flush();
			await vi.advanceTimersByTimeAsync(outageMs);

			// Land on an attempt, then time the whole cycle that follows it.
			await tickUntilAttempt(outageFetch);
			const retryGapMs = await tickUntilAttempt(outageFetch);

			// The router comes back while the daemon sits in the delay it just scheduled.
			// That delay is the whole of the idle gap this issue is about.
			outageFetch.mockResolvedValue(jsonResponse(200, handshakeResponseBody(4)));
			let idleAfterRecoveryMs = 0;
			while (seen.length === 0 && idleAfterRecoveryMs < GIVE_UP_MS) {
				await vi.advanceTimersByTimeAsync(TICK_MS);
				idleAfterRecoveryMs += TICK_MS;
			}
			await client.stop();
			return { retryGapMs, idleAfterRecoveryMs };
		}

		const brief = await outageProbe(3_000);
		const long = await outageProbe(600_000);

		// The ladder stopped growing: a two-hundred-times-longer outage leaves exactly the
		// same delay scheduled. Under one shared counter these differed by ~4x.
		expect(long.retryGapMs).toBe(brief.retryGapMs);
		// ...and that delay — the whole of the post-outage idle — is held to the low cap.
		expect(long.retryGapMs).toBeLessThanOrEqual(DEFAULT_BACKOFF.unreachableMaxMs);
		// ...while the equal-jitter floor keeps it above half the cap, so a fleet still
		// spreads its retries instead of stampeding a control plane that has just come up.
		expect(long.retryGapMs).toBeGreaterThanOrEqual(DEFAULT_BACKOFF.unreachableMaxMs / 2);
		for (const probe of [brief, long]) {
			expect(probe.idleAfterRecoveryMs).toBeLessThanOrEqual(DEFAULT_BACKOFF.unreachableMaxMs);
		}
	});

	// The other half of the criterion: a refusal the control plane *answers* is
	// untouched by the outage that preceded it.
	it('starts the ordinary ladder at its first rung when a long outage ends in a refusal', async () => {
		// Down, then answering exactly one refusal it generated itself, then healthy.
		let stage: 'outage' | 'refusing' | 'healthy' = 'outage';
		fetch.mockImplementation(async () => {
			if (stage === 'outage') return jsonResponse(502, {});
			if (stage === 'refusing') {
				stage = 'healthy';
				return jsonResponse(500, {});
			}
			return jsonResponse(200, handshakeResponseBody(4));
		});
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await flush();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sockets).toHaveLength(0);

		// The control plane starts answering. The daemon reaches it within the unreachable
		// ceiling rather than after a wait the two-minute outage earned.
		stage = 'refusing';
		const beforeRefusal = fetch.mock.calls.length;
		let waitedMs = 0;
		while (fetch.mock.calls.length === beforeRefusal && waitedMs < 120_000) {
			await vi.advanceTimersByTimeAsync(100);
			waitedMs += 100;
		}
		expect(waitedMs).toBeLessThanOrEqual(DEFAULT_BACKOFF.unreachableMaxMs);

		// That answer was a refusal, so it steps the *ordinary* ladder — from its first
		// rung (500ms with random 0), because the outage never touched it. A single shared
		// counter would have been sitting at the 30s ceiling here.
		await vi.advanceTimersByTimeAsync(499);
		expect(sockets).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(sockets).toHaveLength(1);

		await client.stop();
	});

	it('fails fatally on a bad credential at the first handshake', async () => {
		fetch.mockResolvedValueOnce(jsonResponse(401, { authenticated: false }));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await expect(client.done).rejects.toBeInstanceOf(WorkerTransportAuthError);
		expect(sockets).toHaveLength(0);
	});

	it('fails fatally when a session is already held on the first connect', async () => {
		fetch.mockResolvedValueOnce(jsonResponse(409, { reason: 'worker session already held' }));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await expect(client.done).rejects.toBeInstanceOf(WorkerSessionConflictError);
	});

	// Issue #559: a PATH probe that misses an installed CLI declares a set the
	// control plane rejects, and that rejection used to kill the daemon outright.
	// The loop re-probes first and only gives up when the fresh probe agrees.
	it('re-probes and re-declares after a capability rejection, then connects', async () => {
		fetch
			.mockResolvedValueOnce(jsonResponse(409, { reason: 'needs codex', offending: ['codex'] }))
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)));
		const refreshCapabilities = vi
			.fn<() => Promise<AgentCli[]>>()
			.mockResolvedValue(['claude', 'codex']);
		const client = connectWorkerTransport(
			{
				...options,
				capabilities: ['claude'],
				repository: 'smarttechbrewery/swarm',
				refreshCapabilities,
			},
			overrides(),
		);
		await flush();
		expect(refreshCapabilities).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(500);
		expect(fetch).toHaveBeenCalledTimes(2);
		const rebuilt = JSON.parse(String(fetch.mock.calls[1][1].body));
		expect(rebuilt.capabilities).toEqual(['claude', 'codex']);
		// The re-probe rebuilds the request from `options`, so the checkout declaration
		// survives it rather than being dropped on the reconnect (issue #687).
		expect(rebuilt.repository).toBe('smarttechbrewery/swarm');
		expect(sockets).toHaveLength(1);

		await client.stop();
	});

	it('fails fatally when the re-probe agrees the required CLI is not there', async () => {
		fetch.mockResolvedValue(jsonResponse(409, { offending: ['codex'] }));
		const refreshCapabilities = vi.fn<() => Promise<AgentCli[]>>().mockResolvedValue(['claude']);
		const client = connectWorkerTransport(
			{ ...options, capabilities: ['claude'], refreshCapabilities },
			overrides(),
		);
		await expect(client.done).rejects.toBeInstanceOf(WorkerCapabilityConflictError);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('fails fatally on a capability rejection when the set was declared explicitly', async () => {
		fetch.mockResolvedValue(jsonResponse(409, { offending: ['codex'] }));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await expect(client.done).rejects.toBeInstanceOf(WorkerCapabilityConflictError);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('stops re-probing a flapping PATH after the bounded number of attempts', async () => {
		fetch.mockResolvedValue(jsonResponse(409, { offending: ['codex', 'antigravity'] }));
		const refreshCapabilities = vi
			.fn<() => Promise<AgentCli[]>>()
			.mockResolvedValueOnce(['claude', 'codex'])
			.mockResolvedValueOnce(['claude', 'antigravity'])
			.mockResolvedValue(['claude', 'codex', 'antigravity']);
		const client = connectWorkerTransport(
			{ ...options, capabilities: ['claude'], refreshCapabilities },
			overrides(),
		);
		const settled = client.done.catch((e) => e);
		await flush();
		await vi.advanceTimersByTimeAsync(500);
		await flush();
		await vi.advanceTimersByTimeAsync(1_000);

		await expect(settled).resolves.toBeInstanceOf(WorkerCapabilityConflictError);
		expect(refreshCapabilities).toHaveBeenCalledTimes(2);
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	// Issue #549: the control plane delivers a user termination as a pushed frame,
	// because a DB-free daemon has no Redis to read the durable marker from.
	it('hands a task-cancel frame and the sink to the registered onCancel handler', async () => {
		fetch.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)));
		const onCancel = vi.fn();
		const client = connectWorkerTransport(
			{ ...options, capabilities: ['claude'], onCancel },
			overrides(),
		);
		await flush();
		sockets[0].emitOpen();

		sockets[0].emitMessage({
			type: 'task-cancel',
			dispatchId: DISPATCH_ID,
			runId: RUN_ID,
			reason: 'a cancellation was requested for this run',
			phase: 'implementation',
			taskId: '718',
		});

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onCancel).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'task-cancel',
				dispatchId: DISPATCH_ID,
				runId: RUN_ID,
				phase: 'implementation',
				taskId: '718',
			}),
			// The sink is what lets the handler *answer* a cancel it cannot apply
			// (issue #724).
			expect.objectContaining({ send: expect.any(Function) }),
		);
		await client.stop();
	});

	// Issue #724: a Terminate arriving after the phase actually finished must settle
	// the run on its true outcome, not on a synthetic cancellation.
	it('answers a task-cancel with the real result it still holds, without calling onCancel', async () => {
		fetch.mockResolvedValue(jsonResponse(200, handshakeResponseBody(4)));
		const onCancel = vi.fn();
		let sink: AssignmentSink | undefined;
		const client = connectWorkerTransport(
			{
				...options,
				capabilities: ['claude'],
				onCancel,
				onAssignment: (_assignment, assignmentSink) => {
					sink = assignmentSink;
				},
			},
			overrides(),
		);
		await flush();
		sockets[0].emitOpen();
		sockets[0].emitMessage(ASSIGNMENT_FRAME);

		// The peer is gone but the socket has not closed yet, so the write throws and the
		// succeeded result is held rather than counted as delivered.
		sockets[0].send = () => {
			throw new Error('write after end');
		};
		sink?.send(resultFrame());

		const written: unknown[] = [];
		sockets[0].send = (data: string) => {
			written.push(JSON.parse(data));
		};
		sockets[0].emitMessage({
			type: 'task-cancel',
			dispatchId: DISPATCH_ID,
			runId: RUN_ID,
			phase: 'implementation',
			taskId: '718',
		});

		expect(written).toEqual([resultFrame()]);
		expect(onCancel).not.toHaveBeenCalled();

		await client.stop();
	});

	it('ignores a task-cancel when no handler is registered, keeping the session live', async () => {
		fetch.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await flush();
		sockets[0].emitOpen();

		sockets[0].emitMessage({ type: 'task-cancel', dispatchId: DISPATCH_ID });
		await flush();

		expect(sockets[0].closedWith).toBeUndefined();
		expect(fetch).toHaveBeenCalledTimes(1);
		await client.stop();
	});

	// What keeps a new cloud→worker frame additive (no `TRANSPORT_PROTOCOL_VERSION`
	// bump): a daemon that predates one must ignore it, not drop its session.
	it('ignores an unrecognized control frame instead of ending the session', async () => {
		fetch.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await flush();
		sockets[0].emitOpen();

		sockets[0].emitMessage({ type: 'task-pause', dispatchId: DISPATCH_ID });
		sockets[0].emitMessage('not json at all');
		await flush();

		expect(sockets[0].closedWith).toBeUndefined();
		// No reconnect was scheduled — the session is untouched.
		await vi.advanceTimersByTimeAsync(5_000);
		expect(fetch).toHaveBeenCalledTimes(1);
		await client.stop();
	});

	// Issue #718, the incident in miniature: a phase finished while the socket was down
	// and its terminal result was dropped, so a succeeded run settled ~30 minutes later
	// as "did not report a result within the lease window". It now rides the next session.
	it('delivers a result produced while the session was down on the next session', async () => {
		fetch
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)))
			.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(5)));
		let sink: AssignmentSink | undefined;
		const onAssignment = vi.fn((_assignment: unknown, assignmentSink: AssignmentSink) => {
			sink = assignmentSink;
		});
		const client = connectWorkerTransport(
			{ ...options, capabilities: ['claude'], onAssignment },
			overrides(),
		);
		await flush();
		sockets[0].emitOpen();
		sockets[0].emitMessage(ASSIGNMENT_FRAME);
		expect(onAssignment).toHaveBeenCalledTimes(1);

		// The 1.1-second blip. The phase runs on, independent of the heartbeat loop.
		sockets[0].emitDrop(1006);
		await flush();
		const failure = resultFrame({
			status: 'failed',
			error: "Implementation agent (claude) exited with code 1 for task '718'",
			exitCode: 1,
			signal: null,
			failureKind: 'agent',
		});
		sink?.send(failure);
		// Nothing was written into the dead socket — only its own first heartbeat is there.
		expect(sockets[0].sent).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(500);
		expect(sockets).toHaveLength(2);
		sockets[1].emitOpen();
		// Lease first, backlog second — and the exit metadata survives verbatim, so the
		// control plane settles on the real outcome rather than inventing one.
		expect(sockets[1].sent.map((frame) => JSON.parse(frame))).toEqual([
			{ type: 'heartbeat', fencingToken: 5 },
			failure,
		]);

		await client.stop();
	});

	it('answers a re-pushed assignment with a held result instead of re-running the phase', async () => {
		fetch.mockResolvedValue(jsonResponse(200, handshakeResponseBody(4)));
		let sink: AssignmentSink | undefined;
		const onAssignment = vi.fn((_assignment: unknown, assignmentSink: AssignmentSink) => {
			sink = assignmentSink;
		});
		const client = connectWorkerTransport(
			{ ...options, capabilities: ['claude'], onAssignment },
			overrides(),
		);
		await flush();
		sockets[0].emitOpen();
		sockets[0].emitMessage(ASSIGNMENT_FRAME);
		expect(onAssignment).toHaveBeenCalledTimes(1);

		// The peer is gone but the socket has not closed yet, so the write throws and the
		// result is held rather than counted as delivered.
		sockets[0].send = () => {
			throw new Error('write after end');
		};
		sink?.send(resultFrame());

		const written: unknown[] = [];
		sockets[0].send = (data: string) => {
			written.push(JSON.parse(data));
		};
		sockets[0].emitMessage(ASSIGNMENT_FRAME);
		// The outcome this daemon already has is re-reported; the phase is not re-run.
		expect(onAssignment).toHaveBeenCalledTimes(1);
		expect(written).toEqual([resultFrame()]);

		await client.stop();
	});

	// The other half: once the result has been written, a re-push is the control plane's
	// own re-dispatch decision and must run rather than answer with the stale outcome.
	it('runs a re-pushed assignment normally once the result has been delivered', async () => {
		fetch.mockResolvedValue(jsonResponse(200, handshakeResponseBody(4)));
		let sink: AssignmentSink | undefined;
		const onAssignment = vi.fn((_assignment: unknown, assignmentSink: AssignmentSink) => {
			sink = assignmentSink;
		});
		const client = connectWorkerTransport(
			{ ...options, capabilities: ['claude'], onAssignment },
			overrides(),
		);
		await flush();
		sockets[0].emitOpen();
		sockets[0].emitMessage(ASSIGNMENT_FRAME);
		sink?.send(resultFrame());

		sockets[0].emitMessage(ASSIGNMENT_FRAME);
		expect(onAssignment).toHaveBeenCalledTimes(2);

		await client.stop();
	});

	it('reports at error level a result still held when the client stops', async () => {
		const logger = recordingLogger();
		fetch.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)));
		let sink: AssignmentSink | undefined;
		const client = connectWorkerTransport(
			{
				...options,
				capabilities: ['claude'],
				onAssignment: (_assignment, assignmentSink) => {
					sink = assignmentSink;
				},
			},
			{ ...overrides(), logger },
		);
		await flush();
		sockets[0].emitOpen();
		sockets[0].emitMessage(ASSIGNMENT_FRAME);
		sockets[0].emitDrop(1006);
		await flush();
		sink?.send(resultFrame());

		await client.stop();
		await expect(client.done).resolves.toBeUndefined();
		const abandoned = logger.lines.filter((line) => line.message.includes('abandoning'));
		expect(abandoned).toHaveLength(1);
		expect(abandoned[0].level).toBe('error');
		expect(abandoned[0].context).toMatchObject({
			dispatchId: DISPATCH_ID,
			runId: RUN_ID,
			phase: 'implementation',
			status: 'succeeded',
		});
	});

	it('stop() closes the live socket gracefully so the lease is released promptly', async () => {
		fetch.mockResolvedValueOnce(jsonResponse(200, handshakeResponseBody(4)));
		const client = connectWorkerTransport({ ...options, capabilities: ['claude'] }, overrides());
		await flush();
		sockets[0].emitOpen();

		await client.stop();
		expect(sockets[0].closedWith?.code).toBe(1000);
		await expect(client.done).resolves.toBeUndefined();
	});
});

describe('worker transport client module boundary', () => {
	it('imports nothing from the DB, queue, or dispatch layers', () => {
		const files = ['worker-client.ts', 'cli-discovery.ts', 'connect-entry.ts'];
		for (const file of files) {
			const source = readFileSync(
				fileURLToPath(new URL(`../../../src/transport/${file}`, import.meta.url)),
				'utf8',
			);
			const importSpecifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
			for (const specifier of importSpecifiers) {
				expect(specifier).not.toMatch(/\/db\/|\/queue\/|\/dispatch\/|bullmq|ioredis|drizzle/);
			}
		}
	});
});
