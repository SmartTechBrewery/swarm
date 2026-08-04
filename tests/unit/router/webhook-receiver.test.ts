import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '@/config/schema.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import { logger } from '@/lib/logger.js';
import type {
	GitHubProjectsParsedEvent,
	GitHubProjectsRouterAdapter,
} from '@/router/adapters/github-projects.js';
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

	describe('POST /github/webhook — projects_v2_item', () => {
		const pmEvent: GitHubProjectsParsedEvent = {
			eventType: 'projects_v2_item',
			action: 'edited',
			itemNodeId: 'PVTI_x',
			projectNodeId: 'PVT_kwHOAC3TF84BcNwD',
			changedFieldNodeId: 'PVTSSF_x',
			changedFieldType: 'single_select',
			actorLogin: 'human-dev',
		};

		/** App whose PM collaborators are all faked on the happy path. */
		function makePmApp(overrides: Partial<WebhookReceiverDeps> = {}) {
			const enqueueProjects = vi
				.fn<WebhookReceiverDeps['enqueueProjects']>()
				.mockResolvedValue(undefined);
			const pmAdapter = {
				parseWebhook: vi.fn().mockReturnValue(pmEvent),
				isStatusChange: vi.fn().mockReturnValue(true),
				isSelfAuthored: vi.fn().mockResolvedValue(false),
			} as unknown as GitHubProjectsRouterAdapter;

			const app = createWebhookApp({
				scmProviders: [fakeManifest()],
				pmAdapter,
				findProjectByBoard: vi
					.fn<(id: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(project),
				getWebhookSecret: vi
					.fn<WebhookReceiverDeps['getWebhookSecret']>()
					.mockResolvedValue('whsec'),
				enqueueProjects,
				...overrides,
			});
			return { app, enqueueProjects, pmAdapter };
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

		it('accepts and enqueues a verified, human-authored status change', async () => {
			const { app, enqueueProjects } = makePmApp();
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ ok: true, accepted: true });
			expect(enqueueProjects).toHaveBeenCalledWith(pmEvent, project, 'delivery-pm');
		});

		it('ignores an unactionable projects_v2_item payload', async () => {
			const pmAdapter = {
				parseWebhook: vi.fn().mockReturnValue(null),
				isStatusChange: vi.fn(),
				isSelfAuthored: vi.fn(),
			} as unknown as GitHubProjectsRouterAdapter;
			const { app, enqueueProjects } = makePmApp({ pmAdapter });
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(enqueueProjects).not.toHaveBeenCalled();
		});

		it('ignores an event for an untracked board (before touching secrets)', async () => {
			const getWebhookSecret = vi
				.fn<WebhookReceiverDeps['getWebhookSecret']>()
				.mockResolvedValue('whsec');
			const { app, enqueueProjects } = makePmApp({
				findProjectByBoard: vi
					.fn<(id: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(undefined),
				getWebhookSecret,
			});
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(getWebhookSecret).not.toHaveBeenCalled();
			expect(enqueueProjects).not.toHaveBeenCalled();
		});

		it('rejects with 401 when the project has no webhook secret configured', async () => {
			const { app, enqueueProjects } = makePmApp({
				getWebhookSecret: vi.fn<WebhookReceiverDeps['getWebhookSecret']>().mockResolvedValue(null),
			});
			const res = await postPm(app);
			expect(res.status).toBe(401);
			expect(enqueueProjects).not.toHaveBeenCalled();
		});

		it("rejects with 401 when the provider's signature check fails", async () => {
			const { app, enqueueProjects } = makePmApp({
				scmProviders: [fakeManifest({ verifyWebhookSignature: () => false })],
			});
			const res = await postPm(app);
			expect(res.status).toBe(401);
			expect(enqueueProjects).not.toHaveBeenCalled();
		});

		it('ignores a non-Status field edit without enqueueing', async () => {
			const pmAdapter = {
				parseWebhook: vi.fn().mockReturnValue(pmEvent),
				isStatusChange: vi.fn().mockReturnValue(false),
				isSelfAuthored: vi.fn().mockResolvedValue(false),
			} as unknown as GitHubProjectsRouterAdapter;
			const { app, enqueueProjects } = makePmApp({ pmAdapter });
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).reason).toBe('not a status-field change');
			expect(enqueueProjects).not.toHaveBeenCalled();
		});

		it('drops a self-authored status change (loop prevention)', async () => {
			const pmAdapter = {
				parseWebhook: vi.fn().mockReturnValue(pmEvent),
				isStatusChange: vi.fn().mockReturnValue(true),
				isSelfAuthored: vi.fn().mockResolvedValue(true),
			} as unknown as GitHubProjectsRouterAdapter;
			const { app, enqueueProjects } = makePmApp({ pmAdapter });
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(enqueueProjects).not.toHaveBeenCalled();
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
			// Fake only the secret + repo lookups; leave the provider to the registry.
			const app = createWebhookApp({
				findProject: vi
					.fn<(repo: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(project),
				getWebhookSecret: vi
					.fn<WebhookReceiverDeps['getWebhookSecret']>()
					.mockResolvedValue(secret),
				enqueue,
			});
			return { app, enqueue };
		}

		it("serves the registered manifest's `/github/webhook` route", async () => {
			const { app } = realProviderApp();
			expect((await app.request('/github/webhook')).status).toBe(200);
		});

		it('accepts a body signed with the genuine HMAC-SHA256 signature', async () => {
			const { app, enqueue } = realProviderApp();
			const signature = `sha256=${createHmac('sha256', secret).update(signedBody, 'utf8').digest('hex')}`;
			const res = await post(app, signedBody, { 'x-hub-signature-256': signature });
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
			const signature = `sha256=${createHmac('sha256', 'wrong-secret').update(signedBody, 'utf8').digest('hex')}`;
			const res = await post(app, signedBody, { 'x-hub-signature-256': signature });
			expect(res.status).toBe(401);
			expect(enqueue).not.toHaveBeenCalled();
		});
	});
});
