/**
 * SCM webhook receiver — the router's HTTP surface, modeled on Cascade's
 * `src/router/index.ts` route wiring.
 *
 * One POST route per registered SCM provider (`manifest.webhookRoute` —
 * `/github/webhook` for the only provider today) is the whole pipeline up to the
 * queue: read the raw body, let the provider interpret its own headers,
 * authenticate the body (HMAC), normalize the event, match it to a SWARM project,
 * drop events SWARM itself generated (loop prevention), then hand the normalized
 * event to the enqueue seam. Everything downstream of the seam — trigger routing,
 * the worker — is a later phase (see `enqueue.ts`).
 *
 * Since issue #385 the receiver names no provider and knows no provider's
 * vocabulary: header names, event names, payload shapes, signature framing, and
 * the loop-prevention rule all live behind `SCMProvider`
 * (`src/scm/types.ts`), resolved from `scmProviderRegistry`. Adding Bitbucket or
 * GitLab therefore adds a manifest, not a branch here.
 *
 * The one deliberate exception is the GitHub Projects board event: GitHub delivers
 * `projects_v2_item` to the *same* URL with the same secret
 * (docs/github-projects-v2-api.md §5), so an SCM route also carries SWARM's
 * `pm:status-changed` ingress and routes it through the PM adapter. That branch is
 * PM-side and stays as it was.
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
import { getPMProvider } from '../integrations/pm/registry.js';
import type { SCMProviderManifest } from '../integrations/scm/manifest.js';
import { listSCMProviders } from '../integrations/scm/registry.js';
import { logger } from '../lib/logger.js';
import type { ScmEvent } from '../scm/events.js';
import type { ScmType, ScmWebhookRequest } from '../scm/types.js';
import type { GitHubProjectsRouterAdapter } from './adapters/github-projects.js';
import { PROJECTS_V2_ITEM_EVENT } from './adapters/github-projects.js';
import { enqueueProjectsEvent, enqueueScmEvent } from './enqueue.js';

/**
 * Upper bound on the webhook body we'll buffer. GitHub never sends deliveries
 * larger than 25 MB, so anything above that isn't a legitimate GitHub webhook —
 * reject it up front rather than reading an arbitrarily large (still
 * unauthenticated) body into memory via `c.req.text()`.
 */
const MAX_WEBHOOK_BODY_BYTES = 25 * 1024 * 1024;

/**
 * Collaborators the receiver depends on. Defaulted to the real implementations
 * so production wiring is a bare `createWebhookApp()`; tests inject fakes.
 */
export interface WebhookReceiverDeps {
	/** Registered SCM providers whose `webhookRoute`s this app serves. */
	scmProviders: readonly SCMProviderManifest[];
	pmAdapter: GitHubProjectsRouterAdapter;
	findProject: (repo: string) => Promise<ProjectConfig | undefined>;
	/** Resolve the SWARM project owning a Projects v2 board, by its node ID. */
	findProjectByBoard: (projectNodeId: string) => Promise<ProjectConfig | undefined>;
	getWebhookSecret: (project: ProjectConfig) => Promise<string | null>;
	enqueue: (
		providerId: ScmType,
		event: ScmEvent,
		project: ProjectConfig,
		deliveryId: string | undefined,
	) => Promise<void>;
	enqueueProjects: (
		event: import('./adapters/github-projects.js').GitHubProjectsParsedEvent,
		project: ProjectConfig,
		deliveryId: string | undefined,
	) => Promise<void>;
}

/**
 * Resolve the GitHub Projects router adapter from the manifest registry rather
 * than constructing it here, so the receiver never hardcodes a concrete PM
 * provider (ai/CODING_STANDARDS.md "Module shape for a provider"). The
 * entrypoint import above guarantees registration ran; a missing manifest means
 * the entrypoint failed to load, which is a wiring bug, not a runtime condition.
 */
function resolvePmAdapter(): GitHubProjectsRouterAdapter {
	const manifest = getPMProvider('github-projects');
	if (!manifest) {
		throw new Error(
			"PM provider 'github-projects' is not registered — did src/integrations/entrypoint.ts fail to load?",
		);
	}
	return manifest.routerAdapter;
}

