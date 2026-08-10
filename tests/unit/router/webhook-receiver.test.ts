import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// The receiver no longer holds a board lookup — a PM event's project is resolved
// through `PMRouterAdapter.resolveProject` (issue #529). The fake manifests below
// stub that method directly; this mock is for the *real* registered GitHub
// Projects adapter, whose own `resolveProject` calls this facade.
vi.mock('@/config/provider.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/config/provider.js')>()),
	findProjectByBoard: vi.fn(),
	findProjectByLinearTeam: vi.fn(),
	findProjectByJiraProject: vi.fn(),
}));

import {
	findProjectByBoard,
	findProjectByJiraProject,
	findProjectByLinearTeam,
} from '@/config/provider.js';
import type { ProjectConfig } from '@/config/schema.js';
import { PM_WEBHOOK_SECRET_ROLE, type PMProviderManifest } from '@/integrations/pm/manifest.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import { logger } from '@/lib/logger.js';
import type { PmEvent } from '@/pm/events.js';
import type { PMRouterAdapter } from '@/pm/router-adapter.js';
import type { PMType } from '@/pm/types.js';
import { createWebhookApp, type WebhookReceiverDeps } from '@/router/webhook-receiver.js';
import type { ScmEvent } from '@/scm/events.js';
import type { SCMProvider } from '@/scm/types.js';
import {
	createFakeScmProvider,
	createMockJiraProjectConfig,
	createMockLinearProjectConfig,
	createMockProjectConfig,
} from '../../helpers/factories.js';

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
		credentialRoles?: PMProviderManifest['credentialRoles'];
	} = {},
): PMProviderManifest {
	const id = overrides.id ?? 'github-projects';
	return {
		id,
		label: `Fake PM (${id})`,
		category: 'pm',
		webhookRoute: overrides.webhookRoute ?? '/github/webhook',
		// Declares the webhook-secret role by default, so the receiver resolves one
		// (issue #497); a test that needs the "provider signs with something else"
		// shape passes an empty list.
		credentialRoles: overrides.credentialRoles ?? [
			{ role: PM_WEBHOOK_SECRET_ROLE, label: 'Webhook Secret', envVarKey: 'PM_WEBHOOK_SECRET' },
		],
		verifyWebhookSignature: overrides.verifyWebhookSignature ?? (({ secret }) => secret !== null),
		routerAdapter: {
			type: id,
			parseWebhook: vi.fn().mockReturnValue(pmEvent),
			// The provider owns the board→project lookup (issue #529): the receiver
			// resolves a board event's project through this contract method, so the
			// "untracked board" cases override it rather than a receiver dep.
			resolveProject: vi.fn().mockResolvedValue(project),
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

		// A provider that has not declared itself ready to carry traffic (GitLab, until
		// issue #619) registers with `runtimeReady: false`. Mounting its route would
		// expose an endpoint for a provider no project can select, so the receiver
		// serves nothing for it — not even the GET ping.
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
				// The board→project lookup is the adapter's (`fakePmManifest`), not a dep.
				// The board side resolves the PM provider's own role, not the SCM secret
				// (issue #497) — the SCM dep is still stubbed so a test can assert it is
				// left untouched.
				getPmCredential: vi.fn<WebhookReceiverDeps['getPmCredential']>().mockResolvedValue('whsec'),
				getWebhookSecret: vi
					.fn<WebhookReceiverDeps['getWebhookSecret']>()
					.mockResolvedValue('scm-whsec'),
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

		// Issue #529: the receiver holds no board lookup of its own. Each provider owns
		// which of its config keys names the container, so the project comes from the
		// contract method — handed the *parsed* event, not a bare container id.
		it("resolves the project through the adapter's resolveProject, with the parsed event", async () => {
			const { app, pmManifest } = makePmApp();
			await postPm(app);
			expect(pmManifest.routerAdapter.resolveProject).toHaveBeenCalledWith(pmEvent);
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

		// The adapter answering `null` is the "board not tracked" signal (issue #529);
		// the receiver holds no board lookup to answer it with.
		it('ignores an event for an untracked board (before touching secrets)', async () => {
			const getPmCredential = vi
				.fn<WebhookReceiverDeps['getPmCredential']>()
				.mockResolvedValue('whsec');
			const { app, enqueuePm } = makePmApp(
				{ getPmCredential },
				fakePmManifest({ adapter: { resolveProject: vi.fn().mockResolvedValue(null) } }),
			);
			const res = await postPm(app);
			expect(res.status).toBe(202);
			expect((await res.json()).ignored).toBe(true);
			expect(getPmCredential).not.toHaveBeenCalled();
			expect(enqueuePm).not.toHaveBeenCalled();
		});

		it('rejects with 401 when the project has no webhook secret configured', async () => {
			const { app, enqueuePm } = makePmApp({
				getPmCredential: vi.fn<WebhookReceiverDeps['getPmCredential']>().mockResolvedValue(null),
			});
			const res = await postPm(app);
			expect(res.status).toBe(401);
			expect((await res.json()).reason).toBe('webhook secret not configured');
			expect(enqueuePm).not.toHaveBeenCalled();
		});

		// Issue #497: the board path authenticates against the *PM provider's*
		// `webhookSecret` role. For GitHub Projects that role inherits
		// `credentials.webhookSecret`, so it resolves to the same secret as before —
		// but it is resolved as the PM credential, not by borrowing the SCM lookup.
		it("resolves the secret through the PM provider's declared webhookSecret role", async () => {
			const getPmCredential = vi
				.fn<WebhookReceiverDeps['getPmCredential']>()
				.mockResolvedValue('whsec');
			const getWebhookSecret = vi
				.fn<WebhookReceiverDeps['getWebhookSecret']>()
				.mockResolvedValue('scm-whsec');
			const verifyWebhookSignature = vi.fn().mockReturnValue(true);
			const { app, enqueuePm } = makePmApp(
				{ getPmCredential, getWebhookSecret },
				fakePmManifest({ verifyWebhookSignature }),
			);

			const res = await postPm(app);

			expect(res.status).toBe(202);
			expect(getPmCredential).toHaveBeenCalledWith(project, PM_WEBHOOK_SECRET_ROLE);
			expect(getWebhookSecret).not.toHaveBeenCalled();
			expect(verifyWebhookSignature).toHaveBeenCalledWith(
				expect.objectContaining({ secret: 'whsec' }),
			);
			expect(enqueuePm).toHaveBeenCalled();
		});

		// A provider whose scheme signs with something else declares no such role; it
		// must reach its verifier with `secret: null` rather than a resolution error.
		it('hands a provider that declares no webhookSecret role a null secret', async () => {
			const getPmCredential = vi
				.fn<WebhookReceiverDeps['getPmCredential']>()
				.mockResolvedValue('whsec');
			const verifyWebhookSignature = vi.fn().mockReturnValue(true);
			const { app } = makePmApp(
				{ getPmCredential },
				fakePmManifest({ credentialRoles: [], verifyWebhookSignature }),
			);

			await postPm(app);

			expect(getPmCredential).not.toHaveBeenCalled();
			expect(verifyWebhookSignature).toHaveBeenCalledWith(
				expect.objectContaining({ secret: null }),
			);
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
				getPmCredential: vi.fn<WebhookReceiverDeps['getPmCredential']>().mockResolvedValue('whsec'),
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
			// Both secret lookups resolve to the *same* value, which is the truth for
			// GitHub: the board and the repo share one webhook and one secret, expressed
			// since issue #497 as the PM role inheriting `credentials.webhookSecret`.
			const getPmCredential = vi
				.fn<WebhookReceiverDeps['getPmCredential']>()
				.mockResolvedValue(secret);
			// The board lookup is no longer a receiver dep: the *real* GitHub Projects
			// adapter resolves it through the mocked `findProjectByBoard` facade, which
			// is what keeps this end-to-end case honest about where the lookup lives.
			vi.mocked(findProjectByBoard).mockResolvedValue(project);
			// Fake only the secret + project lookups; leave both providers to the registry.
			const app = createWebhookApp({
				findProject: vi
					.fn<(repo: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(project),
				getWebhookSecret: vi
					.fn<WebhookReceiverDeps['getWebhookSecret']>()
					.mockResolvedValue(secret),
				getPmCredential,
				enqueue,
				enqueuePm,
			});
			return { app, enqueue, enqueuePm, getPmCredential };
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
				const { app, enqueue, enqueuePm, getPmCredential } = realProviderApp();
				const res = await postBoard(app, sign(boardBody));
				expect(res.status).toBe(202);
				// Authenticated against the registered manifest's own declared role
				// (issue #497), which resolves to the shared GitHub webhook secret.
				expect(getPmCredential).toHaveBeenCalledWith(project, PM_WEBHOOK_SECRET_ROLE);
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

			it('fails closed when the PM credential is unavailable despite an ambient secret', async () => {
				vi.stubEnv('SCM_WEBHOOK_SECRET', 'ambient-secret');
				const { app, enqueuePm, getPmCredential } = realProviderApp();
				getPmCredential.mockResolvedValue(null);
				const res = await postBoard(app, sign(boardBody, 'ambient-secret'));
				expect(res.status).toBe(401);
				expect(getPmCredential).toHaveBeenCalledWith(project, PM_WEBHOOK_SECRET_ROLE);
				expect(enqueuePm).not.toHaveBeenCalled();
			});
		});
	});

	// The registered Linear manifest is the first PM provider whose route no SCM
	// manifest serves (issue #530), so this exercises the own-route half of the
	// receiver against the *real* registry: its path, its own `linear-signature`
	// header, its unprefixed hex HMAC, and its own adapter's parse + team lookup.
	describe('real registered Linear PM manifest (own route, defaultDeps wiring)', () => {
		const secret = 'linear-whsec';
		const linearProject = createMockLinearProjectConfig();
		const teamId = linearProject.pm.type === 'linear' ? linearProject.pm.teamId : '';
		// A workflow-state edit with no `actor`, so loop prevention answers "not ours"
		// without resolving the board identity (which would be a live Linear call).
		const boardBody = JSON.stringify({
			type: 'Issue',
			action: 'update',
			data: { id: 'a2f0c7e1-8b4e-4a1a-9d61-1c4f0b6e2d33', teamId },
			updatedFrom: { stateId: '9e1a4a5f-8d0c-4ea2-a27c-8142ad0297a0' },
		});

		function realLinearApp() {
			const enqueuePm = vi.fn<WebhookReceiverDeps['enqueuePm']>().mockResolvedValue(undefined);
			const getPmCredential = vi
				.fn<WebhookReceiverDeps['getPmCredential']>()
				.mockResolvedValue(secret);
			// The Linear adapter resolves its project by *team*, through its own facade
			// (issue #529) — not through a receiver dep.
			vi.mocked(findProjectByLinearTeam).mockResolvedValue(linearProject);
			// Leave both registries alone: the route under test is mounted from the
			// registered manifest, not injected.
			const app = createWebhookApp({ getPmCredential, enqueuePm });
			return { app, enqueuePm, getPmCredential };
		}

		/** Linear's framing: a bare hex digest of the raw body, with no `sha256=` prefix. */
		function signLinear(body: string, key = secret) {
			return createHmac('sha256', key).update(body, 'utf8').digest('hex');
		}

		function postLinear(app: ReturnType<typeof createWebhookApp>, signature: string) {
			return app.request('/linear/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'linear-signature': signature },
				body: boardBody,
			});
		}

		it("serves the registered manifest's own `/linear/webhook` GET ping", async () => {
			const { app } = realLinearApp();
			expect((await app.request('/linear/webhook')).status).toBe(200);
		});

		it('enqueues a genuinely-signed board event under the Linear provider id', async () => {
			const { app, enqueuePm, getPmCredential } = realLinearApp();
			const res = await postLinear(app, signLinear(boardBody));
			expect(res.status).toBe(202);
			// Authenticated against Linear's own declared role, which is its own secret
			// rather than the repository's — the manifest inherits nothing.
			expect(getPmCredential).toHaveBeenCalledWith(linearProject, PM_WEBHOOK_SECRET_ROLE);
			expect(enqueuePm).toHaveBeenCalledWith(
				'linear',
				expect.objectContaining({
					itemId: 'a2f0c7e1-8b4e-4a1a-9d61-1c4f0b6e2d33',
					containerId: teamId,
					action: 'updated',
				}),
				linearProject,
				undefined,
			);
		});

		it('rejects a board event whose real signature does not match with 401', async () => {
			const { app, enqueuePm } = realLinearApp();
			const res = await postLinear(app, signLinear(boardBody, 'wrong-secret'));
			expect(res.status).toBe(401);
			expect(enqueuePm).not.toHaveBeenCalled();
		});

		it('fails closed when the project has no Linear webhook secret configured', async () => {
			const { app, enqueuePm, getPmCredential } = realLinearApp();
			getPmCredential.mockResolvedValue(null);
			const res = await postLinear(app, signLinear(boardBody));
			expect(res.status).toBe(401);
			expect(enqueuePm).not.toHaveBeenCalled();
		});
	});

	// The third registered PM manifest, and the second on a route no SCM manifest
	// serves (issue #580). Jira frames its digest exactly as GitHub does —
	// `sha256=<hex>` — but in `x-hub-signature` and against the *board's* secret, so
	// this is where "a correctly signed body is accepted and a tampered one is
	// rejected" is exercised at the seam that actually serves it.
	describe('real registered Jira PM manifest (own route, defaultDeps wiring)', () => {
		const secret = 'jira-whsec';
		const jiraProject = createMockJiraProjectConfig();
		const projectKey = jiraProject.pm.type === 'jira' ? jiraProject.pm.projectKey : '';
		// A workflow transition, reported as a `status` entry in the changelog. No
		// `user` block, so loop prevention answers "not ours" without resolving the
		// board identity (which would be a live Jira call).
		const boardBody = JSON.stringify({
			webhookEvent: 'jira:issue_updated',
			issue: {
				key: 'SWARM-12',
				fields: { project: { key: projectKey }, issuetype: { name: 'Task' } },
			},
			changelog: {
				items: [
					{ fieldId: 'status', field: 'status', fromString: 'To Do', toString: 'In Progress' },
				],
			},
		});

		function realJiraApp() {
			const enqueuePm = vi.fn<WebhookReceiverDeps['enqueuePm']>().mockResolvedValue(undefined);
			const getPmCredential = vi
				.fn<WebhookReceiverDeps['getPmCredential']>()
				.mockResolvedValue(secret);
			// The Jira adapter resolves its project by *project key*, through its own
			// facade (issue #529) — not through a receiver dep.
			vi.mocked(findProjectByJiraProject).mockResolvedValue(jiraProject);
			// Leave both registries alone: the route under test is mounted from the
			// registered manifest, not injected.
			const app = createWebhookApp({ getPmCredential, enqueuePm });
			return { app, enqueuePm, getPmCredential };
		}

		/** Jira's framing: GitHub's `sha256=<hex>`, in a header one name older. */
		function signJira(body: string, key = secret) {
			return `sha256=${createHmac('sha256', key).update(body, 'utf8').digest('hex')}`;
		}

		function postJira(app: ReturnType<typeof createWebhookApp>, signature: string) {
			return app.request('/jira/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-hub-signature': signature },
				body: boardBody,
			});
		}

		it("serves the registered manifest's own `/jira/webhook` GET ping", async () => {
			const { app } = realJiraApp();
			expect((await app.request('/jira/webhook')).status).toBe(200);
		});

		it('enqueues a genuinely-signed status transition under the Jira provider id', async () => {
			const { app, enqueuePm, getPmCredential } = realJiraApp();
			const res = await postJira(app, signJira(boardBody));
			expect(res.status).toBe(202);
			// Authenticated against Jira's own declared role, which is its own secret
			// rather than the repository's — the manifest inherits nothing.
			expect(getPmCredential).toHaveBeenCalledWith(jiraProject, PM_WEBHOOK_SECRET_ROLE);
			expect(enqueuePm).toHaveBeenCalledWith(
				'jira',
				expect.objectContaining({
					itemId: 'SWARM-12',
					containerId: projectKey,
					action: 'updated',
					changedField: 'status',
				}),
				jiraProject,
				undefined,
			);
		});

		it('rejects a board event whose real signature does not match with 401', async () => {
			const { app, enqueuePm } = realJiraApp();
			const res = await postJira(app, signJira(boardBody, 'wrong-secret'));
			expect(res.status).toBe(401);
			expect(enqueuePm).not.toHaveBeenCalled();
		});

		it('fails closed when the project has no Jira webhook secret configured', async () => {
			const { app, enqueuePm, getPmCredential } = realJiraApp();
			getPmCredential.mockResolvedValue(null);
			const res = await postJira(app, signJira(boardBody));
			expect(res.status).toBe(401);
			expect(enqueuePm).not.toHaveBeenCalled();
		});
	});

	// The second runtime-ready SCM provider (issue #618). Nothing in the receiver
	// names it: the same loop that mounts GitHub's route mounts this one, because the
	// registered manifest now declares `runtimeReady: true`. Driven through the real
	// registry with only the project + secret lookups faked, so the assertions cover
	// Bitbucket's genuine header names, `sha256=<hex>` framing over `X-Hub-Signature`,
	// and `X-Event-Key` normalization.
	describe('real registered Bitbucket provider (defaultDeps wiring)', () => {
		const secret = 'topsecret';
		const bitbucketProject = createMockProjectConfig({
			id: 'bb-project',
			repo: 'SmartTechBrewery/swarm',
			scm: 'bitbucket',
		});
		const signedBody = JSON.stringify({
			repository: { full_name: 'SmartTechBrewery/swarm' },
			pullrequest: {
				id: 7,
				source: { branch: { name: 'issue-7' }, commit: { hash: 'abcdef123456' } },
				destination: { branch: { name: 'main' } },
				author: { nickname: 'human-dev' },
			},
			actor: { nickname: 'human-dev' },
		});

		function realBitbucketApp() {
			const enqueue = vi.fn<WebhookReceiverDeps['enqueue']>().mockResolvedValue(undefined);
			// Fake only the secret + project lookups; the manifest comes from the registry.
			const app = createWebhookApp({
				findProject: vi
					.fn<(repo: string) => Promise<ProjectConfig | undefined>>()
					.mockResolvedValue(bitbucketProject),
				getWebhookSecret: vi
					.fn<WebhookReceiverDeps['getWebhookSecret']>()
					.mockResolvedValue(secret),
				enqueue,
			});
			return { app, enqueue };
		}

		function signBitbucket(body: string, key = secret) {
			return `sha256=${createHmac('sha256', key).update(body, 'utf8').digest('hex')}`;
		}

		function postBitbucket(
			app: ReturnType<typeof createWebhookApp>,
			body: string,
			headers: Record<string, string> = {},
		) {
			return app.request('/bitbucket/webhook', {
				method: 'POST',
				headers: {
					'x-event-key': 'pullrequest:created',
					'x-hub-signature': signBitbucket(body),
					'x-request-uuid': 'delivery-bb-1',
					'content-type': 'application/json',
					...headers,
				},
				body,
			});
		}

		it("serves the registered manifest's `/bitbucket/webhook` GET ping", async () => {
			const { app } = realBitbucketApp();
			expect((await app.request('/bitbucket/webhook')).status).toBe(200);
		});

		it("enqueues a signed delivery as a neutral event under providerId 'bitbucket'", async () => {
			const { app, enqueue } = realBitbucketApp();
			const res = await postBitbucket(app, signedBody);
			expect(res.status).toBe(202);
			expect(enqueue).toHaveBeenCalledWith(
				'bitbucket',
				expect.objectContaining({
					kind: 'pull-request',
					action: 'opened',
					workItemId: '7',
					prBranch: 'issue-7',
				}),
				bitbucketProject,
				'delivery-bb-1',
			);
		});

		it('rejects a body whose real signature does not match with 401', async () => {
			const { app, enqueue } = realBitbucketApp();
			const res = await postBitbucket(app, signedBody, {
				'x-hub-signature': signBitbucket(signedBody, 'wrong-secret'),
			});
			expect(res.status).toBe(401);
			expect(enqueue).not.toHaveBeenCalled();
		});

		// Bitbucket omits the header entirely for a hook configured without a secret;
		// the provider's verifier fails closed on it rather than trusting the payload.
		it('rejects an unsigned delivery with 401', async () => {
			const { app, enqueue } = realBitbucketApp();
			const res = await app.request('/bitbucket/webhook', {
				method: 'POST',
				headers: { 'x-event-key': 'pullrequest:created', 'content-type': 'application/json' },
				body: signedBody,
			});
			expect(res.status).toBe(401);
			expect(enqueue).not.toHaveBeenCalled();
		});

		it("acknowledges an event key SWARM doesn't act on without enqueueing", async () => {
			const { app, enqueue } = realBitbucketApp();
			const res = await postBitbucket(app, signedBody, { 'x-event-key': 'repo:push' });
			expect(res.status).toBe(202);
			expect(await res.json()).toMatchObject({ ok: true, ignored: true });
			expect(enqueue).not.toHaveBeenCalled();
		});
	});

	// A CI event whose provider names no pull request is completed on the ingress
	// path through the contract's own commit→PR read (issue #618). Bitbucket's
	// `commit_status` carries no association at all, so this is what supplies
	// `workItemId`/`prBranch` — without which the Review trigger drops the event.
	describe("commit→PR resolution for a 'checks' event", () => {
		const checksEvent: ScmEvent = {
			kind: 'checks',
			action: 'completed',
			repoFullName: 'SmartTechBrewery/swarm',
			isCommentEvent: false,
			headSha: 'abcdef123456',
			checkConclusion: 'success',
		};

		function makeChecksApp(overrides: Partial<SCMProvider> = {}) {
			return makeApp({}, { parseWebhookEvent: () => checksEvent, ...overrides });
		}

		it('fills workItemId and prBranch from the open pull request the commit belongs to', async () => {
			const listPullRequestsForCommit = vi
				.fn<SCMProvider['listPullRequestsForCommit']>()
				.mockResolvedValue([
					{ number: 12, headBranch: 'issue-12', state: 'closed' },
					{ number: 42, headBranch: 'issue-42', state: 'open' },
				]);
			const { app, enqueue } = makeChecksApp({ listPullRequestsForCommit });

			const res = await post(app, VALID_BODY);

			expect(res.status).toBe(202);
			expect(listPullRequestsForCommit).toHaveBeenCalledWith(project, 'abcdef123456');
			expect(enqueue).toHaveBeenCalledWith(
				'github',
				{ ...checksEvent, workItemId: '42', prBranch: 'issue-42' },
				project,
				'delivery-1',
			);
		});

		// A GitHub `check_suite` that names a pull request is already resolved, so this
		// path avoids a second API call. Branch and default-branch checks remain unresolved.
		it('never reads when the provider already resolved the event', async () => {
			const listPullRequestsForCommit = vi.fn<SCMProvider['listPullRequestsForCommit']>();
			const resolved = { ...checksEvent, workItemId: '5', prBranch: 'issue-5' };
			const { app, enqueue } = makeApp(
				{},
				{ parseWebhookEvent: () => resolved, listPullRequestsForCommit },
			);

			await post(app, VALID_BODY);

			expect(listPullRequestsForCommit).not.toHaveBeenCalled();
			expect(enqueue).toHaveBeenCalledWith('github', resolved, project, 'delivery-1');
		});

		// A merged or declined pull request must not wake a review of its commit.
		it('leaves the event unresolved when no candidate is open', async () => {
			const { app, enqueue } = makeChecksApp({
				listPullRequestsForCommit: vi
					.fn<SCMProvider['listPullRequestsForCommit']>()
					.mockResolvedValue([{ number: 12, headBranch: 'issue-12', state: 'closed' }]),
			});

			const res = await post(app, VALID_BODY);

			expect(res.status).toBe(202);
			expect(enqueue).toHaveBeenCalledWith('github', checksEvent, project, 'delivery-1');
		});

		// Fails open: the delivery is still accepted and enqueued (matching no trigger)
		// rather than 500'd, because neither provider redelivers a failed webhook on its
		// own — the next CI event for the same commit retries the resolution.
		it('enqueues the unresolved event when the lookup fails', async () => {
			const { app, enqueue } = makeChecksApp({
				listPullRequestsForCommit: vi
					.fn<SCMProvider['listPullRequestsForCommit']>()
					.mockRejectedValue(new Error('bitbucket 503')),
			});

			const res = await post(app, VALID_BODY);

			expect(res.status).toBe(202);
			expect(enqueue).toHaveBeenCalledWith('github', checksEvent, project, 'delivery-1');
		});

		// Loop prevention runs first, so a dropped event never pays for the read.
		it('does not read for an event loop prevention drops', async () => {
			const listPullRequestsForCommit = vi.fn<SCMProvider['listPullRequestsForCommit']>();
			const { app, enqueue } = makeChecksApp({
				isSwarmGeneratedEvent: async () => true,
				listPullRequestsForCommit,
			});

			const res = await post(app, VALID_BODY);

			expect(res.status).toBe(202);
			expect(listPullRequestsForCommit).not.toHaveBeenCalled();
			expect(enqueue).not.toHaveBeenCalled();
		});
	});
});
