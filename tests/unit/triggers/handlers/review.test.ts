import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import type { AggregateCheckStatus, ScmPersona } from '@/scm/types.js';
import { createReviewTrigger } from '@/triggers/handlers/review.js';
import type { TriggerContext, TriggerDecline } from '@/triggers/types.js';
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
const { claimReviewDispatch, refreshReviewDispatchClaim, reviewDispatchClaimTtlSec } = vi.hoisted(
	() => ({
		claimReviewDispatch: vi.fn(),
		refreshReviewDispatchClaim: vi.fn(),
		// Read only to describe a *declined* claim to the operator (issue #1019);
		// defaults to "no lease could be read", the shape a down Redis produces.
		reviewDispatchClaimTtlSec: vi.fn(),
	}),
);
vi.mock('@/triggers/review-dispatch-dedup.js', () => ({
	claimReviewDispatch,
	refreshReviewDispatchClaim,
	reviewDispatchClaimTtlSec,
	reviewDispatchClaimOwner: (dispatchId: string) => `pr-review:${dispatchId}`,
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
	getBranchHead,
	deliveryPostComment,
} = vi.hoisted(() => ({
	getAggregateCheckStatus: vi.fn(),
	scheduleCoalescedJob: vi.fn(),
	hasPersonaToken: vi.fn(),
	getPullRequest: vi.fn(),
	commentOnPullRequest: vi.fn(),
	// The base-branch health read the red path takes before attributing a failure
	// (issue #873), and the delivery seam its notice is posted through.
	getBranchHead: vi.fn(),
	deliveryPostComment: vi.fn(),
}));
// A green head wakes the merge waiting on it (issue #1173); resolves how many woke.
const { promoteMergeChecksWaits } = vi.hoisted(() => ({ promoteMergeChecksWaits: vi.fn() }));
vi.mock('@/dispatch/dispatcher.js', () => ({
	scheduleCoalescedDispatch: scheduleCoalescedJob,
	promoteMergeChecksWaits,
}));

const deliveryProvider = vi.fn(
	async (_project: ProjectConfig, _persona: ScmPersona) =>
		({ postComment: deliveryPostComment }) as unknown as ScmDeliveryProvider,
);

const SCM = createFakeScmProvider({
	getAggregateCheckStatus,
	hasPersonaToken,
	getPullRequest,
	commentOnPullRequest,
	getBranchHead,
	deliveryProvider,
});

const { loggerWarn, loggerDebug, loggerInfo, loggerError } = vi.hoisted(() => ({
	loggerWarn: vi.fn(),
	loggerDebug: vi.fn(),
	loggerInfo: vi.fn(),
	loggerError: vi.fn(),
}));
vi.mock('@/lib/logger.js', () => ({
	logger: {
		warn: loggerWarn,
		debug: loggerDebug,
		info: loggerInfo,
		error: loggerError,
	},
}));

// The work-item origin gate (issue #397) reads run history; mock just that read
// (keeping the real `isSwarmManagedPullRequest`, so the PR's head branch really
// has to decode under the project's `branchPrefix`). Defaults to "SWARM ran
// Implementation for this item" — the common path. `createFailedRun` is the
// durable trace a terminal give-up writes (issue #742), mocked from the same
// partial so these tests need no database.
//
// A give-up first looks for the Review run a retry left `deferred` on the chain
// (issue #1049) — the latest run for the task, its active dispatch, and the
// conditional settle. Defaults to "no such run", so every give-up below still
// writes its own record unless a case says otherwise.
const { hasRunForTask, createFailedRun, getLatestRunForTask, failRunFromStatus } = vi.hoisted(
	() => ({
		hasRunForTask: vi.fn(),
		createFailedRun: vi.fn(),
		getLatestRunForTask: vi.fn(),
		failRunFromStatus: vi.fn(),
	}),
);
vi.mock('@/db/repositories/runsRepository.js', async (importActual) => ({
	...(await importActual<typeof import('@/db/repositories/runsRepository.js')>()),
	hasRunForTask,
	createFailedRun,
	getLatestRunForTask,
	failRunFromStatus,
}));
const { getActiveDispatchByRunId } = vi.hoisted(() => ({ getActiveDispatchByRunId: vi.fn() }));
vi.mock('@/db/repositories/dispatchesRepository.js', () => ({ getActiveDispatchByRunId }));

// The `review` disposition reserves a durable safety-cap slot before
// dispatching (issue #235); mock the ledger so these tests need no database.
// Defaults to granting a fresh reservation (the common path); individual
// tests flip it to exercise `blocked`/`capped`/a persistence error.
//
// `abandonReviewVerdictOwnedBy` is the hand-back a Review continuation takes
// when its head went red while it waited (issue #1123).
//
// `getApprovedHeadSlot` is half of "is this red an adjudicated approved head?"
// (issue #1128); defaults to "not approved".
const { reserveReviewVerdict, abandonReviewVerdictOwnedBy, getApprovedHeadSlot } = vi.hoisted(
	() => ({
		reserveReviewVerdict: vi.fn(),
		abandonReviewVerdictOwnedBy: vi.fn(),
		getApprovedHeadSlot: vi.fn(),
	}),
);
vi.mock('@/db/repositories/reviewVerdictsRepository.js', () => ({
	reserveReviewVerdict,
	abandonReviewVerdictOwnedBy,
	getApprovedHeadSlot,
	REVIEW_VERDICT_CAP: 3,
	REVIEW_SUPERSEDED_CAP: 5,
}));

// A green head this PR already approved re-arms its merge (issue #1128); the
// re-arm's own guards are asserted in the merge-automation suite.
const { rearmMergeAutomationForGreenHead } = vi.hoisted(() => ({
	rearmMergeAutomationForGreenHead: vi.fn(),
}));
vi.mock('@/worker/merge-automation.js', () => ({ rearmMergeAutomationForGreenHead }));

// The adjudicated-red-approved-head policy (issue #1128): whether a `no-fix`
// recovery was recorded for the head (defaults to none), and the shared re-run
// policy itself, whose branches are asserted in its own suite.
const { hasCiNoFixRecovery, recoverAdjudicatedApprovedHead } = vi.hoisted(() => ({
	hasCiNoFixRecovery: vi.fn(),
	recoverAdjudicatedApprovedHead: vi.fn(),
}));
vi.mock('@/dispatch/ci-no-fix-recovery.js', () => ({ hasCiNoFixRecovery }));
vi.mock('@/dispatch/approved-head-checks-rerun.js', () => ({
	recoverAdjudicatedApprovedHead,
	RERUN_SETTLE_RECHECK_DELAY_MS: 135_000,
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
	reviewDispatchClaimTtlSec.mockReset();
	reviewDispatchClaimTtlSec.mockResolvedValue(undefined);
	refreshReviewDispatchClaim.mockReset();
	refreshReviewDispatchClaim.mockResolvedValue(undefined);
	claimRespondToCiAttempt.mockReset();
	claimRespondToCiAttempt.mockResolvedValue({ allowed: true, attempt: 1 });
	claimConflictResolution.mockReset();
	claimConflictResolution.mockResolvedValue(true);
	getAggregateCheckStatus.mockReset();
	// A head CI already passed: a PR opening reads the checks too (issue #1123),
	// so suites using an `opened` event as their reviewable event keep
	// dispatching. Suites that care about the aggregate set their own.
	getAggregateCheckStatus.mockResolvedValue(checkStatus([['ci', 'completed', 'success']]));
	scheduleCoalescedJob.mockReset();
	promoteMergeChecksWaits.mockReset();
	promoteMergeChecksWaits.mockResolvedValue(0);
	// Ownership-gate default: SWARM has an Implementation run for the work item the
	// PR's branch decodes to. Tests flip it to exercise an unrelated PR or a
	// run-history lookup failure.
	hasRunForTask.mockReset();
	hasRunForTask.mockResolvedValue(true);
	createFailedRun.mockReset();
	createFailedRun.mockResolvedValue('run-abandoned');
	getLatestRunForTask.mockReset();
	getLatestRunForTask.mockResolvedValue(undefined);
	failRunFromStatus.mockReset();
	failRunFromStatus.mockResolvedValue(true);
	getActiveDispatchByRunId.mockReset();
	getActiveDispatchByRunId.mockResolvedValue(undefined);
	reserveReviewVerdict.mockReset();
	reserveReviewVerdict.mockResolvedValue({ status: 'reserved', id: 'v1', ordinal: 1 });
	abandonReviewVerdictOwnedBy.mockReset();
	abandonReviewVerdictOwnedBy.mockResolvedValue(true);
	rearmMergeAutomationForGreenHead.mockReset();
	rearmMergeAutomationForGreenHead.mockResolvedValue(undefined);
	getApprovedHeadSlot.mockReset();
	getApprovedHeadSlot.mockResolvedValue(undefined);
	hasCiNoFixRecovery.mockReset();
	hasCiNoFixRecovery.mockResolvedValue(false);
	recoverAdjudicatedApprovedHead.mockReset();
	recoverAdjudicatedApprovedHead.mockResolvedValue('rerun-requested');
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
	// Base-branch attribution default (issue #873): the provider names no head for
	// the base branch, which `readBaseBranchHealth` reports as `unknown` — the
	// fail-open answer, so every suite that does not care about the base keeps the
	// pre-#873 routing and costs no second aggregate read. Suites that do care set
	// a head and answer for it.
	getBranchHead.mockReset();
	getBranchHead.mockResolvedValue(null);
	deliveryPostComment.mockReset();
	deliveryPostComment.mockResolvedValue(1);
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
		ciNoFixRecovery?: boolean;
		noteDecline?: (decline: TriggerDecline) => void;
		runId?: string;
		project?: ProjectConfig;
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

		it("dispatches Review once the head's checks have all passed", async () => {
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
				verdictSlotReserved: true,
			});
			// The opening reads the head's checks like a completed-checks event (issue #1123).
			expect(getAggregateCheckStatus).toHaveBeenCalledWith(
				expect.objectContaining({ id: PROJECT.id }),
				'abc123',
			);
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
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

		describe("waits for the head's checks (issue #1123)", () => {
			const opened = (extra: Parameters<typeof ctx>[1] = {}) =>
				ctx({ ...base, headSha: 'abc123', isCrossRepo: false, prBranch: 'issue-42' }, extra);

			it('defers a head whose check is still running, on the shared checks recheck', async () => {
				getAggregateCheckStatus.mockResolvedValue(checkStatus([['ci', 'in_progress', null]]));
				expect(await handler.handle(opened())).toBeNull();
				expect(claimReviewDispatch).not.toHaveBeenCalled();
				expect(reserveReviewVerdict).not.toHaveBeenCalled();
				expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
				const [payload, key, , waitReason] = scheduleCoalescedJob.mock.calls[0];
				expect(key).toBe(`check-suite:${PROJECT.repo}:42:abc123`);
				expect(payload).toMatchObject({
					event: expect.objectContaining({ kind: 'pull-request', action: 'opened' }),
					recheckAttempt: 1,
				});
				expect(waitReason).toBe('recheck');
			});

			it('defers a head with no checks registered yet under required', async () => {
				getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
				const noteDecline = vi.fn();
				expect(await handler.handle(opened({ noteDecline }))).toBeNull();
				expect(claimReviewDispatch).not.toHaveBeenCalled();
				expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
				expect(noteDecline).toHaveBeenCalledOnce();
				const decline = noteDecline.mock.calls[0][0] as TriggerDecline;
				expect(decline.kind).toBe('recheck-scheduled');
				expect(decline.reason).toContain('none are registered');
				expect(decline.reason).toContain('`if-present`');
			});

			it('routes a failed check to Respond-to-CI without reserving a review', async () => {
				getAggregateCheckStatus.mockResolvedValue(checkStatus([['ci', 'completed', 'failure']]));
				const result = await handler.handle(opened());
				expect(result).toEqual({
					phase: 'respond-to-ci',
					taskId: '42-ci',
					prNumber: '42',
					prBranch: 'issue-42',
					headSha: 'abc123',
				});
				expect(reserveReviewVerdict).not.toHaveBeenCalled();
				expect(claimRespondToCiAttempt).toHaveBeenCalledOnce();
			});

			it('reviews a zero-check head at once under if-present', async () => {
				getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
				const project = createMockProjectConfig({ reviewChecks: 'if-present' });
				const result = await handler.handle({ ...opened(), project });
				expect(result).toMatchObject({ phase: 'review', prNumber: '42', headSha: 'abc123' });
				expect(scheduleCoalescedJob).not.toHaveBeenCalled();
			});

			it('defers a present running check under if-present', async () => {
				getAggregateCheckStatus.mockResolvedValue(checkStatus([['ci', 'queued', null]]));
				const project = createMockProjectConfig({ reviewChecks: 'if-present' });
				expect(await handler.handle({ ...opened(), project })).toBeNull();
				expect(claimReviewDispatch).not.toHaveBeenCalled();
				expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
			});

			it('routes a present failed check to Respond-to-CI under if-present', async () => {
				getAggregateCheckStatus.mockResolvedValue(checkStatus([['ci', 'completed', 'failure']]));
				const project = createMockProjectConfig({ reviewChecks: 'if-present' });
				const result = await handler.handle({ ...opened(), project });
				expect(result).toMatchObject({ phase: 'respond-to-ci', taskId: '42-ci' });
			});

			it('defers on the read-failure budget when the checks read throws', async () => {
				getAggregateCheckStatus.mockRejectedValue(new Error('502 Bad Gateway'));
				expect(await handler.handle(opened())).toBeNull();
				expect(claimReviewDispatch).not.toHaveBeenCalled();
				expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
				expect(scheduleCoalescedJob.mock.calls[0][0]).toMatchObject({
					readFailureRecheckAttempt: 1,
				});
				expect(scheduleCoalescedJob.mock.calls[0][0]).not.toHaveProperty('recheckAttempt');
			});

			it('dispatches Review from a recheck once the checks have passed', async () => {
				const result = await handler.handle(opened({ recheckAttempt: 3 }));
				expect(result).toMatchObject({ phase: 'review', prNumber: '42', headSha: 'abc123' });
			});
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
				verdictSlotReserved: true,
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
			const project = createMockProjectConfig({ reviewChecks: 'if-present' });
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
				verdictSlotReserved: true,
			});
			expect(claimReviewDispatch).toHaveBeenCalledTimes(1);
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('the PR/SHA dispatch dedup still guards a duplicate follow-up event under if-present', async () => {
			// A second delivery of the same follow-up event (retry, or a sibling
			// check_suite for the same commit) must not burn a second Review.
			claimReviewDispatch.mockResolvedValue(false);
			getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
			const project = createMockProjectConfig({ reviewChecks: 'if-present' });
			const result = await handler.handle({
				...ctx({ ...base, headSha: 'cafe', prBranch: 'issue-9' }),
				project,
			});
			expect(result).toBeNull();
			expect(reserveReviewVerdict).not.toHaveBeenCalled();
		});

		it('still defers a present but incomplete check under if-present', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));
			const project = createMockProjectConfig({ reviewChecks: 'if-present' });
			expect(await handler.handle({ ...ctx({ ...base, headSha: 'cafe' }), project })).toBeNull();
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
		});

		it('still routes a present failed check to Respond-to-CI under if-present', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
			const project = createMockProjectConfig({ reviewChecks: 'if-present' });
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
			// Same PR+SHA dedup slot as review, plus the per-PR attempt cap. The claim
			// carries its dispatch's token, so only that dispatch can hand it back
			// through the owner-fenced release (issue #1105).
			expect(claimReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:9:cafe`, 'pr-review', {
				prNumber: '9',
				headSha: 'cafe',
				owner: 'pr-review:dispatch-1',
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
			const [job, coalesceKey, delayMs, waitReason] = scheduleCoalescedJob.mock.calls[0];
			expect(coalesceKey).toBe(`check-suite:${PROJECT.repo}:9:cafe`);
			expect(delayMs).toBe(30_000);
			// The one coalesced recheck that *is* a wait on CI (issue #1087).
			expect(waitReason).toBe('recheck');
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
			const [job, coalesceKey, , waitReason] = scheduleCoalescedJob.mock.calls[0];
			expect(coalesceKey).toBe(`check-suite:${PROJECT.repo}:9:cafe`);
			expect(job).toMatchObject({ readFailureRecheckAttempt: 1, deliveryId: 'd-9' });
			// A read that never answered is not CI still running (issue #1087).
			expect(waitReason).toBe('read-failed');
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

		it('claims the PR+SHA slot before dispatching, under its own dispatch token', async () => {
			await handler.handle(ctx(reviewable));
			expect(claimReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:42:abc123`, 'pr-review', {
				prNumber: '42',
				headSha: 'abc123',
				owner: 'pr-review:dispatch-1',
			});
		});

		// Also what keeps a merge dispatch's own base update off the verdict ledger
		// (issue #874): it claims this slot for the head it produces, so that head's
		// `checks completed` event finds it taken and spends no Review.
		it('skips dispatch when the slot is already claimed (or Redis is down)', async () => {
			claimReviewDispatch.mockResolvedValue(false);
			expect(await handler.handle(ctx(reviewable))).toBeNull();
			expect(reserveReviewVerdict).not.toHaveBeenCalled();
		});

		// Issue #1019: returning a bare `null` here let the worker report the drop as
		// "the disposition changed" — the board and the PR — when the actual cause was
		// SWARM's own lock, taken seconds earlier by the operator's own previous click.
		describe('a declined claim says so (issue #1019)', () => {
			it('records the collision, naming the slot and the wait', async () => {
				claimReviewDispatch.mockResolvedValue(false);
				reviewDispatchClaimTtlSec.mockResolvedValue(252);
				const noteDecline = vi.fn();

				expect(await handler.handle(ctx(reviewable, { noteDecline }))).toBeNull();

				expect(reviewDispatchClaimTtlSec).toHaveBeenCalledWith(`${PROJECT.repo}:42:abc123`);
				expect(noteDecline).toHaveBeenCalledExactlyOnceWith({
					kind: 'dispatch-claim-held',
					reason: expect.stringContaining(`${PROJECT.repo}:42:abc123`),
					// The same lease as a number: the settle defers a carried run on it
					// rather than failing the run for a collision that clears by itself.
					retryAfterSec: 252,
				});
				const [{ reason }] = noteDecline.mock.calls[0] as [TriggerDecline];
				expect(reason).toContain('4m 12s');
				expect(reason).toContain('disposition did not change');
			});

			// The claim also fails closed on an unreachable Redis, in which case there is
			// no lease to read — so the message says that rather than inventing a wait.
			it('says the holder could not be read when no lease answers', async () => {
				claimReviewDispatch.mockResolvedValue(false);
				reviewDispatchClaimTtlSec.mockResolvedValue(undefined);
				const noteDecline = vi.fn();

				expect(await handler.handle(ctx(reviewable, { noteDecline }))).toBeNull();

				const [{ reason }] = noteDecline.mock.calls[0] as [TriggerDecline];
				expect(reason).toContain('could not be read');
				expect(reason).not.toContain('frees in');
			});

			it('records nothing when the claim is granted', async () => {
				const noteDecline = vi.fn();

				await handler.handle(ctx(reviewable, { noteDecline }));

				expect(noteDecline).not.toHaveBeenCalled();
				expect(reviewDispatchClaimTtlSec).not.toHaveBeenCalled();
			});
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
				verdictSlotReserved: true,
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
				verdictSlotReserved: true,
			});
			expect(reserveReviewVerdict).toHaveBeenCalledWith(
				{
					projectId: PROJECT.id,
					repository: PROJECT.repo,
					prNumber: '42',
					headSha: 'abc123',
				},
				'dispatch-1',
			);
		});

		it('skips the dispatch when another head is still pending (blocked)', async () => {
			reserveReviewVerdict.mockResolvedValue({ status: 'blocked', ordinal: 1 });
			expect(await handler.handle(ctx(reviewable))).toBeNull();
			expect(rearmMergeAutomationForGreenHead).not.toHaveBeenCalled();
		});

		// Both bounds stop the dispatch the same way, and the handler names which one
		// in the line an operator greps (issue #1079).
		it.each([
			['verdict-cap'],
			['superseded-bound'],
		])('skips the dispatch once the review allowance is spent (capped: %s)', async (reason) => {
			reserveReviewVerdict.mockResolvedValue({ status: 'capped', reason });

			expect(await handler.handle(ctx(reviewable))).toBeNull();

			expect(loggerWarn).toHaveBeenCalledWith(
				expect.stringContaining('safety cap'),
				expect.objectContaining({ reason, cap: 3, supersededCap: 5 }),
			);
			expect(rearmMergeAutomationForGreenHead).not.toHaveBeenCalled();
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
			// The slot was not this evaluation's to create, so a drop before the phase
			// starts must not hand it back (issue #1105).
			expect(result).not.toHaveProperty('verdictSlotReserved');
			expect(rearmMergeAutomationForGreenHead).not.toHaveBeenCalled();
		});

		it('does not re-review a head whose slot is already submitted — it re-arms the merge (issue #1128)', async () => {
			reserveReviewVerdict.mockResolvedValue({
				status: 'reused',
				id: 'v1',
				ordinal: 1,
				state: 'submitted',
			});
			expect(await handler.handle(ctx(reviewable))).toBeNull();
			expect(rearmMergeAutomationForGreenHead).toHaveBeenCalledExactlyOnceWith({
				project: PROJECT,
				prNumber: '42',
				headSha: 'abc123',
			});
		});

		it('re-arms on a green completed-checks event for an already-approved head', async () => {
			reserveReviewVerdict.mockResolvedValue({
				status: 'reused',
				id: 'v1',
				ordinal: 1,
				state: 'submitted',
			});
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'success']]));

			const result = await handler.handle(
				ctx({
					kind: 'checks',
					action: 'completed',
					workItemId: '42',
					headSha: 'abc123',
					prBranch: 'issue-42',
				}),
			);

			expect(result).toBeNull();
			expect(rearmMergeAutomationForGreenHead).toHaveBeenCalledExactlyOnceWith({
				project: PROJECT,
				prNumber: '42',
				headSha: 'abc123',
			});
		});

		it('fails closed (skips) when the reservation call throws', async () => {
			reserveReviewVerdict.mockRejectedValue(new Error('connection reset'));
			expect(await handler.handle(ctx(reviewable))).toBeNull();
			expect(rearmMergeAutomationForGreenHead).not.toHaveBeenCalled();
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
			expect(rearmMergeAutomationForGreenHead).not.toHaveBeenCalled();
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

			const context = ctx(synchronized);
			const result = await handler.handle(context);

			expect(result).toEqual({
				phase: 'resolve-conflicts',
				taskId: '42-conflicts',
				prNumber: '42',
				prBranch: 'issue-42',
				headSha: 'abc123',
				baseBranch: 'main',
				baseSha: 'base123',
			});
			// The same owner-bound claim the resolve-conflicts trigger takes, so an
			// ended holder frees this route too (issue #1047).
			expect(claimConflictResolution).toHaveBeenCalledWith(
				`${PROJECT.repo}:42:abc123:base123`,
				context.dispatchId,
			);
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
				'mergeability',
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
				'mergeability',
			);
			expect(scheduleCoalescedJob).toHaveBeenNthCalledWith(
				2,
				expect.any(Object),
				'review-mergeability:SmartTechBrewery/swarm:42:abc123:pull-request',
				30000,
				'mergeability',
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
				'mergeability',
			);
		});
	});
});

