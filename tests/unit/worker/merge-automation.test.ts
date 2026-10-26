import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../helpers/factories.js';

const completeDispatch = vi.fn(async (_id: string, _outcome: string) => true);
const failDispatch = vi.fn(async (_id: string, _error: string) => true);
const scheduleDispatchRetry = vi.fn(
	async (_id: string, _input: unknown): Promise<DispatchRow | null> => mockDispatchRow(),
);
// The merge queue (issue #1114): empty by default, which reads as "this dispatch is
// the head" — every case outside the queue's own describe merges exactly as before.
const listActiveMergeDispatchesForRepository = vi.fn(
	async (_projectId: string, _repo: string): Promise<DispatchRow[]> => [],
);
// The worker-side branch update's hand-back (issue #1117): the read of the merge
// dispatch it adopts into, and the compare-and-set write itself.
const findDispatchByDedupKey = vi.fn(
	async (_key: string): Promise<DispatchRow | undefined> => undefined,
);
// The run's active dispatch: the re-arm's "still due" guard and the hand-back's
// first lookup (issue #1128). None by default.
const getActiveDispatchByRunId = vi.fn(
	async (_runId: string): Promise<DispatchRow | undefined> => undefined,
);
const adoptWorkerBranchUpdateIntoWaitingMerge = vi.fn(
	async (_id: string, _wakeSeq: number, _payload: unknown): Promise<DispatchRow | null> =>
		mockDispatchRow({ state: 'retry-scheduled' }),
);
vi.mock('@/db/repositories/dispatchesRepository.js', async (importOriginal) => ({
	// The real lifecycle constants, which `classifyDispatchClaim` reads.
	EXECUTING_DISPATCH_STATES: (
		await importOriginal<typeof import('@/db/repositories/dispatchesRepository.js')>()
	).EXECUTING_DISPATCH_STATES,
	WAITING_DISPATCH_STATES: (
		await importOriginal<typeof import('@/db/repositories/dispatchesRepository.js')>()
	).WAITING_DISPATCH_STATES,
	findDispatchByDedupKey: (key: string) => findDispatchByDedupKey(key),
	getActiveDispatchByRunId: (runId: string) => getActiveDispatchByRunId(runId),
	adoptWorkerBranchUpdateIntoWaitingMerge: (id: string, wakeSeq: number, payload: unknown) =>
		adoptWorkerBranchUpdateIntoWaitingMerge(id, wakeSeq, payload),
	completeDispatch: (id: string, outcome: string) => completeDispatch(id, outcome),
	failDispatch: (id: string, error: string) => failDispatch(id, error),
	scheduleDispatchRetry: (id: string, input: unknown) => scheduleDispatchRetry(id, input),
	listActiveMergeDispatchesForRepository: (projectId: string, repo: string) =>
		listActiveMergeDispatchesForRepository(projectId, repo),
}));

const updateReviewMergeOutcome = vi.fn(async (_runId: string, _input: unknown) => true);
// The run-row copy of the superseded stamp (issue #1080), written beside the ledger's.
const markReviewRunSuperseded = vi.fn(async (_runId: string) => true);
// The approving run a green head re-arms (issue #1128). None by default.
const findApprovedReviewRunForRearm = vi.fn(
	async (
		_key: unknown,
		_outcomes: readonly string[],
	): Promise<{ id: string; taskId: string } | undefined> => undefined,
);
vi.mock('@/db/repositories/runsRepository.js', () => ({
	findApprovedReviewRunForRearm: (key: unknown, outcomes: readonly string[]) =>
		findApprovedReviewRunForRearm(key, outcomes),
	updateReviewMergeOutcome: (runId: string, input: unknown) =>
		updateReviewMergeOutcome(runId, input),
	markReviewRunSuperseded: (runId: string) => markReviewRunSuperseded(runId),
}));

// The review-verdict ledger's superseded stamp (issue #1079). Mocked for the same
// reason the merge capability is injected: this suite asserts *which* refusals
// write it and with which key, while whether the write lands is the ledger's own
// integration suite.
const markReviewVerdictSuperseded = vi.fn(async (_key: unknown) => true);
vi.mock('@/db/repositories/reviewVerdictsRepository.js', () => ({
	markReviewVerdictSuperseded: (key: unknown) => markReviewVerdictSuperseded(key),
}));

// The board work a merged pull request triggers (issue #959). Mocked here so this
// suite keeps knowing only the DB and the merge capability, exactly as the module
// under test does — the settle's own guards are asserted in its own suite.
const settleAbsorbedChildren = vi.fn(async (_input: unknown): Promise<string[]> => []);
vi.mock('@/dispatch/absorbed-child-settle.js', () => ({
	settleAbsorbedChildren: (input: unknown) => settleAbsorbedChildren(input),
}));

