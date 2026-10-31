import { describe, expect, it } from 'vitest';
import {
	AUTOMATIC_RETRY_POLICIES,
	automaticRetryPolicyFor,
	PRESERVED_WORK_RETRY_POLICY,
	preservedWorkRetryPolicyFor,
} from '@/worker/automatic-retry-policy.js';

// Issue #1075: the one registry of failure types SWARM retries automatically after a
// delay of their own. Anything not listed keeps its old behaviour.
describe('automatic retry policy registry', () => {
	it('retries a lost worker transport after 30 minutes, at most twice', () => {
		expect(automaticRetryPolicyFor('transport-lost')).toEqual({
			delayMs: 30 * 60 * 1000,
			maxAttempts: 2,
			waitReason: 'transport-lost',
			label: "worker's connection lost",
		});
	});

	it('has no policy for a failure type outside the registry', () => {
		expect(automaticRetryPolicyFor('error')).toBeUndefined();
		expect(automaticRetryPolicyFor('auth')).toBeUndefined();
		expect(automaticRetryPolicyFor('rate-limit')).toBeUndefined();
		expect(automaticRetryPolicyFor('delivery')).toBeUndefined();
		expect(automaticRetryPolicyFor(undefined)).toBeUndefined();
	});

	it('starts with exactly one entry', () => {
		expect(Object.keys(AUTOMATIC_RETRY_POLICIES)).toEqual(['transport-lost']);
	});
});

// Issue #1257: the one automatic retry of a run that failed holding preserved work —
// keyed by what the failure leaves behind, not by its kind, and configurable per project.
describe('preserved-work retry policy', () => {
	it('retries once after 45 minutes, waiting on its own reason', () => {
		expect(PRESERVED_WORK_RETRY_POLICY).toMatchObject({
			delayMs: 45 * 60 * 1000,
			maxAttempts: 1,
			waitReason: 'preserved-work-retry',
		});
		expect(preservedWorkRetryPolicyFor({})).toBe(PRESERVED_WORK_RETRY_POLICY);
	});

	it("applies the project's own delay", () => {
		expect(
			preservedWorkRetryPolicyFor({ pipeline: { preservedWorkRetry: { delayMinutes: 30 } } }),
		).toEqual({ ...PRESERVED_WORK_RETRY_POLICY, delayMs: 30 * 60 * 1000 });
	});

	it('is off when the project turns it off', () => {
		expect(
			preservedWorkRetryPolicyFor({ pipeline: { preservedWorkRetry: { enabled: false } } }),
		).toBeUndefined();
	});
});