/**
 * A push to a mergeable head under `reviewChecks` (issue #1107).
 *
 * The `updated` event used to end in an unconditional "waiting for checks" skip,
 * so an `if-present` project's head that no CI ever runs on — no `checks` event
 * will arrive for it — waited for the 15-minute unreviewed-PR sweep. Live on
 * `under-control-mobile#135`: the head carried 0 statuses and 0 check runs, its
 * only check suite an Xcode Cloud one stuck in `queued` with no runs, which the
 * provider's aggregate reports as empty. Such a head is now reviewed off the push
 * itself; every other head, and every `required` project, keeps waiting for its
 * own completed-checks event.
 */
describe('review trigger — pull-request updated under reviewChecks (issue #1107)', () => {
	const updated = {
		kind: 'pull-request',
		action: 'updated',
		workItemId: '42',
		headSha: 'abc123',
		isDraft: false,
		isCrossRepo: false,
	} as const;
	const IF_PRESENT = createMockProjectConfig({ reviewChecks: 'if-present' });
	const REQUIRED = createMockProjectConfig({ reviewChecks: 'required' });

	beforeEach(() => {
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
	});

	it('reviews a zero-check head off the push under if-present', async () => {
		// The live shape: a queued third-party suite with no runs, which the
		// provider reports as an empty aggregate.
		getAggregateCheckStatus.mockResolvedValue(checkStatus([]));

		const result = await handler.handle(ctx(updated, { project: IF_PRESENT }));

		expect(result).toEqual({
			phase: 'review',
			taskId: '42',
			prNumber: '42',
			prBranch: 'issue-42',
			headSha: 'abc123',
			verdictSlotReserved: true,
		});
		expect(getAggregateCheckStatus).toHaveBeenCalledWith(IF_PRESENT, 'abc123');
		expect(claimReviewDispatch).toHaveBeenCalledTimes(1);
		expect(scheduleCoalescedJob).not.toHaveBeenCalled();
	});

	// The path the live log took: `mergeable` was still `null` on the first read
	// after the push, so the event came back through a mergeability recheck.
	it('reviews a zero-check head on a mergeability-recheck re-entry too', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([]));

		const result = await handler.handle(ctx(updated, { project: IF_PRESENT, recheckAttempt: 3 }));

		expect(result).toMatchObject({ phase: 'review', taskId: '42', headSha: 'abc123' });
	});

	// The push races a follow-up `checks` event or the sweep for the same head;
	// the PR+SHA claim settles it to one Review.
	it('drops the push when the PR+SHA dispatch slot is already held', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
		claimReviewDispatch.mockResolvedValue(false);

		const result = await handler.handle(ctx(updated, { project: IF_PRESENT }));

		expect(result).toBeNull();
		expect(reserveReviewVerdict).not.toHaveBeenCalled();
	});

	const policies = [
		['if-present', IF_PRESENT],
		['required', REQUIRED],
	] as const;
	const heads = [
		['pending', [['test', 'in_progress', null]]],
		['passing', [['build', 'completed', 'success']]],
		['failing', [['test', 'completed', 'failure']]],
	] as const;
	const cases = policies.flatMap(([policy, project]) =>
		heads.map(([head, runs]) => [policy, head, project, runs] as const),
	);

	it.each(
		cases,
	)('under %s, a %s head still waits for its checks event', async (policy, _head, project, runs) => {
		getAggregateCheckStatus.mockResolvedValue(
			checkStatus(runs.map((run) => [...run] as [string, string, string | null])),
		);

		const result = await handler.handle(ctx(updated, { project }));

		expect(result).toBeNull();
		expect(claimReviewDispatch).not.toHaveBeenCalled();
		expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
		expect(getBranchHead).not.toHaveBeenCalled();
		expect(reserveReviewVerdict).not.toHaveBeenCalled();
		expect(getAggregateCheckStatus).toHaveBeenCalledTimes(policy === 'if-present' ? 1 : 0);
	});

	it.each([
		['the default', PROJECT],
		['an explicit', REQUIRED],
	])('keeps waiting on a zero-check head under %s required policy', async (_label, project) => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([]));

		const result = await handler.handle(ctx(updated, { project }));

		expect(result).toBeNull();
		expect(getAggregateCheckStatus).not.toHaveBeenCalled();
		expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		expect(loggerDebug).toHaveBeenCalledWith(
			'review: PR is mergeable on updated event; waiting for checks — skipping',
			expect.objectContaining({ prNumber: '42', headSha: 'abc123', checksPolicy: 'required' }),
		);
	});

	// A failed read leaves the head exactly where it was before issue #1107: to
	// the checks event and the sweep — no recheck, no give-up trace.
	it('skips without rescheduling when the aggregate read throws under if-present', async () => {
		getAggregateCheckStatus.mockRejectedValue(new Error('502 Bad Gateway'));

		const result = await handler.handle(ctx(updated, { project: IF_PRESENT }));

		expect(result).toBeNull();
		expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		expect(createFailedRun).not.toHaveBeenCalled();
		expect(commentOnPullRequest).not.toHaveBeenCalled();
		expect(loggerWarn).toHaveBeenCalled();
	});

	it('does not read checks when Review is disabled', async () => {
		const project = createMockProjectConfig({
			reviewChecks: 'if-present',
			pipeline: {
				review: { enabled: false },
				respondToReview: { enabled: false },
			},
		});
		getAggregateCheckStatus.mockResolvedValue(checkStatus([]));

		const result = await handler.handle(ctx(updated, { project }));

		expect(result).toBeNull();
		expect(getAggregateCheckStatus).not.toHaveBeenCalled();
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
describe('review trigger — a PR opening and its completed checks (issue #1123)', () => {
	const opened = {
		kind: 'pull-request',
		action: 'opened',
		workItemId: '42',
		headSha: 'abc123',
		isCrossRepo: false,
		prBranch: 'issue-42',
	} as const;
	const checksCompleted = {
		kind: 'checks',
		action: 'completed',
		workItemId: '42',
		headSha: 'abc123',
		prBranch: 'issue-42',
	} as const;

	describe('exactly one Review per head', () => {
		beforeEach(() => {
			// The real PR+SHA slot: granted to the first claimant only.
			const claimed = new Set<string>();
			claimReviewDispatch.mockImplementation(async (key: string) => {
				if (claimed.has(key)) return false;
				claimed.add(key);
				return true;
			});
		});

		it('reviews off the opening and drops the later completed checks', async () => {
			expect(await handler.handle(ctx(opened))).toMatchObject({ phase: 'review' });
			expect(await handler.handle(ctx(checksCompleted))).toBeNull();
			expect(reserveReviewVerdict).toHaveBeenCalledOnce();
		});

		it('reviews off the completed checks and drops a late opening', async () => {
			expect(await handler.handle(ctx(checksCompleted))).toMatchObject({ phase: 'review' });
			expect(await handler.handle(ctx(opened))).toBeNull();
			expect(reserveReviewVerdict).toHaveBeenCalledOnce();
		});

		it('keeps one recheck chain per head when both wait', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['ci', 'in_progress', null]]));
			await handler.handle(ctx(opened));
			await handler.handle(ctx(checksCompleted));
			expect(scheduleCoalescedJob).toHaveBeenCalledTimes(2);
			expect(scheduleCoalescedJob.mock.calls[0][1]).toBe(scheduleCoalescedJob.mock.calls[1][1]);
		});
	});

	describe('a Review that waited re-reads the checks when it is picked up', () => {
		/** A held-claim continuation of an `opened` Review, e.g. one that waited for a worker. */
		const continuation = (noteDecline?: (decline: TriggerDecline) => void) =>
			ctx(opened, { continuationDispatchClaimed: true, runId: 'run-7', noteDecline });

		it('goes to Respond-to-CI, handing back its review slot, once the head went red', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['ci', 'completed', 'failure']]));
			const result = await handler.handle(continuation());
			expect(result).toMatchObject({
				phase: 'respond-to-ci',
				taskId: '42-ci',
				prNumber: '42',
				headSha: 'abc123',
			});
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(reserveReviewVerdict).not.toHaveBeenCalled();
			// The slot the earlier evaluation reserved, fenced on this dispatch.
			expect(abandonReviewVerdictOwnedBy).toHaveBeenCalledWith(
				{ projectId: PROJECT.id, repository: PROJECT.repo, prNumber: '42', headSha: 'abc123' },
				'dispatch-1',
			);
		});

		it('still routes to Respond-to-CI when the slot hand-back fails', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['ci', 'completed', 'failure']]));
			abandonReviewVerdictOwnedBy.mockRejectedValue(new Error('connection reset'));
			expect(await handler.handle(continuation())).toMatchObject({ phase: 'respond-to-ci' });
		});

		it('waits again, as a scheduled recheck, when checks registered meanwhile', async () => {
			// An if-present zero-check head whose CI registered while it waited.
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['ci', 'in_progress', null]]));
			const project = createMockProjectConfig({ reviewChecks: 'if-present' });
			const noteDecline = vi.fn();
			expect(await handler.handle({ ...continuation(noteDecline), project })).toBeNull();
			expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
			// The decline the consumer settles the carried run `deferred` on.
			expect(noteDecline).toHaveBeenCalledWith(
				expect.objectContaining({ kind: 'recheck-scheduled' }),
			);
			expect(abandonReviewVerdictOwnedBy).not.toHaveBeenCalled();
		});
	});
});

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
		failureDiagnosis?: { kind: string; title: string; message: string; recovery: string };
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
		// Which budget ran out (recorded as the diagnosis kind, issue #1203), how many
		// attempts it spent, the head SHA, and the last underlying error — the four
		// things an operator asks after.
		expect(record.failureDiagnosis?.kind).toBe('review-provider-unreachable');
		expect(record.error).toContain("didn't respond while SWARM was checking this pull request");
		expect(record.error).toContain('Retry now');
		expect(record.error).toContain('Re-checks spent: 15 of 15');
		expect(record.error).toContain('Head commit: abc123');
		expect(record.error).toContain('Last error: getaddrinfo ENOTFOUND api.github.com');
		expect(record.error).not.toContain('read-failed');
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
		expect(record.failureDiagnosis?.kind).toBe('review-provider-unreachable');
		expect(record.error).toContain('Use Retry now once');
		expect(record.error).toContain('cafe');
		expect(record.error).toContain('502 Bad Gateway');
		expect(commentOnPullRequest).not.toHaveBeenCalled();
	});

	it('names the CI-lag budget when that is the one that ran out', async () => {
		getAggregateCheckStatus.mockResolvedValue(
			checkStatus([
				['test', 'in_progress', null],
				['Lint, typecheck, and test', 'queued', null],
			]),
		);

		expect(
			await handler.handle(ctx({ ...checks, headSha: 'cafe' }, { recheckAttempt: 20 })),
		).toBeNull();

		const record = recorded();
		// The recorded fact the WIP section classifies on (issue #1203).
		expect(record.failureDiagnosis?.kind).toBe('review-waiting-for-checks');
		// A short plain headline first, the details secondary.
		expect(record.error).toMatch(
			/^Review didn't start yet — CI was still running after 10 minutes\./,
		);
		expect(record.error).toContain('starts automatically when the checks finish');
		expect(record.error).toContain('Re-checks spent: 20 of 20');
		// One line per check, never JSON and never comma-joined.
		expect(record.error).toContain('Still running:\n  - test\n  - Lint, typecheck, and test');
		expect(record.error).not.toContain('state-pending');
		expect(record.error).not.toContain('["');
		expect(record.error).not.toContain('reviewChecksWaitMinutes');
	});

	it('keeps the plain headline, and no diagnosis, when mergeability is never computed', async () => {
		getPullRequest.mockResolvedValue({
			number: 42,
			headBranch: 'issue-42',
			headSha: 'abc123',
			baseBranch: 'main',
			baseSha: 'base-sha-123',
			mergeable: null,
			authorLogin: 'operator-human',
			state: 'open',
		});

		await handler.handle(ctx(updated, { recheckAttempt: 20 }));

		const record = recorded();
		expect(record.failureDiagnosis).toBeUndefined();
		expect(record.error).toMatch(/^Review abandoned: the source-control provider never reported/);
		expect(record.error).toContain('Re-checks spent: 20 of 20');
	});

	it('records no diagnosis when SWARM’s own ownership lookup is what failed', async () => {
		hasRunForTask.mockRejectedValue(new Error('connection reset'));

		await handler.handle(ctx(updated, { readFailureRecheckAttempt: 15 }));

		const record = recorded();
		expect(record.failureDiagnosis).toBeUndefined();
		expect(record.error).toMatch(/^Review abandoned: the source-control provider never answered\./);
		expect(record.error).toContain('Reason: ownership gate resolution failed');
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
 * How long Review waits for a head's CI is per project (issue #1083). The
 * `state-pending` cap is derived from the repository's `reviewChecksWaitMinutes` at the
 * fixed 30 s cadence — 10 minutes (20 attempts) when unset — and only that budget
 * moves with it: the `read-failed` one (#720) stays fixed.
 */
describe('review trigger — per-project CI wait (issue #1083)', () => {
	const checks = { kind: 'checks', action: 'completed', workItemId: '9' } as const;
	/** 20 minutes buys 40 rechecks at 30 s. */
	const LONG_WAIT = createMockProjectConfig({ reviewChecksWaitMinutes: 20 });
	const stillRunning = () =>
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));

	it('keeps waiting past the default cap on a project with a longer wait', async () => {
		stillRunning();
		const noteDecline = vi.fn();

		expect(
			await handler.handle(
				ctx(
					{ ...checks, headSha: 'cafe' },
					{ recheckAttempt: 20, project: LONG_WAIT, noteDecline },
				),
			),
		).toBeNull();

		expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
		const [job, , delayMs] = scheduleCoalescedJob.mock.calls[0];
		expect(job).toMatchObject({ recheckAttempt: 21 });
		expect(delayMs).toBe(30_000);
		expect(createFailedRun).not.toHaveBeenCalled();
		expect((noteDecline.mock.calls[0][0] as TriggerDecline).reason).toContain('attempt 21 of 40');
	});

	it('gives up at its own cap, naming the setting as the lever', async () => {
		stillRunning();

		expect(
			await handler.handle(
				ctx({ ...checks, headSha: 'cafe' }, { recheckAttempt: 40, project: LONG_WAIT }),
			),
		).toBeNull();

		expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		expect(createFailedRun).toHaveBeenCalledOnce();
		const { error, failureDiagnosis } = createFailedRun.mock.calls[0][0];
		expect(failureDiagnosis?.kind).toBe('review-waiting-for-checks');
		expect(error).toContain('Re-checks spent: 40 of 40');
		expect(error).toContain('Check Wait');
		expect(error).toContain('20 minutes');
	});

	it('names the default wait on a give-up when the project sets nothing', async () => {
		stillRunning();

		await handler.handle(ctx({ ...checks, headSha: 'cafe' }, { recheckAttempt: 20 }));

		const { error } = createFailedRun.mock.calls[0][0];
		expect(error).toContain('Re-checks spent: 20 of 20');
		expect(error).toContain('Check Wait');
		expect(error).toContain('10 minutes');
	});

	it('bounds the mergeability wait too — the two share one budget', async () => {
		getPullRequest.mockResolvedValue({
			number: 9,
			headBranch: 'issue-9',
			headSha: 'cafe',
			baseBranch: 'main',
			baseSha: 'base-sha-123',
			mergeable: null,
			authorLogin: 'operator-human',
			state: 'open',
		});

		await handler.handle(
			ctx({ ...checks, headSha: 'cafe' }, { recheckAttempt: 20, project: LONG_WAIT }),
		);

		expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
		expect(scheduleCoalescedJob.mock.calls[0][0]).toMatchObject({ recheckAttempt: 21 });
		expect(createFailedRun).not.toHaveBeenCalled();
	});

	it('leaves the read-failed budget and its backoff unchanged', async () => {
		getAggregateCheckStatus.mockRejectedValue(new Error('502 Bad Gateway'));

		await handler.handle(
			ctx({ ...checks, headSha: 'cafe' }, { readFailureRecheckAttempt: 2, project: LONG_WAIT }),
		);
		expect(scheduleCoalescedJob.mock.calls[0][2]).toBe(120_000);

		await handler.handle(
			ctx({ ...checks, headSha: 'cafe' }, { readFailureRecheckAttempt: 15, project: LONG_WAIT }),
		);
		expect(createFailedRun).toHaveBeenCalledOnce();
		const { error } = createFailedRun.mock.calls[0][0];
		expect(error).toContain('Re-checks spent: 15 of 15');
		expect(error).not.toContain('Check Wait');
	});
});

/**
 * A retry that meets a defer is a wait, and says what for (issue #1049).
 *
 * The observed case: a PR touching only paths every CI workflow `paths-ignore`s
 * has **zero** checks, under the repository's `reviewChecks: 'required'` the
 * `state-pending` chain spent its budget and recorded an abandoned review, and each
 * "Retry now" on that record re-entered here as a continuation, deferred again —
 * and was settled `failed` as a changed disposition while its own recheck went on
 * to pick the very same run back up. The handler now names the wait, and the chain
 * a retry started ends on the retried run rather than beside it.
 */
describe('review trigger — a retry that meets a defer names its wait (issue #1049)', () => {
	const checks = { kind: 'checks', action: 'completed', workItemId: '9' } as const;
	/** The retried abandoned record: a continuation carrying its run. */
	const retry = (noteDecline: (decline: TriggerDecline) => void, recheckAttempt?: number) =>
		ctx({ ...checks, headSha: 'cafe' }, { runId: 'run-abandoned', noteDecline, recheckAttempt });

	function notedDecline(noteDecline: ReturnType<typeof vi.fn>): TriggerDecline {
		expect(noteDecline).toHaveBeenCalledOnce();
		return noteDecline.mock.calls[0][0] as TriggerDecline;
	}

	it('names a zero-check head, and the if-present lever, on the recheck it schedules', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
		const noteDecline = vi.fn();

		expect(await handler.handle(retry(noteDecline))).toBeNull();

		expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
		const decline = notedDecline(noteDecline);
		expect(decline).toMatchObject({ kind: 'recheck-scheduled', retryAfterSec: 30 });
		expect(decline.reason).toContain("checks on pull request #9 at head 'cafe'");
		expect(decline.reason).toContain('none are registered');
		expect(decline.reason).toContain('attempt 1 of 20');
		// The one wait that may never end by itself — so the lever is named outright.
		expect(decline.reason).toContain('`if-present`');
		expect(decline.reason).toContain('disposition did not change');
		expect(decline.reason).not.toContain('disabled');
	});

	it('names the checks still running, with no policy advice they do not need', async () => {
		getAggregateCheckStatus.mockResolvedValue(
			checkStatus([
				['build', 'completed', 'success'],
				['test', 'in_progress', null],
			]),
		);
		const noteDecline = vi.fn();

		await handler.handle(retry(noteDecline, 4));

		const { reason } = notedDecline(noteDecline);
		expect(reason).toContain('still running: test');
		expect(reason).toContain('attempt 5 of 20');
		expect(reason).not.toContain('if-present');
		// The CI-wait lever belongs to the give-up record only (issue #1083).
		expect(reason).not.toContain('checksWaitMinutes');
	});

	it('names an unknown mergeability on the mergeability recheck', async () => {
		getPullRequest.mockResolvedValue({
			number: 9,
			headBranch: 'issue-9',
			headSha: 'cafe',
			baseBranch: 'main',
			baseSha: 'base-sha-123',
			mergeable: null,
			authorLogin: 'operator-human',
			state: 'open',
		});
		const noteDecline = vi.fn();

		await handler.handle(retry(noteDecline));

		expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
		const decline = notedDecline(noteDecline);
		expect(decline.kind).toBe('recheck-scheduled');
		expect(decline.reason).toContain('is mergeable');
		expect(getAggregateCheckStatus).not.toHaveBeenCalled();
	});

	// The note is what lets the settle *defer* a run, so it may only ever describe
	// a recheck that exists: a spent budget schedules none.
	it('notes no wait once the budget is spent', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
		const noteDecline = vi.fn();

		await handler.handle(retry(noteDecline, 20));

		expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		expect(noteDecline).not.toHaveBeenCalled();
	});

	describe('the give-up that ends such a wait', () => {
		/** The retried run as the settle left it: deferred on this head's chain. */
		const waitingRun = (overrides: Record<string, unknown> = {}) => ({
			id: 'run-abandoned',
			status: 'deferred',
			repository: PROJECT.repo,
			jobPayload: { type: 'scm', event: createMockScmEvent({ ...checks, headSha: 'cafe' }) },
			...overrides,
		});
		/** The chain's last recheck: a fresh decision, carrying no run of its own. */
		const exhaustedChain = () =>
			handler.handle(ctx({ ...checks, headSha: 'cafe' }, { recheckAttempt: 20 }));

		it('names the if-present lever on the record for a zero-check head', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([]));

			await exhaustedChain();

			expect(createFailedRun).toHaveBeenCalledOnce();
			expect(createFailedRun.mock.calls[0][0].error).toContain('`if-present`');
			// Raising the wait cannot help a head no workflow runs on (issue #1083).
			expect(createFailedRun.mock.calls[0][0].error).not.toContain('checksWaitMinutes');
		});

		/** Only the named phase's task has a run waiting; the other has none. */
		const waitingOnly = (phase: 'review' | 'respond-to-ci') =>
			getLatestRunForTask.mockImplementation(async (_projectId, _repository, _taskId, asked) =>
				asked === phase ? waitingRun() : undefined,
			);

		it('settles the run the retry left waiting instead of writing a second record', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
			waitingOnly('review');

			await exhaustedChain();

			expect(getLatestRunForTask).toHaveBeenCalledWith(PROJECT.id, PROJECT.repo, '9', 'review');
			expect(getActiveDispatchByRunId).toHaveBeenCalledWith('run-abandoned');
			expect(failRunFromStatus).toHaveBeenCalledExactlyOnceWith(
				'run-abandoned',
				expect.stringContaining('Review abandoned'),
				'deferred',
				undefined,
			);
			expect(failRunFromStatus.mock.calls[0][1]).toContain('`if-present`');
			expect(createFailedRun).not.toHaveBeenCalled();
		});

		// Issue #1203: the retried run the chain settles carries the same recorded
		// fact as a fresh record, so the WIP section reads it as waiting for CI.
		it('settles a still-running head’s waiting run with its CI-wait diagnosis', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));
			waitingOnly('review');

			await exhaustedChain();

			expect(failRunFromStatus).toHaveBeenCalledExactlyOnceWith(
				'run-abandoned',
				expect.stringContaining("Review didn't start yet"),
				'deferred',
				expect.objectContaining({ kind: 'review-waiting-for-checks' }),
			);
			expect(createFailedRun).not.toHaveBeenCalled();
		});

		// A retried Respond-to-CI run re-enters this same handler (it is the one that
		// dispatches Respond-to-CI), so its wait ends on this chain's give-up too —
		// looked up under Respond-to-CI's own task id, not Review's.
		it('settles a Respond-to-CI run the retry left waiting', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
			waitingOnly('respond-to-ci');

			await exhaustedChain();

			expect(getLatestRunForTask).toHaveBeenCalledWith(
				PROJECT.id,
				PROJECT.repo,
				'9-ci',
				'respond-to-ci',
			);
			expect(failRunFromStatus).toHaveBeenCalledExactlyOnceWith(
				'run-abandoned',
				expect.stringContaining('Review abandoned'),
				'deferred',
				undefined,
			);
			expect(createFailedRun).not.toHaveBeenCalled();
		});

		// A `deferred` Review with a dispatch of its own is waiting on *that*
		// dispatch — a rate limit, a held claim, an operator's fresh retry — which
		// settles it; this chain's give-up must not.
		it('leaves a deferred run that its own dispatch owns alone', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
			getLatestRunForTask.mockResolvedValue(waitingRun());
			getActiveDispatchByRunId.mockResolvedValue({ id: 'dispatch-retry' });

			await exhaustedChain();

			expect(failRunFromStatus).not.toHaveBeenCalled();
			expect(createFailedRun).toHaveBeenCalledOnce();
		});

		it.each([
			[
				'another head',
				{ jobPayload: { type: 'scm', event: createMockScmEvent({ headSha: 'beef' }) } },
			],
			['another repository', { repository: 'someone/else' }],
			['a run that is not waiting', { status: 'failed' }],
		])('leaves the latest run alone when it is for %s', async (_label, overrides) => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
			getLatestRunForTask.mockResolvedValue(waitingRun(overrides));

			await exhaustedChain();

			expect(failRunFromStatus).not.toHaveBeenCalled();
			expect(createFailedRun).toHaveBeenCalledOnce();
		});

		// The settle is conditional on the row still being `deferred`: a run that went
		// back to `running` meanwhile is left to its phase, and the give-up is still
		// recorded rather than lost.
		it('still records the give-up when the waiting run moved on first', async () => {
			getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
			getLatestRunForTask.mockResolvedValue(waitingRun());
			failRunFromStatus.mockResolvedValue(false);

			await exhaustedChain();

			expect(createFailedRun).toHaveBeenCalledOnce();
		});
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

