import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { ProjectConfig } from '@/config/schema.js';
import type { PMProviderManifest } from '@/integrations/pm/manifest.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import { logger } from '@/lib/logger.js';
import type { PmEvent } from '@/pm/events.js';
import type { PMRouterAdapter } from '@/pm/router-adapter.js';
import type { PMType } from '@/pm/types.js';
import { createWebhookApp, type WebhookReceiverDeps } from '@/router/webhook-receiver.js';
import type { ScmEvent } from '@/scm/events.js';
import type { SCMProvider } from '@/scm/types.js';
import { createFakeScmProvider, createMockProjectConfig } from '../../helpers/factories.js';

const project = createMockProjectConfig({ id: 'proj-1', repo: 'SmartTechBrewery/swarm' });

const prEvent: ScmEvent = {
	kind: 'pull-request',
	action: 'opened',
	repoFullName: 'SmartTechBrewery/swarm',
	workItemId: '1',
	actorLogin: 'human-dev',
	isCommentEvent: false,
};

/**
 * A registered SCM manifest whose provider is a typed fake — the receiver mounts
 * routes and delegates every provider-specific decision through this, so a test
 * substitutes one manifest instead of the four collaborators it replaced.
 */
function fakeManifest(overrides: Partial<SCMProvider> = {}): SCMProviderManifest {
	return {
		id: 'github',
		label: 'GitHub',
		category: 'scm',
		webhookRoute: '/github/webhook',
		provider: createFakeScmProvider({
			readWebhookRequest: (header) => ({
				eventName: header('x-github-event') ?? 'unknown',
				...(header('x-github-delivery') ? { deliveryId: header('x-github-delivery') } : {}),
				signature: header('x-hub-signature-256') ?? '',
			}),
			parseWebhookEvent: () => prEvent,
			isSwarmGeneratedEvent: async () => false,
			verifyWebhookSignature: () => true,
			...overrides,
		}),
	};
}

const pmEvent: PmEvent = {
	action: 'updated',
	itemId: 'PVTI_x',
	containerId: 'PVT_kwHOAC3TF84BcNwD',
	changedField: 'PVTSSF_x',
	changedFieldType: 'single_select',
	actorHandle: 'human-dev',
};

/**
 * A registered PM manifest whose adapter and verifier are fakes — the PM twin of
 * {@link fakeManifest}. The receiver mounts its `webhookRoute` and delegates every
 * board-side decision (parse, filter, loop prevention, signature) through it.
 *
 * The default verifier is the realistic shape of an HMAC provider: it needs the
 * project's secret, so a project without one fails verification rather than being
 * refused before the provider is asked.
 */
function fakePmManifest(
	overrides: {
		id?: PMType;
		webhookRoute?: string;
		adapter?: Partial<PMRouterAdapter>;
		verifyWebhookSignature?: PMProviderManifest['verifyWebhookSignature'];
	} = {},
): PMProviderManifest {
	const id = overrides.id ?? 'github-projects';
	return {
		id,
		label: `Fake PM (${id})`,
		category: 'pm',
		webhookRoute: overrides.webhookRoute ?? '/github/webhook',
		verifyWebhookSignature: overrides.verifyWebhookSignature ?? (({ secret }) => secret !== null),
		routerAdapter: {
			type: id,
			parseWebhook: vi.fn().mockReturnValue(pmEvent),
			isStatusChange: vi.fn().mockReturnValue(true),
			isSelfAuthored: vi.fn().mockResolvedValue(false),
			...overrides.adapter,
		} as unknown as PMRouterAdapter,
		createProvider: () => {
			throw new Error('the receiver never constructs a PMProvider');
		},
		configSchema: z.unknown(),
		discovery: [],
	};
}

/**
 * Build an app with fully-faked collaborators. Defaults describe the happy path
 * (event parses, repo is tracked, secret exists, signature valid, not
 * SWARM-generated); each test overrides only the stage it exercises.
 */
