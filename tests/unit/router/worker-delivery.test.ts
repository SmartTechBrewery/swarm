import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';
import type { ReviewVerdictLedger } from '@/pipeline/review-ledger.js';
import type { PMProvider } from '@/pm/types.js';
import {
	handleAbandonReviewVerdict,
	handleAddBlockedBy,
	handleAddPmComment,
	handleAddPmLabel,
	handleCreateWorkItem,
	handleFindPmComment,
	handleFindWorkItem,
	handleFindWorkItemByMarker,
	handleFindWorkItemForArtifact,
	handleListBlockers,
	handleMarkReviewVerdict,
	handleMoveWorkItem,
	handlePostComment,
	handlePriorReview,
	handleScheduleFollowUpReview,
	handleSubmitReview,
	handleUpdateWorkItem,
	type WorkerDeliveryDeps,
} from '@/router/worker-delivery.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';
import { createMockProjectConfig, createMockWorkItem } from '../../helpers/factories.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const CREDENTIAL = 'raw-worker-credential-secret';
const RESOLVED_PAT = 'ghp-reviewer-pat-should-never-leak';
/** A GitHub board Status option ID — must never be what crosses the wire (RULES.md §2). */
const BOARD_OPTION_ID = '47fc9ee4';

function makeWorker(overrides: Partial<Worker> = {}): Worker {
	return {
		id: WORKER_ID,
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude'],
		supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

/** A delivery provider whose metadata ops record their input and return fixed ids. */
function makeDelivery(overrides: Partial<ScmDeliveryProvider> = {}): ScmDeliveryProvider {
	return {
		commitIdentity: { name: 'reviewer', email: 'reviewer@users.noreply.github.com' },
		findPullRequest: vi.fn(),
		createPullRequest: vi.fn(),
		pushBranch: vi.fn(),
		submitReview: vi.fn().mockResolvedValue(77),
		postComment: vi.fn().mockResolvedValue(88),
		...overrides,
	};
}

/** A PM provider whose write ops record their input and return a fixed comment id. */
function makePmProvider(overrides: Partial<PMProvider> = {}): PMProvider {
	return {
		type: 'github-projects',
		supportsAssignees: true,
		supportsDependencies: true,
		getWorkItem: vi.fn(),
		listWorkItems: vi.fn(),
		findWorkItemByUrlSuffix: vi.fn().mockResolvedValue(undefined),
		findWorkItemForArtifact: vi.fn().mockResolvedValue(undefined),
		findWorkItemByDescriptionMarker: vi.fn().mockResolvedValue(undefined),
		moveWorkItem: vi.fn().mockResolvedValue(undefined),
		addComment: vi.fn().mockResolvedValue('IC_kwComment'),
		findComment: vi.fn(),
		createWorkItem: vi.fn(),
		updateWorkItem: vi.fn(),
		addLabel: vi.fn(),
		listBlockers: vi.fn(),
		addBlockedBy: vi.fn(),
		...overrides,
	};
}

/** A review-verdict ledger whose ops record their input and return fixed slots. */
function makeReviewLedger(overrides: Partial<ReviewVerdictLedger> = {}): ReviewVerdictLedger {
	return {
		getPriorSubmittedReview: vi.fn().mockResolvedValue(undefined),
		markReviewVerdictSubmitted: vi.fn().mockResolvedValue({ id: 'verdict-1', ordinal: 1 }),
		abandonReviewVerdict: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function makeDeps(overrides: Partial<WorkerDeliveryDeps> = {}): WorkerDeliveryDeps {
	const project = createMockProjectConfig();
	return {
		resolveWorkerByCredential: vi.fn().mockResolvedValue(makeWorker()),
		findProjectById: vi.fn(
			async (id: string): Promise<ProjectConfig | undefined> =>
				id === project.id ? project : undefined,
		),
		isWorkerEnrolled: vi.fn().mockResolvedValue(true),
		buildScmDelivery: vi.fn().mockResolvedValue(makeDelivery()),
		buildPmProvider: vi.fn(() => makePmProvider()),
		reviewLedger: makeReviewLedger(),
		scheduleFollowUpReview: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

function reviewBody(overrides: Record<string, unknown> = {}) {
	return {
		projectId: 'swarm',
		prNumber: 42,
		verdict: 'approve',
		body: 'Looks good',
		deliveryId: 'delivery-1',
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		...overrides,
	};
}

function commentBody(overrides: Record<string, unknown> = {}) {
	return {
		projectId: 'swarm',
		prNumber: 42,
		body: 'Addressed the review',
		deliveryId: 'delivery-2',
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		...overrides,
	};
}

function moveBody(overrides: Record<string, unknown> = {}) {
	return {
		projectId: 'swarm',
		itemId: 'PVTI_item1',
		status: 'inReview',
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		...overrides,
	};
}

function pmCommentBody(overrides: Record<string, unknown> = {}) {
	return {
		projectId: 'swarm',
		itemId: 'PVTI_item1',
		body: 'Plan posted',
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		...overrides,
	};
}

describe('handleSubmitReview', () => {
	beforeEach(() => vi.clearAllMocks());

	// The wire schema still accepts `comment` so an older worker's frame isn't
	// rejected wholesale, but SWARM stopped producing the verdict (issue #470): it
	// clears no review gate and dispatches no follow-up, so submitting one strands
	// the PR. The rejection is explicit here rather than schema-level so the worker
	// gets a legible reason.
	it('rejects the removed comment verdict with a legible reason, before authenticating', async () => {
		const submitReview = vi.fn();
		const buildScmDelivery = vi.fn().mockResolvedValue(makeDelivery({ submitReview }));
		const deps = makeDeps({ buildScmDelivery });

		const result = await handleSubmitReview(deps, CREDENTIAL, reviewBody({ verdict: 'comment' }));

		expect(result.status).toBe(400);
		expect(result.json).toEqual({
			reason: 'the comment verdict was removed (issue #470) — upgrade the worker',
		});
		expect(submitReview).not.toHaveBeenCalled();
		expect(buildScmDelivery).not.toHaveBeenCalled();
	});

	it('submits the review under the reviewer persona and returns the id', async () => {
		const submitReview = vi.fn().mockResolvedValue(77);
		const buildScmDelivery = vi.fn().mockResolvedValue(makeDelivery({ submitReview }));
		const deps = makeDeps({ buildScmDelivery });

		const result = await handleSubmitReview(deps, CREDENTIAL, reviewBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({ reviewId: 77 });
		expect(buildScmDelivery).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'swarm' }),
			'reviewer',
		);
		expect(submitReview).toHaveBeenCalledWith({
			prNumber: 42,
			verdict: 'approve',
			body: 'Looks good',
			deliveryId: 'delivery-1',
		});
	});

	it('rejects an unknown credential with 401 and never echoes the credential or PAT', async () => {
		const deps = makeDeps({ resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined) });

		const result = await handleSubmitReview(deps, 'bogus', reviewBody());

		expect(result.status).toBe(401);
		expect(result.json).toEqual({ authenticated: false });
		const serialized = JSON.stringify(result.json);
		expect(serialized).not.toContain('bogus');
		expect(serialized).not.toContain(RESOLVED_PAT);
		expect(deps.buildScmDelivery).not.toHaveBeenCalled();
	});

	it('rejects an absent credential with 401 without resolving a worker', async () => {
		const deps = makeDeps();
		const result = await handleSubmitReview(deps, undefined, reviewBody());
		expect(result.status).toBe(401);
		expect(deps.resolveWorkerByCredential).not.toHaveBeenCalled();
	});

	it('returns 404 for an unknown project', async () => {
		const deps = makeDeps();
		const result = await handleSubmitReview(deps, CREDENTIAL, reviewBody({ projectId: 'nope' }));
		expect(result.status).toBe(404);
		expect(deps.buildScmDelivery).not.toHaveBeenCalled();
	});

	it('returns 403 when the worker is not enrolled in the project', async () => {
		const deps = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		const result = await handleSubmitReview(deps, CREDENTIAL, reviewBody());
		expect(result.status).toBe(403);
		expect(deps.buildScmDelivery).not.toHaveBeenCalled();
	});

	it('returns 400 for a malformed body', async () => {
		const deps = makeDeps();
		const result = await handleSubmitReview(deps, CREDENTIAL, reviewBody({ verdict: 'lgtm' }));
		expect(result.status).toBe(400);
		expect(deps.resolveWorkerByCredential).not.toHaveBeenCalled();
	});

	it('returns 400 for a protocol-version mismatch', async () => {
		const deps = makeDeps();
		const result = await handleSubmitReview(
			deps,
			CREDENTIAL,
			reviewBody({ protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1 }),
		);
		expect(result.status).toBe(400);
		expect(result.json).toMatchObject({ protocolVersion: TRANSPORT_PROTOCOL_VERSION });
		expect(deps.resolveWorkerByCredential).not.toHaveBeenCalled();
	});

	it('answers 503 with persona credential unavailable when the reviewer PAT is missing', async () => {
		const deps = makeDeps({
			buildScmDelivery: vi
				.fn()
				.mockRejectedValue(new Error(`No reviewer credential configured: ${RESOLVED_PAT}`)),
		});

		const result = await handleSubmitReview(deps, CREDENTIAL, reviewBody());

		expect(result.status).toBe(503);
		expect(result.json).toEqual({ reason: 'persona credential unavailable', persona: 'reviewer' });
		expect(JSON.stringify(result.json)).not.toContain(RESOLVED_PAT);
	});

	it('answers 503 with persona identity unresolved when buildScmDelivery fails with a non-credential error', async () => {
		const deps = makeDeps({
			buildScmDelivery: vi
				.fn()
				.mockRejectedValue(
					new Error(`Could not resolve GitHub identity for reviewer persona: ${RESOLVED_PAT}`),
				),
		});

		const result = await handleSubmitReview(deps, CREDENTIAL, reviewBody());

		expect(result.status).toBe(503);
		expect(result.json).toEqual({ reason: 'persona identity unresolved', persona: 'reviewer' });
		expect(JSON.stringify(result.json)).not.toContain(RESOLVED_PAT);
	});
});

describe('handlePostComment', () => {
	beforeEach(() => vi.clearAllMocks());

	it('posts the comment and returns the id', async () => {
		const postComment = vi.fn().mockResolvedValue(88);
		const deps = makeDeps({
			buildScmDelivery: vi.fn().mockResolvedValue(makeDelivery({ postComment })),
		});

		const result = await handlePostComment(deps, CREDENTIAL, commentBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({ commentId: 88 });
		expect(postComment).toHaveBeenCalledWith({
			prNumber: 42,
			body: 'Addressed the review',
			deliveryId: 'delivery-2',
		});
	});

	it('posts under the persona the request names, so a review reply is authored by the implementer', async () => {
		const postComment = vi.fn().mockResolvedValue(88);
		const buildScmDelivery = vi.fn().mockResolvedValue(makeDelivery({ postComment }));
		const deps = makeDeps({ buildScmDelivery });

		const result = await handlePostComment(
			deps,
			CREDENTIAL,
			commentBody({ persona: 'implementer' }),
		);

		expect(result.status).toBe(200);
		expect(buildScmDelivery).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'swarm' }),
			'implementer',
		);
		expect(postComment).toHaveBeenCalledTimes(1);
	});

	it('falls back to the reviewer persona for a client that sends none', async () => {
		const buildScmDelivery = vi.fn().mockResolvedValue(makeDelivery());
		const deps = makeDeps({ buildScmDelivery });

		expect((await handlePostComment(deps, CREDENTIAL, commentBody())).status).toBe(200);
		expect(buildScmDelivery).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'swarm' }),
			'reviewer',
		);
	});

	it('enforces auth and enrollment before touching the PAT', async () => {
		const unknown = makeDeps({ resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined) });
		expect((await handlePostComment(unknown, 'bogus', commentBody())).status).toBe(401);

		const unenrolled = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		expect((await handlePostComment(unenrolled, CREDENTIAL, commentBody())).status).toBe(403);
		expect(unenrolled.buildScmDelivery).not.toHaveBeenCalled();
	});

	it('returns 400 for a malformed body', async () => {
		const deps = makeDeps();
		const result = await handlePostComment(deps, CREDENTIAL, commentBody({ body: '' }));
		expect(result.status).toBe(400);
	});

	it('returns 400 for an unknown persona rather than guessing one', async () => {
		const deps = makeDeps();
		const result = await handlePostComment(deps, CREDENTIAL, commentBody({ persona: 'operator' }));
		expect(result.status).toBe(400);
		expect(deps.buildScmDelivery).not.toHaveBeenCalled();
	});

	it('answers 503 with a reason when the persona credential cannot be resolved', async () => {
		// Ordinary misconfiguration on this host: `implementer` resolves to its
		// `SWARM_OPERATOR_GH_TOKEN`, which the router did not need for this route
		// before issue #444. Letting the throw escape makes it a reason-less 500, so
		// the worker's log — and the failed run's comment — never name the cause.
		const deps = makeDeps({
			buildScmDelivery: vi
				.fn()
				.mockRejectedValue(new Error(`No operator GitHub token configured: ${RESOLVED_PAT}`)),
		});

		const result = await handlePostComment(
			deps,
			CREDENTIAL,
			commentBody({ persona: 'implementer' }),
		);

		expect(result.status).toBe(503);
		expect(result.json).toEqual({
			reason: 'persona credential unavailable',
			persona: 'implementer',
		});
		expect(JSON.stringify(result.json)).not.toContain(RESOLVED_PAT);
		expect(JSON.stringify(result.json)).not.toContain(CREDENTIAL);
	});
});

