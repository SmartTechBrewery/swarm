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
import { resendRunCancellationsToWorker } from '@/router/dispatch-cancellation.js';
import {
	awaitDispatchResult,
	noteWorkerTransportLost,
	noteWorkerTransportRestored,
} from '@/router/dispatch-results.js';
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

// The only Redis this suite touches: the durable cancellation marker the
// stream-open re-push consults (issue #827). Everything else the marker's module
// exports is left as it really is, so a transitive importer keeps working.
const { isRunCancellationRequested } = vi.hoisted(() => ({
	isRunCancellationRequested: vi.fn<(runId: string) => Promise<boolean>>(),
}));
vi.mock('@/queue/cancellation.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/queue/cancellation.js')>()),
	isRunCancellationRequested,
}));

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const CREDENTIAL = 'raw-worker-credential-secret';

function makeWorker(overrides: Partial<Worker> = {}): Worker {
	const worker: Worker = {
		id: WORKER_ID,
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude'],
		// No declaration (issue #783), so the probe is the effective set.
		probedCapabilities: ['claude'],
		declaredCapabilities: null,
		supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
		repository: null,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
	// Keep the two CLI fields in step when a test overrides only `capabilities`.
	return { ...worker, probedCapabilities: overrides.probedCapabilities ?? worker.capabilities };
}

function makeAcquired(overrides: Partial<AcquiredSession['session']> = {}): AcquiredSession {
	return {
		session: {
			id: SESSION_ID,
			workerId: WORKER_ID,
			instanceId: null,
			fencingToken: 7,
			lastHeartbeatAt: new Date('2026-01-01T00:00:00Z'),
			currentRunId: null,
			createdAt: new Date('2026-01-01T00:00:00Z'),
			reclaimedBySameInstance: false,
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
		suspendEnrollmentsForMismatchedRepository: vi.fn().mockResolvedValue([]),
		reapSupersededWorkerClaims: vi.fn().mockResolvedValue(undefined),
		resolveHeartbeatTtlMs: vi.fn().mockReturnValue(60_000),
		validateFencingToken: vi.fn().mockResolvedValue(true),
		deliverDispatchResult: vi.fn().mockReturnValue(true),
		deliverDispatchProgress: vi.fn(),
		deliverDispatchAck: vi.fn(),
		persistStreamLog: vi.fn(),
		// By default this router is awaiting the dispatch and pushed it to WORKER_ID,
		// so a stream-log from that socket is authorized (issue #544 review, F1).
		resolveDispatchStreamTarget: vi.fn(() => ({ workerId: WORKER_ID, runId: RUN_ID })),
		onWorkerAvailable: vi.fn(),
		onWorkerTransportLost: vi.fn(),
		onWorkerTransportRestored: vi.fn(),
		resendRunCancellations: vi.fn(),
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
		// `validBody()` presents no proof of possession, so the acquire is the plain one.
		expect(deps.acquireSession).toHaveBeenCalledWith(CREDENTIAL, 60_000, undefined, undefined);
		// `validBody()` declares no `supportedPhases` — the older-daemon shape — so the
		// handshake records every phase, the behaviour that pre-dated the field (#467).
		// It declares no `repository` either, which records NULL (issue #687): the
		// column's pre-existing value, and the one that clears a stale declaration.
		expect(deps.refreshWorkerCapabilities).toHaveBeenCalledWith(
			WORKER_ID,
			['claude'],
			[...DEFAULT_WORKER_SUPPORTED_PHASES],
			null,
		);
	});

	it('records a declared phase subset verbatim, without widening it', async () => {
		const deps = makeDeps();
		const declared: TriggerPhase[] = ['implementation', 'review'];

		const result = await handleHandshake(deps, { ...validBody(), supportedPhases: declared });

		expect(result.status).toBe(200);
		expect(deps.refreshWorkerCapabilities).toHaveBeenCalledWith(
			WORKER_ID,
			['claude'],
			declared,
			null,
		);
	});

	// Issue #687 — the third declaration. Persisted (unlike `hostname`) and normalised at
	// this boundary, so the roster records one canonical `owner/repo` whatever form a
	// daemon sent.
	it('records the declared repository, normalised', async () => {
		const deps = makeDeps();

		const result = await handleHandshake(deps, {
			...validBody(),
			repository: 'SmartTechBrewery/Swarm.git',
		});

		expect(result.status).toBe(200);
		expect(deps.refreshWorkerCapabilities).toHaveBeenCalledWith(
			WORKER_ID,
			['claude'],
			[...DEFAULT_WORKER_SUPPORTED_PHASES],
			'smarttechbrewery/swarm',
		);
		expect(result.json).toMatchObject({ authenticated: true, workerId: WORKER_ID });
	});

	// Issue #690 — the declaration's second consumer: enrollments written against
	// another repository are suspended once the machine says which one it is.
	it('polices existing enrollments against the declared repository', async () => {
		const deps = makeDeps();

		const result = await handleHandshake(deps, {
			...validBody(),
			repository: 'SmartTechBrewery/Swarm.git',
		});

		expect(result.status).toBe(200);
		// The normalised form, and only after the declaration was persisted — the pass
		// acts on what the row now says.
		expect(deps.suspendEnrollmentsForMismatchedRepository).toHaveBeenCalledWith(
			WORKER_ID,
			'smarttechbrewery/swarm',
		);
		expect(deps.refreshWorkerCapabilities).toHaveBeenCalledBefore(
			deps.suspendEnrollmentsForMismatchedRepository as ReturnType<typeof vi.fn>,
		);
	});

	it('polices nothing when the daemon declared no repository', async () => {
		const deps = makeDeps();

		const result = await handleHandshake(deps, validBody());

		expect(result.status).toBe(200);
		// An unidentifiable checkout must not suspend enrollments an operator created.
		expect(deps.suspendEnrollmentsForMismatchedRepository).not.toHaveBeenCalled();
	});

	it('still completes the handshake when policing enrollments throws', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const deps = makeDeps({
			suspendEnrollmentsForMismatchedRepository: vi
				.fn()
				.mockRejectedValue(new Error('postgres is unreachable')),
		});

		const result = await handleHandshake(deps, {
			...validBody(),
			repository: 'smarttechbrewery/swarm',
		});

		// Policing enrollments is housekeeping on the control plane's side — it must
		// never stop a worker from connecting. The daemon's own pre-flight check
		// (issue #688) refuses a mismatched assignment regardless.
		expect(result.status).toBe(200);
		expect(result.json).toMatchObject({ authenticated: true, workerId: WORKER_ID });
		expect(deps.releaseSession).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it('does not police enrollments when the declaration could not be persisted', async () => {
		const deps = makeDeps({
			refreshWorkerCapabilities: vi
				.fn()
				.mockRejectedValue(new WorkerCapabilityReductionError(WORKER_ID, ['claude'])),
		});

		const result = await handleHandshake(deps, {
			...validBody(),
			repository: 'smarttechbrewery/swarm',
		});

		expect(result.status).toBe(409);
		expect(deps.suspendEnrollmentsForMismatchedRepository).not.toHaveBeenCalled();
	});

	// Issue #783 — the handshake still writes the daemon's probe verbatim, and an
	// owner's declaration is neither honoured nor overwritten here: it outranks the
	// probe downstream, in the effective set `rowToWorker` resolves.
	it('warns once when a stored declaration names a CLI this machine no longer probes', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const deps = makeDeps({
			refreshWorkerCapabilities: vi.fn().mockResolvedValue(
				makeWorker({
					capabilities: ['claude'],
					probedCapabilities: ['claude'],
					declaredCapabilities: ['claude', 'codex'],
				}),
			),
		});

		const result = await handleHandshake(deps, validBody());

		// The stale declaration is a warning, never a refusal — the intersection has
		// already narrowed it away, so the daemon connects and simply runs less.
		expect(result.status).toBe(200);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('no longer reported'),
			expect.objectContaining({ workerId: WORKER_ID, dropped: ['codex'] }),
		);
		warn.mockRestore();
	});

	it('warns about no drift when the probe still reports every declared CLI', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const deps = makeDeps({
			refreshWorkerCapabilities: vi
				.fn()
				.mockResolvedValue(makeWorker({ declaredCapabilities: ['claude'] })),
		});

		expect((await handleHandshake(deps, validBody())).status).toBe(200);
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	// The dependency's contract allows `undefined` (an unknown worker id), and existing
	// callers/doubles resolve it — the drift check must not turn that into a crash.
	it('completes the handshake when the capability refresh resolves undefined', async () => {
		const deps = makeDeps({ refreshWorkerCapabilities: vi.fn().mockResolvedValue(undefined) });

		expect((await handleHandshake(deps, validBody())).status).toBe(200);
	});

	it('rejects a malformed repository with 400, before touching the lease', async () => {
		const deps = makeDeps();

		const result = await handleHandshake(deps, { ...validBody(), repository: 'not-a-slug' });

		expect(result.status).toBe(400);
		expect(deps.acquireSession).not.toHaveBeenCalled();
		expect(deps.refreshWorkerCapabilities).not.toHaveBeenCalled();
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

	// Issue #608: a reconnecting daemon presents the lease it already holds, so the
	// control plane recognises its own holder instead of refusing it for the rest of
	// the heartbeat TTL.
	describe('session reclaim', () => {
		const reclaim = { sessionId: SESSION_ID, fencingToken: 6 };

		it('passes a presented reclaim through to the acquire and returns the new session', async () => {
			const deps = makeDeps();

			const result = await handleHandshake(deps, { ...validBody(), reclaim });

			expect(result.status).toBe(200);
			expect(result.json).toMatchObject({ sessionId: SESSION_ID, fencingToken: 7 });
			expect(deps.acquireSession).toHaveBeenCalledWith(CREDENTIAL, 60_000, reclaim, undefined);
		});

		// The AC's "a different daemon is still refused" case at this seam: the acquire
		// rejects the proof, and the 409 body is byte-identical to today's.
		it('still answers 409 “worker session already held” when the reclaim is refused', async () => {
			const deps = makeDeps({
				acquireSession: vi.fn().mockRejectedValue(new WorkerSessionHeldError(WORKER_ID)),
			});

			const result = await handleHandshake(deps, { ...validBody(), reclaim });

			expect(result.status).toBe(409);
			expect(result.json).toEqual({
				authenticated: false,
				reason: 'worker session already held',
			});
			expect(deps.refreshWorkerCapabilities).not.toHaveBeenCalled();
		});

		it('rejects a malformed reclaim with 400 before touching the lease', async () => {
			const deps = makeDeps();

			const badSessionId = await handleHandshake(deps, {
				...validBody(),
				reclaim: { sessionId: 'not-a-uuid', fencingToken: 6 },
			});
			const badToken = await handleHandshake(deps, {
				...validBody(),
				reclaim: { sessionId: SESSION_ID, fencingToken: 0 },
			});

			expect(badSessionId.status).toBe(400);
			expect(badToken.status).toBe(400);
			expect(deps.acquireSession).not.toHaveBeenCalled();
		});
	});

	// Issue #719: the supersede is knowable the moment the new generation takes the
	// lease, so the claims the old one left executing are settled from that signal
	// instead of waiting out `timeoutMs + RESULT_WAIT_MARGIN_MS`. The handshake is
	// where it happens because it is the only point that can tell a takeover from the
	// same daemon reclaiming its own lease.
	describe('reaping a superseded generation’s dispatch claims', () => {
		it('reaps when the acquire took no reclaim branch, naming the new generation', async () => {
			const deps = makeDeps();

			const result = await handleHandshake(deps, validBody());

			expect(result.status).toBe(200);
			expect(deps.reapSupersededWorkerClaims).toHaveBeenCalledWith(WORKER_ID, 7);
		});

		it('reaps nothing when the daemon reclaimed its own lease (its phase may still be running)', async () => {
			const deps = makeDeps();

			// `makeAcquired()` returns session 3333… at token 7 — exactly the replace
			// branch's answer to this proof, so the same daemon is back and #718's held
			// result is still coming.
			const result = await handleHandshake(deps, {
				...validBody(),
				reclaim: { sessionId: SESSION_ID, fencingToken: 6 },
			});

			expect(result.status).toBe(200);
			expect(deps.reapSupersededWorkerClaims).not.toHaveBeenCalled();
		});

		it('does not reap a current daemon after a lost response made its proof stale or absent', async () => {
			const acquired = makeAcquired();
			const instanceId = '44444444-4444-4444-8444-444444444444';
			const deps = makeDeps({
				acquireSession: vi.fn().mockResolvedValue({
					...acquired,
					session: { ...acquired.session, reclaimedBySameInstance: true },
				}),
			});

			await handleHandshake(deps, {
				...validBody(),
				instanceId,
				reclaim: { sessionId: SESSION_ID, fencingToken: 3 },
			});
			await handleHandshake(deps, {
				...validBody(),
				instanceId,
			});

			expect(deps.acquireSession).toHaveBeenNthCalledWith(
				1,
				CREDENTIAL,
				60_000,
				{ sessionId: SESSION_ID, fencingToken: 3 },
				instanceId,
			);
			expect(deps.acquireSession).toHaveBeenNthCalledWith(
				2,
				CREDENTIAL,
				60_000,
				undefined,
				instanceId,
			);
			expect(deps.reapSupersededWorkerClaims).not.toHaveBeenCalled();
		});

		it('reaps for a stale proof or one naming another session', async () => {
			const stale = makeDeps();
			await handleHandshake(stale, {
				...validBody(),
				// The row moved past this token while that daemon was away, so the acquire
				// refused the proof and took the lease over instead.
				reclaim: { sessionId: SESSION_ID, fencingToken: 3 },
			});
			expect(stale.reapSupersededWorkerClaims).toHaveBeenCalledWith(WORKER_ID, 7);

			const foreign = makeDeps();
			await handleHandshake(foreign, {
				...validBody(),
				reclaim: { sessionId: '44444444-4444-4444-8444-444444444444', fencingToken: 6 },
			});
			expect(foreign.reapSupersededWorkerClaims).toHaveBeenCalledWith(WORKER_ID, 7);
		});

		it('still completes the handshake when the reap throws, and still polices enrollments', async () => {
			const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			const deps = makeDeps({
				reapSupersededWorkerClaims: vi.fn().mockRejectedValue(new Error('postgres is down')),
			});

			const result = await handleHandshake(deps, {
				...validBody(),
				repository: 'smarttechbrewery/swarm',
			});

			// Housekeeping on the control plane's side, exactly like the enrollment pass:
			// connecting must not depend on it, and the timer remains the slow backstop.
			expect(result.status).toBe(200);
			expect(result.json).toMatchObject({ authenticated: true, workerId: WORKER_ID });
			expect(deps.releaseSession).not.toHaveBeenCalled();
			expect(deps.suspendEnrollmentsForMismatchedRepository).toHaveBeenCalled();
			expect(warn).toHaveBeenCalled();
			warn.mockRestore();
		});

		it('reaps nothing for a handshake that never took the lease', async () => {
			const unauthenticated = makeDeps({
				resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined),
			});
			await handleHandshake(unauthenticated, validBody());
			expect(unauthenticated.reapSupersededWorkerClaims).not.toHaveBeenCalled();

			const held = makeDeps({
				acquireSession: vi.fn().mockRejectedValue(new WorkerSessionHeldError(WORKER_ID)),
			});
			await handleHandshake(held, validBody());
			expect(held.reapSupersededWorkerClaims).not.toHaveBeenCalled();

			const versionMismatch = makeDeps();
			await handleHandshake(versionMismatch, {
				...validBody(),
				protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1,
			});
			expect(versionMismatch.reapSupersededWorkerClaims).not.toHaveBeenCalled();

			// A capability reduction releases the lease it just took and answers 409, so
			// there is no new generation to reap the old one on behalf of.
			const reduced = makeDeps({
				refreshWorkerCapabilities: vi
					.fn()
					.mockRejectedValue(new WorkerCapabilityReductionError(WORKER_ID, ['claude'])),
			});
			await handleHandshake(reduced, validBody());
			expect(reduced.reapSupersededWorkerClaims).not.toHaveBeenCalled();
		});
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
		// Nothing became available, so nothing is woken (issue #610).
		expect(deps.onWorkerAvailable).not.toHaveBeenCalled();
	});

	// Issue #610. A worker connecting is one of the two moments that clears an
	// availability wait, and the socket open is where the control plane learns it.
	it('wakes the availability-blocked dispatches once an authenticated socket opens', async () => {
		const deps = makeDeps();
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});

		handlers.onOpen?.({}, fakeWs());

		expect(deps.onWorkerAvailable).toHaveBeenCalledWith(WORKER_ID);
	});

	it('keeps the socket registered when waking throws — connectivity does not depend on it', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const deps = makeDeps({
			onWorkerAvailable: vi.fn(() => {
				throw new Error('postgres is down');
			}),
		});
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});
		const ws = fakeWs();

		expect(() => handlers.onOpen?.({}, ws)).not.toThrow();
		expect(isWorkerConnected(WORKER_ID)).toBe(true);
		expect(warnSpy).toHaveBeenCalled();

		warnSpy.mockRestore();
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

