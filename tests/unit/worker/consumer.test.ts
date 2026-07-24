import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { AgentCli, AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError, agentRunError } from '@/harness/agent-failure.js';
import type { CliQuotaSnapshot } from '@/harness/quota.js';
import type { ResolvedAssignee } from '@/identity/assignee-resolver.js';
import type { SwarmUser } from '@/identity/schema.js';
import type { WorkerDispatchCandidate } from '@/identity/worker-enrollment-service.js';
import { logger } from '@/lib/logger.js';
import { DependencyBlockedError } from '@/pipeline/dependency-guard.js';
import type { ProposedScope } from '@/pipeline/planning.js';
import { BlockedRecoveryError } from '@/pipeline/resume.js';
import type { PMProvider, WorkItemAssignee } from '@/pm/types.js';
import type { CancellationOrigin } from '@/queue/cancellation.js';
import { DeliveryDeferredError } from '@/scm/delivery.js';
import {
	createMockGitHubParsedEvent,
	createMockGitHubProjectsWebhookJob,
	createMockGitHubWebhookJob,
	createMockProjectConfig,
	createMockWorkItem,
} from '../../helpers/factories.js';

// Every collaborator is mocked at the module boundary (ai/TESTING.md). The
// consumer no longer owns the worktree lifecycle — each pipeline phase does —
// so this mocks the four phase orchestrators + the PM-provider factory and
// asserts the wiring: which phase runs, with which inputs, and how its result
// (or failure) becomes a JobOutcome.

let projectLookup: (id: string) => ProjectConfig | undefined;
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByIdFromDb: async (id: string) => projectLookup(id),
}));

const addComment = vi.fn(async (_id: string, _text: string) => 'comment-1');
const provider = {
	type: 'github-projects',
	// The real GitHub Projects adapter reports assignee support; the eligibility
	// gate reads this flag to decide whether to resolve an item's assignee.
	supportsAssignees: true,
	addComment,
} as unknown as PMProvider;
const providerBuiltWith: ProjectConfig[] = [];
vi.mock('@/integrations/pm/github-projects/provider.js', () => ({
	createGitHubProjectsProvider: (project: ProjectConfig) => {
		providerBuiltWith.push(project);
		return provider;
	},
}));

type PhaseCall = { phase: string; args: Record<string, unknown> };
const phaseCalls: PhaseCall[] = [];
let phaseImpl: (
	phase: string,
	args: Record<string, unknown>,
) => Promise<{
	agent: AgentCliResult;
	movedTo?: string;
	split?: { subTaskItemIds: string[]; mainTaskUpdated: boolean };
	verdict?: string;
	reviewOrdinal?: number;
	automationOutcome?: string;
}>;

function mockPhase(phase: string) {
	return (args: Record<string, unknown>) => {
		phaseCalls.push({ phase, args });
		return phaseImpl(phase, args);
	};
}
// Each mocked phase module keeps its coded `DEFAULT_*_CLI`: the eligibility gate
// judges a worker's capability against the phase's *effective* CLI, so
// `PHASE_DEFAULT_CLI` (`@/worker/target-policy.js`) reads these constants.
vi.mock('@/pipeline/planning.js', () => ({
	runPlanningPhase: mockPhase('planning'),
	DEFAULT_PLANNING_CLI: 'claude',
}));
vi.mock('@/pipeline/implementation.js', () => ({
	runImplementationPhase: mockPhase('implementation'),
	DEFAULT_IMPLEMENTATION_CLI: 'claude',
}));
vi.mock('@/pipeline/review.js', () => ({
	runReviewPhase: mockPhase('review'),
	DEFAULT_REVIEW_CLI: 'claude',
}));
vi.mock('@/pipeline/respond-to-review.js', () => ({
	runRespondToReviewPhase: mockPhase('respond-to-review'),
	DEFAULT_RESPOND_CLI: 'claude',
}));
vi.mock('@/pipeline/respond-to-ci.js', () => ({
	runRespondToCiPhase: mockPhase('respond-to-ci'),
	DEFAULT_RESPOND_CI_CLI: 'claude',
}));
vi.mock('@/pipeline/resolve-conflicts.js', () => ({
	runResolveConflictsPhase: mockPhase('resolve-conflicts'),
	DEFAULT_RESOLVE_CONFLICTS_CLI: 'claude',
}));

vi.mock('@/queue/producer.js', () => ({
	priorityFor: (job: { type: string }) => (job.type === 'github-projects' ? 10 : undefined),
}));

// The durable dispatch layer (issue #284) is mocked at its two boundaries: the
// dispatcher (claim/publish orchestration) and the repository (state
// transitions). The default claim wraps the incoming job in a dispatch row
// whose stored payload is the job itself, so `parseDispatchPayload` hands the
// same job back — tests then assert the transitions the consumer performs.
type MockDispatchRow = {
	id: string;
	wakeSeq: number;
	projectId: string;
	jobPayload: Record<string, unknown>;
	availableAt: Date;
	createdAt: Date;
	state: string;
	priority: number;
	attempt: number;
};
function mockDispatchRow(job: Record<string, unknown>): MockDispatchRow {
	return {
		id: 'dispatch-1',
		wakeSeq: 0,
		projectId: String(job.projectId ?? ''),
		jobPayload: job,
		availableAt: new Date(),
		createdAt: new Date(),
		state: 'leased',
		priority: 0,
		attempt: 0,
	};
}
const claimDispatchForJob = vi.fn(
	async (job: Record<string, unknown>, _leaseMs: number) =>
		({ claimed: true, dispatch: mockDispatchRow(job) }) as
			| { claimed: true; dispatch: MockDispatchRow }
			| { claimed: false; reason: string },
);
const createAndPublishDispatch = vi.fn(async (_input: unknown) => ({
	dispatch: mockDispatchRow({}),
	created: true,
}));
const promoteNextCapacityDispatch = vi.fn(async (_projectId: string, _prioritize?: boolean) => {});
const publishDispatchWakeUp = vi.fn(async (_dispatch: unknown) => {});
vi.mock('@/dispatch/dispatcher.js', () => ({
	DISPATCH_LEASE_OWNER: 'test-host:1',
	claimDispatchForJob: (job: Record<string, unknown>, leaseMs: number) =>
		claimDispatchForJob(job, leaseMs),
	createAndPublishDispatch: (input: unknown) => createAndPublishDispatch(input),
	parseDispatchPayload: (dispatch: MockDispatchRow) => ({
		...dispatch.jobPayload,
		dispatchId: dispatch.id,
	}),
	promoteNextCapacityDispatch: (projectId: string, prioritize?: boolean) =>
		promoteNextCapacityDispatch(projectId, prioritize),
	publishDispatchWakeUp: (dispatch: unknown) => publishDispatchWakeUp(dispatch),
}));

const completeDispatch = vi.fn(async (_id: string, _outcome: string) => true);
const failDispatch = vi.fn(async (_id: string, _error: string) => true);
const cancelClaimedDispatch = vi.fn(async (_id: string, _reason: string) => true);
const markDispatchRunning = vi.fn(
	async (_id: string, _runId: string | undefined, _leaseUntil: Date, _t: string, _p: string) =>
		true,
);
const recordDispatchResolution = vi.fn(async (_id: string, _taskId: string, _phase: string) => {});
const deferDispatchToPending = vi.fn(async (_id: string, _input: unknown) => mockDispatchRow({}));
const scheduleDispatchRetry = vi.fn(
	async (_id: string, input: { jobPayload: Record<string, unknown> }) => ({
		...mockDispatchRow(input.jobPayload),
		state: 'retry-scheduled',
	}),
);
const claimWorkerForDispatch = vi.fn(
	async (
		_input: unknown,
	): Promise<
		{ claimed: true; dispatch: MockDispatchRow } | { claimed: false; reason: 'wrong-worker-host' }
	> => ({
		claimed: true,
		dispatch: mockDispatchRow({}),
	}),
);
vi.mock('@/db/repositories/dispatchesRepository.js', () => ({
	claimWorkerForDispatch: (input: unknown) => claimWorkerForDispatch(input),
	completeDispatch: (id: string, outcome: string) => completeDispatch(id, outcome),
	failDispatch: (id: string, error: string) => failDispatch(id, error),
	cancelClaimedDispatch: (id: string, reason: string) => cancelClaimedDispatch(id, reason),
	markDispatchRunning: (
		id: string,
		runId: string | undefined,
		leaseUntil: Date,
		t: string,
		p: string,
	) => markDispatchRunning(id, runId, leaseUntil, t, p),
	recordDispatchResolution: (id: string, taskId: string, phase: string) =>
		recordDispatchResolution(id, taskId, phase),
	deferDispatchToPending: (id: string, input: unknown) => deferDispatchToPending(id, input),
	scheduleDispatchRetry: (id: string, input: { jobPayload: Record<string, unknown> }) =>
		scheduleDispatchRetry(id, input),
}));

const refreshConflictResolutionClaim = vi.fn(async (_key: string, _ttlSec: number) => {});
vi.mock('@/triggers/resolve-conflicts-dedup.js', () => ({
	refreshConflictResolutionClaim: (key: string, ttlSec: number) =>
		refreshConflictResolutionClaim(key, ttlSec),
	buildConflictResolutionKey: (repo: string, prNumber: string, headSha: string, baseSha: string) =>
		`${repo}:${prNumber}:${headSha}:${baseSha}`,
}));

const refreshReviewDispatchClaim = vi.fn(async (_key: string, _ttlSec: number) => {});
const releaseReviewDispatch = vi.fn(async (_key: string) => {});
vi.mock('@/triggers/review-dispatch-dedup.js', () => ({
	refreshReviewDispatchClaim: (key: string, ttlSec: number) =>
		refreshReviewDispatchClaim(key, ttlSec),
	releaseReviewDispatch: (key: string) => releaseReviewDispatch(key),
	buildReviewDispatchKey: (repo: string, prNumber: string, headSha: string) =>
		`${repo}:${prNumber}:${headSha}`,
}));

// The run-history repository is mocked at the module boundary: these assertions
// pin the best-effort run-row lifecycle (create before the phase, finalize after)
// without a live Postgres. `createRun` resolves a fixed id the completion sites
// finalize against.
const createRun = vi.fn(async (_input: unknown) => 'run-1');
const completeRun = vi.fn(async (_id: string, _input: unknown) => {});
const storeRunLogs = vi.fn(async (_id: string, _stdout: string, _stderr: string) => {});
const updateRunJobPayload = vi.fn(async (_id: string, _job: unknown) => {});
const getLatestRunForTask = vi.fn(
	async (_projectId: string, _taskId: string, _phase: string) => undefined,
);
const getLatestCompletedPlanningScope = vi.fn<
	(projectId: string, taskId: string) => Promise<ProposedScope | undefined>
>(async (_projectId: string, _taskId: string) => undefined);
const hasCompletedRunForTask = vi.fn(
	async (_projectId: string, _taskId: string, _phase: string) => false,
);
const resetRunToRunning = vi.fn(async (_id: string, _job?: unknown, _fromStatus?: string) => true);
const getRunByIdFromDb = vi.fn(
	async (_id: string) => undefined as { agentSessionId?: string | null } | undefined,
);
vi.mock('@/db/repositories/runsRepository.js', () => ({
	createRun: (input: unknown) => createRun(input),
	completeRun: (id: string, input: unknown) => completeRun(id, input),
	storeRunLogs: (id: string, stdout: string, stderr: string) => storeRunLogs(id, stdout, stderr),
	updateRunJobPayload: (id: string, job: unknown) => updateRunJobPayload(id, job),
	getLatestRunForTask: (projectId: string, taskId: string, phase: string) =>
		getLatestRunForTask(projectId, taskId, phase),
	getLatestCompletedPlanningScope: (projectId: string, taskId: string) =>
		getLatestCompletedPlanningScope(projectId, taskId),
	hasCompletedRunForTask: (projectId: string, taskId: string, phase: string) =>
		hasCompletedRunForTask(projectId, taskId, phase),
	resetRunToRunning: (id: string, job?: unknown, fromStatus?: string) =>
		resetRunToRunning(id, job, fromStatus),
	getRunByIdFromDb: (id: string) => getRunByIdFromDb(id),
}));

// Global (app-wide) settings are loaded once per job for the default-model tier
// (`resolveModel`). Mocked at the module boundary so these tests drive the
// global `agents.defaults` without a live Postgres; defaults to "nothing stored".
const getAppSettings = vi.fn(async () => ({}) as Record<string, unknown>);
vi.mock('@/db/repositories/appSettingsRepository.js', () => ({
	getAppSettings: () => getAppSettings(),
}));

// The CLIs this worker can run, for capability-aware target routing (issue
// #346). Mocked at the same boundary; defaults to "discovery never ran", which
// keeps every phase on its preferred target.
const getAllCliQuotas = vi.fn<() => Promise<CliQuotaSnapshot[]>>(async () => []);
vi.mock('@/db/repositories/cliQuotasRepository.js', () => ({
	getAllCliQuotas: () => getAllCliQuotas(),
}));

// The PR-comment path of `reportInterruptedJobToBoard` goes through the concrete
// SCM integration (the PM provider has no PR → comment mapping); mock it at the
// module boundary the same way the PM provider is mocked above.
const commentOnPullRequest = vi.fn(async (_p: ProjectConfig, _n: number, _b: string) => 99);
vi.mock('@/integrations/scm/github/scm-integration.js', () => ({
	GitHubSCMIntegration: class {
		commentOnPullRequest = commentOnPullRequest;
	},
}));

// The durable merge-automation module (issue #292) is mocked at its own
// boundary: these tests only assert that an eligible Review approval persists a
// merge dispatch with the right identity (and that a merge-automation wake-up
// is routed to the executor), not the executor's internal behavior.
const requestMergeAutomation = vi.fn(async (_input: unknown) => {});
const processMergeAutomationDispatch = vi.fn(async (_d: unknown, _j: unknown, _p: unknown) => ({
	status: 'merge-automation-settled' as const,
	result: 'merged' as const,
	prNumber: '17',
}));
vi.mock('@/worker/merge-automation.js', () => ({
	requestMergeAutomation: (input: unknown) => requestMergeAutomation(input),
	processMergeAutomationDispatch: (dispatch: unknown, job: unknown, project: unknown) =>
		processMergeAutomationDispatch(dispatch, job, project),
}));