describe('control-plane delivery seam', () => {
	beforeEach(() => vi.clearAllMocks());

	it('carries only the review metadata to the reviewer PAT and round-trips the id', async () => {
		// A `buildScmDelivery` standing in for the server-side reviewer-PAT write:
		// it asserts exactly the verdict + body reached it (proving only metadata
		// crossed, never a repository tree) and returns a review id.
		const submitReview = vi.fn(
			async (input: { prNumber: number; verdict: string; body: string; deliveryId: string }) => {
				expect(input).toEqual({
					prNumber: 42,
					verdict: 'request-changes',
					body: 'Please fix the null check',
					deliveryId: 'delivery-9',
				});
				return 4242;
			},
		);
		const deps = makeDeps({
			buildScmDelivery: vi.fn().mockResolvedValue(makeDelivery({ submitReview })),
		});

		const result = await handleSubmitReview(
			deps,
			CREDENTIAL,
			reviewBody({
				verdict: 'request-changes',
				body: 'Please fix the null check',
				deliveryId: 'delivery-9',
			}),
		);

		expect(result.json).toEqual({ reviewId: 4242 });
	});
});

describe('handleMoveWorkItem', () => {
	beforeEach(() => vi.clearAllMocks());

	it('moves the card under the server-side PM credential and returns an empty body', async () => {
		const moveWorkItem = vi.fn().mockResolvedValue(undefined);
		const buildPmProvider = vi.fn(() => makePmProvider({ moveWorkItem }));
		const deps = makeDeps({ buildPmProvider });

		const result = await handleMoveWorkItem(deps, CREDENTIAL, moveBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({});
		expect(buildPmProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'swarm' }));
		// The canonical status key crosses the wire, never a board option ID (RULES.md §2);
		// resolving it to an option ID is the adapter's job, server-side.
		expect(moveWorkItem).toHaveBeenCalledWith('PVTI_item1', 'inReview');
		expect(moveWorkItem).not.toHaveBeenCalledWith('PVTI_item1', BOARD_OPTION_ID);
	});

	it('rejects an unknown credential with 401 and never echoes the credential or PM credential', async () => {
		const deps = makeDeps({ resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined) });

		const result = await handleMoveWorkItem(deps, 'bogus', moveBody());

		expect(result.status).toBe(401);
		expect(result.json).toEqual({ authenticated: false });
		const serialized = JSON.stringify(result.json);
		expect(serialized).not.toContain('bogus');
		expect(serialized).not.toContain(RESOLVED_PAT);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});

	it('rejects an absent credential with 401 without resolving a worker', async () => {
		const deps = makeDeps();
		const result = await handleMoveWorkItem(deps, undefined, moveBody());
		expect(result.status).toBe(401);
		expect(deps.resolveWorkerByCredential).not.toHaveBeenCalled();
	});

	it('returns 404 for an unknown project', async () => {
		const deps = makeDeps();
		const result = await handleMoveWorkItem(deps, CREDENTIAL, moveBody({ projectId: 'nope' }));
		expect(result.status).toBe(404);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});

	it('returns 403 when the worker is not enrolled in the project', async () => {
		const deps = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		const result = await handleMoveWorkItem(deps, CREDENTIAL, moveBody());
		expect(result.status).toBe(403);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});

	it('returns 400 for a malformed body', async () => {
		const deps = makeDeps();
		const result = await handleMoveWorkItem(deps, CREDENTIAL, moveBody({ itemId: '' }));
		expect(result.status).toBe(400);
		expect(deps.resolveWorkerByCredential).not.toHaveBeenCalled();
	});

	it('returns 400 for a protocol-version mismatch', async () => {
		const deps = makeDeps();
		const result = await handleMoveWorkItem(
			deps,
			CREDENTIAL,
			moveBody({ protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1 }),
		);
		expect(result.status).toBe(400);
		expect(result.json).toMatchObject({ protocolVersion: TRANSPORT_PROTOCOL_VERSION });
		expect(deps.resolveWorkerByCredential).not.toHaveBeenCalled();
	});
});

