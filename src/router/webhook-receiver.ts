/**
 * GitHub webhook receiver — the router'\''s HTTP surface, modeled on Cascade'\''s
 * `src/router/index.ts` route wiring but trimmed to SWARM'\''s single SCM.
 *
 * `POST /github/webhook` is the whole pipeline up to the queue: read the raw
 * body, authenticate it (HMAC), match it to a SWARM project, drop SWARM'\''s own
 * comment events (loop prevention), then hand the normalized event to the
 * enqueue seam. Everything downstream of the seam — trigger routing, the worker
 * — is a later phase (see `enqueue.ts`).
 *
 * The app is built by a factory taking its collaborators as parameters so tests
 * can drive it via `app.request()` with fakes, without a live server, DB, or
 * real credentials — the same reason Cascade extracts its verifier/handler
 * logic out of the side-effect-heavy entry point.
 */

import { type Context, Hono } from 'hono';

import {
	findProjectByBoard,
	findProjectByRepo,
	getWebhookSecretOrNull,
} from '../config/provider.js';
import type { ProjectConfig } from '../config/schema.js';
// Side-effect import: registers every PM provider manifest into
// pmProviderRegistry before defaultDeps() reads it below.
import '../integrations/entrypoint.js';
import { getPMProvider } from '../integrations/pm/registry.js';
import { logger } from '../lib/logger.js';
import { verifyGitHubSignature } from '../webhook/signature-verification.js';
import { GitHubRouterAdapter } from './adapters/github.js';
import type { GitHubProjectsRouterAdapter } from './adapters/github-projects.js';
import { PROJECTS_V2_ITEM_EVENT } from './adapters/github-projects.js';
import { enqueueProjectsEvent, enqueueWebhookEvent } from './enqueue.js';

/** Header GitHub delivers the event type in (not carried in the body). */
const EVENT_TYPE_HEADER = 'x-github-event';
/** Header carrying the HMAC-SHA256 signature GitHub signs the raw body with. */
const SIGNATURE_HEADER = 'x-hub-signature-256';
/** Per-delivery id GitHub sends; carried through for idempotency/tracing. */
const DELIVERY_HEADER = 'x-github-delivery';
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
	adapter: GitHubRouterAdapter;
	pmAdapter: GitHubProjectsRouterAdapter;
	findProject: (repo: string) => Promise<ProjectConfig | undefined>;
	/** Resolve the SWARM project owning a Projects v2 board, by its node ID. */
	findProjectByBoard: (projectNodeId: string) => Promise<ProjectConfig | undefined>;
	getWebhookSecret: (project: ProjectConfig) => Promise<string | null>;
	enqueue: (
		event: import('./adapters/github.js').GitHubParsedEvent,
		project: ProjectConfig,
		deliveryId: string | undefined,
	) => Promise<void>;
	enqueueProjects: (
		event: import('./adapters/github-projects.js').GitHubProjectsParsedEvent,
		project: ProjectConfig,
		deliveryId: string | undefined,
	) => Promise<void>;
	verifySignature: (rawBody: string, signature: string, secret: string) => boolean;
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
		adapter: new GitHubRouterAdapter(),
		pmAdapter: resolvePmAdapter(),
		findProject: findProjectByRepo,
		findProjectByBoard,
		getWebhookSecret: getWebhookSecretOrNull,
		enqueue: enqueueWebhookEvent,
		enqueueProjects: enqueueProjectsEvent,
		verifySignature: verifyGitHubSignature,
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
 * Authenticate a webhook against its project'\''s HMAC secret — shared by the SCM
 * and PM paths, since both subscriptions point at the same URL and share the
 * same secret (docs/github-projects-v2-api.md §5). Returns a short-circuit
 * `Response` (401) the caller must return, or `null` when the body is authentic.
 * A project with no secret configured can'\''t be verified, so we refuse rather
 * than trust an unauthenticated payload.
 */
async function authenticateWebhook(
	c: Context,
	deps: WebhookReceiverDeps,
	project: ProjectConfig,
	rawBody: string,
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

	const signature = c.req.header(SIGNATURE_HEADER) ?? '';
	if (!deps.verifySignature(rawBody, signature, secret)) {
		logger.warn('GitHub webhook signature verification failed', {
			projectId: project.id,
			...logContext,
		});
		return c.json({ ok: false, reason: 'signature verification failed' }, 401);
	}

	return null;
}

