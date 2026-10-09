import { describe, expect, it } from 'vitest';
import {
	AUTOMATIC_RETRY_POLICIES,
	automaticRetryPolicyFor,
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