describe('handleAddPmComment', () => {
	beforeEach(() => vi.clearAllMocks());

	it('posts the comment on the backing item and returns the created id', async () => {
		const addComment = vi.fn().mockResolvedValue('IC_kw42');
		const deps = makeDeps({ buildPmProvider: vi.fn(() => makePmProvider({ addComment })) });

		const result = await handleAddPmComment(deps, CREDENTIAL, pmCommentBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({ commentId: 'IC_kw42' });
		expect(addComment).toHaveBeenCalledWith('PVTI_item1', 'Plan posted');
	});

	it('enforces auth and enrollment before touching the PM credential', async () => {
		const unknown = makeDeps({ resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined) });
		expect((await handleAddPmComment(unknown, 'bogus', pmCommentBody())).status).toBe(401);
		expect(unknown.buildPmProvider).not.toHaveBeenCalled();

		const unenrolled = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		expect((await handleAddPmComment(unenrolled, CREDENTIAL, pmCommentBody())).status).toBe(403);
		expect(unenrolled.buildPmProvider).not.toHaveBeenCalled();
	});

	it('returns 400 for a malformed body', async () => {
		const deps = makeDeps();
		const result = await handleAddPmComment(deps, CREDENTIAL, pmCommentBody({ body: '' }));
		expect(result.status).toBe(400);
	});
});

