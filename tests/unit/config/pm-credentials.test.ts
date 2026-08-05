import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../helpers/factories.js';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveProjectCredential: vi.fn(),
}));
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByRepoFromDb: vi.fn(),
	findProjectByBoardFromDb: vi.fn(),
}));

import { requirePmCredential, resolvePmCredential } from '@/config/provider.js';
import { type ProjectConfig, ProjectConfigSchema } from '@/config/schema.js';
import { resolveProjectCredential } from '@/db/repositories/credentialsRepository.js';
// Registers the real github-projects manifest, whose declared roles both halves of
// this suite validate and resolve against.
import '@/integrations/entrypoint.js';
import { githubProjectsManifest } from '@/integrations/pm/github-projects/index.js';
import type { PmCredentialRoleSpec } from '@/integrations/pm/manifest.js';
import {
	_resetPMProviderRegistryForTesting,
	registerPMProvider,
} from '@/integrations/pm/registry.js';

/**
 * Re-register the `github-projects` id with a different set of declared roles.
 * `pm.type` is a closed union in `ProjectConfigSchema`, so swapping the manifest
 * behind the id — rather than inventing a `PMType` — is how a test exercises roles
 * GitHub Projects itself doesn't declare (a Jira-shaped API token, an optional role).
 */
function registerRoles(credentialRoles: readonly PmCredentialRoleSpec[]): void {
	_resetPMProviderRegistryForTesting();
	registerPMProvider({ ...githubProjectsManifest, credentialRoles });
}

/** A project config input with the given PM credential references. */
function configWithPmReferences(pm: Record<string, string> | undefined): unknown {
	const project = createMockProjectConfig();
	return {
		...project,
		credentials: {
			reviewer: 'SCM_TOKEN_REVIEWER',
			webhookSecret: 'SCM_WEBHOOK_SECRET',
			...(pm ? { pm } : {}),
		},
	};
}

/** The messages of a failed parse, joined — enough to assert what an operator is told. */
function parseErrors(input: unknown): string {
	const result = ProjectConfigSchema.safeParse(input);
	expect(result.success).toBe(false);
	return result.success ? '' : result.error.issues.map((issue) => issue.message).join('\n');
}

afterEach(() => {
	_resetPMProviderRegistryForTesting();
	registerPMProvider(githubProjectsManifest);
	vi.unstubAllEnvs();
});

describe('credentials.pm validation against the declared roles', () => {
	it('accepts a config with no credentials.pm at all (every config written before #497)', () => {
		expect(ProjectConfigSchema.safeParse(configWithPmReferences(undefined)).success).toBe(true);
	});

	it('rejects a reference for a role the provider does not declare, naming the declared roles', () => {
		registerRoles([{ role: 'apiToken', label: 'API Token', envVarKey: 'JIRA_API_TOKEN' }]);
		const errors = parseErrors(configWithPmReferences({ apiToken: 'X', apiKey: 'Y' }));
		expect(errors).toContain("declares no credential role 'apiKey'");
		expect(errors).toContain('its roles are: apiToken');
	});

	it('rejects a configured block that omits a non-optional role, naming it and its env var', () => {
		registerRoles([
			{ role: 'email', label: 'Email', envVarKey: 'JIRA_EMAIL' },
			{ role: 'apiToken', label: 'API Token', envVarKey: 'JIRA_API_TOKEN' },
		]);
		const errors = parseErrors(configWithPmReferences({ email: 'JIRA_EMAIL' }));
		expect(errors).toContain("requires the 'apiToken' credential (API Token)");
		expect(errors).toContain('credentials.pm.apiToken');
		expect(errors).toContain('JIRA_API_TOKEN');
	});

	it('does not require an optional role', () => {
		registerRoles([
			{ role: 'apiKey', label: 'API Key', envVarKey: 'LINEAR_API_KEY' },
			{
				role: 'webhookSecret',
				label: 'Webhook Secret',
				envVarKey: 'LINEAR_WEBHOOK_SECRET',
				optional: true,
			},
		]);
		expect(
			ProjectConfigSchema.safeParse(configWithPmReferences({ apiKey: 'LINEAR_API_KEY' })).success,
		).toBe(true);
	});

	// GitHub Projects' own shape: a non-optional role that already resolves from the
	// shared block, so a project need not name it even when it configures others.
	it('does not require a role that inherits a shared credential reference', () => {
		expect(ProjectConfigSchema.safeParse(configWithPmReferences({})).success).toBe(true);
	});

	it('skips the check when no manifest is registered for pm.type', () => {
		_resetPMProviderRegistryForTesting();
		expect(ProjectConfigSchema.safeParse(configWithPmReferences({ whatever: 'KEY' })).success).toBe(
			true,
		);
	});
});

