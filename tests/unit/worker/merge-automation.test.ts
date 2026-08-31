import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../helpers/factories.js';

const completeDispatch = vi.fn(async (_id: string, _outcome: string) => true);
const failDispatch = vi.fn(async (_id: string, _error: string) => true);
const scheduleDispatchRetry = vi.fn(
	async (_id: string, _input: unknown): Promise<DispatchRow | null> => mockDispatchRow(),
);
vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	completeDispatch: (id: string, outcome: string) => completeDispatch(id, outcome),
	failDispatch: (id: string, error: string) => failDispatch(id, error),
	scheduleDispatchRetry: (id: string, input: unknown) => scheduleDispatchRetry(id, input),
}));

const updateReviewMergeOutcome = vi.fn(async (_runId: string, _input: unknown) => true);
vi.mock('@/db/repositories/runsRepository.js', () => ({
	updateReviewMergeOutcome: (runId: string, input: unknown) =>
		updateReviewMergeOutcome(runId, input),
}));

const createAndPublishDispatch = vi.fn(async (_input: unknown) => ({
	dispatch: mockDispatchRow(),
	created: true,
}));
const publishDispatchWakeUp = vi.fn(async (_dispatch: unknown) => {});
vi.mock('@/dispatch/dispatcher.js', () => ({
	createAndPublishDispatch: (input: unknown) => createAndPublishDispatch(input),
	publishDispatchWakeUp: (dispatch: unknown) => publishDispatchWakeUp(dispatch),
}));

// The review-dispatch dedup is Redis-backed; the updated head's claim (issue
// #874) is asserted through these rather than against a real connection.
const claimReviewDispatch = vi.fn(async (_key: string, _trigger: string, _ctx: unknown) => true);
const refreshReviewDispatchClaim = vi.fn(async (_key: string, _ttl: number) => {});
vi.mock('@/triggers/review-dispatch-dedup.js', () => ({
	buildReviewDispatchKey: (repo: string, prNumber: string, headSha: string) =>
		`${repo}:${prNumber}:${headSha}`,
	claimReviewDispatch: (key: string, trigger: string, ctx: unknown) =>
		claimReviewDispatch(key, trigger, ctx),
	refreshReviewDispatchClaim: (key: string, ttl: number) => refreshReviewDispatchClaim(key, ttl),
}));

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import type { MergeAutomationJob } from '@/queue/jobs.js';
import type { MergePullRequestOutcome, UpdatePullRequestBranchOutcome } from '@/scm/merge.js';
import type { AggregateCheckStatus } from '@/scm/types.js';
import {
	MAX_BASE_UPDATES,
	MAX_MERGE_RETRIES,
	MERGE_RETRY_EXHAUSTED,
	mergeDispatchDedupKey,
	mergeRetryDelayMs,
	processMergeAutomationDispatch,
	requestMergeAutomation,
} from '@/worker/merge-automation.js';

function mockDispatchRow(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		wakeSeq: 0,
		attempt: 0,
		state: 'leased',
		availableAt: new Date(),
		createdAt: new Date(),
		...overrides,
	} as DispatchRow;
}

const project = createMockProjectConfig();

const job: MergeAutomationJob = {
	type: 'merge-automation',
	projectId: project.id,
	reviewRunId: 'run-1',
	repo: project.repo,
	prNumber: '17',
	approvedHeadSha: 'deadbeef',
};

function mergeReturning(outcome: MergePullRequestOutcome) {
	return vi.fn(async (_p: unknown, _n: number, _sha: string) => outcome);
}

/**
 * The registered provider standing in for GitHub. Every case below injects
 * `mergePullRequest` explicitly except the one that exercises the default, which
 * resolves the project's provider through `scmProviderRegistry` (issue #386) —
 * so the registry gets one fake manifest rather than the real integration's
 * module graph.
 */
const registeredMergePullRequest = vi.fn(async (_p: unknown, _n: number, _sha: string) => ({
	status: 'merged' as const,
	message: 'merged',
	sha: 'abc',
}));

