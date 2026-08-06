import { describe, expect, it } from 'vitest';

import { linearConfigSchema, requireLinearConfig } from '@/integrations/pm/linear/config-schema.js';
import {
	createMockGitHubProjectsConfig,
	createMockLinearConfig,
	createMockLinearProjectConfig,
	createMockProjectConfig,
} from '../../../../helpers/factories.js';

describe('linearConfigSchema', () => {
	it('accepts a team and at least one workflow-state mapping', () => {
		const config = createMockLinearConfig();
		expect(config.teamId).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
		expect(config.statusOptions.inProgress).toBe('24a31a62-af5f-449a-aa73-8e636a81e5a2');
	});

	it.each([
		{ teamId: '', statusOptions: { backlog: 'state-1' } },
		{ teamId: 'team-1', statusOptions: {} },
		{ teamId: 'team-1', statusOptions: { backlog: '' } },
	])('rejects an incomplete board mapping', (config) => {
		expect(() => linearConfigSchema.parse(config)).toThrow();
	});

	it('rejects GitHub Projects-only keys instead of silently retaining a mixed mapping', () => {
		expect(() =>
			linearConfigSchema.parse({
				...createMockLinearConfig(),
				projectId: createMockGitHubProjectsConfig().projectId,
			}),
		).toThrow();
	});
});

describe('requireLinearConfig', () => {
	it('narrows a Linear pm member and strips its discriminator', () => {
		const config = requireLinearConfig(createMockLinearProjectConfig());

		expect(config).toEqual(createMockLinearConfig());
		expect(config).not.toHaveProperty('type');
	});

	it('names both providers when called for a GitHub Projects project', () => {
		expect(() => requireLinearConfig(createMockProjectConfig())).toThrow(
			/'github-projects'.*'linear'/,
		);
	});
});