const createAndPublishDispatch = vi.fn(async (_input: unknown) => ({
	dispatch: mockDispatchRow(),
	created: true,
}));
const publishDispatchWakeUp = vi.fn(async (_dispatch: unknown) => {});
const promoteMergeQueueWaits = vi.fn(async (_projectId: string, _repo: string) => false);
vi.mock('@/dispatch/dispatcher.js', () => ({
	createAndPublishDispatch: (input: unknown) => createAndPublishDispatch(input),
	publishDispatchWakeUp: (dispatch: unknown) => publishDispatchWakeUp(dispatch),
	promoteMergeQueueWaits: (projectId: string, repo: string) =>
		promoteMergeQueueWaits(projectId, repo),
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

// The real GitHub adapter over a stubbed Octokit (issue #1113), for the one case
// that must prove `mergeable_state: clean` on a behind head reaches the update
// path — an injected merge capability would only restate the adapter's answer.
const octokitPullsGet = vi.fn();
const octokitPullsMerge = vi.fn();
const octokitCompare = vi.fn();
const octokitGraphql = vi.fn();
vi.mock('@octokit/rest', () => ({
	Octokit: class {
		pulls = { get: octokitPullsGet, merge: octokitPullsMerge };
		repos = { compareCommitsWithBasehead: octokitCompare };
		graphql = octokitGraphql;
	},
}));
vi.mock('@/config/provider.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/config/provider.js')>()),
	getPersonaToken: vi.fn(async () => 'tok-impl'),
}));

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import { GitHubSCMIntegration } from '@/integrations/scm/github/scm-integration.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import { MERGE_CATCH_UP_ACTION, type MergeAutomationJob } from '@/queue/jobs.js';
import type {
	MergePullRequestOutcome,
	UpdatePullRequestBranchOutcome,
	WorkerBranchUpdateOutcome,
} from '@/scm/merge.js';
import type { AggregateCheckStatus, PullRequestDetails } from '@/scm/types.js';
import {
	adoptWorkerBranchUpdate,
	MAX_BASE_UPDATES,
	MAX_MERGE_RETRIES,
	MERGE_PROVIDER_ERROR_EXHAUSTED,
	MERGE_QUEUE_RECHECK_MS,
	MERGE_QUEUED,
	MERGE_REARM_OUTCOMES,
	MERGE_RETRY_EXHAUSTED,
	mergeCatchUpDedupKey,
	mergeDispatchDedupKey,
	mergeRearmDedupKey,
	mergeRetryDelayMs,
	processMergeAutomationDispatch,
	rearmMergeAutomationForGreenHead,
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
	// The ledger key the supersession stamp is written on (issue #1079) — the same
	// SHA until a base update advances `approvedHeadSha` out from under it.
	reviewedHeadSha: 'deadbeef',
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

/**
 * The same registry's pull-request read, which the `merged` path resolves the
 * absorbed settle's own-task identity through (issue #959). On the project's
 * default `issue-` prefix this branch decodes to task 12.
 */
const registeredGetPullRequest = vi.fn(
	async (_p: unknown, _n: number) =>
		({ number: 17, headBranch: 'issue-12', headSha: 'deadbeef' }) as PullRequestDetails,
);

/**
 * The same registry's aggregate check read, which every merge attempt consults
 * before merging (issue #1124). Green by default, so a case that is not about
 * checks merges exactly as it did before the gate existed.
 */
const GREEN_CHECKS: AggregateCheckStatus = {
	totalCount: 1,
	checkRuns: [{ name: 'ci', status: 'completed', conclusion: 'success' }],
};
const registeredGetAggregateCheckStatus = vi.fn(
	async (_p: unknown, _sha: string, _persona?: string): Promise<AggregateCheckStatus> =>
		GREEN_CHECKS,
);

beforeEach(() => {
	_resetSCMProviderRegistryForTesting();
	registeredMergePullRequest.mockClear();
	registeredGetPullRequest.mockClear();
	registeredGetAggregateCheckStatus.mockReset();
	registeredGetAggregateCheckStatus.mockResolvedValue(GREEN_CHECKS);
	registerSCMProvider({
		id: 'github',
		label: 'GitHub',
		category: 'scm',
		webhookRoute: '/github/webhook',
		provider: {
			type: 'github',
			mergePullRequest: registeredMergePullRequest,
			getPullRequest: registeredGetPullRequest,
			getAggregateCheckStatus: registeredGetAggregateCheckStatus,
		},
	} as unknown as SCMProviderManifest);
	completeDispatch.mockClear();
	failDispatch.mockClear();
	scheduleDispatchRetry.mockClear();
	scheduleDispatchRetry.mockImplementation(async () => mockDispatchRow());
	listActiveMergeDispatchesForRepository.mockReset();
	listActiveMergeDispatchesForRepository.mockResolvedValue([]);
	promoteMergeQueueWaits.mockClear();
	updateReviewMergeOutcome.mockClear();
	updateReviewMergeOutcome.mockResolvedValue(true);
	createAndPublishDispatch.mockClear();
	createAndPublishDispatch.mockResolvedValue({ dispatch: mockDispatchRow(), created: true });
	publishDispatchWakeUp.mockClear();
	claimReviewDispatch.mockClear();
	claimReviewDispatch.mockResolvedValue(true);
	refreshReviewDispatchClaim.mockClear();
	settleAbsorbedChildren.mockClear();
	settleAbsorbedChildren.mockResolvedValue([]);
	markReviewVerdictSuperseded.mockClear();
	markReviewVerdictSuperseded.mockResolvedValue(true);
	markReviewRunSuperseded.mockClear();
	markReviewRunSuperseded.mockResolvedValue(true);
	findDispatchByDedupKey.mockReset();
	findDispatchByDedupKey.mockResolvedValue(undefined);
	getActiveDispatchByRunId.mockReset();
	getActiveDispatchByRunId.mockResolvedValue(undefined);
	findApprovedReviewRunForRearm.mockReset();
	findApprovedReviewRunForRearm.mockResolvedValue(undefined);
	adoptWorkerBranchUpdateIntoWaitingMerge.mockReset();
	adoptWorkerBranchUpdateIntoWaitingMerge.mockResolvedValue(
		mockDispatchRow({ state: 'retry-scheduled' }),
	);
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

/**
 * A payload as the head of the merge queue persists it (issue #1114): the job it
 * was handed, plus the instant its turn started.
 */
function onTurn(payload: MergeAutomationJob) {
	return { ...payload, queueTurnStartedAt: expect.any(String) };
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

describe('mergeRearmDedupKey', () => {
	it('keys the re-arm on the Review run and the head', () => {
		expect(mergeRearmDedupKey('run-1', 'deadbeef')).toBe('merge-rearm:run-1:deadbeef');
		expect(mergeRearmDedupKey('run-1', 'deadbeef')).toBe(mergeRearmDedupKey('run-1', 'deadbeef'));
		expect(mergeRearmDedupKey('run-1', 'other')).not.toBe(mergeRearmDedupKey('run-1', 'deadbeef'));
		expect(mergeRearmDedupKey('run-2', 'deadbeef')).not.toBe(
			mergeRearmDedupKey('run-1', 'deadbeef'),
		);
		expect(mergeRearmDedupKey('run-1', 'deadbeef')).not.toBe(mergeDispatchDedupKey('run-1'));
	});
});

describe('rearmMergeAutomationForGreenHead (issue #1128)', () => {
	const autoMerging = { ...project, autoMerge: true };
	const input = { project: autoMerging, prNumber: '17', headSha: 'deadbeef' };

	beforeEach(() => {
		findApprovedReviewRunForRearm.mockResolvedValue({ id: 'run-1', taskId: '17' });
	});

	it('re-arms one merge dispatch for the approved head, keyed on the run and the head', async () => {
		await rearmMergeAutomationForGreenHead(input);

		expect(findApprovedReviewRunForRearm).toHaveBeenCalledExactlyOnceWith(
			{ projectId: project.id, repository: project.repo, prNumber: '17', headSha: 'deadbeef' },
			MERGE_REARM_OUTCOMES,
		);
		expect(MERGE_REARM_OUTCOMES).toEqual(['not-eligible', MERGE_RETRY_EXHAUSTED]);
		expect(getActiveDispatchByRunId).toHaveBeenCalledExactlyOnceWith('run-1');
		expect(createAndPublishDispatch).toHaveBeenCalledExactlyOnceWith({
			projectId: project.id,
			jobPayload: job,
			dedupKey: 'merge-rearm:run-1:deadbeef',
			source: 'synthetic',
			runId: 'run-1',
			taskId: '17',
			phase: 'merge-automation',
		});
	});

	it('does nothing while merge automation is off for the repository', async () => {
		await rearmMergeAutomationForGreenHead({ ...input, project: { ...project, autoMerge: false } });

		expect(findApprovedReviewRunForRearm).not.toHaveBeenCalled();
		expect(createAndPublishDispatch).not.toHaveBeenCalled();
	});

	it('does nothing when no approval of this head stopped with a re-armable outcome', async () => {
		findApprovedReviewRunForRearm.mockResolvedValue(undefined);

		await rearmMergeAutomationForGreenHead(input);

		expect(createAndPublishDispatch).not.toHaveBeenCalled();
	});

	it('does nothing while the approving run still has a dispatch due', async () => {
		getActiveDispatchByRunId.mockResolvedValue(mockDispatchRow({ state: 'retry-scheduled' }));

		await rearmMergeAutomationForGreenHead(input);

		expect(createAndPublishDispatch).not.toHaveBeenCalled();
	});

	it('mints no duplicate when the head was already re-armed', async () => {
		createAndPublishDispatch.mockResolvedValue({ dispatch: mockDispatchRow(), created: false });

		await expect(rearmMergeAutomationForGreenHead(input)).resolves.toBeUndefined();
		expect(createAndPublishDispatch).toHaveBeenCalledOnce();
	});

	it('is best-effort: a creation failure is swallowed, never thrown', async () => {
		createAndPublishDispatch.mockRejectedValue(new Error('db down'));

		await expect(rearmMergeAutomationForGreenHead(input)).resolves.toBeUndefined();
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
		expect(input.jobPayload).toEqual(onTurn(job));
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

	it('records not-ready retry exhaustion and completes the dispatch once the budget is spent', async () => {
		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: MAX_MERGE_RETRIES }),
			job,
			project,
			{ mergePullRequest: mergeReturning({ status: 'not-ready', message: 'checks pending' }) },
		);

		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		expect(updateReviewMergeOutcome).toHaveBeenLastCalledWith('run-1', {
			status: MERGE_RETRY_EXHAUSTED,
			// Unchanged byte-for-byte: this wording is already in run history.
			message:
				'Merge automation gave up after repeated not-ready results; the pull request is approved but was left open for a manual merge.',
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

	// Issue #923: one transient 5xx used to settle the dispatch terminally, and
	// nothing could ever re-create it — the dedup key and the review-verdict
	// ledger both hold. It now rides the same bounded budget `not-ready` owns.
	it('schedules a bounded retry on an unexpected provider failure', async () => {
		const before = Date.now();
		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: 2 }),
			job,
			project,
			{
				mergePullRequest: mergeReturning({
					status: 'provider-error',
					message: '502 Bad Gateway',
				}),
			},
		);

		expect(failDispatch).not.toHaveBeenCalled();
		expect(completeDispatch).not.toHaveBeenCalled();
		expect(scheduleDispatchRetry).toHaveBeenCalledTimes(1);
		const input = lastRetryInput();
		// The payload travels unchanged — a provider failure advances no head.
		expect(input.jobPayload).toEqual(onTurn(job));
		expect(input.waitReason).toBe('recheck');
		expect(input.attempt).toBe(3);
		const delay = input.availableAt.getTime() - before;
		expect(delay).toBeGreaterThanOrEqual(mergeRetryDelayMs(3) - 1000);
		expect(delay).toBeLessThanOrEqual(mergeRetryDelayMs(3) + 1000);
		// The reason is on the Review run from the first failed attempt, so the
		// dashboard names it while the retries are still running.
		expect(updateReviewMergeOutcome).toHaveBeenLastCalledWith('run-1', {
			status: 'provider-error',
			message: '502 Bad Gateway',
			attempt: 2,
			approvedHeadSha: 'deadbeef',
		});
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'retry-scheduled',
			prNumber: '17',
		});
	});

	it('records provider-error exhaustion once that same budget is spent', async () => {
		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: MAX_MERGE_RETRIES }),
			job,
			project,
			{
				mergePullRequest: mergeReturning({
					status: 'provider-error',
					message: '502 Bad Gateway',
				}),
			},
		);

		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		expect(failDispatch).not.toHaveBeenCalled();
		expect(updateReviewMergeOutcome).toHaveBeenLastCalledWith('run-1', {
			status: MERGE_PROVIDER_ERROR_EXHAUSTED,
			message: expect.stringContaining('502 Bad Gateway'),
			attempt: MAX_MERGE_RETRIES,
			approvedHeadSha: 'deadbeef',
		});
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-retry-exhausted');
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: MERGE_PROVIDER_ERROR_EXHAUSTED,
			prNumber: '17',
		});
	});

	// Both give-ups complete the dispatch through one outcome; the Review run is
	// what tells "the forge kept failing" apart from "it never became ready".
	it('keeps the two budget exhaustions distinguishable on the run', async () => {
		await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: MAX_MERGE_RETRIES }),
			job,
			project,
			{ mergePullRequest: mergeReturning({ status: 'not-ready', message: 'checks pending' }) },
		);
		const notReady = updateReviewMergeOutcome.mock.calls.at(-1)?.[1];

		await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: MAX_MERGE_RETRIES }),
			job,
			project,
			{ mergePullRequest: mergeReturning({ status: 'provider-error', message: '502' }) },
		);
		const providerError = updateReviewMergeOutcome.mock.calls.at(-1)?.[1];

		expect(notReady).toMatchObject({ status: MERGE_RETRY_EXHAUSTED });
		expect(providerError).toMatchObject({ status: MERGE_PROVIDER_ERROR_EXHAUSTED });
		expect(MERGE_RETRY_EXHAUSTED).not.toBe(MERGE_PROVIDER_ERROR_EXHAUSTED);
		expect(completeDispatch.mock.calls.map((call) => call[1])).toEqual([
			'merge-retry-exhausted',
			'merge-retry-exhausted',
		]);
	});

	// The acceptance criterion the stranded pull requests were about: a retried
	// merge needs no operator action at all.
	it('merges on a later attempt after a transient provider failure, with no operator action', async () => {
		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'provider-error', message: '502 Bad Gateway' }),
		});

		expect(scheduleDispatchRetry).toHaveBeenCalledTimes(1);
		expect(lastRetryInput().jobPayload).toEqual(onTurn(job));

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: 1 }),
			job,
			project,
			{
				mergePullRequest: mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' }),
			},
		);

		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
		expect(failDispatch).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'merged',
			prNumber: '17',
		});
	});

	it('normalizes a thrown provider rejection to a retried provider-error', async () => {
		const mergePullRequest = vi.fn(async () => {
			throw new Error('provider unavailable');
		});

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest,
		});

		expect(failDispatch).not.toHaveBeenCalled();
		expect(updateReviewMergeOutcome).toHaveBeenLastCalledWith('run-1', {
			status: 'provider-error',
			message: 'provider unavailable',
			attempt: 0,
			approvedHeadSha: 'deadbeef',
		});
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'retry-scheduled',
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
	// Since issue #923 it settles as a *bounded retry*: a misconfigured project
	// costs the budget and then exhausts terminally, with the reason on the run
	// from the first attempt rather than a status-code predicate in shared code.
	it('settles the dispatch as a retried provider-error when no provider is registered', async () => {
		_resetSCMProviderRegistryForTesting();

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project);

		expect(failDispatch).not.toHaveBeenCalled();
		expect(updateReviewMergeOutcome).toHaveBeenCalledOnce();
		expect(updateReviewMergeOutcome.mock.calls[0]?.[1]).toMatchObject({
			status: 'provider-error',
			message: expect.stringMatching(/Cannot resolve the SCM provider/),
		});
		expect(scheduleDispatchRetry).toHaveBeenCalledTimes(1);
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'retry-scheduled',
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

	// A merge that is *not* behind its base behaves as it did before issue #874 —
	// no branch update, one merge call — except that since issue #1124 the
	// approved head's own checks are read first, as the implementer.
	it('merges a green approved head as today, after one check read', async () => {
		const updatePullRequestBranch = updateReturning({ status: 'up-to-date' });
		const getAggregateCheckStatus = checksConcluding('success');
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest,
			updatePullRequestBranch,
			getAggregateCheckStatus,
		});

		expect(getAggregateCheckStatus).toHaveBeenCalledExactlyOnceWith(
			project,
			'deadbeef',
			'implementer',
		);
		expect(getAggregateCheckStatus.mock.invocationCallOrder[0]).toBeLessThan(
			mergePullRequest.mock.invocationCallOrder[0] as number,
		);
		expect(updatePullRequestBranch).not.toHaveBeenCalled();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
	});
});