function makeApp(
	overrides: Partial<WebhookReceiverDeps> = {},
	providerOverrides: Partial<SCMProvider> = {},
) {
	const enqueue = vi.fn<WebhookReceiverDeps['enqueue']>().mockResolvedValue(undefined);

	const deps: Partial<WebhookReceiverDeps> = {
		scmProviders: [fakeManifest(providerOverrides)],
		findProject: vi
			.fn<(repo: string) => Promise<ProjectConfig | undefined>>()
			.mockResolvedValue(project),
		getWebhookSecret: vi.fn<WebhookReceiverDeps['getWebhookSecret']>().mockResolvedValue('whsec'),
		enqueue,
		...overrides,
	};

	return { app: createWebhookApp(deps), deps, enqueue };
}

/** Fire a POST at the webhook endpoint with sensible default headers. */
function post(
	app: ReturnType<typeof makeApp>['app'],
	body: string,
	headers: Record<string, string> = {},
) {
	return app.request('/github/webhook', {
		method: 'POST',
		headers: {
			'x-github-event': 'pull_request',
			'x-hub-signature-256': 'sha256=abc',
			'x-github-delivery': 'delivery-1',
			'content-type': 'application/json',
			...headers,
		},
		body,
	});
}

const VALID_BODY = JSON.stringify({ action: 'opened', number: 1 });

