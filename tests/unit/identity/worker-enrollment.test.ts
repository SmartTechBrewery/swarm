import { describe, expect, it } from 'vitest';

import {
	ConcurrencyAllocationSchema,
	DEFAULT_CONCURRENCY_ALLOCATION,
	ENROLLMENT_STATUSES,
	EnrollmentAllowedClisSchema,
	EnrollmentStatusSchema,
	isRoutable,
	WorkerEnrollmentSchema,
} from '@/identity/worker-enrollment.js';

const validEnrollment = {
	id: '11111111-1111-4111-8111-111111111111',
	workerId: '22222222-2222-4222-8222-222222222222',
	projectId: 'proj-alpha',
	status: 'active' as const,
	allowedClis: ['claude', 'codex'],
	concurrencyAllocation: 2,
	sharingConsent: true,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('EnrollmentStatusSchema', () => {
	it('accepts the three known statuses', () => {
		expect(ENROLLMENT_STATUSES).toEqual(['pending', 'active', 'suspended']);
		for (const status of ENROLLMENT_STATUSES) {
			expect(EnrollmentStatusSchema.parse(status)).toBe(status);
		}
	});

	it('rejects an unknown status', () => {
		expect(() => EnrollmentStatusSchema.parse('revoked')).toThrow();
	});
});

describe('EnrollmentAllowedClisSchema', () => {
	it('rejects an empty set', () => {
		expect(() => EnrollmentAllowedClisSchema.parse([])).toThrow();
	});

	it('de-duplicates repeated CLIs', () => {
		expect(EnrollmentAllowedClisSchema.parse(['claude', 'claude', 'codex'])).toEqual([
			'claude',
			'codex',
		]);
	});

	it('rejects an unknown CLI', () => {
		expect(() => EnrollmentAllowedClisSchema.parse(['claude', 'copilot'])).toThrow();
	});
});

describe('ConcurrencyAllocationSchema', () => {
	it('accepts a positive integer', () => {
		expect(ConcurrencyAllocationSchema.parse(3)).toBe(3);
	});

	it('rejects zero, negatives, and non-integers', () => {
		expect(() => ConcurrencyAllocationSchema.parse(0)).toThrow();
		expect(() => ConcurrencyAllocationSchema.parse(-1)).toThrow();
		expect(() => ConcurrencyAllocationSchema.parse(1.5)).toThrow();
	});

	it('has no "unbounded" value — null is not an allocation (issue #480)', () => {
		expect(() => ConcurrencyAllocationSchema.parse(null)).toThrow();
	});

	it('defaults to 1, matching the other concurrency defaults', () => {
		expect(DEFAULT_CONCURRENCY_ALLOCATION).toBe(1);
		expect(ConcurrencyAllocationSchema.parse(DEFAULT_CONCURRENCY_ALLOCATION)).toBe(1);
	});
});

describe('WorkerEnrollmentSchema', () => {
	it('round-trips a valid enrollment', () => {
		expect(WorkerEnrollmentSchema.parse(validEnrollment)).toEqual(validEnrollment);
	});

	it('rejects a non-uuid id and workerId', () => {
		expect(() => WorkerEnrollmentSchema.parse({ ...validEnrollment, id: 'nope' })).toThrow();
		expect(() => WorkerEnrollmentSchema.parse({ ...validEnrollment, workerId: 'nope' })).toThrow();
	});

	it('rejects an empty projectId', () => {
		expect(() => WorkerEnrollmentSchema.parse({ ...validEnrollment, projectId: '' })).toThrow();
	});

	it('rejects a non-positive concurrency allocation', () => {
		expect(() =>
			WorkerEnrollmentSchema.parse({ ...validEnrollment, concurrencyAllocation: 0 }),
		).toThrow();
	});

	it('rejects a null or missing concurrency allocation (issue #480)', () => {
		expect(() =>
			WorkerEnrollmentSchema.parse({ ...validEnrollment, concurrencyAllocation: null }),
		).toThrow();
		const { concurrencyAllocation: _omitted, ...withoutAllocation } = validEnrollment;
		expect(() => WorkerEnrollmentSchema.parse(withoutAllocation)).toThrow();
	});

	it('has no secret field in the read model', () => {
		const parsed = WorkerEnrollmentSchema.parse(validEnrollment);
		expect(parsed).not.toHaveProperty('credentialHash');
		expect(parsed).not.toHaveProperty('credential');
	});
});

describe('isRoutable — the #130 seam', () => {
	// The full truth table: routable ONLY when active AND sharing consent is on.
	it.each([
		{ status: 'active' as const, sharingConsent: true, expected: true },
		{ status: 'active' as const, sharingConsent: false, expected: false },
		{ status: 'pending' as const, sharingConsent: true, expected: false },
		{ status: 'pending' as const, sharingConsent: false, expected: false },
		{ status: 'suspended' as const, sharingConsent: true, expected: false },
		{ status: 'suspended' as const, sharingConsent: false, expected: false },
	])('status=$status sharingConsent=$sharingConsent → $expected', ({
		status,
		sharingConsent,
		expected,
	}) => {
		expect(isRoutable({ status, sharingConsent })).toBe(expected);
	});

	it('revoking sharing consent flips an active+consenting enrollment to not routable', () => {
		expect(isRoutable({ status: 'active', sharingConsent: true })).toBe(true);
		expect(isRoutable({ status: 'active', sharingConsent: false })).toBe(false);
	});

	it('suspending an active+consenting enrollment flips it to not routable', () => {
		expect(isRoutable({ status: 'active', sharingConsent: true })).toBe(true);
		expect(isRoutable({ status: 'suspended', sharingConsent: true })).toBe(false);
	});
});