beforeEach(() => {
	_resetSCMProviderRegistryForTesting();
	registeredMergePullRequest.mockClear();
	registerSCMProvider({
		id: 'github',
		label: 'GitHub',
		category: 'scm',
		webhookRoute: '/github/webhook',
		provider: { mergePullRequest: registeredMergePullRequest },
	} as unknown as SCMProviderManifest);
	completeDispatch.mockClear();
	failDispatch.mockClear();
	scheduleDispatchRetry.mockClear();
	scheduleDispatchRetry.mockImplementation(async () => mockDispatchRow());
	updateReviewMergeOutcome.mockClear();
	updateReviewMergeOutcome.mockResolvedValue(true);
	createAndPublishDispatch.mockClear();
	createAndPublishDispatch.mockResolvedValue({ dispatch: mockDispatchRow(), created: true });
	publishDispatchWakeUp.mockClear();
	claimReviewDispatch.mockClear();
	claimReviewDispatch.mockResolvedValue(true);
	refreshReviewDispatchClaim.mockClear();
});

/** The stale-base answer the merge capability gives for a head behind its base. */
const STALE_BASE: MergePullRequestOutcome = {
	status: 'stale-base',
	message: 'pull request head deadbeef is behind its base branch',
};

function updateReturning(outcome: UpdatePullRequestBranchOutcome) {
	return vi.fn(async (_p: unknown, _n: number, _sha: string) => outcome);
}

/** An aggregate check read whose runs all completed with `conclusion`. */
function checksConcluding(...conclusions: string[]) {
	const checks: AggregateCheckStatus = {
		totalCount: conclusions.length,
		checkRuns: conclusions.map((conclusion, index) => ({
			name: `check-${index}`,
			status: 'completed',
			conclusion,
		})),
	};
	return vi.fn(async () => checks);
}

/** The retry input `scheduleDispatchRetry` was last called with. */
function lastRetryInput() {
	const calls = scheduleDispatchRetry.mock.calls;
	return calls[calls.length - 1]?.[1] as {
		jobPayload: MergeAutomationJob;
		availableAt: Date;
		waitReason: string;
		attempt: number;
	};
}

describe('mergeRetryDelayMs', () => {
	it('doubles from 15s and caps at 5 minutes', () => {
		expect(mergeRetryDelayMs(1)).toBe(15_000);
		expect(mergeRetryDelayMs(2)).toBe(30_000);
		expect(mergeRetryDelayMs(3)).toBe(60_000);
		expect(mergeRetryDelayMs(6)).toBe(5 * 60_000);
		expect(mergeRetryDelayMs(60)).toBe(5 * 60_000);
	});
});

describe('mergeDispatchDedupKey', () => {
	it('keys the merge intent on the originating Review run', () => {
		expect(mergeDispatchDedupKey('run-1')).toBe('merge:run-1');
	});
});

describe('requestMergeAutomation', () => {
	it('persists a dedup-keyed merge dispatch linked to the Review run and publishes it', async () => {
		await requestMergeAutomation({
			project,
			reviewRunId: 'run-1',
			taskId: '17',
			prNumber: '17',
			approvedHeadSha: 'deadbeef',
		});

		expect(createAndPublishDispatch).toHaveBeenCalledExactlyOnceWith({
			projectId: project.id,
			jobPayload: job,
			dedupKey: 'merge:run-1',
			source: 'synthetic',
			runId: 'run-1',
			taskId: '17',
			phase: 'merge-automation',
		});
	});

	it('is best-effort: a creation failure is swallowed, never thrown', async () => {
		createAndPublishDispatch.mockRejectedValue(new Error('db down'));

		await expect(
			requestMergeAutomation({
				project,
				reviewRunId: 'run-1',
				taskId: '17',
				prNumber: '17',
				approvedHeadSha: 'deadbeef',
			}),
		).resolves.toBeUndefined();
	});
});

