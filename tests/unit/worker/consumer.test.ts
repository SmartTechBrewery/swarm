import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { AgentCli, AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError, agentRunError } from '@/harness/agent-failure.js';
import type { CliQuotaSnapshot } from '@/harness/quota.js';
import type { ResolvedAssignee } from '@/identity/assignee-resolver.js';
import type { SwarmUser } from '@/identity/schema.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES } from '@/identity/worker.js';
import { DEFAULT_ENROLLMENT_ALLOWED_PHASES } from '@/identity/worker-enrollment.js';
import type { WorkerDispatchCandidate } from '@/identity/worker-enrollment-service.js';
import { requireGitHubProjectsConfig } from '@/integrations/pm/github-projects/config-schema.js';
import { logger } from '@/lib/logger.js';
import { DependencyBlockedError } from '@/pipeline/dependency-guard.js';
import type { ProposedScope } from '@/pipeline/planning.js';
import { BlockedRecoveryError } from '@/pipeline/resume.js';
import type { PMProvider, WorkItem, WorkItemAssignee } from '@/pm/types.js';
import type { CancellationOrigin } from '@/queue/cancellation.js';
import { DeliveryDeferredError } from '@/scm/delivery.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import {
	createMockPhaseRecovery,
	createMockPmWebhookJob,
	createMockProjectConfig,
	createMockScmEvent,
	createMockScmWebhookJob,
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
// The narrow board-card read the automation-label gate resolves an SCM-driven
// phase's work item through (issue #354). Defaults to "no card backs this PR",
// which is the fail-open answer — the gate then dispatches.
const findWorkItemForArtifact = vi.fn(
	async (_artifact: {
		repository: string;
		kind: string;
		number: string;
	}): Promise<WorkItem | undefined> => undefined,
);
const provider = {
	type: 'github-projects',
	// The real GitHub Projects adapter reports assignee support; the eligibility
	// gate reads this flag to decide whether to resolve an item's assignee.
	supportsAssignees: true,
	addComment,
	findWorkItemForArtifact,
} as unknown as PMProvider;
const providerBuiltWith: ProjectConfig[] = [];
// The consumer resolves both PM halves through the registry (issue #297), so the
// registry is the seam to fake. `registerPMProvider` must stay callable: the
// consumer imports the integrations entrypoint, whose provider modules register
// themselves at load.
vi.mock('@/integrations/pm/registry.js', () => ({
	registerPMProvider: vi.fn(),
	getPMProvider: vi.fn(),
	requireProjectPMProvider: (project: ProjectConfig) => {
		providerBuiltWith.push(project);
		return provider;
	},
	requireProjectPMAdapter: () => ({
		synthesizeStateChange: (project: ProjectConfig, itemId: string) => {
			const pm = requireGitHubProjectsConfig(project);
			return {
				itemId,
				containerId: pm.projectId,
				action: 'updated',
				changedField: pm.statusFieldId,
				changedFieldType: 'single_select',
			};
		},
	}),
}));

/** What a phase run resolves to, as far as the two stand-ins below are concerned. */
type StubPhaseResult = {
	agent: AgentCliResult;
	movedTo?: string;
	split?: { subTaskItemIds: string[]; mainTaskUpdated: boolean };
	verdict?: string;
	reviewOrdinal?: number;
	automationOutcome?: string;
};

/**
 * What `runAssignedPhase` handed each mocked orchestrator — the per-phase switch's
 * own inputs, asserted by its describe block at the bottom of this file.
 */
const assignedPhaseCalls: Array<{ phase: string; args: Record<string, unknown> }> = [];
let assignedPhaseImpl: (phase: string, args: Record<string, unknown>) => Promise<StubPhaseResult> =
	async () => ({ agent: agentResult() });

/**
 * What `processJob` dispatched — the context the control plane resolved before
 * handing the phase to a worker. `processJob` no longer runs a phase itself
 * (issue #553): `executePhase` is a required dependency, and the local wrapper
 * below injects the recording stand-in every case here drives through `phaseImpl`.
 */
const phaseCalls: Array<{ phase: string; context: DispatchPhaseContext }> = [];
let phaseImpl: (phase: string, context: DispatchPhaseContext) => Promise<StubPhaseResult>;

