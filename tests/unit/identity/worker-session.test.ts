import { describe, expect, it } from 'vitest';

import {
	INITIAL_FENCING_TOKEN,
	isReclaimOf,
	isSessionLive,
	nextFencingToken,
	WorkerSessionHeldError,
	WorkerSessionReclaimSchema,
	WorkerSessionSchema,
} from '@/identity/worker-session.js';

const BASE = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(BASE.getTime() + ms);

describe('nextFencingToken', () => {
	it('is strictly monotonic from the initial token', () => {
		let token = INITIAL_FENCING_TOKEN;
		const seen = [token];
		for (let i = 0; i < 5; i++) {
			const next = nextFencingToken(token);
			expect(next).toBeGreaterThan(token);
			token = next;
			seen.push(token);
		}
		expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
		// A replaced holder's token can never again equal a later one.
		expect(new Set(seen).size).toBe(seen.length);
	});
});

describe('isSessionLive (TTL boundary math)', () => {
	const TTL = 60_000;

	it('is live strictly before the TTL elapses', () => {
		expect(isSessionLive(BASE, TTL, at(0))).toBe(true);
		expect(isSessionLive(BASE, TTL, at(TTL - 1))).toBe(true);
	});

	it('is expired exactly at and after the TTL', () => {
		// Boundary: elapsed === TTL is expired, not live.
		expect(isSessionLive(BASE, TTL, at(TTL))).toBe(false);
		expect(isSessionLive(BASE, TTL, at(TTL + 1))).toBe(false);
	});
});

describe('WorkerSessionSchema', () => {
	const valid = {
		id: '11111111-1111-4111-8111-111111111111',
		workerId: '22222222-2222-4222-8222-222222222222',
		fencingToken: 1,
		lastHeartbeatAt: BASE,
		currentRunId: null,
		createdAt: BASE,
	};

	it('accepts a well-formed session with a null current run', () => {
		expect(WorkerSessionSchema.parse(valid)).toEqual(valid);
	});

	it('accepts a uuid current run reference', () => {
		const runId = '33333333-3333-4333-8333-333333333333';
		expect(WorkerSessionSchema.parse({ ...valid, currentRunId: runId }).currentRunId).toBe(runId);
	});

	it('rejects a non-positive or non-integer fencing token', () => {
		expect(() => WorkerSessionSchema.parse({ ...valid, fencingToken: 0 })).toThrow();
		expect(() => WorkerSessionSchema.parse({ ...valid, fencingToken: -1 })).toThrow();
		expect(() => WorkerSessionSchema.parse({ ...valid, fencingToken: 1.5 })).toThrow();
	});
});

describe('isReclaimOf (the reconnecting holder’s proof — issue #608)', () => {
	const session = { id: '11111111-1111-4111-8111-111111111111', fencingToken: 4 };

	it('accepts an exact match on both the session id and its current token', () => {
		expect(isReclaimOf(session, { sessionId: session.id, fencingToken: 4 })).toBe(true);
	});

	it('refuses a caller that presents no proof at all', () => {
		// A competing daemon holds the same credential but not the pair, so the lease's
		// liveness refusal must still catch it.
		expect(isReclaimOf(session, undefined)).toBe(false);
	});

	it('refuses a mismatched session id', () => {
		expect(
			isReclaimOf(session, {
				sessionId: '22222222-2222-4222-8222-222222222222',
				fencingToken: 4,
			}),
		).toBe(false);
	});

	it('refuses a superseded holder’s stale token', () => {
		// Once anyone re-acquires, the row's token moves past the one that daemon
		// remembers — which is what makes matching on the token load-bearing.
		expect(isReclaimOf(session, { sessionId: session.id, fencingToken: 3 })).toBe(false);
		expect(isReclaimOf(session, { sessionId: session.id, fencingToken: 5 })).toBe(false);
	});
});

describe('WorkerSessionReclaimSchema', () => {
	it('accepts a uuid session id with a positive integer token', () => {
		const valid = { sessionId: '11111111-1111-4111-8111-111111111111', fencingToken: 2 };
		expect(WorkerSessionReclaimSchema.parse(valid)).toEqual(valid);
	});

	it('rejects a non-uuid session id or a non-positive/non-integer token', () => {
		expect(
			WorkerSessionReclaimSchema.safeParse({ sessionId: 'nope', fencingToken: 2 }).success,
		).toBe(false);
		const sessionId = '11111111-1111-4111-8111-111111111111';
		expect(WorkerSessionReclaimSchema.safeParse({ sessionId, fencingToken: 0 }).success).toBe(
			false,
		);
		expect(WorkerSessionReclaimSchema.safeParse({ sessionId, fencingToken: -1 }).success).toBe(
			false,
		);
		expect(WorkerSessionReclaimSchema.safeParse({ sessionId, fencingToken: 1.5 }).success).toBe(
			false,
		);
	});
});

describe('WorkerSessionHeldError', () => {
	it('names the contended worker and is a distinct type', () => {
		const err = new WorkerSessionHeldError('worker-9');
		expect(err).toBeInstanceOf(Error);
		expect(err.name).toBe('WorkerSessionHeldError');
		expect(err.workerId).toBe('worker-9');
		expect(err.message).toContain('worker-9');
	});
});
