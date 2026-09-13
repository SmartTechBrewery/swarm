import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { retireSupersededBoardPhases as RetireSuperseded } from '@/dispatch/board-phase-retirement.js';
import type { PmEvent } from '@/pm/events.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';

vi.mock('@/triggers/pm-status-dedup.js', () => ({ recordStatusAndDetectChange: vi.fn() }));
vi.mock('@/dispatch/board-phase-retirement.js', () => ({
	retireSupersededBoardPhases: vi.fn<typeof RetireSuperseded>(),
}));

// The handler resolves the project's board adapter through the PM registry, which
// is populated by the integrations entrypoint at module load — import it so the
// `github-projects` manifest (and its real `isStatusChange`) is registered.
import '@/integrations/entrypoint.js';
import { retireSupersededBoardPhases } from '@/dispatch/board-phase-retirement.js';
import { buildPreplanContract, embedPreplanMarker, PLANNED_LABEL } from '@/pipeline/preplan.js';
import { createPmStatusTrigger } from '@/triggers/handlers/pm-status.js';
import { recordStatusAndDetectChange } from '@/triggers/pm-status-dedup.js';
import type { PmTriggerContext, TriggerContext } from '@/triggers/types.js';
import {
	createMockPmEvent,
	createMockProjectConfig,
	createMockWorkItem,
} from '../../../helpers/factories.js';

const PROJECT = createMockProjectConfig();

beforeEach(() => {
	vi.mocked(recordStatusAndDetectChange).mockReset();
	vi.mocked(recordStatusAndDetectChange).mockResolvedValue(true);
	vi.mocked(retireSupersededBoardPhases).mockReset();
	vi.mocked(retireSupersededBoardPhases).mockResolvedValue(0);
});

/**
 * A PM provider whose `getWorkItem` returns `workItem`, recording the id read.
 * The handler reaches the board only through `ctx.pm` (issue #297), so a test
 * substitutes this one field rather than injecting a factory.
 */
function providerReturning(workItem: WorkItem, seen: string[] = []): PMProvider {
	return {
		type: 'github-projects',
		getWorkItem: async (id) => {
			seen.push(id);
			return workItem;
		},
		listWorkItems: async () => [],
		findWorkItemByUrlSuffix: async () => undefined,
		findWorkItemForArtifact: async () => undefined,
		findWorkItemByDescriptionMarker: async () => undefined,
		moveWorkItem: async () => undefined,
		addComment: async () => 'c1',
		findComment: async () => undefined,
		createWorkItem: async () => workItem,
		updateWorkItem: async () => undefined,
		addLabel: async () => undefined,
		supportsDependencies: false,
		supportsAssignees: false,
		listBlockers: async () => [],
		listDependents: async () => [],
		addBlockedBy: async () => undefined,
		resolveItemRepository: async () => ({ status: 'unrouted' }),
	};
}

function ctx(
	workItem: WorkItem,
	eventOverrides: Partial<PmEvent> = {},
	seen: string[] = [],
): PmTriggerContext {
	return {
		project: PROJECT,
		dispatchId: 'dispatch-1',
		source: 'pm',
		providerId: 'github-projects',
		event: createMockPmEvent(eventOverrides),
		pm: providerReturning(workItem, seen),
	};
}

const trigger = createPmStatusTrigger();

