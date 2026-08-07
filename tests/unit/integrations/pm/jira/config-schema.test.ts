import { describe, expect, it } from 'vitest';

import { jiraConfigSchema, requireJiraConfig } from '@/integrations/pm/jira/config-schema.js';
import {
	createMockGitHubProjectsConfig,
	createMockJiraConfig,
	createMockJiraProjectConfig,
	createMockLinearProjectConfig,
	createMockProjectConfig,
} from '../../../../helpers/factories.js';

describe('jiraConfigSchema', () => {
	it('accepts a site, project key, and at least one status mapping', () => {
		const config = createMockJiraConfig();
		expect(config.baseUrl).toBe('https://example.atlassian.net');
		expect(config.projectKey).toBe('SWARM');
		expect(config.statusOptions.inProgress).toBe('3');
	});

	it.each([
		{ baseUrl: 'example.atlassian.net', projectKey: 'SWARM', statusOptions: { backlog: '10000' } },
		{
			baseUrl: 'https://example.atlassian.net',
			projectKey: '',
			statusOptions: { backlog: '10000' },
		},
		{ baseUrl: 'https://example.atlassian.net', projectKey: 'SWARM', statusOptions: {} },
		{
			baseUrl: 'https://example.atlassian.net',
			projectKey: 'SWARM',
			statusOptions: { backlog: '' },
		},
	])('rejects an incomplete board mapping', (config) => {
		expect(() => jiraConfigSchema.parse(config)).toThrow();
	});

	it('accepts a non-atlassian.net host, since sandbox tenants are not on it', () => {
		expect(
			jiraConfigSchema.parse(createMockJiraConfig({ baseUrl: 'https://swarm.jira-dev.com' }))
				.baseUrl,
		).toBe('https://swarm.jira-dev.com');
	});

	it('rejects GitHub Projects-only keys instead of silently retaining a mixed mapping', () => {
		expect(() =>
			jiraConfigSchema.parse({
				...createMockJiraConfig(),
				projectId: createMockGitHubProjectsConfig().projectId,
			}),
		).toThrow();
	});
});

describe('requireJiraConfig', () => {
	it('narrows a Jira pm member and strips its discriminator', () => {
		const config = requireJiraConfig(createMockJiraProjectConfig());

		expect(config).toEqual(createMockJiraConfig());
		expect(config).not.toHaveProperty('type');
	});

	it.each([
		{ provider: 'github-projects', project: createMockProjectConfig() },
		{ provider: 'linear', project: createMockLinearProjectConfig() },
	])('names both providers when called for a $provider project', ({ provider, project }) => {
		expect(() => requireJiraConfig(project)).toThrow(new RegExp(`'${provider}'.*'jira'`));
	});
});
