import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real `isPipelineRun` is kept (issue #971) for the reason the ledger mock
// below keeps `isCapReachingRequestChanges`: it is a pure predicate, and stubbing
// it would let the service and the repository disagree.
vi.mock('@/db/repositories/runsRepository.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/db/repositories/runsRepository.js')>()),
	getRunByIdFromDb: vi.fn(),
}));

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	getProjectByIdFromDb: vi.fn(),
}));

// Only the ledger *writes/reads* the service performs are stubbed; the real
// predicates (`isCapReachingRequestChanges`, and issue #1040's
// `isReviewAllowanceSpent`/`isLastPermittedVerdict`) are kept so the service's cap
// guards are exercised against the same arithmetic the writer uses.
vi.mock('@/db/repositories/reviewVerdictsRepository.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/db/repositories/reviewVerdictsRepository.js')>()),
	getSubmittedReviewSlot: vi.fn(),
	grantReviewCapOverride: vi.fn(),
	listActiveReviewSlotsForPullRequest: vi.fn(),
}));

vi.mock('@/dispatch/dispatcher.js', () => ({
	createAndPublishDispatch: vi.fn(),
	deliveryDedupKey: (deliveryId: string) => `delivery:${deliveryId}`,
}));

const getPullRequest = vi.fn();

vi.mock('@/integrations/scm/registry.js', () => ({
	requireProjectSCMProvider: () => ({ type: 'github', getPullRequest }),
	// Also read by `ProjectConfigSchema`'s per-provider credential check (issue #628);
	// an empty registry skips it, which is what this suite's fixtures expect.
	listSCMProviders: () => [],
}));

import { getProjectByIdFromDb } from '@/db/repositories/projectsRepository.js';
import {
	getSubmittedReviewSlot,
	grantReviewCapOverride,
	listActiveReviewSlotsForPullRequest,
	type PullRequestReviewSlot,
	REVIEW_VERDICT_CAP,
} from '@/db/repositories/reviewVerdictsRepository.js';
import { getRunByIdFromDb } from '@/db/repositories/runsRepository.js';
import type { runs } from '@/db/schema/runs.js';
import { createAndPublishDispatch } from '@/dispatch/dispatcher.js';
import { ForceReReviewError, forceReReview } from '@/dispatch/force-re-review.js';
import type { SwarmJob } from '@/queue/jobs.js';
import {
	createMockProjectConfig,
	createMockProjectRepositoryPair,
} from '../../helpers/factories.js';

type RunRow = typeof runs.$inferSelect;

const PROJECT = createMockProjectConfig({ id: 'p1', repo: 'SmartTechBrewery/swarm' });
const HEAD_SHA = 'cafebabe0000cafebabe0000cafebabe0000cafe';

const JOB_PAYLOAD: SwarmJob = {
	type: 'scm',
	providerId: 'github',
	projectId: 'p1',
	event: {
		kind: 'checks',
		action: 'completed',
		repoFullName: 'SmartTechBrewery/swarm',
		workItemId: '508',
		isCommentEvent: false,
		headSha: HEAD_SHA,
		prBranch: 'issue-508',
	},
};

/** A completed Review run in exactly the capped state the action recovers from. */
function makeCappedReviewRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: 'run-1',
		projectId: 'p1',
		maintenanceTarget: null,
		maintenanceRequestId: null,
		maintenanceMachine: null,
		kind: 'pipeline',
		repository: 'SmartTechBrewery/swarm',
		taskId: '508',
		workItemId: null,
		workItemTitle: null,
		workItemUrl: null,
		prNumber: '508',
		prTitle: 'Some PR',
		producedPrUrl: null,
		phase: 'review',
		workerId: null,
		workerUserId: null,
		workerFencingToken: null,
		engine: 'claude',
		model: 'sonnet',
		reasoning: null,
		status: 'completed',
		reviewVerdict: 'request-changes',
		reviewOrdinal: REVIEW_VERDICT_CAP,
		reviewAutomationOutcome: 'manual-intervention-required',
		reviewAbsorbed: null,
		reviewMergeOutcome: null,
		reviewMergeMessage: null,
		reviewMergeAttempt: null,
		reviewMergeApprovedHeadSha: null,
		exitCode: 0,
		timedOut: false,
		error: null,
		startedAt: new Date('2026-08-01T00:00:00Z'),
		completedAt: new Date('2026-08-01T00:05:00Z'),
		nextRetryAt: null,
		durationMs: 300000,
		timeoutMs: null,
		usage: null,
		delegations: null,
		jobPayload: JOB_PAYLOAD,
		planningScope: null,
		failureDiagnosis: null,
		agentSessionId: null,
		checkpoint: null,
		continuationCount: 0,
		recovery: null,
		cancellation: null,
		outputBytes: 0,
		outputTruncated: false,
		...overrides,
	};
}

