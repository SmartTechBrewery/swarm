import { describe, expect, it } from 'vitest';

import type { AgentTarget } from '@/config/schema.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';
import {
	type EligibilityResult,
	evaluateWorkerEligibility,
	INELIGIBILITY_REASONS,
	IneligibilityReasonSchema,
	resolveTargetCli,
	type WorkerAvailability,
	type WorkerEligibilityInput,
} from '@/identity/worker-eligibility.js';
import {
	ENROLLMENT_STATUSES,
	isRoutable,
	type WorkerEnrollment,
} from '@/identity/worker-enrollment.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const ENROLLMENT_ID = '22222222-2222-4222-8222-222222222222';

function makeWorker(
	overrides: Partial<Worker> = {},
): Pick<Worker, 'capabilities' | 'supportedPhases'> {
	return {
		capabilities: ['claude', 'codex'],
		supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
		...overrides,
	};
}

function makeEnrollment(overrides: Partial<WorkerEnrollment> = {}): WorkerEnrollment {
	return {
		id: ENROLLMENT_ID,
		workerId: WORKER_ID,
		projectId: 'proj-alpha',
		status: 'active',
		allowedClis: ['claude', 'codex'],
		concurrencyAllocation: 1,
		sharingConsent: true,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

/** The all-clear input: every routing prerequisite satisfied. */
function makeInput(overrides: Partial<WorkerEligibilityInput> = {}): WorkerEligibilityInput {
	return {
		worker: makeWorker(),
		enrollment: makeEnrollment(),
		availability: { connected: true, activeRuns: 0 },
		target: { cli: 'claude' } satisfies AgentTarget,
		phaseDefaultCli: 'claude',
		phase: 'implementation',
		...overrides,
	};
}

function evaluate(overrides: Partial<WorkerEligibilityInput> = {}): EligibilityResult {
	return evaluateWorkerEligibility(makeInput(overrides));
}

describe('IneligibilityReasonSchema', () => {
	it('covers exactly the five predicate reasons', () => {
		expect(INELIGIBILITY_REASONS).toEqual([
			'missing-enrollment',
			'missing-consent',
			'worker-unavailable',
			'missing-phase-capability',
			'missing-cli-capability',
		]);
	});

	// Reserved for Phase 3's scheduler — a verdict about the assignee's whole set
	// of workers, not about the one worker this predicate judges.
	it('does not carry the scheduler-only assignee reason', () => {
		expect(IneligibilityReasonSchema.safeParse('assignee-worker-unavailable').success).toBe(false);
	});
});

describe('resolveTargetCli', () => {
	it("uses the target's own cli when it names one", () => {
		expect(resolveTargetCli({ cli: 'codex' }, 'claude')).toBe('codex');
	});

	it("falls back to the phase's coded default when the target omits a cli", () => {
		expect(resolveTargetCli({ model: 'sonnet' }, 'antigravity')).toBe('antigravity');
	});
});

describe('evaluateWorkerEligibility', () => {
	it('is eligible when every routing prerequisite is satisfied', () => {
		expect(evaluate()).toEqual({ eligible: true });
	});

	it('missing-enrollment when the worker has no enrollment for the project', () => {
		expect(evaluate({ enrollment: undefined })).toEqual({
			eligible: false,
			reason: 'missing-enrollment',
		});
	});

	it.each([
		'pending',
		'suspended',
	] as const)('missing-enrollment when the enrollment is %s', (status) => {
		expect(evaluate({ enrollment: makeEnrollment({ status }) })).toEqual({
			eligible: false,
			reason: 'missing-enrollment',
		});
	});

	it('missing-consent when the owner never granted (or revoked) sharing consent', () => {
		expect(evaluate({ enrollment: makeEnrollment({ sharingConsent: false }) })).toEqual({
			eligible: false,
			reason: 'missing-consent',
		});
	});

	it('worker-unavailable when the worker holds no live session', () => {
		expect(evaluate({ availability: { connected: false, activeRuns: 0 } })).toEqual({
			eligible: false,
			reason: 'worker-unavailable',
		});
	});

	it('worker-unavailable when the enrolled concurrency allocation is fully used', () => {
		const enrollment = makeEnrollment({ concurrencyAllocation: 2 });
		const availability: WorkerAvailability = { connected: true, activeRuns: 2 };
		expect(evaluate({ enrollment, availability })).toEqual({
			eligible: false,
			reason: 'worker-unavailable',
		});
	});

	it('is eligible while a slot of the allocation is still free', () => {
		const enrollment = makeEnrollment({ concurrencyAllocation: 2 });
		expect(evaluate({ enrollment, availability: { connected: true, activeRuns: 1 } })).toEqual({
			eligible: true,
		});
	});

	it('imposes no per-worker slot cap when the allocation is null', () => {
		// A null allocation means the enrollment adds no sub-limit: the worker
		// stays eligible however many runs it already has for this project (the
		// process-wide SWARM_WORKER_CONCURRENCY and the project cap bound it).
		const enrollment = makeEnrollment({ concurrencyAllocation: null });
		expect(evaluate({ enrollment, availability: { connected: true, activeRuns: 5 } })).toEqual({
			eligible: true,
		});
	});

	it('still reports worker-unavailable with a null allocation when disconnected', () => {
		// Null only removes the capacity check — a dead session is still unavailable.
		const enrollment = makeEnrollment({ concurrencyAllocation: null });
		expect(evaluate({ enrollment, availability: { connected: false, activeRuns: 0 } })).toEqual({
			eligible: false,
			reason: 'worker-unavailable',
		});
	});

	// Issue #467: a DB-free daemon declares every phase but `planning`, and the gate
	// must refuse it for that phase rather than letting the dispatch reach a worker
	// that answers with a terminal failure.
	it('missing-phase-capability when the worker did not declare the dispatched phase', () => {
		const worker = makeWorker({
			supportedPhases: ['implementation', 'review', 'respond-to-review', 'respond-to-ci'],
		});
		expect(evaluate({ worker, phase: 'planning' })).toEqual({
			eligible: false,
			reason: 'missing-phase-capability',
		});
	});

	it('is eligible for a phase the worker did declare, with the same narrowed set', () => {
		const worker = makeWorker({ supportedPhases: ['implementation'] });
		expect(evaluate({ worker, phase: 'implementation' })).toEqual({ eligible: true });
	});

	// Phase support is a property of the machine, the CLI one of the candidate target,
	// so the coarser check reports first — a worker missing both is described as unable
	// to run the phase rather than as missing a CLI it would never have reached.
	it('reports the phase before the CLI when the worker is missing both', () => {
		const worker = makeWorker({ capabilities: ['claude'], supportedPhases: ['implementation'] });
		expect(evaluate({ worker, phase: 'planning', target: { cli: 'codex' } })).toEqual({
			eligible: false,
			reason: 'missing-phase-capability',
		});
	});

	it('missing-cli-capability when the worker does not declare the target CLI', () => {
		const worker = makeWorker({ capabilities: ['claude'] });
		expect(evaluate({ worker, target: { cli: 'codex' } })).toEqual({
			eligible: false,
			reason: 'missing-cli-capability',
		});
	});

	it('missing-cli-capability when the enrollment does not allow the target CLI here', () => {
		// The worker can run codex, but this project's enrollment narrows it to claude.
		const enrollment = makeEnrollment({ allowedClis: ['claude'] });
		expect(evaluate({ enrollment, target: { cli: 'codex' } })).toEqual({
			eligible: false,
			reason: 'missing-cli-capability',
		});
	});

	describe('a target that omits its cli falls back to the phase coded default', () => {
		it('is eligible when the worker can run that default', () => {
			expect(evaluate({ target: {}, phaseDefaultCli: 'codex' })).toEqual({ eligible: true });
		});

		it('is missing-cli-capability when it cannot', () => {
			expect(evaluate({ target: { model: 'sonnet' }, phaseDefaultCli: 'antigravity' })).toEqual({
				eligible: false,
				reason: 'missing-cli-capability',
			});
		});
	});

	describe('the first missing signal wins (ADR-001 order)', () => {
		it('reports the enrollment before the consent, connection, or CLI', () => {
			const enrollment = makeEnrollment({
				status: 'suspended',
				sharingConsent: false,
				allowedClis: ['claude'],
			});
			expect(
				evaluate({
					enrollment,
					availability: { connected: false, activeRuns: 3 },
					target: { cli: 'codex' },
				}),
			).toEqual({ eligible: false, reason: 'missing-enrollment' });
		});

		it('reports the consent before the connection or capacity', () => {
			expect(
				evaluate({
					enrollment: makeEnrollment({ sharingConsent: false }),
					availability: { connected: false, activeRuns: 3 },
				}),
			).toEqual({ eligible: false, reason: 'missing-consent' });
		});

		it('reports the availability before the CLI capability', () => {
			const worker = makeWorker({ capabilities: ['claude'] });
			expect(
				evaluate({ worker, availability: { connected: false, activeRuns: 0 }, target: {} }),
			).toEqual({ eligible: false, reason: 'worker-unavailable' });
		});
	});

	// The enrollment half of the predicate must stay exactly `isRoutable` — the
	// named #337 seam — so a change to one can never silently let the other route
	// a suspended or non-consenting enrollment.
	describe('the enrollment checks agree with isRoutable', () => {
		it.each(
			ENROLLMENT_STATUSES.flatMap((status) =>
				[true, false].map((sharingConsent) => ({ status, sharingConsent })),
			),
		)('status=$status sharingConsent=$sharingConsent', ({ status, sharingConsent }) => {
			const enrollment = makeEnrollment({ status, sharingConsent });
			expect(evaluate({ enrollment }).eligible).toBe(isRoutable(enrollment));
		});
	});
});
