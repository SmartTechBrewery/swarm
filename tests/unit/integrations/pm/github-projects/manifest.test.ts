import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers the
// github-projects side-effect registration. Vitest isolates module state per
// test file, so this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import { githubProjectsManifest } from '@/integrations/pm/github-projects/index.js';
import { getPMProvider, listPMProviders } from '@/integrations/pm/registry.js';
import { createMockGitHubProjectsConfig } from '../../../../helpers/factories.js';

describe('github-projects manifest registration', () => {
	it('registers itself into the registry via the entrypoint import', () => {
		expect(getPMProvider('github-projects')).toBe(githubProjectsManifest);
	});

	it('registers exactly once (the entrypoint has one PM provider today)', () => {
		expect(listPMProviders().map((m) => m.id)).toEqual(['github-projects']);
	});

	it('declares the expected identity', () => {
		expect(githubProjectsManifest).toMatchObject({
			id: 'github-projects',
			label: 'GitHub Projects',
			category: 'pm',
			createProvider: expect.any(Function),
		});
	});

	it('exposes the provider config schema, which parses a valid board mapping', () => {
		const config = createMockGitHubProjectsConfig();
		expect(githubProjectsManifest.configSchema.parse(config)).toEqual(config);
	});

	it('exposes a router adapter wired to the same provider id', () => {
		expect(githubProjectsManifest.routerAdapter.type).toBe('github-projects');
	});

	it("satisfies the whole PMRouterAdapter contract the manifest's field is typed to", () => {
		// The field is now the provider-neutral interface (issue #297), so a provider
		// that implements only part of the ingress seam must fail here rather than at
		// the first webhook that reaches the missing method.
		const adapter = githubProjectsManifest.routerAdapter;
		for (const method of [
			'parseWebhook',
			'resolveProject',
			'isStatusChange',
			'isSelfAuthored',
			'synthesizeStateChange',
		] as const) {
			expect(adapter[method], method).toBeTypeOf('function');
		}
	});

	// Issue #496: the receiver mounts routes from the registry, so the shared
	// `/github/webhook` path is declared here as data rather than hardcoded there.
	it('declares the shared GitHub webhook route and a signature verifier', () => {
		expect(githubProjectsManifest.webhookRoute).toBe('/github/webhook');
		expect(githubProjectsManifest.verifyWebhookSignature).toBeTypeOf('function');
	});

	it('declares the board and state discovery capabilities', () => {
		expect(githubProjectsManifest.discovery).toEqual(['containers', 'states']);
	});

	// Issue #537: the board's own API token is a required project credential — this is
	// what replaced borrowing the SCM implementer persona's worker-local operator
	// token. `description` is provider-authored copy the Project Management tab
	// renders, and it names the permissions the token needs.
	it('declares a required board API-token role naming its permissions', () => {
		const apiToken = githubProjectsManifest.credentialRoles.find(
			(role) => role.role === 'apiToken',
		);
		expect(apiToken).toMatchObject({
			role: 'apiToken',
			label: 'GitHub Projects API Token',
			envVarKey: 'PM_GITHUB_PROJECTS_TOKEN',
		});
		// Required: neither optional nor satisfied by a shared SCM reference.
		expect(apiToken?.optional).toBeUndefined();
		expect(apiToken?.inheritsSharedCredential).toBeUndefined();
		expect(apiToken?.description).toContain('read:org');
	});

	// Issue #497: the webhook secret inherits the shared SCM reference rather than
	// asking a project to configure a second one, because board and repo are literally
	// the same webhook.
	it('declares a webhook-secret role that inherits the shared reference', () => {
		expect(githubProjectsManifest.credentialRoles).toContainEqual(
			expect.objectContaining({
				role: 'webhookSecret',
				envVarKey: 'SCM_WEBHOOK_SECRET',
				inheritsSharedCredential: 'webhookSecret',
			}),
		);
	});

	// The board authenticates as its own credential, not as an SCM persona (#537), so
	// the persona roles are still not credential roles of this provider.
	it('declares no persona-token roles', () => {
		expect(githubProjectsManifest.credentialRoles.map((role) => role.role)).toEqual([
			'apiToken',
			'webhookSecret',
		]);
	});
});