function defaultDeps(): WebhookReceiverDeps {
	return {
		scmProviders: listSCMProviders(),
		pmAdapter: resolvePmAdapter(),
		findProject: findProjectByRepo,
		findProjectByBoard,
		getWebhookSecret: getWebhookSecretOrNull,
		enqueue: enqueueScmEvent,
		enqueueProjects: enqueueProjectsEvent,
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
 * Authenticate a webhook against its project's HMAC secret — shared by the SCM
 * and PM paths, since both subscriptions point at the same URL and share the
 * same secret (docs/github-projects-v2-api.md §5). Returns a short-circuit
 * `Response` (401) the caller must return, or `null` when the body is authentic.
 * A project with no secret configured can't be verified, so we refuse rather
 * than trust an unauthenticated payload. The scheme itself is the provider's
 * (`SCMProvider.verifyWebhookSignature`).
 */
async function authenticateWebhook(
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

	const authFailure = await authenticateWebhook(
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
 * Handle the `projects_v2_item` board event — SWARM's `pm:status-changed`
 * ingress. Unlike the SCM path it resolves the project by board node ID (a
 * Projects event carries no repo) and filters to Status-field edits before
 * enqueueing.
 */
async function handleProjectsEvent(
	c: Context,
	deps: WebhookReceiverDeps,
	manifest: SCMProviderManifest,
	rawBody: string,
	payload: unknown,
	request: ScmWebhookRequest,
): Promise<Response> {
	const event = deps.pmAdapter.parseWebhook(request.eventName, payload);
	if (!event) {
		return c.json(
			{ ok: true, ignored: true, reason: 'unactionable projects_v2_item payload' },
			202,
		);
	}

	// Untracked board → not ours. Ack without work (and before touching secrets).
	const project = await deps.findProjectByBoard(event.projectNodeId);
	if (!project) {
		return c.json({ ok: true, ignored: true, reason: 'board not tracked by any project' }, 202);
	}

	const authFailure = await authenticateWebhook(
		c,
		deps,
		manifest,
		project,
		rawBody,
		request.signature,
		{ projectNodeId: event.projectNodeId, eventType: event.eventType, action: event.action },
	);
	if (authFailure) return authFailure;

	// Only Status-field edits (and new cards) wake the pipeline; every other
	// field edit — Priority, Size, assignees — is acknowledged and dropped.
	if (!deps.pmAdapter.isStatusChange(event, project)) {
		return c.json({ ok: true, ignored: true, reason: 'not a status-field change' }, 202);
	}

	// Loop prevention: drop status changes a SWARM persona itself made, so the
	// worker moving a card doesn't re-fire the trigger that started it.
	if (await deps.pmAdapter.isSelfAuthored(event, project)) {
		return c.json(
			{ ok: true, ignored: true, reason: 'self-authored status change (loop prevention)' },
			202,
		);
	}

	await deps.enqueueProjects(event, project, request.deliveryId);
	return c.json({ ok: true, accepted: true }, 202);
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

	for (const manifest of deps.scmProviders) {
		// Providers ping the endpoint with a GET when a webhook is (re)configured.
		app.get(manifest.webhookRoute, (c) => c.text('OK', 200));

		app.post(manifest.webhookRoute, async (c) => {
			const body = await readJsonBody(c);
			if (body instanceof Response) return body;
			const { rawBody, payload } = body;

			// Only the provider knows which of its headers names the event, carries the
			// delivery id, and carries the signature.
			const request = manifest.provider.readWebhookRequest((name) => c.req.header(name));

			// A Projects board event carries no repo, so it routes through the PM
			// adapter (which resolves by board node ID); everything else is a
			// repo-scoped SCM event.
			if (request.eventName === PROJECTS_V2_ITEM_EVENT) {
				return handleProjectsEvent(c, deps, manifest, rawBody, payload, request);
			}
			return handleScmEvent(c, deps, manifest, rawBody, payload, request);
		});
	}

	return app;
}
