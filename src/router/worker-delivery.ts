/**
 * Server-side delivery API for the operations a federated worker cannot perform
 * itself — the metadata GitHub writes whose credential stays on the server
 * (ADR-004 §2), plus the review-verdict ledger reads/writes whose *database*
 * stays on the server (ADR-003 §2).
 *
 * The two metadata-only SCM
 * delivery calls — submit a review, post a PR comment — run *here*, on the
 * router, under the persona credential the server already resolves
 * (`getPersonaToken`), instead of on a federated worker holding that token. The
 * review route always writes as the **per-project reviewer PAT**; the PR-comment
 * route writes as the persona its request names — the reviewer for a Review's
 * comment, the implementer for a Respond-to-review reply — defaulting to the
 * reviewer when a client sends none (issue #444). A worker sends only the verdict
 * + comment body + PR number (+ that persona) up the transport
 * (`../scm/transport-delivery.ts`); this module performs the GitHub write and
 * returns the created review/comment id. The persona credential is resolved
 * *inside* this process and never leaves it, and only metadata crosses the wire —
 * the repository tree never does (the local-first boundary, ai/RULES.md §1).
 *
 * The review still lands on the PR as a genuine GitHub review, so the existing
 * `pull_request_review`-driven respond-to-review trigger (PROJECT.md §5.4) keeps
 * working unchanged.
 *
 * The independent Phase 2/2 half does the same for the two metadata-only **PM**
 * board writes — move a card, comment on the backing Issue/PR — under the
 * **per-project PM credential** the server resolves via
 * `requireProjectPMProvider(project)`; the worker sends only the canonical
 * status key / comment body up the transport (`../pm/transport-delivery.ts`).
 * The PM credential is resolved *inside* this process and never leaves it, and
 * the status crossing the wire is a canonical `PmStatusKey`, never a board
 * option ID (ai/RULES.md §2) — the adapter resolves it server-side.
 *
 * The last three routes front the **review-verdict ledger** — the `review_verdicts`
 * table (`../db/repositories/reviewVerdictsRepository.ts`) a Review run consults
 * for the review-verdict safety cap (issue #235) and the prior-submitted-verdict
 * re-review signal (issue #328). A DB-free remote worker holds no `DATABASE_URL`,
 * so those three calls run here instead (`../transport/review-ledger-delivery.ts`
 * is the client). No credential is involved: what stays server-side is the
 * database. The worker sends only PR coordinates, and the ledger key's
 * `projectId`/`repository` are taken from the **authenticated** project — never
 * from the request — so a worker cannot key a row to a project or repository it
 * isn't enrolled in.
 *
 * The last route fronts neither a credential nor a table but the **dispatch store
 * and queue**: a `fixed` Respond-to-review response owes its newly pushed commit
 * exactly one follow-up Review (issue #241), which the default scheduler
 * (`../pipeline/follow-up-review.ts`) delivers by writing a dispatch row and
 * enqueueing a synthetic event. A DB-free worker can do neither, so it POSTs the
 * PR coordinates and this route performs that same enqueue — for the
 * **authenticated** project, never one named in the request.
 *
 * The five `pm/{find-comment,create-item,update-item,label,blocked-by}` routes are
 * the **Planning** phase's board surface (issue #536) — the split that creates
 * sibling cards, chains them as dependencies, marks an item `planned`, and finds
 * its own plan comment to stay idempotent on a retry. They front the same
 * per-project PM credential as the two writes above and are authorized identically;
 * what they add is width, which is what had kept Planning off a DB-free worker.
 * Planning is the only phase that *creates* board structure, so two properties
 * matter more here than for the narrower routes: the project is the authenticated
 * enrollment's (a worker cannot create a card on a board it isn't enrolled in), and
 * each write is idempotent at the provider, so a replayed request cannot fork the
 * board.
 *
 * Seventeen routes, all under `/worker/delivery`:
 *   - `POST /worker/delivery/review` — submit a review (verdict + body).
 *   - `POST /worker/delivery/pr-comment` — post a top-level PR comment.
 *   - `POST /worker/delivery/pm/move` — move a board card to a canonical status.
 *   - `POST /worker/delivery/pm/comment` — comment on the item's backing Issue/PR.
 *   - `POST /worker/delivery/pm/blockers` — read the item's open prerequisites.
 *   - `POST /worker/delivery/pm/find-item` — resolve one card by its backing URL's tail.
 *   - `POST /worker/delivery/pm/find-artifact` — resolve one card by a repository-scoped artifact.
 *   - `POST /worker/delivery/pm/find-item-by-marker` — resolve one card by a marker in its description.
 *   - `POST /worker/delivery/pm/find-comment` — find one comment by its idempotency marker.
 *   - `POST /worker/delivery/pm/create-item` — create one card (Planning's split children).
 *   - `POST /worker/delivery/pm/update-item` — patch a card's title/description.
 *   - `POST /worker/delivery/pm/label` — apply one label by name.
 *   - `POST /worker/delivery/pm/blocked-by` — record a blocked-by dependency edge.
 *   - `POST /worker/delivery/follow-up-review` — schedule the follow-up Review a fix owes.
 *   - `POST /worker/delivery/review-ledger/prior` — the PR's prior submitted verdict.
 *   - `POST /worker/delivery/review-ledger/mark` — mark this PR/head's slot submitted.
 *   - `POST /worker/delivery/review-ledger/abandon` — release a pending slot.
 *
 * Mirrors `./worker-transport.ts`: the request logic is factored out of the HTTP
 * glue into pure, injectable functions (`handleSubmitReview`,
 * `handlePostComment`, `handleMoveWorkItem`, `handleAddPmComment`,
 * `handleListBlockers`, `handleFindWorkItem`, `handleFindWorkItemByMarker`,
 * `handleFindWorkItemForArtifact`, `handleFindPmComment`, `handleCreateWorkItem`, `handleUpdateWorkItem`,
 * `handleAddPmLabel`, `handleAddBlockedBy`, `handleScheduleFollowUpReview`,
 * `handlePriorReview`, `handleMarkReviewVerdict`, `handleAbandonReviewVerdict`) so
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
// Side-effect import: registers every PM and SCM provider manifest into its
// registry before defaultDeps() resolves the project's SCM provider below. This
// module reads the registry at request time, so it must not rely on a sibling
// module having loaded the entrypoint first (matching `./webhook-receiver.ts`).
import '../integrations/entrypoint.js';
import { requireProjectPMProvider } from '../integrations/pm/index.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { logger } from '../lib/logger.js';
import {
	type ScheduleFollowUpReview,
	scheduleFollowUpReviewDefault,
} from '../pipeline/follow-up-review.js';
import type { ReviewVerdictLedger } from '../pipeline/review-ledger.js';
import type { PMProvider, WorkItem } from '../pm/types.js';
import type { ScmDeliveryProvider } from '../scm/delivery.js';
import type { ScmPersona } from '../scm/types.js';
import {
	AbandonReviewLedgerRequestSchema,
	AddBlockedByDeliveryRequestSchema,
	AddPmCommentDeliveryRequestSchema,
	AddPmLabelDeliveryRequestSchema,
	CreateWorkItemDeliveryRequestSchema,
	FindPmCommentDeliveryRequestSchema,
	FindWorkItemByMarkerDeliveryRequestSchema,
	FindWorkItemDeliveryRequestSchema,
	FindWorkItemForArtifactDeliveryRequestSchema,
	FollowUpReviewDeliveryRequestSchema,
	type FoundWorkItem,
	ListBlockersDeliveryRequestSchema,
	MarkReviewLedgerRequestSchema,
	MoveWorkItemDeliveryRequestSchema,
	PostCommentDeliveryRequestSchema,
	PriorReviewLedgerRequestSchema,
	SubmitReviewDeliveryRequestSchema,
	TRANSPORT_PROTOCOL_VERSION,
	UpdateWorkItemDeliveryRequestSchema,
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
	buildScmDelivery: (project: ProjectConfig, persona: ScmPersona) => Promise<ScmDeliveryProvider>;
	/** Build the server-side PM provider for a project (resolves the per-project PM credential here). */
	buildPmProvider: (project: ProjectConfig) => PMProvider;
	/**
	 * The review-verdict ledger, defaulted to the repository this process reaches
	 * over `DATABASE_URL`. Injected as one object so the three routes below cannot
	 * drift from the contract the Review phase programs against.
	 */
	reviewLedger: ReviewVerdictLedger;
	/**
	 * Schedule the follow-up Review a pushed fix owes (issue #241), defaulted to
	 * the same dispatch+queue enqueue the local host worker runs in-process — the
	 * exact operation a DB-free worker cannot perform itself.
	 */
	scheduleFollowUpReview: ScheduleFollowUpReview;
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
			requireProjectSCMProvider(project).deliveryProvider(project, persona),
		buildPmProvider: requireProjectPMProvider,
		reviewLedger: { getPriorSubmittedReview, markReviewVerdictSubmitted, abandonReviewVerdict },
		scheduleFollowUpReview: scheduleFollowUpReviewDefault,
	};
}

