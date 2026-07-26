import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/runsRepository.js', () => ({
	getRunByIdFromDb: vi.fn(),
	clearRunRecovery: vi.fn(),
	hasLiveRunForTask: vi.fn(),
}));

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	getProjectByIdFromDb: vi.fn(),
}));

vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	getActiveDispatchByRunId: vi.fn(),
	cancelClaimedDispatch: vi.fn(),
}));

vi.mock('@/dispatch/dispatcher.js', () => ({
	cancelDispatchAndWake: vi.fn(),
	createAndPublishDispatch: vi.fn(),
	wakeJobId: (dispatch: { id: string; wakeSeq: number }) =>
		`dispatch_${dispatch.id}_w${dispatch.wakeSeq}`,
}));

vi.mock('@/queue/cancellation.js', () => ({
	clearRunCancellation: vi.fn(),
}));

vi.mock('@/queue/producer.js', () => ({
	priorityFor: (job: { type: string }) => (job.type === 'github-projects' ? 10 : undefined),
	removePendingJobById: vi.fn().mockResolvedValue(true),
}));

// The GitWorktreeManager constructor only stores config, but its methods touch
// git/Redis — the settlement decision is mocked at its own boundary instead.
vi.mock('@/worktree/termination-cleanup.js', () => ({
	reconcileTerminatedWorktree: vi.fn(),
}));

import {
	cancelClaimedDispatch,
	type DispatchRow,
	getActiveDispatchByRunId,
} from '@/db/repositories/dispatchesRepository.js';
import { getProjectByIdFromDb } from '@/db/repositories/projectsRepository.js';
import {
	clearRunRecovery,
	getRunByIdFromDb,
	hasLiveRunForTask,
} from '@/db/repositories/runsRepository.js';
import type { runs } from '@/db/schema/runs.js';
import { cancelDispatchAndWake, createAndPublishDispatch } from '@/dispatch/dispatcher.js';
import { RunResetError, resetRun } from '@/dispatch/run-reset.js';
import { clearRunCancellation } from '@/queue/cancellation.js';
import type { SwarmJob } from '@/queue/jobs.js';
import { removePendingJobById } from '@/queue/producer.js';
import { reconcileTerminatedWorktree } from '@/worktree/termination-cleanup.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

type RunRow = typeof runs.$inferSelect;

const JOB_PAYLOAD: SwarmJob = {
	type: 'scm',
	providerId: 'github',
	projectId: 'p1',
	event: {
		kind: 'pull-request',
		repoFullName: 'jkwiecien/swarm',
		isCommentEvent: false,
	},
};

// Only these tests need a run row; the runs-router suite keeps its own builder
// for the same reason (no shared `createMockRun` factory exists).
function makeRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: 'run-1',
		projectId: 'p1',
		taskId: '424',
		workItemId: null,
		workItemTitle: null,
		workItemUrl: null,
		prNumber: null,
		prTitle: null,
		producedPrUrl: null,
		phase: 'implementation',
		workerId: null,
		workerUserId: null,
		workerFencingToken: null,
		engine: null,
		model: null,
		reasoning: null,
		status: 'failed',
		reviewVerdict: null,
		reviewOrdinal: null,
		reviewAutomationOutcome: null,
		reviewMergeOutcome: null,
		reviewMergeMessage: null,
		reviewMergeAttempt: null,
		reviewMergeApprovedHeadSha: null,
		exitCode: 1,
		timedOut: false,
		error: 'wedged',
		startedAt: new Date('2026-07-10T00:00:00Z'),
		completedAt: new Date('2026-07-10T00:01:00Z'),
		nextRetryAt: null,
		durationMs: 60000,
		timeoutMs: null,
		usage: null,
		delegations: null,
		jobPayload: JOB_PAYLOAD,
		planningScope: null,
		failureDiagnosis: null,
		agentSessionId: 'stale-session',
		recovery: { state: 'blocked', blockedReason: 'live-leased' },
		cancellation: null,
		outputBytes: 0,
		outputTruncated: false,
		...overrides,
	};
}

function makeDispatch(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return {
		id: 'dispatch-1',
		projectId: 'p1',
		taskId: '424',
		phase: 'implementation',
		state: 'retry-scheduled',
		waitReason: 'rate-limit',
		outcome: null,
		dedupKey: null,
		coalesceKey: null,
		continuation: false,
		priority: 0,
		attempt: 1,
		wakeSeq: 3,
		availableAt: new Date('2026-07-10T00:30:00Z'),
		jobPayload: JOB_PAYLOAD,
		runId: 'run-1',
		selectedWorkerId: null,
		workerSessionId: null,
		workerFencingToken: null,
		leaseOwner: null,
		leaseExpiresAt: null,
		lastError: null,
		source: 'webhook',
		createdAt: new Date('2026-07-10T00:00:00Z'),
		updatedAt: new Date('2026-07-10T00:00:00Z'),
		completedAt: null,
		...overrides,
	};
}