/**
 * The PR+SHA claim is a *lease*, and a dispatched CI fix takes it out for as long
 * as its agent may run (issue #841). The claim's default five-minute TTL is sized
 * for the gap between a PR opening and its checks completing, which an agent run
 * readily outlives — and a lease that lapses mid-run leaves the slot free for a
 * delayed sibling completed-check event to take, spending a second fix attempt on
 * the red already being fixed and meeting the no-fix hand-over with a competing
 * claimant rather than this dispatch's own live lease.
 */
describe('review trigger — the CI fix holds the PR+SHA lease for its run (issue #841)', () => {
	const checks = {
		kind: 'checks',
		action: 'completed',
		workItemId: '9',
		headSha: 'cafe',
		prBranch: 'issue-9',
	} as const;
	const KEY = `${PROJECT.repo}:9:cafe`;
	/** The lease a project on the coded 30-minute default gets: wall clock + 5 min margin. */
	const DEFAULT_CI_FIX_CLAIM_TTL_SEC = 35 * 60;

	/**
	 * A stand-in for the Redis claim with its TTL: key → seconds left. `claim` is
	 * `SET NX EX 300`, `refresh` is a plain `SET EX`, and {@link elapse} reaps what
	 * expired — so these tests contend for one real slot over real time rather than
	 * a canned boolean.
	 */
	const leases = new Map<string, number>();
	const elapse = (sec: number) => {
		for (const [key, left] of leases) {
			if (left <= sec) leases.delete(key);
			else leases.set(key, left - sec);
		}
	};

	beforeEach(() => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
		leases.clear();
		claimReviewDispatch.mockImplementation(async (key: string) => {
			if (leases.has(key)) return false;
			leases.set(key, 5 * 60);
			return true;
		});
		refreshReviewDispatchClaim.mockImplementation(async (key: string, ttlSec: number) => {
			leases.set(key, ttlSec);
		});
	});

	it('extends the claim to the fix run’s wall clock when it dispatches', async () => {
		expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'respond-to-ci' });

		expect(refreshReviewDispatchClaim).toHaveBeenCalledWith(KEY, DEFAULT_CI_FIX_CLAIM_TTL_SEC);
	});

	it('locks a sibling out past the point the ordinary five-minute lease would have lapsed', async () => {
		await handler.handle(ctx(checks));
		// Longer than the default TTL, well inside a 30-minute agent run.
		elapse(6 * 60);

		expect(await handler.handle(ctx(checks))).toBeNull();
		// The decisive assertion: exactly one fix attempt was spent on this red.
		expect(claimRespondToCiAttempt).toHaveBeenCalledTimes(1);
	});

	// The honest bound, stated so the docs can't drift past it: this is a lease, not
	// a lock. Past the whole configured wall clock plus its margin — a Redis restart
	// is what is left once the lease tracks the timeout — the slot does fall free
	// again, and the per-PR fix-attempt cap is what bounds a duplicate fix from there.
	it('does not pretend to hold the slot beyond the extended lease', async () => {
		await handler.handle(ctx(checks));
		elapse(DEFAULT_CI_FIX_CLAIM_TTL_SEC + 60);

		expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'respond-to-ci' });
	});

	/**
	 * The lease is derived from the timeout the fix will actually run under, not
	 * from the coded default: `agents.respondToCi.timeoutMs` is valid to 45 minutes
	 * and `SWARM_AGENT_TIMEOUT_MS` moves the default under it, and a lease fixed at
	 * the default's 35 minutes lapsed in the tail of either.
	 */
	describe('sized from the timeout the fix actually runs under', () => {
		/** The same `checks` context, against a project with its own agent config. */
		const projectCtx = (project: ProjectConfig) =>
			createMockScmTriggerContext({
				project,
				scm: SCM,
				event: createMockScmEvent(checks),
			});

		it('covers a Respond-to-CI timeout configured to the schema’s 45-minute maximum', async () => {
			const project = createMockProjectConfig({
				agents: { respondToCi: { timeoutMs: 45 * 60 * 1000 } },
			});

			expect(await handler.handle(projectCtx(project))).toMatchObject({
				phase: 'respond-to-ci',
			});
			expect(refreshReviewDispatchClaim).toHaveBeenCalledWith(KEY, 50 * 60);

			// Minute 36 — where the old fixed lease had already lapsed — and a delayed
			// sibling completed-check event for the same head is still locked out.
			elapse(36 * 60);
			expect(await handler.handle(projectCtx(project))).toBeNull();
			// The decisive assertion: no second fix attempt was spent on this red.
			expect(claimRespondToCiAttempt).toHaveBeenCalledTimes(1);
		});

		it('follows the operator’s SWARM_AGENT_TIMEOUT_MS when the project sets no override', async () => {
			vi.stubEnv('SWARM_AGENT_TIMEOUT_MS', String(40 * 60 * 1000));
			try {
				expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'respond-to-ci' });
				expect(refreshReviewDispatchClaim).toHaveBeenCalledWith(KEY, 45 * 60);
			} finally {
				vi.unstubAllEnvs();
			}
		});

		it('prefers the project’s own override to the global default', async () => {
			vi.stubEnv('SWARM_AGENT_TIMEOUT_MS', String(40 * 60 * 1000));
			try {
				const project = createMockProjectConfig({
					agents: { respondToCi: { timeoutMs: 10 * 60 * 1000 } },
				});

				expect(await handler.handle(projectCtx(project))).toMatchObject({
					phase: 'respond-to-ci',
				});
				expect(refreshReviewDispatchClaim).toHaveBeenCalledWith(KEY, 15 * 60);
			} finally {
				vi.unstubAllEnvs();
			}
		});
	});

	it('leaves the lease alone when the attempt cap drops the dispatch — nothing runs', async () => {
		claimRespondToCiAttempt.mockResolvedValue({ allowed: false, attempt: 5 });

		expect(await handler.handle(ctx(checks))).toBeNull();
		expect(refreshReviewDispatchClaim).not.toHaveBeenCalled();
	});

	it('leaves a Review dispatch on the ordinary TTL — only a CI fix extends it', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'success']]));

		expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'review' });
		expect(refreshReviewDispatchClaim).not.toHaveBeenCalled();
	});
});