describe('resolvePmCredential', () => {
	// `credentials.webhookSecret` is what the github-projects role inherits.
	const project: ProjectConfig = createMockProjectConfig({
		id: 'proj-1',
		credentials: {
			reviewer: 'SCM_TOKEN_REVIEWER',
			webhookSecret: 'SHARED_WEBHOOK_KEY',
			pm: { webhookSecret: 'PM_WEBHOOK_KEY' },
		},
	});

	/** The same project with no PM references configured — the common case today. */
	const projectWithoutPmReferences: ProjectConfig = createMockProjectConfig({
		id: 'proj-1',
		credentials: { reviewer: 'SCM_TOKEN_REVIEWER', webhookSecret: 'SHARED_WEBHOOK_KEY' },
	});

	beforeEach(() => {
		vi.mocked(resolveProjectCredential).mockReset();
	});

	it("prefers the project's own reference for the role over the host env", async () => {
		vi.stubEnv('SCM_WEBHOOK_SECRET', 'from-env');
		vi.mocked(resolveProjectCredential).mockResolvedValue('from-store');

		expect(await resolvePmCredential(project, 'webhookSecret')).toBe('from-store');
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'PM_WEBHOOK_KEY');
	});

	// The reach that keeps GitHub Projects' effective credentials unchanged: with no
	// `credentials.pm`, the role resolves the project's existing shared reference —
	// exactly what `getWebhookSecretOrNull` resolves for the repo side.
	it('falls back to the shared reference the role declares it inherits', async () => {
		vi.stubEnv('SCM_WEBHOOK_SECRET', 'from-env');
		vi.mocked(resolveProjectCredential).mockResolvedValue('shared-secret');

		expect(await resolvePmCredential(projectWithoutPmReferences, 'webhookSecret')).toBe(
			'shared-secret',
		);
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'SHARED_WEBHOOK_KEY');
	});

	it("falls back to the role's env var when nothing resolves from the store", async () => {
		vi.stubEnv('SCM_WEBHOOK_SECRET', 'from-env');
		vi.mocked(resolveProjectCredential).mockResolvedValue(null);

		expect(await resolvePmCredential(project, 'webhookSecret')).toBe('from-env');
		// Both store references were tried before the env — the configured one first.
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'PM_WEBHOOK_KEY');
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'SHARED_WEBHOOK_KEY');
	});

	it('returns null when neither the store nor the env has it', async () => {
		vi.mocked(resolveProjectCredential).mockResolvedValue(null);
		expect(await resolvePmCredential(project, 'webhookSecret')).toBeNull();
	});

	it('throws for a role the provider does not declare', async () => {
		vi.mocked(resolveProjectCredential).mockResolvedValue('anything');
		await expect(resolvePmCredential(project, 'apiToken')).rejects.toThrow(
			/declares no credential role 'apiToken'/,
		);
	});
});

describe('requirePmCredential', () => {
	const project: ProjectConfig = createMockProjectConfig({ id: 'proj-1' });

	beforeEach(() => {
		vi.mocked(resolveProjectCredential).mockReset();
	});

	it('returns the resolved secret', async () => {
		vi.mocked(resolveProjectCredential).mockResolvedValue('whsec_123');
		expect(await requirePmCredential(project, 'webhookSecret')).toBe('whsec_123');
	});

	it('throws naming the role and both ways to supply it', async () => {
		vi.mocked(resolveProjectCredential).mockResolvedValue(null);
		await expect(requirePmCredential(project, 'webhookSecret')).rejects.toThrow(
			/credentials\.pm\.webhookSecret.*SCM_WEBHOOK_SECRET/s,
		);
	});
});
