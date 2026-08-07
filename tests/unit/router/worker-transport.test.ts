import { Hono } from 'hono';
import type { WSContext } from 'hono/ws';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DEFAULT_WORKER_SUPPORTED_PHASES,
	type Worker,
	WorkerCapabilityReductionError,
} from '@/identity/worker.js';
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
import type { TriggerPhase } from '@/triggers/types.js';

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
		supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
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

/** The dispatch the back-channel tests speak about, and the run the router opened for it. */
const DISPATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RUN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
		persistStreamLog: vi.fn(),
		// By default this router is awaiting the dispatch and pushed it to WORKER_ID,
		// so a stream-log from that socket is authorized (issue #544 review, F1).
		resolveDispatchStreamTarget: vi.fn(() => ({ workerId: WORKER_ID, runId: RUN_ID })),
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
		// `validBody()` declares no `supportedPhases` — the older-daemon shape — so the
		// handshake records every phase, the behaviour that pre-dated the field (#467).
		expect(deps.refreshWorkerCapabilities).toHaveBeenCalledWith(
			WORKER_ID,
			['claude'],
			[...DEFAULT_WORKER_SUPPORTED_PHASES],
		);
	});

	it('records a declared phase subset verbatim, without widening it', async () => {
		const deps = makeDeps();
		const declared: TriggerPhase[] = ['implementation', 'review'];

		const result = await handleHandshake(deps, { ...validBody(), supportedPhases: declared });

		expect(result.status).toBe(200);
		expect(deps.refreshWorkerCapabilities).toHaveBeenCalledWith(WORKER_ID, ['claude'], declared);
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

	const ctx = { credential: CREDENTIAL, ttlMs: 60_000, fencingToken: 7, workerId: WORKER_ID };

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

	// The control plane owns the `run_output_events` write for every worker now: a
	// federated one has no database to make it itself, so dropping the frame here
	// left its run detail page blank for the whole run.
	it('forwards a stream-log to the run-output sink and keeps the socket open', async () => {
		const deps = makeDeps();
		const action = await handleWorkerStreamFrame(
			deps,
			ctx,
			JSON.stringify({
				type: 'stream-log',
				dispatchId: DISPATCH,
				runId: RUN_ID,
				lines: [{ stream: 'stdout', content: 'hi\n', emittedAt: '2026-07-24T00:00:00Z' }],
			}),
		);
		expect(action).toEqual({ action: 'ignore' });
		expect(deps.persistStreamLog).toHaveBeenCalledWith(
			{
				type: 'stream-log',
				dispatchId: DISPATCH,
				runId: RUN_ID,
				lines: [{ stream: 'stdout', content: 'hi\n', emittedAt: '2026-07-24T00:00:00Z' }],
			},
			RUN_ID,
		);
		expect(deps.deliverDispatchResult).not.toHaveBeenCalled();
		expect(deps.deliverDispatchProgress).not.toHaveBeenCalled();
		expect(deps.deliverDispatchAck).not.toHaveBeenCalled();
	});

	/**
	 * `stream-log` is the only back-channel frame that writes durably, so it is the
	 * only one whose ids cannot be taken on trust: without these three checks an
	 * authenticated worker credential is a write handle on any run of any project
	 * (issue #544 review, F1).
	 */
	function streamLogFrame(runId: string): string {
		return JSON.stringify({
			type: 'stream-log',
			dispatchId: DISPATCH,
			runId,
			lines: [{ stream: 'stdout', content: 'hi\n', emittedAt: '2026-07-24T00:00:00Z' }],
		});
	}

	it('drops a stream-log for a dispatch this router is not awaiting', async () => {
		const deps = makeDeps({ resolveDispatchStreamTarget: vi.fn(() => undefined) });

		const action = await handleWorkerStreamFrame(deps, ctx, streamLogFrame(RUN_ID));

		expect(action).toEqual({ action: 'ignore' });
		expect(deps.persistStreamLog).not.toHaveBeenCalled();
	});

	it('drops a stream-log whose dispatch was pushed to a different worker', async () => {
		const deps = makeDeps({
			resolveDispatchStreamTarget: vi.fn(() => ({
				workerId: '99999999-9999-4999-8999-999999999999',
				runId: RUN_ID,
			})),
		});

		const action = await handleWorkerStreamFrame(deps, ctx, streamLogFrame(RUN_ID));

		expect(action).toEqual({ action: 'ignore' });
		expect(deps.persistStreamLog).not.toHaveBeenCalled();
	});

	it('persists under the run the router recorded, not the run the frame names', async () => {
		const deps = makeDeps();

		await handleWorkerStreamFrame(
			deps,
			ctx,
			streamLogFrame('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
		);

		expect(deps.persistStreamLog).toHaveBeenCalledWith(expect.anything(), RUN_ID);
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

	// Regression: a back-channel frame (task-execution-result/-progress/-ack,
	// stream-log) resolves `handleWorkerStreamFrame` to `{ action: 'ignore' }` —
	// the socket never closes. An earlier `action.action !== 'ack'` check treated
	// that the same as a `disconnect`/`close` and deregistered a still-open
	// connection, so the worker read as offline (`isWorkerConnected` false) the
	// moment it reported a phase's result — wedging every later dispatch to it
	// behind `worker-unavailable` until the process reconnected, even though the
	// DB session stayed live and the socket never closed.
	it('stays registered after a task-execution-result frame — the socket never closed', async () => {
		const deps = makeDeps();
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});
		const ws = fakeWs();
		handlers.onOpen?.({}, ws);
		expect(isWorkerConnected(WORKER_ID)).toBe(true);

		await handlers.onMessage(
			{
				data: JSON.stringify({
					type: 'task-execution-result',
					dispatchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
					status: 'succeeded',
					phase: 'implementation',
					taskId: '407',
					exitCode: 0,
				}),
			},
			ws,
		);

		expect(isWorkerConnected(WORKER_ID)).toBe(true);
		expect(ws.close).not.toHaveBeenCalled();
		// The next dispatch can still reach this worker.
		expect(sendToWorker(WORKER_ID, { type: 'heartbeat-ack' })).toBe(true);
	});

	// Same regression for the frame a live run sends most often: a chatty run emits
	// one every 100ms, so treating it as a close would drop the connection almost
	// immediately after the phase started.
	it('stays registered after a stream-log frame, having persisted it', async () => {
		const deps = makeDeps();
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});
		const ws = fakeWs();
		handlers.onOpen?.({}, ws);

		await handlers.onMessage(
			{
				data: JSON.stringify({
					type: 'stream-log',
					dispatchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
					runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
					lines: [{ stream: 'stdout', content: 'hi\n', emittedAt: '2026-07-24T00:00:00Z' }],
				}),
			},
			ws,
		);

		expect(deps.persistStreamLog).toHaveBeenCalledTimes(1);
		expect(isWorkerConnected(WORKER_ID)).toBe(true);
		expect(ws.close).not.toHaveBeenCalled();
	});

	it('deregisters when a heartbeat can no longer be refreshed (disconnect action)', async () => {
		const deps = makeDeps({ heartbeat: vi.fn().mockResolvedValue(false) });
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});
		const ws = fakeWs();
		handlers.onOpen?.({}, ws);
		expect(isWorkerConnected(WORKER_ID)).toBe(true);

		await handlers.onMessage({ data: JSON.stringify({ type: 'heartbeat', fencingToken: 7 }) }, ws);

		expect(isWorkerConnected(WORKER_ID)).toBe(false);
	});
});
