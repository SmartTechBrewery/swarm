import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { AggregateCheckStatus } from '@/scm/types.js';
import { createReviewTrigger } from '@/triggers/handlers/review.js';
import type { TriggerContext } from '@/triggers/types.js';
import {
	createFakeScmProvider,
	createMockProjectConfig,
	createMockProjectRepositoryPair,
	createMockScmEvent,
	createMockScmTriggerContext,
} from '../../../helpers/factories.js';

// The handler gates dispatch on a Redis-backed dedup claim; mock it so these
// tests stay pure-in-memory. `claimReviewDispatch` defaults to granting the
// claim (the common path); individual tests flip it to exercise a skip.
const { claimReviewDispatch } = vi.hoisted(() => ({ claimReviewDispatch: vi.fn() }));
vi.mock('@/triggers/review-dispatch-dedup.js', () => ({
	claimReviewDispatch,
	buildReviewDispatchKey: (repo: string, prNumber: string, headSha: string) =>
		`${repo}:${prNumber}:${headSha}`,
}));

// Mock the conflict resolution dedup module to prevent Redis connection.
const { claimConflictResolution } = vi.hoisted(() => ({ claimConflictResolution: vi.fn() }));
vi.mock('@/triggers/resolve-conflicts-dedup.js', () => ({
	claimConflictResolution,
	buildConflictResolutionKey: (repo: string, prNumber: string, headSha: string, baseSha: string) =>
		`${repo}:${prNumber}:${headSha}:${baseSha}`,
}));

// The respond-to-ci path also applies a per-PR fix-attempt cap; mock it so these
// tests need no Redis. Defaults to allowing the attempt; a test flips it to
// exercise the cap.
const { claimRespondToCiAttempt } = vi.hoisted(() => ({ claimRespondToCiAttempt: vi.fn() }));
vi.mock('@/triggers/respond-to-ci-attempts.js', () => ({
	claimRespondToCiAttempt,
	buildRespondToCiAttemptKey: (repo: string, prNumber: string) => `${repo}:${prNumber}`,
}));

// A `checks` event re-queries aggregate CI state and may schedule a coalesced
// recheck. The CI/PR/comment reads are stubs on the injected `SCMProvider` — no
// GitHub module is mocked, so a handler that reached around the contract would
// stop type-checking — and only the dispatcher is module-mocked (it needs Redis).
const {
	getAggregateCheckStatus,
	scheduleCoalescedJob,
	hasPersonaToken,
	getPullRequest,
	commentOnPullRequest,
} = vi.hoisted(() => ({
	getAggregateCheckStatus: vi.fn(),
	scheduleCoalescedJob: vi.fn(),
	hasPersonaToken: vi.fn(),
	getPullRequest: vi.fn(),
	commentOnPullRequest: vi.fn(),
}));
vi.mock('@/dispatch/dispatcher.js', () => ({ scheduleCoalescedDispatch: scheduleCoalescedJob }));

const SCM = createFakeScmProvider({
	getAggregateCheckStatus,
	hasPersonaToken,
	getPullRequest,
	commentOnPullRequest,
});

const { loggerWarn, loggerDebug } = vi.hoisted(() => ({
	loggerWarn: vi.fn(),
	loggerDebug: vi.fn(),
}));
vi.mock('@/lib/logger.js', () => ({
	logger: {
		warn: loggerWarn,
		debug: loggerDebug,
		info: vi.fn(),
		error: vi.fn(),
	},
}));

// The work-item origin gate (issue #397) reads run history; mock just that read
// (keeping the real `isSwarmManagedPullRequest`, so the PR's head branch really
// has to decode under the project's `branchPrefix`). Defaults to "SWARM ran
// Implementation for this item" — the common path.
const { hasRunForTask } = vi.hoisted(() => ({ hasRunForTask: vi.fn() }));
vi.mock('@/db/repositories/runsRepository.js', async (importActual) => ({
	...(await importActual<typeof import('@/db/repositories/runsRepository.js')>()),
	hasRunForTask,
}));

// The `review` disposition reserves a durable safety-cap slot before
// dispatching (issue #235); mock the ledger so these tests need no database.
// Defaults to granting a fresh reservation (the common path); individual
// tests flip it to exercise `blocked`/`capped`/a persistence error.
const { reserveReviewVerdict } = vi.hoisted(() => ({ reserveReviewVerdict: vi.fn() }));
vi.mock('@/db/repositories/reviewVerdictsRepository.js', () => ({
	reserveReviewVerdict,
	REVIEW_VERDICT_CAP: 3,
}));

/** Build an `AggregateCheckStatus` from `[name, status, conclusion]` triples. */
function checkStatus(runs: Array<[string, string, string | null]>): AggregateCheckStatus {
	return {
		totalCount: runs.length,
		checkRuns: runs.map(([name, status, conclusion]) => ({ name, status, conclusion })),
	};
}