const cappedSlot = {
	ordinal: REVIEW_VERDICT_CAP,
	verdict: 'request-changes',
	reviewId: '900123',
	capOverrideGrantedAt: null,
	capOverrideConsumedAt: null,
};

/** The head a later push moved PR #508 to, superseding the one the run reviewed. */
const CURRENT_HEAD_SHA = 'facef00d0000facef00d0000facef00d0000face';

/**
 * A ledger holding `n` submitted slots, so `isReviewAllowanceSpent` answers the
 * real thing rather than a stub. The highest ordinal is the one the approving run
 * holds, which is what `isLastPermittedVerdict` is asked about.
 */
function submittedSlots(count: number): PullRequestReviewSlot[] {
	return Array.from({ length: count }, (_unused, index) => ({
		ordinal: index + 1,
		state: 'submitted' as const,
		headSha: index + 1 === count ? HEAD_SHA : `older-${index}`,
		capOverrideGrantedAt: null,
		capOverrideConsumedAt: null,
		dispatchActive: false,
	}));
}

/** A pull request whose whole review allowance is spent and holds no outstanding grant. */
function spentLedger(): PullRequestReviewSlot[] {
	return submittedSlots(REVIEW_VERDICT_CAP);
}

/** A completed Review run that approved — the cap stop issue #1040 recovers. */
function makeCapSpentApprovalRun(overrides: Partial<RunRow> = {}): RunRow {
	return makeCappedReviewRun({
		reviewVerdict: 'approve',
		reviewAutomationOutcome: null,
		reviewMergeOutcome: 'not-eligible',
		...overrides,
	});
}

/** The approving ledger slot the grant lands on: same head, approving verdict. */
const approvingSlot = {
	ordinal: REVIEW_VERDICT_CAP,
	verdict: 'approve',
	reviewId: '900456',
	capOverrideGrantedAt: null,
	capOverrideConsumedAt: null,
};

type CreateDispatchResult = Awaited<ReturnType<typeof createAndPublishDispatch>>;

function dispatchResult(
	created: boolean,
	state = 'pending',
	outcome: string | null = null,
): CreateDispatchResult {
	return {
		dispatch: { id: 'dispatch-9', state, outcome },
		created,
	} as unknown as CreateDispatchResult;
}