/** A ledger request body — the worker sends PR coordinates only, never the repository. */
function priorReviewBody(overrides: Record<string, unknown> = {}) {
	return {
		projectId: 'swarm',
		prNumber: '42',
		currentHeadSha: 'deadbeef',
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		...overrides,
	};
}

function markLedgerBody(overrides: Record<string, unknown> = {}) {
	return {
		projectId: 'swarm',
		prNumber: '42',
		headSha: 'deadbeef',
		verdict: 'request-changes',
		reviewId: '9911',
		protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		...overrides,
	};
}

describe('handlePriorReview', () => {
	beforeEach(() => vi.clearAllMocks());

	it('reads the prior verdict with a key derived from the authenticated project', async () => {
		const record = {
			ordinal: 1,
			state: 'submitted' as const,
			verdict: 'request-changes',
			headSha: 'cafe',
		};
		const reviewLedger = makeReviewLedger({
			getPriorSubmittedReview: vi.fn().mockResolvedValue(record),
		});
		const deps = makeDeps({ reviewLedger });

		const result = await handlePriorReview(deps, CREDENTIAL, priorReviewBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({ record });
		// projectId + repository come from the project the credential authorized, not
		// from the request — a worker cannot key a row to another project or repo.
		expect(reviewLedger.getPriorSubmittedReview).toHaveBeenCalledWith(
			'swarm',
			'SmartTechBrewery/swarm',
			'42',
			'deadbeef',
		);
	});

	it('answers a first review with an explicit null record', async () => {
		const result = await handlePriorReview(makeDeps(), CREDENTIAL, priorReviewBody());
		expect(result.json).toEqual({ record: null });
	});

	it('enforces auth and enrollment before reading the ledger', async () => {
		const unknownWorker = makeReviewLedger();
		expect(
			(
				await handlePriorReview(
					makeDeps({
						reviewLedger: unknownWorker,
						resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined),
					}),
					'bogus',
					priorReviewBody(),
				)
			).status,
		).toBe(401);
		expect(unknownWorker.getPriorSubmittedReview).not.toHaveBeenCalled();

		const unenrolledLedger = makeReviewLedger();
		expect(
			(
				await handlePriorReview(
					makeDeps({
						reviewLedger: unenrolledLedger,
						isWorkerEnrolled: vi.fn().mockResolvedValue(false),
					}),
					CREDENTIAL,
					priorReviewBody(),
				)
			).status,
		).toBe(403);
		expect(unenrolledLedger.getPriorSubmittedReview).not.toHaveBeenCalled();

		expect(
			(await handlePriorReview(makeDeps(), CREDENTIAL, priorReviewBody({ projectId: 'nope' })))
				.status,
		).toBe(404);
	});

	it('returns 400 for a malformed body or a protocol mismatch', async () => {
		const deps = makeDeps();
		expect(
			(await handlePriorReview(deps, CREDENTIAL, priorReviewBody({ prNumber: '' }))).status,
		).toBe(400);
		expect(
			(
				await handlePriorReview(
					deps,
					CREDENTIAL,
					priorReviewBody({ protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1 }),
				)
			).status,
		).toBe(400);
		expect(deps.reviewLedger.getPriorSubmittedReview).not.toHaveBeenCalled();
	});
});

describe('handleMarkReviewVerdict', () => {
	beforeEach(() => vi.clearAllMocks());

	it('marks the slot submitted and returns its ordinal', async () => {
		const reviewLedger = makeReviewLedger({
			markReviewVerdictSubmitted: vi.fn().mockResolvedValue({ id: 'verdict-2', ordinal: 2 }),
		});

		const result = await handleMarkReviewVerdict(
			makeDeps({ reviewLedger }),
			CREDENTIAL,
			markLedgerBody(),
		);

		expect(result.status).toBe(200);
		expect(result.json).toEqual({ slot: { id: 'verdict-2', ordinal: 2 } });
		expect(reviewLedger.markReviewVerdictSubmitted).toHaveBeenCalledWith(
			{
				projectId: 'swarm',
				repository: 'SmartTechBrewery/swarm',
				prNumber: '42',
				headSha: 'deadbeef',
			},
			{ verdict: 'request-changes', reviewId: '9911' },
		);
	});

	it('reports an absent slot as an explicit null rather than omitting it', async () => {
		const reviewLedger = makeReviewLedger({
			markReviewVerdictSubmitted: vi.fn().mockResolvedValue(undefined),
		});
		const result = await handleMarkReviewVerdict(
			makeDeps({ reviewLedger }),
			CREDENTIAL,
			markLedgerBody(),
		);
		expect(result.json).toEqual({ slot: null });
	});

	it('accepts a mark with no review id yet', async () => {
		const reviewLedger = makeReviewLedger();
		const body = markLedgerBody();
		delete (body as Record<string, unknown>).reviewId;
		const result = await handleMarkReviewVerdict(makeDeps({ reviewLedger }), CREDENTIAL, body);

		expect(result.status).toBe(200);
		expect(reviewLedger.markReviewVerdictSubmitted).toHaveBeenCalledWith(expect.anything(), {
			verdict: 'request-changes',
			reviewId: undefined,
		});
	});

	it('enforces auth and enrollment before writing the ledger', async () => {
		const unauthenticated = makeReviewLedger();
		expect(
			(
				await handleMarkReviewVerdict(
					makeDeps({
						reviewLedger: unauthenticated,
						resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined),
					}),
					'bogus',
					markLedgerBody(),
				)
			).status,
		).toBe(401);
		expect(unauthenticated.markReviewVerdictSubmitted).not.toHaveBeenCalled();

		const unenrolled = makeReviewLedger();
		expect(
			(
				await handleMarkReviewVerdict(
					makeDeps({
						reviewLedger: unenrolled,
						isWorkerEnrolled: vi.fn().mockResolvedValue(false),
					}),
					CREDENTIAL,
					markLedgerBody(),
				)
			).status,
		).toBe(403);
		expect(unenrolled.markReviewVerdictSubmitted).not.toHaveBeenCalled();
	});
});