describe('resetRun', () => {
	beforeEach(() => {
		vi.mocked(getRunByIdFromDb).mockReset().mockResolvedValue(makeRun());
		vi.mocked(getProjectByIdFromDb)
			.mockReset()
			.mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
		vi.mocked(getActiveDispatchByRunId).mockReset().mockResolvedValue(undefined);
		vi.mocked(cancelDispatchAndWake).mockReset().mockResolvedValue(makeDispatch());
		vi.mocked(cancelClaimedDispatch).mockReset().mockResolvedValue(true);
		vi.mocked(clearRunCancellation).mockReset().mockResolvedValue(undefined);
		vi.mocked(clearRunRecovery).mockReset().mockResolvedValue(undefined);
		vi.mocked(hasLiveRunForTask).mockReset().mockResolvedValue(false);
		vi.mocked(removePendingJobById).mockClear();
		vi.mocked(reconcileTerminatedWorktree).mockReset().mockResolvedValue({ outcome: 'removed' });
		vi.mocked(createAndPublishDispatch)
			.mockReset()
			.mockResolvedValue({ dispatch: makeDispatch({ id: 'dispatch-2' }), created: true });
	});

	it('cancels, clears, tears down, and re-dispatches a wedged failed run', async () => {
		vi.mocked(getActiveDispatchByRunId).mockResolvedValue(makeDispatch());

		const result = await resetRun('run-1');

		expect(cancelDispatchAndWake).toHaveBeenCalledWith(
			'dispatch-1',
			expect.stringContaining('run-1'),
		);
		expect(clearRunCancellation).toHaveBeenCalledWith('run-1');
		expect(reconcileTerminatedWorktree).toHaveBeenCalledWith(
			expect.anything(),
			'p1',
			'424',
			null,
			false,
			expect.objectContaining({ discardProtectedWork: false }),
		);
		expect(clearRunRecovery).toHaveBeenCalledWith('run-1');
		expect(createAndPublishDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: 'p1',
				source: 'manual',
				waitReason: 'manual-retry',
				runId: 'run-1',
				taskId: '424',
				phase: 'implementation',
			}),
		);
		expect(result).toEqual({
			runId: 'run-1',
			forced: false,
			dispatch: 'cancelled',
			cancellationCleared: true,
			worktree: { outcome: 'removed' },
			recoveryCleared: true,
			dispatchId: 'dispatch-2',
		});
	});

	it('re-dispatches with a fresh agent session and a reset rate-limit budget', async () => {
		await resetRun('run-1');

		const { jobPayload } = vi.mocked(createAndPublishDispatch).mock.calls[0][0];
		expect(jobPayload.rateLimitRetryAttempt).toBe(0);
		expect(jobPayload.runId).toBe('run-1');
		expect(jobPayload.agentSessionId).toEqual(expect.any(String));
		expect(jobPayload.agentSessionId).not.toBe('stale-session');
		expect(jobPayload.resumeSession).toBeUndefined();
	});

	it('reports an idempotent no-op reset when nothing is left to tear down', async () => {
		vi.mocked(reconcileTerminatedWorktree).mockResolvedValue({ outcome: 'absent' });

		await expect(resetRun('run-1')).resolves.toMatchObject({
			dispatch: 'none',
			worktree: { outcome: 'absent' },
		});
	});

	it('refuses an unknown run before touching anything', async () => {
		vi.mocked(getRunByIdFromDb).mockResolvedValue(undefined);

		await expect(resetRun('missing')).rejects.toThrowError(
			expect.objectContaining({ reason: 'run-not-found' }),
		);
		expect(cancelDispatchAndWake).not.toHaveBeenCalled();
		expect(clearRunCancellation).not.toHaveBeenCalled();
	});

	it('refuses a run whose project no longer exists', async () => {
		vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

		await expect(resetRun('run-1')).rejects.toThrowError(
			expect.objectContaining({ reason: 'project-not-found' }),
		);
		expect(reconcileTerminatedWorktree).not.toHaveBeenCalled();
	});

	it('refuses a running run without force and mutates nothing', async () => {
		vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ status: 'running' }));

		await expect(resetRun('run-1')).rejects.toThrowError(
			expect.objectContaining({ reason: 'running-not-forced' }),
		);
		expect(cancelDispatchAndWake).not.toHaveBeenCalled();
		expect(clearRunCancellation).not.toHaveBeenCalled();
		expect(reconcileTerminatedWorktree).not.toHaveBeenCalled();
		expect(clearRunRecovery).not.toHaveBeenCalled();
		expect(createAndPublishDispatch).not.toHaveBeenCalled();
	});

	it('resets a running run when forced', async () => {
		vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ status: 'running' }));

		await expect(resetRun('run-1', { force: true })).resolves.toMatchObject({ forced: true });
		expect(createAndPublishDispatch).toHaveBeenCalled();
	});

	it('refuses a run with no stored job payload before cancelling anything', async () => {
		vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ jobPayload: null }));

		await expect(resetRun('run-1')).rejects.toThrowError(
			expect.objectContaining({ reason: 'missing-job-payload' }),
		);
		expect(cancelDispatchAndWake).not.toHaveBeenCalled();
	});

	it('aborts when the dispatch was claimed between the read and the cancel', async () => {
		vi.mocked(getActiveDispatchByRunId).mockResolvedValue(makeDispatch());
		vi.mocked(cancelDispatchAndWake).mockResolvedValue(null);

		await expect(resetRun('run-1')).rejects.toThrowError(
			expect.objectContaining({ reason: 'dispatch-claimed' }),
		);
		expect(cancelClaimedDispatch).not.toHaveBeenCalled();
		expect(clearRunCancellation).not.toHaveBeenCalled();
	});

	it('cancels a claimed dispatch and removes its wake-up when forced', async () => {
		vi.mocked(getActiveDispatchByRunId).mockResolvedValue(makeDispatch());
		vi.mocked(cancelDispatchAndWake).mockResolvedValue(null);

		await expect(resetRun('run-1', { force: true })).resolves.toMatchObject({
			dispatch: 'force-cancelled-claimed',
		});
		expect(cancelClaimedDispatch).toHaveBeenCalledWith('dispatch-1', expect.any(String));
		expect(removePendingJobById).toHaveBeenCalledWith('dispatch_dispatch-1_w3');
	});

	it('threads the discard-protected-work flag into the teardown when forced', async () => {
		await resetRun('run-1', { force: true });

		expect(reconcileTerminatedWorktree).toHaveBeenCalledWith(
			expect.anything(),
			'p1',
			'424',
			null,
			false,
			expect.objectContaining({ discardProtectedWork: true }),
		);
	});

	it('asks whether a *different* run owns the lease, excluding the run being reset', async () => {
		await resetRun('run-1');

		const options = vi.mocked(reconcileTerminatedWorktree).mock.calls[0][5];
		await expect(options?.hasLiveOwner?.('p1', '424')).resolves.toBe(false);
		expect(hasLiveRunForTask).toHaveBeenCalledWith('p1', '424', 'run-1');
	});

	it('fails closed when the live-owner lookup errors', async () => {
		vi.mocked(hasLiveRunForTask).mockRejectedValue(new Error('db down'));

		await resetRun('run-1');

		const options = vi.mocked(reconcileTerminatedWorktree).mock.calls[0][5];
		await expect(options?.hasLiveOwner?.('p1', '424')).resolves.toBe(true);
	});

	it('reports a blocked teardown and still re-dispatches the run', async () => {
		vi.mocked(reconcileTerminatedWorktree).mockResolvedValue({
			outcome: 'blocked',
			blockedReason: 'live-leased',
		});

		await expect(resetRun('run-1')).resolves.toMatchObject({
			worktree: { outcome: 'blocked', blockedReason: 'live-leased' },
		});
		expect(clearRunRecovery).toHaveBeenCalledWith('run-1');
		expect(createAndPublishDispatch).toHaveBeenCalled();
	});

	it('stops without re-dispatching when the teardown throws', async () => {
		vi.mocked(reconcileTerminatedWorktree).mockRejectedValue(new Error('git exploded'));

		await expect(resetRun('run-1')).rejects.toThrowError(
			expect.objectContaining({ reason: 'worktree-teardown-failed' }),
		);
		expect(clearRunRecovery).not.toHaveBeenCalled();
		expect(createAndPublishDispatch).not.toHaveBeenCalled();
	});

	it('reports a concurrent reset that already created the run’s dispatch', async () => {
		vi.mocked(createAndPublishDispatch).mockRejectedValue(
			new Error('duplicate key value violates unique constraint "uq_dispatches_active_run"'),
		);

		await expect(resetRun('run-1')).rejects.toThrowError(
			expect.objectContaining({ reason: 'already-resetting' }),
		);
	});

	it('propagates an unrelated dispatch-creation failure as-is', async () => {
		vi.mocked(createAndPublishDispatch).mockRejectedValue(new Error('redis unavailable'));

		const error = await resetRun('run-1').catch((err: unknown) => err);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(RunResetError);
	});
});