/**
 * A delivery outcome: the HTTP status and the JSON body to return.
 *
 * `503` is the one server-fault member: a persona credential this host cannot
 * resolve ({@link resolvePersonaDelivery}). It is answered rather than thrown so
 * the worker learns *why* its write failed — an escaped throw becomes the app-level
 * `internal error` 500, whose body carries no reason at all.
 */
export interface DeliveryResult {
	status: 200 | 400 | 401 | 403 | 404 | 503;
	json: Record<string, unknown>;
}

/**
 * Resolve the SCM delivery provider for one persona, converting a credential this
 * host cannot resolve into an answerable `503` instead of an escaped throw.
 *
 * Both SCM routes need this because the credential is only discovered at call
 * time and its absence is ordinary misconfiguration, not a bug: the reviewer PAT
 * is a per-project secret that may be missing, and `implementer` resolves to this
 * host's `SWARM_OPERATOR_GH_TOKEN`, which the router did not need for
 * `/pr-comment` before issue #444 and which ships commented out in
 * `.env.docker.example`. Without this, the phase's only symptom is
 * `… failed with status 500` in the worker's log, with the actionable cause
 * visible solely in the router's own logs — for a Respond-to-review that has
 * already pushed its fix and now gets neither a reply nor a re-review.
 *
 * The caught error is logged server-side and never returned: it can name the
 * credential the module is contracted not to reflect.
 */
