import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockScmTriggerContext, createMockWorkItem } from '../../helpers/factories.js';

// The handler resolves the project's PM provider through the registry (issue
// #297), so fake it there. `registerPMProvider` must stay callable for any
// provider module that registers itself at load.
const { listWorkItems } = vi.hoisted(() => ({ listWorkItems: vi.fn() }));
vi.mock('@/integrations/pm/registry.js', () => ({
	registerPMProvider: vi.fn(),
	getPMProvider: vi.fn(),
	requireProjectPMAdapter: vi.fn(),
	requireProjectPMProvider: () => ({
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
			url: 'https://github.com/SmartTechBrewery/swarm/issues/339',
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
			repository: { full_name: 'SmartTechBrewery/swarm' },
			issue: {
				number: 339,
				html_url: 'https://github.com/SmartTechBrewery/swarm/issues/339',
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
