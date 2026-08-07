import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCli } from '@/harness/agent-cli.js';
import { SUPPORTED_DB_FREE_PHASES } from '@/transport/assignment-execution.js';
import { type TaskPhase, TRANSPORT_PROTOCOL_VERSION, WS_CLOSE } from '@/transport/protocol.js';
import {
	buildHandshakeRequest,
	buildHeartbeatFrame,
	computeReconnectDelayMs,
	connectWorkerTransport,
	DEFAULT_BACKOFF,
	deriveTransportUrls,
	type FetchResponse,
	heartbeatCadenceMs,
	performHandshake,
	type TransportSocket,
	WorkerCapabilityConflictError,
	WorkerSessionConflictError,
	WorkerTransportAuthError,
	type WorkerTransportOverrides,
	WorkerTransportProtocolError,
} from '@/transport/worker-client.js';
import { ALL_TRIGGER_PHASES } from '@/triggers/types.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CREDENTIAL = 'raw-worker-credential-secret';

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

		await client.stop();
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
			{ ...options, capabilities: ['claude'], refreshCapabilities },
			overrides(),
		);
		await flush();
		expect(refreshCapabilities).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(500);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(JSON.parse(String(fetch.mock.calls[1][1].body)).capabilities).toEqual([
			'claude',
			'codex',
		]);
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
