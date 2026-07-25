/**
 * Server-side delivery API for the operations a federated worker cannot perform
 * itself — the metadata GitHub writes whose credential stays on the server
 * (ADR-004 §2), plus the review-verdict ledger reads/writes whose *database*
 * stays on the server (ADR-003 §2).
 *
 * The two metadata-only SCM
 * delivery calls — submit a review, post a PR comment — run *here*, on the
 * router, under the **per-project reviewer PAT** the server already resolves
 * (`getPersonaToken`), instead of on a federated worker holding that token. A
 * worker sends only the verdict + comment body + PR number up the transport
 * (`../scm/transport-delivery.ts`); this module performs the GitHub write and
 * returns the created review/comment id. The reviewer PAT is resolved *inside*
 * this process and never leaves it, and only metadata crosses the wire — the
 * repository tree never does (the local-first boundary, ai/RULES.md §1).
 *
 * The review still lands on the PR as a genuine GitHub review, so the existing
 * `pull_request_review`-driven respond-to-review trigger (PROJECT.md §5.4) keeps
 * working unchanged.
 *
 * The independent Phase 2/2 half does the same for the two metadata-only **PM**
 * board writes — move a card, comment on the backing Issue/PR — under the
 * **per-project PM credential** the server resolves via
 * `createGitHubProjectsProvider(project)`; the worker sends only the canonical
 * status key / comment body up the transport (`../pm/transport-delivery.ts`).
 * The PM credential is resolved *inside* this process and never leaves it, and
 * the status crossing the wire is a canonical `PmStatusKey`, never a board
 * option ID (ai/RULES.md §2) — the adapter resolves it server-side.
 *
 * The last three routes front the **review-verdict ledger** — the `review_verdicts`
 * table (`../db/repositories/reviewVerdictsRepository.ts`) a Review run consults
 * for the two-verdict safety cap (issue #235) and the prior-submitted-verdict
 * re-review signal (issue #328). A DB-free remote worker holds no `DATABASE_URL`,
 * so those three calls run here instead (`../transport/review-ledger-delivery.ts`
 * is the client). No credential is involved: what stays server-side is the
 * database. The worker sends only PR coordinates, and the ledger key's
 * `projectId`/`repository` are taken from the **authenticated** project — never
 * from the request — so a worker cannot key a row to a project or repository it
 * isn't enrolled in.
 *
 * Eight routes, all under `/worker/delivery`:
 *   - `POST /worker/delivery/review` — submit a review (verdict + body).
 *   - `POST /worker/delivery/pr-comment` — post a top-level PR comment.
 *   - `POST /worker/delivery/pm/move` — move a board card to a canonical status.
 *   - `POST /worker/delivery/pm/comment` — comment on the item's backing Issue/PR.
 *   - `POST /worker/delivery/pm/blockers` — read the item's open prerequisites.
 *   - `POST /worker/delivery/review-ledger/prior` — the PR's prior submitted verdict.
 *   - `POST /worker/delivery/review-ledger/mark` — mark this PR/head's slot submitted.
 *   - `POST /worker/delivery/review-ledger/abandon` — release a pending slot.
 *
 * Mirrors `./worker-transport.ts`: the request logic is factored out of the HTTP
 * glue into pure, injectable functions (`handleSubmitReview`,
 * `handlePostComment`, `handleMoveWorkItem`, `handleAddPmComment`,
 * `handleListBlockers`, `handlePriorReview`, `handleMarkReviewVerdict`, `handleAbandonReviewVerdict`) so
 * tests drive them with fake deps and never need a live router; collaborators
 * default to the real services and are overridden in tests. Credential handling
 * matches the handshake's contract — the raw credential appears only in the
 * `Authorization: Bearer` header, is never logged, never placed in a URL, and
 * never reflected in a response body.
 */

import type { Context, Hono } from 'hono';