describe('createWebhookApp', () => {
	beforeEach(() => vi.clearAllMocks());

	describe('GET routes', () => {
		it('serves a health probe', async () => {
			const { app } = makeApp();
			const res = await app.request('/health');
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ status: 'ok', service: 'router' });
		});

		it("answers the provider's GET ping on its registered webhook path", async () => {
			const { app } = makeApp();
			const res = await app.request('/github/webhook');
			expect(res.status).toBe(200);
		});

		// A provider still being built out phase by phase (Bitbucket, issue #296)
		// registers with `runtimeReady: false`. Mounting its route would expose an
		// unauthenticated endpoint whose first act is a contract method that throws,
		// so the receiver serves nothing for it — not even the GET ping.
		it('serves no route for a provider that is not runtime-ready', async () => {
			const { app } = makeApp({
				scmProviders: [
					fakeManifest(),
					{ ...fakeManifest(), webhookRoute: '/unbuilt/webhook', runtimeReady: false },
				],
			});

			expect((await app.request('/github/webhook')).status).toBe(200);
			expect((await app.request('/unbuilt/webhook')).status).toBe(404);
			const posted = await app.request('/unbuilt/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: VALID_BODY,
			});
			expect(posted.status).toBe(404);
		});
	});

	describe('POST /github/webhook', () => {
		it('accepts and enqueues a valid, verified, human-authored event', async () => {
			const { app, enqueue } = makeApp();
			const res = await post(app, VALID_BODY);
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ ok: true, accepted: true });
			expect(enqueue).toHaveBeenCalledWith('github', prEvent, project, 'delivery-1');
		});

		it('rejects a malformed JSON body with 400', async () => {
			const { app, enqueue } = makeApp();
			const res = await post(app, 'not json{');
			expect(res.status).toBe(400);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it('acknowledges but ignores an unhandled event type', async () => {
			const { app, enqueue } = makeApp({}, { parseWebhookEvent: () => null });
			const res = await post(app, VALID_BODY, { 'x-github-event': 'star' });
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it('acknowledges but ignores an event for an untracked repo', async () => {
			const { app, enqueue, deps } = makeApp({
				findProject: vi
					.fn<(repo: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(undefined),
			});
			const res = await post(app, VALID_BODY);
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			// Must not touch secrets or the queue for a repo that isn't ours.
			expect(deps.getWebhookSecret).not.toHaveBeenCalled();
			expect(enqueue).not.toHaveBeenCalled();
		});

		it('rejects with 401 when the project has no webhook secret configured', async () => {
			const { app, enqueue } = makeApp({
				getWebhookSecret: vi.fn<WebhookReceiverDeps['getWebhookSecret']>().mockResolvedValue(null),
			});
			const res = await post(app, VALID_BODY);
			expect(res.status).toBe(401);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it("rejects with 401 when the provider's signature check fails", async () => {
			const { app, enqueue } = makeApp({}, { verifyWebhookSignature: () => false });
			const res = await post(app, VALID_BODY);
			expect(res.status).toBe(401);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it("passes the raw body (not a re-serialized copy) to the provider's verifier", async () => {
			// A body with unusual spacing would not survive a JSON round-trip; assert
			// the exact received bytes reach the verifier.
			const raw = '{"action":"opened",   "number":1}';
			const verifyWebhookSignature = vi.fn().mockReturnValue(true);
			const { app } = makeApp({}, { verifyWebhookSignature });
			await post(app, raw);
			expect(verifyWebhookSignature).toHaveBeenCalledWith(raw, 'sha256=abc', 'whsec');
		});

		it('drops a SWARM-generated comment event (loop prevention) without enqueueing', async () => {
			const { app, enqueue } = makeApp(
				{},
				{
					parseWebhookEvent: () => ({ ...prEvent, isCommentEvent: true, actorLogin: 'swarm-bot' }),
					isSwarmGeneratedEvent: async () => true,
				},
			);
			const res = await post(app, VALID_BODY, { 'x-github-event': 'issue_comment' });
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it('enqueues with deliveryId undefined when the delivery header is absent', async () => {
			const { app, enqueue } = makeApp();
			// Bypass the `post` helper, which always injects x-github-delivery.
			const res = await app.request('/github/webhook', {
				method: 'POST',
				headers: {
					'x-github-event': 'pull_request',
					'x-hub-signature-256': 'sha256=abc',
					'content-type': 'application/json',
				},
				body: VALID_BODY,
			});
			expect(res.status).toBe(202);
			expect(enqueue).toHaveBeenCalledWith('github', prEvent, project, undefined);
		});

		it('logs and returns 500 when a collaborator throws', async () => {
			const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
			const { app } = makeApp({
				enqueue: vi
					.fn<WebhookReceiverDeps['enqueue']>()
					.mockRejectedValue(new Error('queue unreachable')),
			});
			const res = await post(app, VALID_BODY);
			expect(res.status).toBe(500);
			expect(await res.json()).toEqual({ ok: false, reason: 'internal error' });
			expect(errorSpy).toHaveBeenCalled();
			errorSpy.mockRestore();
		});
	});

	// GitHub delivers `projects_v2_item` to the same URL and secret as its SCM
	// events, so its PM manifest declares `/github/webhook` and the receiver serves
	// it as a co-tenant of the SCM route rather than mounting a second handler
	// (issue #496).
	describe('POST /github/webhook — PM board event (co-tenant of the SCM route)', () => {
		/** App whose PM collaborators are all faked on the happy path. */
		function makePmApp(
			overrides: Partial<WebhookReceiverDeps> = {},
			pmManifest: PMProviderManifest = fakePmManifest(),
		) {
			const enqueuePm = vi.fn<WebhookReceiverDeps['enqueuePm']>().mockResolvedValue(undefined);
			const enqueue = vi.fn<WebhookReceiverDeps['enqueue']>().mockResolvedValue(undefined);

			const app = createWebhookApp({
				scmProviders: [fakeManifest()],
				pmProviders: [pmManifest],
				findProjectByBoard: vi
					.fn<(id: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(project),
				getWebhookSecret: vi
					.fn<WebhookReceiverDeps['getWebhookSecret']>()
					.mockResolvedValue('whsec'),
				enqueue,
				enqueuePm,
				...overrides,
			});
			return { app, enqueue, enqueuePm, pmManifest };
		}

		function postPm(
			app: ReturnType<typeof makePmApp>['app'],
			headers: Record<string, string> = {},
		) {
			return app.request('/github/webhook', {
				method: 'POST',
				headers: {
					'x-github-event': 'projects_v2_item',
					'x-hub-signature-256': 'sha256=abc',
					'x-github-delivery': 'delivery-pm',
					'content-type': 'application/json',
					...headers,
				},
				body: JSON.stringify({ action: 'edited' }),
			});
		}

		it('accepts and enqueues a verified, human-authored status change under its provider id', async () => {
			const { app, enqueuePm } = makePmApp();
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ ok: true, accepted: true });
			expect(enqueuePm).toHaveBeenCalledWith('github-projects', pmEvent, project, 'delivery-pm');
		});

		// A `parseWebhook` returning null *is* the "not my event" answer on a shared
		// route, so the request continues down the SCM path — which acknowledges an
		// event it doesn't handle either.
		it('falls through to the SCM path for a payload its PM adapter cannot parse', async () => {
			const { app, enqueue, enqueuePm } = makePmApp(
				{ scmProviders: [fakeManifest({ parseWebhookEvent: () => null })] },
				fakePmManifest({ adapter: { parseWebhook: vi.fn().mockReturnValue(null) } }),
			);
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).reason).toBe('unhandled event type: projects_v2_item');
			expect(enqueuePm).not.toHaveBeenCalled();
			expect(enqueue).not.toHaveBeenCalled();
		});

		it('ignores an event for an untracked board (before touching secrets)', async () => {
			const getWebhookSecret = vi
				.fn<WebhookReceiverDeps['getWebhookSecret']>()
				.mockResolvedValue('whsec');
			const { app, enqueuePm } = makePmApp({
				findProjectByBoard: vi
					.fn<(id: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(undefined),
				getWebhookSecret,
			});
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(getWebhookSecret).not.toHaveBeenCalled();
			expect(enqueuePm).not.toHaveBeenCalled();
		});

		it('rejects with 401 when the project has no webhook secret configured', async () => {
			const { app, enqueuePm } = makePmApp({
				getWebhookSecret: vi.fn<WebhookReceiverDeps['getWebhookSecret']>().mockResolvedValue(null),
			});
			const res = await postPm(app);
			expect(res.status).toBe(401);
			expect((await res.json()).reason).toBe('webhook secret not configured');
			expect(enqueuePm).not.toHaveBeenCalled();
		});

		// The board path authenticates through the *PM manifest's* verifier, not the
		// SCM provider's method — the two only coincide for GitHub because they share
		// one secret.
		it("rejects with 401 when the PM manifest's own verifier fails", async () => {
			const scmVerify = vi.fn().mockReturnValue(true);
			const { app, enqueuePm } = makePmApp(
				{ scmProviders: [fakeManifest({ verifyWebhookSignature: scmVerify })] },
				fakePmManifest({ verifyWebhookSignature: () => false }),
			);
			const res = await postPm(app);
			expect(res.status).toBe(401);
			expect((await res.json()).reason).toBe('signature verification failed');
			expect(scmVerify).not.toHaveBeenCalled();
			expect(enqueuePm).not.toHaveBeenCalled();
		});

		it("hands the verifier the raw body, the request's headers, the secret, and SWARM's callback URL", async () => {
			vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', 'https://swarm.example.com');
			const verifyWebhookSignature = vi.fn().mockReturnValue(true);
			const { app } = makePmApp({}, fakePmManifest({ verifyWebhookSignature }));

			await postPm(app);

			expect(verifyWebhookSignature).toHaveBeenCalledWith({
				rawBody: JSON.stringify({ action: 'edited' }),
				headers: expect.any(Function),
				secret: 'whsec',
				callbackUrl: 'https://swarm.example.com/github/webhook',
			});
			// The reader is the request's own headers, so a provider names its own
			// signature header rather than the receiver naming it.
			const { headers } = verifyWebhookSignature.mock.calls[0][0];
			expect(headers('x-hub-signature-256')).toBe('sha256=abc');
		});

		it('ignores a non-Status field edit without enqueueing', async () => {
			const { app, enqueuePm } = makePmApp(
				{},
				fakePmManifest({ adapter: { isStatusChange: vi.fn().mockReturnValue(false) } }),
			);
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).reason).toBe('not a status-field change');
			expect(enqueuePm).not.toHaveBeenCalled();
		});

		it('drops a self-authored status change (loop prevention)', async () => {
			const { app, enqueuePm } = makePmApp(
				{},
				fakePmManifest({ adapter: { isSelfAuthored: vi.fn().mockResolvedValue(true) } }),
			);
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(enqueuePm).not.toHaveBeenCalled();
		});
	});

	// The second PM provider is the point of issue #496: a manifest whose route no
	// SCM manifest serves gets its own GET + POST pair, and neither provider's
	// events reach the other's route.
	describe('a PM provider on its own webhook route', () => {
		const jiraEvent: PmEvent = { itemId: 'SWARM-1', containerId: 'board-9', action: 'updated' };

		/** Parses only its own provider's bodies, exactly as a real adapter does. */
		function bodyDiscriminatingAdapter(provider: string, event: PmEvent) {
			return {
				parseWebhook: vi.fn((_eventName: string, payload: unknown) =>
					(payload as { provider?: string })?.provider === provider ? event : null,
				),
			};
		}

		function makeTwoProviderApp(
			jiraOverrides: Parameters<typeof fakePmManifest>[0] = {},
			scmOverrides: Partial<SCMProvider> = {},
		) {
			const enqueuePm = vi.fn<WebhookReceiverDeps['enqueuePm']>().mockResolvedValue(undefined);
			const enqueue = vi.fn<WebhookReceiverDeps['enqueue']>().mockResolvedValue(undefined);
			const githubProjects = fakePmManifest({
				adapter: bodyDiscriminatingAdapter('github-projects', pmEvent),
			});
			const jira = fakePmManifest({
				id: 'jira',
				webhookRoute: '/jira/webhook',
				adapter: bodyDiscriminatingAdapter('jira', jiraEvent),
				...jiraOverrides,
			});

			const app = createWebhookApp({
				scmProviders: [fakeManifest({ parseWebhookEvent: () => null, ...scmOverrides })],
				pmProviders: [githubProjects, jira],
				findProjectByBoard: vi
					.fn<(id: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(project),
				getWebhookSecret: vi
					.fn<WebhookReceiverDeps['getWebhookSecret']>()
					.mockResolvedValue('whsec'),
				enqueue,
				enqueuePm,
			});
			return { app, enqueue, enqueuePm, githubProjects, jira };
		}

		function postJira(
			app: ReturnType<typeof createWebhookApp>,
			path = '/jira/webhook',
			provider = 'jira',
		) {
			return app.request(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-github-event': 'projects_v2_item' },
				body: JSON.stringify({ provider }),
			});
		}

		it("mounts the provider's own GET ping and POST route from the registry", async () => {
			const { app } = makeTwoProviderApp();
			expect((await app.request('/jira/webhook')).status).toBe(200);
		});

		it('enqueues its event under its own provider id, verified by its own verifier', async () => {
			const verifyWebhookSignature = vi.fn().mockReturnValue(true);
			const { app, enqueuePm, githubProjects } = makeTwoProviderApp({ verifyWebhookSignature });

			const res = await postJira(app);

			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ ok: true, accepted: true });
			expect(verifyWebhookSignature).toHaveBeenCalledWith(
				expect.objectContaining({ callbackUrl: expect.stringContaining('/jira/webhook') }),
			);
			// No delivery id: reading one needs a per-provider header reader the PM
			// manifest doesn't declare yet.
			expect(enqueuePm).toHaveBeenCalledWith('jira', jiraEvent, project, undefined);
			expect(githubProjects.verifyWebhookSignature).not.toBe(verifyWebhookSignature);
		});

		it('hands its adapter the payload with no event name (a provider on its own route reads its body)', async () => {
			const { app, jira } = makeTwoProviderApp();
			await postJira(app);
			expect(jira.routerAdapter.parseWebhook).toHaveBeenCalledWith('', { provider: 'jira' });
		});

		it('acknowledges a payload no provider on the route can parse', async () => {
			const { app, enqueuePm } = makeTwoProviderApp();
			const res = await postJira(app, '/jira/webhook', 'github-projects');
			expect(res.status).toBe(202);
			expect((await res.json()).reason).toBe('unactionable board payload');
			expect(enqueuePm).not.toHaveBeenCalled();
		});

		it("never routes one provider's event to the other's path", async () => {
			const { app, enqueue, enqueuePm, githubProjects } = makeTwoProviderApp();

			// A Jira body posted to the GitHub route: the co-tenant can't parse it, so it
			// falls through to SCM (which ignores it) and never reaches Jira's handling.
			const onGithubRoute = await postJira(app, '/github/webhook');
			expect(onGithubRoute.status).toBe(202);
			expect(enqueuePm).not.toHaveBeenCalled();
			expect(enqueue).not.toHaveBeenCalled();

			// And a GitHub Projects body on the Jira route is not offered to the GitHub
			// Projects adapter at all — its route is the other one.
			await postJira(app, '/jira/webhook', 'github-projects');
			expect(githubProjects.routerAdapter.parseWebhook).not.toHaveBeenCalledWith('', {
				provider: 'github-projects',
			});
		});
	});

	// The tests above inject a fake provider; these exercise the *real* registered
	// GitHub manifest that `defaultDeps()` resolves from `scmProviderRegistry` —
	// its route, its header names, its signature scheme, and its parser — so a
	// regression in that wiring (a wrong route, a renamed header, the wrong
	// verifier) is caught end to end.
	describe('real registered GitHub provider (defaultDeps wiring)', () => {
		const secret = 'topsecret';
		const signedBody = JSON.stringify({
			action: 'opened',
			repository: { full_name: 'SmartTechBrewery/swarm' },
			pull_request: { number: 1, head: { sha: 'abc', ref: 'issue-1' } },
			sender: { login: 'human-dev' },
		});

		function realProviderApp() {
			const enqueue = vi.fn<WebhookReceiverDeps['enqueue']>().mockResolvedValue(undefined);
			const enqueuePm = vi.fn<WebhookReceiverDeps['enqueuePm']>().mockResolvedValue(undefined);
			// Fake only the secret + project lookups; leave both providers to the registry.
			const app = createWebhookApp({
				findProject: vi
					.fn<(repo: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(project),
				findProjectByBoard: vi
					.fn<(id: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(project),
				getWebhookSecret: vi
					.fn<WebhookReceiverDeps['getWebhookSecret']>()
					.mockResolvedValue(secret),
				enqueue,
				enqueuePm,
			});
			return { app, enqueue, enqueuePm };
		}

		function sign(body: string, key = secret) {
			return `sha256=${createHmac('sha256', key).update(body, 'utf8').digest('hex')}`;
		}

		it("serves the registered manifest's `/github/webhook` route", async () => {
			const { app } = realProviderApp();
			expect((await app.request('/github/webhook')).status).toBe(200);
		});

		it('accepts a body signed with the genuine HMAC-SHA256 signature', async () => {
			const { app, enqueue } = realProviderApp();
			const res = await post(app, signedBody, { 'x-hub-signature-256': sign(signedBody) });
			expect(res.status).toBe(202);
			expect(enqueue).toHaveBeenCalledWith(
				'github',
				expect.objectContaining({ kind: 'pull-request', action: 'opened', workItemId: '1' }),
				project,
				'delivery-1',
			);
		});

		it('rejects a body whose real signature does not match with 401', async () => {
			const { app, enqueue } = realProviderApp();
			const res = await post(app, signedBody, {
				'x-hub-signature-256': sign(signedBody, 'wrong-secret'),
			});
			expect(res.status).toBe(401);
			expect(enqueue).not.toHaveBeenCalled();
		});

		// The registered GitHub Projects manifest declares this same route and shares
		// the secret, so the board half of `/github/webhook` must keep working
		// unchanged — now through the PM manifest's own verifier (issue #496).
		describe('real registered GitHub Projects PM manifest (co-tenant)', () => {
			const boardBody = JSON.stringify({
				action: 'created',
				projects_v2_item: {
					node_id: 'PVTI_1',
					project_node_id: 'PVT_1',
					content_node_id: 'I_1',
					content_type: 'Issue',
				},
			});

			function postBoard(app: ReturnType<typeof createWebhookApp>, signature: string) {
				return app.request('/github/webhook', {
					method: 'POST',
					headers: {
						'x-github-event': 'projects_v2_item',
						'x-hub-signature-256': signature,
						'x-github-delivery': 'delivery-board',
						'content-type': 'application/json',
					},
					body: boardBody,
				});
			}

			it('enqueues a genuinely-signed board event under the PM provider id', async () => {
				const { app, enqueue, enqueuePm } = realProviderApp();
				const res = await postBoard(app, sign(boardBody));
				expect(res.status).toBe(202);
				expect(enqueuePm).toHaveBeenCalledWith(
					'github-projects',
					expect.objectContaining({ itemId: 'PVTI_1', containerId: 'PVT_1', action: 'created' }),
					project,
					'delivery-board',
				);
				// A board event never travels the repo path.
				expect(enqueue).not.toHaveBeenCalled();
			});

			it('rejects a board event whose real signature does not match with 401', async () => {
				const { app, enqueuePm } = realProviderApp();
				const res = await postBoard(app, sign(boardBody, 'wrong-secret'));
				expect(res.status).toBe(401);
				expect(enqueuePm).not.toHaveBeenCalled();
			});
		});
	});
});