describe('review trigger — a red on an adjudicated approved head (issue #1128)', () => {
	const checks = {
		kind: 'checks',
		action: 'completed',
		workItemId: '9',
		headSha: 'cafe',
		prBranch: 'issue-9',
	} as const;
	/** The policy's precondition: merge automation on for the repository. */
	const AUTO_MERGE = createMockProjectConfig({ autoMerge: true });
	const autoCtx = (extra: Parameters<typeof ctx>[1] = {}) =>
		ctx(checks, { project: AUTO_MERGE, ...extra });

	beforeEach(() => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
	});

	function adjudicatedAndApproved(): void {
		hasCiNoFixRecovery.mockResolvedValue(true);
		getApprovedHeadSlot.mockResolvedValue({ checksRerunAt: null });
	}

	it('goes to the re-run policy — no Respond-to-CI, no claim, no slot', async () => {
		adjudicatedAndApproved();

		expect(await handler.handle(autoCtx())).toBeNull();

		expect(hasCiNoFixRecovery).toHaveBeenCalledWith(AUTO_MERGE, '9', 'cafe');
		expect(getApprovedHeadSlot).toHaveBeenCalledWith({
			projectId: AUTO_MERGE.id,
			repository: AUTO_MERGE.repo,
			prNumber: '9',
			headSha: 'cafe',
		});
		expect(recoverAdjudicatedApprovedHead).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ prNumber: '9', headSha: 'cafe', failedChecks: ['test'] }),
		);
		expect(claimReviewDispatch).not.toHaveBeenCalled();
		expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
		expect(reserveReviewVerdict).not.toHaveBeenCalled();
		expect(scheduleCoalescedJob).not.toHaveBeenCalled();
	});

	// The wait is past the settle window, not the CI-wait cadence, and draws none
	// of that budget: the attempt count rides through untouched.
	it('re-reads a settling re-run after the settle window, off the CI-wait budget', async () => {
		adjudicatedAndApproved();
		recoverAdjudicatedApprovedHead.mockResolvedValue('rerun-settling');
		const noteDecline = vi.fn();

		expect(await handler.handle(autoCtx({ recheckAttempt: 3, noteDecline }))).toBeNull();

		expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
		const [job, , delayMs, waitReason] = scheduleCoalescedJob.mock.calls[0];
		expect(job).toMatchObject({ recheckAttempt: 3 });
		expect(delayMs).toBe(135_000);
		expect(waitReason).toBe('recheck');
		expect(noteDecline).toHaveBeenCalledWith(
			expect.objectContaining({ kind: 'recheck-scheduled', retryAfterSec: 135 }),
		);
		expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
	});

	// The shortest CI wait the schema allows is two rechecks — fewer than the
	// settle window needs. A spent budget must not end the head as an abandoned
	// Review: the settle recheck still lands, and its read hands the head on.
	it('still re-reads a settling re-run when the CI-wait budget is already spent', async () => {
		adjudicatedAndApproved();
		recoverAdjudicatedApprovedHead.mockResolvedValue('rerun-settling');
		const shortWait = createMockProjectConfig({ autoMerge: true, reviewChecksWaitMinutes: 1 });

		expect(await handler.handle(ctx(checks, { project: shortWait, recheckAttempt: 2 }))).toBeNull();

		expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
		expect(scheduleCoalescedJob.mock.calls[0][2]).toBe(135_000);
		expect(createFailedRun).not.toHaveBeenCalled();
	});

	it('drops the event once the head is handed to the operator', async () => {
		adjudicatedAndApproved();
		recoverAdjudicatedApprovedHead.mockResolvedValue('needs-operator');

		expect(await handler.handle(autoCtx())).toBeNull();
		expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
	});

	// The policy's own precondition, checked before any read: without merge
	// automation nothing would re-run or merge the head, so the red keeps its
	// pre-#1128 routing rather than being dropped.
	it('routes to Respond-to-CI when merge automation is off', async () => {
		adjudicatedAndApproved();

		expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'respond-to-ci' });
		expect(hasCiNoFixRecovery).not.toHaveBeenCalled();
		expect(recoverAdjudicatedApprovedHead).not.toHaveBeenCalled();
	});

	it('still reports a red the base branch explains when merge automation is off', async () => {
		adjudicatedAndApproved();
		// The base branch's head reads the same red `test` the pull request fails on.
		getBranchHead.mockResolvedValue('base-head-sha');

		expect(await handler.handle(ctx(checks))).toBeNull();

		expect(deliveryPostComment).toHaveBeenCalledOnce();
		expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
		expect(recoverAdjudicatedApprovedHead).not.toHaveBeenCalled();
	});

	// The policy did nothing (its claim or read failed, or the slot vanished), so
	// the red falls open to the routing it would have had without #1128.
	it('falls open to Respond-to-CI when the policy answers not-applicable', async () => {
		adjudicatedAndApproved();
		recoverAdjudicatedApprovedHead.mockResolvedValue('not-applicable');

		expect(await handler.handle(autoCtx())).toMatchObject({ phase: 'respond-to-ci' });
		expect(recoverAdjudicatedApprovedHead).toHaveBeenCalledOnce();
		expect(claimRespondToCiAttempt).toHaveBeenCalledTimes(1);
	});

	it('routes a red that was never adjudicated to Respond-to-CI, unchanged', async () => {
		getApprovedHeadSlot.mockResolvedValue({ checksRerunAt: null });

		expect(await handler.handle(autoCtx())).toMatchObject({ phase: 'respond-to-ci' });
		expect(recoverAdjudicatedApprovedHead).not.toHaveBeenCalled();
	});

	it('routes an adjudicated head that was not approved to Respond-to-CI, unchanged', async () => {
		hasCiNoFixRecovery.mockResolvedValue(true);

		expect(await handler.handle(autoCtx())).toMatchObject({ phase: 'respond-to-ci' });
		expect(recoverAdjudicatedApprovedHead).not.toHaveBeenCalled();
	});

	it('fails open to Respond-to-CI when the adjudication cannot be read', async () => {
		hasCiNoFixRecovery.mockRejectedValue(new Error('db down'));

		expect(await handler.handle(autoCtx())).toMatchObject({ phase: 'respond-to-ci' });
		expect(recoverAdjudicatedApprovedHead).not.toHaveBeenCalled();
	});
});

