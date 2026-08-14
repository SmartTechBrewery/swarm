import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/runsRepository.js', () => ({
	getRunByIdFromDb: vi.fn(),
	clearRunRecovery: vi.fn(),
	failRunFromStatus: vi.fn(),
	hasLiveRunForTask: vi.fn(),
	updateRunJobPayload: vi.fn(),
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
	failRunFromStatus,
	getRunByIdFromDb,
	hasLiveRunForTask,
	updateRunJobPayload,
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
		repoFullName: 'SmartTechBrewery/swarm',
		isCommentEvent: false,
	},
};

// Only these tests need a run row; the runs-router suite keeps its own builder
// for the same reason (no shared `createMockRun` factory exists).
function makeRun(overrides: Partial<RunRow> = {}): RunRow {
	return {
		id: 'run-1',
		projectId: 'p1',
		repository: 'SmartTechBrewery/swarm',
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
		checkpoint: null,
		continuationCount: 0,
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
		vi.mocked(failRunFromStatus).mockReset().mockResolvedValue(true);
		vi.mocked(hasLiveRunForTask).mockReset().mockResolvedValue(false);
		vi.mocked(updateRunJobPayload).mockReset().mockResolvedValue(undefined);
		vi.mocked(removePendingJobById).mockClear();
		vi.mocked(reconcileTerminatedWorktree).mockReset().mockResolvedValue({ outcome: 'removed' });
		vi.mocked(createAndPublishDispatch)
			.mockReset()
			.mockResolvedValue({ dispatch: makeDispatch({ id: 'dispatch-2' }), created: true });
	});

	it('cancels, clears, discards, and re-dispatches a wedged failed run', async () => {
		vi.mocked(getActiveDispatchByRunId).mockResolvedValue(makeDispatch());

		const result = await resetRun('run-1');

		expect(cancelDispatchAndWake).toHaveBeenCalledWith(
			'dispatch-1',
			expect.stringContaining('run-1'),
		);
		expect(clearRunCancellation).toHaveBeenCalledWith('run-1');
		// Issue #744: the discard is unconditional — there is no opt-in left to pass.
		expect(reconcileTerminatedWorktree).toHaveBeenCalledWith(
			expect.anything(),
			'p1',
			'424',
			null,
			false,
			expect.objectContaining({ discardProtectedWork: true }),
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
			outcome: 'restarted',
			runId: 'run-1',
			dispatch: 'cancelled',
			cancellationCleared: true,
			worktree: { outcome: 'removed' },
			worktreeError: null,
			recoveryCleared: true,
			abandonedPreservedWorkerId: null,
			dispatchId: 'dispatch-2',
		});
	});

	// Issue #567: reset is the *only* thing that ends a pinned wait, and it is the
	// operator's deliberate "give up that machine's work" — so it reports which
	// machine's work went, and it never asks that machine to participate.
	it('reports the machine whose preserved work it abandoned', async () => {
		vi.mocked(getRunByIdFromDb).mockResolvedValue(
			makeRun({ recovery: { preservedWorkerId: 'w-preserved' } }),
		);

		const result = await resetRun('run-1');

		expect(result.abandonedPreservedWorkerId).toBe('w-preserved');
		expect(clearRunRecovery).toHaveBeenCalledWith('run-1');
	});

	it('works while the pinned machine is unreachable, since nothing asks it anything', async () => {
		// The escape hatch has to work exactly when the machine is offline — otherwise
		// a run pinned to a dead host would wait forever with no way out.
		vi.mocked(getRunByIdFromDb).mockResolvedValue(
			makeRun({ recovery: { preservedWorkerId: 'w-offline' } }),
		);
		vi.mocked(reconcileTerminatedWorktree).mockResolvedValue({ outcome: 'absent' });

		const result = await resetRun('run-1');

		expect(result.abandonedPreservedWorkerId).toBe('w-offline');
		expect(result).toMatchObject({ outcome: 'restarted', dispatchId: 'dispatch-2' });
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

	// Issue #741 — the reported failure, end to end. Reset was built by the *manual retry*
	// payload builder, which inherits recovery intent on purpose, so run 2d3df9b3's stored
	// `implementationBranchProvisioned: true` survived every reset and each restart
	// re-provisioned with `createBranch: false` against a branch that no longer existed
	// (`fatal: invalid reference: issue-719`), while a fresh dispatch of the same task ran fine.
	describe('the replacement dispatch carries no resumption state', () => {
		const STORED_SESSION = '92340ec7-709e-4ffa-9297-3899caca4830';

		/** The reported run: a stored payload holding every resume latch at once. */
		const latchedRun = () =>
			makeRun({
				jobPayload: {
					...JOB_PAYLOAD,
					agentSessionId: STORED_SESSION,
					resumeSession: true,
					resumeDelivery: true,
					implementationBranchProvisioned: true,
					recoveryMode: 'resume',
				},
			});

		// The reset keeps the mode it chose itself — the only way the checkout is reached
		// when it lives on another worker (issue #592) — while dropping the stored one.
		it('provisions as a first attempt would, carrying only its own discard intent', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(latchedRun());

			await resetRun('run-1');

			const { jobPayload } = vi.mocked(createAndPublishDispatch).mock.calls[0][0];
			expect(jobPayload.recoveryMode).toBe('discard');
			expect(jobPayload.implementationBranchProvisioned).toBeUndefined();
			expect(jobPayload.resumeSession).toBeUndefined();
			expect(jobPayload.resumeDelivery).toBeUndefined();
			expect(jobPayload.agentSessionId).not.toBe(STORED_SESSION);
			expect(jobPayload.agentSessionId).toEqual(expect.any(String));
		});

		// The row's own `job_payload` keeps the latch until a worker claims the restart, and
		// it is what a *second* reset and `runs.retryNow`'s reconstruct-from-row path read —
		// so leaving it poisoned would let the wedged state outlive its own fix.
		it('sanitises the run row’s stored payload before creating the dispatch', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(latchedRun());

			await resetRun('run-1');

			const [runId, persisted] = vi.mocked(updateRunJobPayload).mock.calls[0];
			expect(runId).toBe('run-1');
			expect(persisted.implementationBranchProvisioned).toBeUndefined();
			expect(persisted.resumeSession).toBeUndefined();
			expect(persisted.resumeDelivery).toBeUndefined();
			expect(persisted).toEqual(vi.mocked(createAndPublishDispatch).mock.calls[0][0].jobPayload);
			expect(vi.mocked(updateRunJobPayload).mock.invocationCallOrder[0]).toBeLessThan(
				vi.mocked(createAndPublishDispatch).mock.invocationCallOrder[0],
			);
		});

		it('still resets when the row could not be sanitised', async () => {
			vi.mocked(getRunByIdFromDb).mockResolvedValue(latchedRun());
			vi.mocked(updateRunJobPayload).mockRejectedValue(new Error('db down'));

			await expect(resetRun('run-1')).resolves.toMatchObject({
				outcome: 'restarted',
				dispatchId: 'dispatch-2',
			});
			expect(createAndPublishDispatch).toHaveBeenCalled();
		});
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

	// Issue #744 — the two states nothing can be re-dispatched from. Refusing them left
	// the wedged run exactly as it was, which is the thing reset exists to end, so they
	// clear the run's state like any other reset and then settle the row terminally.
	it('settles a run whose project no longer exists instead of refusing it', async () => {
		vi.mocked(getActiveDispatchByRunId).mockResolvedValue(makeDispatch());
		vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

		const result = await resetRun('run-1');

		expect(result).toMatchObject({ outcome: 'terminated', dispatch: 'cancelled' });
		expect(result.outcome === 'terminated' && result.reason).toContain('no longer exists');
		expect(clearRunCancellation).toHaveBeenCalledWith('run-1');
		expect(clearRunRecovery).toHaveBeenCalledWith('run-1');
		// No project means no `GitWorktreeManager` to settle this host's checkout with.
		expect(reconcileTerminatedWorktree).not.toHaveBeenCalled();
		expect(result.worktree).toBeNull();
		expect(failRunFromStatus).toHaveBeenCalledWith('run-1', expect.stringContaining('run-1'));
		expect(createAndPublishDispatch).not.toHaveBeenCalled();
	});

	it('settles a run with no stored job payload instead of refusing it', async () => {
		vi.mocked(getActiveDispatchByRunId).mockResolvedValue(makeDispatch());
		vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ jobPayload: null }));

		const result = await resetRun('run-1');

		expect(result).toMatchObject({ outcome: 'terminated', dispatch: 'cancelled' });
		expect(result.outcome === 'terminated' && result.reason).toContain('without a job payload');
		expect(clearRunCancellation).toHaveBeenCalledWith('run-1');
		expect(clearRunRecovery).toHaveBeenCalledWith('run-1');
		// The checkout is still settled here — only the re-dispatch is impossible.
		expect(reconcileTerminatedWorktree).toHaveBeenCalled();
		expect(failRunFromStatus).toHaveBeenCalledWith('run-1', expect.stringContaining('run-1'));
		expect(createAndPublishDispatch).not.toHaveBeenCalled();
	});

	// issue #684 phase 2 — the checkout a reset tears down belongs to the repository the
	// *run* acted on, whose `baseBranch`/`branchPrefix` are its own, so the worktree
	// manager is built from that entry rather than the project's default one.
	it("reads the project scoped to the run's own repository", async () => {
		vi.mocked(getRunByIdFromDb).mockResolvedValue(
			makeRun({ repository: 'SmartTechBrewery/second' }),
		);

		await resetRun('run-1');

		expect(getProjectByIdFromDb).toHaveBeenCalledWith('p1', 'SmartTechBrewery/second');
	});

	it('propagates an unowned-repository throw instead of resetting against the default entry', async () => {
		vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ repository: 'SmartTechBrewery/gone' }));
		vi.mocked(getProjectByIdFromDb).mockRejectedValue(
			new Error("Project 'p1' does not own repository 'SmartTechBrewery/gone'"),
		);

		await expect(resetRun('run-1')).rejects.toThrow(/does not own repository/);
		expect(cancelDispatchAndWake).not.toHaveBeenCalled();
		expect(reconcileTerminatedWorktree).not.toHaveBeenCalled();
	});

	// Issue #744: a live row is the state operators reach for reset in, and refusing it
	// until Terminate had settled it was the refusal that made reset useless there.
	it('resets a running run without it being terminated first', async () => {
		vi.mocked(getRunByIdFromDb).mockResolvedValue(makeRun({ status: 'running' }));

		await expect(resetRun('run-1')).resolves.toMatchObject({ outcome: 'restarted' });
		expect(reconcileTerminatedWorktree).toHaveBeenCalledWith(
			expect.anything(),
			'p1',
			'424',
			null,
			false,
			expect.objectContaining({ discardProtectedWork: true }),
		);
		expect(createAndPublishDispatch).toHaveBeenCalled();
	});

	it('cancels a dispatch a worker claimed first, with no opt-in, and removes its wake-up', async () => {
		vi.mocked(getActiveDispatchByRunId).mockResolvedValue(makeDispatch());
		vi.mocked(cancelDispatchAndWake).mockResolvedValue(null);

		await expect(resetRun('run-1')).resolves.toMatchObject({ dispatch: 'cancelled-claimed' });
		expect(cancelClaimedDispatch).toHaveBeenCalledWith('dispatch-1', expect.any(String));
		expect(removePendingJobById).toHaveBeenCalledWith('dispatch_dispatch-1_w3');
	});

	// Issue #592: the local teardown only reaches the control-plane host, so the reset
	// also has to tell the worker that actually holds the checkout to destroy it —
	// otherwise the replacement dispatch fails on the same collision.
	it("carries a 'discard' recovery mode to the worker holding the checkout", async () => {
		await resetRun('run-1');

		const { jobPayload } = vi.mocked(createAndPublishDispatch).mock.calls[0][0];
		expect(jobPayload.recoveryMode).toBe('discard');
		expect(jobPayload.resumeSession).toBeUndefined();
	});

	it('delegates the discard even when nothing was on this host to tear down', async () => {
		vi.mocked(reconcileTerminatedWorktree).mockResolvedValue({ outcome: 'absent' });

		await expect(resetRun('run-1')).resolves.toMatchObject({ worktree: { outcome: 'absent' } });
		expect(vi.mocked(createAndPublishDispatch).mock.calls[0][0].jobPayload.recoveryMode).toBe(
			'discard',
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

	// Issue #744: this teardown only reaches the control-plane host, and the checkout the
	// restart has to clear may be on another worker — one that honours the discard intent
	// the replacement dispatch carries. So a local throw is reported and stepped over.
	it('reports a teardown that threw and still re-dispatches the run', async () => {
		vi.mocked(reconcileTerminatedWorktree).mockRejectedValue(new Error('git exploded'));

		const result = await resetRun('run-1');

		expect(result).toMatchObject({ outcome: 'restarted', dispatchId: 'dispatch-2' });
		expect(result.worktree).toBeNull();
		expect(result.worktreeError).toContain('git exploded');
		expect(clearRunRecovery).toHaveBeenCalledWith('run-1');
		expect(createAndPublishDispatch).toHaveBeenCalled();
	});

	// The one refusal a *successful* reset can still produce, and the reason it survives
	// issue #744: the unique index means a reset really is under way, so the answer is
	// idempotency rather than a second dispatch for the same run.
	it('reports a concurrent reset that already created the run’s dispatch', async () => {
		vi.mocked(createAndPublishDispatch).mockRejectedValue(
			new Error('duplicate key value violates unique constraint "uq_dispatches_active_run"'),
		);

		await expect(resetRun('run-1')).rejects.toThrowError(
			expect.objectContaining({ reason: 'already-resetting' }),
		);
		expect(createAndPublishDispatch).toHaveBeenCalledOnce();
	});

	it('propagates an unrelated dispatch-creation failure as-is', async () => {
		vi.mocked(createAndPublishDispatch).mockRejectedValue(new Error('redis unavailable'));

		const error = await resetRun('run-1').catch((err: unknown) => err);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(RunResetError);
	});
});