import type { ProjectConfig } from '../config/schema.js';
import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import {
	abandonReviewVerdict,
	getPriorSubmittedReview,
	markReviewVerdictSubmitted,
} from '../db/repositories/reviewVerdictsRepository.js';
import { listEnrollmentsForWorker } from '../db/repositories/workerEnrollmentsRepository.js';
import type { Worker } from '../identity/worker.js';
import { isRoutable } from '../identity/worker-enrollment.js';
import { resolveWorkerByCredential } from '../identity/worker-service.js';
import { createGitHubProjectsProvider } from '../integrations/pm/github-projects/provider.js';
import type { GitHubPersona } from '../integrations/scm/github/personas.js';
import { GitHubSCMIntegration } from '../integrations/scm/github/scm-integration.js';
import type { ReviewVerdictLedger } from '../pipeline/review-ledger.js';
import type { PMProvider } from '../pm/types.js';
import type { ScmDeliveryProvider } from '../scm/delivery.js';
import {
	AbandonReviewLedgerRequestSchema,
	AddPmCommentDeliveryRequestSchema,
	ListBlockersDeliveryRequestSchema,
	MarkReviewLedgerRequestSchema,
	MoveWorkItemDeliveryRequestSchema,
	PostCommentDeliveryRequestSchema,
	PriorReviewLedgerRequestSchema,
	SubmitReviewDeliveryRequestSchema,
	TRANSPORT_PROTOCOL_VERSION,
} from '../transport/protocol.js';

/**
 * Collaborators the delivery API depends on, defaulted to the real services so
 * production wiring is a bare `registerWorkerDelivery(app)`; tests inject fakes.
 * Mirrors `WorkerTransportDeps` in `./worker-transport.ts`.
 */
export interface WorkerDeliveryDeps {
	resolveWorkerByCredential: (rawCredential: string) => Promise<Worker | undefined>;
	findProjectById: (id: string) => Promise<ProjectConfig | undefined>;
	/** Whether `workerId` may deliver to `projectId` — a routable (active + consented) enrollment. */
	isWorkerEnrolled: (workerId: string, projectId: string) => Promise<boolean>;
	/** Build the server-side SCM delivery provider for a project + persona (resolves the PAT here). */
	buildScmDelivery: (
		project: ProjectConfig,
		persona: GitHubPersona,
	) => Promise<ScmDeliveryProvider>;
	/** Build the server-side PM provider for a project (resolves the per-project PM credential here). */
	buildPmProvider: (project: ProjectConfig) => PMProvider;
	/**
	 * The review-verdict ledger, defaulted to the repository this process reaches
	 * over `DATABASE_URL`. Injected as one object so the three routes below cannot
	 * drift from the contract the Review phase programs against.
	 */
	reviewLedger: ReviewVerdictLedger;
}

/** A worker may deliver to a project only via a routable enrollment (active + sharing consent). */
async function isWorkerEnrolledDefault(workerId: string, projectId: string): Promise<boolean> {
	const enrollments = await listEnrollmentsForWorker(workerId);
	return enrollments.some(
		(enrollment) => enrollment.projectId === projectId && isRoutable(enrollment),
	);
}

function defaultDeps(): WorkerDeliveryDeps {
	return {
		resolveWorkerByCredential,
		findProjectById: findProjectByIdFromDb,
		isWorkerEnrolled: isWorkerEnrolledDefault,
		buildScmDelivery: (project, persona) =>
			new GitHubSCMIntegration().deliveryProvider(project, persona),
		buildPmProvider: createGitHubProjectsProvider,
		reviewLedger: { getPriorSubmittedReview, markReviewVerdictSubmitted, abandonReviewVerdict },
	};
}

/** A delivery outcome: the HTTP status and the JSON body to return. */
export interface DeliveryResult {
	status: 200 | 400 | 401 | 403 | 404;
	json: Record<string, unknown>;
}

/**
 * Authenticate a delivery request and resolve the project it targets — the
 * shared prelude both handlers run before touching the reviewer PAT. Returns the
 * authenticated `{ worker, project }` on success, or a {@link DeliveryResult} to
 * return verbatim on any refusal. The credential is never reflected in a body.
 */
async function authenticateDelivery(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	projectId: string,
): Promise<{ worker: Worker; project: ProjectConfig } | DeliveryResult> {
	const worker = credential ? await deps.resolveWorkerByCredential(credential) : undefined;
	if (!worker) return { status: 401, json: { authenticated: false } };

	const project = await deps.findProjectById(projectId);
	if (!project) return { status: 404, json: { reason: 'unknown project' } };

	// A valid worker credential is not enough: the worker must hold a routable
	// enrollment in *this* project, so one worker can't deliver to a project it
	// isn't enrolled in. Reuses the existing dispatch routability read model.
	if (!(await deps.isWorkerEnrolled(worker.id, project.id)))
		return { status: 403, json: { reason: 'worker is not enrolled in this project' } };

	return { worker, project };
}