beforeEach(() => {
	claimReviewDispatch.mockReset();
	claimReviewDispatch.mockResolvedValue(true);
	claimRespondToCiAttempt.mockReset();
	claimRespondToCiAttempt.mockResolvedValue({ allowed: true, attempt: 1 });
	claimConflictResolution.mockReset();
	claimConflictResolution.mockResolvedValue(true);
	getAggregateCheckStatus.mockReset();
	scheduleCoalescedJob.mockReset();
	// Ownership-gate default: SWARM has an Implementation run for the work item the
	// PR's branch decodes to. Tests flip it to exercise an unrelated PR or a
	// run-history lookup failure.
	hasRunForTask.mockReset();
	hasRunForTask.mockResolvedValue(true);
	reserveReviewVerdict.mockReset();
	reserveReviewVerdict.mockResolvedValue({ status: 'reserved', id: 'v1', ordinal: 1 });
	hasPersonaToken.mockReset();
	hasPersonaToken.mockResolvedValue(true);
	getPullRequest.mockReset();
	// `issue-42` matches `createMockProjectConfig()`'s `branchPrefix`, so the
	// ownership gate resolves this PR to work item 42. `authorLogin` is a plain
	// user account on purpose: under the federated model that is what a SWARM PR
	// looks like (issue #397).
	getPullRequest.mockResolvedValue({
		number: 42,
		headBranch: 'issue-42',
		headSha: 'head-sha-123',
		baseBranch: 'main',
		baseSha: 'base-sha-123',
		mergeable: true,
		authorLogin: 'operator-human',
	});
	commentOnPullRequest.mockReset();
});

const PROJECT = createMockProjectConfig();
const handler = createReviewTrigger();

function ctx(
	overrides: Partial<Parameters<typeof createMockScmEvent>[0]> = {},
	extra: {
		recheckAttempt?: number;
		readFailureRecheckAttempt?: number;
		deliveryId?: string;
		continuationDispatchClaimed?: boolean;
	} = {},
): TriggerContext {
	return createMockScmTriggerContext({
		project: PROJECT,
		scm: SCM,
		event: createMockScmEvent(overrides),
		...extra,
	});
}

