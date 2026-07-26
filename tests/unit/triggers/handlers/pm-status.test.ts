import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';

vi.mock('@/triggers/pm-status-dedup.js', () => ({ recordStatusAndDetectChange: vi.fn() }));

import { buildPreplanContract, embedPreplanMarker } from '@/pipeline/preplan.js';
import { createPmStatusTrigger } from '@/triggers/handlers/pm-status.js';
import { recordStatusAndDetectChange } from '@/triggers/pm-status-dedup.js';
import type { TriggerContext } from '@/triggers/types.js';
import {
	createMockGitHubProjectsParsedEvent,
	createMockProjectConfig,
	createMockWorkItem,
} from '../../../helpers/factories.js';

const PROJECT = createMockProjectConfig();

beforeEach(() => {
	vi.mocked(recordStatusAndDetectChange).mockReset();
	vi.mocked(recordStatusAndDetectChange).mockResolvedValue(true);
});

function ctx(
	overrides: Partial<Parameters<typeof createMockGitHubProjectsParsedEvent>[0]> = {},
): TriggerContext {
	return {
		project: PROJECT,
		source: 'github-projects',
		event: createMockGitHubProjectsParsedEvent(overrides),
	};
}

/** A PM provider whose `getWorkItem` returns `workItem`, recording the id read. */
function providerReturning(workItem: WorkItem, seen: string[] = []): PMProvider {
	return {
		type: 'github-projects',
		getWorkItem: async (id) => {
			seen.push(id);
			return workItem;
		},
		listWorkItems: async () => [],
		findWorkItemByUrlSuffix: async () => undefined,
		moveWorkItem: async () => undefined,
		addComment: async () => 'c1',
		findComment: async () => undefined,
		createWorkItem: async () => workItem,
		updateWorkItem: async () => undefined,
		addLabel: async () => undefined,
		supportsDependencies: false,
		supportsAssignees: false,
		listBlockers: async () => [],
		addBlockedBy: async () => undefined,
	};
}

function trigger(workItem: WorkItem) {
	return createPmStatusTrigger({ createProvider: () => providerReturning(workItem) });
}