describe('forceReReview (issue #511)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getRunByIdFromDb).mockResolvedValue(makeCappedReviewRun());
		vi.mocked(getProjectByIdFromDb).mockResolvedValue(PROJECT);
		vi.mocked(getSubmittedReviewSlot).mockResolvedValue(cappedSlot);
		vi.mocked(grantReviewCapOverride).mockResolvedValue('granted');
		vi.mocked(createAndPublishDispatch).mockResolvedValue(dispatchResult(true));
		// Issue #1040's branch only: a ledger with allowance left, so an approving run
		// that reaches it is refused `not-capped` unless a test says otherwise.
		vi.mocked(listActiveReviewSlotsForPullRequest).mockResolvedValue(submittedSlots(1));
		getPullRequest.mockResolvedValue({
			number: 508,
			headBranch: 'issue-508',
			headSha: CURRENT_HEAD_SHA,
			baseBranch: 'main',
			baseSha: 'base',
			mergeable: true,
			authorLogin: 'someone',
			state: 'open',
		});
	});

	describe('the forced continuation', () => {
		it('grants one extra review slot and enqueues the corrective Respond-to-review run', async () => {
			const result = await forceReReview('run-1');

			expect(grantReviewCapOverride).toHaveBeenCalledWith({
				projectId: 'p1',
				repository: 'SmartTechBrewery/swarm',
				prNumber: '508',
				headSha: HEAD_SHA,
			});
			expect(result).toMatchObject({
				runId: 'run-1',
				prNumber: '508',
				headSha: HEAD_SHA,
				capOverride: 'granted',
				dispatch: 'scheduled',
				dispatchId: 'dispatch-9',
			});
		});

		it('replays the ledger record as a forced changes-requested review event', async () => {
			await forceReReview('run-1');

			const input = vi.mocked(createAndPublishDispatch).mock.calls[0][0];
			expect(input).toMatchObject({
				projectId: 'p1',
				source: 'manual',
				taskId: '508-respond',
				phase: 'respond-to-review',
			});
			expect(input.jobPayload).toMatchObject({
				type: 'scm',
				providerId: 'github',
				forcedReReview: true,
				event: {
					kind: 'pull-request-review',
					action: 'submitted',
					workItemId: '508',
					reviewState: 'changes-requested',
					reviewId: '900123',
					headSha: HEAD_SHA,
					prBranch: 'issue-508',
				},
			});
		});

		it('grants the extra slot before enqueueing, so a failed enqueue leaves no half-forced cycle', async () => {
			vi.mocked(createAndPublishDispatch).mockRejectedValueOnce(new Error('queue down'));
			await expect(forceReReview('run-1')).rejects.toThrow('queue down');
			expect(grantReviewCapOverride).toHaveBeenCalledTimes(1);
		});
	});

	describe('deduplication', () => {
		it('reports an already-scheduled cycle instead of duplicating it', async () => {
			vi.mocked(grantReviewCapOverride).mockResolvedValue('already-granted');
			vi.mocked(createAndPublishDispatch).mockResolvedValue(dispatchResult(false));

			const result = await forceReReview('run-1');

			expect(result).toMatchObject({
				capOverride: 'already-granted',
				dispatch: 'already-scheduled',
				dispatchId: 'dispatch-9',
			});
		});

		it('always enqueues under the same deterministic dedup key for a PR/head', async () => {
			await forceReReview('run-1');
			await forceReReview('run-1');

			const [first, second] = vi.mocked(createAndPublishDispatch).mock.calls;
			expect(first[0].dedupKey).toBeDefined();
			expect(second[0].dedupKey).toBe(first[0].dedupKey);
		});

		it('reports a genuinely completed forced cycle without presenting it as scheduled', async () => {
			vi.mocked(grantReviewCapOverride).mockResolvedValue('already-granted');
			vi.mocked(createAndPublishDispatch).mockResolvedValue(
				dispatchResult(false, 'completed', 'phase-succeeded'),
			);

			await expect(forceReReview('run-1')).resolves.toMatchObject({
				capOverride: 'already-granted',
				dispatch: 'already-completed',
				dispatchState: 'completed',
				dispatchOutcome: 'phase-succeeded',
			});
		});
	});

	// A dead dispatch is one whose deterministic dedup key is already spent by a
	// completion that never actually started Respond-to-review — the gap a stale
	// worker exposed live (see the module header). These assert the recovery
	// `publishForcedDispatch` performs instead of reporting the dead row as done.
	describe('recovering from a dead prior attempt', () => {
		it.each([
			['no-trigger', dispatchResult(false, 'completed', 'no-trigger')],
			['skipped-not-eligible', dispatchResult(false, 'completed', 'skipped-not-eligible')],
			['skipped-duplicate', dispatchResult(false, 'completed', 'skipped-duplicate')],
			['superseded', dispatchResult(false, 'completed', 'superseded')],
			['failed', dispatchResult(false, 'failed', null)],
			['cancelled', dispatchResult(false, 'cancelled', null)],
		])('chains a fresh dispatch past a dead %s prior attempt', async (_outcome, deadResult) => {
			vi.mocked(grantReviewCapOverride).mockResolvedValue('already-granted');
			const deadDispatch = { ...deadResult.dispatch, id: 'dispatch-dead' };
			vi.mocked(createAndPublishDispatch)
				.mockResolvedValueOnce({ dispatch: deadDispatch, created: false } as CreateDispatchResult)
				.mockResolvedValueOnce(dispatchResult(true, 'pending', null));

			const result = await forceReReview('run-1');

			expect(createAndPublishDispatch).toHaveBeenCalledTimes(2);
			const [first, second] = vi.mocked(createAndPublishDispatch).mock.calls;
			expect(second[0].dedupKey).not.toBe(first[0].dedupKey);
			expect(result).toMatchObject({
				dispatch: 'retried',
				dispatchId: 'dispatch-9',
				previousAttemptOutcome: deadDispatch.outcome,
			});
		});

		it('does not chain past a dispatch that is genuinely still active', async () => {
			vi.mocked(grantReviewCapOverride).mockResolvedValue('already-granted');
			vi.mocked(createAndPublishDispatch).mockResolvedValue(dispatchResult(false, 'running'));

			const result = await forceReReview('run-1');

			expect(createAndPublishDispatch).toHaveBeenCalledTimes(1);
			expect(result).toMatchObject({ dispatch: 'already-scheduled' });
		});

		it('chains again off the newest dead attempt when that one is also dead', async () => {
			vi.mocked(grantReviewCapOverride).mockResolvedValue('already-granted');
			const firstDead = { id: 'dispatch-dead-1', state: 'completed', outcome: 'no-trigger' };
			const secondDead = { id: 'dispatch-dead-2', state: 'completed', outcome: 'no-trigger' };
			vi.mocked(createAndPublishDispatch)
				.mockResolvedValueOnce({ dispatch: firstDead, created: false } as CreateDispatchResult)
				.mockResolvedValueOnce({ dispatch: secondDead, created: false } as CreateDispatchResult)
				.mockResolvedValueOnce(dispatchResult(true, 'pending', null));

			const result = await forceReReview('run-1');

			expect(createAndPublishDispatch).toHaveBeenCalledTimes(3);
			const [first, second, third] = vi.mocked(createAndPublishDispatch).mock.calls;
			expect(new Set([first[0].dedupKey, second[0].dedupKey, third[0].dedupKey]).size).toBe(3);
			expect(result).toMatchObject({ dispatch: 'retried', previousAttemptOutcome: 'no-trigger' });
		});

		it('fails loudly instead of chaining forever when the corrective path stays broken', async () => {
			vi.mocked(grantReviewCapOverride).mockResolvedValue('already-granted');
			vi.mocked(createAndPublishDispatch).mockImplementation(
				async (input) =>
					({
						dispatch: { id: `dead-${input.dedupKey}`, state: 'completed', outcome: 'no-trigger' },
						created: false,
					}) as CreateDispatchResult,
			);

			await expect(forceReReview('run-1')).rejects.toThrow(/exhausted/i);
		});
	});

	describe('refusals', () => {
		it('refuses an unknown run', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(undefined);
			await expect(forceReReview('nope')).rejects.toMatchObject({ reason: 'run-not-found' });
		});

		it.each([
			['a running review', { status: 'running' }],
			['a non-review phase', { phase: 'implementation' }],
			['an approved review', { reviewVerdict: 'approve' }],
			['a review the cap never stopped', { reviewAutomationOutcome: null }],
			// Issue #971 — "not a Review run at all", refused at the same guard rather than
			// left to trip the `missing-coordinates` one further down, since `repository` is
			// consumed by the project read in between.
			[
				'a maintenance run',
				{ kind: 'worker-update', phase: 'worker-update', repository: null, taskId: null },
			],
		])('refuses %s', async (_label, overrides) => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeCappedReviewRun(overrides));
			await expect(forceReReview('run-1')).rejects.toMatchObject({ reason: 'not-capped' });
			expect(grantReviewCapOverride).not.toHaveBeenCalled();
			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it('refuses when the project no longer exists', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);
			await expect(forceReReview('run-1')).rejects.toMatchObject({ reason: 'project-not-found' });
		});

		it('refuses when the stored payload no longer names the PR branch', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeCappedReviewRun({
					jobPayload: {
						...JOB_PAYLOAD,
						event: { ...JOB_PAYLOAD.event, prBranch: undefined },
					} as SwarmJob,
				}),
			);
			await expect(forceReReview('run-1')).rejects.toMatchObject({
				reason: 'missing-coordinates',
			});
			expect(grantReviewCapOverride).not.toHaveBeenCalled();
		});

		it('refuses when the ledger holds no submitted review for the reviewed head', async () => {
			vi.mocked(getSubmittedReviewSlot).mockResolvedValue(undefined);
			await expect(forceReReview('run-1')).rejects.toMatchObject({
				reason: 'missing-review-record',
			});
			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it('refuses when the ledger slot is below the cap, whatever the run row claims', async () => {
			vi.mocked(getSubmittedReviewSlot).mockResolvedValue({ ...cappedSlot, ordinal: 1 });
			await expect(forceReReview('run-1')).rejects.toMatchObject({ reason: 'not-capped' });
			expect(grantReviewCapOverride).not.toHaveBeenCalled();
		});

		it('surfaces a ForceReReviewError with an operator-facing message', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(undefined);
			await expect(forceReReview('run-1')).rejects.toBeInstanceOf(ForceReReviewError);
		});
	});

	// issue #684 phase 2 — a control-plane action that starts from a run uses *that
	// run's* repository, never the project's default entry. Otherwise a forced
	// continuation for the second repository's PR would answer a review, and key a
	// ledger row, in the first repository.
	describe('repository scoping (issue #684 phase 2)', () => {
		beforeEach(() => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeCappedReviewRun({ repository: 'SmartTechBrewery/second' }),
			);
			// Repository-aware, exactly as the real read is: it answers with the project
			// scoped to whichever entry it is asked for.
			vi.mocked(getProjectByIdFromDb).mockImplementation(async (_id, repo) =>
				createMockProjectConfig({ id: 'p1', repo: repo ?? 'SmartTechBrewery/swarm' }),
			);
		});

		it("reads the project scoped to the run's repository", async () => {
			await forceReReview('run-1');
			expect(getProjectByIdFromDb).toHaveBeenCalledWith('p1', 'SmartTechBrewery/second');
		});

		it('keys the cap override and the ledger read on that repository', async () => {
			await forceReReview('run-1');
			expect(getSubmittedReviewSlot).toHaveBeenCalledWith(
				expect.objectContaining({ repository: 'SmartTechBrewery/second' }),
			);
			expect(grantReviewCapOverride).toHaveBeenCalledWith(
				expect.objectContaining({ repository: 'SmartTechBrewery/second' }),
			);
		});

		it('names that repository on the synthetic review event it replays', async () => {
			await forceReReview('run-1');
			const input = vi.mocked(createAndPublishDispatch).mock.calls[0][0];
			expect(input.jobPayload).toMatchObject({
				type: 'scm',
				event: { repoFullName: 'SmartTechBrewery/second' },
			});
		});

		// The loud failure surfaces as an internal error rather than a refusal reason:
		// a project that stopped owning a repository its run acted on is a
		// misconfiguration, not one of the states the operator is asked to resolve.
		it('propagates the unowned-repository throw instead of falling back', async () => {
			vi.mocked(getProjectByIdFromDb).mockRejectedValue(
				new Error("Project 'p1' does not own repository 'SmartTechBrewery/second'"),
			);
			await expect(forceReReview('run-1')).rejects.toThrow(/does not own repository/);
			expect(grantReviewCapOverride).not.toHaveBeenCalled();
			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});
	});

	// issue #685 — the property the scoping above buys, asserted rather than assumed:
	// two capped reviews for the same PR number and head in two repositories of one
	// project must not collide. The forced dispatch's dedup key is deterministic *and
	// permanent*, so a project-wide one would have the second repository's forced
	// continuation absorbed as an already-recorded repeat of the first's — reported to
	// the operator as "already scheduled", with no corrective run ever queued for it.
	describe('two repositories of one project (issue #685)', () => {
		const [ANDROID, BACKEND] = createMockProjectRepositoryPair();

		beforeEach(() => {
			vi.mocked(getProjectByIdFromDb).mockImplementation(async (_id, repo) =>
				repo === BACKEND.repo ? BACKEND : ANDROID,
			);
		});

		/** One forced continuation for the same PR and head, in `repository`. */
		async function forceIn(repository: string): Promise<void> {
			vi.mocked(getRunByIdFromDb).mockResolvedValueOnce(makeCappedReviewRun({ repository }));
			await forceReReview('run-1');
		}

		it('keys the dispatch and the ledger read per repository for one PR and head', async () => {
			await forceIn(ANDROID.repo);
			await forceIn(BACKEND.repo);

			const [android, backend] = vi.mocked(createAndPublishDispatch).mock.calls;
			expect(backend[0].dedupKey).not.toBe(android[0].dedupKey);
			expect(
				vi.mocked(getSubmittedReviewSlot).mock.calls.map(([input]) => input.repository),
			).toEqual([ANDROID.repo, BACKEND.repo]);
		});
	});

	it('refuses before mutating when Respond-to-review is disabled', async () => {
		vi.mocked(getProjectByIdFromDb).mockResolvedValue(
			createMockProjectConfig({ pipeline: { respondToReview: { enabled: false } } }),
		);

		await expect(forceReReview('run-1')).rejects.toMatchObject({
			reason: 'respond-to-review-disabled',
		});
		expect(getSubmittedReviewSlot).not.toHaveBeenCalled();
		expect(grantReviewCapOverride).not.toHaveBeenCalled();
		expect(createAndPublishDispatch).not.toHaveBeenCalled();
	});

	/**
	 * The second shape (issue #1040): a completed Review that **approved**, whose
	 * pull request's allowance is spent and whose reviewed head a later push
	 * superseded. Its continuation is one Review of the *current* head, not a
	 * corrective response — there is no requested change to answer.
	 */
	describe('a review of the superseded head (issue #1040)', () => {
		beforeEach(() => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeCapSpentApprovalRun());
			vi.mocked(getSubmittedReviewSlot).mockResolvedValue(approvingSlot);
			vi.mocked(listActiveReviewSlotsForPullRequest).mockResolvedValue(spentLedger());
		});

		it('grants one extra slot on the approving record and enqueues a review of the new head', async () => {
			const result = await forceReReview('run-1');

			// The grant lands on the *reviewed* head's slot — the approving one — which
			// `reserveReviewVerdict` finds among the PR's active slots whatever head the
			// next review is of.
			expect(grantReviewCapOverride).toHaveBeenCalledWith({
				projectId: 'p1',
				repository: 'SmartTechBrewery/swarm',
				prNumber: '508',
				headSha: HEAD_SHA,
			});
			expect(result).toMatchObject({
				runId: 'run-1',
				prNumber: '508',
				continuation: 'review',
				headSha: HEAD_SHA,
				reviewHeadSha: CURRENT_HEAD_SHA,
				capOverride: 'granted',
				dispatch: 'scheduled',
				dispatchId: 'dispatch-9',
			});
		});

		it('enqueues the unmarked checks/completed event the pr-review trigger reads', async () => {
			await forceReReview('run-1');

			const input = vi.mocked(createAndPublishDispatch).mock.calls[0][0];
			expect(input).toMatchObject({
				projectId: 'p1',
				source: 'manual',
				taskId: '508',
				phase: 'review',
			});
			expect(input.jobPayload).toMatchObject({
				type: 'scm',
				providerId: 'github',
				event: {
					kind: 'checks',
					action: 'completed',
					repoFullName: 'SmartTechBrewery/swarm',
					workItemId: '508',
					headSha: CURRENT_HEAD_SHA,
					prBranch: 'issue-508',
				},
			});
			// `forcedReReview` is the Respond-to-review trigger's cap-gate bypass alone;
			// a forced Review is licensed by the grant its reservation consumes.
			expect(input.jobPayload).not.toHaveProperty('forcedReReview');
		});

		it('keys the dispatch on the current head, under its own prefix', async () => {
			await forceReReview('run-1');
			const forcedReviewKey = vi.mocked(createAndPublishDispatch).mock.calls[0][0].dedupKey;

			// The same run, forced through the #511 branch, must not collide with it.
			vi.mocked(getRunByIdFromDb).mockResolvedValue(makeCappedReviewRun());
			vi.mocked(getSubmittedReviewSlot).mockResolvedValue(cappedSlot);
			await forceReReview('run-1');

			expect(forcedReviewKey).toBeDefined();
			expect(vi.mocked(createAndPublishDispatch).mock.calls[1][0].dedupKey).not.toBe(
				forcedReviewKey,
			);
		});

		it('grants the extra slot before enqueueing, so a failed enqueue leaves no half-forced force', async () => {
			vi.mocked(createAndPublishDispatch).mockRejectedValueOnce(new Error('queue down'));
			await expect(forceReReview('run-1')).rejects.toThrow('queue down');
			expect(grantReviewCapOverride).toHaveBeenCalledTimes(1);
		});

		describe('deduplication', () => {
			// Reachable once the granted Review has *consumed* the grant: the allowance
			// reads spent again, so the guards pass and the second call reports what it
			// found rather than granting or scheduling twice.
			it('reports an already-granted override without granting a second slot', async () => {
				vi.mocked(listActiveReviewSlotsForPullRequest).mockResolvedValue(
					spentLedger().map((slot) => ({
						...slot,
						capOverrideGrantedAt: new Date(),
						capOverrideConsumedAt: new Date(),
					})),
				);
				vi.mocked(grantReviewCapOverride).mockResolvedValue('already-granted');
				vi.mocked(createAndPublishDispatch).mockResolvedValue(dispatchResult(false));

				await expect(forceReReview('run-1')).resolves.toMatchObject({
					continuation: 'review',
					capOverride: 'already-granted',
					dispatch: 'already-scheduled',
				});
				expect(grantReviewCapOverride).toHaveBeenCalledTimes(1);
			});

			it('always enqueues under the same deterministic key for a PR and current head', async () => {
				await forceReReview('run-1');
				await forceReReview('run-1');

				const [first, second] = vi.mocked(createAndPublishDispatch).mock.calls;
				expect(first[0].dedupKey).toBeDefined();
				expect(second[0].dedupKey).toBe(first[0].dedupKey);
			});

			it('chains a fresh dispatch past a dead prior attempt', async () => {
				vi.mocked(createAndPublishDispatch)
					.mockResolvedValueOnce({
						dispatch: { id: 'dispatch-dead', state: 'completed', outcome: 'no-trigger' },
						created: false,
					} as CreateDispatchResult)
					.mockResolvedValueOnce(dispatchResult(true, 'pending', null));

				const result = await forceReReview('run-1');

				expect(createAndPublishDispatch).toHaveBeenCalledTimes(2);
				const [first, second] = vi.mocked(createAndPublishDispatch).mock.calls;
				expect(second[0].dedupKey).not.toBe(first[0].dedupKey);
				expect(result).toMatchObject({
					continuation: 'review',
					dispatch: 'retried',
					previousAttemptOutcome: 'no-trigger',
				});
			});
		});

		// Every refusal is made before the first mutation — the module's stated
		// invariant — so a refused force changes nothing at all.
		describe('refusals', () => {
			it('refuses before any read when Review is disabled for the project', async () => {
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(
					// The config schema refuses Review off while Respond-to-review is on, so a
					// project with Review disabled always has both off — and this branch is
					// still gated on `review`, the phase it actually dispatches.
					createMockProjectConfig({
						pipeline: { review: { enabled: false }, respondToReview: { enabled: false } },
					}),
				);

				await expect(forceReReview('run-1')).rejects.toMatchObject({
					reason: 'review-disabled',
				});
				expect(getSubmittedReviewSlot).not.toHaveBeenCalled();
			});

			// The switch gating the *other* continuation has no say over this one.
			it('is unaffected by a disabled Respond-to-review', async () => {
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(
					createMockProjectConfig({
						id: 'p1',
						repo: 'SmartTechBrewery/swarm',
						pipeline: { respondToReview: { enabled: false } },
					}),
				);

				await expect(forceReReview('run-1')).resolves.toMatchObject({ dispatch: 'scheduled' });
			});

			it('refuses when the ledger holds no submitted review for the reviewed head', async () => {
				vi.mocked(getSubmittedReviewSlot).mockResolvedValue(undefined);

				await expect(forceReReview('run-1')).rejects.toMatchObject({
					reason: 'missing-review-record',
				});
			});

			it('refuses when the pull request still has review allowance left', async () => {
				vi.mocked(listActiveReviewSlotsForPullRequest).mockResolvedValue(
					submittedSlots(REVIEW_VERDICT_CAP - 1),
				);

				await expect(forceReReview('run-1')).rejects.toMatchObject({ reason: 'not-capped' });
				// The ledger guard is the cheap one and runs first: no provider call either.
				expect(getPullRequest).not.toHaveBeenCalled();
			});

			it("refuses when this run's verdict is not the pull request's latest", async () => {
				vi.mocked(getSubmittedReviewSlot).mockResolvedValue({ ...approvingSlot, ordinal: 2 });

				await expect(forceReReview('run-1')).rejects.toMatchObject({ reason: 'not-capped' });
			});

			// The grant is still outstanding, so the allowance is not spent — this is the
			// stale second click, told to refresh rather than shown a second force.
			it('refuses while a granted, unconsumed override is still outstanding', async () => {
				vi.mocked(listActiveReviewSlotsForPullRequest).mockResolvedValue(
					spentLedger().map((slot) => ({ ...slot, capOverrideGrantedAt: new Date() })),
				);

				await expect(forceReReview('run-1')).rejects.toMatchObject({ reason: 'not-capped' });
			});

			it('refuses when the pull request is closed', async () => {
				getPullRequest.mockResolvedValue({
					number: 508,
					headBranch: 'issue-508',
					headSha: CURRENT_HEAD_SHA,
					baseBranch: 'main',
					baseSha: 'base',
					mergeable: null,
					authorLogin: 'someone',
					state: 'closed',
				});

				await expect(forceReReview('run-1')).rejects.toMatchObject({
					reason: 'pull-request-closed',
				});
			});

			it("refuses when the head never moved, naming the run's own merge result", async () => {
				getPullRequest.mockResolvedValue({
					number: 508,
					headBranch: 'issue-508',
					headSha: HEAD_SHA,
					baseBranch: 'main',
					baseSha: 'base',
					mergeable: true,
					authorLogin: 'someone',
					state: 'open',
				});

				await expect(forceReReview('run-1')).rejects.toMatchObject({
					reason: 'head-unchanged',
					message: expect.stringContaining('merge result'),
				});
			});

			it('mutates nothing on any refusal', async () => {
				const refusals: Array<() => void> = [
					() =>
						vi.mocked(getProjectByIdFromDb).mockResolvedValue(
							createMockProjectConfig({
								pipeline: { review: { enabled: false }, respondToReview: { enabled: false } },
							}),
						),
					() => vi.mocked(getSubmittedReviewSlot).mockResolvedValue(undefined),
					() =>
						vi
							.mocked(listActiveReviewSlotsForPullRequest)
							.mockResolvedValue(submittedSlots(REVIEW_VERDICT_CAP - 1)),
					() =>
						getPullRequest.mockResolvedValue({
							number: 508,
							headBranch: 'issue-508',
							headSha: HEAD_SHA,
							baseBranch: 'main',
							baseSha: 'base',
							mergeable: true,
							authorLogin: 'someone',
							state: 'open',
						}),
				];
				for (const arrange of refusals) {
					arrange();
					await expect(forceReReview('run-1')).rejects.toBeInstanceOf(ForceReReviewError);
				}
				expect(grantReviewCapOverride).not.toHaveBeenCalled();
				expect(createAndPublishDispatch).not.toHaveBeenCalled();
			});
		});

		// Issue #684 phase 2, for the new branch: the provider read is made against the
		// project scoped to the *run's* repository, like every other value here.
		it("reads the pull request through the run's own repository", async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(
				makeCapSpentApprovalRun({ repository: 'SmartTechBrewery/second' }),
			);
			vi.mocked(getProjectByIdFromDb).mockImplementation(async (_id, repo) =>
				createMockProjectConfig({ id: 'p1', repo: repo ?? 'SmartTechBrewery/swarm' }),
			);

			await forceReReview('run-1');

			expect(getPullRequest).toHaveBeenCalledWith(
				expect.objectContaining({ repo: 'SmartTechBrewery/second' }),
				508,
			);
			expect(vi.mocked(createAndPublishDispatch).mock.calls[0][0].jobPayload).toMatchObject({
				type: 'scm',
				event: { repoFullName: 'SmartTechBrewery/second' },
			});
		});
	});
});
