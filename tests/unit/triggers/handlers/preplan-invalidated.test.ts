import { describe, expect, it, vi } from 'vitest';

import {
	buildPreplanContract,
	embedPreplanMarker,
	REPLAN_LABEL,
	SPLIT_CHILD_LABEL,
} from '@/pipeline/preplan.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import { createPreplanInvalidatedTrigger } from '@/triggers/handlers/preplan-invalidated.js';
import type { TriggerContext } from '@/triggers/types.js';
import {
	createMockProjectConfig,
	createMockScmEvent,
	createMockScmTriggerContext,
	createMockWorkItem,
} from '../../../helpers/factories.js';

const PROJECT = createMockProjectConfig();
const ITEM_URL = 'https://github.com/SmartTechBrewery/swarm/issues/10';

function preplannedChild(overrides: Partial<WorkItem> = {}): WorkItem {
	const humanDescription = 'Original child scope.';
	const contract = buildPreplanContract({
		splitId: 'split-1',
		childIndex: 0,
		parentUrl: 'https://github.com/SmartTechBrewery/swarm/issues/9',
		itemUrl: ITEM_URL,
		humanDescription,
		plan: '# Child plan',
		generatedAt: '2026-07-22T00:00:00Z',
	});
	return createMockWorkItem({
		id: 'PVTI_child',
		url: ITEM_URL,
		status: 'Planning',
		statusId: PROJECT.githubProjects.statusOptions.planning,
		description: embedPreplanMarker(humanDescription, contract),
		labels: [{ id: 'split-label', name: SPLIT_CHILD_LABEL }],
		...overrides,
	});
}

function providerReturning(items: WorkItem[]) {
	const listWorkItems = vi.fn<PMProvider['listWorkItems']>(async () => items);
	const provider: PMProvider = {
		type: 'github-projects',
		getWorkItem: async () => items[0] ?? createMockWorkItem(),
		listWorkItems,
		findWorkItemByUrlSuffix: async () => undefined,
		moveWorkItem: async () => undefined,
		addComment: async () => 'comment-1',
		findComment: async () => undefined,
		createWorkItem: async () => createMockWorkItem(),
		updateWorkItem: async () => undefined,
		addLabel: async () => undefined,
		supportsDependencies: false,
		supportsAssignees: false,
		listBlockers: async () => [],
		addBlockedBy: async () => undefined,
	};
	return { provider, listWorkItems };
}

function context(
	overrides: Partial<Parameters<typeof createMockScmEvent>[0]> = {},
): TriggerContext {
	return createMockScmTriggerContext({
		project: PROJECT,
		event: createMockScmEvent({
			kind: 'work-item',
			action: 'edited',
			workItemId: '10',
			workItemUrl: ITEM_URL,
			workItemBodyChanged: true,
			...overrides,
		}),
	});
}

function triggerFor(items: WorkItem[]) {
	const { provider, listWorkItems } = providerReturning(items);
	return {
		trigger: createPreplanInvalidatedTrigger({ createProvider: () => provider }),
		listWorkItems,
	};
}

describe('preplan-invalidated trigger', () => {
	it('dispatches Planning after a child scope edit invalidates its marker', async () => {
		const child = preplannedChild();
		const invalidated = {
			...child,
			description: child.description.replace('Original child scope.', 'Expanded child scope.'),
		};
		const { trigger, listWorkItems } = triggerFor([invalidated]);

		expect(await trigger.handle(context())).toEqual({
			phase: 'planning',
			taskId: '10',
			workItem: invalidated,
		});
		expect(listWorkItems).toHaveBeenCalledWith({ status: 'planning' });
	});

	it('dispatches Planning when swarm:replan is added', async () => {
		const child = preplannedChild();
		const invalidated = {
			...child,
			labels: [...child.labels, { id: 'replan-label', name: REPLAN_LABEL }],
		};
		const { trigger } = triggerFor([invalidated]);

		expect(
			await trigger.handle(context({ action: 'labeled', labelName: REPLAN_LABEL })),
		).toMatchObject({ phase: 'planning', taskId: '10' });
	});

	it('dispatches Planning when the split-child label is removed', async () => {
		const invalidated = preplannedChild({ labels: [] });
		const { trigger } = triggerFor([invalidated]);

		expect(
			await trigger.handle(context({ action: 'unlabeled', labelName: SPLIT_CHILD_LABEL })),
		).toMatchObject({ phase: 'planning', taskId: '10' });
	});

	it('does not dispatch when the authoritative preplan is still valid', async () => {
		const { trigger } = triggerFor([preplannedChild()]);
		expect(await trigger.handle(context())).toBeNull();
	});

	it('does not dispatch for an item outside Planning', async () => {
		const { trigger } = triggerFor([]);
		expect(await trigger.handle(context())).toBeNull();
	});

	it('does not dispatch for a label change on a card sitting in Backlog', async () => {
		const { trigger } = triggerFor([]);
		expect(
			await trigger.handle(context({ action: 'labeled', labelName: REPLAN_LABEL })),
		).toBeNull();
	});

	it('matches only relevant issue-body and label changes', () => {
		const { trigger } = triggerFor([]);
		expect(trigger.matches(context())).toBe(true);
		expect(trigger.matches(context({ workItemBodyChanged: false }))).toBe(false);
		expect(trigger.matches(context({ action: 'labeled', labelName: 'bug' }))).toBe(false);
		expect(trigger.matches(context({ action: 'unlabeled', labelName: SPLIT_CHILD_LABEL }))).toBe(
			true,
		);
	});
});