describe('review trigger', () => {
	describe('matches', () => {
		it('matches a PR opened', () => {
			expect(handler.matches(ctx({ kind: 'pull-request', action: 'opened' }))).toBe(true);
		});

		it('matches a completed check suite', () => {
			expect(handler.matches(ctx({ kind: 'checks', action: 'completed' }))).toBe(true);
		});

		it('ignores other PR actions', () => {
			expect(handler.matches(ctx({ kind: 'pull-request', action: 'closed' }))).toBe(false);
		});

		it('ignores a projects source', () => {
			const projectsCtx = {
				project: PROJECT,
				source: 'github-projects',
				event: { eventType: 'projects_v2_item' },
			} as unknown as TriggerContext;
			expect(handler.matches(projectsCtx)).toBe(false);
		});
	});

	describe('handle — pull-request opened', () => {
		const base = {
			kind: 'pull-request',
			action: 'opened',
			workItemId: '42',
			prAuthorLogin: 'operator-human',
		} as const;

		it('dispatches Review for a non-draft same-repo PR linked to a SWARM work item', async () => {
			const result = await handler.handle(
				ctx({ ...base, headSha: 'abc123', isDraft: false, isCrossRepo: false }),
			);
			expect(result).toEqual({
				phase: 'review',
				taskId: '42',
				prNumber: '42',
				// Carried from the PR the mergeability gate already fetched, so the
				// automation-label gate can resolve the backing board item (issue #354).
				prBranch: 'issue-42',
				headSha: 'abc123',
			});
		});

		it('dispatches when no pipeline config is present', async () => {
			const project = createMockProjectConfig({ pipeline: undefined });
			const result = await handler.handle({
				...ctx({ ...base, headSha: 'abc123', isDraft: false, isCrossRepo: false }),
				project,
			});
			expect(result).toMatchObject({ phase: 'review', prNumber: '42' });
		});

		it('skips before the ownership gate when Review is disabled', async () => {
			const project = createMockProjectConfig({
				pipeline: { review: { enabled: false }, respondToReview: { enabled: false } },
			});
			expect(
				await handler.handle({
					...ctx({ ...base, headSha: 'abc123', isDraft: false, isCrossRepo: false }),
					project,
				}),
			).toBeNull();
			expect(hasRunForTask).not.toHaveBeenCalled();
		});

		it('skips a draft PR', async () => {
			expect(await handler.handle(ctx({ ...base, headSha: 'abc', isDraft: true }))).toBeNull();
		});

		it('skips a fork PR', async () => {
			expect(await handler.handle(ctx({ ...base, headSha: 'abc', isCrossRepo: true }))).toBeNull();
		});

		it('dispatches Review for a PR authored by a plain user account (federated worker)', async () => {
			// The federated implementer identity is the operator's own GitHub account
			// (issue #397): branch + run history, not authorship, decide ownership.
			const result = await handler.handle(
				ctx({ ...base, headSha: 'abc', isCrossRepo: false, prAuthorLogin: 'operator-human' }),
			);
			expect(result).toMatchObject({ phase: 'review', prNumber: '42', headSha: 'abc' });
			expect(hasRunForTask).toHaveBeenCalledWith(PROJECT.id, '42', 'implementation');
		});

		it('skips a PR on a human-named branch', async () => {
			getPullRequest.mockResolvedValue({
				number: 42,
				headBranch: 'contributor-patch',
				headSha: 'abc',
				baseBranch: 'main',
				baseSha: 'base-sha-123',
				mergeable: true,
				authorLogin: 'a-human',
			});
			const result = await handler.handle(ctx({ ...base, headSha: 'abc', isCrossRepo: false }));
			expect(result).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			// A branch outside the prefix is a definitive no — no run-history query.
			expect(hasRunForTask).not.toHaveBeenCalled();
		});

		it('skips a PR on a SWARM-style branch with no Implementation run', async () => {
			hasRunForTask.mockResolvedValue(false);
			const result = await handler.handle(ctx({ ...base, headSha: 'abc', isCrossRepo: false }));
			expect(result).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
		});

		it('degrades to a bounded recheck when the ownership lookup throws', async () => {
			// A transient DB blip must not silently drop a legitimate review — it
			// defers, like a failed mergeability fetch. The lookup *failed*, so it
			// spends the read-failure budget, not the CI-lag one (issue #720).
			hasRunForTask.mockRejectedValue(new Error('connection reset'));
			const result = await handler.handle(
				ctx({ ...base, headSha: 'abc', isCrossRepo: false }, { deliveryId: 'd-7' }),
			);
			expect(result).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
			expect(scheduleCoalescedJob.mock.calls[0][0]).toMatchObject({
				readFailureRecheckAttempt: 1,
				deliveryId: 'd-7',
			});
			expect(scheduleCoalescedJob.mock.calls[0][0]).not.toHaveProperty('recheckAttempt');
		});

		it('skips when no head SHA is present', async () => {
			expect(await handler.handle(ctx({ ...base, isCrossRepo: false }))).toBeNull();
		});

		it('does not query check state for a PR event', async () => {
			await handler.handle(ctx({ ...base, headSha: 'abc123', isDraft: false, isCrossRepo: false }));
			expect(getAggregateCheckStatus).not.toHaveBeenCalled();
		});
	});

	describe('handle — check_suite', () => {
		const base = { kind: 'checks', action: 'completed', workItemId: '9' } as const;

		it('dispatches Review when all checks completed and none failed', async () => {
			getAggregateCheckStatus.mockResolvedValue(
				checkStatus([
					['build', 'completed', 'success'],
					['test', 'completed', 'success'],
				]),
			);
			const result = await handler.handle(ctx({ ...base, headSha: 'cafe' }));
			expect(result).toEqual({
				phase: 'review',
				taskId: '9',
				prNumber: '9',
				// The fetched PR's head branch (the default mock's), not the event's.
				prBranch: 'issue-42',
				headSha: 'cafe',
			});
			// The ownership gate ran off the fetched PR's head branch — no extra
			// author round trip on this path any more.
			expect(hasRunForTask).toHaveBeenCalledWith(PROJECT.id, '42', 'implementation');
			// The aggregate query goes through the provider contract, which reads under
			// its own documented default persona (the reviewer), so the reviewer identity
			// stays independent of the PR's author (PROJECT.md §5.3).
			expect(getAggregateCheckStatus).toHaveBeenCalledWith(
				expect.objectContaining({ id: PROJECT.id }),
				'cafe',
			);
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('defers on zero checks by default (required policy)', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { deliveryId: 'd-3' })),
			).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
			expect(scheduleCoalescedJob.mock.calls[0][0]).toMatchObject({
				recheckAttempt: 1,
				deliveryId: 'd-3',
			});
		});

		it('dispatches exactly one Review on zero checks when the project opts into if-present', async () => {
			// This is the shape `scheduleFollowUpReviewDefault` enqueues after a
			// fixed Respond-to-review response (`src/pipeline/follow-up-review.ts`):
			// a synthetic `check_suite completed` carrying only the new head SHA and
			// PR branch, no check-run data of its own — the real decision happens
			// here once the handler re-queries live Actions-API state (issue #274).
			getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
			const project = createMockProjectConfig({ pipeline: { review: { checks: 'if-present' } } });
			const result = await handler.handle({
				...ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' }),
				project,
			});
			expect(result).toEqual({
				phase: 'review',
				taskId: '9',
				prNumber: '9',
				// The fetched PR's head branch (the default mock's), not the event's.
				prBranch: 'issue-42',
				headSha: 'cafe',
			});
			expect(claimReviewDispatch).toHaveBeenCalledTimes(1);
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('the PR/SHA dispatch dedup still guards a duplicate follow-up event under if-present', async () => {
			// A second delivery of the same follow-up event (retry, or a sibling
			// check_suite for the same commit) must not burn a second Review.
			claimReviewDispatch.mockResolvedValue(false);
			getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
			const project = createMockProjectConfig({ pipeline: { review: { checks: 'if-present' } } });
			const result = await handler.handle({
				...ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' }),
				project,
			});
			expect(result).toBeNull();
			expect(reserveReviewVerdict).not.toHaveBeenCalled();
		});

		it('still defers a present but incomplete check under if-present', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));
			const project = createMockProjectConfig({ pipeline: { review: { checks: 'if-present' } } });
			expect(await handler.handle({ ...ctx({ ...base, headSha: 'cafe' }), project })).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
		});

		it('still routes a present failed check to Respond-to-CI under if-present', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			const project = createMockProjectConfig({ pipeline: { review: { checks: 'if-present' } } });
			const result = await handler.handle({
				...ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' }),
				project,
			});
			expect(result).toEqual({
				phase: 'respond-to-ci',
				taskId: '9-ci',
				prNumber: '9',
				prBranch: 'issue-9',
				headSha: 'cafe',
			});
		});

		it('skips a PR on a SWARM-style branch with no Implementation run and logs warn', async () => {
			hasRunForTask.mockResolvedValue(false);
			getPullRequest.mockResolvedValueOnce({
				number: 9,
				headBranch: 'issue-9',
				headSha: 'cafe',
				baseBranch: 'main',
				baseSha: 'base123',
				mergeable: true,
				authorLogin: 'operator-human',
			});
			const result = await handler.handle(ctx({ ...base, headSha: 'cafe' }));
			expect(result).toBeNull();
			// Gated before the (heavier) Actions-API call, and no dispatch claimed.
			expect(getAggregateCheckStatus).not.toHaveBeenCalled();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
			expect(loggerWarn).toHaveBeenCalledWith(
				expect.stringContaining('no Implementation run row'),
				expect.objectContaining({ prBranch: 'issue-9', taskId: '9' }),
			);
		});

		it('skips a PR on a non-task branch and logs debug', async () => {
			getPullRequest.mockResolvedValueOnce({
				number: 9,
				headBranch: 'contributor-patch',
				headSha: 'cafe',
				baseBranch: 'main',
				baseSha: 'base123',
				mergeable: true,
				authorLogin: 'operator-human',
			});
			const result = await handler.handle(ctx({ ...base, headSha: 'cafe' }));
			expect(result).toBeNull();
			expect(loggerDebug).toHaveBeenCalledWith(
				expect.stringContaining('not linked to a SWARM work item'),
				expect.objectContaining({ prBranch: 'contributor-patch' }),
			);
		});

		it('degrades to a bounded recheck when the ownership lookup throws', async () => {
			// A transient error determining ownership must not drop a legit review;
			// it defers, like a failed aggregate query — on the read-failure budget.
			hasRunForTask.mockRejectedValue(new Error('connection reset'));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { deliveryId: 'd-2' })),
			).toBeNull();
			expect(getAggregateCheckStatus).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
			expect(scheduleCoalescedJob.mock.calls[0][0]).toMatchObject({
				readFailureRecheckAttempt: 1,
				deliveryId: 'd-2',
			});
		});

		it('dispatches Respond-to-CI when a check failed', async () => {
			getAggregateCheckStatus.mockResolvedValue(
				checkStatus([
					['build', 'completed', 'success'],
					['test', 'completed', 'failure'],
				]),
			);
			const result = await handler.handle(ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' }));
			expect(result).toEqual({
				phase: 'respond-to-ci',
				taskId: '9-ci',
				prNumber: '9',
				prBranch: 'issue-9',
				headSha: 'cafe',
			});
			// Same PR+SHA dedup slot as review, plus the per-PR attempt cap.
			expect(claimReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:9:cafe`, 'pr-review', {
				prNumber: '9',
				headSha: 'cafe',
			});
			expect(claimRespondToCiAttempt).toHaveBeenCalledWith(`${PROJECT.repo}:9`, {
				prNumber: '9',
				headSha: 'cafe',
			});
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('reuses both held claims on a prioritized Respond-to-CI retry', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));

			const result = await handler.handle(
				ctx(
					{ ...base, headSha: 'cafe', prBranch: 'issue-9' },
					{ continuationDispatchClaimed: true },
				),
			);

			expect(result).toEqual({
				phase: 'respond-to-ci',
				taskId: '9-ci',
				prNumber: '9',
				prBranch: 'issue-9',
				headSha: 'cafe',
			});
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
		});

		it('skips Respond-to-CI when the phase is disabled', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			const project = createMockProjectConfig({ pipeline: { respondToCi: { enabled: false } } });
			expect(
				await handler.handle({
					...ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' }),
					project,
				}),
			).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
		});

		it('does not dispatch Respond-to-CI when the PR+SHA slot is already claimed', async () => {
			claimReviewDispatch.mockResolvedValue(false);
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' })),
			).toBeNull();
			expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
		});

		it('drops the CI-fix dispatch once the per-PR attempt cap is hit', async () => {
			claimRespondToCiAttempt.mockResolvedValue({ allowed: false, attempt: 4 });
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' })),
			).toBeNull();
		});

		it('skips Respond-to-CI when the check suite carries no PR branch', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			// prBranch absent — the fix phase would have no branch to check out.
			expect(await handler.handle(ctx({ ...base, headSha: 'cafe' }))).toBeNull();
			expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
		});

		it('defers and schedules a coalesced recheck when a check is still running', async () => {
			getAggregateCheckStatus.mockResolvedValue(
				checkStatus([
					['build', 'completed', 'success'],
					['test', 'in_progress', null],
				]),
			);
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { deliveryId: 'd-1' })),
			).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
			const [job, coalesceKey, delayMs] = scheduleCoalescedJob.mock.calls[0];
			expect(coalesceKey).toBe(`check-suite:${PROJECT.repo}:9:cafe`);
			expect(delayMs).toBe(30_000);
			expect(job).toMatchObject({
				type: 'scm',
				providerId: 'github',
				projectId: PROJECT.id,
				deliveryId: 'd-1',
				recheckAttempt: 1,
			});
		});

		it('increments recheckAttempt across successive rechecks', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'queued', null]]));
			await handler.handle(ctx({ ...base, headSha: 'cafe' }, { recheckAttempt: 4 }));
			expect(scheduleCoalescedJob.mock.calls[0][0]).toMatchObject({ recheckAttempt: 5 });
		});

		it('stops rescheduling once the recheck cap is reached', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { recheckAttempt: 20 })),
			).toBeNull();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('degrades to a bounded recheck when the aggregate query throws', async () => {
			// A transient Actions-API error (or an unresolvable reviewer token) must
			// not escape the handler — that would fail the job and burn its BullMQ
			// retries. It defers a recheck instead, on the read-failure budget.
			getAggregateCheckStatus.mockRejectedValue(new Error('502 Bad Gateway'));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { deliveryId: 'd-9' })),
			).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
			const [job, coalesceKey] = scheduleCoalescedJob.mock.calls[0];
			expect(coalesceKey).toBe(`check-suite:${PROJECT.repo}:9:cafe`);
			expect(job).toMatchObject({ readFailureRecheckAttempt: 1, deliveryId: 'd-9' });
		});

		it('degrades to a bounded recheck when the reviewer token cannot be resolved', async () => {
			// The provider throws before the API call when the persona's token is
			// unconfigured — same degrade path, no job failure.
			getAggregateCheckStatus.mockRejectedValue(new Error('no reviewer token configured'));
			expect(await handler.handle(ctx({ ...base, headSha: 'cafe' }))).toBeNull();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
		});

		it('gives up (no reschedule) when the query keeps failing past the read-failure cap', async () => {
			getAggregateCheckStatus.mockRejectedValue(new Error('still 502'));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { readFailureRecheckAttempt: 15 })),
			).toBeNull();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(loggerWarn).toHaveBeenCalledWith(
				expect.stringContaining('giving up on deferred recheck'),
				expect.objectContaining({ budget: 'read-failed', cap: 15 }),
			);
		});

		it('skips a suite with no associated PR (no query)', async () => {
			expect(
				await handler.handle(
					ctx({
						kind: 'checks',
						action: 'completed',
						workItemId: undefined,
						headSha: 'cafe',
					}),
				),
			).toBeNull();
			expect(getAggregateCheckStatus).not.toHaveBeenCalled();
		});

		it('skips a suite with no head SHA (no query)', async () => {
			expect(await handler.handle(ctx({ ...base, headSha: undefined }))).toBeNull();
			expect(getAggregateCheckStatus).not.toHaveBeenCalled();
		});
	});

	describe('handle — dedup gate', () => {
		const reviewable = {
			kind: 'pull-request',
			action: 'opened',
			workItemId: '42',
			headSha: 'abc123',
			isDraft: false,
			isCrossRepo: false,
			prAuthorLogin: 'operator-human',
		} as const;

		it('claims the PR+SHA slot before dispatching', async () => {
			await handler.handle(ctx(reviewable));
			expect(claimReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:42:abc123`, 'pr-review', {
				prNumber: '42',
				headSha: 'abc123',
			});
		});

		it('skips dispatch when the slot is already claimed (or Redis is down)', async () => {
			claimReviewDispatch.mockResolvedValue(false);
			expect(await handler.handle(ctx(reviewable))).toBeNull();
		});

		it('does not claim for an unreviewable event', async () => {
			await handler.handle(ctx({ ...reviewable, isDraft: true }));
			expect(claimReviewDispatch).not.toHaveBeenCalled();
		});

		it('reuses the held claim (no re-claim) for a prioritized continuation retry', async () => {
			// A concurrency-deferred Review carries `continuationDispatchClaimed`: the
			// PR+SHA claim is already held (refreshed) from its original dispatch, so
			// re-claiming within that TTL would drop this retry as a duplicate (#214).
			const result = await handler.handle(ctx(reviewable, { continuationDispatchClaimed: true }));

			expect(result).toEqual({
				phase: 'review',
				taskId: '42',
				prNumber: '42',
				prBranch: 'issue-42',
				headSha: 'abc123',
			});
			expect(claimReviewDispatch).not.toHaveBeenCalled();
		});

		it('still claims when the continuation flag is absent (unchanged behavior)', async () => {
			await handler.handle(ctx(reviewable));
			expect(claimReviewDispatch).toHaveBeenCalledOnce();
		});
	});

	describe('handle — durable review-verdict reservation (issue #235)', () => {
		const reviewable = {
			kind: 'pull-request',
			action: 'opened',
			workItemId: '42',
			headSha: 'abc123',
			isDraft: false,
			isCrossRepo: false,
			prAuthorLogin: 'operator-human',
		} as const;

		it('reserves the PR/head slot after the dispatch claim, before dispatching', async () => {
			const result = await handler.handle(ctx(reviewable));
			expect(result).toEqual({
				phase: 'review',
				taskId: '42',
				prNumber: '42',
				prBranch: 'issue-42',
				headSha: 'abc123',
			});
			expect(reserveReviewVerdict).toHaveBeenCalledWith({
				projectId: PROJECT.id,
				repository: PROJECT.repo,
				prNumber: '42',
				headSha: 'abc123',
			});
		});

		it('skips the dispatch when another head is still pending (blocked)', async () => {
			reserveReviewVerdict.mockResolvedValue({ status: 'blocked', ordinal: 1 });
			expect(await handler.handle(ctx(reviewable))).toBeNull();
		});

		it('skips the dispatch once every permitted verdict is submitted (capped)', async () => {
			reserveReviewVerdict.mockResolvedValue({ status: 'capped' });
			expect(await handler.handle(ctx(reviewable))).toBeNull();
		});

		it('reuses a same-head retry reservation and still dispatches', async () => {
			reserveReviewVerdict.mockResolvedValue({
				status: 'reused',
				id: 'v1',
				ordinal: 1,
				state: 'pending',
			});
			const result = await handler.handle(ctx(reviewable));
			expect(result).toMatchObject({ phase: 'review' });
		});

		it('skips the dispatch when a same-head retry is already submitted', async () => {
			reserveReviewVerdict.mockResolvedValue({
				status: 'reused',
				id: 'v1',
				ordinal: 1,
				state: 'submitted',
			});
			expect(await handler.handle(ctx(reviewable))).toBeNull();
		});

		it('fails closed (skips) when the reservation call throws', async () => {
			reserveReviewVerdict.mockRejectedValue(new Error('connection reset'));
			expect(await handler.handle(ctx(reviewable))).toBeNull();
		});

		it('does not reserve a slot for the Respond-to-CI disposition', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			const result = await handler.handle(
				ctx({
					kind: 'checks',
					action: 'completed',
					workItemId: '9',
					headSha: 'cafe',
					prBranch: 'issue-9',
				}),
			);
			expect(result).toMatchObject({ phase: 'respond-to-ci' });
			expect(reserveReviewVerdict).not.toHaveBeenCalled();
		});
	});

	describe('handle — mergeability and conflict triggers (issue #265)', () => {
		const synchronized = {
			kind: 'pull-request',
			action: 'updated',
			workItemId: '42',
			headSha: 'abc123',
			isDraft: false,
			isCrossRepo: false,
			prAuthorLogin: 'operator-human',
		} as const;

		it('transitions to Resolve-conflicts immediately when mergeable is false (conflicting)', async () => {
			getPullRequest.mockResolvedValue({
				number: 42,
				headBranch: 'issue-42',
				headSha: 'abc123',
				baseBranch: 'main',
				baseSha: 'base123',
				mergeable: false,
				authorLogin: 'operator-human',
			});

			const result = await handler.handle(ctx(synchronized));

			expect(result).toEqual({
				phase: 'resolve-conflicts',
				taskId: '42-conflicts',
				prNumber: '42',
				prBranch: 'issue-42',
				headSha: 'abc123',
				baseBranch: 'main',
				baseSha: 'base123',
			});
		});

		it('skips (returns null) on synchronize event when PR is mergeable (true)', async () => {
			getPullRequest.mockResolvedValue({
				number: 42,
				headBranch: 'issue-42',
				headSha: 'abc123',
				baseBranch: 'main',
				baseSha: 'base123',
				mergeable: true,
				authorLogin: 'operator-human',
			});

			const result = await handler.handle(ctx(synchronized));
			expect(result).toBeNull();
		});

		it('schedules a deferred mergeability recheck when mergeable is null (unknown)', async () => {
			getPullRequest.mockResolvedValue({
				number: 42,
				headBranch: 'issue-42',
				headSha: 'abc123',
				baseBranch: 'main',
				baseSha: 'base123',
				mergeable: null,
				authorLogin: 'operator-human',
			});

			const result = await handler.handle(ctx(synchronized));
			expect(result).toBeNull();
			expect(scheduleCoalescedJob).toHaveBeenCalledWith(
				expect.objectContaining({
					recheckAttempt: 1,
					event: expect.objectContaining({
						kind: 'pull-request',
						action: 'updated',
					}),
				}),
				'review-mergeability:SmartTechBrewery/swarm:42:abc123:pull-request',
				30000,
			);
		});

		it('keeps a checks-event mergeability recheck when a PR update arrives for the same head', async () => {
			getPullRequest.mockResolvedValue({
				number: 42,
				headBranch: 'issue-42',
				headSha: 'abc123',
				baseBranch: 'main',
				baseSha: 'base123',
				mergeable: null,
				authorLogin: 'operator-human',
			});

			await handler.handle(
				ctx({
					kind: 'checks',
					action: 'completed',
					workItemId: '42',
					headSha: 'abc123',
					prBranch: 'issue-42',
				}),
			);
			await handler.handle(ctx(synchronized));

			expect(scheduleCoalescedJob).toHaveBeenNthCalledWith(
				1,
				expect.any(Object),
				'review-mergeability:SmartTechBrewery/swarm:42:abc123:checks',
				30000,
			);
			expect(scheduleCoalescedJob).toHaveBeenNthCalledWith(
				2,
				expect.any(Object),
				'review-mergeability:SmartTechBrewery/swarm:42:abc123:pull-request',
				30000,
			);
		});

		it('comments and gives up on mergeability rechecks once cap is reached', async () => {
			getPullRequest.mockResolvedValue({
				number: 42,
				headBranch: 'issue-42',
				headSha: 'abc123',
				baseBranch: 'main',
				baseSha: 'base123',
				mergeable: null,
				authorLogin: 'operator-human',
			});

			const result = await handler.handle(ctx(synchronized, { recheckAttempt: 20 }));
			expect(result).toBeNull();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
			expect(commentOnPullRequest).toHaveBeenCalledWith(
				expect.any(Object),
				42,
				expect.stringContaining('SWARM conflict check needs attention'),
			);
		});
	});
});