// Issue #1124 — an approval does not prove the approved head is green: a Review
// dispatched off `opened`, or one that queued while CI changed, can approve a
// head whose checks are still running or already red.
describe('processMergeAutomationDispatch: an approved head whose checks are not green (issue #1124)', () => {
	/** One finished green run plus one still running — the head is pending. */
	function checksPending(state: 'in_progress' | 'queued' = 'in_progress', name = 'test') {
		return vi.fn(
			async (): Promise<AggregateCheckStatus> => ({
				totalCount: 2,
				checkRuns: [
					{ name: 'lint', status: 'completed', conclusion: 'success' },
					{ name, status: state, conclusion: null },
				],
			}),
		);
	}

	function commentSpy() {
		return vi.fn(async (_p: unknown, _n: number, _body: string, _persona?: string) => 1);
	}

	it('does not merge a red approved head, and says so on the run and the pull request', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });
		const updatePullRequestBranch = updateReturning({ status: 'updated', headSha: 'never' });
		const commentOnPullRequest = commentSpy();

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest,
			updatePullRequestBranch,
			getAggregateCheckStatus: checksConcluding('success', 'failure'),
			commentOnPullRequest,
		});

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(updatePullRequestBranch).not.toHaveBeenCalled();
		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith('run-1', {
			status: 'not-eligible',
			message: expect.stringMatching(/approved head.*check-1/),
			attempt: 0,
			approvedHeadSha: 'deadbeef',
		});
		expect(commentOnPullRequest).toHaveBeenCalledOnce();
		const body = commentOnPullRequest.mock.calls[0]?.[2] as string;
		expect(body).toContain('check-1');
		expect(body).toContain('`deadbeef`');
		expect(body).toContain('Respond-to-CI');
		expect(body).toContain('Generated by SWARM');
		// A head re-run green is re-armed (issue #1128), not left for a hand merge.
		expect(body).toContain('SWARM merges this head');
		expect(body).not.toContain('merge by hand');
		// Not the stale-base wording: nothing here is about the base.
		expect(body).not.toContain('nothing has built against the');
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(promoteMergeQueueWaits).toHaveBeenCalledExactlyOnceWith(project.id, project.repo);
		// A genuinely red head keeps its approval's slot (issue #1079).
		expect(markReviewVerdictSuperseded).not.toHaveBeenCalled();
		expect(markReviewRunSuperseded).not.toHaveBeenCalled();
		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'not-eligible',
			prNumber: '17',
		});
	});

	it('refuses a red approved head without first bringing it up to date with its base', async () => {
		const updatePullRequestBranch = updateReturning({ status: 'updated', headSha: 'never' });
		const mergePullRequest = mergeReturning(STALE_BASE);

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest,
			updatePullRequestBranch,
			getAggregateCheckStatus: checksConcluding('failure'),
			commentOnPullRequest: commentSpy(),
		});

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(updatePullRequestBranch).not.toHaveBeenCalled();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
	});

	it('waits, without merging, while the approved head’s checks are still running', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest,
			getAggregateCheckStatus: checksPending(),
		});

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(completeDispatch).not.toHaveBeenCalled();
		const input = lastRetryInput();
		expect(input.attempt).toBe(1);
		expect(input.waitReason).toBe('recheck');
		expect(input.jobPayload).toEqual(onTurn(job));
		const recorded = updateReviewMergeOutcome.mock.calls.at(-1)?.[1] as {
			status: string;
			message: string;
		};
		expect(recorded.status).toBe('not-ready');
		expect(recorded.message).toMatch(/^waiting for the checks on the approved head/);
		expect(recorded.message).toContain('test');
		expect(outcome.result).toBe('retry-scheduled');
	});

	it('gives up on a head whose checks stay pending, saying SWARM merges it once they are green', async () => {
		await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: MAX_MERGE_RETRIES }),
			job,
			project,
			{ getAggregateCheckStatus: checksPending() },
		);

		const recorded = updateReviewMergeOutcome.mock.calls.at(-1)?.[1] as {
			status: string;
			message: string;
		};
		expect(recorded.status).toBe(MERGE_RETRY_EXHAUSTED);
		// Re-armed once its checks complete green (issue #1128).
		expect(recorded.message).toContain('SWARM merges it once its checks complete green');
		expect(recorded.message).not.toContain('manual merge');
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-retry-exhausted');
	});

	it('merges a pending approved head once its checks turn green', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest,
			getAggregateCheckStatus: checksPending(),
		});
		expect(mergePullRequest).not.toHaveBeenCalled();

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: 1 }),
			job,
			project,
			{ mergePullRequest, getAggregateCheckStatus: checksConcluding('success', 'success') },
		);

		expect(mergePullRequest).toHaveBeenCalledExactlyOnceWith(project, 17, 'deadbeef');
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
		expect(outcome.result).toBe('merged');
	});

	it('refuses a pending approved head that turns red, as red', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });
		const commentOnPullRequest = commentSpy();

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest,
			getAggregateCheckStatus: checksPending(),
			commentOnPullRequest,
		});
		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: 1 }),
			job,
			project,
			{
				mergePullRequest,
				getAggregateCheckStatus: checksConcluding('success', 'failure'),
				commentOnPullRequest,
			},
		);

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(commentOnPullRequest).toHaveBeenCalledOnce();
		expect(markReviewVerdictSuperseded).not.toHaveBeenCalled();
		expect(outcome.result).toBe('not-eligible');
	});

	it('bounds the wait, settling with the pending checks named once the budget is spent', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: MAX_MERGE_RETRIES }),
			job,
			project,
			{ mergePullRequest, getAggregateCheckStatus: checksPending('queued', 'build') },
		);

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-retry-exhausted');
		const recorded = updateReviewMergeOutcome.mock.calls.at(-1)?.[1] as {
			status: string;
			message: string;
		};
		expect(recorded.status).toBe(MERGE_RETRY_EXHAUSTED);
		expect(recorded.message).toContain("approved head's checks");
		expect(recorded.message).toContain('build');
		expect(outcome.result).toBe(MERGE_RETRY_EXHAUSTED);
	});

	it('merges a zero-check approved head under if-present without waiting', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });

		await processMergeAutomationDispatch(
			mockDispatchRow(),
			job,
			{ ...project, reviewChecks: 'if-present' },
			{
				mergePullRequest,
				getAggregateCheckStatus: vi.fn(async () => ({ totalCount: 0, checkRuns: [] })),
			},
		);

		expect(mergePullRequest).toHaveBeenCalledExactlyOnceWith(expect.anything(), 17, 'deadbeef');
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
	});

	it('waits on a zero-check approved head under the default required policy', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest,
			getAggregateCheckStatus: vi.fn(async () => ({ totalCount: 0, checkRuns: [] })),
		});

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(lastRetryInput().attempt).toBe(1);
		expect(outcome.result).toBe('retry-scheduled');
	});

	it('treats a failing check read as a retried provider error, never a merge', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest,
			getAggregateCheckStatus: vi.fn(async () => {
				throw new Error('checks API 502');
			}),
		});

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(updateReviewMergeOutcome).toHaveBeenLastCalledWith('run-1', {
			status: 'provider-error',
			message: 'checks API 502',
			attempt: 0,
			approvedHeadSha: 'deadbeef',
		});
		expect(scheduleDispatchRetry).toHaveBeenCalledTimes(1);
		expect(outcome.result).toBe('retry-scheduled');
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
		expect(input.jobPayload).toEqual(
			onTurn({
				...job,
				approvedHeadSha: 'merged-with-base',
				baseUpdates: 1,
			}),
		);
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

	// Issue #1113: a repository that opts into `if-present` and has no checks at
	// all merges the updated head straight away instead of waiting out a budget.
	it('merges an updated head with no checks under if-present without waiting', async () => {
		const advanced: MergeAutomationJob = {
			...job,
			approvedHeadSha: 'merged-with-base',
			baseUpdates: 1,
		};
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });

		await processMergeAutomationDispatch(
			mockDispatchRow(),
			advanced,
			{ ...project, reviewChecks: 'if-present' },
			{
				mergePullRequest,
				getAggregateCheckStatus: vi.fn(async () => ({ totalCount: 0, checkRuns: [] })),
			},
		);

		expect(mergePullRequest).toHaveBeenCalledExactlyOnceWith(
			expect.anything(),
			17,
			'merged-with-base',
		);
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
	});

	// Issue #1113: CI that never starts on the updated head (a self-hosted runner
	// that is offline) settles within the existing budget, naming what it waited for.
	it('settles naming the pending checks when the updated head’s CI never starts', async () => {
		const advanced: MergeAutomationJob = {
			...job,
			approvedHeadSha: 'merged-with-base',
			baseUpdates: 1,
		};
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged' });

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: MAX_MERGE_RETRIES }),
			advanced,
			project,
			{
				mergePullRequest,
				getAggregateCheckStatus: vi.fn(async () => ({
					totalCount: 1,
					checkRuns: [{ name: 'build', status: 'queued', conclusion: null }],
				})),
			},
		);

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-retry-exhausted');
		const recorded = updateReviewMergeOutcome.mock.calls.at(-1)?.[1] as {
			status: string;
			message: string;
		};
		expect(recorded.status).toBe(MERGE_RETRY_EXHAUSTED);
		expect(recorded.message).toContain('up to date with its base');
		expect(recorded.message).toContain('build');
		expect(outcome.result).toBe(MERGE_RETRY_EXHAUSTED);
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
		// Issue #1113: a moving base is told apart from a red build — both the run's
		// outcome and the comment say the base kept moving and how many updates it cost.
		const recorded = updateReviewMergeOutcome.mock.calls.at(-1)?.[1] as { message: string };
		expect(recorded.message).toContain(`${MAX_BASE_UPDATES} times`);
		expect(recorded.message).toContain('base is moving faster');
		expect(commentOnPullRequest).toHaveBeenCalledOnce();
		const body = commentOnPullRequest.mock.calls[0]?.[2] ?? '';
		expect(body).toContain(`${MAX_BASE_UPDATES} times`);
		expect(body).toContain('base moved again');
		expect(body).not.toContain('fails its checks');
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
		expect(lastRetryInput().jobPayload).toEqual(onTurn(job));
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

	// A head the provider could not attribute to *its own* update is the case the
	// pin alone never covered: `update-branch` merges in the background, so the
	// head read back afterwards may be one somebody pushed. Advancing onto it
	// would carry the approval — and the claimed review slot — onto unreviewed
	// code, so this settles exactly as a pushed head has always settled.
	it('never advances onto a head the provider could not attribute to its update', async () => {
		const commentOnPullRequest = vi.fn(async (_p: unknown, _n: number, _body: string) => 1);

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({
				status: 'head-moved',
				message: 'The head of #17 is pushed-head, which GitHub did not produce',
			}),
			commentOnPullRequest,
		});

		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith('run-1', {
			status: 'not-eligible',
			message: 'The head of #17 is pushed-head, which GitHub did not produce',
			attempt: 0,
			// The approval stays pinned to the reviewed commit, and no advance is recorded.
			approvedHeadSha: 'deadbeef',
			advancedFrom: undefined,
		});
		// No retry, and above all no pre-claimed review slot: the pushed head is
		// owed the Review this would otherwise have suppressed.
		expect(claimReviewDispatch).not.toHaveBeenCalled();
		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		expect(commentOnPullRequest).toHaveBeenCalledOnce();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(outcome.result).toBe('not-eligible');
	});

	// The update call's own provider error takes the same shared budget as the
	// merge call's (issue #923) — leaving it terminal would half-fix the
	// lifecycle, since an identical 502 would still strand the pull request.
	it('retries when the update itself fails unexpectedly', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({
				status: 'provider-error',
				message: '502 Bad Gateway',
			}),
		});

		expect(failDispatch).not.toHaveBeenCalled();
		expect(completeDispatch).not.toHaveBeenCalled();
		expect(scheduleDispatchRetry).toHaveBeenCalledTimes(1);
		// Which call failed travels in the message, replacing the log line the
		// terminal branch used to emit.
		expect(updateReviewMergeOutcome).toHaveBeenLastCalledWith('run-1', {
			status: 'provider-error',
			message: 'failed to bring the head up to date with the base: 502 Bad Gateway',
			attempt: 0,
			approvedHeadSha: 'deadbeef',
		});
		expect(outcome.result).toBe('retry-scheduled');
	});

	it('normalizes a thrown update rejection to a retried provider-error', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: vi.fn(async () => {
				throw new Error('provider unavailable');
			}),
		});

		expect(failDispatch).not.toHaveBeenCalled();
		expect(updateReviewMergeOutcome).toHaveBeenLastCalledWith('run-1', {
			status: 'provider-error',
			message: 'failed to bring the head up to date with the base: provider unavailable',
			attempt: 0,
			approvedHeadSha: 'deadbeef',
		});
		expect(outcome.result).toBe('retry-scheduled');
	});

	// A comment is an extra on top of the durable outcome, never the notice itself.
	it('settles even when the refusal comment cannot be posted', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({ status: 'conflict', message: 'conflicts' }),
			commentOnPullRequest: vi.fn(async (_p: unknown, _n: number, _body: string) => {
				throw new Error('provider unreachable');
			}),
		});

		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(outcome.result).toBe('not-eligible');
	});
});

