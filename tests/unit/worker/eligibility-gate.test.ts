import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentTarget } from '@/config/schema.js';
import type { ResolvedAssignee } from '@/identity/assignee-resolver.js';
import type { SwarmUser } from '@/identity/schema.js';
import type { Worker } from '@/identity/worker.js';
import type { WorkerEnrollment } from '@/identity/worker-enrollment.js';
import type { WorkerDispatchCandidate } from '@/identity/worker-enrollment-service.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';

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

import { type DispatchGateInput, evaluateDispatchEligibility } from '@/worker/eligibility-gate.js';

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

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
			createdAt: new Date('2026-01-01T00:00:00Z'),
			updatedAt: new Date('2026-01-01T00:00:00Z'),
		},
		enrollment: {
			id: `enr-${id}`,
			workerId: id,
			projectId: 'swarm',
			status: 'active',
			allowedClis: overrides.capabilities ?? ['claude'],
			concurrencyAllocation: 1,
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
		targets: [{}] satisfies AgentTarget[],
		phaseDefaultCli: 'claude',
		...overrides,
	};
}

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

	describe('unassigned items', () => {
		it('routes to the first free eligible worker in enrollment order', async () => {
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
