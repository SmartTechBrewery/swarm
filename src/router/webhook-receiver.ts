/**
 * Webhook receiver — the router's HTTP surface, modeled on Cascade's
 * `src/router/index.ts` route wiring.
 *
 * One POST route per registered manifest — runtime-ready SCM providers
 * (`SCMProviderManifest.webhookRoute`) and PM providers
 * (`PMProviderManifest.webhookRoute`) — is the whole pipeline up to the queue:
 * read the raw body, let the provider interpret its own headers, authenticate the
 * body, normalize the event, match it to a SWARM project, drop events SWARM itself
 * generated (loop prevention), then hand the normalized event to the enqueue seam.
 * Everything downstream of the seam — trigger routing, the worker — is a later
 * phase (see `enqueue.ts`).
 *
 * The receiver names no provider and knows no provider's vocabulary: header names,
 * event names, payload shapes, signature framing, and both loop-prevention rules
 * live behind `SCMProvider` (`src/scm/types.ts`, issue #385) on the repo side and
 * behind `PMRouterAdapter` plus the manifest's own `verifyWebhookSignature`
 * (`src/pm/router-adapter.ts`, `src/integrations/pm/manifest.ts`, issues
 * #297/#496) on the board side. Adding Bitbucket, GitLab, Jira, or Trello adds a
 * manifest, not a branch here.
 *
 * **A shared path makes a PM manifest a co-tenant, never a second handler.**
 * GitHub delivers `projects_v2_item` to the *same* URL with the same secret as its
 * SCM events (docs/github-projects-v2-api.md §5), so a PM manifest may
 * legitimately declare a path an SCM manifest already serves — and `app.post()`-ing
 * that path again would leave Hono with a shadowed second handler that never runs.
 * The rule (issue #496):
 *
 * 1. Runtime-ready SCM manifests mount their routes first.
 * 2. A PM manifest whose `webhookRoute` is one of those paths becomes a
 *    **co-tenant** of it: inside that route's handler, before SCM parsing, the raw
 *    `(eventName, payload)` is offered to each co-tenant's
 *    `routerAdapter.parseWebhook`, and the first non-null result takes the request
 *    down the PM path. `parseWebhook` already returns `null` for anything that is
 *    not its own event, so this is the neutral form of the hardcoded
 *    `projects_v2_item` branch it replaced.
 * 3. A PM manifest whose route nothing else serves mounts its own GET (provider
 *    ping) + POST pair, exactly as the SCM loop does.
 *
 * The app is built by a factory taking its collaborators as parameters so tests
 * can drive it via `app.request()` with fakes, without a live server, DB, or real
 * credentials — the same reason Cascade extracts its verifier/handler logic out of
 * the side-effect-heavy entry point.
 */

import { type Context, Hono } from 'hono';

import {
	findProjectByBoard,
	findProjectByRepo,
	getWebhookSecretOrNull,
} from '../config/provider.js';
import type { ProjectConfig } from '../config/schema.js';
// Side-effect import: registers every PM and SCM provider manifest into its
// registry before defaultDeps() reads them below.
import '../integrations/entrypoint.js';
import { listPMProviders, type PMProviderManifest } from '../integrations/pm/index.js';
import {
	isRuntimeReadySCMProvider,
	type SCMProviderManifest,
} from '../integrations/scm/manifest.js';
import { listSCMProviders } from '../integrations/scm/registry.js';
import { logger } from '../lib/logger.js';
import type { PmEvent } from '../pm/events.js';
import type { PMType } from '../pm/types.js';
import type { ScmEvent } from '../scm/events.js';
import type { ScmType, ScmWebhookRequest } from '../scm/types.js';
import { enqueuePmEvent, enqueueScmEvent } from './enqueue.js';
import { resolveWebhookCallbackUrl } from './webhook-callback-url.js';

/**
 * Upper bound on the webhook body we'll buffer. GitHub never sends deliveries
 * larger than 25 MB, so anything above that isn't a legitimate GitHub webhook —
 * reject it up front rather than reading an arbitrarily large (still
 * unauthenticated) body into memory via `c.req.text()`.
 */
const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;

/**
 * The `eventName` a PM adapter serving its **own** route is handed. The PM
 * manifest declares no header reader — the SCM contract's `readWebhookRequest`
 * has no PM twin yet — and none of the providers `PMType` already names needs
 * one: Jira (`webhookEvent`), Linear (`type`/`action`), and Trello
 * (`action.type`) each name the event *in the body*, which `parseWebhook`
 * receives in full. A provider that genuinely needs a header to discriminate is
 * the signal to widen the manifest, not to guess a header name here.
 */
const OWN_ROUTE_EVENT_NAME = '';