// Issue #1117: Bitbucket Cloud, gitlab.com and Azure DevOps Services declare
// `updatePullRequestBranch` unsupported, so a SWARM worker does the update and
// hands its result back to the dispatch waiting on it.
describe('processMergeAutomationDispatch: a provider that cannot update a branch', () => {
	const prAtHead = (headSha: string) =>
		vi.fn(async () => ({ number: 17, headBranch: 'issue-12', headSha }) as PullRequestDetails);
	const UNSUPPORTED: UpdatePullRequestBranchOutcome = {
		status: 'unsupported',
		message: 'Bitbucket Cloud exposes no API for merging the destination branch',
	};
	/** The payload once the catch-up was asked for this head, optionally with its result. */
	function waitingOnWorker(result?: WorkerBranchUpdateOutcome): MergeAutomationJob {
		return { ...job, workerCatchUp: { requestedFor: 'deadbeef', ...(result ? { result } : {}) } };
	}

	it('asks a SWARM worker for the update and parks, with no comment and no terminal settle', async () => {
		const requestMergeCatchUp = vi.fn(async (_input: unknown) => {});
		const commentOnPullRequest = vi.fn(async (_p: unknown, _n: number, _body: string) => 1);

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: 3 }),
			job,
			project,
			{
				mergePullRequest: mergeReturning(STALE_BASE),
				updatePullRequestBranch: updateReturning(UNSUPPORTED),
				commentOnPullRequest,
				requestMergeCatchUp,
			},
		);

		expect(requestMergeCatchUp).toHaveBeenCalledExactlyOnceWith({
			project,
			job: onTurn(job),
		});
		const input = lastRetryInput();
		expect(input.jobPayload).toEqual(onTurn(waitingOnWorker()));
		expect(input.waitReason).toBe('recheck');
		// A new wait: the budget restarts, sized like the one after GitHub's own update.
		expect(input.attempt).toBe(0);
		expect(input.availableAt.getTime() - Date.now()).toBeLessThanOrEqual(mergeRetryDelayMs(1));
		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith('run-1', {
			status: 'stale-base',
			message: expect.stringContaining('a SWARM worker is merging the base into it'),
			attempt: 3,
			approvedHeadSha: 'deadbeef',
			advancedFrom: undefined,
		});
		expect(commentOnPullRequest).not.toHaveBeenCalled();
		expect(completeDispatch).not.toHaveBeenCalled();
		expect(promoteMergeQueueWaits).not.toHaveBeenCalled();
		expect(outcome.result).toBe('retry-scheduled');
	});

	it('persists the catch-up as a deduped resolve-conflicts dispatch by default', async () => {
		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning(UNSUPPORTED),
		});

		expect(createAndPublishDispatch).toHaveBeenCalledExactlyOnceWith({
			projectId: project.id,
			jobPayload: {
				type: 'scm',
				providerId: 'github',
				projectId: project.id,
				mergeCatchUp: { reviewRunId: 'run-1', headSha: 'deadbeef' },
				event: {
					kind: 'pull-request',
					action: MERGE_CATCH_UP_ACTION,
					repoFullName: project.repo,
					workItemId: '17',
					isCommentEvent: false,
					headSha: 'deadbeef',
				},
			},
			dedupKey: mergeCatchUpDedupKey('run-1', 'deadbeef'),
			source: 'synthetic',
			taskId: '17-conflicts',
			phase: 'resolve-conflicts',
		});
		expect(mergeCatchUpDedupKey('run-1', 'deadbeef')).toBe('merge-catch-up:run-1:deadbeef');
	});

	it('waits on the ordinary budget, asking nothing again, once the update is requested', async () => {
		const requestMergeCatchUp = vi.fn(async (_input: unknown) => {});
		const mergePullRequest = mergeReturning(STALE_BASE);

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: 2 }),
			waitingOnWorker(),
			project,
			{
				mergePullRequest,
				updatePullRequestBranch: updateReturning(UNSUPPORTED),
				requestMergeCatchUp,
			},
		);

		expect(requestMergeCatchUp).not.toHaveBeenCalled();
		// Not offered while the update is out (see the next test for why).
		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(lastRetryInput().attempt).toBe(3);
		expect(updateReviewMergeOutcome).toHaveBeenLastCalledWith('run-1', {
			status: 'not-ready',
			message: 'waiting for a SWARM worker to bring the head up to date with the base',
			attempt: 2,
			approvedHeadSha: 'deadbeef',
			advancedFrom: undefined,
		});
		expect(outcome.result).toBe('retry-scheduled');
	});

	it('a head the worker already pushed before the hand-back landed does not settle not-eligible', async () => {
		const commentOnPullRequest = vi.fn(async (_p: unknown, _n: number, _body: string) => 1);
		// What the provider would answer for the approved head once the worker's
		// merge commit is the branch's head.
		const mergePullRequest = mergeReturning({
			status: 'not-eligible',
			message: 'pull request head changed since the reviewed commit',
		});

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: 1 }),
			waitingOnWorker(),
			project,
			{ mergePullRequest, commentOnPullRequest, getPullRequest: prAtHead('worker-merge') },
		);

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(commentOnPullRequest).not.toHaveBeenCalled();
		expect(completeDispatch).not.toHaveBeenCalled();
		expect(markReviewVerdictSuperseded).not.toHaveBeenCalled();
		const input = lastRetryInput();
		expect(input.attempt).toBe(2);
		// Still waiting for that same update, so the hand-back can adopt it.
		expect(input.jobPayload.workerCatchUp).toEqual({ requestedFor: 'deadbeef' });
		expect(outcome.result).toBe('retry-scheduled');
	});

	it('gives up on the bounded budget when the worker never answers', async () => {
		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: MAX_MERGE_RETRIES }),
			waitingOnWorker(),
			project,
			{
				mergePullRequest: mergeReturning(STALE_BASE),
				updatePullRequestBranch: updateReturning(UNSUPPORTED),
			},
		);

		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-retry-exhausted');
		expect(updateReviewMergeOutcome).toHaveBeenLastCalledWith(
			'run-1',
			expect.objectContaining({
				status: MERGE_RETRY_EXHAUSTED,
				message: expect.stringContaining('asked a SWARM worker'),
			}),
		);
		expect(outcome.result).toBe(MERGE_RETRY_EXHAUSTED);
	});

	it('retries the request on the ordinary budget when it cannot be persisted', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning(UNSUPPORTED),
			requestMergeCatchUp: vi.fn(async () => {
				throw new Error('db down');
			}),
		});

		const input = lastRetryInput();
		expect(input.attempt).toBe(1);
		// Not marked requested, so the next attempt asks again.
		expect(input.jobPayload.workerCatchUp).toBeUndefined();
		expect(outcome.result).toBe('retry-scheduled');
	});

	it('advances onto the head the worker produced, pre-claims its review slot and resets the budget', async () => {
		const mergePullRequest = mergeReturning(STALE_BASE);

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow({ attempt: 4 }),
			waitingOnWorker({ status: 'updated', headSha: 'worker-merge' }),
			project,
			{ mergePullRequest },
		);

		expect(mergePullRequest).not.toHaveBeenCalled();
		const input = lastRetryInput();
		expect(input.jobPayload).toEqual(
			onTurn({ ...job, approvedHeadSha: 'worker-merge', baseUpdates: 1 }),
		);
		expect(input.attempt).toBe(0);
		expect(claimReviewDispatch).toHaveBeenCalledWith(
			`${project.repo}:17:worker-merge`,
			'merge-automation',
			{ prNumber: '17', headSha: 'worker-merge' },
		);
		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith('run-1', {
			status: 'stale-base',
			message: expect.stringContaining('on a SWARM worker (deadbeef → worker-merge)'),
			attempt: 4,
			approvedHeadSha: 'worker-merge',
			advancedFrom: 'deadbeef',
		});
		expect(outcome.result).toBe('retry-scheduled');
	});

	it('merges the worker-produced head once its own checks are green', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged', sha: 'm' });

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow(),
			{ ...job, approvedHeadSha: 'worker-merge', baseUpdates: 1 },
			project,
			{ mergePullRequest, getAggregateCheckStatus: checksConcluding('success') },
		);

		expect(mergePullRequest).toHaveBeenCalledExactlyOnceWith(project, 17, 'worker-merge');
		expect(outcome.result).toBe('merged');
	});

	it('settles a conflicting worker merge terminally, with the conflict comment', async () => {
		const commentOnPullRequest = vi.fn(async (_p: unknown, _n: number, _body: string) => 1);
		const mergePullRequest = mergeReturning(STALE_BASE);

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow(),
			waitingOnWorker({ status: 'conflict', message: 'conflicts in a.ts' }),
			project,
			{ mergePullRequest, commentOnPullRequest, getPullRequest: prAtHead('deadbeef') },
		);

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(commentOnPullRequest.mock.calls[0]?.[2]).toContain(
			'the base does not merge into it cleanly: conflicts in a.ts',
		);
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(markReviewVerdictSuperseded).not.toHaveBeenCalled();
		expect(promoteMergeQueueWaits).toHaveBeenCalledExactlyOnceWith(project.id, job.repo);
		expect(outcome.result).toBe('not-eligible');
	});

	it('settles a head that moved under the worker terminally and frees the approval’s slot', async () => {
		const commentOnPullRequest = vi.fn(async (_p: unknown, _n: number, _body: string) => 1);

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow(),
			waitingOnWorker({ status: 'head-moved', message: 'branch is at pushed-head' }),
			project,
			{
				mergePullRequest: mergeReturning(STALE_BASE),
				commentOnPullRequest,
				getPullRequest: prAtHead('pushed-head'),
			},
		);

		expect(commentOnPullRequest.mock.calls[0]?.[2]).toContain(
			'the branch moved to a commit SWARM did not ask for: branch is at pushed-head',
		);
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(markReviewVerdictSuperseded).toHaveBeenCalledOnce();
		expect(outcome.result).toBe('not-eligible');
	});

	it('merges as usual when the worker found the head already up to date', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged', sha: 'm' });

		const outcome = await processMergeAutomationDispatch(
			mockDispatchRow(),
			waitingOnWorker({ status: 'up-to-date' }),
			project,
			{ mergePullRequest },
		);

		expect(mergePullRequest).toHaveBeenCalledOnce();
		expect(outcome.result).toBe('merged');
	});

	it('ignores a result recorded for a head the dispatch has moved past', async () => {
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged', sha: 'm' });

		await processMergeAutomationDispatch(
			mockDispatchRow(),
			{
				...job,
				approvedHeadSha: 'later-head',
				workerCatchUp: {
					requestedFor: 'deadbeef',
					result: { status: 'conflict', message: 'stale' },
				},
			},
			project,
			{ mergePullRequest, getAggregateCheckStatus: checksConcluding('success') },
		);

		expect(mergePullRequest).toHaveBeenCalledOnce();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
	});

	// Acceptance (d): GitHub keeps its own update; the fallback is `unsupported`'s alone.
	it('never asks a worker when the provider can update the branch itself', async () => {
		const requestMergeCatchUp = vi.fn(async (_input: unknown) => {});

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({ status: 'updated', headSha: 'gh-merge' }),
			requestMergeCatchUp,
		});

		expect(requestMergeCatchUp).not.toHaveBeenCalled();
		expect(lastRetryInput().jobPayload.approvedHeadSha).toBe('gh-merge');
	});
});

