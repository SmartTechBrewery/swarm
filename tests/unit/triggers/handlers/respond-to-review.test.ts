import { describe, expect, it, vi } from 'vitest';
import { REVIEW_VERDICT_CAP } from '@/db/repositories/reviewVerdictsRepository.js';
import { getPersonaForLogin } from '@/integrations/scm/github/personas.js';
import { parseGitHubWebhook } from '@/integrations/scm/github/webhook.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';
import { createRespondToReviewTrigger } from '@/triggers/handlers/respond-to-review.js';
import type { TriggerContext } from '@/triggers/types.js';
import {
	createFakeScmProvider,
	createMockProjectConfig,
	createMockScmEvent,
	createMockScmTriggerContext,
} from '../../../helpers/factories.js';

const PROJECT = createMockProjectConfig();
const IDENTITIES: ScmPersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };
const HEAD_SHA = 'deadbeef1234deadbeef1234deadbeef1234dead';

// The handler resolves persona identities through the injected `SCMProvider`, so
// only identity *resolution* is stubbed (it would otherwise hit the provider's
// API); the real `personaForActor` mapping runs against these identities, which
// is what keeps the `[bot]`-suffix case honest.
const SCM = createFakeScmProvider({
	resolvePersonaIdentities: async () => IDENTITIES,
	personaForActor: getPersonaForLogin,
});

// The ledger lookups default to the first (non-capping) verdict slot so the
// existing dispatch tests exercise the common case without needing a live database.
const getReviewVerdictByReviewId = vi.fn(async () => ({
	ordinal: 1,
	state: 'submitted' as const,
	verdict: 'request-changes',
	headSha: HEAD_SHA,
}));
const getReviewVerdictByHead = vi.fn(async () => undefined);
const handler = createRespondToReviewTrigger({
	getReviewVerdictByReviewId,
	getReviewVerdictByHead,
});

function reviewEvent(overrides: Partial<Parameters<typeof createMockScmEvent>[0]> = {}) {
	return createMockScmEvent({
		kind: 'pull-request-review',
		action: 'submitted',
		workItemId: '17',
		reviewState: 'changes-requested',
		reviewId: '555',
		prBranch: 'issue-17',
		headSha: HEAD_SHA,
		actorLogin: 'swarm-rev',
		...overrides,
	});
}

function ctx(overrides: Partial<Parameters<typeof createMockScmEvent>[0]> = {}): TriggerContext {
	return createMockScmTriggerContext({ project: PROJECT, scm: SCM, event: reviewEvent(overrides) });
}

