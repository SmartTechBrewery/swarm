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
	// The handler reads the cap itself to spot the event that *first* crosses it
	// (issue #838); omitting it here would leave that guard comparing against
	// `undefined` and never firing.
	MAX_FIX_ATTEMPTS: 3,
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
// Implementation for this item" — the common path. `createFailedRun` is the
// durable trace a terminal give-up writes (issue #742), mocked from the same
// partial so these tests need no database.
const { hasRunForTask, createFailedRun } = vi.hoisted(() => ({
	hasRunForTask: vi.fn(),
	createFailedRun: vi.fn(),
}));
vi.mock('@/db/repositories/runsRepository.js', async (importActual) => ({
	...(await importActual<typeof import('@/db/repositories/runsRepository.js')>()),
	hasRunForTask,
	createFailedRun,
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
	createFailedRun.mockReset();
	createFailedRun.mockResolvedValue('run-abandoned');
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
		state: 'open',
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
				state: 'open',
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
				state: 'open',
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
				state: 'open',
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
			// An attempt still within the cap is not a give-up (issue #838).
			expect(createFailedRun).not.toHaveBeenCalled();
			expect(commentOnPullRequest).not.toHaveBeenCalled();
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
			// The drop is no longer silent — see the issue #838 suite below for what
			// the crossing records.
			expect(createFailedRun).toHaveBeenCalledTimes(1);
		});

		it('skips Respond-to-CI when the check suite carries no PR branch', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			// prBranch absent — the fix phase would have no branch to check out.
			expect(await handler.handle(ctx({ ...base, headSha: 'cafe' }))).toBeNull();
			expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
			// A malformed `checks` payload is not a cycle SWARM gave up on, so it
			// deliberately leaves no give-up trace (issue #838).
			expect(createFailedRun).not.toHaveBeenCalled();
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
				state: 'open',
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
				state: 'open',
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
				state: 'open',
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
				state: 'open',
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
				state: 'open',
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

	/**
	 * A recheck chain still in flight when its PR closes (issue #772).
	 *
	 * `mergeable` never becomes final on a closed pull request, so before this
	 * guard such a chain polled every 30s until its 20-attempt cap and then wrote a
	 * `failed` run — observed on PR #768, whose stray `checks` chain kept polling
	 * for ~16 minutes after the PR had already been reviewed, approved and merged.
	 * A closed PR is a plain skip: nothing left to review, and nothing went wrong.
	 */
	describe('handle — a closed pull request stops the chain (issue #772)', () => {
		/** The merged PR the chain is unknowingly polling. */
		const closedPr = {
			number: 42,
			headBranch: 'issue-42',
			headSha: 'abc123',
			baseBranch: 'main',
			baseSha: 'base123',
			mergeable: null,
			authorLogin: 'operator-human',
			state: 'closed',
		};

		const entryPoints = [
			['a completed checks event', { kind: 'checks', action: 'completed' }],
			['a PR updated event', { kind: 'pull-request', action: 'updated' }],
			['a PR opened event', { kind: 'pull-request', action: 'opened' }],
		] as const;

		it.each(entryPoints)('skips without rescheduling on %s', async (_label, event) => {
			getPullRequest.mockResolvedValue(closedPr);

			const result = await handler.handle(
				ctx({
					...event,
					workItemId: '42',
					headSha: 'abc123',
					prBranch: 'issue-42',
					isDraft: false,
					isCrossRepo: false,
				}),
			);

			expect(result).toBeNull();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
			expect(createFailedRun).not.toHaveBeenCalled();
			expect(commentOnPullRequest).not.toHaveBeenCalled();
		});

		// The PR #768 outcome exactly: at the cap, the give-up path would otherwise
		// write the durable `failed` run and the give-up comment.
		it('records no abandonment even at the state-pending cap', async () => {
			getPullRequest.mockResolvedValue(closedPr);

			const result = await handler.handle(
				ctx(
					{ kind: 'checks', action: 'completed', workItemId: '42', headSha: 'abc123' },
					{ recheckAttempt: 20 },
				),
			);

			expect(result).toBeNull();
			expect(createFailedRun).not.toHaveBeenCalled();
			expect(commentOnPullRequest).not.toHaveBeenCalled();
		});

		// The guard precedes the ownership gate's DB read and the `checks` path's
		// aggregate checks-API query, so a closed PR costs neither.
		it('skips before the ownership gate and the aggregate check query', async () => {
			getPullRequest.mockResolvedValue(closedPr);

			await handler.handle(
				ctx({ kind: 'checks', action: 'completed', workItemId: '42', headSha: 'abc123' }),
			);

			expect(hasRunForTask).not.toHaveBeenCalled();
			expect(getAggregateCheckStatus).not.toHaveBeenCalled();
		});

		// It also precedes `handleConflictingPullRequest`, so a PR that closed while
		// reporting a conflict does not dispatch Resolve-conflicts against it.
		it('does not dispatch Resolve-conflicts for a closed PR reporting a conflict', async () => {
			getPullRequest.mockResolvedValue({ ...closedPr, mergeable: false });

			const result = await handler.handle(
				ctx({
					kind: 'pull-request',
					action: 'updated',
					workItemId: '42',
					headSha: 'abc123',
					isDraft: false,
					isCrossRepo: false,
				}),
			);

			expect(result).toBeNull();
			expect(claimConflictResolution).not.toHaveBeenCalled();
		});

		// Issue #720's budgets are untouched for a PR that is genuinely still open
		// and slow to report `mergeable`.
		it('still spends the state-pending budget while the PR is open', async () => {
			getPullRequest.mockResolvedValue({ ...closedPr, state: 'open' });

			const result = await handler.handle(
				ctx({
					kind: 'pull-request',
					action: 'updated',
					workItemId: '42',
					headSha: 'abc123',
					isDraft: false,
					isCrossRepo: false,
				}),
			);

			expect(result).toBeNull();
			expect(scheduleCoalescedJob).toHaveBeenCalledWith(
				expect.objectContaining({ recheckAttempt: 1 }),
				'review-mergeability:SmartTechBrewery/swarm:42:abc123:pull-request',
				30000,
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
			state: 'open',
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
		// Best-effort and expected to fail during a real outage — an extra on top of
		// the durable record (issue #742) — but its wording must match the reason.
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
			state: 'open',
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
			state: 'open',
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
 * A durable trace when a review is abandoned (issue #742).
 *
 * Before this, a terminal give-up's only notice was a best-effort pull-request
 * comment on the mergeability path and nothing at all on the aggregate-check one
 * — and in the incident behind issue #720 that comment failed against the very
 * provider whose unreachability caused the give-up, so the abandoned review left
 * no trace anywhere and the dispatch settled as an ordinary no-trigger. What is
 * pinned here is that the record is written to SWARM's own database, on both
 * give-up paths, independently of whether the provider can be reached.
 */
describe('review trigger — durable trace when a review is abandoned (issue #742)', () => {
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

	/** The single record the give-up wrote. */
	function recorded(): {
		projectId: string;
		repository: string;
		taskId: string;
		phase: string;
		prNumber?: string;
		error: string;
		jobPayload?: Record<string, unknown>;
	} {
		expect(createFailedRun).toHaveBeenCalledTimes(1);
		return createFailedRun.mock.calls[0][0];
	}

	it('records one failed Review run when the mergeability path gives up', async () => {
		getPullRequest.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));

		expect(await handler.handle(ctx(updated, { readFailureRecheckAttempt: 15 }))).toBeNull();

		const record = recorded();
		expect(record).toMatchObject({
			projectId: PROJECT.id,
			repository: PROJECT.repo,
			taskId: '42',
			phase: 'review',
			prNumber: '42',
		});
		// Which budget ran out, how many attempts it spent, the head SHA, and the
		// last underlying error — the four things an operator asks after.
		expect(record.error).toContain('read-failed');
		expect(record.error).toContain('15/15 attempts');
		expect(record.error).toContain('abc123');
		expect(record.error).toContain('getaddrinfo ENOTFOUND api.github.com');
	});

	it('records one failed Review run when the aggregate-check path gives up', async () => {
		// The path that had no notice at all before: it posts no comment, so the
		// record is the only thing standing between an abandoned review and silence.
		getAggregateCheckStatus.mockRejectedValue(new Error('502 Bad Gateway'));

		expect(
			await handler.handle(ctx({ ...checks, headSha: 'cafe' }, { readFailureRecheckAttempt: 15 })),
		).toBeNull();

		const record = recorded();
		expect(record).toMatchObject({ taskId: '9', phase: 'review', prNumber: '9' });
		expect(record.error).toContain('read-failed');
		expect(record.error).toContain('cafe');
		expect(record.error).toContain('502 Bad Gateway');
		expect(commentOnPullRequest).not.toHaveBeenCalled();
	});

	it('names the CI-lag budget when that is the one that ran out', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));

		expect(
			await handler.handle(ctx({ ...checks, headSha: 'cafe' }, { recheckAttempt: 20 })),
		).toBeNull();

		const record = recorded();
		expect(record.error).toContain('state-pending');
		expect(record.error).toContain('20/20 attempts');
		expect(record.error).toContain('test');
	});

	it('stores a payload a dashboard retry re-decides from, with both budgets reset', async () => {
		getPullRequest.mockRejectedValue(new Error('ENOTFOUND'));

		await handler.handle(
			ctx(updated, { readFailureRecheckAttempt: 15, recheckAttempt: 4, deliveryId: 'd-7' }),
		);

		const payload = recorded().jobPayload;
		expect(payload).toMatchObject({
			type: 'scm',
			providerId: 'github',
			projectId: PROJECT.id,
			deliveryId: 'd-7',
		});
		// Without this a "Retry now" would re-enter the handler already at its cap
		// and give up again without reading anything.
		expect(payload).not.toHaveProperty('recheckAttempt');
		expect(payload).not.toHaveProperty('readFailureRecheckAttempt');
	});

	it('still records the give-up when the pull-request comment cannot be posted', async () => {
		// The incident's actual shape: the comment goes through the same unreachable
		// provider, so the record is what survives.
		getPullRequest.mockRejectedValue(new Error('ENOTFOUND'));
		commentOnPullRequest.mockRejectedValue(new Error('ENOTFOUND'));

		expect(await handler.handle(ctx(updated, { readFailureRecheckAttempt: 15 }))).toBeNull();

		expect(createFailedRun).toHaveBeenCalledTimes(1);
		expect(commentOnPullRequest).toHaveBeenCalledTimes(1);
	});

	it('swallows a failed record write and still attempts the comment', async () => {
		// Bookkeeping must never throw out of `handle`: that lands outside
		// `processJob`'s `runPhase`-only try/catch and burns the job's BullMQ retries.
		getPullRequest.mockRejectedValue(new Error('ENOTFOUND'));
		createFailedRun.mockRejectedValue(new Error('database is down too'));

		expect(await handler.handle(ctx(updated, { readFailureRecheckAttempt: 15 }))).toBeNull();

		expect(commentOnPullRequest).toHaveBeenCalledTimes(1);
	});

	it('records nothing on a defer that reschedules', async () => {
		getAggregateCheckStatus.mockRejectedValue(new Error('502 Bad Gateway'));

		expect(
			await handler.handle(ctx({ ...checks, headSha: 'cafe' }, { readFailureRecheckAttempt: 2 })),
		).toBeNull();

		expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
		expect(createFailedRun).not.toHaveBeenCalled();
	});

	it('records nothing on a review that dispatches normally', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['build', 'completed', 'success']]));

		await expect(handler.handle(ctx({ ...checks, headSha: 'cafe' }))).resolves.toMatchObject({
			phase: 'review',
		});
		expect(createFailedRun).not.toHaveBeenCalled();
	});
});

