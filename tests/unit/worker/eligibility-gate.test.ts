import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTarget } from '@/config/schema.js';
import type { ResolvedAssignee } from '@/identity/assignee-resolver.js';
import type { SwarmUser } from '@/identity/schema.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';
import type { WorkerEnrollment } from '@/identity/worker-enrollment.js';
import type { WorkerDispatchCandidate } from '@/identity/worker-enrollment-service.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import { SUPPORTED_DB_FREE_PHASES } from '@/transport/assignment-execution.js';
import { ALL_TRIGGER_PHASES } from '@/triggers/types.js';

// The gate's two DB-backed collaborators are mocked at their module boundary
// (ai/TESTING.md): the project's enrolled workers and the assignee → SWARM user
// link. Everything else in the gate is pure policy, which is what these assert.
const listProjectDispatchCandidates = vi.fn<
	(projectId: string) => Promise<WorkerDispatchCandidate[]>
>(async () => []);
vi.mock('@/identity/worker-enrollment-service.js', () => ({
	listProjectDispatchCandidates: (projectId: string) => listProjectDispatchCandidates(projectId),
}));

const resolveAssignedUser = vi.fn<
	(workItem: Pick<WorkItem, 'assignees'>, provider: string) => Promise<ResolvedAssignee | undefined>
>(async () => undefined);
vi.mock('@/identity/assignee-resolver.js', () => ({
	resolveAssignedUser: (workItem: Pick<WorkItem, 'assignees'>, provider: string) =>
		resolveAssignedUser(workItem, provider),
}));

import {
	DISPATCH_INELIGIBILITY_REASONS,
	type DispatchGateInput,
	type DispatchIneligibilityReason,
	evaluateDispatchEligibility,
	isAffinityGatedPhase,
	isAvailabilityRefusal,
	type RunnableDispatchDemand,
} from '@/worker/eligibility-gate.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

/** The task's repository — the scoped project's own entry (issues #684, #714). */
const REPOSITORY = 'smarttechbrewery/swarm';
/** A second repository of the same project, held by a different machine. */
const OTHER_REPOSITORY = 'smarttechbrewery/dashboard';

/** The PM provider seam the gate reads — only these two fields. */
const PM = { type: 'github-projects', supportsAssignees: true } as Pick<
	PMProvider,
	'type' | 'supportsAssignees'
>;

function makeCandidate(
	id: string,
	overrides: {
		ownerUserId?: string;
		capabilities?: Worker['capabilities'];
		supportedPhases?: Worker['supportedPhases'];
		repository?: Worker['repository'];
		enrollment?: Partial<WorkerEnrollment>;
		connected?: boolean;
		activeRuns?: number;
	} = {},
): WorkerDispatchCandidate {
	return {
		worker: {
			id,
			ownerUserId: overrides.ownerUserId ?? ALICE,
			displayName: `worker-${id}`,
			capabilities: overrides.capabilities ?? ['claude'],
			// No declaration (issue #783), so the probe is the effective set.
			probedCapabilities: overrides.capabilities ?? ['claude'],
			declaredCapabilities: null,
			supportedPhases: overrides.supportedPhases ?? [...DEFAULT_WORKER_SUPPORTED_PHASES],
			// A single-repository project, which is the regression bar for every case in this
			// file that says nothing about repositories: the declared checkout always is the
			// task's, so the #714 check is satisfied rather than merely skipped.
			repository: overrides.repository === undefined ? REPOSITORY : overrides.repository,
			createdAt: new Date('2026-01-01T00:00:00Z'),
			updatedAt: new Date('2026-01-01T00:00:00Z'),
		},
		enrollment: {
			id: `enr-${id}`,
			workerId: id,
			projectId: 'swarm',
			status: 'active',
			allowedClis: overrides.capabilities ?? ['claude'],
			allowedPhases: [...ALL_TRIGGER_PHASES],
			concurrencyAllocation: 1,
			// The gate reads the project's worker order as the *candidate list's* order
			// (issue #750) — `listProjectDispatchCandidates` has already applied it — so
			// the stored position is irrelevant here and every candidate carries the same.
			orderIndex: 0,
			sharingConsent: true,
			createdAt: new Date('2026-01-01T00:00:00Z'),
			updatedAt: new Date('2026-01-01T00:00:00Z'),
			...overrides.enrollment,
		},
		availability: {
			connected: overrides.connected ?? true,
			activeRuns: overrides.activeRuns ?? 0,
		},
	};
}

function assignedTo(userId: string, handle = 'octocat'): ResolvedAssignee {
	return {
		user: { id: userId, identifier: handle, displayName: handle } as SwarmUser,
		assignee: { handle },
	};
}

const ASSIGNED_ITEM: Pick<WorkItem, 'assignees'> = { assignees: [{ handle: 'octocat' }] };

function gateInput(overrides: Partial<DispatchGateInput> = {}): DispatchGateInput {
	return {
		projectId: 'swarm',
		repository: REPOSITORY,
		targets: [{}] satisfies AgentTarget[],
		phaseDefaultCli: 'claude',
		phase: 'implementation',
		...overrides,
	};
}

/** A DB-free remote daemon: every phase it can run — all six, since issue #536. */
const DB_FREE_PHASES: Worker['supportedPhases'] = [...SUPPORTED_DB_FREE_PHASES];