describe('review trigger — the no-fix hand-back to Review (issue #841)', () => {
	const checks = {
		kind: 'checks',
		action: 'completed',
		workItemId: '9',
		headSha: 'cafe',
		prBranch: 'issue-9',
	} as const;

	/** The state the recovery re-enters on: nothing re-ran the checks, so the head is still red. */
	beforeEach(() => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));
	});

	it('dispatches Review on a still-red head, without spending a CI-fix attempt', async () => {
		const result = await handler.handle(ctx(checks, { ciNoFixRecovery: true }));

		expect(result).toEqual({
			phase: 'review',
			taskId: '9',
			prNumber: '9',
			// The fetched PR's head branch (the default mock's), not the event's.
			prBranch: 'issue-42',
			headSha: 'cafe',
			verdictSlotReserved: true,
		});
		expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
	});

	// The bypass is opt-in: an ordinary red check suite is unaffected, so nothing
	// about the `fixed` path or a genuine first CI failure changes.
	it('still routes the identical event to Respond-to-CI without the marker', async () => {
		const result = await handler.handle(ctx(checks));

		expect(result).toEqual({
			phase: 'respond-to-ci',
			taskId: '9-ci',
			prNumber: '9',
			prBranch: 'issue-9',
			headSha: 'cafe',
		});
		expect(claimRespondToCiAttempt).toHaveBeenCalledTimes(1);
	});

	// Issue #1128: the adjudicated red is still red, so its merge would only be
	// refused again — the re-arm belongs to a genuinely green head. A head this PR
	// already approved (approve, then red, then `no-fix`) goes to the approved-head
	// re-run policy instead, and nothing is dispatched.
	it('sends an adjudicated head whose slot is already submitted to the re-run policy', async () => {
		reserveReviewVerdict.mockResolvedValue({
			status: 'reused',
			id: 'v1',
			ordinal: 1,
			state: 'submitted',
		});

		expect(await handler.handle(ctx(checks, { ciNoFixRecovery: true }))).toBeNull();

		expect(rearmMergeAutomationForGreenHead).not.toHaveBeenCalled();
		expect(recoverAdjudicatedApprovedHead).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				project: PROJECT,
				scm: SCM,
				prNumber: '9',
				headSha: 'cafe',
				failedChecks: ['test'],
			}),
		);
		expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
	});

	it('still reserves the durable review-verdict slot, and a capped reservation still skips', async () => {
		reserveReviewVerdict.mockResolvedValue({ status: 'capped', ordinal: 3 });

		expect(await handler.handle(ctx(checks, { ciNoFixRecovery: true }))).toBeNull();

		expect(reserveReviewVerdict).toHaveBeenCalledWith(
			{
				projectId: PROJECT.id,
				repository: PROJECT.repo,
				prNumber: '9',
				headSha: 'cafe',
			},
			'dispatch-1',
		);
	});

	// The recovery *owns* the PR+SHA slot rather than contending for it: the
	// finished Respond-to-CI dispatch hands its claim over (refreshed, not
	// released — `src/dispatch/ci-no-fix-recovery.ts`), so re-claiming here would
	// see that still-live claim and drop the recovery as a duplicate, recreating
	// the review limbo this whole path exists to remove.
	it('reuses the held dispatch claim instead of re-claiming', async () => {
		expect(await handler.handle(ctx(checks, { ciNoFixRecovery: true }))).toMatchObject({
			phase: 'review',
		});
		expect(claimReviewDispatch).not.toHaveBeenCalled();
	});

	// The delayed-sibling race the hand-over closes. The aggregate decision waits
	// for *every* suite to complete, so a two-suite PR can have one suite's webhook
	// decide the aggregate while the other's is still in flight — and that delayed
	// sibling carries no marker. Were the claim released, it would take the freed
	// slot, spend a second CI-fix attempt on a red SWARM already adjudicated, and
	// leave the recovery to fail its own claim and settle `no-trigger`; the
	// recovery's deterministic delivery id then absorbs the second run's recovery
	// as a repeat, so no Review ever runs.
	describe('with the claim held across the hand-over', () => {
		// A stand-in for the Redis `SET NX` claim, so the two events below contend
		// for one real slot rather than a canned boolean.
		const claims = new Set<string>();

		beforeEach(() => {
			claims.clear();
			claimReviewDispatch.mockImplementation(async (key: string) => {
				if (claims.has(key)) return false;
				claims.add(key);
				return true;
			});
			// The claim the finished Respond-to-CI dispatch handed to the recovery.
			claims.add(`${PROJECT.repo}:9:cafe`);
		});

		it('locks a delayed unmarked check event out of starting a second CI fix', async () => {
			expect(await handler.handle(ctx(checks))).toBeNull();
			expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
		});

		it('still dispatches exactly one Review for the marked recovery behind it', async () => {
			await handler.handle(ctx(checks));

			expect(await handler.handle(ctx(checks, { ciNoFixRecovery: true }))).toMatchObject({
				phase: 'review',
				prNumber: '9',
				headSha: 'cafe',
			});
			expect(reserveReviewVerdict).toHaveBeenCalledTimes(1);
		});
	});

	it('does not short-circuit a state-pending defer — a still-running check still defers', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));

		expect(await handler.handle(ctx(checks, { ciNoFixRecovery: true }))).toBeNull();
		expect(scheduleCoalescedJob).toHaveBeenCalledTimes(1);
		expect(claimReviewDispatch).not.toHaveBeenCalled();
		// The marker rides the deferred payload: it states a fact about this head
		// that a recheck does not change, and dropping it would send the recovery
		// back to Respond-to-CI once the check finally reports red.
		expect(scheduleCoalescedJob.mock.calls[0][0]).toMatchObject({ ciNoFixRecovery: true });
	});

	it('carries the marker on the durable give-up record, so a dashboard retry keeps the bypass', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));

		await handler.handle(ctx(checks, { ciNoFixRecovery: true, recheckAttempt: 20 }));

		expect(createFailedRun.mock.calls[0][0].jobPayload).toMatchObject({
			ciNoFixRecovery: true,
		});
	});

	it('does not bypass the closed-PR skip', async () => {
		getPullRequest.mockResolvedValue({
			number: 9,
			headBranch: 'issue-9',
			headSha: 'cafe',
			baseBranch: 'main',
			baseSha: 'base123',
			mergeable: null,
			authorLogin: 'operator-human',
			state: 'closed',
		});

		expect(await handler.handle(ctx(checks, { ciNoFixRecovery: true }))).toBeNull();
		expect(getAggregateCheckStatus).not.toHaveBeenCalled();
	});

	it('does not bypass the work-item origin gate', async () => {
		hasRunForTask.mockResolvedValue(false);

		expect(await handler.handle(ctx(checks, { ciNoFixRecovery: true }))).toBeNull();
		expect(getAggregateCheckStatus).not.toHaveBeenCalled();
		expect(claimReviewDispatch).not.toHaveBeenCalled();
	});

	it('does not bypass the conflicting-PR route to Resolve-conflicts', async () => {
		getPullRequest.mockResolvedValue({
			number: 9,
			headBranch: 'issue-9',
			headSha: 'cafe',
			baseBranch: 'main',
			baseSha: 'base123',
			mergeable: false,
			authorLogin: 'operator-human',
			state: 'open',
		});

		expect(await handler.handle(ctx(checks, { ciNoFixRecovery: true }))).toMatchObject({
			phase: 'resolve-conflicts',
			prNumber: '9',
		});
	});

	it('does not bypass the draft skip on a pull-request event', async () => {
		expect(
			await handler.handle(
				ctx(
					{
						kind: 'pull-request',
						action: 'opened',
						workItemId: '9',
						headSha: 'cafe',
						isDraft: true,
					},
					{ ciNoFixRecovery: true },
				),
			),
		).toBeNull();
	});

	it('does not bypass the fork skip on a pull-request event', async () => {
		expect(
			await handler.handle(
				ctx(
					{
						kind: 'pull-request',
						action: 'opened',
						workItemId: '9',
						headSha: 'cafe',
						isDraft: false,
						isCrossRepo: true,
					},
					{ ciNoFixRecovery: true },
				),
			),
		).toBeNull();
	});
});