// The federated dispatch gate (issue #339) reads the project's enrolled workers
// and resolves an item's assignee to a SWARM user. Both are mocked at their
// module boundary so these tests drive routing without Postgres; the default —
// no enrolled workers — is an unfederated project, where the local worker runs
// every phase exactly as it did before the gate existed.
const listProjectDispatchCandidates = vi.fn<
	(projectId: string) => Promise<WorkerDispatchCandidate[]>
>(async () => []);
vi.mock('@/identity/worker-enrollment-service.js', () => ({
	listProjectDispatchCandidates: (projectId: string) => listProjectDispatchCandidates(projectId),
}));

const resolveAssignedUser = vi.fn<
	(
		workItem: { assignees: WorkItemAssignee[] },
		provider: string,
	) => Promise<ResolvedAssignee | undefined>
>(async () => undefined);
vi.mock('@/identity/assignee-resolver.js', () => ({
	resolveAssignedUser: (workItem: { assignees: WorkItemAssignee[] }, provider: string) =>
		resolveAssignedUser(workItem, provider),
}));

type SlotAcquisition = { acquired: false } | { acquired: true; tracked: boolean };
const acquireProjectSlot = vi.fn<(projectId: string, limit: number) => Promise<SlotAcquisition>>(
	async () => ({ acquired: true, tracked: true }),
);
const releaseProjectSlot = vi.fn(async (_projectId: string) => {});
vi.mock('@/worker/project-concurrency.js', () => ({
	acquireProjectSlot: (projectId: string, limit: number) => acquireProjectSlot(projectId, limit),
	releaseProjectSlot: (projectId: string) => releaseProjectSlot(projectId),
}));

// User-initiated termination (issue #166): the durable cancellation flag is read
// to tell a user termination apart from a worker-shutdown abort, and the per-run
// controller is registered/unregistered around the phase. Mocked at the boundary
// so these tests drive the "was this cancelled?" answer without Redis.
const isRunCancellationRequested = vi.fn<(runId: string) => Promise<boolean>>(async () => false);
const clearRunCancellation = vi.fn(async (_runId: string) => {});
const getRunCancellationOrigin = vi.fn<(runId: string) => Promise<CancellationOrigin | null>>(
	async () => null,
);
vi.mock('@/queue/cancellation.js', () => ({
	isRunCancellationRequested: (runId: string) => isRunCancellationRequested(runId),
	clearRunCancellation: (runId: string) => clearRunCancellation(runId),
	getRunCancellationOrigin: (runId: string) => getRunCancellationOrigin(runId),
	RUN_CANCELLED_MESSAGE: 'Run cancelled after a cancellation request.',
}));

const registerRunController = vi.fn<(runId: string, controller: AbortController) => void>();
const unregisterRunController = vi.fn<(runId: string) => void>();
const linkRunAbortController = vi.fn((signal?: AbortSignal) => {
	const controller = new AbortController();
	if (!signal) {
		return { controller, detach: () => {} };
	}
	const onShutdown = () => controller.abort();
	signal.addEventListener('abort', onShutdown);
	return {
		controller,
		detach: () => signal.removeEventListener('abort', onShutdown),
	};
});
const beginRunCancellationTracking = vi.fn(async (runId?: string, controller?: AbortController) => {
	if (!runId || !controller) return;
	registerRunController(runId, controller);
	if (await isRunCancellationRequested(runId)) {
		controller.abort();
	}
});

vi.mock('@/worker/run-cancellation.js', () => ({
	registerRunController: (runId: string, controller: AbortController) =>
		registerRunController(runId, controller),
	unregisterRunController: (runId: string) => unregisterRunController(runId),
	linkRunAbortController: (signal?: AbortSignal) => linkRunAbortController(signal),
	beginRunCancellationTracking: (runId?: string, controller?: AbortController) =>
		beginRunCancellationTracking(runId, controller),
}));

// Terminated-run checkout settlement (issue #361): mocked at its boundary so the
// consumer's finalize wiring is asserted (which outcome → which recovery record)
// without a real git worktree. Defaults to 'absent' (no checkout to reconcile).
type TerminationResult =
	| { outcome: 'absent' }
	| { outcome: 'preserved'; agentSessionId: string }
	| { outcome: 'removed' }
	| { outcome: 'blocked'; blockedReason: 'dirty' | 'unpushed' | 'live-leased' };
const reconcileTerminatedWorktree = vi.fn<() => Promise<TerminationResult>>(async () => ({
	outcome: 'absent',
}));
vi.mock('@/worktree/termination-cleanup.js', () => ({
	reconcileTerminatedWorktree: (...args: unknown[]) =>
		(reconcileTerminatedWorktree as unknown as (...a: unknown[]) => Promise<TerminationResult>)(
			...args,
		),
}));

import { createTriggerRegistry } from '@/triggers/registry.js';
import type { TriggerContext, TriggerResult } from '@/triggers/types.js';
import {
	type AssignedPhaseInputs,
	DEFAULT_AGENT_TIMEOUT_MS,
	processJob,
	reportInterruptedJobToBoard,
	runAssignedPhase,
} from '@/worker/consumer.js';

const PROJECT = createMockProjectConfig();

function agentResult(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 1234,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
		...overrides,
	};
}

function registryReturning(result: TriggerResult | null, seenContexts: TriggerContext[] = []) {
	const registry = createTriggerRegistry();
	registry.register({
		name: 'test-trigger',
		description: 'returns a fixed result',
		matches: () => true,
		handle: async (ctx) => {
			seenContexts.push(ctx);
			return result;
		},
	});
	return registry;
}

const REVIEW_TRIGGER: TriggerResult = {
	phase: 'review',
	taskId: '17',
	prNumber: '17',
	headSha: 'deadbeef',
};
const RESPOND_TO_REVIEW_TRIGGER: TriggerResult = {
	phase: 'respond-to-review',
	taskId: '17-respond',
	prNumber: '17',
	prBranch: 'issue-17',
	reviewId: '555',
	headSha: 'deadbeef',
};
const RESPOND_TO_CI_TRIGGER: TriggerResult = {
	phase: 'respond-to-ci',
	taskId: '17-ci',
	prNumber: '17',
	prBranch: 'issue-17',
	headSha: 'deadbeef',
};
const RESOLVE_CONFLICTS_TRIGGER: TriggerResult = {
	phase: 'resolve-conflicts',
	taskId: '17-conflicts',
	prNumber: '17',
	prBranch: 'issue-17',
	headSha: 'deadbeef',
	baseBranch: 'main',
	baseSha: 'cafebabe',
};

