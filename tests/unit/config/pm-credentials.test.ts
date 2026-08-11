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
	adoptLegacyPmCredentials,
	listPmCredentialReferences,
	pmCredentialReferenceFor,
} from '@/config/pm-credentials.js';
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

/**
 * A project config input with the given `github-projects` PM credential references —
 * the block for the provider `baselineProject` runs on, since issue #631 keyed the map
 * by provider id.
 */
function configWithPmReferences(pm: Record<string, string> | undefined): unknown {
	return configWithPmBlocks(pm ? { 'github-projects': pm } : undefined);
}

/** A project config input with whole `credentials.pm` map — one block per provider. */
function configWithPmBlocks(pm: unknown): unknown {
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
	// This project conventionally exports the webhook variable the github-projects role
	// declares (`GITHUB_WEBHOOK_SECRET` since issue #628 made the SCM references per
	// provider). Negative cases must be independent of whether the runner inherited it.
	vi.stubEnv('GITHUB_WEBHOOK_SECRET', '');
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
		expect(errors).toContain('credentials.pm.github-projects.apiToken');
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
		expect(errors).toContain('credentials.pm.github-projects.apiToken');
		expect(errors).toContain('JIRA_API_TOKEN');
	});

	it('rejects an absent block when the provider has a non-optional role', () => {
		registerRoles([{ role: 'apiToken', label: 'API Token', envVarKey: 'JIRA_API_TOKEN' }]);
		const errors = parseErrors(configWithPmReferences(undefined));
		expect(errors).toContain("requires the 'apiToken' credential (API Token)");
		expect(errors).toContain('credentials.pm.github-projects.apiToken');
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
		/** The Linear fixture with its own provider's `credentials.pm` block replaced. */
		function linearConfigWithPmReferences(pm: Record<string, string> | undefined): unknown {
			const linearProject = createMockLinearProjectConfig();
			return {
				...linearProject,
				credentials: {
					reviewer: linearProject.credentials.reviewer,
					webhookSecret: linearProject.credentials.webhookSecret,
					...(pm ? { pm: { linear: pm } } : {}),
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
			expect(errors).toContain('credentials.pm.linear.apiKey');
			expect(errors).toContain('LINEAR_API_KEY');
		});

		// Required rather than optional on purpose: the verifier fails closed on a null
		// secret, so an optional role would validate here and 401 every delivery.
		it('requires the webhookSecret role too, since it inherits nothing', () => {
			const errors = parseErrors(linearConfigWithPmReferences({ apiKey: 'LINEAR_API_KEY' }));
			expect(errors).toContain("requires the 'webhookSecret' credential (Webhook Secret)");
			expect(errors).toContain('credentials.pm.linear.webhookSecret');
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

	// Issue #631: the map is keyed by provider id, so the keys themselves are validated —
	// against the `PM_TYPES` value list rather than the registry, so a config parsed by a
	// surface that loaded no provider module is judged the same way.
	describe('the provider-id keys', () => {
		it('rejects a key that is not a PM provider id, naming the ids', () => {
			const errors = parseErrors(
				configWithPmBlocks({
					'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
					jiar: { apiToken: 'TYPO_KEY' },
				}),
			);
			expect(errors).toContain("'jiar' is not a PM provider id");
			expect(errors).toContain('github-projects, jira, linear, trello');
		});

		// The state the switch flow depends on: a project keeps the block of a provider it
		// is not running on, and only the *current* provider's roles have to be complete.
		it('accepts a retained block for a provider the project is not running on', () => {
			expect(
				ProjectConfigSchema.safeParse(
					configWithPmBlocks({
						'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
						// Deliberately incomplete for Jira (no `webhookSecret`): rule 3 is scoped to
						// `pm.type`, so a retained block need not satisfy its provider's presence rule.
						jira: { email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' },
					}),
				).success,
			).toBe(true);
		});

		// Structure is still checked for every block, current or retained, so a typo in a
		// retained provider's role is caught rather than surfacing on the switch.
		it('rejects a role a retained provider does not declare', () => {
			const errors = parseErrors(
				configWithPmBlocks({
					'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
					linear: { apiKey: 'LINEAR_API_KEY', apiToken: 'WRONG_ROLE' },
				}),
			);
			expect(errors).toContain("declares no credential role 'apiToken'");
			expect(errors).toContain('its roles are: apiKey, webhookSecret');
		});
	});
});

// Issue #631: a config written before the map was keyed by provider is nested under
// `pm.type` on parse, so nothing has to be re-entered by hand. This is a `z.preprocess`
// rather than the SCM side's output transform, because the legacy and live shapes share
// the one `credentials.pm` key.
describe('the legacy flat credentials.pm adoption', () => {
	/** The parsed project for a raw config input, which must parse. */
	function parsed(input: unknown): ProjectConfig {
		const result = ProjectConfigSchema.safeParse(input);
		expect(result.success).toBe(true);
		if (!result.success) throw result.error;
		return result.data;
	}

	it("nests a flat role map under the project's own provider", () => {
		const project = parsed(configWithPmBlocks({ apiToken: 'PM_GITHUB_PROJECTS_TOKEN' }));

		expect(project.credentials.pm).toEqual({
			'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
		});
	});

	it('nests it under a non-default provider just the same', () => {
		const linearProject = createMockLinearProjectConfig();
		const project = parsed({
			...linearProject,
			credentials: {
				pm: { apiKey: 'LINEAR_API_KEY', webhookSecret: 'LINEAR_WEBHOOK_SECRET' },
			},
		});

		expect(project.credentials.pm).toEqual({
			linear: { apiKey: 'LINEAR_API_KEY', webhookSecret: 'LINEAR_WEBHOOK_SECRET' },
		});
	});

	// Detected by value type rather than a version marker, which is also what makes the
	// adoption idempotent: a per-provider map has no string values, so it is left alone.
	it('leaves an already-nested map untouched', () => {
		const nested = {
			'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
			jira: { email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' },
		};
		const project = parsed(configWithPmBlocks(nested));

		expect(project.credentials.pm).toEqual(nested);
	});

	// Not a state SWARM produces, but pinned because the SQL backfill reads a mixed map
	// the same way and the two adoption paths must not disagree.
	it('moves only the flat entries of a map holding both shapes', () => {
		const project = parsed(
			configWithPmBlocks({
				apiToken: 'PM_GITHUB_PROJECTS_TOKEN',
				jira: { email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' },
			}),
		);

		expect(project.credentials.pm).toEqual({
			'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
		});
	});

	// The pass-through rules, asserted on the normalizer directly: each of these inputs
	// is one the schema behind the preprocess must be left to report on (or accept) itself,
	// so none can be exercised through a successful parse.
	describe('leaves alone what it cannot or must not adopt', () => {
		it.each([
			['a non-object', 'not a project'],
			['a project with no credentials', { pm: { type: 'github-projects' } }],
			['a project with no credentials.pm', { pm: { type: 'jira' }, credentials: {} }],
			['an empty map', { pm: { type: 'jira' }, credentials: { pm: {} } }],
			// Never defaulted to a provider: `pm` is required, so the base schema reports it.
			['a flat map with no pm.type to attribute it to', { credentials: { pm: { apiKey: 'K' } } }],
		])('%s', (_name, input) => {
			expect(adoptLegacyPmCredentials(input)).toBe(input);
		});
	});

	// The reference *name* is the store key the secret is already filed under, so
	// rewriting it to the manifest's conventional `envVarKey` would break resolution.
	it('copies the reference name verbatim rather than rewriting it to the conventional key', () => {
		const project = parsed(configWithPmBlocks({ apiToken: 'MY_BOARD_TOKEN' }));

		expect(project.credentials.pm?.['github-projects']?.apiToken).toBe('MY_BOARD_TOKEN');
	});
});

// The pure lookups the resolver and the API layer share — no registry, no DB.
describe('the pure reference lookups', () => {
	const twoBoards = {
		credentials: {
			pm: {
				'github-projects': { apiToken: 'PM_TOKEN_KEY' },
				jira: { email: 'JIRA_EMAIL_KEY', apiToken: 'PM_TOKEN_KEY' },
			},
		},
	};

	it('reads the reference for the provider it was asked for', () => {
		expect(pmCredentialReferenceFor(twoBoards, 'github-projects', 'apiToken')).toBe('PM_TOKEN_KEY');
		expect(pmCredentialReferenceFor(twoBoards, 'jira', 'email')).toBe('JIRA_EMAIL_KEY');
	});

	it('returns undefined for an unconfigured provider or role rather than another block’s', () => {
		expect(pmCredentialReferenceFor(twoBoards, 'linear', 'apiKey')).toBeUndefined();
		expect(pmCredentialReferenceFor(twoBoards, 'github-projects', 'email')).toBeUndefined();
		expect(pmCredentialReferenceFor({ credentials: {} }, 'jira', 'apiToken')).toBeUndefined();
	});

	// `swarm config apply` reads every block, so a retained provider's secrets are applied
	// too. Deduping is the caller's, which is why the repeated key is listed twice.
	it('lists every reference across all providers, undeduped', () => {
		expect(listPmCredentialReferences(twoBoards).sort()).toEqual([
			'JIRA_EMAIL_KEY',
			'PM_TOKEN_KEY',
			'PM_TOKEN_KEY',
		]);
		expect(listPmCredentialReferences({ credentials: {} })).toEqual([]);
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
			pm: { 'github-projects': { apiToken: 'PM_TOKEN_KEY', webhookSecret: 'PM_WEBHOOK_KEY' } },
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
			pm: { 'github-projects': { apiToken: 'PM_TOKEN_KEY' } },
		},
	});

	beforeEach(() => {
		vi.mocked(resolveProjectCredential).mockReset();
	});

	it("prefers the project's own reference for the role over the host env", async () => {
		vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'from-env');
		vi.mocked(resolveProjectCredential).mockResolvedValue('from-store');

		expect(await resolvePmCredential(project, 'webhookSecret')).toBe('from-store');
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'PM_WEBHOOK_KEY');
	});

	// The regression this phase exists to prevent (issue #631): `apiToken` is *both*
	// GitHub Projects' and Jira's role name, so a project retaining Jira's block must
	// resolve only the block for the provider it is running on. Deliberately not a
	// fallback chain — a retained block is stored and never read.
	it("reads only its own provider's block, never another provider's identical role", async () => {
		const twoBoards = createMockProjectConfig({
			id: 'proj-1',
			credentials: {
				reviewer: 'SCM_TOKEN_REVIEWER',
				webhookSecret: 'SHARED_WEBHOOK_KEY',
				pm: {
					'github-projects': { apiToken: 'PM_TOKEN_KEY' },
					jira: { email: 'JIRA_EMAIL_KEY', apiToken: 'JIRA_TOKEN_KEY' },
				},
			},
		});
		vi.mocked(resolveProjectCredential).mockImplementation(async (_id, key) => `secret:${key}`);

		expect(await resolvePmCredential(twoBoards, 'apiToken')).toBe('secret:PM_TOKEN_KEY');
		expect(resolveProjectCredential).not.toHaveBeenCalledWith('proj-1', 'JIRA_TOKEN_KEY');
	});

	// The other direction: a project on a provider whose block is absent fails closed
	// rather than reaching into the retained one that happens to declare the same role.
	it('resolves null for a role its own provider has no block for', async () => {
		const jiraBoardOnly = {
			...createMockProjectConfig({ id: 'proj-1' }),
			// Assembled, not parsed: `ProjectConfigSchema` rejects a config whose current
			// provider is missing a required role, which is exactly the state under test.
			credentials: {
				webhookSecret: 'SHARED_WEBHOOK_KEY',
				pm: { jira: { apiToken: 'JIRA_TOKEN_KEY' } },
			},
		};
		vi.mocked(resolveProjectCredential).mockImplementation(async (_id, key) => `secret:${key}`);

		expect(await resolvePmCredential(jiraBoardOnly, 'apiToken')).toBeNull();
		expect(resolveProjectCredential).not.toHaveBeenCalledWith('proj-1', 'JIRA_TOKEN_KEY');
	});

	// The reach that keeps GitHub Projects' effective credentials unchanged: with no
	// `credentials.pm`, the role resolves the repo side's own webhook-secret reference —
	// exactly what `getWebhookSecretOrNull` resolves. Since issue #628 that is the
	// *per-provider* reference for the SCM provider the project runs on; this fixture
	// states none, so it is GitHub's, which is where the legacy pair was adopted.
	it('falls back to the SCM reference the role declares it inherits', async () => {
		vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'from-env');
		vi.mocked(resolveProjectCredential).mockResolvedValue('shared-secret');

		expect(await resolvePmCredential(projectWithoutPmReferences, 'webhookSecret')).toBe(
			'shared-secret',
		);
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'SHARED_WEBHOOK_KEY');
	});

	// Issue #628: the inherited secret is the repo side's for the provider the project
	// *runs on*, so a board paired with a GitLab repo resolves GitLab's webhook secret and
	// never GitHub's — which for GitLab is the token it echoes in `X-Gitlab-Token`.
	it("inherits the per-provider secret for the project's own SCM provider", async () => {
		const gitlabRepoProject = createMockProjectConfig({
			id: 'proj-1',
			scm: 'gitlab',
			credentials: {
				scm: {
					github: { webhookSecret: 'GH_HOOK_KEY' },
					gitlab: { webhookSecret: 'GL_HOOK_KEY' },
				},
				pm: { 'github-projects': { apiToken: 'PM_TOKEN_KEY' } },
			},
		});
		vi.mocked(resolveProjectCredential).mockResolvedValue('gitlab-secret');

		expect(await resolvePmCredential(gitlabRepoProject, 'webhookSecret')).toBe('gitlab-secret');
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'GL_HOOK_KEY');
		expect(resolveProjectCredential).not.toHaveBeenCalledWith('proj-1', 'GH_HOOK_KEY');
	});

	// Fails closed rather than reaching for another provider's secret.
	it('resolves null when the project stores no secret for its own SCM provider', async () => {
		const unconfigured = createMockProjectConfig({
			id: 'proj-1',
			scm: 'bitbucket',
			credentials: {
				scm: { github: { webhookSecret: 'GH_HOOK_KEY' } },
				pm: { 'github-projects': { apiToken: 'PM_TOKEN_KEY' } },
			},
		});
		vi.mocked(resolveProjectCredential).mockResolvedValue('github-secret');

		expect(await resolvePmCredential(unconfigured, 'webhookSecret')).toBeNull();
		expect(resolveProjectCredential).not.toHaveBeenCalledWith('proj-1', 'GH_HOOK_KEY');
	});

	it("falls back to the role's env var when an explicitly configured role resolves nowhere", async () => {
		vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'from-env');
		vi.mocked(resolveProjectCredential).mockResolvedValue(null);

		expect(await resolvePmCredential(project, 'webhookSecret')).toBe('from-env');
		// Both store references were tried before the env — the configured one first.
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'PM_WEBHOOK_KEY');
		expect(resolveProjectCredential).toHaveBeenCalledWith('proj-1', 'SHARED_WEBHOOK_KEY');
	});

	it('fails closed for an inherited role with no PM reference even when its env var is set', async () => {
		vi.stubEnv('GITHUB_WEBHOOK_SECRET', 'ambient-secret');
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
			/credentials\.pm\.github-projects\.webhookSecret.*GITHUB_WEBHOOK_SECRET/s,
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
			// Carried since issue #631, because the path an operator is told to set is per
			// provider and `src/api/routers/pm.ts` composes its own copy from these fields.
			providerId: 'github-projects',
			role: 'apiToken',
			label: 'GitHub Projects API Token',
			envVarKey: 'PM_GITHUB_PROJECTS_TOKEN',
		});
		// It names what is missing, never a credential value.
		expect(String(error.message)).not.toContain('whsec');
	});
});
