import { beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyDispatchClaim, type DispatchClaim } from '@/dispatch/claim-liveness.js';

// The two session reads behind the silence half of the judgement (issue #827,
// shared by issue #1017). Mocked at the service boundary so "is this worker live,
// and if not how long has it been quiet?" is drivable without Postgres.
const { getLiveSessionForWorker, getRetainedSessionForWorker } = vi.hoisted(() => ({
	getLiveSessionForWorker: vi.fn<(workerId: string) => Promise<unknown>>(),
	getRetainedSessionForWorker: vi.fn<(workerId: string) => Promise<unknown>>(),
}));
vi.mock('@/identity/worker-session-service.js', () => ({
	getLiveSessionForWorker,
	getRetainedSessionForWorker,
	resolveHeartbeatTtlMs: () => HEARTBEAT_TTL_MS,
}));

/** Matches `DEFAULT_WORKER_HEARTBEAT_TTL_MS`; `offlineSilenceMs` floors at 2 minutes. */
const HEARTBEAT_TTL_MS = 60_000;
const SILENCE_GRACE_MS = 120_000;

const NOW = new Date('2026-09-16T09:52:00.000Z');
const WORKER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function claim(overrides: Partial<DispatchClaim> = {}): DispatchClaim {
	return {
		state: 'leased',
		// An hour out — well inside `DISPATCH_CLAIM_LEASE_MS`.
		leaseExpiresAt: new Date(NOW.getTime() + 3_600_000),
		selectedWorkerId: WORKER_ID,
		...overrides,
	};
}

describe('classifyDispatchClaim', () => {
	beforeEach(() => {
		vi.mocked(getLiveSessionForWorker).mockReset().mockResolvedValue(undefined);
		vi.mocked(getRetainedSessionForWorker).mockReset().mockResolvedValue(undefined);
	});

	it('reads a queued dispatch as waiting, with no session lookup at all', async () => {
		for (const state of ['pending', 'retry-scheduled'] as const) {
			await expect(classifyDispatchClaim(claim({ state }), NOW)).resolves.toBe('waiting');
		}
		expect(getLiveSessionForWorker).not.toHaveBeenCalled();
	});

	it('reads a claim held by a live worker as executing', async () => {
		vi.mocked(getLiveSessionForWorker).mockResolvedValue({ id: 'session-1' });

		await expect(classifyDispatchClaim(claim({ state: 'running' }), NOW)).resolves.toBe(
			'executing',
		);
	});

	it('reads a lapsed lease as stale without asking about the worker', async () => {
		// The shape the lease-expiry sweep would reap on its next pass; the operator
		// should not have to wait for that cadence (issue #1017).
		const lapsed = claim({ leaseExpiresAt: new Date(NOW.getTime() - 1) });

		await expect(classifyDispatchClaim(lapsed, NOW)).resolves.toBe('stale');
		expect(getLiveSessionForWorker).not.toHaveBeenCalled();
	});

	it('reads a claim with no lease at all as stale', async () => {
		await expect(classifyDispatchClaim(claim({ leaseExpiresAt: null }), NOW)).resolves.toBe(
			'stale',
		);
	});

	it('reads an unexpired claim on a worker silent past the grace as stale', async () => {
		vi.mocked(getRetainedSessionForWorker).mockResolvedValue({
			lastHeartbeatAt: new Date(NOW.getTime() - SILENCE_GRACE_MS),
		});

		await expect(classifyDispatchClaim(claim(), NOW)).resolves.toBe('stale');
	});

	it('keeps a released-but-recently-heard-from worker executing', async () => {
		// A socket close releases the session, and a phase outlives its session
		// routinely (issue #718) — so only silence past the grace may decide.
		vi.mocked(getRetainedSessionForWorker).mockResolvedValue({
			lastHeartbeatAt: new Date(NOW.getTime() - (SILENCE_GRACE_MS - 1)),
		});

		await expect(classifyDispatchClaim(claim(), NOW)).resolves.toBe('executing');
	});

	it('keeps an unfederated claim (no selected worker) executing while its lease holds', async () => {
		await expect(classifyDispatchClaim(claim({ selectedWorkerId: null }), NOW)).resolves.toBe(
			'executing',
		);
		expect(getRetainedSessionForWorker).not.toHaveBeenCalled();
	});

	it('fails closed to executing when the session read throws', async () => {
		vi.mocked(getLiveSessionForWorker).mockRejectedValue(new Error('db down'));

		await expect(classifyDispatchClaim(claim(), NOW)).resolves.toBe('executing');
	});
});