describe('processJob', () => {
	beforeEach(() => {
		phaseCalls.length = 0;
		providerBuiltWith.length = 0;
		projectLookup = () => PROJECT;
		phaseImpl = async () => ({ agent: agentResult() });
		addComment.mockClear();
		addComment.mockResolvedValue('comment-1');
		claimDispatchForJob.mockClear();
		claimDispatchForJob.mockImplementation(async (job: Record<string, unknown>) => ({
			claimed: true,
			dispatch: mockDispatchRow(job),
		}));
		createAndPublishDispatch.mockClear();
		createAndPublishDispatch.mockResolvedValue({ dispatch: mockDispatchRow({}), created: true });
		promoteNextCapacityDispatch.mockClear();
		publishDispatchWakeUp.mockClear();
		completeDispatch.mockClear();
		failDispatch.mockClear();
		cancelClaimedDispatch.mockClear();
		markDispatchRunning.mockClear();
		recordDispatchResolution.mockClear();
		deferDispatchToPending.mockClear();
		scheduleDispatchRetry.mockClear();
		claimWorkerForDispatch.mockClear();
		claimWorkerForDispatch.mockResolvedValue({
			claimed: true,
			dispatch: mockDispatchRow({}),
		});
		refreshConflictResolutionClaim.mockClear();
		refreshReviewDispatchClaim.mockClear();
		releaseReviewDispatch.mockClear();
		createRun.mockClear();
		createRun.mockResolvedValue('run-1');
		completeRun.mockClear();
		completeRun.mockResolvedValue(undefined);
		storeRunLogs.mockClear();
		storeRunLogs.mockResolvedValue(undefined);
		updateRunJobPayload.mockClear();
		updateRunJobPayload.mockResolvedValue(undefined);
		resetRunToRunning.mockClear();
		resetRunToRunning.mockResolvedValue(true);
		getRunByIdFromDb.mockClear();
		getRunByIdFromDb.mockResolvedValue(undefined);
		reconcileTerminatedWorktree.mockClear();
		reconcileTerminatedWorktree.mockResolvedValue({ outcome: 'absent' });
		getLatestRunForTask.mockClear();
		getLatestRunForTask.mockResolvedValue(undefined);
		getLatestCompletedPlanningScope.mockClear();
		getLatestCompletedPlanningScope.mockResolvedValue(undefined);
		hasCompletedRunForTask.mockClear();
		hasCompletedRunForTask.mockResolvedValue(false);
		getAppSettings.mockClear();
		getAppSettings.mockResolvedValue({});
		getAllCliQuotas.mockClear();
		getAllCliQuotas.mockResolvedValue([]);
		listProjectDispatchCandidates.mockClear();
		listProjectDispatchCandidates.mockResolvedValue([]);
		resolveAssignedUser.mockClear();
		resolveAssignedUser.mockResolvedValue(undefined);
		acquireProjectSlot.mockClear();
		acquireProjectSlot.mockResolvedValue({ acquired: true, tracked: true });
		releaseProjectSlot.mockClear();
		isRunCancellationRequested.mockClear();
		isRunCancellationRequested.mockResolvedValue(false);
		clearRunCancellation.mockClear();
		getRunCancellationOrigin.mockClear();
		getRunCancellationOrigin.mockResolvedValue(null);
		registerRunController.mockClear();
		unregisterRunController.mockClear();
		requestMergeAutomation.mockClear();
		processMergeAutomationDispatch.mockClear();
	});

	// Restore any per-test environment stub (e.g. SWARM_SINGLE_USER_MODE) so a mode
	// enabled by one case never leaks into the next (issue #373).
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('runs under the project limit and releases the slot on success', async () => {
		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-succeeded');
		expect(acquireProjectSlot).toHaveBeenCalledWith(PROJECT.id, PROJECT.maxConcurrentJobs);
		expect(releaseProjectSlot).toHaveBeenCalledOnce();
		expect(releaseProjectSlot).toHaveBeenCalledWith(PROJECT.id);
	});

	it('defers at the project limit without running or releasing an unacquired slot', async () => {
		acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome).toMatchObject({
			status: 'phase-deferred',
			phase: 'review',
			taskId: '17',
			attempt: 0,
			retryDelayMs: 0,
			pendingDispatch: true,
		});
		expect(phaseCalls).toEqual([]);
		expect(releaseProjectSlot).not.toHaveBeenCalled();

		await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
		expect(phaseCalls).toHaveLength(1);
	});

	it('leaves a fresh Implementation retry free to create its task branch after a capacity deferral', async () => {
		acquireProjectSlot.mockResolvedValueOnce({ acquired: false });
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		const trigger: TriggerResult = { phase: 'implementation', taskId: '216', workItem };

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning(trigger),
		);

		expect(outcome).toMatchObject({
			status: 'phase-deferred',
			phase: 'implementation',
			resumable: false,
			runId: 'run-1',
		});
		expect(phaseCalls).toEqual([]);
	});

	it('does not consume the external-failure retry budget while waiting for a slot', async () => {
		acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

		const outcome = await processJob(
			createMockGitHubWebhookJob({ rateLimitRetryAttempt: 6 }),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-deferred');
		if (outcome.status !== 'phase-deferred') throw new Error('expected deferred');
		expect(outcome.pendingDispatch).toBe(true);
		expect(commentOnPullRequest).not.toHaveBeenCalled();
		expect(phaseCalls).toEqual([]);
	});

	describe('pending-continuation scheduling (#214)', () => {
		it('retains a concurrency-blocked Review as an observable pending continuation', async () => {
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome).toMatchObject({
				status: 'phase-deferred',
				phase: 'review',
				taskId: '17',
				continuationDispatchClaimed: true,
				pendingContinuation: true,
				runId: 'run-1',
			});
			// Observable: a `deferred` run row is created now instead of the Review being
			// invisible until the fallback delay fires.
			expect(createRun).toHaveBeenCalledTimes(1);
			// The PR+SHA claim is refreshed (held open) past the fallback retry window so
			// no sibling event steals it while the continuation waits.
			expect(refreshReviewDispatchClaim).toHaveBeenCalledWith(
				`${PROJECT.repo}:17:deadbeef`,
				expect.any(Number),
			);
			expect(phaseCalls).toEqual([]);
			// Never acquired a slot → never released, and nothing reserved.
			expect(releaseProjectSlot).not.toHaveBeenCalled();
		});

		it.each([
			['Respond-to-review', RESPOND_TO_REVIEW_TRIGGER],
			['Respond-to-CI', RESPOND_TO_CI_TRIGGER],
			['Resolve-conflicts', RESOLVE_CONFLICTS_TRIGGER],
		] as const)('retains a concurrency-blocked %s phase as an observable pending continuation', async (_label, trigger) => {
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

			const outcome = await processJob(createMockGitHubWebhookJob(), registryReturning(trigger));

			expect(outcome).toMatchObject({
				status: 'phase-deferred',
				phase: trigger.phase,
				taskId: trigger.taskId,
				continuationDispatchClaimed: true,
				pendingContinuation: true,
				runId: 'run-1',
			});
			expect(createRun).toHaveBeenCalledOnce();
			expect(phaseCalls).toEqual([]);
		});

		it('refreshes the Respond-to-CI PR+SHA claim without refreshing Respond-to-review', async () => {
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });
			await processJob(createMockGitHubWebhookJob(), registryReturning(RESPOND_TO_CI_TRIGGER));

			expect(refreshReviewDispatchClaim).toHaveBeenCalledWith(
				`${PROJECT.repo}:17:deadbeef`,
				expect.any(Number),
			);

			refreshReviewDispatchClaim.mockClear();
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });
			await processJob(createMockGitHubWebhookJob(), registryReturning(RESPOND_TO_REVIEW_TRIGGER));

			// The dispatch claim stays held even without priority so immediate
			// slot-release dispatch cannot be deduplicated as a fresh webhook.
		});

		it('refreshes the Resolve-conflicts head/base claim while pending', async () => {
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

			await processJob(createMockGitHubWebhookJob(), registryReturning(RESOLVE_CONFLICTS_TRIGGER));

			expect(refreshConflictResolutionClaim).toHaveBeenCalledWith(
				`${PROJECT.repo}:17:deadbeef:cafebabe`,
				expect.any(Number),
			);
		});

		it('retains a continuation when a project with multiple slots is fully occupied', async () => {
			projectLookup = () => createMockProjectConfig({ maxConcurrentJobs: 2 });
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(RESPOND_TO_CI_TRIGGER),
			);

			expect(acquireProjectSlot).toHaveBeenCalledWith(PROJECT.id, 2);
			expect(outcome).toMatchObject({
				status: 'phase-deferred',
				pendingContinuation: true,
			});
		});

		it('retains a blocked Implementation with a visible run and exact resume phase', async () => {
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });
			const workItem = createMockWorkItem({ statusId: '61e4505c' });
			const trigger: TriggerResult = { phase: 'implementation', taskId: '216', workItem };

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(trigger),
			);

			if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
			expect(outcome.continuationDispatchClaimed).toBeUndefined();
			expect(outcome.pendingContinuation).toBeUndefined();
			expect(outcome.pendingDispatch).toBe(true);
			expect(refreshReviewDispatchClaim).not.toHaveBeenCalled();
			expect(createRun).toHaveBeenCalledOnce();
		});

		it('wakes the next capacity-blocked dispatch when a slot frees on success', async () => {
			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(releaseProjectSlot).toHaveBeenCalledOnce();
			expect(promoteNextCapacityDispatch).toHaveBeenCalledWith(PROJECT.id, true);
		});

		it('records the capacity wait durably on the dispatch when blocked by the limit', async () => {
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

			const outcome = await processJob(
				createMockGitHubWebhookJob({ runId: undefined }),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-deferred');
			expect(deferDispatchToPending).toHaveBeenCalledWith(
				'dispatch-1',
				expect.objectContaining({
					waitReason: 'project-capacity',
					continuation: true,
					runId: 'run-1',
					jobPayload: expect.objectContaining({
						runId: 'run-1',
						continuationDispatchClaimed: true,
					}),
				}),
			);
			// A slot deferral is durable pending work, not a timer retry.
			expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		});

		it.each([
			REVIEW_TRIGGER,
			RESPOND_TO_REVIEW_TRIGGER,
			RESPOND_TO_CI_TRIGGER,
			RESOLVE_CONFLICTS_TRIGGER,
		])('keeps FIFO scheduling for $phase when continuation prioritization is false', async (trigger) => {
			projectLookup = () =>
				createMockProjectConfig({ pipeline: { prioritizeContinuations: false } });
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

			const outcome = await processJob(createMockGitHubWebhookJob(), registryReturning(trigger));

			expect(outcome).toMatchObject({
				status: 'phase-deferred',
				phase: trigger.phase,
				retryDelayMs: 0,
			});
			if (outcome.status !== 'phase-deferred') throw new Error('unreachable');
			expect(outcome.continuationDispatchClaimed).toBe(true);
			expect(outcome.pendingContinuation).toBe(false);
			expect(createRun).toHaveBeenCalledOnce();
		});

		it('still promotes pending work on slot release when prioritizeContinuations is false', async () => {
			projectLookup = () =>
				createMockProjectConfig({ pipeline: { prioritizeContinuations: false } });

			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(releaseProjectSlot).toHaveBeenCalledOnce();
			expect(promoteNextCapacityDispatch).toHaveBeenCalledWith(PROJECT.id, false);
		});

		it('finalizes the run row and releases the claim if a pending continuation re-resolves to no-trigger', async () => {
			const job = createMockGitHubWebhookJob({
				runId: 'run-123',
				continuationDispatchClaimed: true,
				event: createMockGitHubParsedEvent({ headSha: 'deadbeef' }),
			});

			const outcome = await processJob(job, registryReturning(null));

			expect(outcome.status).toBe('no-trigger');
			expect(completeRun).toHaveBeenCalledWith('run-123', {
				status: 'failed',
				error: expect.stringContaining('no-trigger'),
			});
			expect(releaseReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:17:deadbeef`);
		});
	});

	it('releases a tracked slot after failure and abort, but not a fail-open slot', async () => {
		phaseImpl = async () => {
			throw new Error('failed');
		};
		await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
		expect(releaseProjectSlot).toHaveBeenCalledTimes(1);

		releaseProjectSlot.mockClear();
		phaseImpl = async () => {
			throw new AgentRunError('aborted', { kind: 'aborted' });
		};
		await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
		expect(releaseProjectSlot).toHaveBeenCalledTimes(1);

		releaseProjectSlot.mockClear();
		acquireProjectSlot.mockResolvedValueOnce({ acquired: true, tracked: false });
		phaseImpl = async () => ({ agent: agentResult() });
		await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
		expect(releaseProjectSlot).not.toHaveBeenCalled();
	});

	it('throws for a job referencing an unknown project', async () => {
		projectLookup = () => undefined;

		await expect(
			processJob(createMockGitHubWebhookJob({ projectId: 'ghost' }), registryReturning(null)),
		).rejects.toThrow("unknown project 'ghost'");
		expect(phaseCalls).toEqual([]);
	});

	it('completes as no-trigger without running a phase', async () => {
		const registry = createTriggerRegistry();

		await expect(processJob(createMockGitHubWebhookJob(), registry)).resolves.toEqual({
			status: 'no-trigger',
		});
		expect(phaseCalls).toEqual([]);
	});

	it('hands the trigger a context built from the job', async () => {
		const seen: TriggerContext[] = [];
		const job = createMockGitHubWebhookJob();

		await processJob(job, registryReturning(null, seen));

		expect(seen).toEqual([
			{ project: PROJECT, deliveryId: job.deliveryId, source: 'github', event: job.event },
		]);
	});

	it('threads a recheck job back through, exposing its incremented recheckAttempt to the trigger', async () => {
		// A deferred recheck (scheduleCoalescedJob) re-enqueues the same event with
		// recheckAttempt bumped; when the worker pulls it, processJob must surface
		// that attempt in the ctx so the review handler re-matches and can enforce
		// its recheck cap rather than looping forever.
		const seen: TriggerContext[] = [];
		const job = createMockGitHubWebhookJob({ recheckAttempt: 5 });

		await processJob(job, registryReturning(REVIEW_TRIGGER, seen));

		expect(seen[0].recheckAttempt).toBe(5);
		expect(phaseCalls[0].phase).toBe('review');
	});

	it('threads a deferred PM phase through so its status trigger can resume it', async () => {
		const seen: TriggerContext[] = [];
		const job = createMockGitHubProjectsWebhookJob({ resumePmPhase: 'implementation' });

		await processJob(job, registryReturning(null, seen));

		expect(seen[0].resumePmPhase).toBe('implementation');
	});

	it('reuses the implementation branch only with a provisioning checkpoint', async () => {
		const workItem = createMockWorkItem({ statusId: '47fc9ee4' });
		const trigger: TriggerResult = { phase: 'implementation', taskId: '10', workItem };

		await processJob(
			createMockGitHubProjectsWebhookJob({
				resumePmPhase: 'implementation',
				implementationBranchProvisioned: true,
			}),
			registryReturning(trigger),
		);

		expect(phaseCalls[0].args.resumeExistingBranch).toBe(true);
	});

	it('does not treat PM resume dispatch intent as proof that a branch exists', async () => {
		const workItem = createMockWorkItem({ statusId: '47fc9ee4' });
		const trigger: TriggerResult = { phase: 'implementation', taskId: '10', workItem };

		await processJob(
			createMockGitHubProjectsWebhookJob({ resumePmPhase: 'implementation', runId: 'run-1' }),
			registryReturning(trigger),
		);

		expect(phaseCalls[0].args.resumeExistingBranch).toBe(false);
	});

	it('persists the explicit branch checkpoint after Implementation provisions', async () => {
		phaseImpl = async (_phase, args) => {
			await (args.onBranchProvisioned as () => Promise<void>)();
			throw new Error('failed after provisioning');
		};
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		const trigger: TriggerResult = { phase: 'implementation', taskId: '10', workItem };

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(updateRunJobPayload).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({ implementationBranchProvisioned: true }),
		);
	});

	it('threads the fresh run row id as the sessionId on a first PM run (nothing to resume)', async () => {
		const workItem = createMockWorkItem({ statusId: '3fe662f4' });
		const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		// createRun's id becomes the deterministic session handle; no resume yet.
		expect(phaseCalls[0].args.sessionId).toBe('run-1');
		expect(phaseCalls[0].args.resumeSessionId).toBeUndefined();
	});

	it('threads the restored session as resumeSessionId (not sessionId) on a resumed PM run', async () => {
		getRunByIdFromDb.mockResolvedValue({ agentSessionId: 'sess-restored' });
		const workItem = createMockWorkItem({ statusId: '47fc9ee4' });
		const trigger: TriggerResult = { phase: 'implementation', taskId: '10', workItem };

		await processJob(
			createMockGitHubProjectsWebhookJob({
				resumePmPhase: 'implementation',
				resumeSession: true,
				runId: 'run-1',
			}),
			registryReturning(trigger),
		);

		// The carried row's preserved session is restored from the DB and resumed.
		expect(getRunByIdFromDb).toHaveBeenCalledWith('run-1');
		expect(phaseCalls[0].args.resumeSessionId).toBe('sess-restored');
		expect(phaseCalls[0].args.sessionId).toBeUndefined();
	});

	it('threads the restored session as resumeSessionId on a resumed non-PM (review) run', async () => {
		getRunByIdFromDb.mockResolvedValue({ agentSessionId: 'sess-review' });

		await processJob(
			createMockGitHubWebhookJob({ resumeSession: true, runId: 'run-1' }),
			registryReturning(REVIEW_TRIGGER),
		);

		// Review is a github (PR) job with no resumePmPhase — session continuation is
		// driven purely by the generic resumeSession flag, uniform across phases.
		expect(phaseCalls[0].phase).toBe('review');
		expect(phaseCalls[0].args.resumeSessionId).toBe('sess-review');
		expect(phaseCalls[0].args.sessionId).toBeUndefined();
	});

	it('threads delivery resume separately when no agent session was captured', async () => {
		getRunByIdFromDb.mockResolvedValue({ agentSessionId: null });

		await processJob(
			createMockGitHubWebhookJob({ resumeDelivery: true, runId: 'run-1' }),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(phaseCalls[0].phase).toBe('review');
		expect(phaseCalls[0].args.resumeDelivery).toBe(true);
		expect(phaseCalls[0].args.resumeSessionId).toBeUndefined();
	});

	it('discriminates the context source for a projects job', async () => {
		const seen: TriggerContext[] = [];
		const job = createMockGitHubProjectsWebhookJob();

		await processJob(job, registryReturning(null, seen));

		expect(seen[0].source).toBe('github-projects');
		expect(seen[0].event).toEqual(job.event);
	});

	it('runs the Review phase for a review trigger and maps the outcome', async () => {
		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(phaseCalls).toHaveLength(1);
		expect(phaseCalls[0].phase).toBe('review');
		expect(phaseCalls[0].args).toMatchObject({
			project: PROJECT,
			prNumber: '17',
			headSha: 'deadbeef',
			taskId: '17',
		});
		expect(outcome).toEqual({
			status: 'phase-succeeded',
			phase: 'review',
			taskId: '17',
			exitCode: 0,
			signal: null,
			timedOut: false,
			durationMs: 1234,
		});
	});

	describe('merge-automation wake-ups (issue #292)', () => {
		const MERGE_JOB = {
			type: 'merge-automation' as const,
			projectId: PROJECT.id,
			reviewRunId: 'run-1',
			repo: 'jkwiecien/swarm',
			prNumber: '17',
			approvedHeadSha: 'deadbeef',
		};

		it('routes a claimed merge-automation dispatch to the executor, off the trigger/slot path', async () => {
			const seen: TriggerContext[] = [];
			const outcome = await processJob({ ...MERGE_JOB }, registryReturning(REVIEW_TRIGGER, seen));

			expect(processMergeAutomationDispatch).toHaveBeenCalledTimes(1);
			const [dispatchArg, jobArg, projectArg] = processMergeAutomationDispatch.mock.calls[0];
			expect(jobArg).toMatchObject({ ...MERGE_JOB, dispatchId: 'dispatch-1' });
			expect(projectArg).toEqual(PROJECT);
			expect(dispatchArg).toMatchObject({ id: 'dispatch-1', state: 'leased' });
			expect(outcome).toEqual({
				status: 'merge-automation-settled',
				result: 'merged',
				prNumber: '17',
			});
			// It never resolves a trigger, runs an agent phase, or consumes a slot.
			expect(seen).toHaveLength(0);
			expect(phaseCalls).toHaveLength(0);
			expect(acquireProjectSlot).not.toHaveBeenCalled();
		});

		it('drops the wake-up without executing when the dispatch claim is refused', async () => {
			claimDispatchForJob.mockResolvedValue({ claimed: false, reason: 'terminal' });

			const outcome = await processJob({ ...MERGE_JOB }, registryReturning(REVIEW_TRIGGER));

			expect(processMergeAutomationDispatch).not.toHaveBeenCalled();
			expect(outcome).toEqual({ status: 'dispatch-refused', reason: 'terminal' });
		});
	});

	it('builds a PM provider and passes the work item for a planning trigger', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(providerBuiltWith).toEqual([PROJECT]);
		expect(phaseCalls[0].phase).toBe('planning');
		expect(phaseCalls[0].args).toMatchObject({
			project: PROJECT,
			taskId: '10',
			workItem,
			pm: provider,
		});
	});

	describe('self-enqueue after auto-advance', () => {
		it('does not self-enqueue Planning for preplanned split children', async () => {
			const trigger: TriggerResult = {
				phase: 'planning',
				taskId: '10',
				workItem: createMockWorkItem(),
			};
			phaseImpl = async () => ({
				agent: agentResult(),
				split: {
					subTaskItemIds: ['PVTI_child-one', 'PVTI_child-two'],
					mainTaskUpdated: true,
				},
			});

			await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it('self-enqueues a synthetic board job when Planning auto-advances to ToDo', async () => {
			const workItem = createMockWorkItem({ statusId: '3fe662f4' });
			const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };
			phaseImpl = async () => ({ agent: agentResult(), movedTo: 'todo' });

			await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

			expect(createAndPublishDispatch).toHaveBeenCalledExactlyOnceWith({
				projectId: PROJECT.id,
				priority: 10,
				source: 'synthetic',
				jobPayload: {
					type: 'github-projects',
					projectId: PROJECT.id,
					event: {
						eventType: 'projects_v2_item',
						action: 'edited',
						itemNodeId: workItem.id,
						projectNodeId: PROJECT.githubProjects.projectId,
						changedFieldNodeId: PROJECT.githubProjects.statusFieldId,
						changedFieldType: 'single_select',
					},
				},
			});
		});

		it('does not self-enqueue when the phase made no move (autoAdvance off)', async () => {
			const trigger: TriggerResult = {
				phase: 'planning',
				taskId: '10',
				workItem: createMockWorkItem(),
			};
			phaseImpl = async () => ({ agent: agentResult() });

			await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it("does not self-enqueue when the destination status doesn't start a phase", async () => {
			const trigger: TriggerResult = {
				phase: 'implementation',
				taskId: '10',
				workItem: createMockWorkItem(),
			};
			// Implementation's own report-back move (to "inReview") isn't a trigger.
			phaseImpl = async () => ({ agent: agentResult(), movedTo: 'inReview' });

			await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it('does not self-enqueue for a non-PM (PR-driven) phase', async () => {
			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it('still reports phase-succeeded when the self-enqueue itself fails', async () => {
			const trigger: TriggerResult = {
				phase: 'planning',
				taskId: '10',
				workItem: createMockWorkItem(),
			};
			phaseImpl = async () => ({ agent: agentResult(), movedTo: 'todo' });
			createAndPublishDispatch.mockRejectedValueOnce(new Error('redis unreachable'));

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(trigger),
			);

			expect(outcome.status).toBe('phase-succeeded');
		});
	});

	it("threads the project's per-phase agent override (cli/model/reasoning) into the phase call", async () => {
		const projectWithAgents = createMockProjectConfig({
			// Legacy combined string migrates to logical model + reasoning (issue #180).
			agents: { planning: { cli: 'antigravity', model: 'Gemini 3.5 Flash (High)' } },
		});
		projectLookup = () => projectWithAgents;
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args).toMatchObject({
			cli: 'antigravity',
			model: 'gemini-3.5-flash',
			reasoning: 'high',
		});
	});

	describe('implementation-unplanned config selection', () => {
		const implementationTrigger = (): TriggerResult => ({
			phase: 'implementation',
			taskId: '10',
			workItem: createMockWorkItem(),
		});

		it.each([
			'failed',
			'deferred',
			'absent',
		] as const)('uses the unplanned config and records it when Planning history is %s', async () => {
			projectLookup = () =>
				createMockProjectConfig({
					agents: {
						implementation: { cli: 'claude', model: 'sonnet' },
						implementationUnplanned: {
							cli: 'codex',
							model: 'gpt-5.6-terra',
							reasoning: 'max',
						},
					},
				});
			hasCompletedRunForTask.mockResolvedValueOnce(false);

			await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(implementationTrigger()),
			);

			expect(hasCompletedRunForTask).toHaveBeenCalledWith(PROJECT.id, '10', 'planning');
			expect(phaseCalls[0].args).toMatchObject({
				cli: 'codex',
				model: 'gpt-5.6-terra',
				reasoning: 'max',
			});
			expect(createRun).toHaveBeenCalledWith(
				expect.objectContaining({ engine: 'codex', model: 'gpt-5.6-terra', reasoning: 'max' }),
			);
		});

		it('uses the normal config after Planning completed and when the unplanned config is unset', async () => {
			const projectWithVariant = createMockProjectConfig({
				agents: {
					implementation: { cli: 'claude', model: 'opus' },
					implementationUnplanned: { cli: 'codex', model: 'gpt-5.6-terra' },
				},
			});
			projectLookup = () => projectWithVariant;
			hasCompletedRunForTask.mockResolvedValueOnce(true);

			await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(implementationTrigger()),
			);
			expect(phaseCalls[0].args).toMatchObject({ cli: 'claude', model: 'opus' });

			phaseCalls.length = 0;
			projectLookup = () =>
				createMockProjectConfig({ agents: { implementation: { cli: 'claude', model: 'opus' } } });
			hasCompletedRunForTask.mockResolvedValueOnce(false);
			await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(implementationTrigger()),
			);
			expect(phaseCalls[0].args).toMatchObject({ cli: 'claude', model: 'opus' });
		});

		it('assumes planned when the planning history lookup fails', async () => {
			projectLookup = () =>
				createMockProjectConfig({
					agents: {
						implementation: { cli: 'claude', model: 'opus' },
						implementationUnplanned: { cli: 'codex', model: 'gpt-5.6-terra' },
					},
				});
			hasCompletedRunForTask.mockRejectedValueOnce(new Error('postgres down'));

			await expect(
				processJob(
					createMockGitHubProjectsWebhookJob(),
					registryReturning(implementationTrigger()),
				),
			).resolves.toMatchObject({ status: 'phase-succeeded' });
			expect(phaseCalls[0].args).toMatchObject({ cli: 'claude', model: 'opus' });
		});

		it('does not query planning history for non-implementation phases', async () => {
			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(hasCompletedRunForTask).not.toHaveBeenCalledWith(PROJECT.id, '17', 'planning');
		});
	});

	it('passes undefined cli and the default model when the project has no agents override, leaving phase on coded default CLI but resolving default model', async () => {
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.cli).toBeUndefined();
		expect(phaseCalls[0].args.model).toBe('sonnet');
	});

	it('resolves model to the project defaults block when phase override omits model', async () => {
		const projectWithDefaults = createMockProjectConfig({
			agents: {
				defaults: { claude: 'opus' },
				planning: { cli: 'claude' },
			},
		});
		projectLookup = () => projectWithDefaults;
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.cli).toBe('claude');
		expect(phaseCalls[0].args.model).toBe('opus');
	});

	it('resolves model to the global defaults when the project has none', async () => {
		getAppSettings.mockResolvedValue({ agents: { defaults: { claude: 'opus' } } });
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		// No project override at all → the global default wins over the coded default.
		expect(phaseCalls[0].args.model).toBe('opus');
	});

	it('prefers the project default over the global default', async () => {
		getAppSettings.mockResolvedValue({ agents: { defaults: { claude: 'haiku' } } });
		const projectWithDefaults = createMockProjectConfig({
			agents: { defaults: { claude: 'opus' }, planning: { cli: 'claude' } },
		});
		projectLookup = () => projectWithDefaults;
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.model).toBe('opus');
	});

	it('prefers the per-phase model over both project and global defaults', async () => {
		getAppSettings.mockResolvedValue({ agents: { defaults: { claude: 'haiku' } } });
		const projectWithDefaults = createMockProjectConfig({
			agents: {
				defaults: { claude: 'opus' },
				planning: { cli: 'claude', model: 'sonnet' },
			},
		});
		projectLookup = () => projectWithDefaults;
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.model).toBe('sonnet');
	});

	it('falls back to the coded default when neither project nor global sets one', async () => {
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.model).toBe('sonnet');
	});

	it('still runs the phase on coded defaults when the settings load fails', async () => {
		getAppSettings.mockRejectedValueOnce(new Error('db down'));
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning(trigger),
		);

		expect(outcome.status).toBe('phase-succeeded');
		expect(phaseCalls[0].args.model).toBe('sonnet');
	});

	// The ordering/fallback rules themselves are unit-tested in
	// `tests/unit/worker/target-selection.test.ts`; these assert the wiring — that
	// the routed target is what the phase actually runs and what the run row records.
	describe('capability-aware target routing (issue #346)', () => {
		function quota(cli: AgentCli, status: CliQuotaSnapshot['status']): CliQuotaSnapshot {
			return { cli, status, source: 'live', lastUpdated: '2026-07-21T00:00:00.000Z' };
		}
		const planningTrigger = (): TriggerResult => ({
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		});
		// A two-target Planning phase: codex preferred, claude as the alternative.
		// The schema derives the `cli`/`model` mirror from `targets[0]`.
		const twoTargetProject = () =>
			createMockProjectConfig({
				agents: {
					planning: {
						targets: [
							{ cli: 'codex', model: 'gpt-5.6-terra' },
							{ cli: 'claude', model: 'opus', reasoning: 'high' },
						],
					},
				},
			});

		it('runs the preferred target when this worker can run its CLI', async () => {
			projectLookup = twoTargetProject;
			getAllCliQuotas.mockResolvedValue([
				quota('codex', 'available'),
				quota('claude', 'available'),
			]);

			await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(planningTrigger()));

			expect(phaseCalls[0].args).toMatchObject({ cli: 'codex', model: 'gpt-5.6-terra' });
		});

		it('routes to the next target when the preferred CLI is unavailable here', async () => {
			projectLookup = twoTargetProject;
			getAllCliQuotas.mockResolvedValue([
				quota('codex', 'unavailable'),
				quota('claude', 'available'),
			]);

			await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(planningTrigger()));

			expect(phaseCalls[0].args).toMatchObject({
				cli: 'claude',
				model: 'opus',
				reasoning: 'high',
			});
			// The run row must record what actually ran, not the preferred target.
			expect(createRun).toHaveBeenCalledWith(
				expect.objectContaining({ engine: 'claude', model: 'opus', reasoning: 'high' }),
			);
		});

		it('keeps the preferred target when no configured CLI is available', async () => {
			projectLookup = twoTargetProject;
			getAllCliQuotas.mockResolvedValue([
				quota('codex', 'unavailable'),
				quota('claude', 'unavailable'),
			]);

			await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(planningTrigger()));

			// Fail visibly on spawn rather than silently skip the phase.
			expect(phaseCalls[0].args).toMatchObject({ cli: 'codex', model: 'gpt-5.6-terra' });
		});

		it('keeps the preferred target when the capability lookup fails', async () => {
			projectLookup = twoTargetProject;
			getAllCliQuotas.mockRejectedValue(new Error('postgres down'));

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(planningTrigger()),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(phaseCalls[0].args).toMatchObject({ cli: 'codex', model: 'gpt-5.6-terra' });
		});

		it('lets a per-run override win over routing', async () => {
			projectLookup = twoTargetProject;
			// codex is unavailable, but the run explicitly pins it (a manual retry).
			getAllCliQuotas.mockResolvedValue([
				quota('codex', 'unavailable'),
				quota('claude', 'available'),
			]);

			await processJob(
				createMockGitHubProjectsWebhookJob({
					cliOverride: 'codex',
					modelOverride: 'gpt-5.6-sol',
				}),
				registryReturning(planningTrigger()),
			);

			expect(phaseCalls[0].args).toMatchObject({ cli: 'codex', model: 'gpt-5.6-sol' });
		});
	});

	it("threads the project's Planning autoAdvance setting into the phase call", async () => {
		const projectWithPipeline = createMockProjectConfig({
			pipeline: { planning: { autoAdvance: true } },
		});
		projectLookup = () => projectWithPipeline;

		await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({
				phase: 'planning',
				taskId: '10',
				workItem: createMockWorkItem({ statusId: '61e4505c' }),
			}),
		);
		expect(phaseCalls[0].args.autoAdvance).toBe(true);
	});

	it('passes undefined Planning autoAdvance when the project has no override', async () => {
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockGitHubProjectsWebhookJob(), registryReturning(trigger));

		expect(phaseCalls[0].args.autoAdvance).toBeUndefined();
	});

	it('threads a shutdown-linked per-run signal through to the phase', async () => {
		// The phase now receives a per-run signal (so a single run can be terminated
		// independently, issue #166) that is *linked* to the worker's shutdown signal
		// rather than being the same object — aborting shutdown still aborts the run.
		const controller = new AbortController();
		let phaseSignal: AbortSignal | undefined;
		phaseImpl = async (_phase, args) => {
			phaseSignal = args.signal as AbortSignal | undefined;
			return { agent: agentResult() };
		};

		await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
			controller.signal,
		);

		expect(phaseSignal).toBeInstanceOf(AbortSignal);
		expect(phaseSignal).not.toBe(controller.signal);
	});

	it('aborts the in-flight phase signal when the worker shutdown signal fires', async () => {
		const controller = new AbortController();
		let phaseSignal: AbortSignal | undefined;
		phaseImpl = async (_phase, args) => {
			phaseSignal = args.signal as AbortSignal | undefined;
			// Fire shutdown mid-run; the linked per-run signal must abort too.
			controller.abort();
			return { agent: agentResult() };
		};

		await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
			controller.signal,
		);

		expect(phaseSignal?.aborted).toBe(true);
	});

	it('reports a phase failure as phase-failed, not a thrown error', async () => {
		phaseImpl = async () => {
			throw new Error('review agent exited with code 3');
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome).toEqual({
			status: 'phase-failed',
			phase: 'review',
			taskId: '17',
			error: 'review agent exited with code 3',
		});
	});

	it('posts a failure comment on the backing issue when a work-item phase fails terminally', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new Error("implementation agent (antigravity) exited with code 1 for task '100'");
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledTimes(1);
		const [itemId, body] = addComment.mock.calls[0];
		expect(itemId).toBe(workItem.id);
		expect(body).toContain('SWARM run failed');
		expect(body).toContain('**implementation**');
		expect(body).toContain("exited with code 1 for task '100'");
		expect(body).not.toContain('splitting the issue');
	});

	it('reports an early provider stall rather than claiming an unproven scope problem', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError('stalled', { kind: 'stalled' });
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob({ rateLimitRetryAttempt: 6 }),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledTimes(1);
		const [, body] = addComment.mock.calls[0];
		expect(body).toContain('Provider stalled early');
		expect(body).toContain(
			'The agent provider stalled before meaningful work began; retry later or use another configured provider.',
		);
		expect(body).not.toContain('likely exceeds the single-task scope');
	});

	it('reports a terminal response stall as likely scope exceeded only with prior scope and progress evidence', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		getLatestCompletedPlanningScope.mockResolvedValue({
			whyOneTask: 'The changes need one coordinated delivery.',
			independentConcerns: ['worker diagnosis', 'dashboard presentation'],
			affectedAreas: ['worker', 'web'],
			outOfScope: [],
		});
		phaseImpl = async () => {
			throw new AgentRunError(
				'stalled',
				{ kind: 'stalled' },
				agentResult({
					durationMs: 10 * 60 * 1000,
					stdout: `${'x'.repeat(1_000)}\nError: timeout waiting for response`,
				}),
			);
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob({ rateLimitRetryAttempt: 6 }),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome).toMatchObject({
			status: 'phase-failed',
			failureDiagnosis: { kind: 'likely-scope-exceeded' },
		});
		expect(getLatestCompletedPlanningScope).toHaveBeenCalledWith(PROJECT.id, '100');
		const [, body] = addComment.mock.calls[0];
		expect(body).toContain('Likely scope exceeded');
		expect(body).toContain(
			'The agent stalled after substantial progress. This task likely exceeds the single-task scope; narrow or split it before retrying.',
		);
		expect(completeRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				failureDiagnosis: expect.objectContaining({ kind: 'likely-scope-exceeded' }),
			}),
		);
	});

	it('defers a timeout agent run for a resume retry instead of failing it', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			// A genuinely-killed timeout always carries an agent result (exit null).
			throw new AgentRunError(
				'timeout',
				{ kind: 'timeout' },
				agentResult({ exitCode: null, timedOut: true, sessionId: 'sess-100' }),
			);
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		// Timeout is now recoverable: the run resumes rather than failing outright,
		// so no terminal failure comment is posted.
		expect(outcome.status).toBe('phase-deferred');
		expect(outcome).toMatchObject({ resumable: true });
		expect(addComment).not.toHaveBeenCalled();
	});

	it('does not append splitting suggestion for a non-stalled AgentRunError', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError('some other agent failure', { kind: 'error' });
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledTimes(1);
		const [, body] = addComment.mock.calls[0];
		expect(body).not.toContain('splitting the issue');
	});

	it('does not comment on a deferred (rate-limited) failure — the run will retry', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError('rate limited', { kind: 'rate-limit' });
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-deferred');
		expect(addComment).not.toHaveBeenCalled();
	});

	it('defers a dependency-blocked Implementation as a token-free re-check without commenting', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new DependencyBlockedError(workItem, [
				{
					reference: '#319',
					url: 'https://github.com/o/r/issues/319',
					title: 'Session auth',
					open: true,
					source: 'dependency',
				},
			]);
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		// Deferred (not failed), on its own dependency-recheck cadence, and — while it
		// waits — no "failed" comment is posted on the item.
		expect(outcome).toMatchObject({ status: 'phase-deferred', dependencyRecheck: true });
		if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
		expect(outcome.reason).toContain('#319');
		expect(addComment).not.toHaveBeenCalled();
	});

	it('does not consume the rate-limit budget while waiting on a dependency', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new DependencyBlockedError(workItem, [
				{ reference: '#7', url: 'u', title: 't', open: true, source: 'dependency' },
			]);
		};

		// A run that had already exhausted the rate-limit budget still defers on a
		// dependency block — the two budgets are separate.
		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob({ rateLimitRetryAttempt: 6 }),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-deferred');
	});

	it('fails a still-blocked dependency once the re-check budget is exhausted, posting the reason', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new DependencyBlockedError(workItem, [
				{
					reference: '#319',
					url: 'https://github.com/o/r/issues/319',
					title: 'Session auth',
					open: true,
					source: 'dependency',
				},
			]);
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob({ dependencyRecheckAttempt: 1_000_000 }),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledOnce();
		const [, body] = addComment.mock.calls[0];
		expect(body).toContain('#319');
		expect(body).toMatch(/must be done first/i);
	});

	describe('federated dispatch gate (issue #339)', () => {
		const ALICE = '11111111-1111-4111-8111-111111111111';
		const BOB = '22222222-2222-4222-8222-222222222222';

		function candidate(
			id: string,
			overrides: {
				ownerUserId?: string;
				capabilities?: AgentCli[];
				sharingConsent?: boolean;
				activeRuns?: number;
			} = {},
		): WorkerDispatchCandidate {
			const capabilities = overrides.capabilities ?? ['claude'];
			return {
				worker: {
					id,
					ownerUserId: overrides.ownerUserId ?? ALICE,
					displayName: `worker-${id}`,
					capabilities,
					createdAt: new Date('2026-01-01T00:00:00Z'),
					updatedAt: new Date('2026-01-01T00:00:00Z'),
				},
				enrollment: {
					id: `enr-${id}`,
					workerId: id,
					projectId: 'swarm',
					status: 'active',
					allowedClis: capabilities,
					concurrencyAllocation: 1,
					sharingConsent: overrides.sharingConsent ?? true,
					createdAt: new Date('2026-01-01T00:00:00Z'),
					updatedAt: new Date('2026-01-01T00:00:00Z'),
				},
				availability: { connected: true, activeRuns: overrides.activeRuns ?? 0 },
			};
		}

		const assignedItem = () =>
			createMockWorkItem({ statusId: '61e4505c', assignees: [{ handle: 'octocat' }] });
		const planningTrigger = (workItem = assignedItem()): TriggerResult => ({
			phase: 'planning',
			taskId: '10',
			workItem,
		});
		const executionIdentity = (workerId: string) => ({
			workerId,
			sessionId: `session-${workerId}`,
			fencingToken: 7,
			heartbeatTtlMs: 60_000,
		});

		it('runs the phase locally for an unfederated project (no enrolled workers)', async () => {
			// The single-local-worker MVP is untouched by the gate: with nothing
			// enrolled there is no other machine to gate, so the phase just runs.
			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(planningTrigger()),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(phaseCalls).toHaveLength(1);
		});

		it('defers before provisioning anything when no eligible worker may take it', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				candidate('w-1', { sharingConsent: false }),
			]);

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(planningTrigger()),
			);

			// A token-free wait: no agent invoked, no run row, no dispatch lease
			// renewal — and no premature "failed" comment on the item.
			expect(outcome).toMatchObject({ status: 'phase-deferred', workerEligibilityRecheck: true });
			expect(phaseCalls).toEqual([]);
			expect(createRun).not.toHaveBeenCalled();
			expect(markDispatchRunning).not.toHaveBeenCalled();
			expect(addComment).not.toHaveBeenCalled();
		});

		it('records the wait durably as worker-eligibility on its own budget', async () => {
			listProjectDispatchCandidates.mockResolvedValue([candidate('w-1', { activeRuns: 1 })]);

			await processJob(
				createMockGitHubProjectsWebhookJob({ rateLimitRetryAttempt: 3 }),
				registryReturning(planningTrigger()),
			);

			expect(scheduleDispatchRetry).toHaveBeenCalledOnce();
			const [, input] = scheduleDispatchRetry.mock.calls[0] as [string, Record<string, unknown>];
			expect(input).toMatchObject({ waitReason: 'worker-eligibility', attempt: 1 });
			// The rate-limit budget is untouched: waiting for a worker is not a failure.
			expect(input.jobPayload).toMatchObject({
				workerEligibilityRecheckAttempt: 1,
				rateLimitRetryAttempt: 3,
			});
		});

		it('fails with the actionable reason once the re-check budget is exhausted', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				candidate('w-1', { sharingConsent: false }),
			]);

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob({ workerEligibilityRecheckAttempt: 1_000_000 }),
				registryReturning(planningTrigger()),
			);

			expect(outcome.status).toBe('phase-failed');
			expect(addComment).toHaveBeenCalledOnce();
			const [, body] = addComment.mock.calls[0];
			expect(body).toMatch(/sharing consent/i);
		});

		it('never routes an assigned item to another user’s free worker', async () => {
			listProjectDispatchCandidates.mockResolvedValue([candidate('w-bob', { ownerUserId: BOB })]);
			resolveAssignedUser.mockResolvedValue({
				user: { id: ALICE, identifier: 'octocat', displayName: 'octocat' } as SwarmUser,
				assignee: { handle: 'octocat' },
			});

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(planningTrigger()),
			);

			expect(outcome).toMatchObject({ status: 'phase-deferred', workerEligibilityRecheck: true });
			expect(phaseCalls).toEqual([]);
		});

		it('refuses execution when a different authenticated worker host dequeues the job', async () => {
			listProjectDispatchCandidates.mockResolvedValue([candidate('w-alice')]);
			claimWorkerForDispatch.mockResolvedValue({
				claimed: false,
				reason: 'wrong-worker-host',
			});

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(planningTrigger()),
				undefined,
				executionIdentity('w-bob'),
			);

			expect(outcome).toMatchObject({ status: 'phase-deferred', workerEligibilityRecheck: true });
			expect(claimWorkerForDispatch).toHaveBeenCalledWith(
				expect.objectContaining({
					selectedWorkerId: 'w-alice',
					executionWorkerId: 'w-bob',
				}),
			);
			expect(phaseCalls).toEqual([]);
			expect(createRun).not.toHaveBeenCalled();
			expect(markDispatchRunning).not.toHaveBeenCalled();
		});

		it('re-checks on every dispatch, so a revocation blocks the next attempt only', async () => {
			listProjectDispatchCandidates.mockResolvedValue([candidate('w-1')]);
			const first = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(planningTrigger()),
				undefined,
				executionIdentity('w-1'),
			);
			expect(first.status).toBe('phase-succeeded');

			// Consent is revoked between attempts: the already-finished run keeps its
			// result, and only the *next* dispatch is refused.
			listProjectDispatchCandidates.mockResolvedValue([
				candidate('w-1', { sharingConsent: false }),
			]);
			const second = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning({ ...planningTrigger(), taskId: '11' }),
			);

			expect(second).toMatchObject({ status: 'phase-deferred', workerEligibilityRecheck: true });
			expect(phaseCalls).toHaveLength(1);
		});

		it('dispatches the exact target the gate selected, not the preferred one', async () => {
			// Target priority first, worker order second: only a claude worker is
			// enrolled, so the codex-preferred phase runs its claude target — and the
			// run row records that same target.
			projectLookup = () =>
				createMockProjectConfig({
					agents: {
						planning: {
							targets: [
								{ cli: 'codex', model: 'gpt-5.6-terra' },
								{ cli: 'claude', model: 'opus', reasoning: 'high' },
							],
						},
					},
				});
			listProjectDispatchCandidates.mockResolvedValue([
				candidate('w-claude', { capabilities: ['claude'] }),
			]);

			await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(planningTrigger()),
				undefined,
				executionIdentity('w-claude'),
			);

			expect(phaseCalls[0].args).toMatchObject({
				cli: 'claude',
				model: 'opus',
				reasoning: 'high',
			});
			expect(createRun).toHaveBeenCalledWith(
				expect.objectContaining({
					workerId: 'w-claude',
					workerFencingToken: 7,
					engine: 'claude',
					model: 'opus',
					reasoning: 'high',
				}),
			);
		});

		describe('local single-user mode (issue #373)', () => {
			it('runs every phase on the host worker, ignoring an enrolled non-consenting worker', async () => {
				// An install in single-user mode treats the host process as the implicit
				// local executor for every project: dispatch skips the federated roster
				// entirely, so an enrolled worker that would fail the gate (here, no
				// sharing consent) never blocks — the phase just runs locally.
				vi.stubEnv('SWARM_SINGLE_USER_MODE', 'true');
				listProjectDispatchCandidates.mockResolvedValue([
					candidate('w-1', { sharingConsent: false }),
				]);

				const outcome = await processJob(
					createMockGitHubProjectsWebhookJob(),
					registryReturning(planningTrigger()),
				);

				expect(outcome.status).toBe('phase-succeeded');
				expect(phaseCalls).toHaveLength(1);
				// No federated evaluation at all: neither the roster nor the assignee
				// link is read, and no worker claim is ever attempted.
				expect(listProjectDispatchCandidates).not.toHaveBeenCalled();
				expect(resolveAssignedUser).not.toHaveBeenCalled();
				expect(claimWorkerForDispatch).not.toHaveBeenCalled();
				// The normal local project slot is used, exactly as an unfederated project.
				expect(acquireProjectSlot).toHaveBeenCalledWith(PROJECT.id, PROJECT.maxConcurrentJobs);
				// A local dispatch binds no worker identity onto its run row.
				expect(createRun).toHaveBeenCalledWith(
					expect.objectContaining({ workerId: undefined, workerFencingToken: undefined }),
				);
			});

			it('restores the full federated gate for the same roster when the mode is disabled', async () => {
				// The paired control: with the mode off (the safe default), the same
				// enrolled-but-non-consenting worker still produces today's token-free
				// worker-eligibility deferral, proving disabling the mode restores the
				// complete federated policy.
				listProjectDispatchCandidates.mockResolvedValue([
					candidate('w-1', { sharingConsent: false }),
				]);

				const outcome = await processJob(
					createMockGitHubProjectsWebhookJob(),
					registryReturning(planningTrigger()),
				);

				expect(outcome).toMatchObject({
					status: 'phase-deferred',
					workerEligibilityRecheck: true,
				});
				expect(phaseCalls).toEqual([]);
				// The gate ran — the roster *was* consulted, unlike enabled mode.
				expect(listProjectDispatchCandidates).toHaveBeenCalledWith(PROJECT.id);
			});
		});
	});

	it('defers a capacity failure briefly without posting a failure comment', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError('model at capacity', { kind: 'capacity' });
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome).toMatchObject({ status: 'phase-deferred', retryDelayMs: 6 * 60 * 1000 });
		expect(addComment).not.toHaveBeenCalled();
	});

	it('fails capacity after two retries and suggests configuring a different model', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError('Implementation agent (codex) exited (model at capacity)', {
				kind: 'capacity',
			});
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob({ rateLimitRetryAttempt: 2 }),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledOnce();
		const [, body] = addComment.mock.calls[0];
		expect(body).toContain('Known provider condition: model capacity');
		expect(body).toContain('reported at capacity');
		expect(body).toContain('different model');
		expect(completeRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				failureDiagnosis: expect.objectContaining({ kind: 'provider-capacity' }),
			}),
		);
	});

	it('does not comment for a PR-driven phase failure (no backing work item)', async () => {
		phaseImpl = async () => {
			throw new Error('review agent exited with code 3');
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).not.toHaveBeenCalled();
	});

	it('still reports phase-failed when the failure comment itself fails to post', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		addComment.mockRejectedValue(new Error('github 502'));
		phaseImpl = async () => {
			throw new Error('implementation agent exited with code 1');
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledTimes(1);
	});

	it('defers a rate-limited phase instead of failing it, delaying until after the reset', async () => {
		const retryAfter = new Date(Date.now() + 90 * 60 * 1000); // 90 min out
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 1 (rate limited)', {
				kind: 'rate-limit',
				resetHint: '1:40pm (Europe/Warsaw)',
				retryAfter,
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-deferred');
		if (outcome.status !== 'phase-deferred') throw new Error('unreachable');
		expect(outcome.phase).toBe('review');
		expect(outcome.taskId).toBe('17');
		expect(outcome.attempt).toBe(0);
		// ~90 min + a small buffer, comfortably inside the [6min, 6h] clamp.
		expect(outcome.retryDelayMs).toBeGreaterThan(90 * 60 * 1000);
		expect(outcome.retryDelayMs).toBeLessThan(92 * 60 * 1000);
	});

	it('floors the retry delay above the review-dispatch-dedup TTL even for an imminent reset', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('rate limited', {
				kind: 'rate-limit',
				retryAfter: new Date(Date.now() + 1000), // resets ~now
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
		expect(outcome.retryDelayMs).toBeGreaterThanOrEqual(6 * 60 * 1000);
	});

	it('falls back to a default delay when the limit gave no parseable reset time', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('rate limited', { kind: 'rate-limit' });
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
		expect(outcome.retryDelayMs).toBe(30 * 60 * 1000);
	});

	it('carries the created run row id on the deferred outcome and preserves its cancellation marker', async () => {
		// createRun resolves 'run-1' (see the top-level mock); a deferral must
		// surface that id so `reenqueueDeferred` threads it onto the retry job and
		// the retry resets this same row instead of inserting a new one (issue #136).
		// The marker must survive this return: termination can race the queue hand-off
		// and `reenqueueDeferred` is responsible for observing it before retrying.
		phaseImpl = async () => {
			throw new AgentRunError('rate limited', { kind: 'rate-limit' });
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
		expect(outcome.runId).toBe('run-1');
		expect(clearRunCancellation).not.toHaveBeenCalledWith('run-1');
	});

	it('fails a rate-limited phase once the retry budget is exhausted', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 1 (rate limited)', {
				kind: 'rate-limit',
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob({ rateLimitRetryAttempt: 6 }),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome).toMatchObject({
			status: 'phase-failed',
			phase: 'review',
			taskId: '17',
			error: 'Review agent (claude) exited with code 1 (rate limited)',
			failureDiagnosis: { kind: 'provider-rate-limit' },
		});
	});

	it('does not defer a non-rate-limit AgentRunError', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 1', { kind: 'error' });
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-failed');
	});

	it('defers a stalled phase instead of failing it, using minimum delayed-retry floor', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (antigravity) exited with code 1 (stalled)', {
				kind: 'stalled',
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-deferred');
		if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
		expect(outcome.phase).toBe('review');
		expect(outcome.taskId).toBe('17');
		expect(outcome.attempt).toBe(0);
		expect(outcome.retryDelayMs).toBe(6 * 60 * 1000); // MIN_RETRY_DELAY_MS
		expect(outcome.resumable).toBe(true);
	});

	it('fails a stalled phase once the retry budget is exhausted', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (antigravity) exited with code 1 (stalled)', {
				kind: 'stalled',
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob({ rateLimitRetryAttempt: 6 }),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome).toMatchObject({
			status: 'phase-failed',
			phase: 'review',
			taskId: '17',
			error: 'Review agent (antigravity) exited with code 1 (stalled)',
			failureDiagnosis: { kind: 'provider-stalled-early' },
		});
	});

	it('retains the case that an ordinary exit-1 remains terminal', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 1', { kind: 'error' });
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-failed');
	});

	it('defers an aborted phase (worker shutdown mid-run) with the dedup-safe floor delay', async () => {
		// A run the worker itself killed (e.g. a dev --watch restart) has no reset
		// hint — it must still land above the review-dispatch-dedup TTL, same as a
		// rate-limit retry, not the rate-limit path's 30-min no-hint default.
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 143 (aborted)', {
				kind: 'aborted',
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-deferred');
		if (outcome.status !== 'phase-deferred') throw new Error('unreachable');
		expect(outcome.attempt).toBe(0);
		expect(outcome.retryDelayMs).toBe(6 * 60 * 1000);
	});

	it('defers delivery failures with their underlying cause and an honest log label', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		phaseImpl = async () => {
			throw new DeliveryDeferredError('Implementation delivery deferred for retry', {
				cause: new Error("pre-push hook failed: Cannot find package 'react'"),
			});
		};

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({
				phase: 'implementation',
				taskId: '216',
				workItem: createMockWorkItem(),
			}),
		);

		expect(outcome).toMatchObject({
			status: 'phase-deferred',
			resumable: false,
			resumeDelivery: true,
			reason:
				"Implementation delivery deferred for retry ← pre-push hook failed: Cannot find package 'react'",
		});
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('delivery failed'),
			expect.objectContaining({
				error:
					"Implementation delivery deferred for retry ← pre-push hook failed: Cannot find package 'react'",
			}),
		);
		warn.mockRestore();
	});

	it('fails an aborted phase once the retry budget is exhausted', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 143 (aborted)', {
				kind: 'aborted',
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob({ rateLimitRetryAttempt: 6 }),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome).toMatchObject({
			status: 'phase-failed',
			phase: 'review',
			taskId: '17',
			error: 'Review agent (claude) exited with code 143 (aborted)',
			failureDiagnosis: { kind: 'worker-shutdown' },
		});
	});

	it('registers a per-run abort controller and threads its signal into the phase', async () => {
		let seenSignal: AbortSignal | undefined;
		phaseImpl = async (_phase, args) => {
			seenSignal = args.signal as AbortSignal | undefined;
			return { agent: agentResult() };
		};

		await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

		expect(registerRunController).toHaveBeenCalledWith('run-1', expect.any(AbortController));
		expect(seenSignal).toBeInstanceOf(AbortSignal);
		// Cleanup: the controller is unregistered and the flag cleared on settle.
		expect(unregisterRunController).toHaveBeenCalledWith('run-1');
		expect(clearRunCancellation).toHaveBeenCalledWith('run-1');
	});

	it('settles a marker-only cancellation as a terminal failure, not a deferral', async () => {
		// A cancellation was requested: an aborted run that would normally defer must
		// instead fail terminally with the neutral cancellation reason (issue #166,
		// #305), flagged structurally rather than by comparing the error string.
		isRunCancellationRequested.mockResolvedValue(true);
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 143 (aborted)', {
				kind: 'aborted',
			});
		};

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome).toMatchObject({
			status: 'phase-failed',
			phase: 'review',
			taskId: '17',
			error: 'Run cancelled after a cancellation request.',
			failureDiagnosis: { kind: 'user-terminated' },
			cancelled: true,
		});
		// An intentional stop isn't a stall — no board/PR "failed" comment is posted.
		expect(commentOnPullRequest).not.toHaveBeenCalled();
		// The failed row records the neutral cancellation reason, and — since the
		// marker carried no origin — persists a `null` cancellation rather than
		// inferring one (issue #308).
		expect(completeRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				status: 'failed',
				error: 'Run cancelled after a cancellation request.',
				cancellation: null,
			}),
		);
		// The dispatch is cancelled (not failed), so nothing resurrects it.
		expect(cancelClaimedDispatch).toHaveBeenCalledWith(
			expect.any(String),
			'Run cancelled after a cancellation request.',
		);
		expect(failDispatch).not.toHaveBeenCalled();
	});

	it('persists a recorded cancellation origin on the failed run (issue #308)', async () => {
		isRunCancellationRequested.mockResolvedValue(true);
		const origin: CancellationOrigin = {
			source: 'dashboard',
			requestedAt: '2026-07-19T00:00:00.000Z',
		};
		getRunCancellationOrigin.mockResolvedValue(origin);
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 143 (aborted)', {
				kind: 'aborted',
			});
		};

		await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

		expect(completeRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				status: 'failed',
				error: 'Run cancelled after a cancellation request.',
				cancellation: origin,
			}),
		);
	});

	it('reconciles a terminated run’s checkout and cleans it when there is no session (issue #361)', async () => {
		isRunCancellationRequested.mockResolvedValue(true);
		reconcileTerminatedWorktree.mockResolvedValue({ outcome: 'removed' });
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 143 (aborted)', {
				kind: 'aborted',
			});
		};

		await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

		// The settlement removed a clean checkout: no recovery state, and — crucially —
		// no session id survives the removed checkout.
		expect(completeRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({ status: 'failed', recovery: null, agentSessionId: null }),
		);
		// Reconciled as a run that owned its own worktree lease (stoppedRunHeldLease=true).
		expect(reconcileTerminatedWorktree).toHaveBeenCalledWith(
			expect.anything(),
			PROJECT.id,
			'17',
			null,
			true,
		);
	});

	it('preserves a terminated run’s checkout and session when reconciliation preserves it (issue #361)', async () => {
		isRunCancellationRequested.mockResolvedValue(true);
		getRunByIdFromDb.mockResolvedValue({ agentSessionId: 'sess-live' });
		reconcileTerminatedWorktree.mockResolvedValue({
			outcome: 'preserved',
			agentSessionId: 'sess-live',
		});
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 143 (aborted)', {
				kind: 'aborted',
			});
		};

		await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

		expect(completeRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				status: 'failed',
				agentSessionId: 'sess-live',
				recovery: { state: 'preserved', agentSessionId: 'sess-live' },
			}),
		);
	});

	it('records a blocked recovery reason when protected work cannot be removed (issue #361)', async () => {
		isRunCancellationRequested.mockResolvedValue(true);
		reconcileTerminatedWorktree.mockResolvedValue({ outcome: 'blocked', blockedReason: 'dirty' });
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 143 (aborted)', {
				kind: 'aborted',
			});
		};

		await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

		expect(completeRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				status: 'failed',
				agentSessionId: null,
				recovery: { state: 'blocked', blockedReason: 'dirty' },
			}),
		);
	});

	it('aborts before running the agent when cancellation was requested at pickup', async () => {
		// A deferred run terminated in the window between its retry being dequeued and
		// the phase starting: the start-check aborts the controller so the phase gets
		// an already-aborted signal.
		isRunCancellationRequested.mockResolvedValue(true);
		let signalAborted = false;
		phaseImpl = async (_phase, args) => {
			signalAborted = (args.signal as AbortSignal | undefined)?.aborted ?? false;
			return { agent: agentResult() };
		};

		await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

		expect(signalAborted).toBe(true);
	});

	it('terminally fails a blocked worktree collision without deferring, persisting the reason (issue #367)', async () => {
		phaseImpl = async () => {
			throw new BlockedRecoveryError(
				'dirty',
				"Worktree collision for task '17': the existing checkout has uncommitted changes",
			);
		};

		commentOnPullRequest.mockClear();
		completeRun.mockClear();

		const outcome = await processJob(
			createMockGitHubWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
		);

		// Terminal, not deferred — no retry is scheduled for a protected collision.
		expect(outcome.status).toBe('phase-failed');
		// The blocked reason is persisted on the run's recovery state so the
		// dashboard can render recovery guidance (Phase 3).
		expect(completeRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				status: 'failed',
				recovery: { state: 'blocked', blockedReason: 'dirty' },
			}),
		);
		// The actionable reason is surfaced on the PR for a human to resolve.
		expect(commentOnPullRequest).toHaveBeenCalledTimes(1);
		expect(commentOnPullRequest.mock.calls[0][2]).toContain('uncommitted changes');
	});

	it('never defers a blocked worktree collision, even on the first attempt', async () => {
		phaseImpl = async () => {
			throw new BlockedRecoveryError('resumable-owner', 'blocked collision');
		};

		completeRun.mockClear();

		const outcome = await processJob(
			createMockGitHubWebhookJob({ rateLimitRetryAttempt: 0 }),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(outcome.status).toBe('phase-failed');
		// A `phase-deferred` outcome would carry a retryDelayMs; a blocked collision
		// must never produce one.
		expect(outcome).not.toHaveProperty('retryDelayMs');
		expect(completeRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				status: 'failed',
				recovery: { state: 'blocked', blockedReason: 'resumable-owner' },
			}),
		);
	});

	it('reports a blocked worktree collision on the PM board for a board-driven phase', async () => {
		const workItem = createMockWorkItem({ id: 'item-100' });
		phaseImpl = async () => {
			throw new BlockedRecoveryError(
				'unpushed',
				"Worktree collision for task '100': the existing checkout has unpushed commits",
			);
		};

		addComment.mockClear();

		const outcome = await processJob(
			createMockGitHubProjectsWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledTimes(1);
		expect(addComment.mock.calls[0][0]).toBe('item-100');
		expect(addComment.mock.calls[0][1]).toContain('unpushed commits');
	});

	describe('automation-label gate (issue #131)', () => {
		// A board-driven phase only starts for a work item a human opted in by
		// labelling it. The gate sits at this single dispatch choke point, so it is
		// re-evaluated on every fresh webhook, retry, self-enqueued next phase, and
		// capacity promotion — but never terminates a run already in flight.

		function implementationTrigger(labels: { id: string; name: string }[]): TriggerResult {
			return {
				phase: 'implementation',
				taskId: '216',
				workItem: createMockWorkItem({ statusId: '61e4505c', labels }),
			};
		}

		it('runs the phase when the item carries the label', async () => {
			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(implementationTrigger([{ id: 'LA_1', name: 'swarm' }])),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(phaseCalls).toHaveLength(1);
		});

		it('runs the phase when the configured label appears beyond the former 50-item boundary', async () => {
			const dummyLabels = Array.from({ length: 50 }, (_, i) => ({
				id: `DUMMY_${i}`,
				name: `dummy-label-${i}`,
			}));
			const labels = [...dummyLabels, { id: 'LA_1', name: 'swarm' }];

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(implementationTrigger(labels)),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(phaseCalls).toHaveLength(1);
		});

		it('skips an unlabeled item without spending a slot, a worktree, or tokens', async () => {
			const info = vi.spyOn(logger, 'info').mockImplementation(() => {});

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(implementationTrigger([])),
			);

			expect(outcome).toMatchObject({
				status: 'skipped-not-eligible',
				phase: 'implementation',
				taskId: '216',
			});
			expect(phaseCalls).toEqual([]);
			expect(acquireProjectSlot).not.toHaveBeenCalled();
			expect(createRun).not.toHaveBeenCalled();
			expect(completeDispatch).toHaveBeenCalledWith('dispatch-1', 'skipped-not-eligible');
			// Still resolved on the dispatch first, so the Queue UI can name what was skipped.
			expect(recordDispatchResolution).toHaveBeenCalledWith('dispatch-1', '216', 'implementation');
			expect(info).toHaveBeenCalledWith(
				expect.stringContaining('missing the automation label'),
				expect.objectContaining({ label: 'swarm', taskId: '216' }),
			);
			info.mockRestore();
		});

		it('skips the next phase when the label is removed between phases, leaving the earlier run alone', async () => {
			const planned = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning({
					phase: 'planning',
					taskId: '216',
					workItem: createMockWorkItem({ statusId: '3fe662f4' }),
				}),
			);
			expect(planned.status).toBe('phase-succeeded');

			// The self-enqueued Implementation dispatch re-reads the item — the label
			// is gone by then.
			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(implementationTrigger([])),
			);

			expect(outcome.status).toBe('skipped-not-eligible');
			// The Planning run that was already dispatched is untouched — the gate is
			// dispatch-time only.
			expect(phaseCalls).toEqual([expect.objectContaining({ phase: 'planning' })]);
		});

		it('finalizes a retried run row instead of leaving it deferred', async () => {
			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob({ runId: 'run-7' }),
				registryReturning(implementationTrigger([])),
			);

			expect(outcome.status).toBe('skipped-not-eligible');
			expect(completeRun).toHaveBeenCalledWith(
				'run-7',
				expect.objectContaining({
					status: 'failed',
					error: expect.stringContaining('automation label'),
				}),
			);
		});

		it('dispatches an unlabeled item when the project disables the gate', async () => {
			projectLookup = () =>
				createMockProjectConfig({ pipeline: { automationLabel: '' } }) as ProjectConfig;

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(implementationTrigger([])),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(phaseCalls).toHaveLength(1);
		});

		it('honors a project-configured label instead of the default', async () => {
			projectLookup = () =>
				createMockProjectConfig({ pipeline: { automationLabel: 'automate' } }) as ProjectConfig;

			const skipped = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(implementationTrigger([{ id: 'LA_1', name: 'swarm' }])),
			);
			expect(skipped.status).toBe('skipped-not-eligible');

			const dispatched = await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning(implementationTrigger([{ id: 'LA_2', name: 'automate' }])),
			);
			expect(dispatched.status).toBe('phase-succeeded');
		});

		it('leaves the SCM continuation phases ungated (phase 2/2)', async () => {
			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
		});
	});

	describe('in-flight guard (duplicate-dispatch collision)', () => {
		// The bug: a duplicate `reordered`/`edited` webhook for the same card can be
		// dequeued after the pm-status dedup's TTL expired (having waited in the
		// queue behind long runs), re-dispatching the same phase for the same task
		// while the first run still holds the `task-<id>` worktree — the second
		// `provision()` then failed with "worktree already exists". The guard skips
		// the duplicate instead.

		it('skips a duplicate dispatch for a task already running here, without running the phase twice', async () => {
			// Park the first run's phase on a gate so it stays "in flight" while the
			// second job is processed.
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			phaseImpl = async () => {
				await gate;
				return { agent: agentResult() };
			};

			const first = processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
			// Let the first call get past its awaits (project lookup, dispatch) and into
			// runPhase, so it has registered taskId 17 as in-flight.
			await new Promise((r) => setTimeout(r, 0));

			const second = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(second).toEqual({ status: 'skipped-in-flight', phase: 'review', taskId: '17' });
			expect(phaseCalls).toHaveLength(1); // the phase ran once, not twice

			release?.();
			await first; // let the first run settle so it releases the slot before the next test
		});

		it('releases the slot after the phase settles, so a later dispatch for the same task runs', async () => {
			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
			expect(phaseCalls).toHaveLength(1);

			// Same taskId again, now that the first has finished — must not be skipped.
			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(phaseCalls).toHaveLength(2);
		});

		it('releases the slot even when the phase fails, so a retry for the same task can run', async () => {
			phaseImpl = async () => {
				throw new Error('boom');
			};
			const failed = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);
			expect(failed.status).toBe('phase-failed');

			phaseImpl = async () => ({ agent: agentResult() });
			const retried = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(retried.status).toBe('phase-succeeded');
		});

		it('does not block a different task from running concurrently', async () => {
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			phaseImpl = async (_phase, args) => {
				if (args.taskId === '17') await gate; // only task 17 parks
				return { agent: agentResult() };
			};

			const first = processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
			await new Promise((r) => setTimeout(r, 0));

			// A different taskId must run, not be skipped by task 17's in-flight slot.
			const other: TriggerResult = { ...REVIEW_TRIGGER, taskId: '18', prNumber: '18' };
			const second = await processJob(createMockGitHubWebhookJob(), registryReturning(other));

			expect(second.status).toBe('phase-succeeded');

			release?.();
			await first;
		});
	});

	describe('run-history tracking', () => {
		it('creates a run row then finalizes it completed with the agent result on success', async () => {
			phaseImpl = async () => ({
				agent: agentResult({
					exitCode: 0,
					timedOut: false,
					durationMs: 1234,
					stdout: 'o',
					stderr: 'e',
				}),
			});

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(createRun).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					projectId: PROJECT.id,
					taskId: '17',
					phase: 'review',
					workItemId: undefined,
					workItemTitle: undefined,
					workItemUrl: undefined,
					prNumber: '17',
					// Effective CLI resolved and persisted at creation (issue #169) — the
					// coded default here, since the review trigger carries no cli override.
					engine: 'claude',
					model: 'sonnet',
					jobPayload: expect.any(Object),
				}),
			);
			expect(completeRun).toHaveBeenCalledExactlyOnceWith('run-1', {
				status: 'completed',
				engine: 'claude',
				exitCode: 0,
				timedOut: false,
				durationMs: 1234,
				usage: undefined,
			});
			expect(storeRunLogs).toHaveBeenCalledExactlyOnceWith('run-1', 'o', 'e');
		});

		it('reuses and resets the existing run row when the job carries a runId (no new row)', async () => {
			const outcome = await processJob(
				createMockGitHubWebhookJob({ runId: 'run-1' }),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			// The retry resets the originating row rather than inserting a second one.
			expect(resetRunToRunning).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({ runId: 'run-1' }),
				undefined,
			);
			expect(createRun).not.toHaveBeenCalled();
			// The reused id is what gets finalized on completion.
			expect(completeRun).toHaveBeenCalledWith(
				'run-1',
				expect.objectContaining({ status: 'completed' }),
			);
		});

		it('falls back to creating a fresh row when the carried runId no longer exists', async () => {
			resetRunToRunning.mockResolvedValueOnce(false); // row was pruned

			const outcome = await processJob(
				createMockGitHubWebhookJob({ runId: 'run-gone' }),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(resetRunToRunning).toHaveBeenCalledExactlyOnceWith(
				'run-gone',
				expect.objectContaining({ runId: 'run-gone' }),
				undefined,
			);
			expect(createRun).toHaveBeenCalledOnce();
		});

		it('inserts a fresh row (no reset) for a job without a runId', async () => {
			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(resetRunToRunning).not.toHaveBeenCalled();
			expect(createRun).toHaveBeenCalledOnce();
		});

		it('records a job cli override as the fresh row engine (issue #169)', async () => {
			await processJob(
				createMockGitHubWebhookJob({ cliOverride: 'codex' }),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(createRun).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ engine: 'codex' }),
			);
		});

		it.each([
			'failed',
			'deferred',
		] as const)('reuses the latest %s row for a fresh webhook', async (status) => {
			getLatestRunForTask.mockResolvedValueOnce({ id: `run-${status}`, status } as never);

			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(getLatestRunForTask).toHaveBeenCalledWith(PROJECT.id, '17', 'review');
			expect(resetRunToRunning).toHaveBeenCalledWith(
				`run-${status}`,
				expect.objectContaining({ runId: `run-${status}` }),
				status,
			);
			expect(createRun).not.toHaveBeenCalled();
			expect(completeRun).toHaveBeenCalledWith(
				`run-${status}`,
				expect.objectContaining({ status: 'completed' }),
			);
		});

		it('creates a fresh row when the latest row is completed', async () => {
			getLatestRunForTask.mockResolvedValueOnce({
				id: 'run-completed',
				status: 'completed',
			} as never);

			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(resetRunToRunning).not.toHaveBeenCalled();
			expect(createRun).toHaveBeenCalledOnce();
		});

		it('creates a fresh row when another retry wins the terminal-row claim', async () => {
			getLatestRunForTask.mockResolvedValueOnce({ id: 'run-failed', status: 'failed' } as never);
			resetRunToRunning.mockResolvedValueOnce(false);

			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(createRun).toHaveBeenCalledOnce();
			expect(createRun).toHaveBeenCalledWith(
				expect.objectContaining({
					jobPayload: expect.not.objectContaining({ runId: 'run-failed' }),
				}),
			);
		});

		it('forwards the agent-reported token usage into completeRun on success', async () => {
			phaseImpl = async () => ({
				agent: agentResult({ usage: { inputTokens: 100, outputTokens: 50 } }),
			});

			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({ usage: { inputTokens: 100, outputTokens: 50 } }),
			);
		});

		it('forwards a completed Review run’s verdict into completeRun (issue #218)', async () => {
			phaseImpl = async () => ({ agent: agentResult(), verdict: 'request-changes' });

			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({ status: 'completed', reviewVerdict: 'request-changes' }),
			);
		});

		it('forwards a completed Review run’s safety-cap ordinal and automation outcome (issue #235)', async () => {
			phaseImpl = async () => ({
				agent: agentResult(),
				verdict: 'request-changes',
				reviewOrdinal: 2,
				automationOutcome: 'manual-intervention-required',
			});

			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({
					reviewOrdinal: 2,
					reviewAutomationOutcome: 'manual-intervention-required',
				}),
			);
		});

		describe('durable merge dispatch after an eligible approval (issue #292)', () => {
			const autoMergeProject = createMockProjectConfig({
				pipeline: { respondToReview: { autoMerge: true } },
			});

			it('persists a merge dispatch when the verdict is approve and autoMerge is on', async () => {
				projectLookup = () => autoMergeProject;
				phaseImpl = async () => ({ agent: agentResult(), verdict: 'approve' });

				await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

				expect(requestMergeAutomation).toHaveBeenCalledExactlyOnceWith({
					project: autoMergeProject,
					reviewRunId: 'run-1',
					taskId: '17',
					prNumber: '17',
					approvedHeadSha: 'deadbeef',
				});
			});

			it('does not persist a merge dispatch when autoMerge is off', async () => {
				phaseImpl = async () => ({ agent: agentResult(), verdict: 'approve' });

				await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

				expect(requestMergeAutomation).not.toHaveBeenCalled();
			});

			it('does not persist a merge dispatch for a non-approve verdict', async () => {
				projectLookup = () => autoMergeProject;
				phaseImpl = async () => ({ agent: agentResult(), verdict: 'request-changes' });

				await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

				expect(requestMergeAutomation).not.toHaveBeenCalled();
			});

			it('does not persist a merge dispatch for a non-Review phase', async () => {
				projectLookup = () => autoMergeProject;
				const workItem = createMockWorkItem();
				phaseImpl = async () => ({ agent: agentResult() });

				await processJob(
					createMockGitHubProjectsWebhookJob(),
					registryReturning({ phase: 'planning', taskId: '10', workItem }),
				);

				expect(requestMergeAutomation).not.toHaveBeenCalled();
			});
		});

		it('records the work item metadata and requested model/reasoning for a PM-driven phase', async () => {
			const projectWithAgents = createMockProjectConfig({
				agents: { planning: { cli: 'antigravity', model: 'Gemini 3.5 Flash (High)' } },
			});
			projectLookup = () => projectWithAgents;
			const workItem = createMockWorkItem({ statusId: '61e4505c' });

			await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning({ phase: 'planning', taskId: '10', workItem }),
			);

			expect(createRun).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					projectId: projectWithAgents.id,
					taskId: '10',
					phase: 'planning',
					workItemId: workItem.id,
					workItemTitle: workItem.title,
					workItemUrl: workItem.url,
					prNumber: undefined,
					// Legacy combined string normalized to logical model + reasoning (issue #180).
					model: 'gemini-3.5-flash',
					reasoning: 'high',
					jobPayload: expect.any(Object),
				}),
			);
		});

		it('does not store an empty provider URL', async () => {
			const workItem = createMockWorkItem({ statusId: '61e4505c', url: '' });

			await processJob(
				createMockGitHubProjectsWebhookJob(),
				registryReturning({ phase: 'planning', taskId: '10', workItem }),
			);

			expect(createRun).toHaveBeenCalledWith(
				expect.objectContaining({ workItemTitle: workItem.title, workItemUrl: undefined }),
			);
		});

		it('finalizes the run failed and stores its logs for a terminal AgentRunError', async () => {
			phaseImpl = async () => {
				throw new AgentRunError(
					'review agent exited with code 1',
					{ kind: 'error' },
					agentResult({
						cli: 'claude',
						exitCode: 1,
						timedOut: false,
						durationMs: 42,
						stdout: 'so',
						stderr: 'se',
					}),
				);
			};

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-failed');
			expect(completeRun).toHaveBeenCalledExactlyOnceWith('run-1', {
				status: 'failed',
				agentSessionId: null,
				error: 'review agent exited with code 1',
				engine: 'claude',
				exitCode: 1,
				timedOut: false,
				durationMs: 42,
				usage: undefined,
				recovery: null,
			});
			expect(storeRunLogs).toHaveBeenCalledExactlyOnceWith('run-1', 'so', 'se');
		});

		it('records the agent-reported usage on a terminal failure that still produced one', async () => {
			phaseImpl = async () => {
				throw new AgentRunError(
					'review agent exited with code 1',
					{ kind: 'error' },
					agentResult({ exitCode: 1, usage: { inputTokens: 30, outputTokens: 15 } }),
				);
			};

			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({ usage: { inputTokens: 30, outputTokens: 15 } }),
			);
		});

		it('finalizes the run deferred (not failed) for a rate-limited AgentRunError', async () => {
			vi.useFakeTimers();
			const now = new Date('2026-07-10T10:00:00.000Z');
			vi.setSystemTime(now);
			phaseImpl = async () => {
				throw new AgentRunError(
					'rate limited',
					{ kind: 'rate-limit' },
					agentResult({ exitCode: 1, stdout: 'ro', stderr: 're' }),
				);
			};

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-deferred');
			if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
			expect(completeRun).toHaveBeenCalledTimes(1);
			expect(completeRun.mock.calls[0][1]).toMatchObject({
				status: 'deferred',
				nextRetryAt: new Date(now.getTime() + outcome.retryDelayMs),
			});
			expect(storeRunLogs).toHaveBeenCalledExactlyOnceWith('run-1', 'ro', 're');
			vi.useRealTimers();
		});

		it('finalizes a Codex Review capacity failure as deferred with retry metadata', async () => {
			vi.useFakeTimers();
			const now = new Date('2026-07-10T10:00:00.000Z');
			vi.setSystemTime(now);
			phaseImpl = async () => {
				throw agentRunError(
					agentResult({
						cli: 'codex',
						exitCode: 1,
						stdout:
							'{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}',
					}),
					'Review agent (codex) exited with code 1',
					' for PR #17',
				);
			};

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome).toMatchObject({
				status: 'phase-deferred',
				phase: 'review',
				runId: 'run-1',
				attempt: 0,
				retryDelayMs: 6 * 60 * 1000,
				reason: 'Review agent (codex) exited with code 1 (model at capacity) for PR #17',
				resumable: false,
			});
			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({
					status: 'deferred',
					nextRetryAt: new Date(now.getTime() + 6 * 60 * 1000),
					engine: 'codex',
				}),
			);
			vi.useRealTimers();
		});

		it('still reports phase-succeeded when createRun fails (best-effort, no id to finalize)', async () => {
			createRun.mockRejectedValueOnce(new Error('postgres down'));

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			// Creation failed → no run id → the completion path no-ops.
			expect(completeRun).not.toHaveBeenCalled();
			expect(storeRunLogs).not.toHaveBeenCalled();
		});

		it('still reports phase-succeeded when completeRun rejects (best-effort swallow)', async () => {
			completeRun.mockRejectedValueOnce(new Error('postgres down'));

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
		});

		it('does not create a run row for a no-trigger job', async () => {
			await processJob(createMockGitHubWebhookJob(), createTriggerRegistry());
			expect(createRun).not.toHaveBeenCalled();
		});

		it('does not create a run row for a skipped-in-flight duplicate', async () => {
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			phaseImpl = async () => {
				await gate;
				return { agent: agentResult() };
			};

			const first = processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));
			await new Promise((r) => setTimeout(r, 0));

			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			// Only the first (in-flight) run created a row; the skipped duplicate did not.
			expect(createRun).toHaveBeenCalledTimes(1);

			release?.();
			await first;
		});
	});

	describe('wall-clock timeout & retry lifecycle (issue #165)', () => {
		it('passes the worker default timeout to a phase the project sets no override for', async () => {
			await processJob(createMockGitHubWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(phaseCalls[0].args.timeoutMs).toBe(DEFAULT_AGENT_TIMEOUT_MS);
		});

		it('defers a genuinely-killed timeout (non-zero exit) for a resume retry', async () => {
			phaseImpl = async () => {
				throw new AgentRunError(
					'review agent exceeded its wall-clock timeout',
					{ kind: 'timeout' },
					agentResult({
						exitCode: null,
						signal: 'SIGKILL',
						timedOut: true,
						durationMs: 999,
						sessionId: 'sess-review',
					}),
				);
			};

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			// A genuine kill interrupted work — resume it: the row finalizes `deferred`
			// (with timedOut recorded) and its captured session id is preserved.
			expect(outcome.status).toBe('phase-deferred');
			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({
					status: 'deferred',
					timedOut: true,
					agentSessionId: 'sess-review',
				}),
			);
		});

		it('re-routes a clean-exit run the harness still flagged timed-out to a failure', async () => {
			// The rare trap-SIGTERM-then-exit-0 case: the phase "succeeded" but the
			// harness reports timedOut, so the row must finalize `failed`, not
			// `completed` (a completed+timedOut row is self-contradictory).
			phaseImpl = async () => ({ agent: agentResult({ exitCode: 0, timedOut: true }) });

			const outcome = await processJob(
				createMockGitHubWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-failed');
			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({ status: 'failed', timedOut: true }),
			);
			expect(completeRun).not.toHaveBeenCalledWith(
				'run-1',
				expect.objectContaining({ status: 'completed' }),
			);
		});

		it('runs a manual retry on its cli/model overrides and finalizes the reused row out of running', async () => {
			const captured: Partial<AgentCliResult> = {
				cli: 'codex',
				exitCode: 1,
				timedOut: false,
			};
			phaseImpl = async (_phase, args) => {
				// The phase must be dispatched with the retry's overrides, not the
				// project/coded defaults — the confirmed `codex`/`gpt-5.6-terra`
				// regression that instead relaunched `antigravity`.
				expect(args.cli).toBe('codex');
				expect(args.model).toBe('gpt-5.6-terra');
				throw new AgentRunError(
					'implementation agent (codex) exited with code 1',
					{ kind: 'error' },
					agentResult(captured),
				);
			};
			const workItem = createMockWorkItem({ statusId: '47fc9ee4' });
			const trigger: TriggerResult = { phase: 'implementation', taskId: '10', workItem };

			const outcome = await processJob(
				createMockGitHubProjectsWebhookJob({
					runId: 'run-1',
					cliOverride: 'codex',
					modelOverride: 'gpt-5.6-terra',
				}),
				registryReturning(trigger),
			);

			expect(outcome.status).toBe('phase-failed');
			// The carried row is reused (reset to running), then finalized `failed`
			// with the engine that actually ran — never left `running`.
			expect(resetRunToRunning).toHaveBeenCalledWith(
				'run-1',
				expect.objectContaining({ runId: 'run-1' }),
				undefined,
			);
			expect(createRun).not.toHaveBeenCalled();
			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({ status: 'failed', engine: 'codex' }),
			);
		});
	});
});

describe('reportInterruptedJobToBoard', () => {
	beforeEach(() => {
		projectLookup = () => PROJECT;
		addComment.mockClear();
		addComment.mockResolvedValue('comment-1');
		commentOnPullRequest.mockClear();
		commentOnPullRequest.mockResolvedValue(99);
	});

	it('comments on the PR for a github (PR/check) job', async () => {
		// createMockGitHubWebhookJob's event carries workItemId '17'.
		await reportInterruptedJobToBoard(
			createMockGitHubWebhookJob(),
			'job stalled more than allowable limit',
		);

		expect(commentOnPullRequest).toHaveBeenCalledTimes(1);
		const [proj, prNumber, body] = commentOnPullRequest.mock.calls[0];
		expect(proj).toBe(PROJECT);
		expect(prNumber).toBe(17);
		expect(body).toContain('SWARM run interrupted');
		expect(body).toContain('job stalled more than allowable limit');
		expect(addComment).not.toHaveBeenCalled();
	});

	it('comments on the work item for a github-projects (board) job', async () => {
		const job = createMockGitHubProjectsWebhookJob();

		await reportInterruptedJobToBoard(job, 'stalled');

		expect(addComment).toHaveBeenCalledTimes(1);
		const [itemId, body] = addComment.mock.calls[0];
		expect(itemId).toBe(job.event.itemNodeId);
		expect(body).toContain('SWARM run interrupted');
		expect(commentOnPullRequest).not.toHaveBeenCalled();
	});

	it('skips silently when the project cannot be resolved', async () => {
		projectLookup = () => undefined;

		await expect(
			reportInterruptedJobToBoard(createMockGitHubWebhookJob(), 'stalled'),
		).resolves.toBeUndefined();
		expect(commentOnPullRequest).not.toHaveBeenCalled();
		expect(addComment).not.toHaveBeenCalled();
	});

	it('skips a github job that carries no PR/issue number', async () => {
		const job = createMockGitHubWebhookJob({
			event: createMockGitHubParsedEvent({ workItemId: undefined }),
		});

		await reportInterruptedJobToBoard(job, 'stalled');

		expect(commentOnPullRequest).not.toHaveBeenCalled();
		expect(addComment).not.toHaveBeenCalled();
	});

	it('swallows malformed job data without throwing', async () => {
		await expect(reportInterruptedJobToBoard({ not: 'a job' }, 'stalled')).resolves.toBeUndefined();
		expect(commentOnPullRequest).not.toHaveBeenCalled();
		expect(addComment).not.toHaveBeenCalled();
	});

	it('swallows a comment failure without throwing', async () => {
		commentOnPullRequest.mockRejectedValue(new Error('github 500'));

		await expect(
			reportInterruptedJobToBoard(createMockGitHubWebhookJob(), 'stalled'),
		).resolves.toBeUndefined();
	});
});

describe('runAssignedPhase (shared per-phase runner switch)', () => {
	const runAgent = (async () => agentResult()) as AssignedPhaseInputs['runAgent'];

	function baseInputs(overrides: Partial<AssignedPhaseInputs>): AssignedPhaseInputs {
		return {
			phase: 'planning',
			taskId: '17',
			project: PROJECT,
			resumeDelivery: false,
			runAgent,
			...overrides,
		};
	}

	beforeEach(() => {
		phaseCalls.length = 0;
		providerBuiltWith.length = 0;
		phaseImpl = async () => ({ agent: agentResult() });
	});

	it('routes planning to runPlanningPhase with the board PM provider and work item', async () => {
		const workItem = createMockWorkItem({ id: 'PVTI_1' });
		await runAssignedPhase(baseInputs({ phase: 'planning', workItem }));
		expect(phaseCalls).toHaveLength(1);
		expect(phaseCalls[0].phase).toBe('planning');
		expect(phaseCalls[0].args.workItem).toBe(workItem);
		// The board-driven phases build the concrete PM provider inside the switch.
		expect(providerBuiltWith).toHaveLength(1);
	});

	it('uses an injected PM write delegate without building the in-process provider', async () => {
		// Control-plane delivery mode hands `runPhase` a transport PM write delegate
		// (`resolvePmDelivery`); the switch must forward it verbatim and never build
		// the concrete in-process provider (which would resolve the PM credential).
		const injectedPm = { type: 'github-projects' } as unknown as PMProvider;
		await runAssignedPhase(
			baseInputs({ phase: 'planning', workItem: createMockWorkItem(), pm: injectedPm }),
		);
		expect(phaseCalls[0].args.pm).toBe(injectedPm);
		expect(providerBuiltWith).toHaveLength(0);
	});

	it('routes implementation and forwards the branch-resume flag + hook', async () => {
		const onBranchProvisioned = async () => {};
		await runAssignedPhase(
			baseInputs({
				phase: 'implementation',
				workItem: createMockWorkItem(),
				resumeExistingBranch: true,
				onBranchProvisioned,
			}),
		);
		expect(phaseCalls[0].phase).toBe('implementation');
		expect(phaseCalls[0].args.resumeExistingBranch).toBe(true);
		expect(phaseCalls[0].args.onBranchProvisioned).toBe(onBranchProvisioned);
	});

	it('routes review with PR coordinates and no PM provider', async () => {
		await runAssignedPhase(baseInputs({ phase: 'review', prNumber: '42', headSha: 'deadbeef' }));
		expect(phaseCalls[0].phase).toBe('review');
		expect(phaseCalls[0].args.prNumber).toBe('42');
		expect(phaseCalls[0].args.headSha).toBe('deadbeef');
		expect(providerBuiltWith).toHaveLength(0);
	});

	it('routes respond-to-review with the submitted review id and the PM provider', async () => {
		await runAssignedPhase(
			baseInputs({
				phase: 'respond-to-review',
				prNumber: '42',
				prBranch: 'issue-17',
				reviewId: 'RV_1',
				headSha: 'deadbeef',
			}),
		);
		expect(phaseCalls[0].phase).toBe('respond-to-review');
		expect(phaseCalls[0].args.reviewId).toBe('RV_1');
		expect(providerBuiltWith).toHaveLength(1);
	});

	it('routes respond-to-ci with PR coordinates', async () => {
		await runAssignedPhase(
			baseInputs({ phase: 'respond-to-ci', prNumber: '42', prBranch: 'issue-17', headSha: 'dead' }),
		);
		expect(phaseCalls[0].phase).toBe('respond-to-ci');
		expect(phaseCalls[0].args.prBranch).toBe('issue-17');
	});

	it('routes resolve-conflicts with base + head coordinates', async () => {
		await runAssignedPhase(
			baseInputs({
				phase: 'resolve-conflicts',
				prNumber: '42',
				prBranch: 'issue-17',
				headSha: 'dead',
				baseBranch: 'main',
				baseSha: 'cafe',
			}),
		);
		expect(phaseCalls[0].phase).toBe('resolve-conflicts');
		expect(phaseCalls[0].args.baseBranch).toBe('main');
		expect(phaseCalls[0].args.baseSha).toBe('cafe');
	});

	it('threads a fresh session id as sessionId and a resume as resumeSessionId', async () => {
		await runAssignedPhase(
			baseInputs({ phase: 'planning', workItem: createMockWorkItem(), sessionId: 'sess-fresh' }),
		);
		expect(phaseCalls[0].args.sessionId).toBe('sess-fresh');
		expect(phaseCalls[0].args.resumeSessionId).toBeUndefined();

		phaseCalls.length = 0;
		await runAssignedPhase(
			baseInputs({
				phase: 'review',
				prNumber: '42',
				headSha: 'dead',
				resumeSessionId: 'sess-resume',
			}),
		);
		expect(phaseCalls[0].args.resumeSessionId).toBe('sess-resume');
		expect(phaseCalls[0].args.sessionId).toBeUndefined();
	});

	it('throws when a required phase input is missing rather than calling the runner', async () => {
		await expect(
			runAssignedPhase(baseInputs({ phase: 'planning', workItem: undefined })),
		).rejects.toThrow(/requires a workItem/);
		await expect(runAssignedPhase(baseInputs({ phase: 'review' }))).rejects.toThrow(
			/requires prNumber and headSha/,
		);
		expect(phaseCalls).toHaveLength(0);
	});
});
