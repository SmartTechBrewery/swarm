import { describe, expect, it } from 'vitest';
import {
	jobContinuesPreservedCheckout,
	preservedCheckoutMachineUnknown,
	preservedContinuationKind,
} from '@/dispatch/preserved-worker.js';
import { createMockPmWebhookJob, createMockScmWebhookJob } from '../../helpers/factories.js';

// Issue #567. The predicate that decides whether a dispatch must be pinned to the
// machine holding its checkout. Getting it wrong in either direction is a real
// failure: too narrow and a continuation is silently redone elsewhere, too wide and
// an ordinary dispatch waits on a machine it does not need.
describe('jobContinuesPreservedCheckout', () => {
	it('is false for an ordinary dispatch that adopts nothing', () => {
		expect(jobContinuesPreservedCheckout(createMockPmWebhookJob())).toBe(false);
	});

	it('is true for an operator-driven session resume', () => {
		expect(jobContinuesPreservedCheckout(createMockPmWebhookJob({ recoveryMode: 'resume' }))).toBe(
			true,
		);
	});

	it('is true for a Tier 2 checkpoint continuation', () => {
		expect(
			jobContinuesPreservedCheckout(createMockPmWebhookJob({ recoveryMode: 'checkpoint' })),
		).toBe(true);
	});

	it('is true for the automatic retry that resumes a session', () => {
		// The shape the observed rate-limit deferral re-dispatches through: no
		// `recoveryMode` at all, just `resumeSession` off `deriveRetryJobPayload`.
		expect(jobContinuesPreservedCheckout(createMockPmWebhookJob({ resumeSession: true }))).toBe(
			true,
		);
	});

	it('is true for a delivery resume, which needs no agent session', () => {
		expect(jobContinuesPreservedCheckout(createMockScmWebhookJob({ resumeDelivery: true }))).toBe(
			true,
		);
	});

	it('is false for an explicit fresh start, even alongside a stale resume flag', () => {
		// `'fresh'` is the operator saying "reclaim the checkout and start over", which
		// is exactly the escape hatch from a pin — it must never be pinned itself.
		expect(
			jobContinuesPreservedCheckout(
				createMockPmWebhookJob({ recoveryMode: 'fresh', resumeSession: true }),
			),
		).toBe(false);
	});
});

// Issue #1138: names which continuation a transport-lost deferral carries, so the
// settle can keep the run row describing it.
describe('preservedContinuationKind', () => {
	it('names a Tier 2 checkpoint continuation', () => {
		expect(preservedContinuationKind(createMockPmWebhookJob({ recoveryMode: 'checkpoint' }))).toBe(
			'checkpoint',
		);
	});

	it('names an automatic and an operator-driven session resume', () => {
		expect(preservedContinuationKind(createMockPmWebhookJob({ resumeSession: true }))).toBe(
			'session',
		);
		expect(preservedContinuationKind(createMockPmWebhookJob({ recoveryMode: 'resume' }))).toBe(
			'session',
		);
	});

	it('names a delivery resume', () => {
		expect(preservedContinuationKind(createMockScmWebhookJob({ resumeDelivery: true }))).toBe(
			'delivery',
		);
	});

	it('is undefined for a job that is not a continuation', () => {
		expect(preservedContinuationKind(createMockPmWebhookJob())).toBeUndefined();
		expect(
			preservedContinuationKind(
				createMockPmWebhookJob({ recoveryMode: 'fresh', resumeSession: true }),
			),
		).toBeUndefined();
	});
});

// Issue #954's "machine unknown" verdict, shared by the worker's pin read and
// "Retry now" (issue #1101) so the two can never disagree about a row.
describe('preservedCheckoutMachineUnknown', () => {
	it('is true when the run bound a machine but recorded no pin', () => {
		expect(preservedCheckoutMachineUnknown({ workerId: 'w', recovery: null })).toBe(true);
		expect(preservedCheckoutMachineUnknown({ workerId: 'w', recovery: {} })).toBe(true);
	});

	it('is false when the run records the machine holding the checkout', () => {
		expect(
			preservedCheckoutMachineUnknown({ workerId: 'w', recovery: { preservedWorkerId: 'w' } }),
		).toBe(false);
	});

	it('is false for a run that never bound a machine, or no run at all', () => {
		expect(preservedCheckoutMachineUnknown({ workerId: null, recovery: null })).toBe(false);
		expect(preservedCheckoutMachineUnknown(undefined)).toBe(false);
	});
});