describe('respond-to-review trigger', () => {
	describe('matches', () => {
		it('matches a submitted changes-requested review', () => {
			expect(handler.matches(ctx())).toBe(true);
		});

		it('matches a submitted commented review so an opt-out project can dispatch it', () => {
			expect(handler.matches(ctx({ reviewState: 'commented' }))).toBe(true);
		});

		it('matches an approved review too — dispatch policy is decided by the project setting', () => {
			expect(handler.matches(ctx({ reviewState: 'approved' }))).toBe(true);
		});

		it('ignores a non-submitted action (edit/dismiss)', () => {
			expect(handler.matches(ctx({ action: 'edited' }))).toBe(false);
		});

		it('ignores other event types', () => {
			expect(handler.matches(ctx({ kind: 'pull-request', action: 'opened' }))).toBe(false);
		});
	});

	describe('handle', () => {
		it('dispatches Respond-to-review for a reviewer-persona review', async () => {
			const result = await handler.handle(ctx());
			expect(result).toEqual({
				phase: 'respond-to-review',
				taskId: '17-respond',
				prNumber: '17',
				prBranch: 'issue-17',
				reviewId: '555',
				headSha: HEAD_SHA,
			});
		});

		it('dispatches with the review-pinned SHA when the PR head SHA is absent', async () => {
			const event = parseGitHubWebhook('pull_request_review', {
				action: 'submitted',
				repository: { full_name: PROJECT.repo },
				pull_request: { number: 17, head: { ref: 'issue-17' } },
				review: {
					id: 555,
					state: 'changes_requested',
					commit_id: HEAD_SHA,
				},
				sender: { login: 'swarm-rev' },
			});
			if (!event) throw new Error('expected pull_request_review to parse');

			const result = await handler.handle(
				createMockScmTriggerContext({ project: PROJECT, scm: SCM, event }),
			);
			expect(result).toMatchObject({ phase: 'respond-to-review', headSha: HEAD_SHA });
		});

		it('recovers a parsed review webhook with neither SHA source from the verdict ledger', async () => {
			const event = parseGitHubWebhook('pull_request_review', {
				action: 'submitted',
				repository: { full_name: PROJECT.repo },
				pull_request: { number: 17, head: { ref: 'issue-17' } },
				review: { id: 555, state: 'changes_requested' },
				sender: { login: 'swarm-rev' },
			});
			if (!event) throw new Error('expected pull_request_review to parse');

			expect(
				await handler.handle(createMockScmTriggerContext({ project: PROJECT, scm: SCM, event })),
			).toMatchObject({ phase: 'respond-to-review', headSha: HEAD_SHA });
		});

		it('re-dispatches the same review once on a prioritized continuation retry', async () => {
			const result = await handler.handle({
				...ctx(),
				continuationDispatchClaimed: true,
			});
			expect(result).toEqual({
				phase: 'respond-to-review',
				taskId: '17-respond',
				prNumber: '17',
				prBranch: 'issue-17',
				reviewId: '555',
				headSha: HEAD_SHA,
			});
		});

		it('dispatches when no pipeline config is present', async () => {
			const result = await handler.handle({ ...ctx(), project: createMockProjectConfig() });
			expect(result).toMatchObject({ phase: 'respond-to-review', prNumber: '17' });
		});

		it('skips when Respond-to-review is disabled', async () => {
			const project = createMockProjectConfig({
				pipeline: { respondToReview: { enabled: false } },
			});
			expect(await handler.handle({ ...ctx(), project })).toBeNull();
		});

		it('skips approved and comment-only reviewer-persona reviews by default', async () => {
			expect(await handler.handle(ctx({ reviewState: 'approved' }))).toBeNull();
			expect(await handler.handle(ctx({ reviewState: 'commented' }))).toBeNull();
		});

		it('dispatches every reviewer-persona verdict when skipOnMinors is disabled', async () => {
			const project = createMockProjectConfig({
				pipeline: { respondToReview: { skipOnMinors: false } },
			});
			const result = await handler.handle({
				...ctx({ reviewState: 'approved' }),
				project,
			});
			expect(result).toMatchObject({ phase: 'respond-to-review', prNumber: '17' });
		});

		it('skips a review authored by a human', async () => {
			expect(await handler.handle(ctx({ actorLogin: 'a-human' }))).toBeNull();
		});

		it('skips a review authored by the implementer persona', async () => {
			expect(await handler.handle(ctx({ actorLogin: 'swarm-impl' }))).toBeNull();
		});

		it('recognizes a [bot]-suffixed reviewer login', async () => {
			const result = await handler.handle(ctx({ actorLogin: 'swarm-rev[bot]' }));
			expect(result).toMatchObject({ phase: 'respond-to-review', prNumber: '17' });
		});

		it('skips when the webhook coordinates that cannot be recovered are incomplete', async () => {
			expect(await handler.handle(ctx({ prBranch: undefined }))).toBeNull();
			expect(await handler.handle(ctx({ reviewId: undefined }))).toBeNull();
		});

		it('skips a missing-SHA review only when its verdict ledger record is unavailable', async () => {
			const noRecordHandler = createRespondToReviewTrigger({
				getReviewVerdictByReviewId: vi.fn(async () => undefined),
				getReviewVerdictByHead: vi.fn(async () => undefined),
			});
			expect(await noRecordHandler.handle(ctx({ headSha: undefined }))).toBeNull();
		});

		it('skips when the review has no author', async () => {
			expect(await handler.handle(ctx({ actorLogin: undefined }))).toBeNull();
		});
	});

	describe('review-verdict safety cap (issue #235)', () => {
		it('stops the cycle on the cap-reaching changes-requested verdict', async () => {
			const getReviewVerdictByReviewId = vi.fn(async () => ({
				ordinal: REVIEW_VERDICT_CAP,
				state: 'submitted' as const,
				verdict: 'request-changes',
				headSha: HEAD_SHA,
			}));
			const cappedHandler = createRespondToReviewTrigger({
				getReviewVerdictByReviewId,
				getReviewVerdictByHead: vi.fn(async () => undefined),
			});
			expect(await cappedHandler.handle(ctx())).toBeNull();
		});

		it('dispatches the first changes-requested verdict (ordinal 1 is not capped)', async () => {
			const result = await handler.handle(ctx());
			expect(result).toMatchObject({ phase: 'respond-to-review', prNumber: '17' });
			expect(getReviewVerdictByReviewId).toHaveBeenCalledWith(PROJECT.id, PROJECT.repo, '555');
		});

		it('falls back to the PR/head lookup when the review id is not yet in the ledger', async () => {
			const byReviewId = vi.fn(async () => undefined);
			const byHead = vi.fn(async () => ({
				ordinal: REVIEW_VERDICT_CAP,
				state: 'submitted' as const,
				verdict: 'request-changes',
				headSha: HEAD_SHA,
			}));
			const cappedHandler = createRespondToReviewTrigger({
				getReviewVerdictByReviewId: byReviewId,
				getReviewVerdictByHead: byHead,
			});
			expect(await cappedHandler.handle(ctx())).toBeNull();
			expect(byHead).toHaveBeenCalledWith(PROJECT.id, PROJECT.repo, '17', HEAD_SHA);
		});

		it('falls back to mapping reviewState when record.verdict is null/undefined (webhook race)', async () => {
			const byReviewId = vi.fn(async () => undefined);
			const byHead = vi.fn(async () => ({
				ordinal: REVIEW_VERDICT_CAP,
				state: 'pending' as const,
				verdict: null,
				headSha: HEAD_SHA,
			}));
			const cappedHandler = createRespondToReviewTrigger({
				getReviewVerdictByReviewId: byReviewId,
				getReviewVerdictByHead: byHead,
			});
			expect(await cappedHandler.handle(ctx({ reviewState: 'changes-requested' }))).toBeNull();
			expect(byHead).toHaveBeenCalledWith(PROJECT.id, PROJECT.repo, '17', HEAD_SHA);
		});

		it('fails closed (skips) when no ledger record is found for a changes-requested event', async () => {
			const noRecordHandler = createRespondToReviewTrigger({
				getReviewVerdictByReviewId: vi.fn(async () => undefined),
				getReviewVerdictByHead: vi.fn(async () => undefined),
			});
			expect(await noRecordHandler.handle(ctx())).toBeNull();
		});

		it('fails closed (skips) when the ledger lookup throws', async () => {
			const throwingHandler = createRespondToReviewTrigger({
				getReviewVerdictByReviewId: vi.fn(async () => {
					throw new Error('connection reset');
				}),
				getReviewVerdictByHead: vi.fn(async () => undefined),
			});
			expect(await throwingHandler.handle(ctx())).toBeNull();
		});

		it('does not consult the ledger for a non-changes-requested verdict', async () => {
			const project = createMockProjectConfig({
				pipeline: { respondToReview: { skipOnMinors: false } },
			});
			const byReviewId = vi.fn(async () => undefined);
			const noopHandler = createRespondToReviewTrigger({
				getReviewVerdictByReviewId: byReviewId,
				getReviewVerdictByHead: vi.fn(async () => undefined),
			});
			const result = await noopHandler.handle({ ...ctx({ reviewState: 'approved' }), project });
			expect(result).toMatchObject({ phase: 'respond-to-review' });
			expect(byReviewId).not.toHaveBeenCalled();
		});
	});
});