/**
 * Separate CI-lag and read-failure recheck budgets (issue #720).
 *
 * The two defer reasons used to share one 20-attempt allowance, so a transient
 * source-control outage drew down the budget reserved for CI that is still
 * running: on PR #694 seventeen of twenty attempts went to a DNS failure, the cap
 * was reached, and the synthetic follow-up Review (`src/pipeline/follow-up-review.ts`)
 * — which has no later webhook to fall back on — was dropped. What is pinned here
 * is the classification: a defer spends the budget its *reason* names, whichever
 * scheduler runs.
 */
describe('review trigger — CI-lag vs read-failure recheck budgets (issue #720)', () => {
	const checks = { kind: 'checks', action: 'completed', workItemId: '9' } as const;
	const updated = {
		kind: 'pull-request',
		action: 'updated',
		workItemId: '42',
		headSha: 'abc123',
		isDraft: false,
		isCrossRepo: false,
		prAuthorLogin: 'operator-human',
	} as const;

	/** The payload of the most recent coalesced reschedule. */
	function lastScheduledJob(): {
		recheckAttempt?: number;
		readFailureRecheckAttempt?: number;
	} {
		const { calls } = scheduleCoalescedJob.mock;
		return calls[calls.length - 1][0];
	}

	/** The delay (third argument) of the most recent coalesced reschedule. */
	function lastScheduledDelay(): number {
		const { calls } = scheduleCoalescedJob.mock;
		return calls[calls.length - 1][2];
	}

	it('still defers a failed read once the CI-lag budget is spent, carrying it through untouched', async () => {
		// The regression: sharing one counter, a spent CI-lag allowance stopped the
		// reschedule outright even though nothing had answered to spend it.
		getPullRequest.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));

		expect(await handler.handle(ctx({ ...checks, headSha: 'cafe' }, { recheckAttempt: 20 }))).toBe(
			null,
		);

		expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
		expect(lastScheduledJob()).toMatchObject({
			recheckAttempt: 20,
			readFailureRecheckAttempt: 1,
		});
	});

	it('spends the read-failure budget when the aggregate query fails, leaving the CI-lag one alone', async () => {
		getAggregateCheckStatus.mockRejectedValue(new Error('502 Bad Gateway'));

		expect(
			await handler.handle(
				ctx({ ...checks, headSha: 'cafe' }, { recheckAttempt: 7, readFailureRecheckAttempt: 2 }),
			),
		).toBeNull();

		expect(lastScheduledJob()).toMatchObject({
			recheckAttempt: 7,
			readFailureRecheckAttempt: 3,
		});
	});

	it('clears the read-failure counter on a defer that did get an answer', async () => {
		// An incomplete check is the provider *answering* — the outage is over, so
		// the read-failure allowance is handed back in full.
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));

		expect(
			await handler.handle(
				ctx({ ...checks, headSha: 'cafe' }, { recheckAttempt: 2, readFailureRecheckAttempt: 6 }),
			),
		).toBeNull();

		const job = lastScheduledJob();
		expect(job).toMatchObject({ recheckAttempt: 3 });
		expect(job).not.toHaveProperty('readFailureRecheckAttempt');
		expect(lastScheduledDelay()).toBe(30_000);
	});

	it('clears it on an unknown-mergeability defer too', async () => {
		getPullRequest.mockResolvedValue({
			number: 42,
			headBranch: 'issue-42',
			headSha: 'abc123',
			baseBranch: 'main',
			baseSha: 'base123',
			mergeable: null,
			authorLogin: 'operator-human',
		});

		expect(await handler.handle(ctx(updated, { readFailureRecheckAttempt: 4 }))).toBeNull();

		const job = lastScheduledJob();
		expect(job).toMatchObject({ recheckAttempt: 1 });
		expect(job).not.toHaveProperty('readFailureRecheckAttempt');
	});

	it('backs off exponentially, capped at 5 minutes, while the read keeps failing', async () => {
		getPullRequest.mockRejectedValue(new Error('ENOTFOUND'));

		for (const [attemptsSpent, expectedDelay] of [
			[0, 30_000],
			[3, 240_000],
			[9, 300_000],
		] as const) {
			scheduleCoalescedJob.mockClear();
			expect(
				await handler.handle(
					ctx({ ...checks, headSha: 'cafe' }, { readFailureRecheckAttempt: attemptsSpent }),
				),
			).toBeNull();
			expect(lastScheduledDelay()).toBe(expectedDelay);
		}
	});

	it('gives up on the mergeability path once the read-failure budget is spent, naming the outage', async () => {
		getPullRequest.mockRejectedValue(new Error('ENOTFOUND'));

		expect(await handler.handle(ctx(updated, { readFailureRecheckAttempt: 15 }))).toBeNull();

		expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		expect(loggerWarn).toHaveBeenCalledWith(
			expect.stringContaining('giving up on deferred recheck'),
			expect.objectContaining({ budget: 'read-failed', cap: 15 }),
		);
		// Best-effort and expected to fail during a real outage (the durable trace
		// is issue #720's phase 2), but its wording must match the reason.
		expect(commentOnPullRequest).toHaveBeenCalledWith(
			expect.any(Object),
			42,
			expect.stringContaining('could not reach the source-control provider'),
		);
	});

	it('keeps the unknown-mergeability wording when the CI-lag budget is what ran out', async () => {
		getPullRequest.mockResolvedValue({
			number: 42,
			headBranch: 'issue-42',
			headSha: 'abc123',
			baseBranch: 'main',
			baseSha: 'base123',
			mergeable: null,
			authorLogin: 'operator-human',
		});

		expect(await handler.handle(ctx(updated, { recheckAttempt: 20 }))).toBeNull();

		expect(commentOnPullRequest).toHaveBeenCalledWith(
			expect.any(Object),
			42,
			expect.stringContaining('SWARM conflict check needs attention'),
		);
	});

	it('carries a follow-up Review through an outage and reviews once the provider answers', async () => {
		// The incident end to end: a synthetic follow-up Review (no later webhook to
		// fall back on) that already spent three CI-lag attempts, then five failed
		// reads, then a provider that comes back with green checks.
		const followUp = { ...checks, headSha: 'newsha', prBranch: 'issue-9' } as const;
		getPullRequest.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));

		let carried: { recheckAttempt?: number; readFailureRecheckAttempt?: number } = {
			recheckAttempt: 3,
		};
		for (let attempt = 0; attempt < 5; attempt++) {
			expect(await handler.handle(ctx(followUp, carried))).toBeNull();
			carried = {
				recheckAttempt: lastScheduledJob().recheckAttempt,
				readFailureRecheckAttempt: lastScheduledJob().readFailureRecheckAttempt,
			};
		}
		expect(carried).toEqual({ recheckAttempt: 3, readFailureRecheckAttempt: 5 });

		getPullRequest.mockResolvedValue({
			number: 9,
			headBranch: 'issue-9',
			headSha: 'newsha',
			baseBranch: 'main',
			baseSha: 'base123',
			mergeable: true,
			authorLogin: 'operator-human',
		});
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['build', 'completed', 'success']]));

		await expect(handler.handle(ctx(followUp, carried))).resolves.toMatchObject({
			phase: 'review',
			prNumber: '9',
			headSha: 'newsha',
		});
	});

	it('leaves a fresh webhook carrying neither counter driving the decision as before', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['build', 'completed', 'success']]));

		await expect(handler.handle(ctx({ ...checks, headSha: 'cafe' }))).resolves.toMatchObject({
			phase: 'review',
			prNumber: '9',
			headSha: 'cafe',
		});
		expect(scheduleCoalescedJob).not.toHaveBeenCalled();
	});
});