describe('review trigger — a red the base branch explains (issue #873)', () => {
	const checks = {
		kind: 'checks',
		action: 'completed',
		workItemId: '9',
		headSha: 'cafe',
		prBranch: 'issue-9',
	} as const;

	const BASE_HEAD = 'base-head-sha';

	/**
	 * Answer the aggregate query per commit, so the pull request's head and the
	 * base branch's head can disagree — which is the whole question this path asks.
	 */
	function aggregateByCommit(byRef: Record<string, AggregateCheckStatus>): void {
		getAggregateCheckStatus.mockImplementation(async (_project: ProjectConfig, ref: string) => {
			const status = byRef[ref];
			if (!status) throw new Error(`unexpected aggregate read for ${ref}`);
			return status;
		});
	}

	const PR_RED = checkStatus([
		['build', 'completed', 'success'],
		['unit', 'completed', 'failure'],
	]);

	beforeEach(() => {
		getBranchHead.mockResolvedValue(BASE_HEAD);
	});

	it('routes to Respond-to-CI when the base branch is green', async () => {
		aggregateByCommit({
			cafe: PR_RED,
			[BASE_HEAD]: checkStatus([['unit', 'completed', 'success']]),
		});

		expect(await handler.handle(ctx(checks))).toEqual({
			phase: 'respond-to-ci',
			taskId: '9-ci',
			prNumber: '9',
			prBranch: 'issue-9',
			headSha: 'cafe',
		});
		expect(claimRespondToCiAttempt).toHaveBeenCalledTimes(1);
		expect(deliveryPostComment).not.toHaveBeenCalled();
	});

	// Fails open: never withhold a legitimate fix because the base could not be read.
	it('routes to Respond-to-CI when the base branch head cannot be read', async () => {
		getBranchHead.mockRejectedValue(new Error('rate limited'));
		aggregateByCommit({ cafe: PR_RED });

		expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'respond-to-ci' });
		expect(claimRespondToCiAttempt).toHaveBeenCalledTimes(1);
		expect(deliveryPostComment).not.toHaveBeenCalled();
	});

	// The intersection requirement: a coincidentally red base is not a hiding place.
	it('routes to Respond-to-CI when the red base fails on other checks', async () => {
		aggregateByCommit({
			cafe: PR_RED,
			[BASE_HEAD]: checkStatus([['lint', 'completed', 'failure']]),
		});

		expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'respond-to-ci' });
		expect(claimRespondToCiAttempt).toHaveBeenCalledTimes(1);
		expect(deliveryPostComment).not.toHaveBeenCalled();
		expect(loggerInfo).toHaveBeenCalledWith(
			expect.stringContaining('red on other checks'),
			expect.objectContaining({ baseFailedChecks: ['lint'], failedChecks: ['unit'] }),
		);
	});

	describe('when the base branch is red on the same checks', () => {
		beforeEach(() => {
			aggregateByCommit({
				cafe: PR_RED,
				[BASE_HEAD]: checkStatus([
					['unit', 'completed', 'failure'],
					['lint', 'completed', 'failure'],
				]),
			});
		});

		it('dispatches nothing and spends no fix attempt, verdict slot or dedup claim', async () => {
			expect(await handler.handle(ctx(checks))).toBeNull();

			expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
			expect(reserveReviewVerdict).not.toHaveBeenCalled();
			// The slot has to stay free: a human re-running CI against a fixed base is
			// what produces the Review this PR is still owed.
			expect(claimReviewDispatch).not.toHaveBeenCalled();
			expect(createFailedRun).not.toHaveBeenCalled();
			expect(scheduleCoalescedJob).not.toHaveBeenCalled();
		});

		it('comments once, naming the base branch, its head and the shared checks', async () => {
			await handler.handle(ctx(checks));

			expect(deliveryProvider).toHaveBeenCalledWith(PROJECT, 'implementer');
			expect(deliveryPostComment).toHaveBeenCalledTimes(1);
			const posted = deliveryPostComment.mock.calls[0][0];
			expect(posted.prNumber).toBe(9);
			expect(posted.body).toContain('`main`');
			expect(posted.body).toContain(BASE_HEAD.slice(0, 7));
			expect(posted.body).toContain('`unit`');
			// Only the shared failure is named — `lint` is the base's alone.
			expect(posted.body).not.toContain('`lint`');
			expect(loggerInfo).toHaveBeenCalledWith(
				expect.stringContaining('attributed to the base branch'),
				expect.objectContaining({
					prNumber: '9',
					headSha: 'cafe',
					baseBranch: 'main',
					baseHeadSha: BASE_HEAD,
					sharedChecks: ['unit'],
				}),
			);
		});

		it('reuses one delivery id across sibling check events at the same base head', async () => {
			await handler.handle(ctx(checks));
			await handler.handle(ctx(checks));

			expect(deliveryPostComment).toHaveBeenCalledTimes(2);
			expect(deliveryPostComment.mock.calls[0][0].deliveryId).toBe(
				deliveryPostComment.mock.calls[1][0].deliveryId,
			);
		});

		it('mints a new delivery id once the base head advances', async () => {
			await handler.handle(ctx(checks));

			const nextBase = 'base-head-sha-2';
			getBranchHead.mockResolvedValue(nextBase);
			aggregateByCommit({
				cafe: PR_RED,
				[nextBase]: checkStatus([['unit', 'completed', 'failure']]),
			});
			await handler.handle(ctx(checks));

			expect(deliveryPostComment.mock.calls[0][0].deliveryId).not.toBe(
				deliveryPostComment.mock.calls[1][0].deliveryId,
			);
		});

		it('keeps the attribution when the comment cannot be posted', async () => {
			deliveryPostComment.mockRejectedValue(new Error('502 from the provider'));

			expect(await handler.handle(ctx(checks))).toBeNull();

			expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
			expect(loggerError).toHaveBeenCalledWith(
				expect.stringContaining('failed to post the base-blocked notice'),
				expect.objectContaining({ prNumber: '9', baseHeadSha: BASE_HEAD }),
			);
		});

		it('says nothing at all when the CI-fix phase is disabled for the project', async () => {
			const project = createMockProjectConfig({ pipeline: { respondToCi: { enabled: false } } });

			expect(await handler.handle({ ...ctx(checks), project })).toBeNull();

			expect(deliveryPostComment).not.toHaveBeenCalled();
		});
	});

	// A pull request retargeted off the project's configured base still builds
	// against the base it now names, so that is the branch the attribution asks
	// about — reading `project.baseBranch` instead would both invent an
	// explanation the PR never built against and withhold its CI fix.
	describe('when the pull request targets a base other than the project default', () => {
		const RELEASE_HEAD = 'release-head-sha';

		beforeEach(() => {
			getPullRequest.mockResolvedValue({
				number: 9,
				headBranch: 'issue-42',
				headSha: 'cafe',
				baseBranch: 'release/1.0',
				baseSha: 'release-base-sha',
				mergeable: true,
				authorLogin: 'operator-human',
				state: 'open',
			});
			getBranchHead.mockImplementation(async (_project: ProjectConfig, branch: string) =>
				branch === 'release/1.0' ? RELEASE_HEAD : BASE_HEAD,
			);
		});

		it('routes to Respond-to-CI when the project base is red but its own base is green', async () => {
			aggregateByCommit({
				cafe: PR_RED,
				[RELEASE_HEAD]: checkStatus([['unit', 'completed', 'success']]),
				[BASE_HEAD]: checkStatus([['unit', 'completed', 'failure']]),
			});

			expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'respond-to-ci' });
			expect(getBranchHead).toHaveBeenCalledWith(PROJECT, 'release/1.0', 'implementer');
			expect(getBranchHead).not.toHaveBeenCalledWith(PROJECT, 'main', 'implementer');
			expect(deliveryPostComment).not.toHaveBeenCalled();
		});

		it('blocks and names its own base when that base is red on the shared check', async () => {
			aggregateByCommit({
				cafe: PR_RED,
				[RELEASE_HEAD]: checkStatus([['unit', 'completed', 'failure']]),
			});

			expect(await handler.handle(ctx(checks))).toBeNull();

			expect(claimRespondToCiAttempt).not.toHaveBeenCalled();
			const posted = deliveryPostComment.mock.calls[0][0];
			expect(posted.body).toContain('`release/1.0`');
			expect(posted.body).not.toContain('`main`');
			expect(posted.body).toContain(RELEASE_HEAD.slice(0, 7));
			expect(loggerInfo).toHaveBeenCalledWith(
				expect.stringContaining('attributed to the base branch'),
				expect.objectContaining({ baseBranch: 'release/1.0', baseHeadSha: RELEASE_HEAD }),
			);
		});
	});

	// The cost contract: the base is only ever read on an already-red aggregate.
	it('never reads the base branch when the pull request is green', async () => {
		aggregateByCommit({ cafe: checkStatus([['unit', 'completed', 'success']]) });

		expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'review' });
		expect(getBranchHead).not.toHaveBeenCalled();
	});

	// The #841 bypass runs first and answers the same event without a base read.
	it('never reads the base branch on a no-fix recovery', async () => {
		aggregateByCommit({ cafe: PR_RED });

		expect(await handler.handle(ctx(checks, { ciNoFixRecovery: true }))).toMatchObject({
			phase: 'review',
		});
		expect(getBranchHead).not.toHaveBeenCalled();
	});
});

