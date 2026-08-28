import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	acquireLease,
	getLiveSession,
	getRetainedSession,
	heartbeatLease,
	releaseLease,
	setCurrentRunRow,
} = vi.hoisted(() => ({
	acquireLease: vi.fn(),
	getLiveSession: vi.fn(),
	getRetainedSession: vi.fn(),
	heartbeatLease: vi.fn(),
	releaseLease: vi.fn(),
	setCurrentRunRow: vi.fn(),
}));
const { resolveWorkerByCredential } = vi.hoisted(() => ({ resolveWorkerByCredential: vi.fn() }));

vi.mock('@/db/repositories/workerSessionsRepository.js', () => ({
	acquireLease,
	getLiveSession,
	getRetainedSession,
	heartbeat: heartbeatLease,
	releaseLease,
	setCurrentRun: setCurrentRunRow,
}));
vi.mock('@/identity/worker-service.js', () => ({ resolveWorkerByCredential }));

import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';
import type { WorkerSession } from '@/identity/worker-session.js';
import {
	acquireSession,
	DEFAULT_WORKER_HEARTBEAT_TTL_MS,
	getLiveSessionForWorker,
	getRetainedSessionForWorker,
	heartbeat,
	releaseSession,
	resolveHeartbeatTtlMs,
	setCurrentRun,
	UnknownWorkerCredentialError,
	validateFencingToken,
} from '@/identity/worker-session-service.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';

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