/**
 * Collaborators the receiver depends on. Defaulted to the real implementations
 * so production wiring is a bare `createWebhookApp()`; tests inject fakes.
 */
export interface WebhookReceiverDeps {
	/** Runtime-ready registered SCM providers whose `webhookRoute`s this app serves. */
	scmProviders: readonly SCMProviderManifest[];
	/**
	 * Registered PM providers whose `webhookRoute`s this app serves — either as a
	 * co-tenant of an SCM route or on their own (see this module's header). No
	 * `runtimeReady` filter: the PM manifest has no such flag, because
	 * `project.pm.type` already selects a project's provider
	 * (`src/integrations/pm/registry.ts`).
	 */
	pmProviders: readonly PMProviderManifest[];
	findProject: (repo: string) => Promise<ProjectConfig | undefined>;
	/** Resolve the SWARM project owning a PM board, by the provider's container id. */
	findProjectByBoard: (containerId: string) => Promise<ProjectConfig | undefined>;
	getWebhookSecret: (project: ProjectConfig) => Promise<string | null>;
	enqueue: (
		providerId: ScmType,
		event: ScmEvent,
		project: ProjectConfig,
		deliveryId: string | undefined,
	) => Promise<void>;
	enqueuePm: (
		providerId: PMType,
		event: PmEvent,
		project: ProjectConfig,
		deliveryId: string | undefined,
	) => Promise<void>;
}

function defaultDeps(): WebhookReceiverDeps {
	return {
		scmProviders: listSCMProviders(),
		pmProviders: listPMProviders(),
		findProject: findProjectByRepo,
		findProjectByBoard,
		getWebhookSecret: getWebhookSecretOrNull,
		enqueue: enqueueScmEvent,
		enqueuePm: enqueuePmEvent,
	};
}

/**
 * Read the raw body (never re-serialized — the HMAC covers the exact bytes) and
 * parse it as JSON. Returns the parsed payload alongside the raw bytes, or a
 * short-circuit `Response` (413 oversized / 400 non-JSON) for the caller to return.
 */
async function readJsonBody(c: Context): Promise<{ rawBody: string; payload: unknown } | Response> {
	// Reject oversized bodies before buffering — the body is unauthenticated here
	// (the secret is per-project, resolved further down).
	const contentLength = Number(c.req.header('content-length'));
	if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BODY_BYTES) {
		return c.json({ ok: false, reason: 'payload too large' }, 413);
	}

	const rawBody = await c.req.text();
	try {
		return { rawBody, payload: JSON.parse(rawBody) };
	} catch {
		// The most common cause is a webhook misconfigured with GitHub's
		// `application/x-www-form-urlencoded` content type; the diagnostic points at
		// the fix (docs mandate `application/json`).
		return c.json(
			{
				ok: false,
				reason: 'invalid JSON body (webhook must use the application/json content type)',
			},
			400,
		);
	}
}

/**
 * Authenticate a repo-scoped webhook against its project's HMAC secret. Returns a
 * short-circuit `Response` (401) the caller must return, or `null` when the body
 * is authentic. A project with no secret configured can't be verified, so we
 * refuse rather than trust an unauthenticated payload. The scheme itself is the
 * provider's (`SCMProvider.verifyWebhookSignature`).
 */
async function authenticateScmWebhook(
	c: Context,
	deps: WebhookReceiverDeps,
	manifest: SCMProviderManifest,
	project: ProjectConfig,
	rawBody: string,
	signature: string,
	logContext: Record<string, unknown>,
): Promise<Response | null> {
	const secret = await deps.getWebhookSecret(project);
	if (!secret) {
		logger.error('No webhook secret configured for project; rejecting webhook', {
			projectId: project.id,
			...logContext,
		});
		return c.json({ ok: false, reason: 'webhook secret not configured' }, 401);
	}

	if (!manifest.provider.verifyWebhookSignature(rawBody, signature, secret)) {
		logger.warn('Webhook signature verification failed', {
			providerId: manifest.id,
			projectId: project.id,
			...logContext,
		});
		return c.json({ ok: false, reason: 'signature verification failed' }, 401);
	}

	return null;
}

/**
 * Authenticate a board webhook through the PM manifest's own verifier. Returns a
 * short-circuit `Response` (401) the caller must return, or `null` when the body
 * is authentic.
 *
 * Unlike the SCM path this does **not** refuse an unconfigured secret up front: a
 * PM scheme need not use SWARM's shared secret at all (Trello signs with its API
 * secret over `rawBody + callbackUrl`), so the verifier decides and a `null`
 * secret rides through to it — GitHub Projects' verifier fails closed on it, as any
 * verifier that needs a secret must. The missing secret is still reported as its
 * own diagnostic, since it is the likeliest cause of a 401 here.
 */