describe('adoptWorkerBranchUpdate', () => {
	const waiting: MergeAutomationJob = { ...job, workerCatchUp: { requestedFor: 'deadbeef' } };
	const input = {
		project,
		reviewRunId: 'run-1',
		headSha: 'deadbeef',
		outcome: { status: 'updated', headSha: 'worker-merge' } as const,
	};
	const noSleep = vi.fn(async (_ms: number) => {});

	beforeEach(() => noSleep.mockClear());

	it('adopts the result into the waiting merge dispatch and wakes it', async () => {
		findDispatchByDedupKey.mockResolvedValue(
			mockDispatchRow({ state: 'retry-scheduled', wakeSeq: 7, jobPayload: waiting }),
		);

		expect(await adoptWorkerBranchUpdate(input, noSleep)).toBe(true);

		expect(findDispatchByDedupKey).toHaveBeenCalledWith(mergeDispatchDedupKey('run-1'));
		expect(adoptWorkerBranchUpdateIntoWaitingMerge).toHaveBeenCalledExactlyOnceWith(
			'dispatch-1',
			7,
			{
				...waiting,
				workerCatchUp: { requestedFor: 'deadbeef', result: input.outcome },
			},
		);
		expect(publishDispatchWakeUp).toHaveBeenCalledOnce();
		// Settling is the merge dispatch's own job, under its own claim.
		expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		expect(completeDispatch).not.toHaveBeenCalled();
	});

	it.each([
		['no merge dispatch', undefined],
		['a settled merge dispatch', mockDispatchRow({ state: 'completed', jobPayload: waiting })],
		[
			'one that moved past this head',
			mockDispatchRow({
				state: 'retry-scheduled',
				jobPayload: { ...waiting, approvedHeadSha: 'later' },
			}),
		],
		[
			'one that never asked for this update',
			mockDispatchRow({ state: 'retry-scheduled', jobPayload: job }),
		],
	])('drops the result for %s', async (_label, row) => {
		findDispatchByDedupKey.mockResolvedValue(row);

		expect(await adoptWorkerBranchUpdate(input, noSleep)).toBe(false);

		expect(adoptWorkerBranchUpdateIntoWaitingMerge).not.toHaveBeenCalled();
		expect(noSleep).not.toHaveBeenCalled();
	});

	it("hands the result to a re-armed merge dispatch, the run's active one (issue #1128)", async () => {
		getActiveDispatchByRunId.mockResolvedValue(
			mockDispatchRow({ id: 'rearmed', state: 'retry-scheduled', wakeSeq: 2, jobPayload: waiting }),
		);

		expect(await adoptWorkerBranchUpdate(input, noSleep)).toBe(true);

		expect(getActiveDispatchByRunId).toHaveBeenCalledWith('run-1');
		expect(findDispatchByDedupKey).not.toHaveBeenCalled();
		expect(adoptWorkerBranchUpdateIntoWaitingMerge).toHaveBeenCalledExactlyOnceWith(
			'rearmed',
			2,
			expect.objectContaining({
				workerCatchUp: { requestedFor: 'deadbeef', result: input.outcome },
			}),
		);
	});

	it('reads a merge dispatch caught mid-attempt again until it is waiting', async () => {
		findDispatchByDedupKey
			.mockResolvedValueOnce(mockDispatchRow({ state: 'running', jobPayload: waiting }))
			.mockResolvedValueOnce(mockDispatchRow({ state: 'retry-scheduled', jobPayload: waiting }));

		expect(await adoptWorkerBranchUpdate(input, noSleep)).toBe(true);

		expect(noSleep).toHaveBeenCalledOnce();
		expect(adoptWorkerBranchUpdateIntoWaitingMerge).toHaveBeenCalledOnce();
	});

	it('gives up, bounded, on a merge dispatch that stays busy', async () => {
		findDispatchByDedupKey.mockResolvedValue(
			mockDispatchRow({ state: 'leased', jobPayload: waiting }),
		);

		expect(await adoptWorkerBranchUpdate(input, noSleep)).toBe(false);

		expect(findDispatchByDedupKey).toHaveBeenCalledTimes(5);
		expect(noSleep).toHaveBeenCalledTimes(4);
	});
});