async function resolvePersonaDelivery(
	deps: WorkerDeliveryDeps,
	project: ProjectConfig,
	persona: ScmPersona,
	route: string,
): Promise<ScmDeliveryProvider | DeliveryResult> {
	try {
		return await deps.buildScmDelivery(project, persona);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const isIdentityUnresolved = message.toLowerCase().includes('identity');

		if (isIdentityUnresolved) {
			logger.error('worker-delivery: persona identity unresolved', {
				route,
				projectId: project.id,
				persona,
				error: message,
			});
			return { status: 503, json: { reason: 'persona identity unresolved', persona } };
		}

		logger.error('worker-delivery: persona credential unavailable', {
			route,
			projectId: project.id,
			persona,
			error: message,
		});
		return { status: 503, json: { reason: 'persona credential unavailable', persona } };
	}
}

/**
 * Authenticate a delivery request and resolve the project it targets — the
 * shared prelude both handlers run before touching a persona credential. Returns the
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
 * unknown project, not enrolled, or a persona credential this host cannot
 * resolve), and never reflects the credential in the body.
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

	// The wire schema still accepts `comment` so that an older worker gets this
	// legible reason rather than a schema-level "invalid delivery request", and so
	// that removing the verdict needed no `TRANSPORT_PROTOCOL_VERSION` bump (which
	// would reject every frame from that worker, not just this one). SWARM stopped
	// producing the verdict in issue #470: it clears no review gate and dispatches
	// no follow-up, so submitting it strands the PR.
	if (request.verdict === 'comment')
		return {
			status: 400,
			json: {
				reason: 'the comment verdict was removed (issue #470) — upgrade the worker',
			},
		};

	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;

	// The reviewer PAT is resolved inside this process by `buildScmDelivery` and
	// never leaves it; only the metadata below is written to GitHub.
	const delivery = await resolvePersonaDelivery(
		deps,
		authed.project,
		'reviewer',
		'/worker/delivery/review',
	);
	if ('status' in delivery) return delivery;
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
 * {@link handleSubmitReview}; the persona's credential is resolved server-side.
 *
 * The author persona comes from the **request**, not from this handler: a Review
 * comments as the reviewer, while a Respond-to-review reply is the implementer
 * answering that review, and inferring `reviewer` here had the reviewer answering
 * itself (issue #444). The schema defaults the field to `reviewer`, so a client
 * that sends no persona behaves exactly as before. `implementer` resolves through
 * the same `getPersonaToken` seam to this host's `SWARM_OPERATOR_GH_TOKEN` — which
 * the router already holds for loop prevention — and, like the reviewer PAT, that
 * credential is resolved inside this process and never leaves it. A host that
 * cannot resolve it answers `503` with a reason rather than throwing
 * ({@link resolvePersonaDelivery}).
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

	const delivery = await resolvePersonaDelivery(
		deps,
		authed.project,
		request.persona,
		'/worker/delivery/pr-comment',
	);
	if ('status' in delivery) return delivery;
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
 * Resolve one board card by the tail of its backing Issue/PR URL — the second PM
 * **read** the delivery API serves, so a federated worker's Respond-to-review run
 * can still report In progress / In review on the board it holds no credential
 * for. Same prelude and contract as {@link handleMoveWorkItem}; the match runs
 * inside the provider (`PMProvider.findWorkItemByUrlSuffix`), so nothing here
 * pattern-matches a provider-specific URL shape (ai/RULES.md §2), and
 * `item: null` is the ordinary "no card wraps that URL" answer rather than a 404.
 */