/**
 * Two repositories of one project, same PR number (issue #685).
 *
 * A project may hold several repositories since issue #699, and two of them can
 * carry the same PR number for entirely unrelated work. Both keys this handler
 * takes out therefore have to name the repository of the task at hand: a
 * project-wide dedup key would drop the second repository's review as a duplicate
 * of the first's, and a project-wide ledger key would charge it against the first
 * repository's three verdict slots. Both are silent failures, which is why they
 * are asserted rather than left as a property of the wiring.
 *
 * Driven through the handler with the two configs `processJob` itself would hand
 * it — `scopeProjectToRepository` applied to one two-entry record — so what is
 * pinned is the wiring, not the key builders (`buildReviewDispatchKey`'s own
 * repo-keying is pinned in `tests/unit/triggers/review-dispatch-dedup.test.ts`).
 */
describe('review trigger — two repositories of one project (issue #685)', () => {
	const [ANDROID, BACKEND] = createMockProjectRepositoryPair();

	/** The same freshly-opened PR #42, as it arrives for one of the two repositories. */
	function repoCtx(project: ProjectConfig): TriggerContext {
		return createMockScmTriggerContext({
			project,
			scm: SCM,
			event: createMockScmEvent({
				kind: 'pull-request',
				action: 'opened',
				workItemId: '42',
				headSha: 'abc123',
				isDraft: false,
				isCrossRepo: false,
				prAuthorLogin: 'operator-human',
			}),
		});
	}

	it('dispatches both, claiming a dedup slot per repository', async () => {
		await expect(handler.handle(repoCtx(ANDROID))).resolves.toMatchObject({
			phase: 'review',
			prNumber: '42',
		});
		// Not swallowed as a duplicate of the first: the second repository's PR #42 is
		// different work at the same number.
		await expect(handler.handle(repoCtx(BACKEND))).resolves.toMatchObject({
			phase: 'review',
			prNumber: '42',
		});

		const [android, backend] = claimReviewDispatch.mock.calls.map((call) => call[0] as string);
		expect(android).toContain('acme/android');
		expect(backend).toContain('acme/backend');
		expect(backend).not.toBe(android);
	});

	it('reserves a verdict slot per repository under the one project id', async () => {
		await handler.handle(repoCtx(ANDROID));
		await handler.handle(repoCtx(BACKEND));

		expect(reserveReviewVerdict.mock.calls.map(([input]) => input)).toEqual([
			{ projectId: 'acme', repository: 'acme/android', prNumber: '42', headSha: 'abc123' },
			{ projectId: 'acme', repository: 'acme/backend', prNumber: '42', headSha: 'abc123' },
		]);
	});
});