// Issue #1113: a private repository on GitHub's free plan cannot require
// up-to-date branches, so GitHub reports `mergeable_state: clean` for a head
// many commits behind its base. The real adapter must still answer `stale-base`.
describe('processMergeAutomationDispatch: GitHub reporting clean for a behind head', () => {
	const github = new GitHubSCMIntegration();

	beforeEach(() => {
		octokitPullsGet.mockReset().mockResolvedValue({
			data: {
				merged: false,
				state: 'open',
				draft: false,
				head: { sha: 'deadbeef' },
				base: { ref: 'main' },
				mergeable_state: 'clean',
			},
		});
		octokitGraphql
			.mockReset()
			.mockResolvedValue({ repository: { pullRequest: { reviewDecision: 'APPROVED' } } });
		octokitPullsMerge.mockReset().mockResolvedValue({
			data: { merged: true, message: 'Pull Request successfully merged', sha: 'merge-sha' },
		});
		octokitCompare.mockReset();
	});

	function realMerge() {
		return (p: Parameters<typeof github.mergePullRequest>[0], n: number, sha: string) =>
			github.mergePullRequest(p, n, sha);
	}

	it('brings a head that lacks its base up to date instead of merging it', async () => {
		octokitCompare.mockResolvedValue({ data: { status: 'diverged' } });
		const updatePullRequestBranch = updateReturning({
			status: 'updated',
			headSha: 'merged-with-base',
		});

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: realMerge(),
			updatePullRequestBranch,
		});

		expect(octokitPullsMerge).not.toHaveBeenCalled();
		expect(octokitCompare).toHaveBeenCalledExactlyOnceWith({
			owner: 'SmartTechBrewery',
			repo: 'swarm',
			basehead: 'main...deadbeef',
		});
		expect(updatePullRequestBranch).toHaveBeenCalledExactlyOnceWith(project, 17, 'deadbeef');
		expect(lastRetryInput().jobPayload).toMatchObject({
			approvedHeadSha: 'merged-with-base',
			baseUpdates: 1,
		});
	});

	it('merges a head that already contains its base exactly as before', async () => {
		octokitCompare.mockResolvedValue({ data: { status: 'ahead' } });
		const updatePullRequestBranch = updateReturning({ status: 'up-to-date' });

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: realMerge(),
			updatePullRequestBranch,
		});

		expect(octokitPullsMerge).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ pull_number: 17, sha: 'deadbeef' }),
		);
		expect(updatePullRequestBranch).not.toHaveBeenCalled();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
		expect(outcome.result).toBe('merged');
	});
});

describe('processMergeAutomationDispatch: settling what the merge absorbed', () => {
	/** The pull request read the own-task resolution goes through. */
	function prOnBranch(headBranch: string) {
		return vi.fn(async () => ({ number: 17, headBranch }) as PullRequestDetails);
	}

	/**
	 * The lazy own-task resolver the settle was last handed. Lazy because resolving
	 * it costs a forge read and essentially every merge declares nothing — so the
	 * settle invokes it only once it has a declaration to act on, and these cases
	 * invoke it the same way.
	 */
	function lastResolveOwnTaskId(): () => Promise<string | undefined> {
		const calls = settleAbsorbedChildren.mock.calls;
		return (calls[calls.length - 1]?.[0] as { resolveOwnTaskId: () => Promise<string | undefined> })
			.resolveOwnTaskId;
	}

	it('settles the declared split siblings once, after the dispatch completes', async () => {
		settleAbsorbedChildren.mockResolvedValue(['#947']);
		const getPullRequest = prOnBranch(`${project.branchPrefix}12`);

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' }),
			getPullRequest,
		});

		expect(settleAbsorbedChildren).toHaveBeenCalledExactlyOnceWith({
			project,
			dispatchId: 'dispatch-1',
			repository: project.repo,
			prNumber: '17',
			resolveOwnTaskId: expect.any(Function),
		});
		// The pull request's own task is the number its head branch encodes — never
		// the Review run's `taskId`, which is the pull request's own number.
		expect(await lastResolveOwnTaskId()()).toBe('12');
		expect(getPullRequest).toHaveBeenCalledExactlyOnceWith(project, 17, 'implementer');
		// The merge is the fact the settle is licensed by, so it can never run first.
		expect(settleAbsorbedChildren.mock.invocationCallOrder[0]).toBeGreaterThan(
			completeDispatch.mock.invocationCallOrder[0] as number,
		);
		expect(outcome.result).toBe('merged');
	});

	it.each([
		['not-ready', { status: 'not-ready', message: 'checks pending' }],
		['not-eligible', { status: 'not-eligible', message: 'head moved' }],
		['provider-error', { status: 'provider-error', message: '502' }],
	] as [string, MergePullRequestOutcome][])('settles nothing on a %s outcome', async (_l, o) => {
		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(o),
		});

		expect(settleAbsorbedChildren).not.toHaveBeenCalled();
	});

	// Fail closed on the guard's input: the settle is told it has none rather than
	// being handed an identity nothing verified.
	it.each([
		['the pull request read fails', undefined],
		['the head branch encodes no task', 'hotfix/manual'],
	] as [
		string,
		string | undefined,
	][])('hands the settle no own task when %s', async (_label, headBranch) => {
		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' }),
			getPullRequest: headBranch
				? prOnBranch(headBranch)
				: vi.fn(async () => {
						throw new Error('provider unreachable');
					}),
		});

		expect(await lastResolveOwnTaskId()()).toBeUndefined();
	});

	// The merge has happened and cannot be undone by a board error.
	it('still reports the merge when the settle throws', async () => {
		settleAbsorbedChildren.mockRejectedValue(new Error('board unreachable'));

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' }),
			getPullRequest: prOnBranch(`${project.branchPrefix}12`),
		});

		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'merged',
			prNumber: '17',
		});
	});
});

