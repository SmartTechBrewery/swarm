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
	DEFAULT_CONCURRENCY_ALLOCATION,
	ENROLLMENT_STATUSES,
	isRoutable,
	permitsPhase,
	type WorkerEnrollment,
} from '@/identity/worker-enrollment.js';
import { ALL_TRIGGER_PHASES } from '@/triggers/types.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const ENROLLMENT_ID = '22222222-2222-4222-8222-222222222222';

/** The task's repository, and the one the all-clear worker's checkout is (issue #714). */
const TASK_REPOSITORY = 'smarttechbrewery/swarm';

function makeWorker(
	overrides: Partial<Worker> = {},
): Pick<Worker, 'capabilities' | 'supportedPhases' | 'repository'> {
	return {
		capabilities: ['claude', 'codex'],
		supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
		repository: TASK_REPOSITORY,
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
		allowedPhases: [...ALL_TRIGGER_PHASES],
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
		repository: TASK_REPOSITORY,
		...overrides,
	};
}

function evaluate(overrides: Partial<WorkerEligibilityInput> = {}): EligibilityResult {
	return evaluateWorkerEligibility(makeInput(overrides));
}

describe('IneligibilityReasonSchema', () => {
	it('covers exactly the seven predicate reasons', () => {
		expect(INELIGIBILITY_REASONS).toEqual([
			'missing-enrollment',
			'missing-consent',
			'worker-unavailable',
			'repository-mismatch',
			'missing-phase-capability',
			'phase-not-permitted',
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

	it('gates on the default allocation of 1 — there is no uncapped enrollment (issue #480)', () => {
		// The capacity test lost its null case with #480: every enrollment states its
		// share of the project, so one active run already fills a default allocation
		// rather than the worker being bounded only by SWARM_WORKER_CONCURRENCY.
		const enrollment = makeEnrollment({
			concurrencyAllocation: DEFAULT_CONCURRENCY_ALLOCATION,
		});
		expect(evaluate({ enrollment, availability: { connected: true, activeRuns: 1 } })).toEqual({
			eligible: false,
			reason: 'worker-unavailable',
		});
	});

	it('lets a widened allocation take several of the project’s slots on one machine', () => {
		const enrollment = makeEnrollment({ concurrencyAllocation: 3 });
		expect(evaluate({ enrollment, availability: { connected: true, activeRuns: 2 } })).toEqual({
			eligible: true,
		});
	});

	// Issue #714. A worker holds exactly one checkout and declares which repository it
	// is at handshake (#687); a task for another repository can run no phase there at
	// all, so the gate must skip the machine rather than select it and have the worker
	// refuse the assignment terminally on arrival (#688).
	describe('the repository the machine’s checkout is (issue #714)', () => {
		it('repository-mismatch when the declared checkout is a different repository', () => {
			const worker = makeWorker({ repository: 'smarttechbrewery/other' });
			expect(evaluate({ worker })).toEqual({
				eligible: false,
				reason: 'repository-mismatch',
			});
		});

		it('is eligible when the declaration is the task’s repository', () => {
			expect(evaluate({ worker: makeWorker({ repository: TASK_REPOSITORY }) })).toEqual({
				eligible: true,
			});
		});

		// Both sides go through `repoSlugsMatch`, so a `ProjectConfig.repo` the operator
		// wrote with the host's casing and a `.git` suffix still matches the normalised
		// declaration the daemon sent.
		it('normalises both sides — casing and a trailing .git are noise', () => {
			const worker = makeWorker({ repository: 'smarttechbrewery/swarm' });
			expect(evaluate({ worker, repository: 'SmartTechBrewery/Swarm.git' })).toEqual({
				eligible: true,
			});
		});

		// An unidentifiable checkout must not become unroutable: the provision-time
		// `origin` check and #688's assignment refusal stay its guards, exactly as #690
		// decided for enrollment.
		it('does not refuse a worker that declared no repository', () => {
			expect(evaluate({ worker: makeWorker({ repository: null }) })).toEqual({ eligible: true });
		});

		// Connection and capacity stay ahead of the repository: "some worker is merely
		// busy or offline" is the best news available, and a machine that *does* hold this
		// repository but is offline must report that instead.
		it('does not preempt an earlier missing signal', () => {
			const worker = makeWorker({ repository: 'smarttechbrewery/other' });
			expect(evaluate({ worker, availability: { connected: false, activeRuns: 0 } })).toEqual({
				eligible: false,
				reason: 'worker-unavailable',
			});
		});

		// …but it is reported ahead of every capability, because a worker holding the
		// wrong tree can run no phase and no CLI for this task whatever it declares.
		it('reports the repository before the phase and the CLI', () => {
			const worker = makeWorker({
				repository: 'smarttechbrewery/other',
				capabilities: ['claude'],
				supportedPhases: ['implementation'],
			});
			expect(evaluate({ worker, phase: 'planning', target: { cli: 'codex' } })).toEqual({
				eligible: false,
				reason: 'repository-mismatch',
			});
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

	// Issue #509: the owner's per-project selection, judged as its own signal so the
	// message can point at the person who can widen it.
	it('phase-not-permitted when the enrollment does not allow the dispatched phase here', () => {
		const enrollment = makeEnrollment({ allowedPhases: ['implementation'] });
		expect(evaluate({ enrollment, phase: 'review' })).toEqual({
			eligible: false,
			reason: 'phase-not-permitted',
		});
	});

	it('is eligible for a phase the enrollment does allow, with the same narrowed set', () => {
		const enrollment = makeEnrollment({ allowedPhases: ['implementation'] });
		expect(evaluate({ enrollment, phase: 'implementation' })).toEqual({ eligible: true });
	});

	// The same worker, two projects: only the enrollment differs, so the verdict does.
	it('scopes the selection to the enrollment — one machine, different phases per project', () => {
		const worker = makeWorker();
		const inAlpha = makeEnrollment({ projectId: 'proj-alpha', allowedPhases: ['implementation'] });
		const inBeta = makeEnrollment({ projectId: 'proj-beta', allowedPhases: ['review'] });
		expect(evaluate({ worker, enrollment: inAlpha, phase: 'review' })).toEqual({
			eligible: false,
			reason: 'phase-not-permitted',
		});
		expect(evaluate({ worker, enrollment: inBeta, phase: 'review' })).toEqual({ eligible: true });
	});

	// The machine's declaration is the coarser, more fundamental fact, and its fix
	// belongs to whoever operates the machine rather than to the enrollment's owner.
	it('reports the machine’s missing declaration before the enrollment’s selection', () => {
		const worker = makeWorker({ supportedPhases: ['implementation'] });
		const enrollment = makeEnrollment({ allowedPhases: ['implementation'] });
		expect(evaluate({ worker, enrollment, phase: 'planning' })).toEqual({
			eligible: false,
			reason: 'missing-phase-capability',
		});
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

	// Likewise for the #509 seam: the phase half of the predicate must stay exactly
	// `permitsPhase` ANDed with the machine's own declaration, so neither can drift
	// into routing a phase the other refuses.
	describe('the phase checks agree with permitsPhase AND the declared repertoire', () => {
		it.each(ALL_TRIGGER_PHASES)('phase=%s', (phase) => {
			const worker = makeWorker({ supportedPhases: ['implementation', 'review'] });
			const enrollment = makeEnrollment({ allowedPhases: ['planning', 'implementation'] });
			expect(evaluate({ worker, enrollment, phase }).eligible).toBe(
				worker.supportedPhases.includes(phase) && permitsPhase(enrollment, phase),
			);
		});
	});
});