describe('handleAbandonReviewVerdict', () => {
	beforeEach(() => vi.clearAllMocks());

	it('releases the pending slot for the authenticated project', async () => {
		const reviewLedger = makeReviewLedger();
		const result = await handleAbandonReviewVerdict(
			makeDeps({ reviewLedger }),
			CREDENTIAL,
			priorReviewBody({ headSha: 'deadbeef', currentHeadSha: undefined }),
		);

		expect(result.status).toBe(200);
		expect(result.json).toEqual({});
		expect(reviewLedger.abandonReviewVerdict).toHaveBeenCalledWith({
			projectId: 'swarm',
			repository: 'SmartTechBrewery/swarm',
			prNumber: '42',
			headSha: 'deadbeef',
		});
	});

	it('enforces auth and enrollment before releasing the slot', async () => {
		const unauthenticated = makeReviewLedger();
		expect(
			(
				await handleAbandonReviewVerdict(
					makeDeps({
						reviewLedger: unauthenticated,
						resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined),
					}),
					'bogus',
					priorReviewBody({ headSha: 'deadbeef' }),
				)
			).status,
		).toBe(401);
		expect(unauthenticated.abandonReviewVerdict).not.toHaveBeenCalled();

		const unenrolled = makeReviewLedger();
		expect(
			(
				await handleAbandonReviewVerdict(
					makeDeps({
						reviewLedger: unenrolled,
						isWorkerEnrolled: vi.fn().mockResolvedValue(false),
					}),
					CREDENTIAL,
					priorReviewBody({ headSha: 'deadbeef' }),
				)
			).status,
		).toBe(403);
		expect(unenrolled.abandonReviewVerdict).not.toHaveBeenCalled();
	});
});

describe('handleListBlockers', () => {
	beforeEach(() => vi.clearAllMocks());

	function blockersBody(overrides: Record<string, unknown> = {}) {
		return {
			projectId: 'swarm',
			itemId: 'PVTI_item1',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
			...overrides,
		};
	}

	it('reads the item’s blockers under the server-side PM credential', async () => {
		const blockers = [
			{
				id: 'PVTI_blocker',
				reference: '#319',
				url: 'https://github.com/SmartTechBrewery/swarm/issues/319',
				title: 'Prerequisite',
				open: true,
				source: 'dependency' as const,
			},
		];
		const listBlockers = vi.fn().mockResolvedValue(blockers);
		const deps = makeDeps({ buildPmProvider: vi.fn(() => makePmProvider({ listBlockers })) });

		const result = await handleListBlockers(deps, CREDENTIAL, blockersBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({ blockers });
		expect(listBlockers).toHaveBeenCalledWith('PVTI_item1');
	});

	it('passes through an empty list for an item nothing gates', async () => {
		const deps = makeDeps({
			buildPmProvider: vi.fn(() => makePmProvider({ listBlockers: vi.fn().mockResolvedValue([]) })),
		});
		expect((await handleListBlockers(deps, CREDENTIAL, blockersBody())).json).toEqual({
			blockers: [],
		});
	});

	it('enforces auth and enrollment before touching the PM credential', async () => {
		const unknownWorker = makeDeps({
			resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined),
		});
		expect((await handleListBlockers(unknownWorker, 'bogus', blockersBody())).status).toBe(401);
		expect(unknownWorker.buildPmProvider).not.toHaveBeenCalled();

		const unenrolled = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		expect((await handleListBlockers(unenrolled, CREDENTIAL, blockersBody())).status).toBe(403);
		expect(unenrolled.buildPmProvider).not.toHaveBeenCalled();

		const deps = makeDeps();
		expect(
			(await handleListBlockers(deps, CREDENTIAL, blockersBody({ projectId: 'nope' }))).status,
		).toBe(404);
	});

	it('returns 400 for a malformed body or a protocol mismatch', async () => {
		const deps = makeDeps();
		expect((await handleListBlockers(deps, CREDENTIAL, blockersBody({ itemId: '' }))).status).toBe(
			400,
		);
		expect(
			(
				await handleListBlockers(
					deps,
					CREDENTIAL,
					blockersBody({ protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1 }),
				)
			).status,
		).toBe(400);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});
});