export async function handleFindWorkItem(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = FindWorkItemDeliveryRequestSchema.safeParse(body);
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
	const item = await pm.findWorkItemByUrlSuffix(request.urlSuffix);
	return { status: 200, json: { item: item ? projectFoundWorkItem(item) : null } };
}

/**
 * Narrow a `WorkItem` onto the wire frame the three card-returning routes share
 * (`FoundWorkItemSchema`): identity, title, URL, and the status pair when the
 * provider resolved one. Description, labels, and assignees are dropped rather
 * than sent — a worker needs none of them to address a card, and assignees must
 * not cross the wire at all (ai/RULES.md §2). Factored out so a field can't be
 * added to one route's projection and missed by the others.
 */
function projectFoundWorkItem(item: WorkItem): FoundWorkItem {
	return {
		id: item.id,
		title: item.title,
		url: item.url,
		...(item.status !== undefined && { status: item.status }),
		...(item.statusId !== undefined && { statusId: item.statusId }),
	};
}

/**
 * Resolve one board card by a marker in its description — the read that makes
 * Planning's split **resumable** instead of duplicating a child it already created
 * (issue #543; `applySplit`, `../pipeline/planning.ts`). Same prelude, contract, and
 * narrow card projection as {@link handleFindWorkItem}: the match runs inside the
 * provider, so nothing here knows how a provider stores a description, and
 * `item: null` is the ordinary "no card carries that marker" answer the caller acts
 * on by creating one.
 */
export async function handleFindWorkItemByMarker(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = FindWorkItemByMarkerDeliveryRequestSchema.safeParse(body);
	if (!parsed.success) return { status: 400, json: { reason: 'invalid delivery request' } };
	const request = parsed.data;
	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION)
		return {
			status: 400,
			json: { reason: 'unsupported protocol version', protocolVersion: TRANSPORT_PROTOCOL_VERSION },
		};
	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;
	const item = await deps
		.buildPmProvider(authed.project)
		.findWorkItemByDescriptionMarker(request.marker);
	return { status: 200, json: { item: item ? projectFoundWorkItem(item) : null } };
}

/** Resolve one board card by its repository-scoped backing artifact. */
export async function handleFindWorkItemForArtifact(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = FindWorkItemForArtifactDeliveryRequestSchema.safeParse(body);
	if (!parsed.success) return { status: 400, json: { reason: 'invalid delivery request' } };
	const request = parsed.data;
	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION)
		return {
			status: 400,
			json: { reason: 'unsupported protocol version', protocolVersion: TRANSPORT_PROTOCOL_VERSION },
		};
	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;
	const item = await deps.buildPmProvider(authed.project).findWorkItemForArtifact({
		repository: request.repository,
		kind: request.kind,
		number: request.number,
	});
	return { status: 200, json: { item: item ? projectFoundWorkItem(item) : null } };
}

/**
 * Find one comment on a work item's backing Issue/PR by its idempotency marker —
 * the read that makes a **replayed Planning delivery** a no-op instead of a second
 * plan comment and a duplicated split (`planDeliveryMarker`,
 * `../pipeline/planning.ts`). Same prelude and contract as
 * {@link handleMoveWorkItem}; `commentId: null` is the ordinary "this delivery has
 * not posted yet" answer rather than a 404, because that is exactly how the caller
 * reads it — it posts.
 *
 * Only the comment's *id* comes back, never its body: the caller asks whether its
 * own marker is present, and returning the text would put a board comment on the
 * wire for no reader.
 */
export async function handleFindPmComment(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = FindPmCommentDeliveryRequestSchema.safeParse(body);
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
	const commentId = await pm.findComment(request.itemId, request.marker);
	return { status: 200, json: { commentId: commentId ?? null } };
}

/**
 * Create one board card — the sibling task Planning's split spawns (`createWorkItem`).
 * Same prelude and contract as {@link handleMoveWorkItem}, and the authorization
 * matters most here of all the PM routes: the board written to is the
 * **authenticated** enrollment's project, so a worker credential cannot mint cards
 * on a board it isn't enrolled in even if its request names one.
 *
 * The canonical status key and the label *names* cross the wire; resolving them to
 * a board option id and to provider label objects stays inside the adapter
 * (ai/RULES.md §2). The created card comes back on the same narrow frame the
 * lookups use, which is all Planning reads off a fresh sibling.
 */
