import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PmEvent } from '@/pm/events.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';

vi.mock('@/triggers/pm-status-dedup.js', () => ({ recordStatusAndDetectChange: vi.fn() }));

// The handler resolves the project's board adapter through the PM registry, which
// is populated by the integrations entrypoint at module load — import it so the
// `github-projects` manifest (and its real `isStatusChange`) is registered.
import '@/integrations/entrypoint.js';
import { buildPreplanContract, embedPreplanMarker } from '@/pipeline/preplan.js';
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

		it('returns null (skips planning dispatch) when a split child entering Planning is already preplanned', async () => {
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
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: itemUrl,
				description: embedPreplanMarker('Subtask 1 description', contract),
				labels: [{ id: 'l1', name: 'swarm:split-child' }],
			});
			expect(await trigger.handle(ctx(workItem))).toBeNull();
		});

		it('dispatches Planning when a valid preplan marker has no split-child label', async () => {
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
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: itemUrl,
				description: embedPreplanMarker('Subtask 1 description', contract),
				labels: [],
			});
			const result = await trigger.handle(ctx(workItem));
			expect(result).toEqual({ phase: 'planning', taskId: '10', workItem });
		});

		it('dispatches Planning when preplanned item carries replan label (swarm:replan)', async () => {
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
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: itemUrl,
				description: embedPreplanMarker('Subtask 1 description', contract),
				labels: [
					{ id: 'l1', name: 'swarm:split-child' },
					{ id: 'l2', name: 'swarm:replan' },
				],
			});
			const result = await trigger.handle(ctx(workItem));
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
});