describe('handleFindWorkItem', () => {
	beforeEach(() => vi.clearAllMocks());

	function findBody(overrides: Record<string, unknown> = {}) {
		return {
			projectId: 'swarm',
			urlSuffix: '/issues/21',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
			...overrides,
		};
	}

	it('resolves the card under the server-side PM credential and projects onto the narrow wire frame', async () => {
		const item = createMockWorkItem({
			id: 'ITEM_21',
			url: 'https://github.com/SmartTechBrewery/swarm/issues/21',
			description: 'Sensitive body text that should not cross wire',
			labels: [{ id: 'l1', name: 'bug' }],
			assignees: [{ handle: 'octocat' }],
		});
		const findWorkItemByUrlSuffix = vi.fn().mockResolvedValue(item);
		const deps = makeDeps({
			buildPmProvider: vi.fn(() => makePmProvider({ findWorkItemByUrlSuffix })),
		});

		const result = await handleFindWorkItem(deps, CREDENTIAL, findBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({
			item: {
				id: 'ITEM_21',
				title: item.title,
				url: 'https://github.com/SmartTechBrewery/swarm/issues/21',
				status: item.status,
				statusId: item.statusId,
			},
		});
		expect(findWorkItemByUrlSuffix).toHaveBeenCalledWith('/issues/21');
	});

	it('answers item: null when no card wraps that URL — an ordinary miss, not a 404', async () => {
		const deps = makeDeps();
		const result = await handleFindWorkItem(deps, CREDENTIAL, findBody());
		expect(result.status).toBe(200);
		expect(result.json).toEqual({ item: null });
	});

	it('enforces auth and enrollment before touching the PM credential', async () => {
		const unknownWorker = makeDeps({
			resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined),
		});
		expect((await handleFindWorkItem(unknownWorker, 'bogus', findBody())).status).toBe(401);
		expect(unknownWorker.buildPmProvider).not.toHaveBeenCalled();

		const unenrolled = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		expect((await handleFindWorkItem(unenrolled, CREDENTIAL, findBody())).status).toBe(403);
		expect(unenrolled.buildPmProvider).not.toHaveBeenCalled();

		const deps = makeDeps();
		expect(
			(await handleFindWorkItem(deps, CREDENTIAL, findBody({ projectId: 'nope' }))).status,
		).toBe(404);
	});

	it('returns 400 for a malformed body or a protocol mismatch', async () => {
		const deps = makeDeps();
		expect((await handleFindWorkItem(deps, CREDENTIAL, findBody({ urlSuffix: '' }))).status).toBe(
			400,
		);
		expect(
			(
				await handleFindWorkItem(
					deps,
					CREDENTIAL,
					findBody({ protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1 }),
				)
			).status,
		).toBe(400);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});
});

describe('handleFindWorkItemByMarker', () => {
	// Issue #543: the read Planning's retried split resolves its already-created
	// child through. Narrow in the same sense as the URL-suffix lookup — one marker
	// in, one card out — so the card comes back on the same projected frame.
	const MARKER = '<!-- swarm-split-child:run-1:0 -->';

	it('resolves the card through the provider and projects the narrow frame', async () => {
		const findWorkItemByDescriptionMarker = vi
			.fn()
			.mockResolvedValue(createMockWorkItem({ id: 'ITEM_61', description: `body\n\n${MARKER}` }));
		const deps = makeDeps({
			buildPmProvider: vi.fn(() => makePmProvider({ findWorkItemByDescriptionMarker })),
		});

		const result = await handleFindWorkItemByMarker(deps, CREDENTIAL, {
			projectId: 'swarm',
			marker: MARKER,
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});

		expect(result.status).toBe(200);
		expect(findWorkItemByDescriptionMarker).toHaveBeenCalledWith(MARKER);
		// The description the marker was matched on is deliberately not sent back.
		expect(result.json).toMatchObject({ item: { id: 'ITEM_61' } });
		expect((result.json as { item: Record<string, unknown> }).item).not.toHaveProperty(
			'description',
		);
	});

	it('answers a miss with an explicit null card', async () => {
		const deps = makeDeps({
			buildPmProvider: vi.fn(() =>
				makePmProvider({ findWorkItemByDescriptionMarker: vi.fn().mockResolvedValue(undefined) }),
			),
		});

		const result = await handleFindWorkItemByMarker(deps, CREDENTIAL, {
			projectId: 'swarm',
			marker: MARKER,
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});

		expect(result).toMatchObject({ status: 200, json: { item: null } });
	});

	it('rejects a mismatched protocol version before touching the board', async () => {
		const deps = makeDeps();

		const result = await handleFindWorkItemByMarker(deps, CREDENTIAL, {
			projectId: 'swarm',
			marker: MARKER,
			protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1,
		});

		expect(result.status).toBe(400);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});
});

describe('handleFindWorkItemForArtifact', () => {
	it('resolves the card through the repository-scoped provider lookup', async () => {
		const item = createMockWorkItem({ id: 'ITEM_21' });
		const findWorkItemForArtifact = vi.fn().mockResolvedValue(item);
		const deps = makeDeps({
			buildPmProvider: vi.fn(() => makePmProvider({ findWorkItemForArtifact })),
		});

		const result = await handleFindWorkItemForArtifact(deps, CREDENTIAL, {
			projectId: 'swarm',
			repository: 'SmartTechBrewery/swarm',
			kind: 'issue',
			number: '21',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});

		expect(result.status).toBe(200);
		expect(findWorkItemForArtifact).toHaveBeenCalledWith({
			repository: 'SmartTechBrewery/swarm',
			kind: 'issue',
			number: '21',
		});
	});
});

/**
 * The Planning routes (issue #536). Planning is the only phase that *creates* board
 * structure, so beyond the shared prelude every one of these asserts the two
 * properties that keep a bug from writing wrong structure onto a live board: the
 * board written to is the **authenticated** project's, and no provider-native shape
 * (a board option id, a label object) is what crosses the wire.
 */
describe('handleFindPmComment', () => {
	beforeEach(() => vi.clearAllMocks());

	function findCommentBody(overrides: Record<string, unknown> = {}) {
		return {
			projectId: 'swarm',
			itemId: 'PVTI_item1',
			marker: 'swarm-planning-delivery:run-1',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
			...overrides,
		};
	}

	it('returns the matching comment id under the server-side PM credential', async () => {
		const findComment = vi.fn().mockResolvedValue('IC_kw77');
		const deps = makeDeps({ buildPmProvider: vi.fn(() => makePmProvider({ findComment })) });

		const result = await handleFindPmComment(deps, CREDENTIAL, findCommentBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({ commentId: 'IC_kw77' });
		expect(findComment).toHaveBeenCalledWith('PVTI_item1', 'swarm-planning-delivery:run-1');
	});

	it('answers commentId: null for an unposted delivery — an ordinary miss, not a 404', async () => {
		const deps = makeDeps({
			buildPmProvider: vi.fn(() =>
				makePmProvider({ findComment: vi.fn().mockResolvedValue(undefined) }),
			),
		});
		const result = await handleFindPmComment(deps, CREDENTIAL, findCommentBody());
		expect(result.status).toBe(200);
		expect(result.json).toEqual({ commentId: null });
	});

	it('enforces auth and enrollment before touching the PM credential', async () => {
		const unknownWorker = makeDeps({
			resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined),
		});
		expect((await handleFindPmComment(unknownWorker, 'bogus', findCommentBody())).status).toBe(401);
		expect(unknownWorker.buildPmProvider).not.toHaveBeenCalled();

		const unenrolled = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		expect((await handleFindPmComment(unenrolled, CREDENTIAL, findCommentBody())).status).toBe(403);
		expect(unenrolled.buildPmProvider).not.toHaveBeenCalled();

		const deps = makeDeps();
		expect(
			(await handleFindPmComment(deps, CREDENTIAL, findCommentBody({ projectId: 'nope' }))).status,
		).toBe(404);
	});

	it('returns 400 for a malformed body or a protocol mismatch', async () => {
		const deps = makeDeps();
		expect(
			(await handleFindPmComment(deps, CREDENTIAL, findCommentBody({ marker: '' }))).status,
		).toBe(400);
		expect(
			(
				await handleFindPmComment(
					deps,
					CREDENTIAL,
					findCommentBody({ protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1 }),
				)
			).status,
		).toBe(400);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});
});