function makeSession(overrides: Partial<WorkerSession> = {}): WorkerSession {
	return {
		id: '33333333-3333-4333-8333-333333333333',
		workerId: WORKER_ID,
		instanceId: null,
		fencingToken: 1,
		lastHeartbeatAt: new Date('2026-01-01T00:00:00Z'),
		currentRunId: null,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

beforeEach(() => {
	acquireLease.mockReset();
	getLiveSession.mockReset();
	getRetainedSession.mockReset();
	heartbeatLease.mockReset();
	releaseLease.mockReset();
	setCurrentRunRow.mockReset();
	resolveWorkerByCredential.mockReset();
});

describe('resolveHeartbeatTtlMs', () => {
	it('defaults when unset and validates a positive integer', () => {
		expect(resolveHeartbeatTtlMs(undefined)).toBe(DEFAULT_WORKER_HEARTBEAT_TTL_MS);
		expect(resolveHeartbeatTtlMs('1000')).toBe(1000);
	});

	it('rejects a non-positive or non-integer value', () => {
		expect(() => resolveHeartbeatTtlMs('0')).toThrow(/positive integer/);
		expect(() => resolveHeartbeatTtlMs('-5')).toThrow(/positive integer/);
		expect(() => resolveHeartbeatTtlMs('1.5')).toThrow(/positive integer/);
		expect(() => resolveHeartbeatTtlMs('abc')).toThrow(/positive integer/);
	});
});

describe('credential authentication', () => {
	it('acquireSession resolves the worker first, then acquires and returns its fencing token', async () => {
		resolveWorkerByCredential.mockResolvedValue(makeWorker());
		acquireLease.mockResolvedValue(makeSession({ fencingToken: 3 }));

		const { session, fencingToken } = await acquireSession('raw-cred', 5000);

		expect(resolveWorkerByCredential).toHaveBeenCalledWith('raw-cred');
		// No proof of possession presented — the plain acquire, forwarded as `undefined`.
		expect(acquireLease).toHaveBeenCalledWith(WORKER_ID, 5000, undefined);
		expect(session.fencingToken).toBe(3);
		expect(fencingToken).toBe(3);
	});

	// Issue #608: a reconnecting daemon's proof rides down to the lease, but only
	// after the credential authenticated — possession is checked on top of auth.
	it('acquireSession forwards a reclaim proof to the lease, still authenticating first', async () => {
		resolveWorkerByCredential.mockResolvedValue(makeWorker());
		acquireLease.mockResolvedValue(makeSession({ fencingToken: 5 }));
		const reclaim = { sessionId: '44444444-4444-4444-8444-444444444444', fencingToken: 4 };

		const { fencingToken } = await acquireSession('raw-cred', 5000, reclaim);

		expect(resolveWorkerByCredential).toHaveBeenCalledWith('raw-cred');
		expect(acquireLease).toHaveBeenCalledWith(WORKER_ID, 5000, reclaim);
		expect(fencingToken).toBe(5);
	});

	it('never reaches the lease with a reclaim when the credential is unknown', async () => {
		resolveWorkerByCredential.mockResolvedValue(undefined);

		await expect(
			acquireSession('nope', 5000, {
				sessionId: '44444444-4444-4444-8444-444444444444',
				fencingToken: 4,
			}),
		).rejects.toBeInstanceOf(UnknownWorkerCredentialError);
		expect(acquireLease).not.toHaveBeenCalled();
	});

	it('throws UnknownWorkerCredentialError and never touches the lease for an unknown credential', async () => {
		resolveWorkerByCredential.mockResolvedValue(undefined);

		await expect(acquireSession('nope')).rejects.toBeInstanceOf(UnknownWorkerCredentialError);
		expect(acquireLease).not.toHaveBeenCalled();
	});

	it('heartbeat/release/setCurrentRun all authenticate before delegating', async () => {
		resolveWorkerByCredential.mockResolvedValue(makeWorker());
		heartbeatLease.mockResolvedValue(true);
		releaseLease.mockResolvedValue(true);
		setCurrentRunRow.mockResolvedValue(true);

		expect(await heartbeat('raw-cred', 2, 5000)).toBe(true);
		expect(heartbeatLease).toHaveBeenCalledWith(WORKER_ID, 2, 5000);

		expect(await releaseSession('raw-cred', 2)).toBe(true);
		expect(releaseLease).toHaveBeenCalledWith(WORKER_ID, 2);

		expect(await setCurrentRun('raw-cred', 2, 'run-1', 5000)).toBe(true);
		expect(setCurrentRunRow).toHaveBeenCalledWith(WORKER_ID, 2, 'run-1', 5000);
	});

	it('a heartbeat with an unknown credential throws and never delegates', async () => {
		resolveWorkerByCredential.mockResolvedValue(undefined);
		await expect(heartbeat('nope', 1)).rejects.toBeInstanceOf(UnknownWorkerCredentialError);
		expect(heartbeatLease).not.toHaveBeenCalled();
	});
});

describe('validateFencingToken (the #130 seam)', () => {
	it('accepts the current token of a live session', async () => {
		getLiveSession.mockResolvedValue(makeSession({ fencingToken: 7 }));
		expect(await validateFencingToken(WORKER_ID, 7, 5000)).toBe(true);
		expect(getLiveSession).toHaveBeenCalledWith(WORKER_ID, 5000);
	});

	it('rejects a stale token from a replaced worker', async () => {
		getLiveSession.mockResolvedValue(makeSession({ fencingToken: 8 }));
		// The caller still holds the pre-replacement token 7.
		expect(await validateFencingToken(WORKER_ID, 7, 5000)).toBe(false);
	});

	it('rejects when the worker has no live session', async () => {
		getLiveSession.mockResolvedValue(undefined);
		expect(await validateFencingToken(WORKER_ID, 1, 5000)).toBe(false);
	});
});

describe('getLiveSessionForWorker', () => {
	it('delegates to the repository live-session lookup', async () => {
		const session = makeSession();
		getLiveSession.mockResolvedValue(session);
		expect(await getLiveSessionForWorker(WORKER_ID, 5000)).toBe(session);
		expect(getLiveSession).toHaveBeenCalledWith(WORKER_ID, 5000);
	});
});

describe('getRetainedSessionForWorker', () => {
	it('delegates to the repository retained-session lookup, without a TTL', async () => {
		const session = makeSession();
		getRetainedSession.mockResolvedValue(session);

		expect(await getRetainedSessionForWorker(WORKER_ID)).toBe(session);
		// Deliberately un-gated: last-seen must survive expiry, so no TTL is passed
		// and the liveness lookup is never consulted.
		expect(getRetainedSession).toHaveBeenCalledWith(WORKER_ID);
		expect(getLiveSession).not.toHaveBeenCalled();
	});

	it('is undefined for a worker that never connected', async () => {
		getRetainedSession.mockResolvedValue(undefined);
		expect(await getRetainedSessionForWorker(WORKER_ID)).toBeUndefined();
	});
});