/**
 * A durable trace when a CI-fix cycle is abandoned (issue #838).
 *
 * The per-PR fix-attempt cap used to wind down to a bare warn: the card stayed in
 * **In review**, the runs list showed nothing, and no dispatch was pending — the
 * same silence issue #742 removed from the Review handler's give-up paths. What
 * is pinned here is that the *first* event to cross the cap writes one durable
 * `failed` Respond-to-CI run (plus a best-effort comment), and that every later
 * red `checks` event on that capped PR keeps the plain warn-and-drop.
 */
describe('review trigger — durable trace when a CI fix is abandoned (issue #838)', () => {
	const checks = {
		kind: 'checks',
		action: 'completed',
		workItemId: '9',
		headSha: 'cafe',
		prBranch: 'issue-9',
	} as const;

	beforeEach(() => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
	});

	it('records the give-up on the event that first crosses the cap', async () => {
		claimRespondToCiAttempt.mockResolvedValue({ allowed: false, attempt: 4 });

		expect(await handler.handle(ctx(checks))).toBeNull();

		expect(createFailedRun).toHaveBeenCalledTimes(1);
		const record = createFailedRun.mock.calls[0][0];
		expect(record).toMatchObject({
			projectId: PROJECT.id,
			repository: PROJECT.repo,
			// Respond-to-CI's own task id, so the row sits with the rest of this PR's
			// CI history rather than under the Review phase's bare PR number.
			taskId: '9-ci',
			phase: 'respond-to-ci',
			prNumber: '9',
		});
		// The PR, the commit, the budget that ran out, and what is still failing.
		expect(record.error).toContain('#9');
		expect(record.error).toContain('cafe');
		expect(record.error).toContain('4/3');
		expect(record.error).toContain('test');
		expect(record.error).toContain('needs a human');

		expect(commentOnPullRequest).toHaveBeenCalledTimes(1);
		expect(commentOnPullRequest.mock.calls[0][2]).toContain(
			'SWARM has stopped trying to fix this build',
		);
	});

	it('records it only once — a later red check suite on a capped PR stays quiet', async () => {
		claimRespondToCiAttempt.mockResolvedValue({ allowed: false, attempt: 5 });

		expect(await handler.handle(ctx(checks))).toBeNull();

		expect(createFailedRun).not.toHaveBeenCalled();
		expect(commentOnPullRequest).not.toHaveBeenCalled();
	});

	it('stores a payload a dashboard retry re-decides from, with no recheck counters', async () => {
		claimRespondToCiAttempt.mockResolvedValue({ allowed: false, attempt: 4 });

		await handler.handle(ctx(checks, { recheckAttempt: 3, deliveryId: 'd-9' }));

		const payload = createFailedRun.mock.calls[0][0].jobPayload;
		expect(payload).toMatchObject({
			type: 'scm',
			providerId: 'github',
			projectId: PROJECT.id,
			deliveryId: 'd-9',
		});
		expect(payload).not.toHaveProperty('recheckAttempt');
		expect(payload).not.toHaveProperty('readFailureRecheckAttempt');
	});

	it('still records the give-up when the pull-request comment cannot be posted', async () => {
		claimRespondToCiAttempt.mockResolvedValue({ allowed: false, attempt: 4 });
		commentOnPullRequest.mockRejectedValue(new Error('ENOTFOUND'));

		expect(await handler.handle(ctx(checks))).toBeNull();

		expect(createFailedRun).toHaveBeenCalledTimes(1);
	});

	it('swallows a failed record write rather than throwing out of handle', async () => {
		// A throw here would land outside `processJob`'s `runPhase`-only try/catch
		// and burn the job's BullMQ retries.
		claimRespondToCiAttempt.mockResolvedValue({ allowed: false, attempt: 4 });
		createFailedRun.mockRejectedValue(new Error('database is down too'));

		expect(await handler.handle(ctx(checks))).toBeNull();

		expect(commentOnPullRequest).toHaveBeenCalledTimes(1);
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