describe('handleCreateWorkItem', () => {
	beforeEach(() => vi.clearAllMocks());

	function createBody(overrides: Record<string, unknown> = {}) {
		return {
			projectId: 'swarm',
			title: 'Phase 2 of 3 — extract the reader',
			description: 'child body',
			status: 'backlog',
			labels: ['swarm', 'swarm:split-child'],
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
			...overrides,
		};
	}

	it('creates the card on the authenticated project and projects it onto the narrow frame', async () => {
		const created = createMockWorkItem({
			id: 'ITEM_61',
			url: 'https://github.com/SmartTechBrewery/swarm/issues/61',
			description: 'child body the worker already has',
			labels: [{ id: 'l1', name: 'swarm' }],
			assignees: [{ handle: 'octocat' }],
		});
		const createWorkItem = vi.fn().mockResolvedValue(created);
		const project = createMockProjectConfig();
		const buildPmProvider = vi.fn(() => makePmProvider({ createWorkItem }));
		const deps = makeDeps({ buildPmProvider });

		const result = await handleCreateWorkItem(deps, CREDENTIAL, createBody());

		expect(result.status).toBe(200);
		// Description, labels and assignees deliberately stay off the wire.
		expect(result.json).toEqual({
			item: {
				id: 'ITEM_61',
				title: created.title,
				url: 'https://github.com/SmartTechBrewery/swarm/issues/61',
				status: created.status,
				statusId: created.statusId,
			},
		});
		// A canonical status key and label names in; the adapter resolves them.
		expect(createWorkItem).toHaveBeenCalledWith({
			title: 'Phase 2 of 3 — extract the reader',
			description: 'child body',
			status: 'backlog',
			labels: ['swarm', 'swarm:split-child'],
		});
		// The board is the authenticated enrollment's project, never one the body names.
		expect(buildPmProvider).toHaveBeenCalledWith(project);
	});

	it('omits labels entirely when the request names none', async () => {
		const createWorkItem = vi.fn().mockResolvedValue(createMockWorkItem());
		const deps = makeDeps({ buildPmProvider: vi.fn(() => makePmProvider({ createWorkItem })) });

		await handleCreateWorkItem(deps, CREDENTIAL, createBody({ labels: undefined }));

		expect(createWorkItem).toHaveBeenCalledWith({
			title: 'Phase 2 of 3 — extract the reader',
			description: 'child body',
			status: 'backlog',
		});
	});

	it('creates nothing for an unauthenticated, unenrolled or unknown-project request', async () => {
		const unknownWorker = makeDeps({
			resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined),
		});
		expect((await handleCreateWorkItem(unknownWorker, 'bogus', createBody())).status).toBe(401);
		expect(unknownWorker.buildPmProvider).not.toHaveBeenCalled();

		const unenrolled = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		expect((await handleCreateWorkItem(unenrolled, CREDENTIAL, createBody())).status).toBe(403);
		expect(unenrolled.buildPmProvider).not.toHaveBeenCalled();

		const deps = makeDeps();
		expect(
			(await handleCreateWorkItem(deps, CREDENTIAL, createBody({ projectId: 'nope' }))).status,
		).toBe(404);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});

	it('returns 400 for a malformed body or a protocol mismatch', async () => {
		const deps = makeDeps();
		expect((await handleCreateWorkItem(deps, CREDENTIAL, createBody({ title: '' }))).status).toBe(
			400,
		);
		expect((await handleCreateWorkItem(deps, CREDENTIAL, createBody({ status: '' }))).status).toBe(
			400,
		);
		expect(
			(
				await handleCreateWorkItem(
					deps,
					CREDENTIAL,
					createBody({ protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1 }),
				)
			).status,
		).toBe(400);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});
});

describe('handleUpdateWorkItem', () => {
	beforeEach(() => vi.clearAllMocks());

	function updateBody(overrides: Record<string, unknown> = {}) {
		return {
			projectId: 'swarm',
			itemId: 'PVTI_item1',
			title: 'Phase 1 of 3 — the smaller first task',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
			...overrides,
		};
	}

	it('forwards only the fields the request carries, so an omitted one stays unchanged', async () => {
		const updateWorkItem = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({ buildPmProvider: vi.fn(() => makePmProvider({ updateWorkItem })) });

		expect((await handleUpdateWorkItem(deps, CREDENTIAL, updateBody())).status).toBe(200);
		expect(updateWorkItem).toHaveBeenCalledWith('PVTI_item1', {
			title: 'Phase 1 of 3 — the smaller first task',
		});

		// A marker embed patches only the description — and an empty one is legitimate.
		await handleUpdateWorkItem(deps, CREDENTIAL, updateBody({ title: undefined, description: '' }));
		expect(updateWorkItem).toHaveBeenLastCalledWith('PVTI_item1', { description: '' });
	});

	it('enforces auth and enrollment, and rejects a malformed body', async () => {
		const unenrolled = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		expect((await handleUpdateWorkItem(unenrolled, CREDENTIAL, updateBody())).status).toBe(403);
		expect(unenrolled.buildPmProvider).not.toHaveBeenCalled();

		const deps = makeDeps();
		expect((await handleUpdateWorkItem(deps, CREDENTIAL, updateBody({ itemId: '' }))).status).toBe(
			400,
		);
		// An untitled item is no provider's shape, so an empty title is a bad request
		// rather than a write that blanks the card.
		expect((await handleUpdateWorkItem(deps, CREDENTIAL, updateBody({ title: '' }))).status).toBe(
			400,
		);
		// Both fields optional means "leave this one alone", so neither means the
		// request asks for nothing — reject it rather than spend a board write on an
		// empty patch (issue #536 review).
		expect(
			(await handleUpdateWorkItem(deps, CREDENTIAL, updateBody({ title: undefined }))).status,
		).toBe(400);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});
});