/**
 * Two repositories of one project with different check policies (issue #1109).
 *
 * Whether a repository has CI is that repository's property: the live
 * `under-control-platform` project pairs a backend with PR CI (`required`) and a
 * mobile app with none (`if-present`). Each pull request is decided under its own
 * repository's `reviewChecks` and `reviewChecksWaitMinutes`, never the other's.
 */
describe('review trigger — two repositories with different check policies (issue #1109)', () => {
	const [MOBILE, PLATFORM] = createMockProjectRepositoryPair(['acme/mobile', 'acme/platform'], {
		repositories: [
			{ repo: 'acme/mobile', reviewChecks: 'if-present' },
			{ repo: 'acme/platform', reviewChecks: 'required', reviewChecksWaitMinutes: 30 },
		],
	});
	const checks = { kind: 'checks', action: 'completed', workItemId: '42' } as const;
	const updated = {
		kind: 'pull-request',
		action: 'updated',
		workItemId: '42',
		headSha: 'abc123',
		isDraft: false,
		isCrossRepo: false,
	} as const;

	beforeEach(() => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([]));
	});

	it('scopes each repository to its own policy and wait', () => {
		expect(MOBILE).toMatchObject({ repo: 'acme/mobile', reviewChecks: 'if-present' });
		expect(MOBILE.reviewChecksWaitMinutes).toBeUndefined();
		expect(PLATFORM).toMatchObject({
			repo: 'acme/platform',
			reviewChecks: 'required',
			reviewChecksWaitMinutes: 30,
		});
	});

	it('reviews a zero-check head immediately in the if-present repository', async () => {
		const result = await handler.handle(ctx({ ...checks, headSha: 'abc123' }, { project: MOBILE }));

		expect(result).toMatchObject({ phase: 'review', prNumber: '42', headSha: 'abc123' });
		expect(claimReviewDispatch).toHaveBeenCalledOnce();
		expect(scheduleCoalescedJob).not.toHaveBeenCalled();
	});

	it('waits on a zero-check head in the required repository, naming its own lever', async () => {
		const noteDecline = vi.fn();

		const result = await handler.handle(
			ctx({ ...checks, headSha: 'abc123' }, { project: PLATFORM, noteDecline }),
		);

		expect(result).toBeNull();
		expect(claimReviewDispatch).not.toHaveBeenCalled();
		expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
		const { reason } = noteDecline.mock.calls[0][0] as TriggerDecline;
		expect(reason).toContain('`reviewChecks`');
		expect(reason).toContain('`if-present`');
		// The platform's own 30-minute wait buys 60 rechecks at 30 s, not the default 20.
		expect(reason).toContain('attempt 1 of 60');
	});

	it('reviews a zero-check push in the if-present repository and not in the required one', async () => {
		const mobile = await handler.handle(ctx(updated, { project: MOBILE }));
		expect(mobile).toMatchObject({ phase: 'review', prNumber: '42', headSha: 'abc123' });

		claimReviewDispatch.mockClear();
		getAggregateCheckStatus.mockClear();

		const platform = await handler.handle(ctx(updated, { project: PLATFORM }));
		expect(platform).toBeNull();
		expect(getAggregateCheckStatus).not.toHaveBeenCalled();
		expect(claimReviewDispatch).not.toHaveBeenCalled();
	});

	it("gives up at each repository's own wait, naming that repository's minutes", async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));

		await handler.handle(
			ctx({ ...checks, headSha: 'abc123' }, { project: MOBILE, recheckAttempt: 20 }),
		);
		expect(createFailedRun).toHaveBeenCalledOnce();
		expect(createFailedRun.mock.calls[0][0].error).toContain('10 minutes');

		createFailedRun.mockClear();
		await handler.handle(
			ctx({ ...checks, headSha: 'abc123' }, { project: PLATFORM, recheckAttempt: 20 }),
		);
		// Attempt 20 is well inside the platform's 60-attempt budget.
		expect(createFailedRun).not.toHaveBeenCalled();

		await handler.handle(
			ctx({ ...checks, headSha: 'abc123' }, { project: PLATFORM, recheckAttempt: 60 }),
		);
		expect(createFailedRun).toHaveBeenCalledOnce();
		expect(createFailedRun.mock.calls[0][0].error).toContain('30 minutes');
	});
});

