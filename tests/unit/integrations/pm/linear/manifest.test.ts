import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers the
// linear side-effect registration. Vitest isolates module state per test file, so
// this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import { linearManifest } from '@/integrations/pm/linear/index.js';
import { verifyLinearWebhookSignature } from '@/integrations/pm/linear/webhook.js';
import {
	getPMProvider,
	listPMProviders,
	requireProjectPMAdapter,
	requireProjectPMProvider,
} from '@/integrations/pm/registry.js';
import {
	createMockLinearConfig,
	createMockLinearProjectConfig,
} from '../../../../helpers/factories.js';

describe('linear manifest registration', () => {
	it('registers itself into the registry via the entrypoint import', () => {
		expect(getPMProvider('linear')).toBe(linearManifest);
	});

	it('registers alongside GitHub Projects rather than replacing it', () => {
		expect(listPMProviders().map((m) => m.id)).toEqual(['github-projects', 'linear']);
	});

	it('declares the expected identity', () => {
		expect(linearManifest).toMatchObject({
			id: 'linear',
			label: 'Linear',
			category: 'pm',
			createProvider: expect.any(Function),
		});
	});

	it('exposes the provider config schema, which parses a valid board mapping', () => {
		const config = createMockLinearConfig();
		expect(linearManifest.configSchema.parse(config)).toEqual(config);
	});

	it('exposes a router adapter wired to the same provider id', () => {
		expect(linearManifest.routerAdapter.type).toBe('linear');
	});

	// Its own route, unlike GitHub Projects' co-tenancy of `/github/webhook`: a
	// Linear board is a separate system, so the receiver mounts a GET ping + POST
	// pair here (issue #496).
	it('declares its own webhook route, authenticated by its own verifier', () => {
		expect(linearManifest.webhookRoute).toBe('/linear/webhook');
		// The provider's own verifier, not the GitHub-shaped one: Linear sends a bare
		// hex digest where GitHub frames its own `sha256=<hex>`.
		expect(linearManifest.verifyWebhookSignature).toBe(verifyLinearWebhookSignature);
	});

	it('declares the team and workflow-state discovery capabilities', () => {
		expect(linearManifest.discovery).toEqual(['containers', 'states']);
	});

	it('declares exactly the two credential roles config validation resolves', () => {
		expect(linearManifest.credentialRoles.map((role) => role.role)).toEqual([
			'apiKey',
			'webhookSecret',
		]);
	});

	it('declares a required API-key role naming its own env var', () => {
		const apiKey = linearManifest.credentialRoles.find((role) => role.role === 'apiKey');
		expect(apiKey).toMatchObject({
			role: 'apiKey',
			label: 'API Key',
			envVarKey: 'LINEAR_API_KEY',
		});
		expect(apiKey?.optional).toBeUndefined();
	});

	// Required, deliberately: the verifier fails closed on a null secret, so an
	// optional role would pass `swarm config apply` and then 401 every delivery.
	it('declares a required webhook-secret role naming its own env var', () => {
		const webhookSecret = linearManifest.credentialRoles.find(
			(role) => role.role === 'webhookSecret',
		);
		expect(webhookSecret).toMatchObject({
			role: 'webhookSecret',
			label: 'Webhook Secret',
			envVarKey: 'LINEAR_WEBHOOK_SECRET',
		});
		expect(webhookSecret?.optional).toBeUndefined();
	});

	// The rule `PmCredentialRoleSpec.inheritsSharedCredential` states for a board
	// that is a separate system from the repo (ai/RULES.md §2): neither role may
	// borrow the project's SCM credentials.
	it('inherits no shared SCM credential for either role', () => {
		for (const role of linearManifest.credentialRoles) {
			expect(role.inheritsSharedCredential, role.role).toBeUndefined();
		}
	});

	it('builds a provider for a Linear project, typed to its own id', () => {
		const provider = linearManifest.createProvider(createMockLinearProjectConfig());
		expect(provider.type).toBe('linear');
	});

	// The project-scoped lookup every pipeline/trigger call site uses. A PM manifest
	// carries no `runtimeReady` flag, so registering *is* what makes `pm.type:
	// 'linear'` selectable (ai/RULES.md §2).
	it('is what the project-scoped lookups resolve for a Linear project', () => {
		const linearProject = createMockLinearProjectConfig();
		expect(requireProjectPMProvider(linearProject).type).toBe('linear');
		expect(requireProjectPMAdapter(linearProject).type).toBe('linear');
	});
});