/**
 * Submit a review as a pure function of its deps, the raw bearer credential, and
 * the request body: validate → authenticate → resolve the project → perform the
 * review write under the reviewer PAT. Returns the status/body for the route to
 * send; never throws for an expected failure (bad request, bad credential,
 * unknown project, not enrolled), and never reflects the credential in the body.
 */
export async function handleSubmitReview(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = SubmitReviewDeliveryRequestSchema.safeParse(body);
	if (!parsed.success) return { status: 400, json: { reason: 'invalid delivery request' } };
	const request = parsed.data;

	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION)
		return {
			status: 400,
			json: { reason: 'unsupported protocol version', protocolVersion: TRANSPORT_PROTOCOL_VERSION },
		};

	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;

	// The reviewer PAT is resolved inside this process by `buildScmDelivery` and
	// never leaves it; only the metadata below is written to GitHub.
	const delivery = await deps.buildScmDelivery(authed.project, 'reviewer');
	const reviewId = await delivery.submitReview({
		prNumber: request.prNumber,
		verdict: request.verdict,
		body: request.body,
		deliveryId: request.deliveryId,
	});
	return { status: 200, json: { reviewId } };
}

/**
 * Post a top-level PR comment as a pure function of its deps, the raw bearer
 * credential, and the request body. Same prelude and contract as
 * {@link handleSubmitReview}; the reviewer PAT is resolved server-side.
 */
export async function handlePostComment(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = PostCommentDeliveryRequestSchema.safeParse(body);
	if (!parsed.success) return { status: 400, json: { reason: 'invalid delivery request' } };
	const request = parsed.data;

	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION)
		return {
			status: 400,
			json: { reason: 'unsupported protocol version', protocolVersion: TRANSPORT_PROTOCOL_VERSION },
		};

	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;

	const delivery = await deps.buildScmDelivery(authed.project, 'reviewer');
	const commentId = await delivery.postComment({
		prNumber: request.prNumber,
		body: request.body,
		deliveryId: request.deliveryId,
	});
	return { status: 200, json: { commentId } };
}

/**
 * Move a board card to a canonical pipeline status as a pure function of its
 * deps, the raw bearer credential, and the request body. Same prelude and
 * contract as {@link handleSubmitReview}; the per-project PM credential is
 * resolved server-side by `buildPmProvider` and never leaves this process, and
 * the adapter resolves the canonical status key to its board option ID.
 */
export async function handleMoveWorkItem(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = MoveWorkItemDeliveryRequestSchema.safeParse(body);
	if (!parsed.success) return { status: 400, json: { reason: 'invalid delivery request' } };
	const request = parsed.data;

	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION)
		return {
			status: 400,
			json: { reason: 'unsupported protocol version', protocolVersion: TRANSPORT_PROTOCOL_VERSION },
		};

	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;

	const pm = deps.buildPmProvider(authed.project);
	await pm.moveWorkItem(request.itemId, request.status);
	return { status: 200, json: {} };
}

/**
 * Post a comment on a work item's backing Issue/PR as a pure function of its
 * deps, the raw bearer credential, and the request body. Same prelude and
 * contract as {@link handleMoveWorkItem}; returns the created comment's id.
 */
export async function handleAddPmComment(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = AddPmCommentDeliveryRequestSchema.safeParse(body);
	if (!parsed.success) return { status: 400, json: { reason: 'invalid delivery request' } };
	const request = parsed.data;

	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION)
		return {
			status: 400,
			json: { reason: 'unsupported protocol version', protocolVersion: TRANSPORT_PROTOCOL_VERSION },
		};

	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;

	const pm = deps.buildPmProvider(authed.project);
	const commentId = await pm.addComment(request.itemId, request.body);
	return { status: 200, json: { commentId } };
}

/**
 * Read a work item's blockers — the one PM **read** the delivery API serves, so a
 * federated worker's Implementation run still gates on unfinished prerequisites
 * (issue #330) instead of skipping the check it has no credential for. Same
 * prelude and contract as {@link handleMoveWorkItem}; the PM credential is
 * resolved server-side, and the blockers come back in the provider-neutral shape
 * `PMProvider.listBlockers` defines.
 */