async function authenticatePmWebhook(
	c: Context,
	deps: WebhookReceiverDeps,
	manifest: PMProviderManifest,
	project: ProjectConfig,
	rawBody: string,
	logContext: Record<string, unknown>,
): Promise<Response | null> {
	const secret = await deps.getWebhookSecret(project);
	const headers = (name: string) => c.req.header(name);

	const verified = manifest.verifyWebhookSignature({
		rawBody,
		headers,
		secret,
		callbackUrl: resolveWebhookCallbackUrl(manifest.webhookRoute, headers),
	});
	if (verified) return null;

	if (!secret) {
		logger.error('No webhook secret configured for project; rejecting board webhook', {
			providerId: manifest.id,
			projectId: project.id,
			...logContext,
		});
		return c.json({ ok: false, reason: 'webhook secret not configured' }, 401);
	}

	logger.warn('Webhook signature verification failed', {
		providerId: manifest.id,
		projectId: project.id,
		...logContext,
	});
	return c.json({ ok: false, reason: 'signature verification failed' }, 401);
}

/** Handle a repo-scoped SCM event (a pull request, a review, a comment, checks, …). */
async function handleScmEvent(
	c: Context,
	deps: WebhookReceiverDeps,
	manifest: SCMProviderManifest,
	rawBody: string,
	payload: unknown,
	request: ScmWebhookRequest,
): Promise<Response> {
	// Non-actionable event type → acknowledge so the provider stops retrying, but do
	// no work. `parseWebhookEvent` returns null for anything SWARM doesn't act on.
	const event = manifest.provider.parseWebhookEvent(request.eventName, payload);
	if (!event) {
		return c.json(
			{ ok: true, ignored: true, reason: `unhandled event type: ${request.eventName}` },
			202,
		);
	}

	// Untracked repo → not ours. Ack without work (and before touching secrets).
	const project = await deps.findProject(event.repoFullName);
	if (!project) {
		return c.json({ ok: true, ignored: true, reason: 'repo not tracked by any project' }, 202);
	}

	const authFailure = await authenticateScmWebhook(
		c,
		deps,
		manifest,
		project,
		rawBody,
		request.signature,
		{ repo: event.repoFullName, eventKind: event.kind },
	);
	if (authFailure) return authFailure;

	// Loop prevention: drop comment events SWARM generated — recognized by the
	// comment's own SWARM marker, not by its author (issue #443) — so SWARM never
	// reacts to its own ack/reply. PR/review lifecycle events flow through even
	// when a persona produced them (the *other* persona must act); that
	// cross-persona routing is the trigger's job, not this gate's.
	if (await manifest.provider.isSwarmGeneratedEvent(event, project)) {
		return c.json(
			{ ok: true, ignored: true, reason: 'swarm-generated comment (loop prevention)' },
			202,
		);
	}

	await deps.enqueue(manifest.id, event, project, request.deliveryId);
	return c.json({ ok: true, accepted: true }, 202);
}

/**
 * Handle a PM board event — SWARM's `pm:status-changed` ingress — for the manifest
 * whose adapter already parsed it (the caller parses, because on a shared route
 * that parse is also the "is this a board event at all?" test). Unlike the SCM path
 * it resolves the project by the board's container id (a board event carries no
 * repo) and filters to state-field changes before enqueueing. Every
 * provider-specific step is behind the PM manifest: `PMRouterAdapter`
 * (`src/pm/router-adapter.ts`) for the filters, `verifyWebhookSignature` for
 * authentication.
 */
async function handlePmEvent(
	c: Context,
	deps: WebhookReceiverDeps,
	manifest: PMProviderManifest,
	event: PmEvent,
	rawBody: string,
	deliveryId: string | undefined,
): Promise<Response> {
	// Untracked board → not ours. Ack without work (and before touching secrets).
	const project = await deps.findProjectByBoard(event.containerId);
	if (!project) {
		return c.json({ ok: true, ignored: true, reason: 'board not tracked by any project' }, 202);
	}

	const authFailure = await authenticatePmWebhook(c, deps, manifest, project, rawBody, {
		containerId: event.containerId,
		action: event.action,
	});
	if (authFailure) return authFailure;

	// Only Status-field edits (and new cards) wake the pipeline; every other
	// field edit — Priority, Size, assignees — is acknowledged and dropped.
	if (!manifest.routerAdapter.isStatusChange(event, project)) {
		return c.json({ ok: true, ignored: true, reason: 'not a status-field change' }, 202);
	}

	// Loop prevention: drop status changes a SWARM persona itself made, so the
	// worker moving a card doesn't re-fire the trigger that started it.
	if (await manifest.routerAdapter.isSelfAuthored(event, project)) {
		return c.json(
			{ ok: true, ignored: true, reason: 'self-authored status change (loop prevention)' },
			202,
		);
	}

	await deps.enqueuePm(manifest.id, event, project, deliveryId);
	return c.json({ ok: true, accepted: true }, 202);
}