describe('processMergeAutomationDispatch', () => {
	it('completes the dispatch and persists the outcome when the provider merges', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' });

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest,
		});

		expect(mergePullRequest).toHaveBeenCalledExactlyOnceWith(project, 17, 'deadbeef');
		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith('run-1', {
			status: 'merged',
			message: 'merged',
			attempt: 0,
			approvedHeadSha: 'deadbeef',
		});
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'merged',
			prNumber: '17',
		});
	});

	it('schedules a bounded, doubling retry while the PR is transiently not-ready', async () => {
		const before = Date.now();
		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: 2 }),
			job,
			project,
			{ mergePullRequest: mergeReturning({ status: 'not-ready', message: 'checks pending' }) },
		);

		expect(scheduleDispatchRetry).toHaveBeenCalledTimes(1);
		const [id, input] = scheduleDispatchRetry.mock.calls[0] as [
			string,
			{ jobPayload: unknown; availableAt: Date; waitReason: string; attempt: number },
		];
		expect(id).toBe('dispatch-1');
		expect(input.jobPayload).toEqual(job);
		expect(input.waitReason).toBe('recheck');
		expect(input.attempt).toBe(3);
		const delay = input.availableAt.getTime() - before;
		expect(delay).toBeGreaterThanOrEqual(mergeRetryDelayMs(3) - 1000);
		expect(delay).toBeLessThanOrEqual(mergeRetryDelayMs(3) + 1000);
		expect(publishDispatchWakeUp).toHaveBeenCalledTimes(1);
		expect(completeDispatch).not.toHaveBeenCalled();
		expect(failDispatch).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'retry-scheduled',
			prNumber: '17',
		});
	});

	it('skips the wake-up publish when the retry transition lost to a concurrent cancel', async () => {
		scheduleDispatchRetry.mockResolvedValue(null);

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'not-ready', message: 'checks pending' }),
		});

		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
	});

	it('records retry exhaustion and completes the dispatch once the budget is spent', async () => {
		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: MAX_MERGE_RETRIES }),
			job,
			project,
			{ mergePullRequest: mergeReturning({ status: 'not-ready', message: 'checks pending' }) },
		);

		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		expect(updateReviewMergeOutcome).toHaveBeenLastCalledWith('run-1', {
			status: MERGE_RETRY_EXHAUSTED,
			message: expect.stringContaining('left open for a manual merge'),
			attempt: MAX_MERGE_RETRIES,
			approvedHeadSha: 'deadbeef',
		});
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-retry-exhausted');
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: MERGE_RETRY_EXHAUSTED,
			prNumber: '17',
		});
	});

	it.each([
		['not-eligible', 'merge-not-eligible'],
		['policy-blocked', 'merge-policy-blocked'],
		['unsupported', 'merge-unsupported'],
	] as const)('completes the dispatch with a visible outcome for %s', async (status, expected) => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status, message: 'refused' } as MergePullRequestOutcome),
		});

		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', expected);
		expect(failDispatch).not.toHaveBeenCalled();
		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: status,
			prNumber: '17',
		});
	});

	it('fails the dispatch on an unexpected provider failure', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'provider-error', message: '502 Bad Gateway' }),
		});

		expect(failDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', '502 Bad Gateway');
		expect(completeDispatch).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'provider-error',
			prNumber: '17',
		});
	});

	it('normalizes a thrown provider rejection to provider-error', async () => {
		const mergePullRequest = vi.fn(async () => {
			throw new Error('provider unavailable');
		});

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest,
		});

		expect(failDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'provider unavailable');
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'provider-error',
			prNumber: '17',
		});
	});

	// The only path the argument-injecting cases above leave uncovered: the default
	// merge capability, which now comes from the project's registered provider
	// instead of a concrete GitHub construction (issue #386).
	it('defaults to the registered provider’s merge capability when none is injected', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project);

		expect(registeredMergePullRequest).toHaveBeenCalledExactlyOnceWith(project, 17, 'deadbeef');
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'merged',
			prNumber: '17',
		});
	});

	// An unresolvable provider is a provider failure like any other: it must settle
	// the claimed dispatch rather than escape `processJob`, which would leave the
	// dispatch in flight until the reconciler's lease expiry with nothing recorded
	// on the Review run. Hence the default is resolved inside the attempt's `try`,
	// not in a default parameter (which binds before the body can catch anything).
	it('settles the dispatch as provider-error when no provider is registered', async () => {
		_resetSCMProviderRegistryForTesting();

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project);

		expect(failDispatch).toHaveBeenCalledOnce();
		expect(failDispatch.mock.calls[0]?.[1]).toMatch(/Cannot resolve the SCM provider/);
		expect(updateReviewMergeOutcome).toHaveBeenCalledOnce();
		expect(updateReviewMergeOutcome.mock.calls[0]?.[1]).toMatchObject({
			status: 'provider-error',
		});
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'provider-error',
			prNumber: '17',
		});
	});

	it('still settles the dispatch when persisting the outcome onto the run fails', async () => {
		updateReviewMergeOutcome.mockRejectedValue(new Error('db down'));

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'merged', message: 'merged' }),
		});

		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
	});

	// A merge that is *not* behind its base must behave exactly as it did before
	// issue #874: no branch update, no extra check read, one merge call.
	it('leaves an up-to-date head on the pre-existing path', async () => {
		const updatePullRequestBranch = updateReturning({ status: 'up-to-date' });
		const getAggregateCheckStatus = checksConcluding('success');

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'merged', message: 'merged' }),
			updatePullRequestBranch,
			getAggregateCheckStatus,
		});

		expect(updatePullRequestBranch).not.toHaveBeenCalled();
		expect(getAggregateCheckStatus).not.toHaveBeenCalled();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
	});
});

