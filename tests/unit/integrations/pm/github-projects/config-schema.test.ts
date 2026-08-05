import { describe, expect, it } from 'vitest';
import type { ProjectPm } from '@/config/schema.js';
import {
	githubProjectsConfigSchema,
	requireGitHubProjectsConfig,
} from '@/integrations/pm/github-projects/config-schema.js';
import {
	createMockGitHubProjectsConfig,
	createMockProjectConfig,
} from '../../../../helpers/factories.js';

describe('githubProjectsConfigSchema', () => {
	it('accepts a valid board mapping', () => {
		const config = createMockGitHubProjectsConfig();
		expect(config.projectId).toBe('PVT_kwHOAC3TF84BcNwD');
		expect(config.statusOptions.inProgress).toBe('47fc9ee4');
	});

	it('round-trips a parsed config unchanged (no drift, no stripped fields)', () => {
		const input = {
			projectId: 'PVT_x',
			statusFieldId: 'PVTSSF_y',
			statusOptions: { backlog: 'opt-1', done: 'opt-2' },
			phaseLabels: { 'phase-0': 'phase-0' },
		};
		expect(githubProjectsConfigSchema.parse(input)).toEqual(input);
	});

	it('treats phaseLabels as optional', () => {
		const config = createMockGitHubProjectsConfig();
		expect(config.phaseLabels).toBeUndefined();
	});

	it('rejects an empty projectId', () => {
		expect(() =>
			githubProjectsConfigSchema.parse({
				projectId: '',
				statusFieldId: 'PVTSSF_y',
				statusOptions: { backlog: 'opt-1' },
			}),
		).toThrow();
	});

	it('rejects an empty statusOptions record', () => {
		expect(() =>
			githubProjectsConfigSchema.parse({
				projectId: 'PVT_x',
				statusFieldId: 'PVTSSF_y',
				statusOptions: {},
			}),
		).toThrow();
	});

	it('strips unknown keys rather than rejecting them (non-strict object)', () => {
		const parsed = githubProjectsConfigSchema.parse({
			projectId: 'PVT_x',
			statusFieldId: 'PVTSSF_y',
			statusOptions: { backlog: 'opt-1' },
			unexpected: 'dropped',
		});
		expect(parsed).not.toHaveProperty('unexpected');
	});

	it('rejects an empty status-option value', () => {
		expect(() =>
			githubProjectsConfigSchema.parse({
				projectId: 'PVT_x',
				statusFieldId: 'PVTSSF_y',
				statusOptions: { backlog: '' },
			}),
		).toThrow();
	});

	it('rejects a missing statusFieldId', () => {
		expect(() =>
			githubProjectsConfigSchema.parse({
				projectId: 'PVT_x',
				statusOptions: { backlog: 'opt-1' },
			}),
		).toThrow();
	});
});

describe('requireGitHubProjectsConfig', () => {
	it('narrows the project pm union member to this provider board mapping', () => {
		const project = createMockProjectConfig();

		const config = requireGitHubProjectsConfig(project);

		// The provider's own config, with the union discriminator left behind.
		expect(config).toEqual(createMockGitHubProjectsConfig());
		expect(config).not.toHaveProperty('type');
		// And it validates as the provider's own schema — the narrowing loses nothing.
		expect(githubProjectsConfigSchema.parse(config)).toEqual(config);
	});

	it('throws when the project is configured for another PM provider', () => {
		// Assembled around the schema, not through it: `ProjectPm` has one member today,
		// so the only way to reach this guard is a call site naming this provider for a
		// board it does not own — a wiring bug, which is what the throw reports.
		const project = {
			...createMockProjectConfig(),
			pm: { type: 'jira', projectId: 'PROJ' } as unknown as ProjectPm,
		};

		expect(() => requireGitHubProjectsConfig(project)).toThrow(/'jira'/);
	});
});