/**
 * Issue #1079: a terminal refusal explained *only* by the pull request's head
 * having moved since the review stamps that approval's ledger slot superseded,
 * so the pass stops spending one of `REVIEW_VERDICT_CAP`'s three slots. The
 * question is answered by one provider-neutral `getPullRequest` read rather than
 * a structured refusal reason — these cases pin which refusals ask it, what key
 * they write, and that every failure degrades to the old behaviour.
 */
describe('processMergeAutomationDispatch: superseded approvals', () => {
	/** A pull-request read reporting `headSha` as the branch's current head. */
	function prAtHead(headSha: string) {
		return vi.fn(
			async () => ({ number: 17, headBranch: 'issue-12', headSha }) as PullRequestDetails,
		);
	}

	it('stamps the slot when a terminal not-eligible is explained by a moved head', async () => {
		const getPullRequest = prAtHead('pushed-head');

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'not-eligible', message: 'head moved' }),
			getPullRequest,
		});

		expect(getPullRequest).toHaveBeenCalledExactlyOnceWith(project, 17, 'implementer');
		expect(markReviewVerdictSuperseded).toHaveBeenCalledExactlyOnceWith({
			projectId: project.id,
			repository: project.repo,
			prNumber: '17',
			headSha: 'deadbeef',
		});
		// The run row is stamped beside the ledger (issue #1080), keyed on the Review run.
		expect(markReviewRunSuperseded).toHaveBeenCalledExactlyOnceWith('run-1');
		// The settle itself is untouched — the stamp is bookkeeping beside it.
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(outcome.result).toBe('not-eligible');
	});

	// `not-eligible`'s other causes — drafted, closed, the approval dismissed —
	// all leave the head where it was, and that approval keeps its slot.
	it('leaves the slot alone when the head is unchanged', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'not-eligible', message: 'review dismissed' }),
			getPullRequest: prAtHead('deadbeef'),
		});

		expect(markReviewVerdictSuperseded).not.toHaveBeenCalled();
		expect(markReviewRunSuperseded).not.toHaveBeenCalled();
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(outcome.result).toBe('not-eligible');
	});

	it('stamps the slot when the head moves while the branch is being updated', async () => {
		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({
				status: 'head-moved',
				message: 'The head of #17 is pushed-head, which GitHub did not produce',
			}),
			getPullRequest: prAtHead('pushed-head'),
			commentOnPullRequest: vi.fn(async (_p: unknown, _n: number, _b: string) => 1),
		});

		expect(markReviewVerdictSuperseded).toHaveBeenCalledExactlyOnceWith({
			projectId: project.id,
			repository: project.repo,
			prNumber: '17',
			headSha: 'deadbeef',
		});
		expect(markReviewRunSuperseded).toHaveBeenCalledExactlyOnceWith('run-1');
		expect(outcome.result).toBe('not-eligible');
	});

	// The red merged tree is a genuine failure of the reviewed diff against the
	// current base, not a supersession: freeing the slot would buy re-reviews of a
	// combination that is actually broken.
	it('never stamps the slot for a red updated head', async () => {
		const advanced: MergeAutomationJob = {
			...job,
			approvedHeadSha: 'merged-with-base',
			baseUpdates: 1,
		};

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), advanced, project, {
			mergePullRequest: mergeReturning({ status: 'merged', message: 'merged' }),
			getAggregateCheckStatus: checksConcluding('failure'),
			getPullRequest: prAtHead('pushed-head'),
			commentOnPullRequest: vi.fn(async (_p: unknown, _n: number, _b: string) => 1),
		});

		expect(markReviewVerdictSuperseded).not.toHaveBeenCalled();
		expect(markReviewRunSuperseded).not.toHaveBeenCalled();
		expect(outcome.result).toBe('not-eligible');
	});

	// A conflicting update means the base does not merge into the head, not that
	// the head moved.
	it('never stamps the slot for a conflicting update', async () => {
		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({ status: 'conflict', message: 'conflict' }),
			getPullRequest: prAtHead('pushed-head'),
			commentOnPullRequest: vi.fn(async (_p: unknown, _n: number, _b: string) => 1),
		});

		expect(markReviewVerdictSuperseded).not.toHaveBeenCalled();
		expect(markReviewRunSuperseded).not.toHaveBeenCalled();
	});

	it.each([
		['merged', { status: 'merged', message: 'merged', sha: 'abc' }],
		['policy-blocked', { status: 'policy-blocked', message: 'branch protection' }],
		['unsupported', { status: 'unsupported', message: 'merge queue required' }],
		['not-ready', { status: 'not-ready', message: 'checks pending' }],
	] as [string, MergePullRequestOutcome][])('never stamps the slot on %s', async (_label, o) => {
		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning(o),
			getPullRequest: prAtHead('pushed-head'),
		});

		expect(markReviewVerdictSuperseded).not.toHaveBeenCalled();
		expect(markReviewRunSuperseded).not.toHaveBeenCalled();
	});

	// The ledger slot stays where the review was, so a dispatch that advanced its
	// `approvedHeadSha` onto a base update (issue #874) must not key the stamp on
	// the head it produced.
	it('keys the stamp on the reviewed head, not an advanced approved head', async () => {
		const advanced: MergeAutomationJob = {
			...job,
			approvedHeadSha: 'merged-with-base',
			baseUpdates: 1,
		};

		await processMergeAutomationDispatch(mockDispatchRow(), advanced, project, {
			mergePullRequest: mergeReturning({ status: 'not-eligible', message: 'head moved' }),
			getAggregateCheckStatus: checksConcluding('success'),
			getPullRequest: prAtHead('pushed-head'),
		});

		expect(markReviewVerdictSuperseded).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ headSha: 'deadbeef' }),
		);
	});

	// A payload written before `reviewedHeadSha` existed never advanced, so the
	// approved head *is* the reviewed one.
	it('falls back to the approved head on a payload that predates reviewedHeadSha', async () => {
		const legacy = { ...job, reviewedHeadSha: undefined };

		await processMergeAutomationDispatch(mockDispatchRow(), legacy, project, {
			mergePullRequest: mergeReturning({ status: 'not-eligible', message: 'head moved' }),
			getPullRequest: prAtHead('pushed-head'),
		});

		expect(markReviewVerdictSuperseded).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ headSha: 'deadbeef' }),
		);
	});

	// Best-effort by design: every failure degrades to today's behaviour — the
	// slot keeps counting and the pull request needs Force re-review — never to a
	// settle that reports something other than what happened.
	it.each([
		[
			'the provider read throws',
			{
				getPullRequest: vi.fn(async () => {
					throw new Error('provider unreachable');
				}),
			},
		],
		['the ledger write throws', {}],
		['the run-row write throws', {}],
	])('settles identically when %s', async (label, capabilities) => {
		if (label === 'the ledger write throws') {
			markReviewVerdictSuperseded.mockRejectedValue(new Error('db down'));
		}
		if (label === 'the run-row write throws') {
			markReviewRunSuperseded.mockRejectedValue(new Error('db down'));
		}

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'not-eligible', message: 'head moved' }),
			getPullRequest: prAtHead('pushed-head'),
			...capabilities,
		});

		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'not-eligible',
			prNumber: '17',
		});
	});

	// A key no slot exists for is reported rather than assumed to have landed.
	it('warns rather than assuming the stamp landed when no slot matched', async () => {
		markReviewVerdictSuperseded.mockResolvedValue(false);

		const outcome = await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'not-eligible', message: 'head moved' }),
			getPullRequest: prAtHead('pushed-head'),
		});

		expect(outcome.result).toBe('not-eligible');
	});

	// A retry after a crash between the two writes finds the ledger already stamped;
	// the run row must still be reached, or the dashboard never shows the stamp.
	it('still stamps the run row when the ledger slot was already stamped', async () => {
		markReviewVerdictSuperseded.mockResolvedValue(false);

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'not-eligible', message: 'head moved' }),
			getPullRequest: prAtHead('pushed-head'),
		});

		expect(markReviewRunSuperseded).toHaveBeenCalledExactlyOnceWith('run-1');
	});

	// The ledger is the decision; the run row only mirrors it, so a ledger failure
	// never leaves a run claiming a supersession the cap arithmetic does not know.
	it('does not stamp the run row when the ledger write fails', async () => {
		markReviewVerdictSuperseded.mockRejectedValue(new Error('db down'));

		await processMergeAutomationDispatch(mockDispatchRow(), job, project, {
			mergePullRequest: mergeReturning({ status: 'not-eligible', message: 'head moved' }),
			getPullRequest: prAtHead('pushed-head'),
		});

		expect(markReviewRunSuperseded).not.toHaveBeenCalled();
	});
});

