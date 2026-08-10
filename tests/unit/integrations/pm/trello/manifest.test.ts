import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers the
// trello side-effect registration. Vitest isolates module state per test file, so
// this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import {
	getPMProvider,
	listPMProviders,
	requireProjectPMAdapter,
	requireProjectPMProvider,
} from '@/integrations/pm/registry.js';
import { trelloManifest } from '@/integrations/pm/trello/index.js';
import { verifyTrelloWebhookSignature } from '@/integrations/pm/trello/webhook.js';
import {
	createMockTrelloConfig,
	createMockTrelloProjectConfig,
} from '../../../../helpers/factories.js';

describe('trello manifest registration', () => {
	it('registers itself into the registry via the entrypoint import', () => {
		expect(getPMProvider('trello')).toBe(trelloManifest);
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
		expect(trelloManifest).toMatchObject({
			id: 'trello',
			label: 'Trello',
			category: 'pm',
			createProvider: expect.any(Function),
		});
	});

	it('exposes the provider config schema, which parses a valid board mapping', () => {
		const config = createMockTrelloConfig();
		expect(trelloManifest.configSchema.parse(config)).toEqual(config);
	});

	it('exposes a router adapter wired to the same provider id', () => {
		expect(trelloManifest.routerAdapter.type).toBe('trello');
	});

	// Its own route, unlike GitHub Projects' co-tenancy of `/github/webhook`: a Trello
	// board is a separate system, so the receiver mounts a GET ping + POST pair here
	// (issue #496). That GET is also what answers Trello's `HEAD` probe of the
	// callback URL before it accepts a subscription.
	it('declares its own webhook route, authenticated by its own verifier', () => {
		expect(trelloManifest.webhookRoute).toBe('/trello/webhook');
		// The provider's own verifier: Trello sends a base64 HMAC-**SHA1** where the
		// other three send SHA-256, hex, and — for two of them — a `sha256=` prefix.
		expect(trelloManifest.verifyWebhookSignature).toBe(verifyTrelloWebhookSignature);
	});

	// The manifest is the seam the receiver authenticates through, so exercise the
	// verifier from here rather than trusting the identity assertion above alone.
	// Trello is the one provider whose HMAC covers SWARM's *own* callback URL, so a
	// body signed for another URL must be rejected too.
	it('accepts a body signed over the callback URL and rejects a tampered one', () => {
		const secret = 'trello-api-secret';
		const callbackUrl = 'https://swarm.example/trello/webhook';
		const rawBody = JSON.stringify({ action: { type: 'updateCard' } });
		const sign = (body: string, url: string) =>
			createHmac('sha1', secret)
				.update(body + url, 'utf8')
				.digest('base64');
		const verify = (body: string, signature: string) =>
			trelloManifest.verifyWebhookSignature({
				rawBody: body,
				headers: (name) => (name.toLowerCase() === 'x-trello-webhook' ? signature : undefined),
				secret,
				callbackUrl,
			});

		expect(verify(rawBody, sign(rawBody, callbackUrl))).toBe(true);
		expect(verify(`${rawBody} `, sign(rawBody, callbackUrl))).toBe(false);
		// Signed for a different callback URL — the reason `PmWebhookVerification`
		// carries one at all.
		expect(verify(rawBody, sign(rawBody, 'https://attacker.example/trello/webhook'))).toBe(false);
	});

	it('declares the board and list discovery capabilities', () => {
		expect(trelloManifest.discovery).toEqual(['containers', 'states']);
	});

	// Three rather than two, because Trello authenticates with a key/token pair passed
	// as query parameters — neither half authenticates a request alone — plus the
	// secret its deliveries are signed with.
	it('declares exactly the three credential roles config validation resolves', () => {
		expect(trelloManifest.credentialRoles.map((role) => role.role)).toEqual([
			'apiKey',
			'token',
			'webhookSecret',
		]);
	});

	it('declares a required API-key role naming its own env var', () => {
		const apiKey = trelloManifest.credentialRoles.find((role) => role.role === 'apiKey');
		expect(apiKey).toMatchObject({
			role: 'apiKey',
			label: 'API Key',
			envVarKey: 'TRELLO_API_KEY',
		});
		expect(apiKey?.optional).toBeUndefined();
	});

	it('declares a required token role naming its own env var', () => {
		const token = trelloManifest.credentialRoles.find((role) => role.role === 'token');
		expect(token).toMatchObject({
			role: 'token',
			label: 'Token',
			envVarKey: 'TRELLO_TOKEN',
		});
		expect(token?.optional).toBeUndefined();
	});

	// Named for the *receiver's* role vocabulary while naming Trello's own API secret
	// in its env var: the receiver resolves only `PM_WEBHOOK_SECRET_ROLE` into
	// `PmWebhookVerification.secret`, so an `apiSecret` role would reach the verifier
	// as `null`. Required, deliberately: the verifier fails closed on a null secret,
	// so an optional role would pass `swarm config apply` and then 401 every delivery.
	it('declares a required webhook-secret role backed by the Trello API secret', () => {
		const webhookSecret = trelloManifest.credentialRoles.find(
			(role) => role.role === 'webhookSecret',
		);
		expect(webhookSecret).toMatchObject({
			role: 'webhookSecret',
			label: 'Webhook Secret',
			envVarKey: 'TRELLO_API_SECRET',
		});
		expect(webhookSecret?.optional).toBeUndefined();
	});

	// The rule `PmCredentialRoleSpec.inheritsSharedCredential` states for a board
	// that is a separate system from the repo (ai/RULES.md §2): no role may borrow
	// the project's SCM credentials.
	it('inherits no shared SCM credential for any role', () => {
		for (const role of trelloManifest.credentialRoles) {
			expect(role.inheritsSharedCredential, role.role).toBeUndefined();
		}
	});

	it('builds a provider for a Trello project, typed to its own id', () => {
		const provider = trelloManifest.createProvider(createMockTrelloProjectConfig());
		expect(provider.type).toBe('trello');
	});

	// The project-scoped lookup every pipeline/trigger call site uses. A PM manifest
	// carries no `runtimeReady` flag, so registering *is* what makes `pm.type:
	// 'trello'` selectable (ai/RULES.md §2).
	it('is what the project-scoped lookups resolve for a Trello project', () => {
		const trelloProject = createMockTrelloProjectConfig();
		expect(requireProjectPMProvider(trelloProject).type).toBe('trello');
		expect(requireProjectPMAdapter(trelloProject).type).toBe('trello');
	});
});