/**
 * What a DB-free daemon built **before** issue #536 declares — the five phases that
 * ran without a database back when `planning` needed one. Nothing in production
 * narrows this set on purpose any more, but the machine-declaration gate exists
 * precisely for version skew (a worker row is re-declared only when that daemon
 * reconnects), so the #467/#469 policy composition is pinned against this fixture
 * rather than against whatever `SUPPORTED_DB_FREE_PHASES` happens to hold.
 */
const LEGACY_DB_FREE_PHASES: Worker['supportedPhases'] = [
	'respond-to-ci',
	'resolve-conflicts',
	'implementation',
	'review',
	'respond-to-review',
];

// Issue #469. Stated as its own contract because the set is a policy decision, not
// an implementation detail: which phases route to their assignee's own machine.
describe('isAffinityGatedPhase', () => {
	it('gates implementation, the phase that writes source on the owner’s machine', () => {
		expect(isAffinityGatedPhase('implementation')).toBe(true);
	});

	it('does not gate planning, which belongs to no particular machine', () => {
		expect(isAffinityGatedPhase('planning')).toBe(false);
	});

	it('does not gate the PR-driven phases, which carry no assignee', () => {
		for (const phase of [
			'review',
			'respond-to-review',
			'respond-to-ci',
			'resolve-conflicts',
		] as const) {
			expect(isAffinityGatedPhase(phase)).toBe(false);
		}
	});
});

// Issue #607. The classification the dispatch row records, asserted over the whole
// refusal vocabulary: which waits clear by themselves and which need a human. Stated
// as two explicit lists so a reason added to the union fails *here* as well as at the
// type level, rather than being silently absorbed into whichever bucket it defaults to.
describe('isAvailabilityRefusal', () => {
	/** Every structural check passed; the machine is busy, offline, or the pinned one. */
	const AVAILABILITY: readonly DispatchIneligibilityReason[] = [
		'worker-unavailable',
		'assignee-worker-unavailable',
		'preserved-worker-unavailable',
	];
	/** Nothing a connecting machine can change — a human must act. */
	const AUTHORIZATION: readonly DispatchIneligibilityReason[] = [
		'missing-enrollment',
		'missing-consent',
		'missing-phase-capability',
		'phase-not-permitted',
		'missing-cli-capability',
		// Issue #714: a checkout is re-declared only at handshake, so no machine coming
		// online clears this — somebody has to point a worker at the repository.
		'repository-mismatch',
	];

	it('classifies every reason in the union, and no reason twice', () => {
		expect([...AVAILABILITY, ...AUTHORIZATION].sort()).toEqual(
			[...DISPATCH_INELIGIBILITY_REASONS].sort(),
		);
	});

	it('treats a machine that is merely busy, offline, or pinned as an availability wait', () => {
		for (const reason of AVAILABILITY) {
			expect(isAvailabilityRefusal(reason), reason).toBe(true);
		}
	});

	it('treats a refusal only a human can clear as something else entirely', () => {
		for (const reason of AUTHORIZATION) {
			expect(isAvailabilityRefusal(reason), reason).toBe(false);
		}
	});
});