// Issue #874 — the head is behind the base it would land on, so the merge is
// refused and the dispatch re-verifies instead.
describe('processMergeAutomationDispatch: a stale approved head', () => {
	it('asks the provider to update the branch, pinned to the approved head', async () => {
		const updatePullRequestBranch = updateReturning({
			status: 'updated',
			headSha: 'merged-with-base',
		});

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch,
		});

		expect(updatePullRequestBranch).toHaveBeenCalledExactlyOnceWith(project, 17, 'deadbeef');
	});

	it('advances the payload onto the new head, records both SHAs and resets the budget', async () => {
		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: 4 }),
			job,
			project,
			{
				mergePullRequest: mergeReturning(STALE_BASE),
				updatePullRequestBranch: updateReturning({
					status: 'updated',
					headSha: 'merged-with-base',
				}),
			},
		);

		const input = lastRetryInput();
		expect(input.jobPayload).toEqual({
			...job,
			approvedHeadSha: 'merged-with-base',
			baseUpdates: 1,
		});
		expect(input.waitReason).toBe('recheck');
		// Reset, not incremented: the fresh CI is a new wait and gets the full budget.
		expect(input.attempt).toBe(0);
		expect(publishDispatchWakeUp).toHaveBeenCalledTimes(1);
		// The advance names the head it replaces, which is what lets the run row's
		// own generation guard accept a write that changes the approved head.
		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith('run-1', {
			status: 'stale-base',
			message: expect.stringContaining('deadbeef → merged-with-base'),
			attempt: 4,
			approvedHeadSha: 'merged-with-base',
			advancedFrom: 'deadbeef',
		});
		expect(completeDispatch).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'retry-scheduled',
			prNumber: '17',
		});
	});

	// Without the claim the updated head's own `checks completed` event dispatches
	// a Review, spending one of `REVIEW_VERDICT_CAP`'s three slots per update on a
	// diff that has not changed.
	it('claims the updated head’s review-dispatch slot before scheduling the retry', async () => {
		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({
				status: 'updated',
				headSha: 'merged-with-base',
			}),
		});

		expect(claimReviewDispatch).toHaveBeenCalledExactlyOnceWith(
			`${project.repo}:17:merged-with-base`,
			'merge-automation',
			{ prNumber: '17', headSha: 'merged-with-base' },
		);
		// Held past the dedup module's five-minute default, which CI routinely outlasts.
		expect(refreshReviewDispatchClaim).toHaveBeenCalledExactlyOnceWith(
			`${project.repo}:17:merged-with-base`,
			15 * 60,
		);
		expect(claimReviewDispatch.mock.invocationCallOrder[0]).toBeLessThan(
			scheduleDispatchRetry.mock.invocationCallOrder[0],
		);
	});

	it('merges the updated head once its own checks are green', async () => {
		const advanced: MergeAutomationJob = {
			...job,
			approvedHeadSha: 'merged-with-base',
			baseUpdates: 1,
		};
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });

		await processMergeAutomationDispatch(mockDispatchRow(), advanced, project, {
			mergePullRequest,
			getAggregateCheckStatus: checksConcluding('success', 'success'),
		});

		expect(mergePullRequest).toHaveBeenCalledExactlyOnceWith(project, 17, 'merged-with-base');
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
	});

	it('waits, without merging, while the updated head’s checks are still running', async () => {
		const advanced: MergeAutomationJob = {
			...job,
			approvedHeadSha: 'merged-with-base',
			baseUpdates: 1,
		};
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });
		const getAggregateCheckStatus = vi.fn(async () => ({
			totalCount: 2,
			checkRuns: [
				{ name: 'build', status: 'completed', conclusion: 'success' },
				{ name: 'test', status: 'in_progress', conclusion: null },
			],
		}));

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), advanced, project, {
			mergePullRequest,
			getAggregateCheckStatus,
		});

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(lastRetryInput().attempt).toBe(1);
		expect(outcome.result).toBe('retry-scheduled');
	});

	// The whole point of the exercise: each side is green on its own and the
	// combination is not, so the merge is refused out loud rather than landed.
	it('refuses and comments when the updated head’s own checks fail', async () => {
		const advanced: MergeAutomationJob = {
			...job,
			approvedHeadSha: 'merged-with-base',
			baseUpdates: 1,
		};
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });
		const commentOnPullRequest = vi.fn(async (_p: unknown, _n: number, _body: string) => 1);

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), advanced, project, {
			mergePullRequest,
			getAggregateCheckStatus: checksConcluding('failure'),
			commentOnPullRequest,
		});

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(commentOnPullRequest).toHaveBeenCalledOnce();
		expect(commentOnPullRequest.mock.calls[0]?.[2]).toContain('check-0');
		expect(outcome.result).toBe('not-eligible');
	});

	it('gives up visibly once the base-update allowance is spent', async () => {
		const exhausted: MergeAutomationJob = { ...job, baseUpdates: MAX_BASE_UPDATES };
		const updatePullRequestBranch = updateReturning({ status: 'updated', headSha: 'never' });
		const commentOnPullRequest = vi.fn(async (_p: unknown, _n: number, _body: string) => 1);

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), exhausted, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch,
			getAggregateCheckStatus: checksConcluding('success'),
			commentOnPullRequest,
		});

		expect(updatePullRequestBranch).not.toHaveBeenCalled();
		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		expect(updateReviewMergeOutcome).toHaveBeenLastCalledWith('run-1', {
			status: 'stale-base',
			message: expect.stringContaining('needs a human'),
			attempt: 0,
			approvedHeadSha: 'deadbeef',
			advancedFrom: undefined,
		});
		expect(commentOnPullRequest).toHaveBeenCalledOnce();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-retry-exhausted');
		expect(outcome.result).toBe('stale-base');
	});

	it('rides out an already-up-to-date race on the ordinary backoff', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({ status: 'up-to-date' }),
		});

		expect(lastRetryInput().attempt).toBe(1);
		// No head advanced, so the payload — and the base-update budget — is untouched.
		expect(lastRetryInput().jobPayload).toEqual(job);
		expect(claimReviewDispatch).not.toHaveBeenCalled();
		expect(outcome.result).toBe('retry-scheduled');
	});

	it('settles a conflicting update terminally, with a comment', async () => {
		const commentOnPullRequest = vi.fn(async (_p: unknown, _n: number, _body: string) => 1);

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({
				status: 'conflict',
				message: 'merge conflict between base and head',
			}),
			commentOnPullRequest,
		});

		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith('run-1', {
			status: 'not-eligible',
			message: 'merge conflict between base and head',
			attempt: 0,
			approvedHeadSha: 'deadbeef',
			advancedFrom: undefined,
		});
		expect(commentOnPullRequest).toHaveBeenCalledOnce();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(outcome.result).toBe('not-eligible');
	});

	it('settles a provider that cannot update a branch terminally, with a comment', async () => {
		const commentOnPullRequest = vi.fn(async (_p: unknown, _n: number, _body: string) => 1);

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({
				status: 'unsupported',
				message: 'Bitbucket Cloud exposes no API for merging the destination branch',
			}),
			commentOnPullRequest,
		});

		expect(commentOnPullRequest).toHaveBeenCalledOnce();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-unsupported');
		expect(outcome.result).toBe('unsupported');
	});

	it('fails the dispatch when the update itself fails unexpectedly', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({
				status: 'provider-error',
				message: '502 Bad Gateway',
			}),
		});

		expect(failDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', '502 Bad Gateway');
		expect(completeDispatch).not.toHaveBeenCalled();
		expect(outcome.result).toBe('provider-error');
	});

	it('normalizes a thrown update rejection to provider-error', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: vi.fn(async () => {
				throw new Error('provider unavailable');
			}),
		});

		expect(failDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'provider unavailable');
		expect(outcome.result).toBe('provider-error');
	});

	// A comment is an extra on top of the durable outcome, never the notice itself.
	it('settles even when the refusal comment cannot be posted', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({ status: 'unsupported', message: 'no' }),
			commentOnPullRequest: vi.fn(async (_p: unknown, _n: number, _body: string) => {
				throw new Error('provider unreachable');
			}),
		});

		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-unsupported');
		expect(outcome.result).toBe('unsupported');
	});
});
