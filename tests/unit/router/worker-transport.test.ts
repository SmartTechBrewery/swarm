import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Worker } from '@/identity/worker.js';
import { WorkerCapabilityReductionError } from '@/identity/worker.js';
import type { AcquiredSession } from '@/identity/worker-session-service.js';
import { WorkerSessionHeldError } from '@/identity/worker-session-service.js';
import { logger } from '@/lib/logger.js';
import { isWorkerConnected, sendToWorker } from '@/router/worker-connections.js';
import {
	handleHandshake,
	handleWorkerStreamFrame,
	registerWorkerTransport,
	type WorkerTransportDeps,
	WS_CLOSE,
} from '@/router/worker-transport.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CREDENTIAL = 'raw-worker-credential-secret';

function makeWorker(overrides: Partial<Worker> = {}): Worker {
	return {
		id: WORKER_ID,
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude'],
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

function makeAcquired(overrides: Partial<AcquiredSession['session']> = {}): AcquiredSession {
	return {
		session: {
			id: SESSION_ID,
			workerId: WORKER_ID,
			fencingToken: 7,
			lastHeartbeatAt: new Date('2026-01-01T00:00:00Z'),
			currentRunId: null,
			createdAt: new Date('2026-01-01T00:00:00Z'),
			...overrides,
		},
		fencingToken: 7,
	};
}

function makeDeps(overrides: Partial<WorkerTransportDeps> = {}): WorkerTransportDeps {
	return {
		resolveWorkerByCredential: vi.fn().mockResolvedValue(makeWorker()),
		acquireSession: vi.fn().mockResolvedValue(makeAcquired()),
		heartbeat: vi.fn().mockResolvedValue(true),
		releaseSession: vi.fn().mockResolvedValue(true),
		refreshWorkerCapabilities: vi.fn().mockResolvedValue(makeWorker()),
		resolveHeartbeatTtlMs: vi.fn().mockReturnValue(60_000),
		validateFencingToken: vi.fn().mockResolvedValue(true),
		deliverDispatchResult: vi.fn().mockReturnValue(true),
		deliverDispatchProgress: vi.fn(),
		deliverDispatchAck: vi.fn(),
		...overrides,
	};
}

function validBody() {
	return {
		credential: CREDENTIAL,
		daemonVersion: '1.0.0',
		hostname: 'ada-laptop',
		capabilities: ['claude'],
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
	};
}

describe('handleHandshake', () => {
	beforeEach(() => vi.clearAllMocks());

	it('acquires the session and returns its fields on a valid handshake', async () => {
		const deps = makeDeps();
		const result = await handleHandshake(deps, validBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({
			authenticated: true,
			workerId: WORKER_ID,
			sessionId: SESSION_ID,
			fencingToken: 7,
			heartbeatTtlMs: 60_000,
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
		expect(deps.acquireSession).toHaveBeenCalledWith(CREDENTIAL, 60_000);
		expect(deps.refreshWorkerCapabilities).toHaveBeenCalledWith(WORKER_ID, ['claude']);
	});

	it('rejects a malformed body with 400', async () => {
		const deps = makeDeps();
		const result = await handleHandshake(deps, { credential: CREDENTIAL });
		expect(result.status).toBe(400);
		expect(deps.acquireSession).not.toHaveBeenCalled();
	});

	it('rejects an unsupported protocol version with 400', async () => {
		const deps = makeDeps();
		const result = await handleHandshake(deps, {
			...validBody(),
			protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1,
		});
		expect(result.status).toBe(400);
		expect(deps.resolveWorkerByCredential).not.toHaveBeenCalled();
	});

	it('rejects an unknown credential with 401 and never echoes the credential', async () => {
		const deps = makeDeps({ resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined) });
		const result = await handleHandshake(deps, validBody());

		expect(result.status).toBe(401);
		expect(result.json).toEqual({ authenticated: false });
		expect(JSON.stringify(result.json)).not.toContain(CREDENTIAL);
		expect(deps.acquireSession).not.toHaveBeenCalled();
	});

	it('maps a held session to 409', async () => {
		const deps = makeDeps({
			acquireSession: vi.fn().mockRejectedValue(new WorkerSessionHeldError(WORKER_ID)),
		});
		const result = await handleHandshake(deps, validBody());
		expect(result.status).toBe(409);
		expect(deps.refreshWorkerCapabilities).not.toHaveBeenCalled();
	});

	it('maps a capability reduction to 409, releases the lease, and reports the offending CLIs', async () => {
		const deps = makeDeps({
			refreshWorkerCapabilities: vi
				.fn()
				.mockRejectedValue(new WorkerCapabilityReductionError(WORKER_ID, ['codex'])),
		});
		const result = await handleHandshake(deps, validBody());

		expect(result.status).toBe(409);
		expect(result.json.offending).toEqual(['codex']);
		// The just-acquired lease is freed so a corrected retry isn't blocked.
		expect(deps.releaseSession).toHaveBeenCalledWith(CREDENTIAL, 7);
	});
});

describe('handleWorkerStreamFrame', () => {
	beforeEach(() => vi.clearAllMocks());

	const ctx = { credential: CREDENTIAL, ttlMs: 60_000, fencingToken: 7 };

	it('refreshes the lease and acks a valid heartbeat', async () => {
		const deps = makeDeps();
		const action = await handleWorkerStreamFrame(
			deps,
			ctx,
			JSON.stringify({ type: 'heartbeat', fencingToken: 7 }),
		);

		expect(action).toEqual({
			action: 'ack',
			fencingToken: 7,
			message: { type: 'heartbeat-ack' },
		});
		expect(deps.heartbeat).toHaveBeenCalledWith(CREDENTIAL, 7, 60_000);
	});

	it('disconnects (4408) when the lease can no longer be refreshed', async () => {
		const deps = makeDeps({ heartbeat: vi.fn().mockResolvedValue(false) });
		const action = await handleWorkerStreamFrame(
			deps,
			ctx,
			JSON.stringify({ type: 'heartbeat', fencingToken: 7 }),
		);

		expect(action.action).toBe('disconnect');
		if (action.action === 'disconnect') {
			expect(action.code).toBe(WS_CLOSE.LEASE_LOST);
			expect(action.message.type).toBe('disconnect');
			expect(action.fencingToken).toBe(7);
		}
	});

	it('closes (4400) on a frame that is not valid JSON', async () => {
		const deps = makeDeps();
		const action = await handleWorkerStreamFrame(deps, ctx, 'not json');
		expect(action).toEqual({
			action: 'close',
			code: WS_CLOSE.MALFORMED_FRAME,
			reason: 'malformed frame',
		});
		expect(deps.heartbeat).not.toHaveBeenCalled();
	});

	it('closes (4400) on a frame whose shape is unknown', async () => {
		const deps = makeDeps();
		const action = await handleWorkerStreamFrame(
			deps,
			ctx,
			JSON.stringify({ type: 'heartbeat-ack' }),
		);
		expect(action.action).toBe('close');
		expect(deps.heartbeat).not.toHaveBeenCalled();
	});

	// Split delivery (issue #407): the back-channel frames are routed to the
	// control-plane dispatcher and keep the socket open (never touch the lease).
	const DISPATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

	it('routes a task-execution-result to the dispatcher and keeps the socket open', async () => {
		const deps = makeDeps();
		const action = await handleWorkerStreamFrame(
			deps,
			ctx,
			JSON.stringify({
				type: 'task-execution-result',
				dispatchId: DISPATCH,
				status: 'succeeded',
				phase: 'implementation',
				taskId: '407',
				exitCode: 0,
			}),
		);
		expect(action).toEqual({ action: 'ignore' });
		expect(deps.deliverDispatchResult).toHaveBeenCalledWith(
			expect.objectContaining({ dispatchId: DISPATCH, status: 'succeeded' }),
		);
		expect(deps.heartbeat).not.toHaveBeenCalled();
	});

	it('routes progress and ack frames to the dispatcher without closing', async () => {
		const deps = makeDeps();
		const progress = await handleWorkerStreamFrame(
			deps,
			ctx,
			JSON.stringify({
				type: 'task-progress',
				dispatchId: DISPATCH,
				phase: 'implementation',
				taskId: '407',
				state: 'branch-provisioned',
			}),
		);
		const ack = await handleWorkerStreamFrame(
			deps,
			ctx,
			JSON.stringify({ type: 'task-assignment-ack', dispatchId: DISPATCH, duplicate: false }),
		);
		expect(progress).toEqual({ action: 'ignore' });
		expect(ack).toEqual({ action: 'ignore' });
		expect(deps.deliverDispatchProgress).toHaveBeenCalledWith(
			expect.objectContaining({ state: 'branch-provisioned' }),
		);
		expect(deps.deliverDispatchAck).toHaveBeenCalledWith(
			expect.objectContaining({ dispatchId: DISPATCH }),
		);
	});

	it('ignores a stream-log without persisting it here (same-host worker owns output)', async () => {
		const deps = makeDeps();
		const action = await handleWorkerStreamFrame(
			deps,
			ctx,
			JSON.stringify({
				type: 'stream-log',
				dispatchId: DISPATCH,
				lines: [{ stream: 'stdout', content: 'hi\n', emittedAt: '2026-07-24T00:00:00Z' }],
			}),
		);
		expect(action).toEqual({ action: 'ignore' });
		expect(deps.deliverDispatchResult).not.toHaveBeenCalled();
	});
});

/**
 * A no-op `upgradeWebSocket` stub: the HTTP-path tests exercise only
 * `POST /worker/session`, so the WebSocket route never needs a real upgrade.
 */
function fakeUpgradeWebSocket() {
	return ((_createEvents: unknown) => async (_c: unknown, next: () => Promise<void>) => {
		await next();
	}) as unknown as Parameters<typeof registerWorkerTransport>[1];
}

describe('POST /worker/session route', () => {
	beforeEach(() => vi.clearAllMocks());

	function makeApp(overrides: Partial<WorkerTransportDeps> = {}) {
		const deps = makeDeps(overrides);
		const app = new Hono();
		registerWorkerTransport(app, fakeUpgradeWebSocket(), deps);
		return { app, deps };
	}

	function post(app: Hono, body: string) {
		return app.request('/worker/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		});
	}

	it('returns 200 with the session on a valid handshake', async () => {
		const { app } = makeApp();
		const res = await post(app, JSON.stringify(validBody()));
		expect(res.status).toBe(200);
		const json = await res.json();
		expect(json).toMatchObject({ authenticated: true, workerId: WORKER_ID, sessionId: SESSION_ID });
	});

	it('returns 400 on a non-JSON body', async () => {
		const { app, deps } = makeApp();
		const res = await post(app, 'not json');
		expect(res.status).toBe(400);
		expect(deps.acquireSession).not.toHaveBeenCalled();
	});

	it('returns 401 and never leaks the credential on an unknown credential', async () => {
		const { app } = makeApp({ resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined) });
		const res = await post(app, JSON.stringify(validBody()));
		expect(res.status).toBe(401);
		expect(await res.text()).not.toContain(CREDENTIAL);
	});
});

/** The adapter-facing stream handlers returned by the upgrade event factory. */
interface StreamHandlers {
	onOpen?: (evt: unknown, ws: WSContext) => void;
	onMessage: (evt: { data: unknown }, ws: WSContext) => void | Promise<void>;
	onClose?: (evt: unknown, ws: WSContext) => void | Promise<void>;
	onError?: (evt: unknown, ws: WSContext) => void;
}

/**
 * Capture the async WebSocket event factory `registerWorkerTransport` hands to
 * `upgradeWebSocket` and run it with a fake context, returning the adapter-facing
 * handlers. This drives the real `onMessage` glue — the void callback the
 * `@hono/node-ws` adapter invokes without awaiting or catching — rather than only
 * the pure `handleWorkerStreamFrame`, so the "no rejected promise escapes" safety
 * property can be asserted.
 */
async function openStream(
	deps: WorkerTransportDeps,
	headers: { authorization?: string; fencingToken?: string },
): Promise<StreamHandlers> {
	let factory: ((c: unknown) => Promise<StreamHandlers>) | undefined;
	const upgrade = ((f: (c: unknown) => Promise<StreamHandlers>) => {
		factory = f;
		return async () => {};
	}) as unknown as Parameters<typeof registerWorkerTransport>[1];
	registerWorkerTransport(new Hono(), upgrade, deps);
	if (!factory) throw new Error('worker-transport did not register a stream event factory');
	const c = {
		req: {
			header: (name: string) =>
				name === 'authorization'
					? headers.authorization
					: name === 'x-fencing-token'
						? headers.fencingToken
						: undefined,
		},
	};
	return factory(c);
}

function fakeWs() {
	// `readyState: 1` is the WebSocket OPEN state, so the connection registry treats
	// this fake as a live socket (`sendToWorker`/`isWorkerConnected`).
	return { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as WSContext & {
		send: ReturnType<typeof vi.fn>;
		close: ReturnType<typeof vi.fn>;
		readyState: number;
	};
}

describe('GET /worker/stream onMessage (adapter handler)', () => {
	beforeEach(() => vi.clearAllMocks());

	it('swallows a rejected heartbeat dependency and closes 4408 without an unhandled rejection', async () => {
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		// Authenticated upgrade (valid worker + bound fencing token), then the
		// heartbeat dependency rejects mid-frame — a transient session-store fault.
		const deps = makeDeps({ heartbeat: vi.fn().mockRejectedValue(new Error('boom')) });
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});
		const ws = fakeWs();
		const evt = { data: JSON.stringify({ type: 'heartbeat', fencingToken: 7 }) };

		// The adapter runs onMessage as an un-awaited void callback, so the required
		// property is that it settles rather than leaking a rejected promise.
		await expect(handlers.onMessage(evt, ws)).resolves.toBeUndefined();

		expect(deps.heartbeat).toHaveBeenCalledWith(CREDENTIAL, 7, 60_000);
		expect(ws.close).toHaveBeenCalledWith(WS_CLOSE.LEASE_LOST, 'heartbeat processing failed');
		expect(ws.send).not.toHaveBeenCalled();
		expect(errorSpy).toHaveBeenCalled();

		errorSpy.mockRestore();
	});
});

describe('GET /worker/stream connected-worker registry lifecycle', () => {
	beforeEach(() => vi.clearAllMocks());

	it('registers an authenticated socket on open and deregisters on close', async () => {
		const deps = makeDeps();
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});
		const ws = fakeWs();

		handlers.onOpen?.({}, ws);

		// The authenticated open makes the worker reachable, and the push primitive
		// lands on exactly this socket.
		expect(isWorkerConnected(WORKER_ID)).toBe(true);
		expect(ws.close).not.toHaveBeenCalled();
		expect(sendToWorker(WORKER_ID, { type: 'heartbeat-ack' })).toBe(true);
		expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'heartbeat-ack' }));

		await handlers.onClose?.({}, ws);

		// The close removes it from the registry (and still frees the lease).
		expect(isWorkerConnected(WORKER_ID)).toBe(false);
		expect(deps.releaseSession).toHaveBeenCalledWith(CREDENTIAL, 7);
	});

	it('registers nothing for an unauthenticated open', async () => {
		const deps = makeDeps({ resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined) });
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});
		const ws = fakeWs();

		handlers.onOpen?.({}, ws);

		expect(ws.close).toHaveBeenCalledWith(WS_CLOSE.UNAUTHORIZED, 'unauthorized');
		expect(isWorkerConnected(WORKER_ID)).toBe(false);
		expect(sendToWorker(WORKER_ID, { type: 'heartbeat-ack' })).toBe(false);
	});
});