/** Group PM manifests by the route they declare, so one path mounts one handler. */
function pmManifestsByRoute(
	manifests: readonly PMProviderManifest[],
): Map<string, PMProviderManifest[]> {
	const byRoute = new Map<string, PMProviderManifest[]>();
	for (const manifest of manifests) {
		const sharing = byRoute.get(manifest.webhookRoute);
		if (sharing) sharing.push(manifest);
		else byRoute.set(manifest.webhookRoute, [manifest]);
	}
	return byRoute;
}

/**
 * Build the router's Hono app. Pass `overrides` to substitute collaborators in
 * tests; omit for the production wiring.
 */
export function createWebhookApp(overrides: Partial<WebhookReceiverDeps> = {}): Hono {
	const deps = { ...defaultDeps(), ...overrides };
	const app = new Hono();

	// A throw from a collaborator (DB down, secret store unreachable) would
	// otherwise surface as a bare, unlogged Hono 500. Log it so a processing
	// outage leaves a trace, and keep the 500 — GitHub retries 5xx, which is the
	// right behavior for a transient collaborator failure. Mirrors Cascade's
	// `app.onError` in `src/router/index.ts`.
	app.onError((err, c) => {
		logger.error('Unhandled error in webhook receiver', {
			path: c.req.path,
			method: c.req.method,
			error: err instanceof Error ? err.message : String(err),
		});
		return c.json({ ok: false, reason: 'internal error' }, 500);
	});

	// Liveness probe for the Docker Compose healthcheck.
	app.get('/health', (c) => c.json({ status: 'ok', service: 'router' }));

	// A provider still being built out phase by phase (issue #296) gets no route:
	// serving one would expose an unauthenticated endpoint whose first act is to
	// call a contract method that throws (`manifest.runtimeReady`).
	const scmManifests = deps.scmProviders.filter(isRuntimeReadySCMProvider);
	const scmRoutes = new Set(scmManifests.map((manifest) => manifest.webhookRoute));
	const pmByRoute = pmManifestsByRoute(deps.pmProviders);

	for (const manifest of scmManifests) {
		// PM manifests declaring this same path ride inside this handler rather than
		// mounting a shadowed second one — see this module's header.
		const coTenants = pmByRoute.get(manifest.webhookRoute) ?? [];

		// Providers ping the endpoint with a GET when a webhook is (re)configured.
		app.get(manifest.webhookRoute, (c) => c.text('OK', 200));

		app.post(manifest.webhookRoute, async (c) => {
			const body = await readJsonBody(c);
			if (body instanceof Response) return body;
			const { rawBody, payload } = body;

			// Only the provider knows which of its headers names the event, carries the
			// delivery id, and carries the signature.
			const request = manifest.provider.readWebhookRequest((name) => c.req.header(name));

			// A board event carries no repo, so it routes through its PM manifest
			// (which resolves by container id); everything else is a repo-scoped SCM
			// event. `parseWebhook` returning null *is* the "not my event" answer.
			for (const pm of coTenants) {
				const event = pm.routerAdapter.parseWebhook(request.eventName, payload);
				if (event) return handlePmEvent(c, deps, pm, event, rawBody, request.deliveryId);
			}

			return handleScmEvent(c, deps, manifest, rawBody, payload, request);
		});
	}

	for (const [route, manifests] of pmByRoute) {
		if (scmRoutes.has(route)) continue; // already served as a co-tenant above

		app.get(route, (c) => c.text('OK', 200));

		app.post(route, async (c) => {
			const body = await readJsonBody(c);
			if (body instanceof Response) return body;
			const { rawBody, payload } = body;

			// No delivery id either: reading one needs the same per-provider header
			// knowledge `OWN_ROUTE_EVENT_NAME` explains the absence of, so a delivery
			// here enqueues without a dedup identity until a provider that mounts its
			// own route brings that reader with it.
			for (const manifest of manifests) {
				const event = manifest.routerAdapter.parseWebhook(OWN_ROUTE_EVENT_NAME, payload);
				if (event) return handlePmEvent(c, deps, manifest, event, rawBody, undefined);
			}

			return c.json({ ok: true, ignored: true, reason: 'unactionable board payload' }, 202);
		});
	}

	return app;
}
