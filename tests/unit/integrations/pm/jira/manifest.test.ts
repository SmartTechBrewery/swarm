import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers the
// jira side-effect registration. Vitest isolates module state per test file, so
// this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import { jiraManifest } from '@/integrations/pm/jira/index.js';
import { verifyJiraWebhookSignature } from '@/integrations/pm/jira/webhook.js';
import {
	getPMProvider,
	listPMProviders,
	requireProjectPMAdapter,
	requireProjectPMProvider,
} from '@/integrations/pm/registry.js';
import {
	createMockJiraConfig,
	createMockJiraProjectConfig,
} from '../../../../helpers/factories.js';

describe('jira manifest registration', () => {
	it('registers itself into the registry via the entrypoint import', () => {
		expect(getPMProvider('jira')).toBe(jiraManifest);
	});

	it('registers alongside the providers already there rather than replacing them', () => {
		expect(listPMProviders().map((m) => m.id)).toEqual([
			'github-projects',
			'linear',
			'jira',
			'trello',
		]);
	});

	it('declares the expected identity', () => {
		expect(jiraManifest).toMatchObject({
			id: 'jira',
			label: 'Jira',
			category: 'pm',
			createProvider: expect.any(Function),
		});
	});

	it('exposes the provider config schema, which parses a valid board mapping', () => {
		const config = createMockJiraConfig();
		expect(jiraManifest.configSchema.parse(config)).toEqual(config);
	});

	it('exposes a router adapter wired to the same provider id', () => {
		expect(jiraManifest.routerAdapter.type).toBe('jira');
	});

	// Its own route, unlike GitHub Projects' co-tenancy of `/github/webhook`: a Jira
	// site is a separate system, so the receiver mounts a GET ping + POST pair here
	// (issue #496).
	it('declares its own webhook route, authenticated by its own verifier', () => {
		expect(jiraManifest.webhookRoute).toBe('/jira/webhook');
		// The provider's own verifier, not the GitHub-shaped one: Jira frames its
		// digest identically but signs with the *board's* secret, which that verifier
		// would never resolve.
		expect(jiraManifest.verifyWebhookSignature).toBe(verifyJiraWebhookSignature);
	});

	// The manifest is the seam the receiver authenticates through, so exercise the
	// verifier from here rather than trusting the identity assertion above alone.
	it('accepts a correctly signed body through the manifest and rejects a tampered one', () => {
		const secret = 'jira-whsec';
		const rawBody = JSON.stringify({ webhookEvent: 'jira:issue_updated' });
		const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
		const verify = (body: string, signature: string) =>
			jiraManifest.verifyWebhookSignature({
				rawBody: body,
				headers: (name) => (name.toLowerCase() === 'x-hub-signature' ? signature : undefined),
				secret,
				callbackUrl: 'https://swarm.example/jira/webhook',
			});

		expect(verify(rawBody, `sha256=${digest}`)).toBe(true);
		expect(verify(`${rawBody} `, `sha256=${digest}`)).toBe(false);
	});

	it('declares the project and workflow-status discovery capabilities', () => {
		expect(jiraManifest.discovery).toEqual(['containers', 'states']);
	});

	// Three rather than two, because Jira Cloud authenticates with basic auth: the
	// account email is the username and the API token the password.
	it('declares exactly the three credential roles config validation resolves', () => {
		expect(jiraManifest.credentialRoles.map((role) => role.role)).toEqual([
			'email',
			'apiToken',
			'webhookSecret',
		]);
	});

	it('declares a required email role naming its own env var', () => {
		const email = jiraManifest.credentialRoles.find((role) => role.role === 'email');
		expect(email).toMatchObject({
			role: 'email',
			label: 'Account Email',
			envVarKey: 'JIRA_EMAIL',
		});
		expect(email?.optional).toBeUndefined();
	});

	it('declares a required API-token role naming its own env var', () => {
		const apiToken = jiraManifest.credentialRoles.find((role) => role.role === 'apiToken');
		expect(apiToken).toMatchObject({
			role: 'apiToken',
			label: 'API Token',
			envVarKey: 'JIRA_API_TOKEN',
		});
		expect(apiToken?.optional).toBeUndefined();
	});

	// Required, deliberately: the verifier fails closed on a null secret, so an
	// optional role would pass `swarm config apply` and then 401 every delivery.
	it('declares a required webhook-secret role naming its own env var', () => {
		const webhookSecret = jiraManifest.credentialRoles.find(
			(role) => role.role === 'webhookSecret',
		);
		expect(webhookSecret).toMatchObject({
			role: 'webhookSecret',
			label: 'Webhook Secret',
			envVarKey: 'JIRA_WEBHOOK_SECRET',
		});
		expect(webhookSecret?.optional).toBeUndefined();
	});

	// The rule `PmCredentialRoleSpec.inheritsSharedCredential` states for a board
	// that is a separate system from the repo (ai/RULES.md §2): no role may borrow
	// the project's SCM credentials.
	it('inherits no shared SCM credential for any role', () => {
		for (const role of jiraManifest.credentialRoles) {
			expect(role.inheritsSharedCredential, role.role).toBeUndefined();
		}
	});

	it('builds a provider for a Jira project, typed to its own id', () => {
		const provider = jiraManifest.createProvider(createMockJiraProjectConfig());
		expect(provider.type).toBe('jira');
	});

	// The project-scoped lookup every pipeline/trigger call site uses. A PM manifest
	// carries no `runtimeReady` flag, so registering *is* what makes `pm.type: 'jira'`
	// selectable (ai/RULES.md §2).
	it('is what the project-scoped lookups resolve for a Jira project', () => {
		const jiraProject = createMockJiraProjectConfig();
		expect(requireProjectPMProvider(jiraProject).type).toBe('jira');
		expect(requireProjectPMAdapter(jiraProject).type).toBe('jira');
	});
});
