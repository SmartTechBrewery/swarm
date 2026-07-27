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

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import type { MergeAutomationJob } from '@/queue/jobs.js';
import type { MergePullRequestOutcome } from '@/scm/merge.js';
import {
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
});

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

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow(),
			job,
			project,
			mergePullRequest,
		);

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
			mergeReturning({ status: 'not-ready', message: 'checks pending' }),
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

		await processMergeAutomationDispatch(
			mockDispatchRow(),
			job,
			project,
			mergeReturning({ status: 'not-ready', message: 'checks pending' }),
		);

		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
	});

	it('records retry exhaustion and completes the dispatch once the budget is spent', async () => {
		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: MAX_MERGE_RETRIES }),
			job,
			project,
			mergeReturning({ status: 'not-ready', message: 'checks pending' }),
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
		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow(),
			job,
			project,
			mergeReturning({ status, message: 'refused' } as MergePullRequestOutcome),
		);

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
		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow(),
			job,
			project,
			mergeReturning({ status: 'provider-error', message: '502 Bad Gateway' }),
		);

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

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow(),
			job,
			project,
			mergePullRequest,
		);

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

	it('surfaces the unresolvable-provider throw when no provider is registered', async () => {
		_resetSCMProviderRegistryForTesting();

		await expect(processMergeAutomationDispatch(mockDispatchRow(), job, project)).rejects.toThrow(
			/Cannot resolve the SCM provider/,
		);
	});

	it('still settles the dispatch when persisting the outcome onto the run fails', async () => {
		updateReviewMergeOutcome.mockRejectedValue(new Error('db down'));

		await processMergeAutomationDispatch(
			mockDispatchRow(),
			job,
			project,
			mergeReturning({ status: 'merged', message: 'merged' }),
		);

		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
	});
});