/**
 * Issue #723. The router is the only place that knows the moment a socket drops and
 * the moment one opens, so it is where a transport interruption becomes legible —
 * recorded against the dispatches awaited on that worker and noted in their runs'
 * output streams. What the hooks *do* is the registry's and the sink's business
 * (their own suites); what matters here is that the socket lifecycle invokes them
 * exactly when the transport really changed state, and never at the cost of the
 * connection.
 */
describe('GET /worker/stream transport-interruption hooks', () => {
	beforeEach(() => vi.clearAllMocks());

	async function connect(deps: WorkerTransportDeps) {
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});
		const ws = fakeWs();
		handlers.onOpen?.({}, ws);
		return { handlers, ws };
	}

	it('notes the restored session when an authenticated socket opens', async () => {
		const deps = makeDeps();

		const { handlers, ws } = await connect(deps);

		expect(deps.onWorkerTransportRestored).toHaveBeenCalledWith(WORKER_ID);
		expect(deps.onWorkerTransportLost).not.toHaveBeenCalled();
		await handlers.onClose?.({}, ws);
	});

	it('notes nothing on an unauthenticated open', async () => {
		const deps = makeDeps({ resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined) });
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});

		handlers.onOpen?.({}, fakeWs());

		expect(deps.onWorkerTransportRestored).not.toHaveBeenCalled();
	});

	// Same property the `onWorkerAvailable` test asserts: registration is what
	// connectivity depends on and it already happened, so a note that fails must not
	// take the socket down — nor stop the *other* open hook from running.
	it('keeps the socket registered when the restored note throws', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const deps = makeDeps({
			onWorkerTransportRestored: vi.fn(() => {
				throw new Error('postgres is down');
			}),
		});

		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});
		const ws = fakeWs();

		expect(() => handlers.onOpen?.({}, ws)).not.toThrow();
		expect(isWorkerConnected(WORKER_ID)).toBe(true);
		expect(deps.onWorkerAvailable).toHaveBeenCalledWith(WORKER_ID);
		expect(warnSpy).toHaveBeenCalled();

		await handlers.onClose?.({}, ws);
		warnSpy.mockRestore();
	});

	it('records the interruption when the live socket closes', async () => {
		const deps = makeDeps();
		const { handlers, ws } = await connect(deps);

		await handlers.onClose?.({}, ws);

		expect(deps.onWorkerTransportLost).toHaveBeenCalledWith(WORKER_ID);
		// The lease is still freed — the note rides alongside, it does not replace it.
		expect(deps.releaseSession).toHaveBeenCalledWith(CREDENTIAL, 7);
		expect(isWorkerConnected(WORKER_ID)).toBe(false);
	});

	// A reconnect that registered before the old socket's close arrived: nothing is
	// interrupted, the worker is right here, so the run must not be told otherwise.
	it('writes nothing for a superseded socket’s stale close', async () => {
		const stale = makeDeps();
		const live = makeDeps();

		const first = await connect(stale);
		const second = await connect(live);

		await first.handlers.onClose?.({}, first.ws);

		expect(stale.onWorkerTransportLost).not.toHaveBeenCalled();
		expect(isWorkerConnected(WORKER_ID)).toBe(true);

		await second.handlers.onClose?.({}, second.ws);
		expect(live.onWorkerTransportLost).toHaveBeenCalledWith(WORKER_ID);
	});

	// An errored socket may never deliver a clean close, so `onError` records it too —
	// but the pair `onError` → `onClose` is one drop, and must count as one.
	it('records one interruption for a socket that errors and then closes', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const deps = makeDeps();
		const { handlers, ws } = await connect(deps);

		handlers.onError?.(new Error('socket reset'), ws);
		await handlers.onClose?.({}, ws);

		expect(deps.onWorkerTransportLost).toHaveBeenCalledTimes(1);
		expect(deps.onWorkerTransportLost).toHaveBeenCalledWith(WORKER_ID);
		warnSpy.mockRestore();
	});

	// Review #4929792793 F1: `onOpen` fires `onWorkerTransportRestored` on *every*
	// socket open, including one that supersedes an already-live socket with no
	// transport loss in between (a reconnect racing its predecessor's close, or a
	// second daemon connection). Wiring the hooks to the real
	// `dispatch-results.ts` bookkeeping (rather than the bare mocks the other
	// cases in this block use) is what lets this test observe whether a second,
	// spurious restoration is reported.
	it('does not report a second restoration when a live socket is superseded with no new drop', async () => {
		const awaiting = awaitDispatchResult(DISPATCH, {
			workerId: WORKER_ID,
			runId: RUN_ID,
			phase: 'implementation',
			taskId: '407',
		});
		const restoredCalls: unknown[][] = [];
		const deps = makeDeps({
			onWorkerTransportLost: vi.fn((id: string) => {
				noteWorkerTransportLost(id);
			}),
			onWorkerTransportRestored: vi.fn((id: string) => {
				restoredCalls.push(noteWorkerTransportRestored(id));
			}),
		});

		const first = await connect(deps);
		await first.handlers.onClose?.({}, first.ws);
		await connect(deps);
		// Supersedes the second socket with no intervening drop.
		const third = await connect(deps);

		expect(restoredCalls).toEqual([
			[], // first open: transport never dropped yet
			[{ dispatchId: DISPATCH, runId: RUN_ID }], // second open: restores the drop recorded on close
			[], // third open: superseded `second`, but nothing dropped since it restored
		]);

		await third.handlers.onClose?.({}, third.ws);
		awaiting.dispose();
	});

	it('still frees the lease when the lost note throws', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const deps = makeDeps({
			onWorkerTransportLost: vi.fn(() => {
				throw new Error('postgres is down');
			}),
		});
		const { handlers, ws } = await connect(deps);

		await expect(handlers.onClose?.({}, ws)).resolves.toBeUndefined();

		expect(deps.releaseSession).toHaveBeenCalledWith(CREDENTIAL, 7);
		expect(warnSpy).toHaveBeenCalled();
		warnSpy.mockRestore();
	});
});