describe('pm-status trigger', () => {
	describe('matches', () => {
		it('matches a Status-field edit on the project board', () => {
			expect(trigger(createMockWorkItem()).matches(ctx())).toBe(true);
		});

		it('matches a created card', () => {
			expect(trigger(createMockWorkItem()).matches(ctx({ action: 'created' }))).toBe(true);
		});

		it('matches a reordered card (Board-view drag between columns) regardless of the changed field', () => {
			expect(
				trigger(createMockWorkItem()).matches(
					ctx({ action: 'reordered', changedFieldNodeId: undefined }),
				),
			).toBe(true);
		});

		it('ignores an edit to a non-Status field', () => {
			expect(
				trigger(createMockWorkItem()).matches(ctx({ changedFieldNodeId: 'PVTF_someOtherField' })),
			).toBe(false);
		});

		it('ignores non-triggering actions', () => {
			expect(trigger(createMockWorkItem()).matches(ctx({ action: 'deleted' }))).toBe(false);
		});

		it('ignores non-projects sources', () => {
			const scmCtx = {
				project: PROJECT,
				source: 'scm',
				event: { kind: 'pull-request', repoFullName: 'x/y', isCommentEvent: false },
			} as unknown as TriggerContext;
			expect(trigger(createMockWorkItem()).matches(scmCtx)).toBe(false);
		});
	});

	describe('handle', () => {
		it('dispatches Planning when the card sits in Planning', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: 'https://github.com/jkwiecien/swarm/issues/10',
			});
			const result = await trigger(workItem).handle(ctx());
			expect(result).toEqual({ phase: 'planning', taskId: '10', workItem });
		});

		it('returns null (skips planning dispatch) when a split child entering Planning is already preplanned', async () => {
			const itemUrl = 'https://github.com/jkwiecien/swarm/issues/10';
			const contract = buildPreplanContract({
				splitId: 'split-1',
				childIndex: 0,
				parentUrl: 'https://github.com/jkwiecien/swarm/issues/9',
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
			const result = await trigger(workItem).handle(ctx());
			expect(result).toBeNull();
		});

		it('dispatches Planning when a valid preplan marker has no split-child label', async () => {
			const itemUrl = 'https://github.com/jkwiecien/swarm/issues/10';
			const contract = buildPreplanContract({
				splitId: 'split-1',
				childIndex: 0,
				parentUrl: 'https://github.com/jkwiecien/swarm/issues/9',
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
			const result = await trigger(workItem).handle(ctx());
			expect(result).toEqual({ phase: 'planning', taskId: '10', workItem });
		});

		it('dispatches Planning when preplanned item carries replan label (swarm:replan)', async () => {
			const itemUrl = 'https://github.com/jkwiecien/swarm/issues/10';
			const contract = buildPreplanContract({
				splitId: 'split-1',
				childIndex: 0,
				parentUrl: 'https://github.com/jkwiecien/swarm/issues/9',
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
			const result = await trigger(workItem).handle(ctx());
			expect(result).toEqual({ phase: 'planning', taskId: '10', workItem });
		});

		it('dispatches Implementation when the card sits in ToDo', async () => {
			const workItem = createMockWorkItem({
				statusId: '3121a97d', // ToDo
				url: 'https://github.com/jkwiecien/swarm/issues/12',
			});
			const result = await trigger(workItem).handle(ctx());
			expect(result).toEqual({ phase: 'implementation', taskId: '12', workItem });
		});

		it('returns null for a status that starts no phase', async () => {
			const workItem = createMockWorkItem({ statusId: 'f75ad846' }); // Backlog
			expect(await trigger(workItem).handle(ctx())).toBeNull();
		});

		it('resumes a deferred implementation despite its In progress status', async () => {
			const workItem = createMockWorkItem({
				statusId: '47fc9ee4', // In progress
				url: 'https://github.com/jkwiecien/swarm/issues/138',
			});
			const result = await trigger(workItem).handle({
				...ctx(),
				resumePmPhase: 'implementation',
			});
			expect(result).toEqual({ phase: 'implementation', taskId: '138', workItem });
		});

		it('resumes a deferred phase even when status dedup says unchanged', async () => {
			vi.mocked(recordStatusAndDetectChange).mockResolvedValue(false);
			const workItem = createMockWorkItem({
				statusId: '47fc9ee4',
				url: 'https://github.com/jkwiecien/swarm/issues/138',
			});
			const result = await trigger(workItem).handle({
				...ctx(),
				resumePmPhase: 'implementation',
			});
			expect(result).toEqual({ phase: 'implementation', taskId: '138', workItem });
		});

		it('records a status that starts no phase (so a later return to a phase reads as a change)', async () => {
			// Backlog starts no phase, but it must still be recorded — that is what lets
			// a subsequent move back to ToDo/Planning register as a genuine change
			// rather than a same-status no-op.
			const workItem = createMockWorkItem({ statusId: 'f75ad846' }); // Backlog
			await trigger(workItem).handle(ctx({ itemNodeId: 'PVTI_backlog' }));
			expect(recordStatusAndDetectChange).toHaveBeenCalledWith('PVTI_backlog', 'f75ad846');
		});

		it('records the item node ID and re-read status before dispatching', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: 'https://github.com/jkwiecien/swarm/issues/10',
			});
			await trigger(workItem).handle(ctx({ itemNodeId: 'PVTI_dedup' }));
			expect(recordStatusAndDetectChange).toHaveBeenCalledWith('PVTI_dedup', '61e4505c');
		});

		it('returns null (skips dispatch) when the status is unchanged since last observation', async () => {
			vi.mocked(recordStatusAndDetectChange).mockResolvedValue(false);
			const workItem = createMockWorkItem({
				statusId: '61e4505c', // Planning
				url: 'https://github.com/jkwiecien/swarm/issues/10',
			});
			expect(await trigger(workItem).handle(ctx())).toBeNull();
		});

		it('returns null when the item has no resolvable status', async () => {
			const workItem = createMockWorkItem({ statusId: undefined });
			expect(await trigger(workItem).handle(ctx())).toBeNull();
		});

		it('returns null when the work item URL carries no issue number (e.g. a draft)', async () => {
			const workItem = createMockWorkItem({
				statusId: '61e4505c',
				url: 'https://github.com/jkwiecien/swarm',
			});
			expect(await trigger(workItem).handle(ctx())).toBeNull();
		});

		it('re-reads the exact item from the event', async () => {
			const seen: string[] = [];
			const workItem = createMockWorkItem({ statusId: '61e4505c' });
			const handler = createPmStatusTrigger({
				createProvider: () => providerReturning(workItem, seen),
			});
			await handler.handle(ctx({ itemNodeId: 'PVTI_specific' }));
			expect(seen).toEqual(['PVTI_specific']);
		});

		it('builds the provider from the event project', async () => {
			const seenProjects: ProjectConfig[] = [];
			const handler = createPmStatusTrigger({
				createProvider: (project) => {
					seenProjects.push(project);
					return providerReturning(createMockWorkItem({ statusId: '61e4505c' }));
				},
			});
			await handler.handle(ctx());
			expect(seenProjects).toEqual([PROJECT]);
		});
	});
});
