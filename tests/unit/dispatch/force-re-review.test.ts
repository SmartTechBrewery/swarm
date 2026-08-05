import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/runsRepository.js', () => ({
	getRunByIdFromDb: vi.fn(),
}));

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	getProjectByIdFromDb: vi.fn(),
}));

// Only the two ledger *writes/reads* the service performs are stubbed; the real
// `isCapReachingRequestChanges` is kept so the service's cap guard is exercised
// against the same predicate the Review phase and the trigger use.
vi.mock('@/db/repositories/reviewVerdictsRepository.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/db/repositories/reviewVerdictsRepository.js')>()),
	getSubmittedReviewSlot: vi.fn(),
	grantReviewCapOverride: vi.fn(),
}));

vi.mock('@/dispatch/dispatcher.js', () => ({
	createAndPublishDispatch: vi.fn(),
	deliveryDedupKey: (deliveryId: string) => `delivery:${deliveryId}`,
}));

vi.mock('@/integrations/scm/registry.js', () => ({
	requireProjectSCMProvider: () => ({ type: 'github' }),
}));

import { getProjectByIdFromDb } from '@/db/repositories/projectsRepository.js';
import {
	getSubmittedReviewSlot,
	grantReviewCapOverride,
	REVIEW_VERDICT_CAP,
} from '@/db/repositories/reviewVerdictsRepository.js';
import { getRunByIdFromDb } from '@/db/repositories/runsRepository.js';
import type { runs } from '@/db/schema/runs.js';
import { createAndPublishDispatch } from '@/dispatch/dispatcher.js';
import { ForceReReviewError, forceReReview } from '@/dispatch/force-re-review.js';
import type { SwarmJob } from '@/queue/jobs.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

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
});