describe('evaluateDispatchEligibility', () => {
	beforeEach(() => {
		listProjectDispatchCandidates.mockClear();
		listProjectDispatchCandidates.mockResolvedValue([]);
		resolveAssignedUser.mockClear();
		resolveAssignedUser.mockResolvedValue(undefined);
	});

	it('reports an unfederated project when nothing is enrolled', async () => {
		// The single-local-worker MVP: no enrollments means no other user's machine
		// is involved, so the local worker keeps running every phase.
		expect(await evaluateDispatchEligibility(gateInput())).toEqual({ status: 'unfederated' });
		expect(resolveAssignedUser).not.toHaveBeenCalled();
	});

	// Issue #750 — `listProjectDispatchCandidates` hands the gate the project's
	// configured worker order, so preferring workers in that order is the candidate
	// walk itself. What matters here is the boundary: the order decides *between*
	// eligible workers and never promotes an ineligible one.
	describe('the project’s configured worker order (issue #750)', () => {
		it('prefers the earliest worker in the project order when several are eligible', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-first'),
				makeCandidate('w-second'),
				makeCandidate('w-third'),
			]);

			const decision = await evaluateDispatchEligibility(gateInput());

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-first' } });
		});

		// The same three-worker project with the front-runner ineligible for each of the
		// reasons an operator can actually produce: the next eligible worker takes it,
		// rather than the dispatch waiting for the preferred machine.
		it.each([
			['disconnected', { connected: false }],
			['at its allocated capacity', { activeRuns: 1 }],
			['suspended', { enrollment: { status: 'suspended' as const } }],
			['awaiting approval', { enrollment: { status: 'pending' as const } }],
			['without sharing consent', { enrollment: { sharingConsent: false } }],
			['not allowed the phase here', { enrollment: { allowedPhases: ['review' as const] } }],
			['unable to run any configured CLI', { capabilities: ['codex' as const] }],
		])('skips the first worker when it is %s, taking the next eligible one', async (_why, ineligible) => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-first', ineligible),
				makeCandidate('w-second'),
				makeCandidate('w-third'),
			]);

			const decision = await evaluateDispatchEligibility(gateInput());

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-second' } });
		});
	});

	describe('unassigned items', () => {
		it('routes to the first free eligible worker in the project’s worker order', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-busy', { activeRuns: 1 }),
				makeCandidate('w-free'),
				makeCandidate('w-also-free'),
			]);

			const decision = await evaluateDispatchEligibility(gateInput());

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-free', assignedUserId: undefined },
			});
		});

		it('takes the unassigned path when no assignee is linked to a SWARM user', async () => {
			// ADR-001 open question 5: an unlinked handle resolves to nothing, which
			// the gate treats as unassigned rather than wedging the project.
			listProjectDispatchCandidates.mockResolvedValue([makeCandidate('w-1', { ownerUserId: BOB })]);
			resolveAssignedUser.mockResolvedValue(undefined);

			const decision = await evaluateDispatchEligibility(
				gateInput({ workItem: ASSIGNED_ITEM, pm: PM }),
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-1' } });
		});
	});

	describe('assignee affinity', () => {
		it('routes only to a worker owned by the assignee', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-bob', { ownerUserId: BOB }),
				makeCandidate('w-alice', { ownerUserId: ALICE }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));

			const decision = await evaluateDispatchEligibility(
				gateInput({ workItem: ASSIGNED_ITEM, pm: PM }),
			);

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-alice', ownerUserId: ALICE, assignedUserId: ALICE },
			});
		});

		it('picks a free worker among several owned by the assignee', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-a1', { activeRuns: 1 }),
				makeCandidate('w-a2'),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));

			const decision = await evaluateDispatchEligibility(
				gateInput({ workItem: ASSIGNED_ITEM, pm: PM }),
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-a2' } });
		});

		it('defers as assignee-worker-unavailable when every worker of the assignee is busy', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-a1', { activeRuns: 1 }),
				makeCandidate('w-a2', { connected: false }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));

			const decision = await evaluateDispatchEligibility(
				gateInput({ workItem: ASSIGNED_ITEM, pm: PM }),
			);

			expect(decision).toMatchObject({
				status: 'ineligible',
				reason: 'assignee-worker-unavailable',
			});
		});

		// Issue #469 — the bug this closes. Affinity is a hard rule with no cross-user
		// fallback, while the ability to run `planning` is deliberately not distributed
		// (a DB-free worker refuses it). Applied to Planning, the two composed into work
		// that could never run at all, so Planning is no longer affinity-gated.
		it('routes planning to another user’s worker despite the assignment', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-bob', { ownerUserId: BOB }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));

			const decision = await evaluateDispatchEligibility(
				gateInput({ phase: 'planning', workItem: ASSIGNED_ITEM, pm: PM }),
			);

			// The same fixture is `ineligible` for implementation (the test below it).
			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-bob' },
			});
		});

		// The literal production shape from #469, with both rules composed in one case:
		// the assignee's only machine is a DB-free worker that refuses `planning`, and the
		// DB-capable one belongs to somebody else. Before the fix this item could never be
		// planned; the two assertions below pin each half of the policy against the *same*
		// fixture, so a change to either the phase-capability filter or the affinity
		// predicate cannot silently re-open it.
		it('plans an item whose assignee owns only a worker that cannot plan', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-db-free', { ownerUserId: ALICE, supportedPhases: LEGACY_DB_FREE_PHASES }),
				makeCandidate('w-host', { ownerUserId: BOB }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));

			const decision = await evaluateDispatchEligibility(
				gateInput({ phase: 'planning', workItem: ASSIGNED_ITEM, pm: PM }),
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-host' } });
		});

		it('still holds the assignee to their own worker for implementation on that fixture', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-db-free', { ownerUserId: ALICE, supportedPhases: LEGACY_DB_FREE_PHASES }),
				makeCandidate('w-host', { ownerUserId: BOB }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));

			// Implementation is in `SUPPORTED_DB_FREE_PHASES`, so Alice's own worker takes it
			// — Bob's is never considered. The exemption is Planning's alone.
			const decision = await evaluateDispatchEligibility(
				gateInput({ phase: 'implementation', workItem: ASSIGNED_ITEM, pm: PM }),
			);

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-db-free', assignedUserId: ALICE },
			});
		});

		it('records no assignedUserId on a planning selection', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-alice', { ownerUserId: ALICE }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));

			const decision = await evaluateDispatchEligibility(
				gateInput({ phase: 'planning', workItem: ASSIGNED_ITEM, pm: PM }),
			);

			// Downstream (`bindSelectedWorker`) reads this to decide between
			// `assignee-worker-unavailable` and `worker-unavailable`. A central phase is
			// not waiting for the assignee's machine, so it must not claim to be.
			if (decision.status !== 'selected') throw new Error('unreachable');
			expect(decision.selection.assignedUserId).toBeUndefined();
		});

		it('does not even resolve the assignee for planning', async () => {
			listProjectDispatchCandidates.mockResolvedValue([makeCandidate('w-alice')]);

			await evaluateDispatchEligibility(
				gateInput({ phase: 'planning', workItem: ASSIGNED_ITEM, pm: PM }),
			);

			// Resolving is what *applies* affinity; skipping it is what keeps every
			// downstream consequence consistent rather than resolving and ignoring it.
			expect(resolveAssignedUser).not.toHaveBeenCalled();
		});

		it('plans an item whose assignee owns no enrolled worker at all', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-bob', { ownerUserId: BOB }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));

			const decision = await evaluateDispatchEligibility(
				gateInput({ phase: 'planning', workItem: ASSIGNED_ITEM, pm: PM }),
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-bob' } });
		});

		it('refuses a busy planning dispatch as worker-unavailable, never assignee-worker-unavailable', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-a1', { activeRuns: 1 }),
				makeCandidate('w-a2', { connected: false }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));

			const decision = await evaluateDispatchEligibility(
				gateInput({ phase: 'planning', workItem: ASSIGNED_ITEM, pm: PM }),
			);

			expect(decision).toMatchObject({ status: 'ineligible', reason: 'worker-unavailable' });
			if (decision.status !== 'ineligible') throw new Error('unreachable');
			// The message frames the wait around the project, not the assignee.
			expect(decision.message).not.toContain('octocat');
		});

		it('never falls back to another user’s free worker', async () => {
			// The core ADR-001 rule: assignment is execution affinity, so a free
			// worker owned by someone else must not take the item.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-bob', { ownerUserId: BOB }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));

			const decision = await evaluateDispatchEligibility(
				gateInput({ workItem: ASSIGNED_ITEM, pm: PM }),
			);

			expect(decision).toMatchObject({
				status: 'ineligible',
				reason: 'assignee-worker-unavailable',
			});
			if (decision.status !== 'ineligible') throw new Error('unreachable');
			expect(decision.message).toContain('octocat');
		});

		it('picks up a reassignment on the next dispatch', async () => {
			// The gate re-resolves the assignee on every (re)dispatch, so a retry
			// after a reassignment routes to the new assignee's worker.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-alice', { ownerUserId: ALICE }),
				makeCandidate('w-bob', { ownerUserId: BOB }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));
			const first = await evaluateDispatchEligibility(
				gateInput({ workItem: ASSIGNED_ITEM, pm: PM }),
			);
			expect(first).toMatchObject({ status: 'selected', selection: { workerId: 'w-alice' } });

			resolveAssignedUser.mockResolvedValue(assignedTo(BOB, 'hubot'));
			const retry = await evaluateDispatchEligibility(
				gateInput({ workItem: ASSIGNED_ITEM, pm: PM }),
			);

			expect(retry).toMatchObject({ status: 'selected', selection: { workerId: 'w-bob' } });
		});

		it('ignores assignees for a provider that has no assignee concept', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-bob', { ownerUserId: BOB }),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({
					workItem: ASSIGNED_ITEM,
					// A future provider with no assignee concept opts out through this
					// capability flag (`PMProvider.supportsAssignees`), not by type.
					pm: { ...PM, supportsAssignees: false },
				}),
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-bob' } });
			expect(resolveAssignedUser).not.toHaveBeenCalled();
		});
	});

	describe('structured refusal reasons', () => {
		it('reports revoked sharing consent, naming the fix', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-1', { enrollment: { sharingConsent: false } }),
			]);

			const decision = await evaluateDispatchEligibility(gateInput());

			expect(decision).toMatchObject({ status: 'ineligible', reason: 'missing-consent' });
			if (decision.status !== 'ineligible') throw new Error('unreachable');
			expect(decision.message).toContain('sharing consent');
		});

		it('reports an enrollment still awaiting approval', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-1', { enrollment: { status: 'pending' } }),
			]);

			expect(await evaluateDispatchEligibility(gateInput())).toMatchObject({
				status: 'ineligible',
				reason: 'missing-enrollment',
			});
		});

		it('reports a missing CLI capability and names the configured CLIs', async () => {
			listProjectDispatchCandidates.mockResolvedValue([makeCandidate('w-1')]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ targets: [{ cli: 'codex' }] }),
			);

			expect(decision).toMatchObject({ status: 'ineligible', reason: 'missing-cli-capability' });
			if (decision.status !== 'ineligible') throw new Error('unreachable');
			expect(decision.message).toContain('codex');
		});

		it('prefers the transient reason when some worker cleared every structural check', async () => {
			// One worker is merely busy while another is structurally blocked: waiting
			// is the truthful answer, so the busy worker's reason wins.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-unenrolled', { enrollment: { status: 'suspended' } }),
				makeCandidate('w-busy', { activeRuns: 1 }),
			]);

			expect(await evaluateDispatchEligibility(gateInput())).toMatchObject({
				status: 'ineligible',
				reason: 'worker-unavailable',
			});
		});
	});

	// Issue #567. A continuation's state — a Tier 2 checkpoint, a resumable session,
	// a delivery sidecar — is machine-local, so routing it anywhere but the machine
	// that holds it silently redoes the work. These pin the narrowing itself; the
	// wait it produces is unbounded by `deferWorkerIneligible`.
	describe('preserved-checkout pin', () => {
		it('routes a continuation only to the machine holding its checkout', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-free'),
				makeCandidate('w-preserved'),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ preservedWorker: { id: 'w-preserved', name: 'm3_pro_tp' } }),
			);

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-preserved', pinnedToPreservedWorker: true },
			});
		});

		it('waits for the pinned machine rather than taking a free one, naming it', async () => {
			// The observed failure: the pinned machine is busy and another worker is
			// idle and eligible. Every other worker is irrelevant — the state is not
			// on them — so this must refuse rather than select.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-free'),
				makeCandidate('w-preserved', { activeRuns: 1 }),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ preservedWorker: { id: 'w-preserved', name: 'm3_pro_tp' } }),
			);

			expect(decision).toMatchObject({
				status: 'ineligible',
				reason: 'preserved-worker-unavailable',
			});
			if (decision.status !== 'ineligible') throw new Error('unreachable');
			expect(decision.message).toContain('m3_pro_tp');
			expect(decision.message).toContain('Reset & restart');
		});

		it('waits for a pinned machine that is no longer an enrolled candidate at all', async () => {
			listProjectDispatchCandidates.mockResolvedValue([makeCandidate('w-free')]);

			expect(
				await evaluateDispatchEligibility(gateInput({ preservedWorker: { id: 'w-gone' } })),
			).toMatchObject({ status: 'ineligible', reason: 'preserved-worker-unavailable' });
		});

		it('names the machine by id when its display name could not be resolved', async () => {
			listProjectDispatchCandidates.mockResolvedValue([makeCandidate('w-free')]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ preservedWorker: { id: 'w-gone' } }),
			);

			if (decision.status !== 'ineligible') throw new Error('unreachable');
			expect(decision.message).toContain('w-gone');
		});

		it('keeps a structural refusal from the pinned machine actionable and its own', async () => {
			// Only "busy or offline" becomes the unbounded wait. Revoked consent names
			// something an operator must fix and will not resolve on its own, so it
			// keeps its own reason — and therefore its own bounded budget.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-preserved', { enrollment: { sharingConsent: false } }),
			]);

			expect(
				await evaluateDispatchEligibility(gateInput({ preservedWorker: { id: 'w-preserved' } })),
			).toMatchObject({ status: 'ineligible', reason: 'missing-consent' });
		});

		it('outranks assignee affinity when the two disagree', async () => {
			// The item was reassigned after the checkout was preserved. Intersecting the
			// two narrowings would wait forever for a machine that cannot hold the
			// state; the preserved machine is the only one that can continue this run.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-preserved', { ownerUserId: BOB }),
				makeCandidate('w-assignee', { ownerUserId: ALICE }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));

			expect(
				await evaluateDispatchEligibility(
					gateInput({
						workItem: ASSIGNED_ITEM,
						pm: PM,
						preservedWorker: { id: 'w-preserved' },
					}),
				),
			).toMatchObject({ status: 'selected', selection: { workerId: 'w-preserved' } });
		});

		it('leaves an unpinned dispatch routing exactly as before', async () => {
			listProjectDispatchCandidates.mockResolvedValue([makeCandidate('w-1')]);

			expect(await evaluateDispatchEligibility(gateInput())).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-1', pinnedToPreservedWorker: false },
			});
		});
	});

	describe('ordered model targets (issues #345/#346)', () => {
		it('prefers a higher-priority target a worker can run over a free worker on a lower one', async () => {
			// The addendum's case: a free claude-only worker must not win the
			// lower-priority claude target while a codex worker can serve the
			// higher-priority codex target.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-claude', { capabilities: ['claude'] }),
				makeCandidate('w-codex', { capabilities: ['codex'] }),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ targets: [{ cli: 'codex' }, { cli: 'claude' }] }),
			);

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-codex', targetIndex: 0, cli: 'codex', skippedClis: [] },
			});
		});

		it('falls to a lower-priority target when no worker can serve the preferred one', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-claude', { capabilities: ['claude'] }),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ targets: [{ cli: 'codex' }, { cli: 'claude', model: 'sonnet' }] }),
			);

			expect(decision).toMatchObject({
				status: 'selected',
				selection: {
					workerId: 'w-claude',
					targetIndex: 1,
					cli: 'claude',
					target: { cli: 'claude', model: 'sonnet' },
					skippedClis: ['codex'],
				},
			});
		});

		it('honours the enrollment’s allowed CLIs, not only the worker’s capabilities', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-1', {
					capabilities: ['claude', 'codex'],
					enrollment: { allowedClis: ['claude'] },
				}),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ targets: [{ cli: 'codex' }, { cli: 'claude' }] }),
			);

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { targetIndex: 1, cli: 'claude' },
			});
		});

		it('refuses rather than falling back to targets[0] when no worker can run any target', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-1', { capabilities: ['claude'] }),
			]);

			expect(
				await evaluateDispatchEligibility(gateInput({ targets: [{ cli: 'codex' }] })),
			).toMatchObject({ status: 'ineligible', reason: 'missing-cli-capability' });
		});

		it('resolves a target with no cli against the phase’s coded default', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-1', { capabilities: ['codex'] }),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ targets: [{}], phaseDefaultCli: 'codex' }),
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { cli: 'codex' } });
		});
	});

	// Issue #714. A machine holds one checkout, so a task for another repository can run
	// no phase on it. The gate skips such a machine up front rather than selecting it,
	// claiming it, and having the worker refuse the assignment terminally (issue #688).
	describe('the task’s repository (issue #714)', () => {
		it('selects the machine whose checkout is the task’s repository', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-other', { repository: OTHER_REPOSITORY }),
				makeCandidate('w-mine', { repository: REPOSITORY }),
			]);

			const decision = await evaluateDispatchEligibility(gateInput());

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-mine' } });
		});

		it('refuses with repository-mismatch when no machine holds it', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-other', { repository: OTHER_REPOSITORY }),
				makeCandidate('w-third', { repository: 'smarttechbrewery/cascade' }),
			]);

			const decision = await evaluateDispatchEligibility(gateInput());

			expect(decision).toMatchObject({ status: 'ineligible', reason: 'repository-mismatch' });
			if (decision.status !== 'ineligible') throw new Error('unreachable');
			// The wait needs a human — a machine connecting cannot re-point a checkout — so
			// the deferral records `worker-authorization` rather than `worker-eligibility`.
			expect(isAvailabilityRefusal(decision.reason)).toBe(false);
			// And the message names the repository plus the action that ends the wait.
			expect(decision.message).toContain(REPOSITORY);
			expect(decision.message).toContain('SWARM_WORKER_REPO_ROOT');
		});

		it('still reports worker-unavailable while a matching machine is merely busy', async () => {
			// The best news available wins: one machine does hold this repository and is only
			// occupied, so the wait clears by itself and must not read as an authorization one.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-other', { repository: OTHER_REPOSITORY }),
				makeCandidate('w-mine-busy', { repository: REPOSITORY, activeRuns: 1 }),
			]);

			const decision = await evaluateDispatchEligibility(gateInput());

			expect(decision).toMatchObject({ status: 'ineligible', reason: 'worker-unavailable' });
		});

		it('keeps a machine that declared no repository selectable', async () => {
			// An unidentifiable checkout must not become unroutable (issues #688, #690): the
			// provision-time `origin` check is still its guard.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-other', { repository: OTHER_REPOSITORY }),
				makeCandidate('w-undeclared', { repository: null }),
			]);

			const decision = await evaluateDispatchEligibility(gateInput());

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-undeclared' },
			});
		});
	});

	// Issue #533. The gate judges one dispatch, but the project runs several at once,
	// so "the first eligible worker" can spend a capability another runnable phase
	// uniquely needs. These pin the pool policy *and* its limits: it reorders the
	// preference between eligible workers, and nothing more.
	describe('pool-aware worker selection (issue #533)', () => {
		/** Every phase but the scarce one, for the machine that cannot plan. */
		const WITHOUT_PLANNING = ALL_TRIGGER_PHASES.filter((phase) => phase !== 'planning');

		/** The incident's fleet: only `w-a` can plan; either machine can review. */
		function planningScarceFleet(): WorkerDispatchCandidate[] {
			return [makeCandidate('w-a'), makeCandidate('w-b', { supportedPhases: WITHOUT_PLANNING })];
		}

		/** One other runnable dispatch, in the shape the caller reads off the dispatch rows. */
		function demand(
			dispatchId: string,
			phase: DispatchGateInput['phase'],
			repository: string | undefined = REPOSITORY,
		): RunnableDispatchDemand {
			return { dispatchId, phase, targets: [{}], phaseDefaultCli: 'claude', repository };
		}

		it('leaves the only planning-capable worker free for a runnable planning dispatch', async () => {
			listProjectDispatchCandidates.mockResolvedValue(planningScarceFleet());
			// Review is ranked first — the arrival order that produced the incident, in
			// which taking `w-a` left Planning with nowhere to run.
			const loadPoolDemands = vi.fn(async () => [
				demand('d-review', 'review'),
				demand('d-planning', 'planning'),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ dispatchId: 'd-review', phase: 'review' }),
				{ loadPoolDemands },
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-b' } });
		});

		it('reaches the same assignment when the planning dispatch is ranked first', async () => {
			listProjectDispatchCandidates.mockResolvedValue(planningScarceFleet());
			const loadPoolDemands = vi.fn(async () => [
				demand('d-planning', 'planning'),
				demand('d-review', 'review'),
			]);

			// Planning takes the worker only it can use…
			expect(
				await evaluateDispatchEligibility(
					gateInput({ dispatchId: 'd-planning', phase: 'planning' }),
					{
						loadPoolDemands,
					},
				),
			).toMatchObject({ status: 'selected', selection: { workerId: 'w-a' } });
			// …and Review, gating against the same snapshot, still routes around it.
			expect(
				await evaluateDispatchEligibility(gateInput({ dispatchId: 'd-review', phase: 'review' }), {
					loadPoolDemands,
				}),
			).toMatchObject({ status: 'selected', selection: { workerId: 'w-b' } });
		});

		it('keeps the first eligible worker when nothing else is contending for it', async () => {
			listProjectDispatchCandidates.mockResolvedValue(planningScarceFleet());
			const loadPoolDemands = vi.fn(async () => [demand('d-review', 'review')]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ dispatchId: 'd-review', phase: 'review' }),
				{ loadPoolDemands },
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-a' } });
		});

		it('runs anyway on its first eligible worker when the pool has no slot for it', async () => {
			// Two higher-ranked demands claim both machines. Yielding would idle a worker
			// this dispatch can use for a dispatch whose wake-up may not have fired, so
			// the pool's answer is a preference, not a refusal.
			listProjectDispatchCandidates.mockResolvedValue([makeCandidate('w-a'), makeCandidate('w-b')]);
			const loadPoolDemands = vi.fn(async () => [
				demand('d-first', 'review'),
				demand('d-second', 'review'),
				demand('d-self', 'review'),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ dispatchId: 'd-self', phase: 'review' }),
				{ loadPoolDemands },
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-a' } });
		});

		it('never trades target priority for pool utilisation', async () => {
			// The preferred codex target runs only on `w-a`, which the planning dispatch
			// also needs. Target priority is a hard rule, so Review still takes `w-a` and
			// Planning waits — the pool chooses between workers, never between targets.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-a', { capabilities: ['claude', 'codex'] }),
				makeCandidate('w-b', { capabilities: ['claude'], supportedPhases: WITHOUT_PLANNING }),
			]);
			const loadPoolDemands = vi.fn(async () => [
				demand('d-review', 'review'),
				demand('d-planning', 'planning'),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({
					dispatchId: 'd-review',
					phase: 'review',
					targets: [{ cli: 'codex' }, { cli: 'claude' }],
				}),
				{ loadPoolDemands },
			);

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-a', targetIndex: 0, cli: 'codex' },
			});
		});

		it('spends nothing on the pool read when only one worker is eligible', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-a'),
				makeCandidate('w-busy', { activeRuns: 1 }),
			]);
			const loadPoolDemands = vi.fn(async () => [demand('d-self', 'review')]);

			await evaluateDispatchEligibility(gateInput({ dispatchId: 'd-self', phase: 'review' }), {
				loadPoolDemands,
			});

			expect(loadPoolDemands).not.toHaveBeenCalled();
		});

		it('keeps today’s pick when the pool read is unavailable or the dispatch is unnamed', async () => {
			listProjectDispatchCandidates.mockResolvedValue(planningScarceFleet());
			// A failed read reports `undefined` — scheduling preference must never be the
			// reason a ready dispatch waits.
			const loadPoolDemands = vi.fn(async () => undefined);

			expect(
				await evaluateDispatchEligibility(gateInput({ dispatchId: 'd-review', phase: 'review' }), {
					loadPoolDemands,
				}),
			).toMatchObject({ status: 'selected', selection: { workerId: 'w-a' } });
			// And a caller with no dispatch row cannot recognise its own share, so it does
			// not read the pool at all.
			expect(
				await evaluateDispatchEligibility(gateInput({ phase: 'review' }), { loadPoolDemands }),
			).toMatchObject({ status: 'selected', selection: { workerId: 'w-a' } });
			expect(loadPoolDemands).toHaveBeenCalledTimes(1);
		});

		it('fills a worker’s spare allocation before diverting to another machine', async () => {
			// `w-a` is allocated two slots and running one, so it can still serve both the
			// review and the planning dispatch — there is no scarcity to preserve.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-a', { enrollment: { concurrencyAllocation: 2 }, activeRuns: 0 }),
				makeCandidate('w-b', { supportedPhases: WITHOUT_PLANNING }),
			]);
			const loadPoolDemands = vi.fn(async () => [
				demand('d-review', 'review'),
				demand('d-planning', 'planning'),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ dispatchId: 'd-review', phase: 'review' }),
				{ loadPoolDemands },
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-a' } });
		});

		// Issue #714. A contender is narrowed by its *own* repository, read off its stored
		// payload, so contention is only ever counted between dispatches that can actually
		// share a machine.
		it('does not let a contender for another repository reserve this repository’s machine', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-a'),
				makeCandidate('w-b', { supportedPhases: WITHOUT_PLANNING }),
			]);
			// The planning contender belongs to a repository neither machine holds, so it can
			// run nowhere — there is no scarcity to preserve and Review keeps its first pick.
			const loadPoolDemands = vi.fn(async () => [
				demand('d-review', 'review'),
				demand('d-planning', 'planning', OTHER_REPOSITORY),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ dispatchId: 'd-review', phase: 'review' }),
				{ loadPoolDemands },
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-a' } });
		});

		it('judges a contender that names no repository against every machine', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-a'),
				makeCandidate('w-b', { supportedPhases: WITHOUT_PLANNING }),
			]);
			// A payload written before repositories were routable names none, which means the
			// project's *default* entry — not necessarily the one this gate scoped. So the
			// check is skipped rather than guessed at, leaving the contender's eligible set a
			// superset: Review routes around the only planning-capable machine, and still runs.
			const loadPoolDemands = vi.fn(async () => [
				demand('d-review', 'review'),
				demand('d-planning', 'planning', undefined),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ dispatchId: 'd-review', phase: 'review' }),
				{ loadPoolDemands },
			);

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-b' } });
		});

		it('holds an affinity-gated dispatch to its assignee’s worker under contention', async () => {
			// The pool may only reorder *eligible* workers: Alice's item cannot be routed
			// to Bob's machine to make room, so it takes hers and the contender waits.
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-alice', { ownerUserId: ALICE }),
				makeCandidate('w-bob', { ownerUserId: BOB }),
			]);
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));
			const loadPoolDemands = vi.fn(async () => [
				demand('d-other', 'review'),
				demand('d-self', 'implementation'),
			]);

			const decision = await evaluateDispatchEligibility(
				gateInput({ dispatchId: 'd-self', workItem: ASSIGNED_ITEM, pm: PM }),
				{ loadPoolDemands },
			);

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-alice', assignedUserId: ALICE },
			});
		});
	});

	// The control plane (issue #407) folds a transport-connectivity predicate into
	// the gate so only socket-connected workers are selectable — a worker whose DB
	// lease reads live but whose `/worker/stream` socket is not open on this router
	// is not chosen. The predicate only ever narrows: passing none preserves the
	// in-process behavior above.
	describe('transport connectivity (issue #407)', () => {
		it('skips a DB-live-but-not-connected worker and picks the first connected one', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-offline-socket'),
				makeCandidate('w-connected'),
			]);
			// Both are DB-live and eligible; only the second holds a live socket here.
			const isWorkerConnected = (id: string) => id === 'w-connected';

			const decision = await evaluateDispatchEligibility(gateInput(), { isWorkerConnected });

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-connected' },
			});
		});

		it('defers (ineligible) when the only eligible worker is not socket-connected', async () => {
			listProjectDispatchCandidates.mockResolvedValue([makeCandidate('w-1')]);

			const decision = await evaluateDispatchEligibility(gateInput(), {
				isWorkerConnected: () => false,
			});

			// A live-lease-only worker resolves as `worker-unavailable`, so the durable
			// dispatch stays pending until a worker connects — never a blind dispatch.
			expect(decision).toMatchObject({ status: 'ineligible', reason: 'worker-unavailable' });
		});

		// Issue #467 — the bug this closes. A daemon that refuses `planning` used to be
		// discovered only from the worker's terminal failure frame, which the dispatcher
		// cannot re-route. The gate refuses such a candidate up front. Driven by a
		// pre-#536 daemon's declaration, since today's DB-free daemon declares planning.
		it('never selects a worker that cannot plan, deferring instead of dispatching', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-db-free', { supportedPhases: LEGACY_DB_FREE_PHASES }),
			]);

			const decision = await evaluateDispatchEligibility(gateInput({ phase: 'planning' }));

			// Ineligible, not selected: the shared path defers this as a wait for an
			// eligible worker instead of settling the run as failed.
			expect(decision).toMatchObject({
				status: 'ineligible',
				reason: 'missing-phase-capability',
			});
		});

		// Issue #536's dispatch-side outcome: a DB-free daemon now declares `planning`,
		// so it is selected for it rather than refused — the machine no longer decides
		// which phases an instance can run.
		it('selects a DB-free worker for planning once its daemon declares it', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-db-free', { supportedPhases: DB_FREE_PHASES }),
			]);

			const decision = await evaluateDispatchEligibility(gateInput({ phase: 'planning' }));

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-db-free' } });
		});

		// The refusal text is posted on the board item once the recheck budget is spent,
		// so it must describe the phase that actually failed rather than always narrating
		// the planning/DB-free case.
		it('names the refused phase without asserting it is planning', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-narrow', { supportedPhases: ['implementation'] }),
			]);

			const decision = await evaluateDispatchEligibility(gateInput({ phase: 'review' }));

			expect(decision.status).toBe('ineligible');
			if (decision.status !== 'ineligible') return;
			expect(decision.message).toContain("'review'");
			expect(decision.message).not.toContain('planning');
		});

		it('still selects that DB-free worker for a phase it does declare', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-db-free', { supportedPhases: DB_FREE_PHASES }),
			]);

			const decision = await evaluateDispatchEligibility(gateInput({ phase: 'implementation' }));

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-db-free' },
			});
		});

		// The mixed fleet: selection order (first-free) would have offered the DB-free
		// worker first, so this is what previously made a Planning dispatch die at
		// random even though a capable worker was connected and eligible.
		it('routes planning past a worker that cannot plan to the one behind it', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-db-free', { supportedPhases: LEGACY_DB_FREE_PHASES }),
				makeCandidate('w-host'),
			]);

			const decision = await evaluateDispatchEligibility(gateInput({ phase: 'planning' }));

			expect(decision).toMatchObject({
				status: 'selected',
				selection: { workerId: 'w-host' },
			});
		});

		// Issue #509: the owner's per-enrollment selection is the second phase gate, and
		// the fleet-level behaviour has to match the machine-declaration one — defer,
		// name the phase, and route past the narrowed worker to one that permits it.
		it('never selects a worker whose enrollment does not permit the phase', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-1', { enrollment: { allowedPhases: ['implementation'] } }),
			]);

			const decision = await evaluateDispatchEligibility(gateInput({ phase: 'review' }));

			expect(decision).toMatchObject({ status: 'ineligible', reason: 'phase-not-permitted' });
			if (decision.status !== 'ineligible') return;
			// Points at the owner, who is the only one who can widen the selection.
			expect(decision.message).toContain("'review'");
			expect(decision.message).toMatch(/worker owner/);
		});

		it('routes the phase past a narrowed enrollment to one that permits it', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-narrow', { enrollment: { allowedPhases: ['implementation'] } }),
				makeCandidate('w-wide'),
			]);

			const decision = await evaluateDispatchEligibility(gateInput({ phase: 'review' }));

			expect(decision).toMatchObject({ status: 'selected', selection: { workerId: 'w-wide' } });
		});

		// Two individually correct refusals must not be conflated: the fix for one is to
		// connect a capable daemon, for the other to widen an enrollment.
		it('prefers the enrollment’s refusal over the machine’s when both appear in the fleet', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-incapable', { supportedPhases: ['implementation'] }),
				makeCandidate('w-not-permitted', { enrollment: { allowedPhases: ['implementation'] } }),
			]);

			const decision = await evaluateDispatchEligibility(gateInput({ phase: 'review' }));

			expect(decision).toMatchObject({ status: 'ineligible', reason: 'phase-not-permitted' });
		});

		it('preserves assignee affinity — a connected worker of another user is never chosen', async () => {
			resolveAssignedUser.mockResolvedValue(assignedTo(ALICE));
			listProjectDispatchCandidates.mockResolvedValue([
				makeCandidate('w-alice', { ownerUserId: ALICE }),
				makeCandidate('w-bob', { ownerUserId: BOB }),
			]);
			// Bob's worker is the connected one; Alice's is not — the assigned item must
			// still wait for Alice's own worker rather than route to Bob's.
			const isWorkerConnected = (id: string) => id === 'w-bob';

			const decision = await evaluateDispatchEligibility(
				gateInput({ workItem: ASSIGNED_ITEM, pm: PM }),
				{ isWorkerConnected },
			);

			expect(decision).toMatchObject({
				status: 'ineligible',
				reason: 'assignee-worker-unavailable',
			});
		});
	});
});