/** Handle the five repo-scoped events (`pull_request`, `issues`, …). */
async function handleScmEvent(
	c: Context,
	deps: WebhookReceiverDeps,
	rawBody: string,
	payload: unknown,
	eventType: string,
	deliveryId: string | undefined,
): Promise<Response> {
	// Non-actionable event type → acknowledge so GitHub stops retrying, but do
	// no work. `parseWebhook` returns null for anything outside PROCESSABLE_EVENTS.
	const event = deps.adapter.parseWebhook(eventType, payload);
	if (!event) {
		return c.json({ ok: true, ignored: true, reason: `unhandled event type: ${eventType}` }, 202);
	}

	// Untracked repo → not ours. Ack without work (and before touching secrets).
	const project = await deps.findProject(event.repoFullName);
	if (!project) {
		return c.json({ ok: true, ignored: true, reason: 'repo not tracked by any project' }, 202);
	}

	const authFailure = await authenticateWebhook(c, deps, project, rawBody, {
		repo: event.repoFullName,
		eventType: event.eventType,
	});
	if (authFailure) return authFailure;

	// Loop prevention: drop comment events SWARM generated — recognized by the
	// comment's own SWARM marker, not by its author (issue #443) — so SWARM never
	// reacts to its own ack/reply. PR/review lifecycle events flow through even
	// when a persona produced them (the *other* persona must act); that
	// cross-persona routing is the adapter's job, not this gate's.
	if (await deps.adapter.isSelfAuthored(event, project)) {
		return c.json(
			{ ok: true, ignored: true, reason: 'swarm-generated comment (loop prevention)' },
			202,
		);
	}

	await deps.enqueue(event, project, deliveryId);
	return c.json({ ok: true, accepted: true }, 202);
}

/**
 * Handle the `projects_v2_item` board event — SWARM'\''s `pm:status-changed`
 * ingress. Unlike the SCM path it resolves the project by board node ID (a
 * Projects event carries no repo) and filters to Status-field edits before
 * enqueueing.
 */
async function handleProjectsEvent(
	c: Context,
	deps: WebhookReceiverDeps,
	rawBody: string,
	payload: unknown,
	eventType: string,
	deliveryId: string | undefined,
): Promise<Response> {
	const event = deps.pmAdapter.parseWebhook(eventType, payload);
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

	const authFailure = await authenticateWebhook(c, deps, project, rawBody, {
		projectNodeId: event.projectNodeId,
		eventType: event.eventType,
		action: event.action,
	});
	if (authFailure) return authFailure;

	// Only Status-field edits (and new cards) wake the pipeline; every other
	// field edit — Priority, Size, assignees — is acknowledged and dropped.
	if (!deps.pmAdapter.isStatusChange(event, project)) {
		return c.json({ ok: true, ignored: true, reason: 'not a status-field change' }, 202);
	}

	// Loop prevention: drop status changes a SWARM persona itself made, so the
	// worker moving a card doesn'\''t re-fire the trigger that started it.
	if (await deps.pmAdapter.isSelfAuthored(event, project)) {
		return c.json(
			{ ok: true, ignored: true, reason: 'self-authored status change (loop prevention)' },
			202,
		);
	}

	await deps.enqueueProjects(event, project, deliveryId);
	return c.json({ ok: true, accepted: true }, 202);
}

/**
 * Build the router'\''s Hono app. Pass `overrides` to substitute collaborators in
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

	// GitHub pings the endpoint with a GET when a webhook is (re)configured.
	app.get('/github/webhook', (c) => c.text('OK', 200));

	app.post('/github/webhook', async (c) => {
		const body = await readJsonBody(c);
		if (body instanceof Response) return body;
		const { rawBody, payload } = body;

		const eventType = c.req.header(EVENT_TYPE_HEADER) ?? 'unknown';
		const deliveryId = c.req.header(DELIVERY_HEADER);

		// A Projects board event carries no repo, so it routes through the PM
		// adapter (resolves by board node ID); everything else is a repo-scoped SCM
		// event. Branching on the event type — not on a provider discriminator —
		// keeps each adapter owning its own parse/resolve.
		if (eventType === PROJECTS_V2_ITEM_EVENT) {
			return handleProjectsEvent(c, deps, rawBody, payload, eventType, deliveryId);
		}
		return handleScmEvent(c, deps, rawBody, payload, eventType, deliveryId);
	});

	return app;
}