describe('review trigger — a green head wakes the merge waiting on it (issue #1173)', () => {
	const checks = {
		kind: 'checks',
		action: 'completed',
		workItemId: '42',
		headSha: 'abc123',
		prBranch: 'issue-42',
	} as const;

	beforeEach(() => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'success']]));
	});

	it('wakes it on a green completed-checks event that dispatches Review', async () => {
		expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'review' });
		expect(promoteMergeChecksWaits).toHaveBeenCalledExactlyOnceWith(
			PROJECT.id,
			PROJECT.repo,
			'abc123',
		);
	});

	it('wakes it on a green head whose slot is already submitted, beside the re-arm', async () => {
		reserveReviewVerdict.mockResolvedValue({
			status: 'reused',
			id: 'v1',
			ordinal: 1,
			state: 'submitted',
		});

		expect(await handler.handle(ctx(checks))).toBeNull();
		expect(promoteMergeChecksWaits).toHaveBeenCalledExactlyOnceWith(
			PROJECT.id,
			PROJECT.repo,
			'abc123',
		);
		expect(rearmMergeAutomationForGreenHead).toHaveBeenCalledOnce();
	});

	// The head a base update produced: its merge dispatch pre-claimed the PR+SHA
	// slot (`claimUpdatedHeadReviewSlot`), so the event is dropped at the claim.
	it('wakes it even when the PR+SHA claim is already held', async () => {
		claimReviewDispatch.mockResolvedValue(false);

		expect(await handler.handle(ctx(checks))).toBeNull();
		expect(promoteMergeChecksWaits).toHaveBeenCalledExactlyOnceWith(
			PROJECT.id,
			PROJECT.repo,
			'abc123',
		);
		expect(promoteMergeChecksWaits.mock.invocationCallOrder[0]).toBeLessThan(
			claimReviewDispatch.mock.invocationCallOrder[0] as number,
		);
	});

	it('does not wake it on a red head', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));

		expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'respond-to-ci' });
		expect(promoteMergeChecksWaits).not.toHaveBeenCalled();
	});

	it('does not wake it while a check is still running', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'in_progress', null]]));

		expect(await handler.handle(ctx(checks))).toBeNull();
		expect(scheduleCoalescedJob).toHaveBeenCalledOnce();
		expect(promoteMergeChecksWaits).not.toHaveBeenCalled();
	});

	// The #841 bypass reaches a `review` disposition with its checks still failing.
	it('does not wake it on the adjudicated no-fix red', async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['test', 'completed', 'failure']]));

		expect(await handler.handle(ctx(checks, { ciNoFixRecovery: true }))).toMatchObject({
			phase: 'review',
		});
		expect(promoteMergeChecksWaits).not.toHaveBeenCalled();
	});

	it('does not wake it for a pull request SWARM does not manage', async () => {
		hasRunForTask.mockResolvedValue(false);

		expect(await handler.handle(ctx(checks))).toBeNull();
		expect(promoteMergeChecksWaits).not.toHaveBeenCalled();
	});

	it('does not wake it for a conflicting pull request', async () => {
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

		expect(await handler.handle(ctx(checks))).toMatchObject({ phase: 'resolve-conflicts' });
		expect(promoteMergeChecksWaits).not.toHaveBeenCalled();
	});
});

// Issue #1248: a retried Review (or Respond-to-CI) that the handler turned away
// was recorded as "re-evaluated to no-trigger (e.g. disposition changed …)" while
// the handler knew exactly why — a head branch the repository's naming no longer
// recognised took reading the source to find. Each skip now names its cause.
describe('names why a dispatch was skipped (issue #1248)', () => {
	const checks = {
		kind: 'checks',
		action: 'completed',
		workItemId: '42',
		headSha: 'abc123',
		prBranch: 'issue-42',
	} as const;

	async function skipReason(
		overrides: Partial<Parameters<typeof createMockScmEvent>[0]> = {},
		project?: ProjectConfig,
	): Promise<string> {
		const noteDecline = vi.fn();
		expect(
			await handler.handle(
				ctx(
					{ ...checks, ...overrides },
					{ runId: 'run-7', noteDecline, ...(project ? { project } : {}) },
				),
			),
		).toBeNull();
		expect(noteDecline).toHaveBeenCalledOnce();
		const decline = noteDecline.mock.calls[0][0] as TriggerDecline;
		expect(decline.kind).toBe('skipped');
		return decline.reason;
	}

	it('names a head branch that is not one of the repository task branches', async () => {
		getPullRequest.mockResolvedValue({
			number: 42,
			headBranch: 'issue-VT-1538',
			headSha: 'abc123',
			baseBranch: 'main',
			baseSha: 'base-sha-123',
			mergeable: true,
			authorLogin: 'operator-human',
			state: 'open',
		});
		// The incident's shape: a legacy `branchPrefix` emptied under a branch it named.
		const reason = await skipReason({}, createMockProjectConfig({ branchPrefix: '' }));

		expect(reason).toContain('`issue-VT-1538`');
		expect(reason).toContain('pull request #42');
		expect(reason).toContain('not a SWARM task branch');
		expect(reason).toContain('branch naming');
	});

	it('names the task a branch decodes to when SWARM never implemented it', async () => {
		hasRunForTask.mockResolvedValue(false);

		const reason = await skipReason();

		expect(reason).toContain('names task 42');
		expect(reason).toContain('no Implementation run');
	});

	it('says the pull request is closed', async () => {
		getPullRequest.mockResolvedValue({
			number: 42,
			headBranch: 'issue-42',
			headSha: 'abc123',
			baseBranch: 'main',
			baseSha: 'base-sha-123',
			mergeable: null,
			authorLogin: 'operator-human',
			state: 'closed',
		});

		expect(await skipReason()).toContain('Pull request #42 is closed');
	});

	it('says another review of the pull request is still pending', async () => {
		reserveReviewVerdict.mockResolvedValue({ status: 'blocked', ordinal: 1 });

		expect(await skipReason()).toContain('Another review of pull request #42 is still pending');
	});

	it('says the Review phase is disabled', async () => {
		const project = createMockProjectConfig({
			pipeline: { review: { enabled: false }, respondToReview: { enabled: false } },
		});

		expect(await skipReason({}, project)).toContain('`pipeline.review.enabled`');
	});

	it('says the pull request is a draft', async () => {
		expect(await skipReason({ kind: 'pull-request', action: 'opened', isDraft: true })).toContain(
			'Pull request #42 is a draft',
		);
	});

	it("says a Respond-to-CI retry met the pull request's spent fix budget", async () => {
		getAggregateCheckStatus.mockResolvedValue(checkStatus([['ci', 'completed', 'failure']]));
		claimRespondToCiAttempt.mockResolvedValue({ allowed: false, attempt: 5 });

		expect(await skipReason()).toContain('every permitted Respond-to-CI attempt');
	});

	it('notes nothing on a dispatch', async () => {
		const noteDecline = vi.fn();

		expect(await handler.handle(ctx(checks, { runId: 'run-7', noteDecline }))).toMatchObject({
			phase: 'review',
		});
		expect(noteDecline).not.toHaveBeenCalled();
	});

	// The note is the run's reason, not a log line: the skip a fresh delivery takes
	// stays at the level it always had (the "no new noise" half of the issue).
	it('adds no info or warn log to an ordinary skip', async () => {
		getPullRequest.mockResolvedValue({
			number: 42,
			headBranch: 'contributor-patch',
			headSha: 'abc123',
			baseBranch: 'main',
			baseSha: 'base-sha-123',
			mergeable: true,
			authorLogin: 'a-human',
			state: 'open',
		});
		loggerInfo.mockClear();
		loggerWarn.mockClear();

		expect(await handler.handle(ctx(checks, { noteDecline: vi.fn() }))).toBeNull();

		expect(loggerInfo).not.toHaveBeenCalled();
		expect(loggerWarn).not.toHaveBeenCalled();
	});
});
