import { describe, expect, it } from 'vitest';

import { requireTrelloConfig, trelloConfigSchema } from '@/integrations/pm/trello/config-schema.js';
import {
	createMockJiraProjectConfig,
	createMockLinearProjectConfig,
	createMockProjectConfig,
	createMockTrelloConfig,
	createMockTrelloProjectConfig,
} from '../../../../helpers/factories.js';

describe('trelloConfigSchema', () => {
	it('accepts a board id and at least one list mapping', () => {
		const config = createMockTrelloConfig();
		expect(config.boardId).toBe('5f2b9c1a4e6d7f0a1b2c3d4e');
		expect(config.statusOptions.inProgress).toBe('6a1b2c3d4e5f60718293a4b3');
	});

	it.each([
		{ boardId: '', statusOptions: { backlog: '6a1b2c3d4e5f60718293a4b0' } },
		{ boardId: '5f2b9c1a4e6d7f0a1b2c3d4e', statusOptions: {} },
		{ boardId: '5f2b9c1a4e6d7f0a1b2c3d4e', statusOptions: { backlog: '' } },
		{ statusOptions: { backlog: '6a1b2c3d4e5f60718293a4b0' } },
	])('rejects an incomplete board mapping', (config) => {
		expect(() => trelloConfigSchema.parse(config)).toThrow();
	});

	it('accepts a partial mapping, since a board may have no list for every status', () => {
		expect(
			trelloConfigSchema.parse({
				boardId: '5f2b9c1a4e6d7f0a1b2c3d4e',
				statusOptions: { todo: '6a1b2c3d4e5f60718293a4b2' },
			}).statusOptions,
		).toEqual({ todo: '6a1b2c3d4e5f60718293a4b2' });
	});

	it.each([
		// Cascade's Trello config names the mapping `lists` and carries a label map;
		// `.strict()` rejects both rather than silently retaining a foreign shape.
		{ label: "Cascade's lists key", extra: { lists: { backlog: '6a1b2c3d4e5f60718293a4b0' } } },
		{ label: 'a label map', extra: { labels: { processing: 'label-1' } } },
		{ label: 'a foreign container field', extra: { teamId: 'not-a-trello-field' } },
	])('rejects $label', ({ extra }) => {
		expect(() => trelloConfigSchema.parse({ ...createMockTrelloConfig(), ...extra })).toThrow();
	});
});

describe('requireTrelloConfig', () => {
	it('narrows a Trello pm member and strips its discriminator', () => {
		const config = requireTrelloConfig(createMockTrelloProjectConfig());

		expect(config).toEqual(createMockTrelloConfig());
		expect(config).not.toHaveProperty('type');
	});

	it.each([
		{ provider: 'github-projects', project: createMockProjectConfig() },
		{ provider: 'linear', project: createMockLinearProjectConfig() },
		{ provider: 'jira', project: createMockJiraProjectConfig() },
	])('names both providers when called for a $provider project', ({ provider, project }) => {
		expect(() => requireTrelloConfig(project)).toThrow(new RegExp(`'${provider}'.*'trello'`));
	});
});