function mockPhase(phase: string) {
	return (args: Record<string, unknown>) => {
		assignedPhaseCalls.push({ phase, args });
		return assignedPhaseImpl(phase, args);
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
	priorityFor: (job: { type: string }) => (job.type === 'pm' ? 10 : undefined),
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
const promoteAvailabilityWaitsForWorker = vi.fn(async (_workerId: string, _cause: string) => 0);
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
	promoteAvailabilityWaitsForWorker: (workerId: string, cause: string) =>
		promoteAvailabilityWaitsForWorker(workerId, cause),
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
const releaseConflictResolution = vi.fn(async (_key: string) => {});
vi.mock('@/triggers/resolve-conflicts-dedup.js', () => ({
	refreshConflictResolutionClaim: (key: string, ttlSec: number) =>
		refreshConflictResolutionClaim(key, ttlSec),
	buildConflictResolutionKey: (repo: string, prNumber: string, headSha: string, baseSha: string) =>
		`${repo}:${prNumber}:${headSha}:${baseSha}`,
	releaseConflictResolution: (key: string) => releaseConflictResolution(key),
}));

const releaseRespondToCiAttempt = vi.fn(async (_key: string) => {});
vi.mock('@/triggers/respond-to-ci-attempts.js', () => ({
	buildRespondToCiAttemptKey: (repo: string, prNumber: string) => `${repo}:${prNumber}`,
	releaseRespondToCiAttempt: (key: string) => releaseRespondToCiAttempt(key),
}));

const abandonReviewVerdict = vi.fn(async (_key: unknown) => {});
vi.mock('@/db/repositories/reviewVerdictsRepository.js', () => ({
	abandonReviewVerdict: (key: unknown) => abandonReviewVerdict(key),
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
/**
 * The tail of each `resetRunToRunning` call, named for readability: the mock
 * above deliberately forwards only the first three positional arguments (so the
 * existing exact-call assertions stay short), so the resolved target it records
 * on the reused row and the trailing binding args — worker, fencing token, and
 * the owning user the attribution record needs (issue #398) — are captured here
 * instead.
 */
const resetRunBindings: Array<{
	model?: string;
	engine?: string;
	workerId?: string;
	fencingToken?: number;
	workerUserId?: string;
}> = [];
/**
 * The `agent_session_id` column value each `resetRunToRunning` call writes, for
 * the same reason — `undefined` leaves the stored id alone (a resume), anything
 * else is the id this attempt hands the CLI.
 */
const resetRunSessionColumns: Array<string | null | undefined> = [];
const getRunByIdFromDb = vi.fn(
	async (_id: string) =>
		undefined as
			| {
					agentSessionId?: string | null;
					continuationCount?: number;
					recovery?: { preservedWorkerId?: string | null } | null;
			  }
			| undefined,
);
/** Issue #567 — the settle-time record of which machine holds the preserved checkout. */
const recordRunPreservedWorker = vi.fn(async (_runId: string) => {});
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
	isRetryPendingStatus: (status: string) => status === 'deferred' || status === 'checkpointed',
	resetRunToRunning: (...args: unknown[]) => {
		resetRunSessionColumns.push(args[7] as string | null | undefined);
		resetRunBindings.push({
			model: args[3] as string | undefined,
			engine: args[6] as string | undefined,
			workerId: args[9] as string | undefined,
			fencingToken: args[10] as number | undefined,
			workerUserId: args[11] as string | undefined,
		});
		return resetRunToRunning(args[0] as string, args[1], args[2] as string | undefined);
	},
	getRunByIdFromDb: (id: string) => getRunByIdFromDb(id),
	recordRunPreservedWorker: (runId: string) => recordRunPreservedWorker(runId),
}));

// The preserved-checkout pin resolves the machine's display name for its refusal
// message (issue #567). Mocked at the module boundary like every other DB-backed
// collaborator here; the id is the fallback when it resolves nothing.
const getWorker = vi.fn(async (id: string) => ({ id, displayName: `worker-${id}` }));
vi.mock('@/identity/worker-service.js', () => ({
	getWorker: (id: string) => getWorker(id),
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
const upsertCliQuota = vi.fn(async () => {});
vi.mock('@/db/repositories/cliQuotasRepository.js', () => ({
	getAllCliQuotas: () => getAllCliQuotas(),
	upsertCliQuota: () => upsertCliQuota(),
}));

// The recovery capability/quota discovery a launch or authentication failure
// fires (`handlePhaseFailure`) — mocked so the terminal-auth test can assert it
// ran without shelling out to the real CLIs.
const discoverCliQuotas = vi.fn(async () => [] as unknown[]);
vi.mock('@/harness/quota-discovery.js', () => ({
	discoverCliQuotas: () => discoverCliQuotas(),
}));

// The consumer's own SCM writes and reads — the interrupted-job and phase-failure
// PR comments, and the run row's PR-title lookup — resolve their provider from
// `scmProviderRegistry` (issue #386). Mocking the concrete class still stubs them
// all out, because the consumer's provider-registry side-effect import registers
// `new GitHubSCMIntegration()`, so the registry holds *this* stub instance and
// both `requireProjectSCMProvider(project)` and `requireSCMProvider('github')`
// hand it back. Hoisted, because that registration runs at module load — before a
// plain `const` would be initialized.
const { commentOnPullRequest, getPullRequestTitle } = vi.hoisted(() => ({
	commentOnPullRequest: vi.fn(async (_p: unknown, _n: number, _b: string) => 99),
	getPullRequestTitle: vi.fn(async (_p: unknown, _n: number) => 'Fix the flaky trigger test'),
}));
vi.mock('@/integrations/scm/github/scm-integration.js', () => ({
	GitHubSCMIntegration: class {
		commentOnPullRequest = commentOnPullRequest;
		getPullRequestTitle = getPullRequestTitle;
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
	// Real class so `handlePhaseFailure`'s `instanceof RunTerminatedError` guard is
	// a valid constructor check (the in-process path never throws it).
	RunTerminatedError: class RunTerminatedError extends Error {},
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

import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	getSCMProvider,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import type { Checkpoint } from '@/pipeline/checkpoint.js';
import { isSwarmGeneratedBody } from '@/scm/swarm-origin.js';
import { createTriggerRegistry } from '@/triggers/registry.js';
import type { TriggerContext, TriggerResult } from '@/triggers/types.js';
import {
	type AssignedPhaseInputs,
	DEFAULT_AGENT_TIMEOUT_MS,
	type DispatchPhaseContext,
	interruptedRunCommentBody,
	type PhaseRunResult,
	type ProcessJobDeps,
	phaseFailureCommentBody,
	processJob as processJobWithDeps,
	reportInterruptedJobToBoard,
	runAssignedPhase,
} from '@/worker/consumer.js';

type ProcessJobArgs = Parameters<typeof processJobWithDeps>;

/**
 * The dispatch dependencies every production caller supplies
 * (`createControlPlaneDispatchDeps`, `@/router/dispatcher.js`), with a recording
 * `executePhase` in place of the push-to-a-worker one. A case overrides a field
 * when it is exercising that seam.
 */
function dispatchDeps(overrides: Partial<ProcessJobDeps> = {}): ProcessJobDeps {
	return {
		executePhase: async (context) => {
			phaseCalls.push({ phase: context.trigger.phase, context });
			return (await phaseImpl(context.trigger.phase, context)) as PhaseRunResult;
		},
		...overrides,
	};
}

/**
 * The target `agentOverrideFor` resolved for a dispatched phase. The phase runs on
 * a worker now (issue #553), so the resolution is observable where the dispatcher
 * records it: on the run row it creates. `engine` is the effective CLI (the phase's
 * coded default applied), `model`/`reasoning`/`timeoutMs` are what it will run with.
 */
function resolvedTarget(): Record<string, unknown> {
	const input = createRun.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
	if (!input) throw new Error('expected the dispatcher to have created a run row');
	return input;
}

/** `processJob` with those dependencies, so a case states only what it varies. */
function processJob(
	job: ProcessJobArgs[0],
	registry: ProcessJobArgs[1],
	signal?: ProcessJobArgs[2],
	executionIdentity?: ProcessJobArgs[3],
	deps: Partial<ProcessJobDeps> = {},
): ReturnType<typeof processJobWithDeps> {
	return processJobWithDeps(job, registry, signal, executionIdentity, dispatchDeps(deps));
}

const PROJECT = createMockProjectConfig();
const PROJECT_PM = requireGitHubProjectsConfig(PROJECT);

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

// Narrowed to the `review` variant (rather than the whole union) so a test can
// spread it into a variation — see the in-flight guard's second-taskId case.
const REVIEW_TRIGGER: Extract<TriggerResult, { phase: 'review' }> = {
	phase: 'review',
	taskId: '17',
	prNumber: '17',
	prBranch: 'issue-17',
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
		// This suite exercises the local worker by default. Keep externally configured
		// transport credentials from switching it into the remote-delivery path.
		vi.stubEnv('SWARM_CONTROL_PLANE_URL', '');
		vi.stubEnv('SWARM_WORKER_CREDENTIAL', '');
		phaseCalls.length = 0;
		providerBuiltWith.length = 0;
		projectLookup = () => PROJECT;
		phaseImpl = async () => ({ agent: agentResult() });
		addComment.mockClear();
		addComment.mockResolvedValue('comment-1');
		findWorkItemForArtifact.mockClear();
		findWorkItemForArtifact.mockResolvedValue(undefined);
		releaseConflictResolution.mockClear();
		releaseRespondToCiAttempt.mockClear();
		abandonReviewVerdict.mockClear();
		claimDispatchForJob.mockClear();
		claimDispatchForJob.mockImplementation(async (job: Record<string, unknown>) => ({
			claimed: true,
			dispatch: mockDispatchRow(job),
		}));
		createAndPublishDispatch.mockClear();
		createAndPublishDispatch.mockResolvedValue({ dispatch: mockDispatchRow({}), created: true });
		promoteNextCapacityDispatch.mockClear();
		promoteAvailabilityWaitsForWorker.mockClear();
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
		resetRunBindings.length = 0;
		resetRunSessionColumns.length = 0;
		getRunByIdFromDb.mockClear();
		getRunByIdFromDb.mockResolvedValue(undefined);
		recordRunPreservedWorker.mockClear();
		getWorker.mockClear();
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
		discoverCliQuotas.mockClear();
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
		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

		expect(outcome.status).toBe('phase-succeeded');
		expect(acquireProjectSlot).toHaveBeenCalledWith(PROJECT.id, PROJECT.maxConcurrentJobs);
		expect(releaseProjectSlot).toHaveBeenCalledOnce();
		expect(releaseProjectSlot).toHaveBeenCalledWith(PROJECT.id);
	});

	it('defers at the project limit without running or releasing an unacquired slot', async () => {
		acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

		await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));
		expect(phaseCalls).toHaveLength(1);
	});

	it('leaves a fresh Implementation retry free to create its task branch after a capacity deferral', async () => {
		acquireProjectSlot.mockResolvedValueOnce({ acquired: false });
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		const trigger: TriggerResult = { phase: 'implementation', taskId: '216', workItem };

		const outcome = await processJob(createMockPmWebhookJob(), registryReturning(trigger));

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
			createMockScmWebhookJob({ rateLimitRetryAttempt: 6 }),
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
				createMockScmWebhookJob(),
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

			const outcome = await processJob(createMockScmWebhookJob(), registryReturning(trigger));

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
			await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_CI_TRIGGER));

			expect(refreshReviewDispatchClaim).toHaveBeenCalledWith(
				`${PROJECT.repo}:17:deadbeef`,
				expect.any(Number),
			);

			refreshReviewDispatchClaim.mockClear();
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });
			await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_REVIEW_TRIGGER));

			// The dispatch claim stays held even without priority so immediate
			// slot-release dispatch cannot be deduplicated as a fresh webhook.
		});

		it('refreshes the Resolve-conflicts head/base claim while pending', async () => {
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

			await processJob(createMockScmWebhookJob(), registryReturning(RESOLVE_CONFLICTS_TRIGGER));

			expect(refreshConflictResolutionClaim).toHaveBeenCalledWith(
				`${PROJECT.repo}:17:deadbeef:cafebabe`,
				expect.any(Number),
			);
		});

		it('retains a continuation when a project with multiple slots is fully occupied', async () => {
			projectLookup = () => createMockProjectConfig({ maxConcurrentJobs: 2 });
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

			const outcome = await processJob(
				createMockScmWebhookJob(),
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

			const outcome = await processJob(createMockPmWebhookJob(), registryReturning(trigger));

			if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
			expect(outcome.continuationDispatchClaimed).toBeUndefined();
			expect(outcome.pendingContinuation).toBeUndefined();
			expect(outcome.pendingDispatch).toBe(true);
			expect(refreshReviewDispatchClaim).not.toHaveBeenCalled();
			expect(createRun).toHaveBeenCalledOnce();
		});

		it('wakes the next capacity-blocked dispatch when a slot frees on success', async () => {
			const outcome = await processJob(
				createMockScmWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(releaseProjectSlot).toHaveBeenCalledOnce();
			expect(promoteNextCapacityDispatch).toHaveBeenCalledWith(PROJECT.id, true);
		});

		it('records the capacity wait durably on the dispatch when blocked by the limit', async () => {
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

			const outcome = await processJob(
				createMockScmWebhookJob({ runId: undefined }),
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

			const outcome = await processJob(createMockScmWebhookJob(), registryReturning(trigger));

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

			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(releaseProjectSlot).toHaveBeenCalledOnce();
			expect(promoteNextCapacityDispatch).toHaveBeenCalledWith(PROJECT.id, false);
		});

		it('finalizes the run row and releases the claim if a pending continuation re-resolves to no-trigger', async () => {
			const job = createMockScmWebhookJob({
				runId: 'run-123',
				continuationDispatchClaimed: true,
				event: createMockScmEvent({ headSha: 'deadbeef' }),
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
		await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));
		expect(releaseProjectSlot).toHaveBeenCalledTimes(1);

		releaseProjectSlot.mockClear();
		phaseImpl = async () => {
			throw new AgentRunError('aborted', { kind: 'aborted' });
		};
		await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));
		expect(releaseProjectSlot).toHaveBeenCalledTimes(1);

		releaseProjectSlot.mockClear();
		acquireProjectSlot.mockResolvedValueOnce({ acquired: true, tracked: false });
		phaseImpl = async () => ({ agent: agentResult() });
		await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));
		expect(releaseProjectSlot).not.toHaveBeenCalled();
	});

	it('throws for a job referencing an unknown project', async () => {
		projectLookup = () => undefined;

		await expect(
			processJob(createMockScmWebhookJob({ projectId: 'ghost' }), registryReturning(null)),
		).rejects.toThrow("unknown project 'ghost'");
		expect(phaseCalls).toEqual([]);
	});

	it('completes as no-trigger without running a phase', async () => {
		const registry = createTriggerRegistry();

		await expect(processJob(createMockScmWebhookJob(), registry)).resolves.toEqual({
			status: 'no-trigger',
		});
		expect(phaseCalls).toEqual([]);
	});

	it('hands the trigger a context built from the job, with the provider resolved from the registry', async () => {
		const seen: TriggerContext[] = [];
		const job = createMockScmWebhookJob();

		await processJob(job, registryReturning(null, seen));

		expect(seen).toEqual([
			expect.objectContaining({
				project: PROJECT,
				deliveryId: job.deliveryId,
				source: 'scm',
				providerId: 'github',
				event: job.event,
				// Resolved once here, at the composition root, so no handler names a
				// concrete provider (issue #385).
				scm: expect.objectContaining({ commentOnPullRequest: expect.any(Function) }),
			}),
		]);
	});

	it('threads a recheck job back through, exposing its incremented recheckAttempt to the trigger', async () => {
		// A deferred recheck (scheduleCoalescedJob) re-enqueues the same event with
		// recheckAttempt bumped; when the worker pulls it, processJob must surface
		// that attempt in the ctx so the review handler re-matches and can enforce
		// its recheck cap rather than looping forever.
		const seen: TriggerContext[] = [];
		const job = createMockScmWebhookJob({ recheckAttempt: 5 });

		await processJob(job, registryReturning(REVIEW_TRIGGER, seen));

		expect(seen[0].recheckAttempt).toBe(5);
		expect(phaseCalls[0].phase).toBe('review');
	});

	it('threads a deferred PM phase through so its status trigger can resume it', async () => {
		const seen: TriggerContext[] = [];
		const job = createMockPmWebhookJob({ resumePmPhase: 'implementation' });

		await processJob(job, registryReturning(null, seen));

		expect(seen[0].resumePmPhase).toBe('implementation');
	});

	it('reuses the implementation branch only with a provisioning checkpoint', async () => {
		const workItem = createMockWorkItem({ statusId: '47fc9ee4' });
		const trigger: TriggerResult = { phase: 'implementation', taskId: '10', workItem };

		await processJob(
			createMockPmWebhookJob({
				resumePmPhase: 'implementation',
				implementationBranchProvisioned: true,
			}),
			registryReturning(trigger),
		);

		expect(phaseCalls[0].context.job.implementationBranchProvisioned).toBe(true);
	});

	it('does not treat PM resume dispatch intent as proof that a branch exists', async () => {
		const workItem = createMockWorkItem({ statusId: '47fc9ee4' });
		const trigger: TriggerResult = { phase: 'implementation', taskId: '10', workItem };

		await processJob(
			createMockPmWebhookJob({ resumePmPhase: 'implementation', runId: 'run-1' }),
			registryReturning(trigger),
		);

		expect(phaseCalls[0].context.job.implementationBranchProvisioned).toBeFalsy();
	});

	it('threads the fresh run row id as the sessionId on a first PM run (nothing to resume)', async () => {
		const workItem = createMockWorkItem({ statusId: '3fe662f4' });
		const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };

		await processJob(createMockPmWebhookJob(), registryReturning(trigger));

		// createRun's id becomes the deterministic session handle; no resume yet.
		expect(phaseCalls[0].context.job.agentSessionId).toBe('run-1');
		expect(phaseCalls[0].context.job.resumeSession).toBeFalsy();
	});

	it('threads the restored session as resumeSessionId (not sessionId) on a resumed PM run', async () => {
		getRunByIdFromDb.mockResolvedValue({ agentSessionId: 'sess-restored' });
		const workItem = createMockWorkItem({ statusId: '47fc9ee4' });
		const trigger: TriggerResult = { phase: 'implementation', taskId: '10', workItem };

		await processJob(
			createMockPmWebhookJob({
				resumePmPhase: 'implementation',
				resumeSession: true,
				runId: 'run-1',
			}),
			registryReturning(trigger),
		);

		// The carried row's preserved session is restored from the DB and resumed.
		expect(getRunByIdFromDb).toHaveBeenCalledWith('run-1');
		expect(phaseCalls[0].context.job.agentSessionId).toBe('sess-restored');
		expect(phaseCalls[0].context.job.resumeSession).toBe(true);
	});

	it('threads the restored session as resumeSessionId on a resumed non-PM (review) run', async () => {
		getRunByIdFromDb.mockResolvedValue({ agentSessionId: 'sess-review' });

		await processJob(
			createMockScmWebhookJob({ resumeSession: true, runId: 'run-1' }),
			registryReturning(REVIEW_TRIGGER),
		);

		// Review is a github (PR) job with no resumePmPhase — session continuation is
		// driven purely by the generic resumeSession flag, uniform across phases.
		expect(phaseCalls[0].phase).toBe('review');
		expect(phaseCalls[0].context.job.agentSessionId).toBe('sess-review');
		expect(phaseCalls[0].context.job.resumeSession).toBe(true);
	});

	// A non-resuming retry *assigns* its `agentSessionId` (`claude --session-id`),
	// and the payload's is the freshly minted one. The carried row can still hold
	// the spent id — a terminated run preserves its session, and a swallowed
	// finalize error leaves the previous attempt's id in place — and restoring it
	// here would make the attempt exit 1 on `Session ID <id> is already in use`
	// before doing any work.
	it('assigns the payload session id, not the row one, when the retry is not resuming', async () => {
		getRunByIdFromDb.mockResolvedValue({ agentSessionId: 'sess-spent' });
		const fresh = '9a4bd3d0-2d64-4a58-9d1a-7d84f4b2d0c1';

		await processJob(
			createMockScmWebhookJob({ runId: 'run-1', agentSessionId: fresh }),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(phaseCalls[0].context.job.agentSessionId).toBe(fresh);
		expect(phaseCalls[0].context.job.resumeSession).toBeFalsy();
		// And the row records the id this attempt assigns, so a run that dies before
		// it can finalize still leaves a recoverable session behind.
		expect(resetRunSessionColumns).toEqual([fresh]);
	});

	it('leaves the stored session untouched when the retry resumes it', async () => {
		getRunByIdFromDb.mockResolvedValue({ agentSessionId: 'sess-restored' });

		await processJob(
			createMockScmWebhookJob({ runId: 'run-1', resumeSession: true }),
			registryReturning(REVIEW_TRIGGER),
		);

		// `undefined` is "don't write the column" — it already holds the id being resumed.
		expect(resetRunSessionColumns).toEqual([undefined]);
	});

	it('threads delivery resume separately when no agent session was captured', async () => {
		getRunByIdFromDb.mockResolvedValue({ agentSessionId: null });

		await processJob(
			createMockScmWebhookJob({ resumeDelivery: true, runId: 'run-1' }),
			registryReturning(REVIEW_TRIGGER),
		);

		expect(phaseCalls[0].phase).toBe('review');
		expect(phaseCalls[0].context.job.resumeDelivery).toBe(true);
		expect(phaseCalls[0].context.job.agentSessionId).toBeFalsy();
	});

	it('discriminates the context source for a board job and injects its PM provider', async () => {
		const seen: TriggerContext[] = [];
		const job = createMockPmWebhookJob();

		await processJob(job, registryReturning(null, seen));

		const ctx = seen[0];
		expect(ctx.source).toBe('pm');
		expect(ctx.event).toEqual(job.event);
		if (ctx.source !== 'pm') throw new Error('expected a pm context');
		expect(ctx.providerId).toBe('github-projects');
		expect(ctx.pm).toBe(provider);
	});

	it('runs the Review phase for a review trigger and maps the outcome', async () => {
		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

		expect(phaseCalls).toHaveLength(1);
		expect(phaseCalls[0].phase).toBe('review');
		expect(phaseCalls[0].context.project).toBe(PROJECT);
		expect(phaseCalls[0].context.trigger).toMatchObject({
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
			repo: 'SmartTechBrewery/swarm',
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

		await processJob(createMockPmWebhookJob(), registryReturning(trigger));

		// Once, from the registry and for this project: the trigger context's `ctx.pm`.
		// The phase's own PM provider is the worker's, resolved there (ADR-004 §2).
		expect(providerBuiltWith).toEqual([PROJECT]);
		expect(phaseCalls[0].phase).toBe('planning');
		expect(phaseCalls[0].context.project).toBe(PROJECT);
		expect(phaseCalls[0].context.trigger).toMatchObject({ taskId: '10', workItem });
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

			await processJob(createMockPmWebhookJob(), registryReturning(trigger));

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it('self-enqueues a synthetic board job when Planning auto-advances to ToDo', async () => {
			const workItem = createMockWorkItem({ statusId: '3fe662f4' });
			const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };
			phaseImpl = async () => ({ agent: agentResult(), movedTo: 'todo' });

			await processJob(createMockPmWebhookJob(), registryReturning(trigger));

			expect(createAndPublishDispatch).toHaveBeenCalledExactlyOnceWith({
				projectId: PROJECT.id,
				priority: 10,
				source: 'synthetic',
				jobPayload: {
					type: 'pm',
					providerId: 'github-projects',
					projectId: PROJECT.id,
					// The synthetic event is the provider adapter's, not the worker's.
					event: {
						itemId: workItem.id,
						containerId: PROJECT_PM.projectId,
						action: 'updated',
						changedField: PROJECT_PM.statusFieldId,
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

			await processJob(createMockPmWebhookJob(), registryReturning(trigger));

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

			await processJob(createMockPmWebhookJob(), registryReturning(trigger));

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it('does not self-enqueue for a non-PM (PR-driven) phase', async () => {
			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

			const outcome = await processJob(createMockPmWebhookJob(), registryReturning(trigger));

			expect(outcome.status).toBe('phase-succeeded');
		});
	});

	it("resolves the project's per-phase agent override (cli/model/reasoning) for the dispatch", async () => {
		const projectWithAgents = createMockProjectConfig({
			// Legacy combined string migrates to logical model + reasoning (issue #180).
			agents: { planning: { cli: 'antigravity', model: 'Gemini 3.5 Flash (High)' } },
		});
		projectLookup = () => projectWithAgents;
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };

		await processJob(createMockPmWebhookJob(), registryReturning(trigger));

		expect(resolvedTarget()).toMatchObject({
			engine: 'antigravity',
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

			await processJob(createMockPmWebhookJob(), registryReturning(implementationTrigger()));

			expect(hasCompletedRunForTask).toHaveBeenCalledWith(PROJECT.id, '10', 'planning');
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

			await processJob(createMockPmWebhookJob(), registryReturning(implementationTrigger()));
			expect(resolvedTarget()).toMatchObject({ engine: 'claude', model: 'opus' });

			phaseCalls.length = 0;
			projectLookup = () =>
				createMockProjectConfig({ agents: { implementation: { cli: 'claude', model: 'opus' } } });
			hasCompletedRunForTask.mockResolvedValueOnce(false);
			await processJob(createMockPmWebhookJob(), registryReturning(implementationTrigger()));
			expect(resolvedTarget()).toMatchObject({ engine: 'claude', model: 'opus' });
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
				processJob(createMockPmWebhookJob(), registryReturning(implementationTrigger())),
			).resolves.toMatchObject({ status: 'phase-succeeded' });
			expect(resolvedTarget()).toMatchObject({ engine: 'claude', model: 'opus' });
		});

		it('does not query planning history for non-implementation phases', async () => {
			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(hasCompletedRunForTask).not.toHaveBeenCalledWith(PROJECT.id, '17', 'planning');
		});
	});

	it('leaves the phase on its coded default CLI while still resolving the default model', async () => {
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockPmWebhookJob(), registryReturning(trigger));

		// `engine` is the coded default the phase applies for itself; only the model
		// was resolved through the fallback chain.
		expect(resolvedTarget()).toMatchObject({ engine: 'claude', model: 'sonnet' });
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

		await processJob(createMockPmWebhookJob(), registryReturning(trigger));

		expect(resolvedTarget()).toMatchObject({ engine: 'claude', model: 'opus' });
	});

	it('resolves model to the global defaults when the project has none', async () => {
		getAppSettings.mockResolvedValue({ agents: { defaults: { claude: 'opus' } } });
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockPmWebhookJob(), registryReturning(trigger));

		// No project override at all → the global default wins over the coded default.
		expect(resolvedTarget().model).toBe('opus');
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

		await processJob(createMockPmWebhookJob(), registryReturning(trigger));

		expect(resolvedTarget().model).toBe('opus');
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

		await processJob(createMockPmWebhookJob(), registryReturning(trigger));

		expect(resolvedTarget().model).toBe('sonnet');
	});

	it('falls back to the coded default when neither project nor global sets one', async () => {
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		await processJob(createMockPmWebhookJob(), registryReturning(trigger));

		expect(resolvedTarget().model).toBe('sonnet');
	});

	it('still runs the phase on coded defaults when the settings load fails', async () => {
		getAppSettings.mockRejectedValueOnce(new Error('db down'));
		const trigger: TriggerResult = {
			phase: 'planning',
			taskId: '10',
			workItem: createMockWorkItem({ statusId: '61e4505c' }),
		};

		const outcome = await processJob(createMockPmWebhookJob(), registryReturning(trigger));

		expect(outcome.status).toBe('phase-succeeded');
		expect(resolvedTarget().model).toBe('sonnet');
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

			await processJob(createMockPmWebhookJob(), registryReturning(planningTrigger()));

			expect(resolvedTarget()).toMatchObject({ engine: 'codex', model: 'gpt-5.6-terra' });
		});

		it('routes to the next target when the preferred CLI is unavailable here', async () => {
			projectLookup = twoTargetProject;
			getAllCliQuotas.mockResolvedValue([
				quota('codex', 'unavailable'),
				quota('claude', 'available'),
			]);

			await processJob(createMockPmWebhookJob(), registryReturning(planningTrigger()));

			// The run row must record what will actually run, not the preferred target.
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

			await processJob(createMockPmWebhookJob(), registryReturning(planningTrigger()));

			// Fail visibly on spawn rather than silently skip the phase.
			expect(resolvedTarget()).toMatchObject({ engine: 'codex', model: 'gpt-5.6-terra' });
		});

		it('keeps the preferred target when the capability lookup fails', async () => {
			projectLookup = twoTargetProject;
			getAllCliQuotas.mockRejectedValue(new Error('postgres down'));

			const outcome = await processJob(
				createMockPmWebhookJob(),
				registryReturning(planningTrigger()),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(resolvedTarget()).toMatchObject({ engine: 'codex', model: 'gpt-5.6-terra' });
		});

		it('lets a per-run override win over routing', async () => {
			projectLookup = twoTargetProject;
			// codex is unavailable, but the run explicitly pins it (a manual retry).
			getAllCliQuotas.mockResolvedValue([
				quota('codex', 'unavailable'),
				quota('claude', 'available'),
			]);

			await processJob(
				createMockPmWebhookJob({
					cliOverride: 'codex',
					modelOverride: 'gpt-5.6-sol',
				}),
				registryReturning(planningTrigger()),
			);

			expect(resolvedTarget()).toMatchObject({ engine: 'codex', model: 'gpt-5.6-sol' });
		});
	});

	it('threads a shutdown-linked per-run signal through to the phase', async () => {
		// The phase now receives a per-run signal (so a single run can be terminated
		// independently, issue #166) that is *linked* to the worker's shutdown signal
		// rather than being the same object — aborting shutdown still aborts the run.
		const controller = new AbortController();
		let phaseSignal: AbortSignal | undefined;
		phaseImpl = async (_phase, context) => {
			phaseSignal = context.signal;
			return { agent: agentResult() };
		};

		await processJob(
			createMockScmWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
			controller.signal,
		);

		expect(phaseSignal).toBeInstanceOf(AbortSignal);
		expect(phaseSignal).not.toBe(controller.signal);
	});

	it('aborts the in-flight phase signal when the worker shutdown signal fires', async () => {
		const controller = new AbortController();
		let phaseSignal: AbortSignal | undefined;
		phaseImpl = async (_phase, context) => {
			phaseSignal = context.signal;
			// Fire shutdown mid-run; the linked per-run signal must abort too.
			controller.abort();
			return { agent: agentResult() };
		};

		await processJob(
			createMockScmWebhookJob(),
			registryReturning(REVIEW_TRIGGER),
			controller.signal,
		);

		expect(phaseSignal?.aborted).toBe(true);
	});

	it('reports a phase failure as phase-failed, not a thrown error', async () => {
		phaseImpl = async () => {
			throw new Error('review agent exited with code 3');
		};

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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
			createMockPmWebhookJob(),
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
			createMockPmWebhookJob({ rateLimitRetryAttempt: 6 }),
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
			createMockPmWebhookJob({ rateLimitRetryAttempt: 6 }),
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
			createMockPmWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		// Timeout is now recoverable: the run resumes rather than failing outright,
		// so no terminal failure comment is posted.
		expect(outcome.status).toBe('phase-deferred');
		expect(outcome).toMatchObject({ resumable: true });
		expect(addComment).not.toHaveBeenCalled();
	});

	// Issue #596: the run row's exit metadata must agree with the reason the same settle
	// writes into `error`, and must stay silent when nothing reported it.
	it('records the timed-out run’s own exit metadata on the deferred row', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError(
				'Implementation agent (claude) exited with code 143 (timed out)',
				{ kind: 'timeout' },
				agentResult({ exitCode: 143, timedOut: true, durationMs: 1_806_000 }),
			);
		};

		await processJob(
			createMockPmWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(completeRun).toHaveBeenCalledWith(
			'run-1',
			expect.objectContaining({
				status: 'deferred',
				exitCode: 143,
				timedOut: true,
				durationMs: 1_806_000,
			}),
		);
	});

	it('writes no placeholder exit metadata when the failure reported none', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			// The stand-in an older worker's metadata-less frame rebuilds on the control
			// plane: an exit code it does not know, and neither optional field.
			throw new AgentRunError(
				'Phase deferred (timeout) on the worker',
				{ kind: 'timeout' },
				{
					cli: 'claude',
					exitCode: null,
					signal: null,
					stdout: '',
					stderr: '',
					aborted: false,
					outputTruncated: false,
				},
			);
		};

		await processJob(
			createMockPmWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		const [, input] = completeRun.mock.calls.at(-1) as [string, Record<string, unknown>];
		expect(input.status).toBe('deferred');
		// Omitted — not `0` / `false` — so `completeRun` leaves the columns as they are and
		// the row stays distinguishable as "never reported".
		expect(input.exitCode).toBeNull();
		expect(input.timedOut).toBeUndefined();
		expect(input.durationMs).toBeUndefined();
	});

	it('does not append splitting suggestion for a non-stalled AgentRunError', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError('some other agent failure', { kind: 'error' });
		};

		const outcome = await processJob(
			createMockPmWebhookJob(),
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
			createMockPmWebhookJob(),
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
			createMockPmWebhookJob(),
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
			createMockPmWebhookJob({ rateLimitRetryAttempt: 6 }),
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
			createMockPmWebhookJob({ dependencyRecheckAttempt: 1_000_000 }),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledOnce();
		const [, body] = addComment.mock.calls[0];
		expect(body).toContain('#319');
		expect(body).toMatch(/must be done first/i);
	});

	// A transport-dispatched run reports the block over the wire and the control plane
	// rebuilds the error (`adaptResultToPhaseRun`, `@/router/dispatcher.js`); these drive
	// the resulting throw through the pluggable executor seam to prove the shared budget
	// applies identically to the two in-process tests above (issue #438).
	describe('dependency block over the dispatch path (issue #438)', () => {
		const BLOCKER = {
			reference: '#319',
			url: 'https://github.com/o/r/issues/319',
			title: 'Session auth',
			open: true,
			source: 'dependency' as const,
		} as const;

		function blockingExecutor(workItem: WorkItem): ProcessJobDeps {
			return {
				executePhase: async () => {
					throw new DependencyBlockedError(workItem, [BLOCKER]);
				},
			};
		}

		it('defers on the dependency-recheck budget without commenting', async () => {
			const workItem = createMockWorkItem({ statusId: '61e4505c' });

			const outcome = await processJob(
				createMockPmWebhookJob(),
				registryReturning({ phase: 'implementation', taskId: '100', workItem }),
				undefined,
				undefined,
				blockingExecutor(workItem),
			);

			expect(outcome).toMatchObject({ status: 'phase-deferred', dependencyRecheck: true });
			if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
			expect(outcome.reason).toContain('#319');
			expect(addComment).not.toHaveBeenCalled();
		});

		it('fails with the same board message once the budget is exhausted', async () => {
			const workItem = createMockWorkItem({ statusId: '61e4505c' });

			const outcome = await processJob(
				createMockPmWebhookJob({ dependencyRecheckAttempt: 1_000_000 }),
				registryReturning({ phase: 'implementation', taskId: '100', workItem }),
				undefined,
				undefined,
				blockingExecutor(workItem),
			);

			expect(outcome.status).toBe('phase-failed');
			expect(addComment).toHaveBeenCalledOnce();
			const [, body] = addComment.mock.calls[0];
			expect(body).toContain('#319');
			expect(body).toMatch(/must be done first/i);
		});
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
					supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
					createdAt: new Date('2026-01-01T00:00:00Z'),
					updatedAt: new Date('2026-01-01T00:00:00Z'),
				},
				enrollment: {
					id: `enr-${id}`,
					workerId: id,
					projectId: 'swarm',
					status: 'active',
					allowedClis: capabilities,
					allowedPhases: [...DEFAULT_ENROLLMENT_ALLOWED_PHASES],
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
				createMockPmWebhookJob(),
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
				createMockPmWebhookJob(),
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
				createMockPmWebhookJob({ rateLimitRetryAttempt: 3 }),
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

		// Issue #607. The row says *which kind* of wait it is in, because the two clear
		// differently: a busy machine frees itself, a revoked consent never does. The
		// distinction is visible only there — nothing about the timing changes.
		it('separates a refusal only a human can clear from a busy machine, on identical timing', async () => {
			async function settle(candidates: WorkerDispatchCandidate[]) {
				scheduleDispatchRetry.mockClear();
				listProjectDispatchCandidates.mockResolvedValue(candidates);
				const outcome = await processJob(
					createMockPmWebhookJob({ rateLimitRetryAttempt: 3 }),
					registryReturning(planningTrigger()),
				);
				const [, input] = scheduleDispatchRetry.mock.calls[0] as [string, Record<string, unknown>];
				return { outcome, input };
			}

			const busy = await settle([candidate('w-1', { activeRuns: 1 })]);
			const revoked = await settle([candidate('w-1', { sharingConsent: false })]);

			expect(busy.input.waitReason).toBe('worker-eligibility');
			expect(revoked.input.waitReason).toBe('worker-authorization');
			// Same cadence, same attempt counter, same budget: no dispatch starts earlier
			// or later because of the distinction.
			const retryDelayMs = (busy.outcome as { retryDelayMs?: number }).retryDelayMs;
			expect(retryDelayMs).toBeGreaterThan(0);
			expect(revoked.outcome).toMatchObject({ status: 'phase-deferred', retryDelayMs });
			expect(revoked.input.attempt).toBe(busy.input.attempt);
			expect(revoked.input.jobPayload).toMatchObject({
				workerEligibilityRecheckAttempt: 1,
				rateLimitRetryAttempt: 3,
			});
		});

		it('fails with the actionable reason once the re-check budget is exhausted', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				candidate('w-1', { sharingConsent: false }),
			]);

			const outcome = await processJob(
				createMockPmWebhookJob({ workerEligibilityRecheckAttempt: 1_000_000 }),
				registryReturning(planningTrigger()),
			);

			expect(outcome.status).toBe('phase-failed');
			expect(addComment).toHaveBeenCalledOnce();
			const [, body] = addComment.mock.calls[0];
			expect(body).toMatch(/sharing consent/i);
		});

		// Issue #567. The end-to-end shape of the pin: where it is read from, that the
		// wait it produces never expires, and that it is recorded as its own reason.
		describe('preserved-checkout pin', () => {
			/** A continuation of `run-1` whose checkout was preserved on `w-preserved`. */
			const continuation = () =>
				createMockPmWebhookJob({ runId: 'run-1', recoveryMode: 'checkpoint' });

			beforeEach(() => {
				getRunByIdFromDb.mockResolvedValue({ recovery: { preservedWorkerId: 'w-preserved' } });
			});

			it('waits for the pinned machine instead of running on a free worker', async () => {
				listProjectDispatchCandidates.mockResolvedValue([
					candidate('w-free'),
					candidate('w-preserved', { activeRuns: 1 }),
				]);

				const outcome = await processJob(continuation(), registryReturning(planningTrigger()));

				expect(outcome).toMatchObject({
					status: 'phase-deferred',
					preservedWorkerWait: true,
				});
				expect(phaseCalls).toEqual([]);
			});

			it('records the wait as its own dispatch reason, not a generic eligibility one', async () => {
				listProjectDispatchCandidates.mockResolvedValue([
					candidate('w-preserved', { activeRuns: 1 }),
				]);

				await processJob(continuation(), registryReturning(planningTrigger()));

				const [, input] = scheduleDispatchRetry.mock.calls[0] as [string, Record<string, unknown>];
				expect(input).toMatchObject({ waitReason: 'preserved-worker' });
			});

			it('never gives up on the pinned machine, however long it has waited', async () => {
				// The budget that ends every other eligibility wait must not end this one:
				// failing here would abandon work that is still sitting on disk.
				listProjectDispatchCandidates.mockResolvedValue([
					candidate('w-preserved', { activeRuns: 1 }),
				]);

				const outcome = await processJob(
					createMockPmWebhookJob({
						runId: 'run-1',
						recoveryMode: 'checkpoint',
						workerEligibilityRecheckAttempt: 1_000_000,
					}),
					registryReturning(planningTrigger()),
				);

				expect(outcome).toMatchObject({ status: 'phase-deferred', preservedWorkerWait: true });
				expect(addComment).not.toHaveBeenCalled();
			});

			it('runs on the pinned machine once it is free again', async () => {
				listProjectDispatchCandidates.mockResolvedValue([
					candidate('w-free'),
					candidate('w-preserved'),
				]);

				const outcome = await processJob(
					continuation(),
					registryReturning(planningTrigger()),
					undefined,
					executionIdentity('w-preserved'),
				);

				expect(outcome.status).toBe('phase-succeeded');
				expect(claimWorkerForDispatch).toHaveBeenCalledWith(
					expect.objectContaining({ selectedWorkerId: 'w-preserved' }),
				);
			});

			it('leaves a non-continuation dispatch unpinned, without reading the run row', async () => {
				listProjectDispatchCandidates.mockResolvedValue([candidate('w-free')]);

				const outcome = await processJob(
					createMockPmWebhookJob({ runId: 'run-1' }),
					registryReturning(planningTrigger()),
					undefined,
					executionIdentity('w-free'),
				);

				expect(outcome.status).toBe('phase-succeeded');
			});

			it('refuses a continuation it cannot resolve a pin for rather than routing it unpinned', async () => {
				// Dispatching a continuation without its pin is the defect itself, so an
				// unreadable run row waits — on the ordinary bounded budget, since a DB
				// that never returns must not hold the run forever.
				getRunByIdFromDb.mockRejectedValue(new Error('db down'));
				listProjectDispatchCandidates.mockResolvedValue([candidate('w-free')]);

				const outcome = await processJob(continuation(), registryReturning(planningTrigger()));

				expect(outcome).toMatchObject({
					status: 'phase-deferred',
					workerEligibilityRecheck: true,
					preservedWorkerWait: false,
				});
				expect(phaseCalls).toEqual([]);
			});
		});

		// Issue #610. The settle is the capacity-freed signal — including for a
		// federated transport worker, whose phase runs remotely and reports back here.
		describe('waking the availability waits a settle unblocks', () => {
			it('wakes them on the worker whose execution claim this dispatch held', async () => {
				listProjectDispatchCandidates.mockResolvedValue([candidate('w-1')]);

				const outcome = await processJob(
					createMockPmWebhookJob(),
					registryReturning(planningTrigger()),
					undefined,
					executionIdentity('w-1'),
				);

				expect(outcome.status).toBe('phase-succeeded');
				expect(promoteAvailabilityWaitsForWorker).toHaveBeenCalledWith('w-1', 'capacity-freed');
			});

			it('wakes them for a deferral too — the claim is released either way', async () => {
				listProjectDispatchCandidates.mockResolvedValue([candidate('w-1')]);
				phaseImpl = async () => {
					throw new AgentRunError('rate limited', { kind: 'rate-limit' }, agentResult());
				};

				const outcome = await processJob(
					createMockPmWebhookJob(),
					registryReturning(planningTrigger()),
					undefined,
					executionIdentity('w-1'),
				);

				expect(outcome.status).toBe('phase-deferred');
				expect(promoteAvailabilityWaitsForWorker).toHaveBeenCalledWith('w-1', 'capacity-freed');
			});

			it('wakes nothing when the gate refused before any claim was bound', async () => {
				listProjectDispatchCandidates.mockResolvedValue([candidate('w-1', { activeRuns: 1 })]);

				await processJob(createMockPmWebhookJob(), registryReturning(planningTrigger()));

				// No capacity was taken, so none was freed — the dispatch is simply queued
				// behind whatever is already running.
				expect(promoteAvailabilityWaitsForWorker).not.toHaveBeenCalled();
			});
		});

		it('never routes an assigned item to another user’s free worker', async () => {
			listProjectDispatchCandidates.mockResolvedValue([candidate('w-bob', { ownerUserId: BOB })]);
			resolveAssignedUser.mockResolvedValue({
				user: { id: ALICE, identifier: 'octocat', displayName: 'octocat' } as SwarmUser,
				assignee: { handle: 'octocat' },
			});

			const outcome = await processJob(
				createMockPmWebhookJob(),
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
				createMockPmWebhookJob(),
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
				createMockPmWebhookJob(),
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
				createMockPmWebhookJob(),
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
				createMockPmWebhookJob(),
				registryReturning(planningTrigger()),
				undefined,
				executionIdentity('w-claude'),
			);

			expect(phaseCalls[0].context.resolution.selection?.target).toMatchObject({
				cli: 'claude',
				model: 'opus',
				reasoning: 'high',
			});
			expect(createRun).toHaveBeenCalledWith(
				expect.objectContaining({
					workerId: 'w-claude',
					// The worker's owning user, recorded alongside it as the attribution
					// record's user half (issue #398).
					workerUserId: ALICE,
					workerFencingToken: 7,
					engine: 'claude',
					model: 'opus',
					reasoning: 'high',
				}),
			);
		});

		it('re-binds the worker and its owning user when a retry resets the run row (issue #398)', async () => {
			listProjectDispatchCandidates.mockResolvedValue([candidate('w-claude')]);

			await processJob(
				createMockPmWebhookJob({ runId: 'run-1' }),
				registryReturning(planningTrigger()),
				undefined,
				executionIdentity('w-claude'),
			);

			expect(resetRunBindings).toEqual([
				expect.objectContaining({ workerId: 'w-claude', fencingToken: 7, workerUserId: ALICE }),
			]);
		});

		it('re-binds them on the reused terminal row of a fresh dispatch too (issue #398)', async () => {
			listProjectDispatchCandidates.mockResolvedValue([candidate('w-claude')]);
			getLatestRunForTask.mockResolvedValueOnce({ id: 'run-failed', status: 'failed' } as never);

			await processJob(
				createMockPmWebhookJob(),
				registryReturning(planningTrigger()),
				undefined,
				executionIdentity('w-claude'),
			);

			expect(resetRunBindings).toEqual([
				expect.objectContaining({ workerId: 'w-claude', fencingToken: 7, workerUserId: ALICE }),
			]);
		});

		describe('single-user mode is not a dispatch policy (issue #552)', () => {
			// `SWARM_SINGLE_USER_MODE` used to short-circuit the gate before the roster
			// was read (issue #373). It no longer does: it is the API's authentication
			// policy and nothing else, so worker selection has one rule for every
			// deployment — which is what lets a single-user install dispatch over the
			// transport instead of stalling on a control plane that has no local
			// executor to bypass to.
			it('selects the enrolled worker for a single-user install', async () => {
				vi.stubEnv('SWARM_SINGLE_USER_MODE', 'true');
				listProjectDispatchCandidates.mockResolvedValue([candidate('w-local')]);

				const outcome = await processJob(
					createMockPmWebhookJob(),
					registryReturning(planningTrigger()),
					undefined,
					executionIdentity('w-local'),
				);

				expect(outcome.status).toBe('phase-succeeded');
				// The roster *was* consulted and the run is bound to the selected worker
				// under the fenced claim — no implicit local executor.
				expect(listProjectDispatchCandidates).toHaveBeenCalledWith(PROJECT.id);
				expect(claimWorkerForDispatch).toHaveBeenCalledWith(
					expect.objectContaining({ selectedWorkerId: 'w-local' }),
				);
				expect(createRun).toHaveBeenCalledWith(
					expect.objectContaining({ workerId: 'w-local', workerFencingToken: 7 }),
				);
			});

			it('still refuses an ineligible worker with the mode enabled', async () => {
				// The paired control the other way round: an enrolled worker that fails
				// the gate (here, no sharing consent) defers exactly as in multi-user
				// mode rather than being bypassed into a local run.
				vi.stubEnv('SWARM_SINGLE_USER_MODE', 'true');
				listProjectDispatchCandidates.mockResolvedValue([
					candidate('w-1', { sharingConsent: false }),
				]);

				const outcome = await processJob(
					createMockPmWebhookJob(),
					registryReturning(planningTrigger()),
				);

				expect(outcome).toMatchObject({
					status: 'phase-deferred',
					workerEligibilityRecheck: true,
				});
				expect(phaseCalls).toEqual([]);
				expect(listProjectDispatchCandidates).toHaveBeenCalledWith(PROJECT.id);
			});

			it('leaves an unfederated project running locally whatever the mode says', async () => {
				// The one path that still resolves no selection is the *unfederated* one
				// (nothing enrolled) — a property of the project, not of the auth policy.
				vi.stubEnv('SWARM_SINGLE_USER_MODE', 'true');

				const outcome = await processJob(
					createMockPmWebhookJob(),
					registryReturning(planningTrigger()),
				);

				expect(outcome.status).toBe('phase-succeeded');
				expect(listProjectDispatchCandidates).toHaveBeenCalledWith(PROJECT.id);
				expect(claimWorkerForDispatch).not.toHaveBeenCalled();
				expect(acquireProjectSlot).toHaveBeenCalledWith(PROJECT.id, PROJECT.maxConcurrentJobs);
			});

			it('tells a worker-less transport install which commands to run', async () => {
				// The control-plane path (`federatedOnly`) has no local executor, so the
				// same no-enrollment project defers there instead — and this is the
				// message a single-user install that never registered its own worker
				// finally sees on the board, so it must name the runbook rather than
				// report a bare `worker-unavailable`.
				vi.stubEnv('SWARM_SINGLE_USER_MODE', 'true');

				const outcome = await processJob(
					createMockPmWebhookJob({ workerEligibilityRecheckAttempt: 1_000_000 }),
					registryReturning(planningTrigger()),
					undefined,
					undefined,
					{ federatedOnly: true },
				);

				expect(outcome.status).toBe('phase-failed');
				expect(phaseCalls).toEqual([]);
				const [, body] = addComment.mock.calls[0];
				expect(body).toContain('swarm workers register');
				expect(body).toContain('swarm workers enroll');
			});
		});
	});

	it('defers a capacity failure briefly without posting a failure comment', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError('model at capacity', { kind: 'capacity' });
		};

		const outcome = await processJob(
			createMockPmWebhookJob(),
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
			createMockPmWebhookJob({ rateLimitRetryAttempt: 2 }),
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

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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
			createMockPmWebhookJob(),
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

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

		if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
		expect(outcome.retryDelayMs).toBeGreaterThanOrEqual(6 * 60 * 1000);
	});

	it('falls back to a default delay when the limit gave no parseable reset time', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('rate limited', { kind: 'rate-limit' });
		};

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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
			createMockScmWebhookJob({ rateLimitRetryAttempt: 6 }),
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

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

		expect(outcome.status).toBe('phase-failed');
	});

	it('fails an auth failure terminally, without probing the control plane’s own CLIs', async () => {
		// Issue #343: an unauthenticated CLI must not be re-enqueued (a retry cannot
		// succeed until a human re-`/login`s). `attempt` is 0 on this job, so
		// `phase-failed` proves terminality, not an exhausted budget.
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 1 (authentication failed)', {
				kind: 'auth',
			});
		};

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

		expect(outcome).toMatchObject({
			status: 'phase-failed',
			phase: 'review',
			taskId: '17',
			error: 'Review agent (claude) exited with code 1 (authentication failed)',
			failureDiagnosis: { kind: 'launch-or-authentication' },
		});
		// The CLI that failed to authenticate is the *worker's* (issue #553); probing
		// this host's PATH would record a bogus status for a login it knows nothing
		// about. `startHostMaintenance` (`@/api/maintenance.js`) owns that refresh.
		expect(discoverCliQuotas).not.toHaveBeenCalled();
	});

	it('defers a stalled phase instead of failing it, using minimum delayed-retry floor', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (antigravity) exited with code 1 (stalled)', {
				kind: 'stalled',
			});
		};

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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
			createMockScmWebhookJob({ rateLimitRetryAttempt: 6 }),
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

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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
			createMockPmWebhookJob(),
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
			createMockScmWebhookJob({ rateLimitRetryAttempt: 6 }),
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
		phaseImpl = async (_phase, context) => {
			seenSignal = context.signal;
			return { agent: agentResult() };
		};

		await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

		await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

		await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

		await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

		await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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
		phaseImpl = async (_phase, context) => {
			signalAborted = context.signal.aborted;
			return { agent: agentResult() };
		};

		await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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
			createMockScmWebhookJob({ rateLimitRetryAttempt: 0 }),
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
			createMockPmWebhookJob(),
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
				createMockPmWebhookJob(),
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
				createMockPmWebhookJob(),
				registryReturning(implementationTrigger(labels)),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(phaseCalls).toHaveLength(1);
		});

		it('skips an unlabeled item without spending a slot, a worktree, or tokens', async () => {
			const info = vi.spyOn(logger, 'info').mockImplementation(() => {});

			const outcome = await processJob(
				createMockPmWebhookJob(),
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
				createMockPmWebhookJob(),
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
				createMockPmWebhookJob(),
				registryReturning(implementationTrigger([])),
			);

			expect(outcome.status).toBe('skipped-not-eligible');
			// The Planning run that was already dispatched is untouched — the gate is
			// dispatch-time only.
			expect(phaseCalls).toEqual([expect.objectContaining({ phase: 'planning' })]);
		});

		it('finalizes a retried run row instead of leaving it deferred', async () => {
			const outcome = await processJob(
				createMockPmWebhookJob({ runId: 'run-7' }),
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
				createMockPmWebhookJob(),
				registryReturning(implementationTrigger([])),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(phaseCalls).toHaveLength(1);
		});

		it('honors a project-configured label instead of the default', async () => {
			projectLookup = () =>
				createMockProjectConfig({ pipeline: { automationLabel: 'automate' } }) as ProjectConfig;

			const skipped = await processJob(
				createMockPmWebhookJob(),
				registryReturning(implementationTrigger([{ id: 'LA_1', name: 'swarm' }])),
			);
			expect(skipped.status).toBe('skipped-not-eligible');

			const dispatched = await processJob(
				createMockPmWebhookJob(),
				registryReturning(implementationTrigger([{ id: 'LA_2', name: 'automate' }])),
			);
			expect(dispatched.status).toBe('phase-succeeded');
		});

		describe('SCM continuation phases (issue #354)', () => {
			// These four phases carry a pull request, not a work item, so the gate
			// resolves the PR back to its board card through the PM contract — and must
			// fail *open* when no card backs the PR or the board can't be read, since an
			// unlinked PR or a network blip must never wedge review/CI work.

			/** The board card wrapping issue 17 — the item `issue-17` (the PR branch) decodes to. */
			function card(labels: { id: string; name: string }[]) {
				return createMockWorkItem({
					id: 'item-17',
					url: 'https://github.com/SmartTechBrewery/swarm/issues/17',
					labels,
				});
			}

			const SCM_TRIGGERS: [string, TriggerResult][] = [
				['Review', REVIEW_TRIGGER],
				['Respond-to-review', RESPOND_TO_REVIEW_TRIGGER],
				['Respond-to-CI', RESPOND_TO_CI_TRIGGER],
				['Resolve-conflicts', RESOLVE_CONFLICTS_TRIGGER],
			];

			it.each(SCM_TRIGGERS)("runs %s when the PR's card carries the label", async (_n, trigger) => {
				findWorkItemForArtifact.mockResolvedValue(card([{ id: 'LA_1', name: 'swarm' }]));

				const outcome = await processJob(createMockScmWebhookJob(), registryReturning(trigger));

				expect(outcome.status).toBe('phase-succeeded');
				expect(phaseCalls).toHaveLength(1);
				// Resolved from the PR's task branch (`issue-17`), through the provider's
				// own narrow lookup — no GitHub URL shape is parsed here (ai/RULES.md §2).
				expect(findWorkItemForArtifact).toHaveBeenCalledWith({
					repository: PROJECT.repo,
					kind: 'issue',
					number: '17',
				});
			});

			it.each(SCM_TRIGGERS)("skips %s when the PR's card lacks the label", async (_n, trigger) => {
				findWorkItemForArtifact.mockResolvedValue(card([]));

				const outcome = await processJob(createMockScmWebhookJob(), registryReturning(trigger));

				expect(outcome).toMatchObject({
					status: 'skipped-not-eligible',
					phase: trigger.phase,
					taskId: trigger.taskId,
				});
				expect(phaseCalls).toEqual([]);
				expect(acquireProjectSlot).not.toHaveBeenCalled();
				expect(createRun).not.toHaveBeenCalled();
				expect(completeDispatch).toHaveBeenCalledWith('dispatch-1', 'skipped-not-eligible');
			});

			it.each([
				['Review', REVIEW_TRIGGER],
				['Respond-to-CI', RESPOND_TO_CI_TRIGGER],
			] as [
				string,
				TriggerResult,
			][])('hands back the PR+SHA dispatch dedup claim when %s is skipped', async (_n, trigger) => {
				// Otherwise the labelled retry at the same head — the operator adding
				// the label and re-running checks — is dropped as a duplicate.
				findWorkItemForArtifact.mockResolvedValue(card([]));

				await processJob(createMockScmWebhookJob(), registryReturning(trigger));

				expect(releaseReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:17:deadbeef`);
			});

			it('leaves the shared claim alone for a phase that never took it', async () => {
				findWorkItemForArtifact.mockResolvedValue(card([]));

				await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_REVIEW_TRIGGER));

				expect(releaseReviewDispatch).not.toHaveBeenCalled();
			});

			it('abandons only a skipped Review verdict reservation', async () => {
				findWorkItemForArtifact.mockResolvedValue(card([]));

				await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

				expect(abandonReviewVerdict).toHaveBeenCalledWith({
					projectId: PROJECT.id,
					repository: PROJECT.repo,
					prNumber: '17',
					headSha: 'deadbeef',
				});
				abandonReviewVerdict.mockClear();
				await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_REVIEW_TRIGGER));
				expect(abandonReviewVerdict).not.toHaveBeenCalled();
			});

			it('returns only the skipped Resolve-conflicts and Respond-to-CI claims', async () => {
				findWorkItemForArtifact.mockResolvedValue(card([]));

				await processJob(createMockScmWebhookJob(), registryReturning(RESOLVE_CONFLICTS_TRIGGER));
				expect(releaseConflictResolution).toHaveBeenCalledWith(
					`${PROJECT.repo}:17:deadbeef:cafebabe`,
				);
				expect(releaseRespondToCiAttempt).not.toHaveBeenCalled();

				releaseConflictResolution.mockClear();
				await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_CI_TRIGGER));
				expect(releaseRespondToCiAttempt).toHaveBeenCalledWith(`${PROJECT.repo}:17`);
				expect(releaseConflictResolution).not.toHaveBeenCalled();
			});

			it('runs the phase when no board card backs the PR (fails open)', async () => {
				findWorkItemForArtifact.mockResolvedValue(undefined);

				const outcome = await processJob(
					createMockScmWebhookJob(),
					registryReturning(REVIEW_TRIGGER),
				);

				expect(outcome.status).toBe('phase-succeeded');
				// Both suffixes tried — the backing item first, then the PR itself, for a
				// board that tracks pull requests as cards.
				expect(findWorkItemForArtifact.mock.calls.map(([artifact]) => artifact)).toEqual([
					{ repository: PROJECT.repo, kind: 'issue', number: '17' },
					{ repository: PROJECT.repo, kind: 'pullRequest', number: '17' },
				]);
			});

			it('runs the phase when the board lookup fails (fails open)', async () => {
				const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
				findWorkItemForArtifact.mockRejectedValue(new Error('graphql 502'));

				const outcome = await processJob(
					createMockScmWebhookJob(),
					registryReturning(REVIEW_TRIGGER),
				);

				expect(outcome.status).toBe('phase-succeeded');
				expect(warn).toHaveBeenCalledWith(
					expect.stringContaining('Could not resolve the board work item'),
					expect.objectContaining({ error: 'graphql 502' }),
				);
				warn.mockRestore();
			});

			it('reads no board at all when the project disables the gate', async () => {
				projectLookup = () =>
					createMockProjectConfig({ pipeline: { automationLabel: '' } }) as ProjectConfig;

				const outcome = await processJob(
					createMockScmWebhookJob(),
					registryReturning(REVIEW_TRIGGER),
				);

				expect(outcome.status).toBe('phase-succeeded');
				expect(findWorkItemForArtifact).not.toHaveBeenCalled();
			});

			it('falls back to the PR card for a PR outside the task-branch convention', async () => {
				const prCard = createMockWorkItem({
					id: 'item-pr-17',
					url: 'https://github.com/SmartTechBrewery/swarm/pull/17',
					labels: [],
				});
				findWorkItemForArtifact.mockResolvedValue(prCard);

				const outcome = await processJob(
					createMockScmWebhookJob(),
					registryReturning({ ...REVIEW_TRIGGER, prBranch: 'contributor-patch' }),
				);

				expect(outcome.status).toBe('skipped-not-eligible');
				expect(findWorkItemForArtifact).toHaveBeenCalledExactlyOnceWith({
					repository: PROJECT.repo,
					kind: 'pullRequest',
					number: '17',
				});
			});

			it('finalizes a retried run row instead of leaving it deferred', async () => {
				findWorkItemForArtifact.mockResolvedValue(card([]));

				const outcome = await processJob(
					createMockScmWebhookJob({ runId: 'run-9' }),
					registryReturning(REVIEW_TRIGGER),
				);

				expect(outcome.status).toBe('skipped-not-eligible');
				expect(completeRun).toHaveBeenCalledWith(
					'run-9',
					expect.objectContaining({
						status: 'failed',
						error: expect.stringContaining('automation label'),
					}),
				);
			});
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

			const first = processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));
			// Let the first call get past its awaits (project lookup, dispatch) and into
			// runPhase, so it has registered taskId 17 as in-flight.
			await new Promise((r) => setTimeout(r, 0));

			const second = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(second).toEqual({ status: 'skipped-in-flight', phase: 'review', taskId: '17' });
			expect(phaseCalls).toHaveLength(1); // the phase ran once, not twice

			release?.();
			await first; // let the first run settle so it releases the slot before the next test
		});

		it('releases the slot after the phase settles, so a later dispatch for the same task runs', async () => {
			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));
			expect(phaseCalls).toHaveLength(1);

			// Same taskId again, now that the first has finished — must not be skipped.
			const outcome = await processJob(
				createMockScmWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(phaseCalls).toHaveLength(2);
		});

		it('releases the slot even when the phase fails, so a retry for the same task can run', async () => {
			phaseImpl = async () => {
				throw new Error('boom');
			};
			const failed = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));
			expect(failed.status).toBe('phase-failed');

			phaseImpl = async () => ({ agent: agentResult() });
			const retried = await processJob(
				createMockScmWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(retried.status).toBe('phase-succeeded');
		});

		it('does not block a different task from running concurrently', async () => {
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			phaseImpl = async (_phase, context) => {
				if (context.trigger.taskId === '17') await gate; // only task 17 parks
				return { agent: agentResult() };
			};

			const first = processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));
			await new Promise((r) => setTimeout(r, 0));

			// A different taskId must run, not be skipped by task 17's in-flight slot.
			const other: TriggerResult = { ...REVIEW_TRIGGER, taskId: '18', prNumber: '18' };
			const second = await processJob(createMockScmWebhookJob(), registryReturning(other));

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
				createMockScmWebhookJob(),
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

		it('persists the PR a phase produced as the run row attribution PR (issue #398)', async () => {
			const workItem = createMockWorkItem();
			phaseImpl = async () => ({
				agent: agentResult(),
				prUrl: 'https://github.com/SmartTechBrewery/swarm/pull/7',
			});

			await processJob(
				createMockPmWebhookJob(),
				registryReturning({ phase: 'implementation', taskId: '100', workItem }),
			);

			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({
					status: 'completed',
					producedPrUrl: 'https://github.com/SmartTechBrewery/swarm/pull/7',
				}),
			);
		});

		it('leaves the attribution PR untouched for a phase that produced none', async () => {
			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

			// Omitted rather than nulled, so a settle for a non-PR-producing phase never
			// clears a PR the row already recorded.
			expect(completeRun.mock.calls[0][1]).toMatchObject({ producedPrUrl: undefined });
		});

		it('reuses and resets the existing run row when the job carries a runId (no new row)', async () => {
			const outcome = await processJob(
				createMockScmWebhookJob({ runId: 'run-1' }),
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
				createMockScmWebhookJob({ runId: 'run-gone' }),
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
			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(resetRunToRunning).not.toHaveBeenCalled();
			expect(createRun).toHaveBeenCalledOnce();
		});

		it('records a job cli override as the fresh row engine (issue #169)', async () => {
			await processJob(
				createMockScmWebhookJob({ cliOverride: 'codex' }),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(createRun).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ engine: 'codex' }),
			);
		});

		it.each([
			'failed',
			'deferred',
			'checkpointed',
		] as const)('reuses the latest %s row for a fresh webhook', async (status) => {
			getLatestRunForTask.mockResolvedValueOnce({ id: `run-${status}`, status } as never);

			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(resetRunToRunning).not.toHaveBeenCalled();
			expect(createRun).toHaveBeenCalledOnce();
		});

		it('creates a fresh row when another retry wins the terminal-row claim', async () => {
			getLatestRunForTask.mockResolvedValueOnce({ id: 'run-failed', status: 'failed' } as never);
			resetRunToRunning.mockResolvedValueOnce(false);

			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({ usage: { inputTokens: 100, outputTokens: 50 } }),
			);
		});

		it('forwards a completed Review run’s verdict into completeRun (issue #218)', async () => {
			phaseImpl = async () => ({ agent: agentResult(), verdict: 'request-changes' });

			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

				await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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

				await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

				expect(requestMergeAutomation).not.toHaveBeenCalled();
			});

			it('does not persist a merge dispatch for a non-approve verdict', async () => {
				projectLookup = () => autoMergeProject;
				phaseImpl = async () => ({ agent: agentResult(), verdict: 'request-changes' });

				await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

				expect(requestMergeAutomation).not.toHaveBeenCalled();
			});

			it('does not persist a merge dispatch for a non-Review phase', async () => {
				projectLookup = () => autoMergeProject;
				const workItem = createMockWorkItem();
				phaseImpl = async () => ({ agent: agentResult() });

				await processJob(
					createMockPmWebhookJob(),
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
				createMockPmWebhookJob(),
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
				createMockPmWebhookJob(),
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
				createMockScmWebhookJob(),
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

			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

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
				createMockScmWebhookJob(),
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
				createMockScmWebhookJob(),
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
				createMockScmWebhookJob(),
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
				createMockScmWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
		});

		it('does not create a run row for a no-trigger job', async () => {
			await processJob(createMockScmWebhookJob(), createTriggerRegistry());
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

			const first = processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));
			await new Promise((r) => setTimeout(r, 0));

			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

			// Only the first (in-flight) run created a row; the skipped duplicate did not.
			expect(createRun).toHaveBeenCalledTimes(1);

			release?.();
			await first;
		});
	});

	describe('wall-clock timeout & retry lifecycle (issue #165)', () => {
		it('passes the worker default timeout to a phase the project sets no override for', async () => {
			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(resolvedTarget().timeoutMs).toBe(DEFAULT_AGENT_TIMEOUT_MS);
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
				createMockScmWebhookJob(),
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
				createMockScmWebhookJob(),
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
			phaseImpl = async () => {
				throw new AgentRunError(
					'implementation agent (codex) exited with code 1',
					{ kind: 'error' },
					agentResult(captured),
				);
			};
			const workItem = createMockWorkItem({ statusId: '47fc9ee4' });
			const trigger: TriggerResult = { phase: 'implementation', taskId: '10', workItem };

			const outcome = await processJob(
				createMockPmWebhookJob({
					runId: 'run-1',
					cliOverride: 'codex',
					modelOverride: 'gpt-5.6-terra',
				}),
				registryReturning(trigger),
			);

			expect(outcome.status).toBe('phase-failed');
			// The dispatch must resolve the retry's overrides, not the project/coded
			// defaults — the confirmed `codex`/`gpt-5.6-terra` regression that instead
			// relaunched `antigravity`. The reused row records what will run.
			expect(resetRunBindings[0]).toMatchObject({
				engine: 'codex',
				model: 'gpt-5.6-terra',
			});
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

	/**
	 * Tier 2 — the checkpoint continuation the deferral selects (issue #503,
	 * `docs/CHECKPOINTS.md`). The checkpoint arrives on the thrown `AgentRunError`,
	 * which is the federated channel (a remote worker parses the file on its own host
	 * and the control plane rebuilds the error with it) and is the same value the
	 * in-process path reads off its own disk, so the settle logic under test is
	 * identical either way.
	 */
	describe('checkpoint continuation (Tier 2, issue #503)', () => {
		// `clearMocks` clears calls but keeps implementations, so the budget tests below
		// would otherwise leak their run row into every later test in this file.
		beforeEach(() => {
			getRunByIdFromDb.mockResolvedValue(undefined);
		});

		const CHECKPOINT: Checkpoint = {
			phase: 'respond-to-ci',
			completed: ['Fixed the failing config test'],
			remaining: ['Re-run lint and the focused tests', 'Write the hand-off file'],
			decisions: [],
			workingTree: { modified: ['src/config/schema.ts'], added: [], deleted: [] },
		};

		/** A stopped run: `rate-limit`, optionally with a captured session, optionally reporting a checkpoint. */
		const stoppedRun =
			(options: { sessionId?: string; checkpoint?: Checkpoint } = {}) =>
			async () => {
				throw new AgentRunError(
					'respond-to-ci agent (claude) exited with code 1 (rate limited)',
					{ kind: 'rate-limit' },
					agentResult({ exitCode: 1, sessionId: options.sessionId }),
					options.checkpoint,
				);
			};

		const retriedPayload = () =>
			scheduleDispatchRetry.mock.calls[0][1].jobPayload as Record<string, unknown>;

		it('settles `checkpointed` with the parsed checkpoint and dispatches the continuation', async () => {
			phaseImpl = stoppedRun({ checkpoint: CHECKPOINT });

			const outcome = await processJob(
				createMockScmWebhookJob(),
				registryReturning(RESPOND_TO_CI_TRIGGER),
			);

			expect(outcome.status).toBe('phase-deferred');
			// The row records the hand-off and spends one continuation; it deliberately
			// holds no session id, which is what the retention pin keys on instead.
			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({
					status: 'checkpointed',
					agentSessionId: null,
					checkpoint: CHECKPOINT,
					continuationCount: 1,
				}),
			);
			// …and the continuation goes out through the existing durable dispatch, asking
			// the recovery gate for the checkpoint branch on a fresh session.
			expect(retriedPayload()).toMatchObject({ recoveryMode: 'checkpoint' });
			expect(retriedPayload().resumeSession).toBeUndefined();
			expect(retriedPayload().agentSessionId).toBeDefined();
		});

		// The regression that keeps Tier 1 in front: a first stop that captured a
		// resumable session behaves exactly as it did before this feature existed, even
		// though a checkpoint is sitting right there.
		it('leaves a session-resumable stop on Tier 1, checkpoint or not', async () => {
			phaseImpl = stoppedRun({ sessionId: 'sess-ci', checkpoint: CHECKPOINT });

			const outcome = await processJob(
				createMockScmWebhookJob(),
				registryReturning(RESPOND_TO_CI_TRIGGER),
			);

			expect(outcome.status).toBe('phase-deferred');
			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({
					status: 'deferred',
					agentSessionId: 'sess-ci',
					checkpoint: undefined,
				}),
			);
			expect(retriedPayload()).toMatchObject({ resumeSession: true });
			expect(retriedPayload().recoveryMode).toBeUndefined();
		});

		// Once that resume has itself failed, the id every CLI echoes back is no longer
		// evidence the session can be re-entered — so the checkpoint takes over rather
		// than the checkout being discarded.
		it('continues from the checkpoint when the failed attempt was itself a resume', async () => {
			phaseImpl = stoppedRun({ sessionId: 'sess-ci', checkpoint: CHECKPOINT });

			const outcome = await processJob(
				createMockScmWebhookJob({ resumeSession: true, runId: 'run-1' }),
				registryReturning(RESPOND_TO_CI_TRIGGER),
			);

			expect(outcome.status).toBe('phase-deferred');
			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({ status: 'checkpointed', agentSessionId: null }),
			);
		});

		// Issue #567: the settle is the one moment `runs.worker_id` still names the
		// machine the checkout is on — every later bind overwrites it — so a settle
		// that preserves a checkout records where it is.
		it('records the machine holding the checkout a checkpointed settle preserves', async () => {
			phaseImpl = stoppedRun({ sessionId: 'sess-ci', checkpoint: CHECKPOINT });

			await processJob(
				createMockScmWebhookJob({ resumeSession: true, runId: 'run-1' }),
				registryReturning(RESPOND_TO_CI_TRIGGER),
			);

			expect(recordRunPreservedWorker).toHaveBeenCalledWith('run-1');
		});

		it('ignores a checkpoint another phase left in the shared checkout', async () => {
			phaseImpl = stoppedRun({ checkpoint: { ...CHECKPOINT, phase: 'implementation' } });

			await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_CI_TRIGGER));

			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({ status: 'deferred', checkpoint: undefined }),
			);
		});

		it('does not select checkpoint recovery when run tracking is unavailable', async () => {
			const cleanup = vi
				.spyOn(GitWorktreeManager.prototype, 'cleanup')
				.mockResolvedValue(undefined);
			createRun.mockRejectedValueOnce(new Error('database unavailable'));
			phaseImpl = stoppedRun({ checkpoint: CHECKPOINT });

			const outcome = await processJob(
				createMockScmWebhookJob({ runId: undefined }),
				registryReturning(RESPOND_TO_CI_TRIGGER),
			);

			expect(outcome.status).toBe('phase-deferred');
			expect(retriedPayload().recoveryMode).toBeUndefined();
			expect(cleanup).toHaveBeenCalledExactlyOnceWith(RESPOND_TO_CI_TRIGGER.taskId);
			cleanup.mockRestore();
		});

		it('releases the checkout when reading the continuation budget fails', async () => {
			const cleanup = vi
				.spyOn(GitWorktreeManager.prototype, 'cleanup')
				.mockResolvedValue(undefined);
			getRunByIdFromDb
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('database unavailable'));
			phaseImpl = stoppedRun({ checkpoint: CHECKPOINT });

			const outcome = await processJob(
				createMockScmWebhookJob({ runId: 'run-1' }),
				registryReturning(RESPOND_TO_CI_TRIGGER),
			);

			expect(outcome.status).toBe('phase-deferred');
			expect(retriedPayload().recoveryMode).toBeUndefined();
			expect(cleanup).toHaveBeenCalledExactlyOnceWith(RESPOND_TO_CI_TRIGGER.taskId);
			cleanup.mockRestore();
		});

		it('still settles the deferral when releasing the checkout fails', async () => {
			const cleanup = vi
				.spyOn(GitWorktreeManager.prototype, 'cleanup')
				.mockRejectedValue(new Error('git worktree remove failed'));
			getRunByIdFromDb
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('database unavailable'));
			phaseImpl = stoppedRun({ checkpoint: CHECKPOINT });

			const outcome = await processJob(
				createMockScmWebhookJob({ runId: 'run-1' }),
				registryReturning(RESPOND_TO_CI_TRIGGER),
			);

			expect(outcome.status).toBe('phase-deferred');
			expect(retriedPayload().recoveryMode).toBeUndefined();
			expect(cleanup).toHaveBeenCalledExactlyOnceWith(RESPOND_TO_CI_TRIGGER.taskId);
			cleanup.mockRestore();
		});

		it('fails terminally once the continuation budget is exhausted', async () => {
			getRunByIdFromDb.mockResolvedValue({ continuationCount: 2 });
			phaseImpl = stoppedRun({ checkpoint: CHECKPOINT });

			const outcome = await processJob(
				createMockScmWebhookJob({ runId: 'run-1' }),
				registryReturning(RESPOND_TO_CI_TRIGGER),
			);

			expect(outcome.status).toBe('phase-failed');
			// The reason is on the run's own `error`, not only in the diagnosis, so it
			// survives wherever the raw message is shown.
			expect(outcome).toMatchObject({
				error: expect.stringContaining('checkpoint continuation budget exhausted (2 of 2 used)'),
				failureDiagnosis: { kind: 'continuation-budget-exhausted' },
			});
			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({ status: 'failed' }),
			);
			// Nothing was scheduled: the fallback gave up rather than handing off again.
			expect(scheduleDispatchRetry).not.toHaveBeenCalled();
		});

		it('reads the budget from pipeline.maxContinuations', async () => {
			projectLookup = () => createMockProjectConfig({ pipeline: { maxContinuations: 3 } });
			getRunByIdFromDb.mockResolvedValue({ continuationCount: 2 });
			phaseImpl = stoppedRun({ checkpoint: CHECKPOINT });

			const outcome = await processJob(
				createMockScmWebhookJob({ runId: 'run-1' }),
				registryReturning(RESPOND_TO_CI_TRIGGER),
			);

			expect(outcome.status).toBe('phase-deferred');
			expect(completeRun).toHaveBeenCalledExactlyOnceWith(
				'run-1',
				expect.objectContaining({ status: 'checkpointed', continuationCount: 3 }),
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
		// createMockScmWebhookJob's event carries workItemId '17'.
		await reportInterruptedJobToBoard(
			createMockScmWebhookJob(),
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

	// Resolution is by the job's own `providerId`, not by the project (issue #386):
	// the job already names the provider its ingress parsed the event with, so the
	// comment lands on the provider the event came from. A second registered
	// manifest is what tells the two apart — the project-scoped lookup refuses to
	// pick between them, while the id lookup is unambiguous.
	it('resolves the commenting provider from the job’s providerId', async () => {
		const github = getSCMProvider('github');
		const bitbucket = getSCMProvider('bitbucket');
		// Asserted, not cast: if the entrypoint ever stops registering these, fail
		// here rather than in the restore below with an opaque TypeError.
		expect(github).not.toBeNull();
		expect(bitbucket).not.toBeNull();
		// The entrypoint's own Bitbucket manifest is deliberately *not* runtime-ready
		// (issue #296), so the project-scoped lookup would still resolve GitHub and
		// prove nothing. Swap in a runtime-ready stand-in: two providers competing for
		// that lookup is what makes the id lookup's answer meaningful.
		_resetSCMProviderRegistryForTesting();
		if (github) registerSCMProvider(github);
		registerSCMProvider({
			id: 'bitbucket',
			label: 'Bitbucket',
			category: 'scm',
			webhookRoute: '/bitbucket/webhook',
			provider: { commentOnPullRequest: vi.fn() },
		} as unknown as SCMProviderManifest);
		try {
			await reportInterruptedJobToBoard(createMockScmWebhookJob(), 'stalled');

			expect(commentOnPullRequest).toHaveBeenCalledTimes(1);
		} finally {
			// The registry is a process singleton with no unregister; restore the
			// entrypoint's own registrations so later cases see the real pair again.
			_resetSCMProviderRegistryForTesting();
			if (github) registerSCMProvider(github);
			if (bitbucket) registerSCMProvider(bitbucket);
		}
	});

	it('comments on the work item for a pm (board) job', async () => {
		const job = createMockPmWebhookJob();

		await reportInterruptedJobToBoard(job, 'stalled');

		expect(addComment).toHaveBeenCalledTimes(1);
		const [itemId, body] = addComment.mock.calls[0];
		expect(itemId).toBe(job.event.itemId);
		expect(body).toContain('SWARM run interrupted');
		expect(commentOnPullRequest).not.toHaveBeenCalled();
	});

	it('skips silently when the project cannot be resolved', async () => {
		projectLookup = () => undefined;

		await expect(
			reportInterruptedJobToBoard(createMockScmWebhookJob(), 'stalled'),
		).resolves.toBeUndefined();
		expect(commentOnPullRequest).not.toHaveBeenCalled();
		expect(addComment).not.toHaveBeenCalled();
	});

	it('skips a github job that carries no PR/issue number', async () => {
		const job = createMockScmWebhookJob({
			event: createMockScmEvent({ workItemId: undefined }),
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
			reportInterruptedJobToBoard(createMockScmWebhookJob(), 'stalled'),
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
			recovery: createMockPhaseRecovery(),
			runAgent,
			...overrides,
		};
	}

	beforeEach(() => {
		assignedPhaseCalls.length = 0;
		providerBuiltWith.length = 0;
		assignedPhaseImpl = async () => ({ agent: agentResult() });
	});

	it("threads the project's Planning autoAdvance setting into the phase call", async () => {
		const projectWithPipeline = createMockProjectConfig({
			pipeline: { planning: { autoAdvance: true } },
		});
		await runAssignedPhase(
			baseInputs({
				phase: 'planning',
				project: projectWithPipeline,
				workItem: createMockWorkItem(),
			}),
		);
		expect(assignedPhaseCalls[0].args.autoAdvance).toBe(true);
	});

	it('passes undefined Planning autoAdvance when the project has no override', async () => {
		await runAssignedPhase(baseInputs({ phase: 'planning', workItem: createMockWorkItem() }));
		expect(assignedPhaseCalls[0].args.autoAdvance).toBeUndefined();
	});

	it('routes planning to runPlanningPhase with the board PM provider and work item', async () => {
		const workItem = createMockWorkItem({ id: 'PVTI_1' });
		await runAssignedPhase(baseInputs({ phase: 'planning', workItem }));
		expect(assignedPhaseCalls).toHaveLength(1);
		expect(assignedPhaseCalls[0].phase).toBe('planning');
		expect(assignedPhaseCalls[0].args.workItem).toBe(workItem);
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
		expect(assignedPhaseCalls[0].args.pm).toBe(injectedPm);
		expect(providerBuiltWith).toHaveLength(0);
	});

	it('routes implementation and forwards the branch-resume flag + hook', async () => {
		const onBranchProvisioned = async () => {};
		await runAssignedPhase(
			baseInputs({
				phase: 'implementation',
				workItem: createMockWorkItem(),
				recovery: createMockPhaseRecovery({ resumeExistingBranch: true }),
				onBranchProvisioned,
			}),
		);
		expect(assignedPhaseCalls[0].phase).toBe('implementation');
		expect(assignedPhaseCalls[0].args.resumeExistingBranch).toBe(true);
		expect(assignedPhaseCalls[0].args.onBranchProvisioned).toBe(onBranchProvisioned);
	});

	it('routes review with PR coordinates and no PM provider', async () => {
		await runAssignedPhase(baseInputs({ phase: 'review', prNumber: '42', headSha: 'deadbeef' }));
		expect(assignedPhaseCalls[0].phase).toBe('review');
		expect(assignedPhaseCalls[0].args.prNumber).toBe('42');
		expect(assignedPhaseCalls[0].args.headSha).toBe('deadbeef');
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
		expect(assignedPhaseCalls[0].phase).toBe('respond-to-review');
		expect(assignedPhaseCalls[0].args.reviewId).toBe('RV_1');
		expect(providerBuiltWith).toHaveLength(1);
	});

	it('routes respond-to-ci with PR coordinates', async () => {
		await runAssignedPhase(
			baseInputs({ phase: 'respond-to-ci', prNumber: '42', prBranch: 'issue-17', headSha: 'dead' }),
		);
		expect(assignedPhaseCalls[0].phase).toBe('respond-to-ci');
		expect(assignedPhaseCalls[0].args.prBranch).toBe('issue-17');
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
		expect(assignedPhaseCalls[0].phase).toBe('resolve-conflicts');
		expect(assignedPhaseCalls[0].args.baseBranch).toBe('main');
		expect(assignedPhaseCalls[0].args.baseSha).toBe('cafe');
	});

	it('threads a fresh session id as sessionId and a resume as resumeSessionId', async () => {
		await runAssignedPhase(
			baseInputs({
				phase: 'planning',
				workItem: createMockWorkItem(),
				recovery: createMockPhaseRecovery({ sessionId: 'sess-fresh' }),
			}),
		);
		expect(assignedPhaseCalls[0].args.sessionId).toBe('sess-fresh');
		expect(assignedPhaseCalls[0].args.resumeSessionId).toBeUndefined();

		assignedPhaseCalls.length = 0;
		await runAssignedPhase(
			baseInputs({
				phase: 'review',
				prNumber: '42',
				headSha: 'dead',
				recovery: createMockPhaseRecovery({ resumeSessionId: 'sess-resume' }),
			}),
		);
		expect(assignedPhaseCalls[0].args.resumeSessionId).toBe('sess-resume');
		expect(assignedPhaseCalls[0].args.sessionId).toBeUndefined();
	});

	// Issue #591: the switch is the last hop before a phase, so a mode dropped here
	// is a mode the recovery gate never sees — on either kind of phase.
	it('forwards the recovery mode to a board-driven and a PR-driven phase', async () => {
		await runAssignedPhase(
			baseInputs({
				phase: 'implementation',
				workItem: createMockWorkItem(),
				recovery: createMockPhaseRecovery({ recoveryMode: 'checkpoint' }),
			}),
		);
		expect(assignedPhaseCalls[0].args.recoveryMode).toBe('checkpoint');

		assignedPhaseCalls.length = 0;
		await runAssignedPhase(
			baseInputs({
				phase: 'respond-to-ci',
				prNumber: '42',
				prBranch: 'issue-17',
				headSha: 'dead',
				recovery: createMockPhaseRecovery({ recoveryMode: 'fresh' }),
			}),
		);
		expect(assignedPhaseCalls[0].args.recoveryMode).toBe('fresh');
	});

	it('forwards no recovery mode when the attempt carries none', async () => {
		await runAssignedPhase(baseInputs({ phase: 'planning', workItem: createMockWorkItem() }));
		expect(assignedPhaseCalls[0].args.recoveryMode).toBeUndefined();
	});

	/**
	 * The last hop's own exhaustiveness gate (issue #591). The contract test
	 * (`tests/unit/transport/recovery-intent-contract.test.ts`) stops at
	 * `PhaseRecovery`; this covers the hop after it, which is the one that used to
	 * re-list every member by hand. Driven by the keys of a fully-populated
	 * recovery, so a member added to `PhaseRecovery` and *not* forwarded fails here
	 * instead of arriving nowhere — the exact defect this issue is about, one layer
	 * down. Every member keeps its own name on the phase options, so this is a
	 * straight key-for-key comparison.
	 */
	it('forwards every member of the phase recovery to the orchestrator', async () => {
		const recovery = createMockPhaseRecovery({
			sessionId: 'sess-fresh',
			resumeDelivery: true,
			resumeExistingBranch: true,
			recoveryMode: 'checkpoint',
		});
		// Implementation is the phase that takes all of them — including
		// `resumeExistingBranch`, which the others have no use for.
		await runAssignedPhase(
			baseInputs({ phase: 'implementation', workItem: createMockWorkItem(), recovery }),
		);

		const args = assignedPhaseCalls[0].args;
		for (const [member, value] of Object.entries(recovery)) {
			expect(
				args,
				`runAssignedPhase drops '${member}' — spread the recovery rather than re-listing its members`,
			).toHaveProperty(member, value);
		}
	});

	it('throws when a required phase input is missing rather than calling the runner', async () => {
		await expect(
			runAssignedPhase(baseInputs({ phase: 'planning', workItem: undefined })),
		).rejects.toThrow(/requires a workItem/);
		await expect(runAssignedPhase(baseInputs({ phase: 'review' }))).rejects.toThrow(
			/requires prNumber and headSha/,
		);
		expect(assignedPhaseCalls).toHaveLength(0);
	});
});

describe("the worker's out-of-band comments", () => {
	// Both are posted as SWARM, so comment loop prevention must recognize them
	// (issue #443) — an unmarked body would come back through the webhook as
	// human input.
	it('carry a SWARM-origin marker', () => {
		expect(isSwarmGeneratedBody(phaseFailureCommentBody('implementation', 'boom'))).toBe(true);
		expect(isSwarmGeneratedBody(interruptedRunCommentBody('stalled'))).toBe(true);
	});
});