/**
 * Issue #827 (review #5058049296 F1). The bounded offline settle re-pushes a
 * cancellation only from a wait it armed, and it arms one only for a worker already
 * silent past its heartbeat and reconnect windows when the terminate landed. The
 * ordinary shape is the other one — socket drops, operator terminates seconds later,
 * daemon reconnects moments after that — and the only thing standing between it and
 * an agent that keeps running is this hook. What the re-push *does* is
 * `dispatch-cancellation.ts`'s business; what matters here is that the socket
 * lifecycle really invokes it, against the socket it just registered, and never at
 * the cost of the connection.
 */
describe('GET /worker/stream cancellation re-push on reconnect', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		isRunCancellationRequested.mockResolvedValue(false);
	});

	async function connect(deps: WorkerTransportDeps) {
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});
		const ws = fakeWs();
		handlers.onOpen?.({}, ws);
		return { handlers, ws };
	}

	// The whole point of the finding: no silence wait was ever armed (the worker was
	// still heartbeating when the terminate landed), so the reconnect is the only
	// moment left at which the marker can reach it.
	it('pushes task-cancel for an awaited run marked cancelled while the socket was down', async () => {
		isRunCancellationRequested.mockResolvedValue(true);
		const awaiting = awaitDispatchResult(DISPATCH, {
			workerId: WORKER_ID,
			runId: RUN_ID,
			phase: 'implementation',
			taskId: '407',
		});
		// The real re-push, wired to the real registries, so the assertion is about a
		// frame actually reaching the socket rather than a mock being called.
		const deps = makeDeps({ resendRunCancellations: resendRunCancellationsToWorker });

		const { handlers, ws } = await connect(deps);

		await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
		expect(JSON.parse(String(ws.send.mock.calls[0][0]))).toMatchObject({
			type: 'task-cancel',
			dispatchId: DISPATCH,
			runId: RUN_ID,
			// From the registration, so the worker can answer a cancel it cannot apply
			// with a terminal result naming both (issue #724).
			phase: 'implementation',
			taskId: '407',
		});
		expect(isRunCancellationRequested).toHaveBeenCalledWith(RUN_ID);

		await handlers.onClose?.({}, ws);
		awaiting.dispose();
	});

	// An ordinary connection: the run it is awaiting was never terminated, so the
	// marker read answers `false` and the worker is left alone.
	it('pushes nothing when the awaited run carries no cancellation marker', async () => {
		const awaiting = awaitDispatchResult(DISPATCH, {
			workerId: WORKER_ID,
			runId: RUN_ID,
			phase: 'implementation',
			taskId: '407',
		});
		const deps = makeDeps({ resendRunCancellations: resendRunCancellationsToWorker });

		const { handlers, ws } = await connect(deps);

		await vi.waitFor(() => expect(isRunCancellationRequested).toHaveBeenCalledWith(RUN_ID));
		expect(ws.send).not.toHaveBeenCalled();

		await handlers.onClose?.({}, ws);
		awaiting.dispose();
	});

	// A first connection with nothing awaited on this worker reads no marker at all —
	// the Redis round-trip is bounded by what this router is actually executing there.
	it('reads no marker for a worker this router is awaiting nothing on', async () => {
		const deps = makeDeps({ resendRunCancellations: resendRunCancellationsToWorker });

		const { handlers, ws } = await connect(deps);

		expect(isRunCancellationRequested).not.toHaveBeenCalled();
		await handlers.onClose?.({}, ws);
	});

	// Same property the other two open hooks hold: registration is what connectivity
	// depends on and it already happened.
	it('keeps the socket registered when the re-push throws', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const deps = makeDeps({
			resendRunCancellations: vi.fn(() => {
				throw new Error('redis is down');
			}),
		});
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});
		const ws = fakeWs();

		expect(() => handlers.onOpen?.({}, ws)).not.toThrow();
		expect(isWorkerConnected(WORKER_ID)).toBe(true);
		expect(deps.onWorkerTransportRestored).toHaveBeenCalledWith(WORKER_ID);
		expect(warnSpy).toHaveBeenCalled();

		await handlers.onClose?.({}, ws);
		warnSpy.mockRestore();
	});

	it('re-pushes nothing on an unauthenticated open', async () => {
		const deps = makeDeps({ resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined) });
		const handlers = await openStream(deps, {
			authorization: `Bearer ${CREDENTIAL}`,
			fencingToken: '7',
		});

		handlers.onOpen?.({}, fakeWs());

		expect(deps.resendRunCancellations).not.toHaveBeenCalled();
	});
});
