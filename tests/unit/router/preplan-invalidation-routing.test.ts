import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockScmTriggerContext, createMockWorkItem } from '../../helpers/factories.js';

const { listWorkItems } = vi.hoisted(() => ({ listWorkItems: vi.fn() }));
vi.mock('@/integrations/pm/github-projects/provider.js', () => ({
	createGitHubProjectsProvider: () => ({
		type: 'github-projects',
		supportsAssignees: true,
		listWorkItems,
	}),
}));

import { parseGitHubWebhook } from '@/integrations/scm/github/webhook.js';
import { registerBuiltInTriggers } from '@/triggers/builtins.js';
import { createTriggerRegistry } from '@/triggers/registry.js';

describe('raw issues webhook → preplan invalidation trigger', () => {
	beforeEach(() => {
		listWorkItems.mockReset();
	});

	it('parses, routes, authoritatively re-reads, and dispatches fallback Planning', async () => {
		const workItem = createMockWorkItem({
			id: 'PVTI_child',
			url: 'https://github.com/jkwiecien/swarm/issues/339',
			status: 'Planning',
			statusId: '3fe662f4',
			description: 'The operator requested a fresh plan.',
			labels: [
				{ id: 'split', name: 'swarm:split-child' },
				{ id: 'replan', name: 'swarm:replan' },
			],
		});
		listWorkItems.mockResolvedValue([workItem]);
		const parsed = parseGitHubWebhook('issues', {
			action: 'labeled',
			repository: { full_name: 'jkwiecien/swarm' },
			issue: {
				number: 339,
				html_url: 'https://github.com/jkwiecien/swarm/issues/339',
			},
			label: { name: 'swarm:replan' },
			sender: { login: 'jkwiecien' },
		});
		if (!parsed) throw new Error('raw issues webhook was unexpectedly ignored');

		const registry = createTriggerRegistry();
		registerBuiltInTriggers(registry);
		const result = await registry.dispatch(createMockScmTriggerContext({ event: parsed }));

		expect(listWorkItems).toHaveBeenCalledWith({ status: 'planning' });
		expect(result).toEqual({ phase: 'planning', taskId: '339', workItem });
	});
});