export async function handleListBlockers(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = ListBlockersDeliveryRequestSchema.safeParse(body);
	if (!parsed.success) return { status: 400, json: { reason: 'invalid delivery request' } };
	const request = parsed.data;

	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION)
		return {
			status: 400,
			json: { reason: 'unsupported protocol version', protocolVersion: TRANSPORT_PROTOCOL_VERSION },
		};

	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;

	const pm = deps.buildPmProvider(authed.project);
	// `[]` for a provider that models no dependencies is the interface's own
	// contract (`../pm/types.ts`), so no capability branch is needed here.
	const blockers = await pm.listBlockers(request.itemId);
	return { status: 200, json: { blockers } };
}

/**
 * Read the PR's prior submitted verdict from the ledger — the re-review signal
 * (issue #328) a DB-free worker cannot look up itself. Same prelude and contract
 * as {@link handleSubmitReview}; the ledger key's project and repository come from
 * the authenticated project, never from the request body. Returns
 * `{ record: null }` when the PR has no earlier submitted verdict.
 */
export async function handlePriorReview(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = PriorReviewLedgerRequestSchema.safeParse(body);
	if (!parsed.success) return { status: 400, json: { reason: 'invalid delivery request' } };
	const request = parsed.data;

	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION)
		return {
			status: 400,
			json: { reason: 'unsupported protocol version', protocolVersion: TRANSPORT_PROTOCOL_VERSION },
		};

	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;

	const record = await deps.reviewLedger.getPriorSubmittedReview(
		authed.project.id,
		authed.project.repo,
		request.prNumber,
		request.currentHeadSha,
	);
	return { status: 200, json: { record: record ?? null } };
}

/**
 * Mark this PR/head's reserved ledger slot `submitted` and return it, so the
 * worker's Review run learns its ordinal — the two-verdict cap signal (issue
 * #235). Same prelude and contract as {@link handlePriorReview}; `{ slot: null }`
 * when no record exists for this PR/head.
 */
export async function handleMarkReviewVerdict(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = MarkReviewLedgerRequestSchema.safeParse(body);
	if (!parsed.success) return { status: 400, json: { reason: 'invalid delivery request' } };
	const request = parsed.data;

	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION)
		return {
			status: 400,
			json: { reason: 'unsupported protocol version', protocolVersion: TRANSPORT_PROTOCOL_VERSION },
		};

	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;

	const slot = await deps.reviewLedger.markReviewVerdictSubmitted(
		{
			projectId: authed.project.id,
			repository: authed.project.repo,
			prNumber: request.prNumber,
			headSha: request.headSha,
		},
		{ verdict: request.verdict, reviewId: request.reviewId },
	);
	return { status: 200, json: { slot: slot ?? null } };
}

/**
 * Release this PR/head's still-pending ledger slot after a Review run that
 * certainly submitted nothing. Same prelude and contract as
 * {@link handlePriorReview}; idempotent, and a no-op on an already-submitted slot.
 */
export async function handleAbandonReviewVerdict(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = AbandonReviewLedgerRequestSchema.safeParse(body);
	if (!parsed.success) return { status: 400, json: { reason: 'invalid delivery request' } };
	const request = parsed.data;

	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION)
		return {
			status: 400,
			json: { reason: 'unsupported protocol version', protocolVersion: TRANSPORT_PROTOCOL_VERSION },
		};

	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;

	await deps.reviewLedger.abandonReviewVerdict({
		projectId: authed.project.id,
		repository: authed.project.repo,
		prNumber: request.prNumber,
		headSha: request.headSha,
	});
	return { status: 200, json: {} };
}

/** Extract the raw credential from an `Authorization: Bearer <credential>` header. */
function extractBearerCredential(authorization: string | undefined): string | undefined {
	if (!authorization) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
	return match ? match[1] : undefined;
}

/**
 * Wire the delivery routes onto the router's Hono `app`, next to
 * `registerWorkerTransport`. Pass `overrides` to substitute collaborators in
 * tests; omit for production wiring.
 */
export function registerWorkerDelivery(
	app: Hono,
	overrides: Partial<WorkerDeliveryDeps> = {},
): void {
	const deps = { ...defaultDeps(), ...overrides };

	const parseBody = async (c: Context): Promise<unknown> => {
		try {
			return await c.req.json();
		} catch {
			return undefined;
		}
	};

	app.post('/worker/delivery/review', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleSubmitReview(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/pr-comment', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handlePostComment(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/pm/move', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleMoveWorkItem(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/pm/comment', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleAddPmComment(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/pm/blockers', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleListBlockers(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/review-ledger/prior', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handlePriorReview(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/review-ledger/mark', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleMarkReviewVerdict(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/review-ledger/abandon', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleAbandonReviewVerdict(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});
}
