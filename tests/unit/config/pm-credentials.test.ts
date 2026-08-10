import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockLinearProjectConfig, createMockProjectConfig } from '../../helpers/factories.js';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveProjectCredential: vi.fn(),
}));
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByRepoFromDb: vi.fn(),
	findProjectByBoardFromDb: vi.fn(),
}));

import {
	MissingPmCredentialError,
	requirePmCredential,
	resolvePmCredential,
} from '@/config/provider.js';
import { type ProjectConfig, ProjectConfigSchema } from '@/config/schema.js';
import { resolveProjectCredential } from '@/db/repositories/credentialsRepository.js';
// Registers the real PM manifests, whose declared roles both halves of this suite
// validate and resolve against.
import '@/integrations/entrypoint.js';
import { githubProjectsManifest } from '@/integrations/pm/github-projects/index.js';
import { jiraManifest } from '@/integrations/pm/jira/index.js';
import { linearManifest } from '@/integrations/pm/linear/index.js';
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

// Keep this parsed while the real GitHub Projects manifest is registered. The
// validation tests intentionally replace that manifest with stricter synthetic
// roles, then pass raw inputs to the schema under test.
const baselineProject = createMockProjectConfig();

/** A project config input with the given PM credential references. */
function configWithPmReferences(pm: Record<string, string> | undefined): unknown {
	return {
		...baselineProject,
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
	// Restore what the entrypoint import registered — every provider, not just the
	// first: a test that swaps a manifest behind an id must not leave Linear or Jira
	// unregistered for the ones after it.
	_resetPMProviderRegistryForTesting();
	registerPMProvider(githubProjectsManifest);
	registerPMProvider(linearManifest);
	registerPMProvider(jiraManifest);
	vi.unstubAllEnvs();
});

beforeEach(() => {
	// This project conventionally exports the shared webhook variable. Negative
	// cases must be independent of whether the runner inherited that environment.
	vi.stubEnv('SCM_WEBHOOK_SECRET', '');
});

