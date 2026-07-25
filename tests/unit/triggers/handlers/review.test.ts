import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckSuiteStatus } from '@/integrations/scm/github/client.js';
import { createReviewTrigger } from '@/triggers/handlers/review.js';
import type { TriggerContext } from '@/triggers/types.js';
import {
	createMockGitHubParsedEvent,
	createMockProjectConfig,
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

// A `check_suite` event re-queries aggregate CI state and may schedule a
// coalesced recheck — mock both so the tests need neither GitHub nor Redis.
const {
	getCheckSuiteStatus,
	scheduleCoalescedJob,
	withPersonaCredentials,
	hasPersonaToken,
	getPullRequest,
	commentOnPullRequest,
} = vi.hoisted(() => ({
	getCheckSuiteStatus: vi.fn(),
	scheduleCoalescedJob: vi.fn(),
	withPersonaCredentials: vi.fn(),
	hasPersonaToken: vi.fn(),
	getPullRequest: vi.fn(),
	commentOnPullRequest: vi.fn(),
}));
vi.mock('@/integrations/scm/github/client.js', () => ({ getCheckSuiteStatus }));
vi.mock('@/dispatch/dispatcher.js', () => ({ scheduleCoalescedDispatch: scheduleCoalescedJob }));
vi.mock('@/integrations/scm/github/scm-integration.js', () => ({
	GitHubSCMIntegration: class {
		withPersonaCredentials = withPersonaCredentials;
		hasPersonaToken = hasPersonaToken;
		getPullRequest = getPullRequest;
		commentOnPullRequest = commentOnPullRequest;
	},
}));

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

/** Build a `CheckSuiteStatus` from `[name, status, conclusion]` triples. */
function checkStatus(runs: Array<[string, string, string | null]>): CheckSuiteStatus {
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
	getCheckSuiteStatus.mockReset();
	scheduleCoalescedJob.mockReset();
	// The integration just runs the callback under (mocked) credentials.
	withPersonaCredentials.mockReset();
	withPersonaCredentials.mockImplementation(
		(_project: unknown, _persona: unknown, fn: () => Promise<unknown>) => fn(),
	);
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
	overrides: Partial<Parameters<typeof createMockGitHubParsedEvent>[0]> = {},
	extra: {
		recheckAttempt?: number;
		deliveryId?: string;
		continuationDispatchClaimed?: boolean;
	} = {},
): TriggerContext {
	return {
		project: PROJECT,
		source: 'github',
		event: createMockGitHubParsedEvent(overrides),
		...extra,
	};
}

describe('review trigger', () => {
	describe('matches', () => {
		it('matches a PR opened', () => {
			expect(handler.matches(ctx({ eventType: 'pull_request', action: 'opened' }))).toBe(true);
		});

		it('matches a completed check suite', () => {
			expect(handler.matches(ctx({ eventType: 'check_suite', action: 'completed' }))).toBe(true);
		});

		it('ignores other PR actions', () => {
			expect(handler.matches(ctx({ eventType: 'pull_request', action: 'closed' }))).toBe(false);
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

	describe('handle — pull_request opened', () => {
		const base = {
			eventType: 'pull_request',
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
			// defers, like a failed mergeability fetch.
			hasRunForTask.mockRejectedValue(new Error('connection reset'));
			const result = await handler.handle(
				ctx({ ...base, headSha: 'abc', isCrossRepo: false }, { deliveryId: 'd-7' }),
			);
			expect(result).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
			expect(scheduleCoalescedJob.mock.calls[0][0]).toMatchObject({
				recheckAttempt: 1,
				deliveryId: 'd-7',
			});
		});

		it('skips when no head SHA is present', async () => {
			expect(await handler.handle(ctx({ ...base, isCrossRepo: false }))).toBeNull();
		});

		it('does not query check state for a PR event', async () => {
			await handler.handle(ctx({ ...base, headSha: 'abc123', isDraft: false, isCrossRepo: false }));
			expect(getCheckSuiteStatus).not.toHaveBeenCalled();
		});
	});

	describe('handle — check_suite', () => {
		const base = { eventType: 'check_suite', action: 'completed', workItemId: '9' } as const;

		it('dispatches Review when all checks completed and none failed', async () => {
			getCheckSuiteStatus.mockResolvedValue(
				checkStatus([
					['build', 'completed', 'success'],
					['test', 'completed', 'success'],
				]),
			);
			const result = await handler.handle(ctx({ ...base, headSha: 'cafe' }));
			expect(result).toEqual({ phase: 'review', taskId: '9', prNumber: '9', headSha: 'cafe' });
			// The ownership gate ran off the fetched PR's head branch — no extra
			// author round trip on this path any more.
			expect(hasRunForTask).toHaveBeenCalledWith(PROJECT.id, '42', 'implementation');
			expect(getCheckSuiteStatus).toHaveBeenCalledWith('jkwiecien', 'swarm', 'cafe');
			// The aggregate query still runs under the reviewer persona, so the
			// reviewer identity stays independent of the PR's author (PROJECT.md §5.3).
			expect(withPersonaCredentials).toHaveBeenCalledWith(
				expect.objectContaining({ id: PROJECT.id }),
				'reviewer',
				expect.any(Function),
			);
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('defers on zero checks by default (required policy)', async () => {
			getCheckSuiteStatus.mockResolvedValue(checkStatus([]));
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
			getCheckSuiteStatus.mockResolvedValue(checkStatus([]));
			const project = createMockProjectConfig({ pipeline: { review: { checks: 'if-present' } } });
			const result = await handler.handle({
				...ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' }),
				project,
			});
			expect(result).toEqual({ phase: 'review', taskId: '9', prNumber: '9', headSha: 'cafe' });
			expect(claimReviewDispatch).toHaveBeenCalledTimes(1);
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('the PR/SHA dispatch dedup still guards a duplicate follow-up event under if-present', async () => {
			// A second delivery of the same follow-up event (retry, or a sibling
			// check_suite for the same commit) must not burn a second Review.
			claimReviewDispatch.mockResolvedValue(false);
			getCheckSuiteStatus.mockResolvedValue(checkStatus([]));
			const project = createMockProjectConfig({ pipeline: { review: { checks: 'if-present' } } });
			const result = await handler.handle({
				...ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' }),
				project,
			});
			expect(result).toBeNull();
			expect(reserveReviewVerdict).not.toHaveBeenCalled();
		});

		it('still defers a present but incomplete check under if-present', async () => {
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));
			const project = createMockProjectConfig({ pipeline: { review: { checks: 'if-present' } } });
			expect(await handler.handle({ ...ctx({ ...base, headSha: 'cafe' }), project })).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
		});

		it('still routes a present failed check to Respond-to-CI under if-present', async () => {
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
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
			expect(getCheckSuiteStatus).not.toHaveBeenCalled();
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
			// it defers, like a failed aggregate query.
			hasRunForTask.mockRejectedValue(new Error('connection reset'));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { deliveryId: 'd-2' })),
			).toBeNull();
			expect(getCheckSuiteStatus).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
			expect(scheduleCoalescedJob.mock.calls[0][0]).toMatchObject({
				recheckAttempt: 1,
				deliveryId: 'd-2',
			});
		});

		it('dispatches Respond-to-CI when a check failed', async () => {
			getCheckSuiteStatus.mockResolvedValue(
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
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));

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
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
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
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' })),
			).toBeNull();
			expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
		});

		it('drops the CI-fix dispatch once the per-PR attempt cap is hit', async () => {
			claimRespondToCiAttempt.mockResolvedValue({ allowed: false, attempt: 4 });
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' })),
			).toBeNull();
		});

		it('skips Respond-to-CI when the check suite carries no PR branch', async () => {
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			// prBranch absent — the fix phase would have no branch to check out.
			expect(await handler.handle(ctx({ ...base, headSha: 'cafe' }))).toBeNull();
			expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
		});

		it('defers and schedules a coalesced recheck when a check is still running', async () => {
			getCheckSuiteStatus.mockResolvedValue(
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
				type: 'github',
				projectId: PROJECT.id,
				deliveryId: 'd-1',
				recheckAttempt: 1,
			});
		});

		it('increments recheckAttempt across successive rechecks', async () => {
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'queued', null]]));
			await handler.handle(ctx({ ...base, headSha: 'cafe' }, { recheckAttempt: 4 }));
			expect(scheduleCoalescedJob.mock.calls[0][0]).toMatchObject({ recheckAttempt: 5 });
		});

		it('stops rescheduling once the recheck cap is reached', async () => {
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { recheckAttempt: 20 })),
			).toBeNull();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('degrades to a bounded recheck when the aggregate query throws', async () => {
			// A transient Actions-API error (or an unresolvable reviewer token) must
			// not escape the handler — that would fail the job and burn its BullMQ
			// retries. It defers a recheck instead.
			getCheckSuiteStatus.mockRejectedValue(new Error('502 Bad Gateway'));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { deliveryId: 'd-9' })),
			).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
			const [job, coalesceKey] = scheduleCoalescedJob.mock.calls[0];
			expect(coalesceKey).toBe(`check-suite:${PROJECT.repo}:9:cafe`);
			expect(job).toMatchObject({ recheckAttempt: 1, deliveryId: 'd-9' });
		});

		it('degrades to a bounded recheck when the reviewer token cannot be resolved', async () => {
			// `withPersonaCredentials` throws before the API call when the persona's
			// token is unconfigured — same degrade path, no job failure.
			withPersonaCredentials.mockRejectedValue(new Error('no reviewer token configured'));
			expect(await handler.handle(ctx({ ...base, headSha: 'cafe' }))).toBeNull();
			expect(getCheckSuiteStatus).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
		});

		it('gives up (no reschedule) when the query keeps failing past the cap', async () => {
			getCheckSuiteStatus.mockRejectedValue(new Error('still 502'));
			expect(
				await handler.handle(ctx({ ...base, headSha: 'cafe' }, { recheckAttempt: 20 })),
			).toBeNull();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
		});

		it('skips a suite with no associated PR (no query)', async () => {
			expect(
				await handler.handle(
					ctx({
						eventType: 'check_suite',
						action: 'completed',
						workItemId: undefined,
						headSha: 'cafe',
					}),
				),
			).toBeNull();
			expect(getCheckSuiteStatus).not.toHaveBeenCalled();
		});

		it('skips a suite with no head SHA (no query)', async () => {
			expect(await handler.handle(ctx({ ...base, headSha: undefined }))).toBeNull();
			expect(getCheckSuiteStatus).not.toHaveBeenCalled();
		});
	});

	describe('handle — dedup gate', () => {
		const reviewable = {
			eventType: 'pull_request',
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
			eventType: 'pull_request',
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
			getCheckSuiteStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			const result = await handler.handle(
				ctx({
					eventType: 'check_suite',
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
			eventType: 'pull_request',
			action: 'synchronize',
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
						eventType: 'pull_request',
						action: 'synchronize',
					}),
				}),
				'review-mergeability:jkwiecien/swarm:42:abc123:pull_request',
				30000,
			);
		});

		it('keeps a check-suite mergeability recheck when synchronize arrives for the same head', async () => {
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
					eventType: 'check_suite',
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
				'review-mergeability:jkwiecien/swarm:42:abc123:check_suite',
				30000,
			);
			expect(scheduleCoalescedJob).toHaveBeenNthCalledWith(
				2,
				expect.any(Object),
				'review-mergeability:jkwiecien/swarm:42:abc123:pull_request',
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