export async function handleCreateWorkItem(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = CreateWorkItemDeliveryRequestSchema.safeParse(body);
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
	const item = await pm.createWorkItem({
		title: request.title,
		description: request.description,
		status: request.status,
		...(request.labels !== undefined && { labels: request.labels }),
	});
	return { status: 200, json: { item: projectFoundWorkItem(item) } };
}

/**
 * Patch a card's mutable title/description — how Planning re-scopes the original
 * item into the smaller first task, and how it embeds a split child's preplan
 * marker in the child's body. Same prelude and contract as
 * {@link handleMoveWorkItem}; the two fields are forwarded only when the request
 * carries them, so an omitted field stays unchanged rather than being written as
 * `undefined`.
 */
export async function handleUpdateWorkItem(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = UpdateWorkItemDeliveryRequestSchema.safeParse(body);
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
	await pm.updateWorkItem(request.itemId, {
		...(request.title !== undefined && { title: request.title }),
		...(request.description !== undefined && { description: request.description }),
	});
	return { status: 200, json: {} };
}

/**
 * Apply one label by name to a card's backing artifact — the `planned` completion
 * marker (issue #384) and the automation label a split child needs to be dispatchable
 * (issue #131). Same prelude and contract as {@link handleMoveWorkItem}; the
 * provider both creates a missing label and makes a repeat a no-op, so a retried
 * request is harmless.
 */
export async function handleAddPmLabel(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = AddPmLabelDeliveryRequestSchema.safeParse(body);
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
	await pm.addLabel(request.itemId, request.name);
	return { status: 200, json: {} };
}

/**
 * Record one blocked-by dependency edge — how a split chains its phases so a later
 * phase cannot start before its predecessors land (issue #330). Same prelude and
 * contract as {@link handleMoveWorkItem}. No capability branch is needed: the
 * interface's own contract makes this a no-op on a provider that models no
 * dependencies (`../pm/types.ts`), exactly as `listBlockers` returns `[]` there.
 */
export async function handleAddBlockedBy(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = AddBlockedByDeliveryRequestSchema.safeParse(body);
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
	await pm.addBlockedBy(request.itemId, request.blockerId);
	return { status: 200, json: {} };
}

/**
 * Schedule the one follow-up Review a `fixed` Respond-to-review response owes its
 * newly pushed commit (issue #241) — the dispatch row + queue enqueue a DB-free
 * worker cannot perform. Same prelude and contract as {@link handleMoveWorkItem};
 * the project comes from the **authenticated** enrollment, never from the request,
 * so a worker cannot schedule a dispatch into a project it isn't enrolled in. The
 * scheduler's deterministic dispatch identity absorbs a retried call, so this
 * route is safe to re-send.
 */
export async function handleScheduleFollowUpReview(
	deps: WorkerDeliveryDeps,
	credential: string | undefined,
	body: unknown,
): Promise<DeliveryResult> {
	const parsed = FollowUpReviewDeliveryRequestSchema.safeParse(body);
	if (!parsed.success) return { status: 400, json: { reason: 'invalid delivery request' } };
	const request = parsed.data;

	if (request.protocolVersion !== TRANSPORT_PROTOCOL_VERSION)
		return {
			status: 400,
			json: { reason: 'unsupported protocol version', protocolVersion: TRANSPORT_PROTOCOL_VERSION },
		};

	const authed = await authenticateDelivery(deps, credential, request.projectId);
	if ('status' in authed) return authed;

	await deps.scheduleFollowUpReview({
		project: authed.project,
		prNumber: request.prNumber,
		prBranch: request.prBranch,
		headSha: request.headSha,
	});
	return { status: 200, json: {} };
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
 * worker's Review run learns its ordinal — the verdict-cap signal (issue
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

	app.post('/worker/delivery/pm/find-item', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleFindWorkItem(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/pm/find-item-by-marker', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleFindWorkItemByMarker(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/pm/find-artifact', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleFindWorkItemForArtifact(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/pm/find-comment', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleFindPmComment(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/pm/create-item', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleCreateWorkItem(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/pm/update-item', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleUpdateWorkItem(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/pm/label', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleAddPmLabel(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/pm/blocked-by', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleAddBlockedBy(deps, credential, await parseBody(c));
		return c.json(result.json, result.status);
	});

	app.post('/worker/delivery/follow-up-review', async (c) => {
		const credential = extractBearerCredential(c.req.header('authorization'));
		const result = await handleScheduleFollowUpReview(deps, credential, await parseBody(c));
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