describe('pm-status trigger', () => {
	describe('matches', () => {
		it('matches a state-field edit on the project board', () => {
			expect(trigger.matches(ctx(createMockWorkItem()))).toBe(true);
		});

		it('matches a created card', () => {
			expect(trigger.matches(ctx(createMockWorkItem(), { action: 'created' }))).toBe(true);
		});

		it('matches a moved card (Board-view drag between columns) regardless of the changed field', () => {
			expect(
				trigger.matches(ctx(createMockWorkItem(), { action: 'moved', changedField: undefined })),
			).toBe(true);
		});

		it('ignores an edit to a non-state field', () => {
			expect(
				trigger.matches(ctx(createMockWorkItem(), { changedField: 'PVTF_someOtherField' })),
			).toBe(false);
		});

		it('ignores non-triggering actions', () => {
			expect(trigger.matches(ctx(createMockWorkItem(), { action: 'deleted' }))).toBe(false);
		});

		it('matches a resumed PM phase even when the event is not a state change', () => {
			expect(
				trigger.matches({
					...ctx(createMockWorkItem(), { changedField: 'PVTF_someOtherField' }),
					resumePmPhase: 'implementation',
				}),
			).toBe(true);
		});

		it('ignores non-PM sources', () => {
			const scmCtx = {
				project: PROJECT,
				source: 'scm',
				event: { kind: 'pull-request', repoFullName: 'x/y', isCommentEvent: false },
			} as unknown as TriggerContext;
			expect(trigger.matches(scmCtx)).toBe(false);
		});
	});

	describe('handle', () => {
		it('dispatches Planning when the card sits in Planning', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
			});
			const result = await trigger.handle(ctx(workItem));
			expect(result).toEqual({ phase: 'planning', taskId: '10', workItem });
		});

		// Issue #737 — the whole Planning gate is the `planned` label. A move to
		// Planning dispatches unless the card already carries it; to re-plan, remove
		// the label and move the card Backlog → Planning.
		it('returns null (skips planning dispatch) when the card already carries `planned`', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
				labels: [{ id: 'l1', name: PLANNED_LABEL }],
			});
			expect(await trigger.handle(ctx(workItem))).toBeNull();
		});

		it('re-plans once `planned` is removed and the card moves back into Planning', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
				labels: [{ id: 'l1', name: 'swarm:split-child' }],
			});
			const result = await trigger.handle(ctx(workItem));
			expect(result).toEqual({ phase: 'planning', taskId: '10', workItem });
		});

		it('ignores a preplan marker: only the label gates the dispatch', async () => {
			const itemUrl = 'https://github.com/SmartTechBrewery/swarm/issues/10';
			const contract = buildPreplanContract({
				splitId: 'split-1',
				childIndex: 0,
				parentUrl: 'https://github.com/SmartTechBrewery/swarm/issues/9',
				itemUrl,
				humanDescription: 'Subtask 1 description',
				plan: '# Subtask Plan',
				generatedAt: '2026-07-21T00:00:00Z',
			});
			// A valid marker on a labelled split child — the exact shape that used to be
			// the gate. Unlabeled, it now dispatches; the run it dispatches is the layer
			// that reads the marker and reuses the plan without spending an agent.
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: itemUrl,
				description: embedPreplanMarker('Subtask 1 description', contract),
				labels: [{ id: 'l1', name: 'swarm:split-child' }],
			});
			const result = await trigger.handle(ctx(workItem));
			expect(result).toEqual({ phase: 'planning', taskId: '10', workItem });
		});

		it('gates Implementation on nothing: `planned` only stops Planning', async () => {
			const workItem = createMockWorkItem({
				statusId: '3121a97d', // ToDo
				url: 'https://github.com/SmartTechBrewery/swarm/issues/12',
				labels: [{ id: 'l1', name: PLANNED_LABEL }],
			});
			const result = await trigger.handle(ctx(workItem));
			expect(result).toEqual({ phase: 'implementation', taskId: '12', workItem });
		});

		it('does not drop a deferred Planning phase resuming on a labelled card', async () => {
			const workItem = createMockWorkItem({
				statusId: '47fc9ee4', // In progress — the status its own report moved it to
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
				labels: [{ id: 'l1', name: PLANNED_LABEL }],
			});
			const result = await trigger.handle({ ...ctx(workItem), resumePmPhase: 'planning' });
			expect(result).toEqual({ phase: 'planning', taskId: '10', workItem });
		});

		it('dispatches Implementation when the card sits in ToDo', async () => {
			const workItem = createMockWorkItem({
				statusId: '3121a97d', // ToDo
				url: 'https://github.com/SmartTechBrewery/swarm/issues/12',
			});
			const result = await trigger.handle(ctx(workItem));
			expect(result).toEqual({ phase: 'implementation', taskId: '12', workItem });
		});

		it('resolves the phase from the canonical status key, not the board option id', async () => {
			// A board option the project's mapping does not cover carries no
			// `statusKey`, so it starts no phase — the provider owns that translation
			// (ai/RULES.md §2).
			const workItem = createMockWorkItem({
				statusId: 'PVTSSO_unmapped',
				statusKey: undefined,
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
			});
			expect(await trigger.handle(ctx(workItem))).toBeNull();
		});

		it('returns null for a status that starts no phase', async () => {
			const workItem = createMockWorkItem({ statusId: 'f75ad846' }); // Backlog
			expect(await trigger.handle(ctx(workItem))).toBeNull();
		});

		it('resumes a deferred implementation despite its In progress status', async () => {
			const workItem = createMockWorkItem({
				statusId: '47fc9ee4', // In progress
				url: 'https://github.com/SmartTechBrewery/swarm/issues/138',
			});
			const result = await trigger.handle({
				...ctx(workItem),
				resumePmPhase: 'implementation',
			});
			expect(result).toEqual({ phase: 'implementation', taskId: '138', workItem });
		});

		it('resumes a deferred phase even when status dedup says unchanged', async () => {
			vi.mocked(recordStatusAndDetectChange).mockResolvedValue(false);
			const workItem = createMockWorkItem({
				statusId: '47fc9ee4',
				url: 'https://github.com/SmartTechBrewery/swarm/issues/138',
			});
			const result = await trigger.handle({
				...ctx(workItem),
				resumePmPhase: 'implementation',
			});
			expect(result).toEqual({ phase: 'implementation', taskId: '138', workItem });
		});

		it('records a status that starts no phase (so a later return to a phase reads as a change)', async () => {
			// Backlog starts no phase, but it must still be recorded — that is what lets
			// a subsequent move back to ToDo/Planning register as a genuine change
			// rather than a same-status no-op.
			const workItem = createMockWorkItem({ statusId: 'f75ad846' }); // Backlog
			await trigger.handle(ctx(workItem, { itemId: 'PVTI_backlog' }));
			expect(recordStatusAndDetectChange).toHaveBeenCalledWith('PVTI_backlog', 'f75ad846');
		});

		it('records the item id and re-read status before dispatching', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
			});
			await trigger.handle(ctx(workItem, { itemId: 'PVTI_dedup' }));
			expect(recordStatusAndDetectChange).toHaveBeenCalledWith('PVTI_dedup', '61e4505c');
		});

		it('returns null (skips dispatch) when the status is unchanged since last observation', async () => {
			vi.mocked(recordStatusAndDetectChange).mockResolvedValue(false);
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
			});
			expect(await trigger.handle(ctx(workItem))).toBeNull();
		});

		it('returns null when the item has no resolvable status', async () => {
			const workItem = createMockWorkItem({ statusId: undefined });
			expect(await trigger.handle(ctx(workItem))).toBeNull();
		});

		// The card→artifact seam (issue #498): the provider decides, from its own
		// linkage, whether a card has an SCM artifact. Shared code only reads the
		// answer, so a board that links to nothing skips exactly like a draft card.
		it('keys the dispatch on the provider-supplied taskRef, not on the item URL', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c',
				// A Jira browse URL: nothing about the item's own URL names the artifact, so
				// the provider's two linkage fields are the whole of the answer (issue #710).
				url: 'https://swarm.example.test/browse/PROJ-7',
				taskRef: '77',
				taskRepository: PROJECT.repo,
			});
			const result = await trigger.handle(ctx(workItem));
			expect(result).toEqual({ phase: 'planning', taskId: '77', workItem });
		});

		it('returns null when the work item has no backing SCM artifact (e.g. a draft)', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c',
				url: 'https://github.com/SmartTechBrewery/swarm',
				taskRef: undefined,
			});
			expect(await trigger.handle(ctx(workItem))).toBeNull();
		});

		// Issue #710: the provider reports the repository its linkage named, and *this*
		// handler decides whether that is the repository the run is for — a card linked
		// in another of the project's repositories is refused rather than keyed here,
		// which would push a branch and open a pull request where nobody asked.
		it('returns null when the card links an artifact in another repository', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c',
				url: 'https://github.com/acme/other/issues/12',
			});

			expect(workItem.taskRepository).toBe('acme/other');
			expect(await trigger.handle(ctx(workItem))).toBeNull();
		});

		// `repoSlugsMatch`, not `===` (issue #688): ingress routed the card on those same
		// terms, so a config entry's casing or a `.git` suffix must not make the handler
		// refuse a card the dispatch already accepted.
		it('accepts a taskRepository differing from the run repository only by casing or .git', async () => {
			for (const taskRepository of ['SmartTechBrewery/Swarm.git', 'smarttechbrewery/swarm']) {
				const workItem = createMockWorkItem({
					statusId: '61e4505c',
					taskRef: '10',
					taskRepository,
				});
				await expect(trigger.handle(ctx(workItem))).resolves.toEqual({
					phase: 'planning',
					taskId: '10',
					workItem,
				});
			}
		});

		// A reference with no repository is unplaceable, so it is the same skip as no
		// reference at all — including on a frame from a router predating the field.
		it('returns null for a taskRef arriving with no taskRepository', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c',
				taskRef: '10',
				taskRepository: undefined,
			});
			expect(await trigger.handle(ctx(workItem))).toBeNull();
		});

		it('re-reads the exact item from the event through the injected provider', async () => {
			const seen: string[] = [];
			const workItem = createMockWorkItem({ statusId: '61e4505c' });
			await trigger.handle(ctx(workItem, { itemId: 'PVTI_specific' }, seen));
			expect(seen).toEqual(['PVTI_specific']);
		});
	});

	// Issue #909 — the card's current column is the single source of truth for which
	// board-driven phase is queued for it. Every case here asserts on the call the
	// handler makes into the dispatch layer; what that call then settles is the
	// retirement module's own suite (unit + integration).
	describe('retiring the board phase an earlier move left queued', () => {
		it('Planning → ToDo: keeps Implementation and retires the rest', async () => {
			const workItem = createMockWorkItem({
				statusId: '3121a97d', // ToDo
				url: 'https://github.com/SmartTechBrewery/swarm/issues/12',
			});

			const result = await trigger.handle(ctx(workItem));

			expect(retireSupersededBoardPhases).toHaveBeenCalledWith({
				projectId: PROJECT.id,
				taskId: '12',
				keepPhase: 'implementation',
				excludeDispatchId: 'dispatch-1',
			});
			expect(result).toEqual({ phase: 'implementation', taskId: '12', workItem });
		});

		it('ToDo → Planning: keeps Planning and retires the rest', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
			});

			await trigger.handle(ctx(workItem));

			expect(retireSupersededBoardPhases).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: '10', keepPhase: 'planning' }),
			);
		});

		// The same rule, not a second one: a column that starts nothing retires the
		// waiting dispatch and enqueues nothing.
		it.each([
			['Backlog', 'f75ad846'],
			['In review', 'df73e18b'],
			['Done', '98236657'],
		])('%s retires with no phase to keep, and starts nothing', async (_name, statusId) => {
			const workItem = createMockWorkItem({
				statusId,
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
			});

			expect(await trigger.handle(ctx(workItem))).toBeNull();
			expect(retireSupersededBoardPhases).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: '10', keepPhase: undefined }),
			);
		});

		// A phase's own status report retires nothing (`PM_PHASE_REPORTED_STATUS_KEYS`):
		// Implementation moves its card here to report the pickup, and retiring on it
		// would kill that very phase's own deferred retry.
		it('In progress retires nothing', async () => {
			const workItem = createMockWorkItem({
				statusId: '47fc9ee4', // In progress
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
			});

			expect(await trigger.handle(ctx(workItem))).toBeNull();
			expect(retireSupersededBoardPhases).not.toHaveBeenCalled();
		});

		it('a deferred PM phase resuming from its original event retires nothing', async () => {
			const workItem = createMockWorkItem({
				statusId: '47fc9ee4', // In progress — where its own status report left it
				url: 'https://github.com/SmartTechBrewery/swarm/issues/138',
			});

			const result = await trigger.handle({ ...ctx(workItem), resumePmPhase: 'implementation' });

			expect(retireSupersededBoardPhases).not.toHaveBeenCalled();
			expect(result).toEqual({ phase: 'implementation', taskId: '138', workItem });
		});

		it('a within-column reorder retires nothing', async () => {
			vi.mocked(recordStatusAndDetectChange).mockResolvedValue(false);
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
			});

			expect(await trigger.handle(ctx(workItem))).toBeNull();
			expect(retireSupersededBoardPhases).not.toHaveBeenCalled();
		});

		// Nothing to key the retirement on — for a phase-starting column and a
		// non-phase one alike.
		it.each([
			['a draft card', { taskRef: undefined }],
			['a card linked in another repository', { taskRepository: 'acme/other' }],
		])('%s retires nothing', async (_name, linkage) => {
			for (const statusId of ['61e4505c', 'f75ad846']) {
				const workItem = createMockWorkItem({ statusId, taskRef: '10', ...linkage });
				expect(await trigger.handle(ctx(workItem))).toBeNull();
			}
			expect(retireSupersededBoardPhases).not.toHaveBeenCalled();
		});

		// The retirement runs before the `planned` gate on purpose: what the board says
		// is what the queue holds, and dragging back to ToDo re-queues Implementation.
		it('a `planned` card dragged to Planning retires the queued Implementation and starts nothing', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
				labels: [{ id: 'l1', name: PLANNED_LABEL }],
			});

			expect(await trigger.handle(ctx(workItem))).toBeNull();
			expect(retireSupersededBoardPhases).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: '10', keepPhase: 'planning' }),
			);
		});
	});
});