describe('credentials.pm validation against the declared roles', () => {
	it('accepts an absent credentials.pm when every declared role resolves without one', () => {
		// GitHub Projects' pre-#537 shape: a single role that inherits the shared
		// webhook secret, so an absent block is still a complete configuration.
		registerRoles([
			{
				role: 'webhookSecret',
				label: 'Webhook Secret',
				envVarKey: 'SCM_WEBHOOK_SECRET',
				inheritsSharedCredential: 'webhookSecret',
			},
		]);
		expect(ProjectConfigSchema.safeParse(configWithPmReferences(undefined)).success).toBe(true);
	});

	// The role GitHub Projects gained in #537: the board's own API token, required,
	// so a config that names no reference for it fails instead of quietly falling
	// back to the worker operator's SCM token.
	it("requires GitHub Projects' own apiToken role", () => {
		const errors = parseErrors(configWithPmReferences({}));
		expect(errors).toContain("requires the 'apiToken' credential (GitHub Projects API Token)");
		expect(errors).toContain('credentials.pm.apiToken');
		expect(errors).toContain('PM_GITHUB_PROJECTS_TOKEN');
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

	it('rejects an absent block when the provider has a non-optional role', () => {
		registerRoles([{ role: 'apiToken', label: 'API Token', envVarKey: 'JIRA_API_TOKEN' }]);
		const errors = parseErrors(configWithPmReferences(undefined));
		expect(errors).toContain("requires the 'apiToken' credential (API Token)");
		expect(errors).toContain('credentials.pm.apiToken');
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

	// GitHub Projects' own shape: `webhookSecret` is a non-optional role that already
	// resolves from the shared block, so a project names only `apiToken`.
	it('does not require a role that inherits a shared credential reference', () => {
		expect(
			ProjectConfigSchema.safeParse(
				configWithPmReferences({ apiToken: 'PM_GITHUB_PROJECTS_TOKEN' }),
			).success,
		).toBe(true);
	});

	it('skips the check when no manifest is registered for pm.type', () => {
		_resetPMProviderRegistryForTesting();
		expect(ProjectConfigSchema.safeParse(configWithPmReferences({ whatever: 'KEY' })).success).toBe(
			true,
		);
	});

	// Linear is the second registered provider, and the first whose roles a project
	// must configure in full: neither inherits a shared SCM credential, because its
	// board is a separate system from the repo (issue #530). The check runs against
	// the *registered* manifest, which is why this suite imports the entrypoint.
	describe('a pm.type linear project', () => {
		/** The Linear fixture with its `credentials.pm` block replaced. */
		function linearConfigWithPmReferences(pm: Record<string, string> | undefined): unknown {
			const linearProject = createMockLinearProjectConfig();
			return {
				...linearProject,
				credentials: {
					reviewer: linearProject.credentials.reviewer,
					webhookSecret: linearProject.credentials.webhookSecret,
					...(pm ? { pm } : {}),
				},
			};
		}

		it('validates once both of its own references are named', () => {
			expect(
				ProjectConfigSchema.safeParse(
					linearConfigWithPmReferences({
						apiKey: 'LINEAR_API_KEY',
						webhookSecret: 'LINEAR_WEBHOOK_SECRET',
					}),
				).success,
			).toBe(true);
		});

		it('requires the apiKey role, naming it and its env var', () => {
			const errors = parseErrors(
				linearConfigWithPmReferences({ webhookSecret: 'LINEAR_WEBHOOK_SECRET' }),
			);
			expect(errors).toContain("requires the 'apiKey' credential (API Key)");
			expect(errors).toContain('credentials.pm.apiKey');
			expect(errors).toContain('LINEAR_API_KEY');
		});

		// Required rather than optional on purpose: the verifier fails closed on a null
		// secret, so an optional role would validate here and 401 every delivery.
		it('requires the webhookSecret role too, since it inherits nothing', () => {
			const errors = parseErrors(linearConfigWithPmReferences({ apiKey: 'LINEAR_API_KEY' }));
			expect(errors).toContain("requires the 'webhookSecret' credential (Webhook Secret)");
			expect(errors).toContain('credentials.pm.webhookSecret');
			expect(errors).toContain('LINEAR_WEBHOOK_SECRET');
		});

		it("rejects GitHub Projects' apiToken role, which Linear does not declare", () => {
			const errors = parseErrors(
				linearConfigWithPmReferences({
					apiKey: 'LINEAR_API_KEY',
					webhookSecret: 'LINEAR_WEBHOOK_SECRET',
					apiToken: 'PM_GITHUB_PROJECTS_TOKEN',
				}),
			);
			expect(errors).toContain("declares no credential role 'apiToken'");
			expect(errors).toContain('its roles are: apiKey, webhookSecret');
		});
	});
});

describe('resolvePmCredential', () => {
	// `credentials.webhookSecret` is what the github-projects role inherits. Both
	// configs name the provider's required `apiToken` role, since #537 made it a
	// condition of a valid config.
	const project: ProjectConfig = createMockProjectConfig({
		id: 'proj-1',
		credentials: {
			reviewer: 'SCM_TOKEN_REVIEWER',
			webhookSecret: 'SHARED_WEBHOOK_KEY',
			pm: { apiToken: 'PM_TOKEN_KEY', webhookSecret: 'PM_WEBHOOK_KEY' },
		},
	});

	/**
	 * The same project with no PM reference for the *webhook* role — the common case,
	 * since that role inherits the shared SCM secret rather than being configured.
	 */
	const projectWithoutPmReferences: ProjectConfig = createMockProjectConfig({
		id: 'proj-1',
		credentials: {
			reviewer: 'SCM_TOKEN_REVIEWER',
			webhookSecret: 'SHARED_WEBHOOK_KEY',
			pm: { apiToken: 'PM_TOKEN_KEY' },
		},
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

	it("falls back to the role's env var when an explicitly configured role resolves nowhere", async () => {
		vi.stubEnv('SCM_WEBHOOK_SECRET', 'from-env');
		vi.mocked(resolveProjectCredential).mockResolvedValue(null);

		expect(await resolvePmCredential(project, 'webhookSecret')).toBe('from-env');
		// Both store references were tried before the env — the configured one first.
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'PM_WEBHOOK_KEY');
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'SHARED_WEBHOOK_KEY');
	});

	it('fails closed for an inherited role with no PM reference even when its env var is set', async () => {
		vi.stubEnv('SCM_WEBHOOK_SECRET', 'ambient-secret');
		vi.mocked(resolveProjectCredential).mockResolvedValue(null);

		expect(await resolvePmCredential(projectWithoutPmReferences, 'webhookSecret')).toBeNull();
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'SHARED_WEBHOOK_KEY');
	});

	it('returns null when neither the store nor the env has it', async () => {
		vi.mocked(resolveProjectCredential).mockResolvedValue(null);
		expect(await resolvePmCredential(project, 'webhookSecret')).toBeNull();
	});

	it('throws for a role the provider does not declare', async () => {
		vi.mocked(resolveProjectCredential).mockResolvedValue('anything');
		await expect(resolvePmCredential(project, 'notARole')).rejects.toThrow(
			/declares no credential role 'notARole'/,
		);
	});

	// The whole point of #537: the board's token is a project credential, and nothing
	// in this resolution path reaches for the worker-local operator SCM token.
	it('never falls back to the operator SCM token for the board API token', async () => {
		vi.stubEnv('SWARM_OPERATOR_GH_TOKEN', 'ghp_operator');
		vi.mocked(resolveProjectCredential).mockResolvedValue(null);

		expect(await resolvePmCredential(project, 'apiToken')).toBeNull();
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'PM_TOKEN_KEY');
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

	// Typed, because two surfaces recognize this condition rather than reporting it:
	// the discovery API maps it to PRECONDITION_FAILED and the dashboard renders the
	// "configure this credential" affordance off that code (issue #537).
	it('throws a MissingPmCredentialError carrying the role metadata', async () => {
		vi.mocked(resolveProjectCredential).mockResolvedValue(null);
		const error = await requirePmCredential(project, 'apiToken').catch((err) => err);

		expect(error).toBeInstanceOf(MissingPmCredentialError);
		expect(error).toMatchObject({
			projectId: 'proj-1',
			role: 'apiToken',
			label: 'GitHub Projects API Token',
			envVarKey: 'PM_GITHUB_PROJECTS_TOKEN',
		});
		// It names what is missing, never a credential value.
		expect(String(error.message)).not.toContain('whsec');
	});
});