describe('handleAddPmLabel', () => {
	beforeEach(() => vi.clearAllMocks());

	function labelBody(overrides: Record<string, unknown> = {}) {
		return {
			projectId: 'swarm',
			itemId: 'PVTI_item1',
			name: 'planned',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
			...overrides,
		};
	}

	it('applies the label by name under the server-side PM credential', async () => {
		const addLabel = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({ buildPmProvider: vi.fn(() => makePmProvider({ addLabel })) });

		expect((await handleAddPmLabel(deps, CREDENTIAL, labelBody())).status).toBe(200);
		expect(addLabel).toHaveBeenCalledWith('PVTI_item1', 'planned');
	});

	it('enforces auth and enrollment, and rejects a malformed body', async () => {
		const unenrolled = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		expect((await handleAddPmLabel(unenrolled, CREDENTIAL, labelBody())).status).toBe(403);
		expect(unenrolled.buildPmProvider).not.toHaveBeenCalled();

		const deps = makeDeps();
		expect((await handleAddPmLabel(deps, CREDENTIAL, labelBody({ name: '' }))).status).toBe(400);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});
});

describe('handleAddBlockedBy', () => {
	beforeEach(() => vi.clearAllMocks());

	function blockedByBody(overrides: Record<string, unknown> = {}) {
		return {
			projectId: 'swarm',
			itemId: 'PVTI_child',
			blockerId: 'PVTI_item1',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
			...overrides,
		};
	}

	it('records the dependency edge under the server-side PM credential', async () => {
		const addBlockedBy = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({ buildPmProvider: vi.fn(() => makePmProvider({ addBlockedBy })) });

		expect((await handleAddBlockedBy(deps, CREDENTIAL, blockedByBody())).status).toBe(200);
		expect(addBlockedBy).toHaveBeenCalledWith('PVTI_child', 'PVTI_item1');
	});

	it('needs no capability branch — a provider without dependencies no-ops by contract', async () => {
		const addBlockedBy = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({
			buildPmProvider: vi.fn(() => makePmProvider({ supportsDependencies: false, addBlockedBy })),
		});
		expect((await handleAddBlockedBy(deps, CREDENTIAL, blockedByBody())).status).toBe(200);
		expect(addBlockedBy).toHaveBeenCalledWith('PVTI_child', 'PVTI_item1');
	});

	it('enforces auth and enrollment, and rejects a malformed body', async () => {
		const unenrolled = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		expect((await handleAddBlockedBy(unenrolled, CREDENTIAL, blockedByBody())).status).toBe(403);
		expect(unenrolled.buildPmProvider).not.toHaveBeenCalled();

		const deps = makeDeps();
		expect(
			(await handleAddBlockedBy(deps, CREDENTIAL, blockedByBody({ blockerId: '' }))).status,
		).toBe(400);
		expect(deps.buildPmProvider).not.toHaveBeenCalled();
	});
});

describe('handleScheduleFollowUpReview', () => {
	beforeEach(() => vi.clearAllMocks());

	function followUpBody(overrides: Record<string, unknown> = {}) {
		return {
			projectId: 'swarm',
			prNumber: '42',
			prBranch: 'issue-21',
			headSha: 'newsha',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
			...overrides,
		};
	}

	it('schedules the follow-up for the authenticated project, not one named in the body', async () => {
		const scheduleFollowUpReview = vi.fn().mockResolvedValue(undefined);
		const deps = makeDeps({ scheduleFollowUpReview });

		const result = await handleScheduleFollowUpReview(deps, CREDENTIAL, followUpBody());

		expect(result.status).toBe(200);
		expect(result.json).toEqual({});
		expect(scheduleFollowUpReview).toHaveBeenCalledWith({
			project: createMockProjectConfig(),
			prNumber: '42',
			prBranch: 'issue-21',
			headSha: 'newsha',
		});
	});

	it('enforces auth and enrollment before enqueueing anything', async () => {
		const unknownWorker = makeDeps({
			resolveWorkerByCredential: vi.fn().mockResolvedValue(undefined),
		});
		expect(
			(await handleScheduleFollowUpReview(unknownWorker, 'bogus', followUpBody())).status,
		).toBe(401);
		expect(unknownWorker.scheduleFollowUpReview).not.toHaveBeenCalled();

		const unenrolled = makeDeps({ isWorkerEnrolled: vi.fn().mockResolvedValue(false) });
		expect(
			(await handleScheduleFollowUpReview(unenrolled, CREDENTIAL, followUpBody())).status,
		).toBe(403);
		expect(unenrolled.scheduleFollowUpReview).not.toHaveBeenCalled();

		const deps = makeDeps();
		expect(
			(await handleScheduleFollowUpReview(deps, CREDENTIAL, followUpBody({ projectId: 'nope' })))
				.status,
		).toBe(404);
		expect(deps.scheduleFollowUpReview).not.toHaveBeenCalled();
	});

	it('returns 400 for a malformed body or a protocol mismatch', async () => {
		const deps = makeDeps();
		expect(
			(await handleScheduleFollowUpReview(deps, CREDENTIAL, followUpBody({ headSha: '' }))).status,
		).toBe(400);
		expect(
			(
				await handleScheduleFollowUpReview(
					deps,
					CREDENTIAL,
					followUpBody({ protocolVersion: TRANSPORT_PROTOCOL_VERSION + 1 }),
				)
			).status,
		).toBe(400);
		expect(deps.scheduleFollowUpReview).not.toHaveBeenCalled();
	});
});