describe('processMergeAutomationDispatch: the merge queue (issue #1114)', () => {
	const ownRow = (overrides: Partial<DispatchRow> = {}) =>
		mockDispatchRow({
			leaseExpiresAt: new Date(Date.now() + 15 * 60_000),
			jobPayload: job,
			...overrides,
		});

	/** An earlier merge dispatch for the same repository, for pull request #11. */
	function holderRow(
		overrides: Partial<DispatchRow> = {},
		payload: Partial<MergeAutomationJob> = {},
	) {
		return mockDispatchRow({
			id: 'dispatch-0',
			state: 'retry-scheduled',
			createdAt: new Date(Date.now() - 10 * 60_000),
			updatedAt: new Date(Date.now() - 3 * 60_000),
			jobPayload: { ...job, reviewRunId: 'run-0', prNumber: '11', ...payload },
			...overrides,
		});
	}

	function queueOf(...rows: DispatchRow[]) {
		listActiveMergeDispatchesForRepository.mockResolvedValue(rows);
	}

	it('merges as before when it is alone on the queue, then wakes the next waiter', async () => {
		const own = ownRow();
		queueOf(own);
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' });

		const outcome = await processMergeAutomationDispatch(own, job, project, { mergePullRequest });

		expect(listActiveMergeDispatchesForRepository).toHaveBeenCalledExactlyOnceWith(
			project.id,
			job.repo,
		);
		expect(mergePullRequest).toHaveBeenCalledTimes(1);
		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merged');
		expect(promoteMergeQueueWaits).toHaveBeenCalledExactlyOnceWith(project.id, job.repo);
		expect(completeDispatch.mock.invocationCallOrder[0]).toBeLessThan(
			promoteMergeQueueWaits.mock.invocationCallOrder[0] as number,
		);
		expect(outcome.result).toBe('merged');
	});

	it('defers behind an earlier holder without spending its budget or calling the provider', async () => {
		const own = ownRow({ attempt: 2 });
		queueOf(holderRow(), own);
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' });
		const before = Date.now();

		const outcome = await processMergeAutomationDispatch(own, job, project, { mergePullRequest });

		expect(mergePullRequest).not.toHaveBeenCalled();
		const input = lastRetryInput() as ReturnType<typeof lastRetryInput> & { lastError: string };
		expect(input.waitReason).toBe('merge-queue');
		// Untouched: waiting for a turn is not a not-ready attempt.
		expect(input.attempt).toBe(2);
		expect(input.jobPayload).toEqual(job);
		const delay = input.availableAt.getTime() - before;
		expect(delay).toBeGreaterThanOrEqual(MERGE_QUEUE_RECHECK_MS - 1000);
		expect(delay).toBeLessThanOrEqual(MERGE_QUEUE_RECHECK_MS + 1000);
		expect(input.lastError).toContain(`merge queue of ${job.repo} (${project.baseBranch})`);
		expect(input.lastError).toContain('1 pull request ahead, next #11 (dispatch dispatch-0');
		expect(publishDispatchWakeUp).toHaveBeenCalledTimes(1);
		expect(updateReviewMergeOutcome).toHaveBeenCalledExactlyOnceWith('run-1', {
			status: MERGE_QUEUED,
			message: input.lastError,
			attempt: 2,
			approvedHeadSha: 'deadbeef',
		});
		expect(completeDispatch).not.toHaveBeenCalled();
		expect(promoteMergeQueueWaits).not.toHaveBeenCalled();
		expect(outcome).toEqual({
			status: 'merge-automation-settled',
			result: 'retry-scheduled',
			prNumber: '17',
		});
	});

	it('counts every live dispatch ahead of it, not only the holder', async () => {
		const own = ownRow();
		queueOf(holderRow(), holderRow({ id: 'dispatch-0b', state: 'pending' }), own);

		await processMergeAutomationDispatch(own, job, project, {
			mergePullRequest: mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' }),
		});

		expect((lastRetryInput() as unknown as { lastError: string }).lastError).toContain(
			'2 pull requests ahead, next #11',
		);
	});

	it('bypasses a holder whose lease has lapsed — a dead holder does not keep the queue', async () => {
		const own = ownRow();
		queueOf(holderRow({ state: 'leased', leaseExpiresAt: new Date(Date.now() - 1000) }), own);
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' });

		const outcome = await processMergeAutomationDispatch(own, job, project, { mergePullRequest });

		expect(mergePullRequest).toHaveBeenCalledTimes(1);
		expect(outcome.result).toBe('merged');
	});

	it('honours a holder whose lease is still live', async () => {
		const own = ownRow();
		queueOf(holderRow({ state: 'running', leaseExpiresAt: new Date(Date.now() + 60_000) }), own);
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' });

		const outcome = await processMergeAutomationDispatch(own, job, project, { mergePullRequest });

		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(lastRetryInput().waitReason).toBe('merge-queue');
		expect(outcome.result).toBe('retry-scheduled');
	});

	it('ignores dispatches that arrived after it', async () => {
		const own = ownRow();
		queueOf(own, holderRow({ id: 'dispatch-2', state: 'retry-scheduled' }));
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' });

		await processMergeAutomationDispatch(own, job, project, { mergePullRequest });

		expect(mergePullRequest).toHaveBeenCalledTimes(1);
	});

	it('stamps the start of its turn into the payload its retries persist, once', async () => {
		const own = ownRow();
		queueOf(own);
		const before = Date.now();

		await processMergeAutomationDispatch(own, job, project, {
			mergePullRequest: mergeReturning({ status: 'not-ready', message: 'pending' }),
		});

		const stamped = lastRetryInput().jobPayload.queueTurnStartedAt;
		expect(stamped).toBeDefined();
		expect(Date.parse(stamped as string)).toBeGreaterThanOrEqual(before - 1000);

		const later = { ...job, queueTurnStartedAt: '2026-01-01T00:00:00.000Z' };
		await processMergeAutomationDispatch(
			ownRow({ attempt: 1, jobPayload: later }),
			later,
			project,
			{
				mergePullRequest: mergeReturning({ status: 'not-ready', message: 'pending' }),
			},
		);
		expect(lastRetryInput().jobPayload.queueTurnStartedAt).toBe('2026-01-01T00:00:00.000Z');
	});

	it('reports how long the holder has held the queue from its own stamp', async () => {
		const own = ownRow();
		queueOf(
			holderRow(
				{},
				{ queueTurnStartedAt: new Date(Date.now() - (4 * 60_000 + 7_000)).toISOString() },
			),
			own,
		);

		await processMergeAutomationDispatch(own, job, project, {
			mergePullRequest: mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' }),
		});

		expect((lastRetryInput() as unknown as { lastError: string }).lastError).toContain(
			'which has held the queue for 4m07s',
		);
	});

	it('falls back to when the holder last changed state before its stamp is persisted', async () => {
		const own = ownRow();
		queueOf(holderRow({ updatedAt: new Date(Date.now() - 3 * 60_000) }), own);

		await processMergeAutomationDispatch(own, job, project, {
			mergePullRequest: mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' }),
		});

		expect((lastRetryInput() as unknown as { lastError: string }).lastError).toContain(
			'which has held the queue for 3m00s',
		);
	});

	it.each<[string, MergePullRequestOutcome, number]>([
		['merged', { status: 'merged', message: 'merged', sha: 'abc' }, 0],
		['not-eligible', { status: 'not-eligible', message: 'closed' }, 0],
		['policy-blocked', { status: 'policy-blocked', message: 'protected' }, 0],
		['unsupported', { status: 'unsupported', message: 'merge queue required' }, 0],
		['a spent not-ready budget', { status: 'not-ready', message: 'pending' }, MAX_MERGE_RETRIES],
	])('releases the queue on a terminal ending: %s', async (_label, mergeOutcome, attempt) => {
		const own = ownRow({ attempt });
		queueOf(own);

		await processMergeAutomationDispatch(own, job, project, {
			mergePullRequest: mergeReturning(mergeOutcome),
			getPullRequest: vi.fn(
				async () =>
					({ number: 17, headBranch: 'issue-12', headSha: 'deadbeef' }) as PullRequestDetails,
			),
		});

		expect(completeDispatch).toHaveBeenCalledTimes(1);
		expect(promoteMergeQueueWaits).toHaveBeenCalledExactlyOnceWith(project.id, job.repo);
	});

	it('releases the queue when a stale head cannot be updated', async () => {
		const own = ownRow();
		queueOf(own);

		await processMergeAutomationDispatch(own, job, project, {
			mergePullRequest: mergeReturning(STALE_BASE),
			updatePullRequestBranch: updateReturning({ status: 'conflict', message: 'conflicts' }),
			commentOnPullRequest: vi.fn(async () => 1),
		});

		expect(completeDispatch).toHaveBeenCalledExactlyOnceWith('dispatch-1', 'merge-not-eligible');
		expect(promoteMergeQueueWaits).toHaveBeenCalledExactlyOnceWith(project.id, job.repo);
	});

	it('keeps the queue across its own retries — a scheduled retry releases nothing', async () => {
		const own = ownRow();
		queueOf(own);

		await processMergeAutomationDispatch(own, job, project, {
			mergePullRequest: mergeReturning({ status: 'not-ready', message: 'pending' }),
		});

		expect(lastRetryInput().waitReason).toBe('recheck');
		expect(promoteMergeQueueWaits).not.toHaveBeenCalled();
	});

	it('fails open when the queue cannot be read', async () => {
		listActiveMergeDispatchesForRepository.mockRejectedValue(new Error('db down'));
		const mergePullRequest = mergeReturning({ status: 'merged', message: 'merged', sha: 'abc' });

		const outcome = await processMergeAutomationDispatch(ownRow(), job, project, {
			mergePullRequest,
		});

		expect(mergePullRequest).toHaveBeenCalledTimes(1);
		expect(outcome.result).toBe('merged');
	});
});
