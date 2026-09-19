import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { WorkerDispatchClaimRefusal } from '@/db/repositories/dispatchesRepository.js';
import type { AgentCli, AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError, agentRunError } from '@/harness/agent-failure.js';
import type { ResolvedAssignee } from '@/identity/assignee-resolver.js';
import type { SwarmUser } from '@/identity/schema.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES } from '@/identity/worker.js';
import { DEFAULT_ENROLLMENT_ALLOWED_PHASES } from '@/identity/worker-enrollment.js';
import type { WorkerDispatchCandidate } from '@/identity/worker-enrollment-service.js';
import { requireGitHubProjectsConfig } from '@/integrations/pm/github-projects/config-schema.js';
import { describeError } from '@/lib/errors.js';
import { logger } from '@/lib/logger.js';
import { DependencyBlockedError } from '@/pipeline/dependency-guard.js';
import type { ProposedScope } from '@/pipeline/planning.js';
import { buildPreplanContract, embedPreplanMarker } from '@/pipeline/preplan.js';
import { BlockedRecoveryError } from '@/pipeline/resume.js';
import type { PMProvider, WorkItem, WorkItemAssignee } from '@/pm/types.js';
import type { CancellationOrigin } from '@/queue/cancellation.js';
import { TRANSPORT_LOST_ORPHAN_REASON } from '@/router/transport-loss-reaper.js';
import { DeliveryDeferredError, HANDOFF_FILENAMES, validatePreparedTree } from '@/scm/delivery.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { CommitUnavailableError } from '@/worktree/commit-availability.js';
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

let projectLookup: (id: string, repo?: string) => ProjectConfig | undefined;
/**
 * Every `(projectId, repository)` pair the consumer asked the project read for. The
 * repository is the whole point since issue #684 phase 2 — the real read scopes the
 * record to it, and a project that does not own it throws — so the scoping describe
 * block below asserts on the *argument*, and the throwing case fakes the throw here.
 */
const projectLookupCalls: Array<{ id: string; repo?: string }> = [];
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByIdFromDb: async (id: string, repo?: string) => {
		projectLookupCalls.push({ id, repo });
		return projectLookup(id, repo);
	},
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
	advancedItemIds?: string[];
	verdict?: string;
	reviewOrdinal?: number;
	automationOutcome?: string;
	ciOutcome?: string;
	absorbed?: Array<{ url: string; reference: string; evidence: string }>;
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
	// The real vocabulary, not a stand-in: the no-trigger settle narrows a ledger
	// verdict against it before writing it back onto a run (issue #815).
	REVIEW_VERDICTS: ['approve', 'request-changes'],
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
	/**
	 * What the dispatch's own trigger resolved on an earlier evaluation, as
	 * `recordDispatchResolution` writes it. Null on a row whose delivery resolved
	 * nothing — which is exactly what the no-trigger hand-back gate reads (issue
	 * #856).
	 */
	phase: string | null;
};
function mockDispatchRow(
	job: Record<string, unknown>,
	phase: string | null = null,
): MockDispatchRow {
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
		phase,
	};
}
/** What the two resolution writers now take — one object rather than positionals. */
type MockDispatchResolution = {
	taskId: string;
	phase: string;
	pullRequest?: { repository: string; prNumber: string };
};

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
const promoteTaskInFlightWaits = vi.fn(async (_projectId: string, _taskId: string) => 0);
const promotePullRequestInFlightWaits = vi.fn(
	async (_projectId: string, _repository: string, _prNumber: string) => 0,
);
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
	promoteTaskInFlightWaits: (projectId: string, taskId: string) =>
		promoteTaskInFlightWaits(projectId, taskId),
	promotePullRequestInFlightWaits: (projectId: string, repository: string, prNumber: string) =>
		promotePullRequestInFlightWaits(projectId, repository, prNumber),
	publishDispatchWakeUp: (dispatch: unknown) => publishDispatchWakeUp(dispatch),
}));

const completeDispatch = vi.fn(async (_id: string, _outcome: string) => true);
const failDispatch = vi.fn(async (_id: string, _error: string) => true);
const cancelClaimedDispatch = vi.fn(async (_id: string, _reason: string) => true);
const markDispatchRunning = vi.fn(
	async (
		_id: string,
		_runId: string | undefined,
		_leaseUntil: Date,
		_resolution: MockDispatchResolution,
	) => true,
);
const recordDispatchResolution = vi.fn(
	async (_id: string, _resolution: MockDispatchResolution) => {},
);
const findExecutingWritingDispatchForPullRequest = vi.fn(
	async (
		_projectId: string,
		_repository: string,
		_prNumber: string,
		_excludeDispatchId?: string,
	): Promise<{ id: string; phase: string | null } | undefined> => undefined,
);
const findExecutingDispatchForTask = vi.fn(
	async (
		_projectId: string,
		_taskId: string,
		_excludeDispatchId?: string,
	): Promise<{ id: string; phase: string | null } | undefined> => undefined,
);
const findActivePlanningDispatchForTask = vi.fn(
	async (
		_projectId: string,
		_taskId: string,
		_excludeDispatchId?: string,
	): Promise<{ id: string; state: string } | undefined> => undefined,
);
/**
 * The row behind an in-process in-flight claim, which the guard reads to tell a live
 * claim from one whose dispatch has already settled (issue #858). Defaults to the
 * harness's own `leased` row — an *active* state — so every pre-existing collision case
 * keeps today's verdict.
 */
const getDispatchById = vi.fn(
	async (_id: string): Promise<MockDispatchRow | undefined> => mockDispatchRow({}),
);
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
		| { claimed: true; dispatch: MockDispatchRow }
		// The whole refusal vocabulary, so a case can force any of them the way the real
		// under-lock re-check would (issues #607, #919).
		| { claimed: false; reason: WorkerDispatchClaimRefusal }
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
		resolution: MockDispatchResolution,
	) => markDispatchRunning(id, runId, leaseUntil, resolution),
	recordDispatchResolution: (id: string, resolution: MockDispatchResolution) =>
		recordDispatchResolution(id, resolution),
	BRANCH_WRITING_PHASES: ['respond-to-review', 'respond-to-ci', 'resolve-conflicts'],
	ACTIVE_DISPATCH_STATES: ['pending', 'leased', 'running', 'retry-scheduled'],
	getDispatchById: (id: string) => getDispatchById(id),
	findExecutingWritingDispatchForPullRequest: (
		projectId: string,
		repository: string,
		prNumber: string,
		excludeDispatchId?: string,
	) =>
		findExecutingWritingDispatchForPullRequest(projectId, repository, prNumber, excludeDispatchId),
	findExecutingDispatchForTask: (projectId: string, taskId: string, excludeDispatchId?: string) =>
		findExecutingDispatchForTask(projectId, taskId, excludeDispatchId),
	findActivePlanningDispatchForTask: (
		projectId: string,
		taskId: string,
		excludeDispatchId?: string,
	) => findActivePlanningDispatchForTask(projectId, taskId, excludeDispatchId),
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
/**
 * The durable "this review really was delivered" record the no-trigger settle
 * reads to tell an already-succeeded redelivery from a run that never did
 * anything (issue #815). Defaults to "no submitted slot", which is the shape
 * every pre-existing case expects.
 */
const getSubmittedReviewSlot = vi.fn(
	async (_key: unknown) =>
		undefined as { ordinal: number; verdict: string | null; reviewId: string | null } | undefined,
);
vi.mock('@/db/repositories/reviewVerdictsRepository.js', () => ({
	abandonReviewVerdict: (key: unknown) => abandonReviewVerdict(key),
	getSubmittedReviewSlot: (key: unknown) => getSubmittedReviewSlot(key),
	// The one-line rule itself, re-implemented rather than proxied: the real
	// module is fully mocked here, and `REVIEW_VERDICT_CAP` is 3.
	isCapReachingRequestChanges: (ordinal: number | undefined, verdict: string | null | undefined) =>
		ordinal !== undefined && ordinal >= 3 && verdict === 'request-changes',
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
/**
 * Issue #954 — the terminal settle of the row a *continuation* carries, which the
 * gate's refusal reaches through no run of its own.
 */
const failRunFromStatus = vi.fn(
	async (_id: string, _reason: string, _fromStatus?: string, _diagnosis?: unknown) => true,
);
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
					// The *last bind's* worker (issue #954) — read only to tell a run that
					// never bound a machine from one whose recorded machine went missing.
					workerId?: string | null;
					// Read by the no-trigger settle (issue #815) to establish that the
					// redelivered run really is the Review the ledger slot belongs to.
					phase?: string;
					taskId?: string | null;
					prNumber?: string | null;
					// Issue #971 — the two the no-trigger settle narrows on before it reads
					// `taskId`: a maintenance run carries neither.
					kind?: string;
					repository?: string | null;
			  }
			| undefined,
);
/** Issue #567 — the settle-time record of which machine holds the preserved checkout. */
const recordRunPreservedWorker = vi.fn(async (_runId: string) => {});
// Issue #1018 — the run's record of which machines could not obtain its commit: the
// write the failure makes, and the read the next dispatch's gate does.
const recordRunCommitUnavailableWorker = vi.fn(async (_runId: string) => {});
const listRunCommitUnavailableWorkerIds = vi.fn(async (_runId: string): Promise<string[]> => []);
vi.mock('@/db/repositories/runsRepository.js', () => ({
	createRun: (input: unknown) => createRun(input),
	completeRun: (id: string, input: unknown) => completeRun(id, input),
	failRunFromStatus: (id: string, reason: string, fromStatus?: string, diagnosis?: unknown) =>
		failRunFromStatus(id, reason, fromStatus, diagnosis),
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
	recordRunCommitUnavailableWorker: (runId: string) => recordRunCommitUnavailableWorker(runId),
	listRunCommitUnavailableWorkerIds: (runId: string) => listRunCommitUnavailableWorkerIds(runId),
	// Issue #971 — a pure predicate over the row's own columns, so the real rule is
	// restated rather than stubbed to a constant: the no-trigger settle must agree with
	// the repository about what counts as pipeline work.
	isPipelineRun: (run: { kind?: string; repository?: string | null; taskId?: string | null }) =>
		run.kind === 'pipeline' && run.repository !== null && run.taskId !== null,
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

// The `no-fix` hand-back to Review (issue #841), mocked at its own boundary for
// the same reason: these tests assert that a `no-fix` Respond-to-CI run schedules
// exactly one recovery with the right coordinates, not how that recovery is built
// (which is `tests/unit/dispatch/ci-no-fix-recovery.test.ts`).
const scheduleCiNoFixRecovery = vi.fn(async (_input: unknown) => {});
vi.mock('@/dispatch/ci-no-fix-recovery.js', () => ({
	scheduleCiNoFixRecovery: (input: unknown) => scheduleCiNoFixRecovery(input),
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
// The clear also carries the run's identity since issue #913: a clear that actually
// removes a pending marker is the audit record that the cancellation took effect.
const clearRunCancellation = vi.fn(
	async (_runId: string, _context: { action: string; projectId: string }) => {},
);
const getRunCancellationOrigin = vi.fn<(runId: string) => Promise<CancellationOrigin | null>>(
	async () => null,
);
vi.mock('@/queue/cancellation.js', () => ({
	isRunCancellationRequested: (runId: string) => isRunCancellationRequested(runId),
	clearRunCancellation: (runId: string, context: { action: string; projectId: string }) =>
		clearRunCancellation(runId, context),
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
	if (!runId || !controller) return false;
	registerRunController(runId, controller);
	if (await isRunCancellationRequested(runId)) {
		controller.abort();
		return true;
	}
	return false;
});

vi.mock('@/worker/run-cancellation.js', () => ({
	registerRunController: (runId: string, controller: AbortController) =>
		registerRunController(runId, controller),
	unregisterRunController: (runId: string) => unregisterRunController(runId),
	linkRunAbortController: (signal?: AbortSignal) => linkRunAbortController(signal),
	beginRunCancellationTracking: (runId?: string, controller?: AbortController) =>
		beginRunCancellationTracking(runId, controller),
	// Real class so `handlePhaseFailure`'s `instanceof RunTerminatedError` guard is
	// a valid constructor check — and so `processJob` can throw one itself for a run
	// whose cancellation was already recorded at pickup (issue #912).
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
		// The machine-scoped dispatch kind's one collaborator (issue #972) — required
		// on the interface so a missing wiring is a compile error rather than an update
		// that silently never arrives.
		pushWorkerUpdate: async (workerId, requestId) => {
			workerUpdatePushes.push({ workerId, requestId });
			return workerUpdatePushResult;
		},
		...overrides,
	};
}

/** Every `pushWorkerUpdate` the dispatcher made, in order. */
let workerUpdatePushes: Array<{ workerId: string; requestId: string }> = [];
/** What the injected push answers — varied by the `worker-update` cases below. */
let workerUpdatePushResult: 'pushed' | 'superseded' | 'not-connected' = 'pushed';

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

// `scm` is stated rather than left to the sole-runtime-ready fallback: with GitHub
// *and* Bitbucket runtime-ready since issue #618, a project naming no provider makes
// `requireProjectSCMProvider` throw — which is exactly what a real installation must
// now fix by setting this one field.
const PROJECT = createMockProjectConfig({ scm: 'github' });
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

const HELD_CLAIM_REASON =
	"Another dispatch holds the review slot for pull request #17 at head 'deadbeef'";

/**
 * A registry whose single handler declines *and says why* — the shape the
 * `pr-review` handler produces when another dispatch already holds the PR+SHA
 * review slot (issue #1019).
 */
function registryDecliningWithHeldClaim(
	// Defaulted as a whole object rather than per-field, so a case can state the
	// *unreadable* lease by passing `{}` — a bare `undefined` would take the default.
	{ retryAfterSec }: { retryAfterSec?: number } = { retryAfterSec: 180 },
) {
	const registry = createTriggerRegistry();
	registry.register({
		name: 'test-trigger',
		description: 'declines because the dispatch slot is held',
		matches: () => true,
		handle: async (ctx) => {
			ctx.noteDecline?.({
				kind: 'dispatch-claim-held',
				reason: HELD_CLAIM_REASON,
				retryAfterSec,
			});
			return null;
		},
	});
	return registry;
}

/**
 * Claim the next dispatch as a row whose earlier evaluation resolved `phase` —
 * what `recordDispatchResolution` leaves behind, and the only thing the
 * no-trigger hand-back gate keys on (issue #856).
 */
function claimDispatchWithPhase(phase: string) {
	claimDispatchForJob.mockImplementationOnce(async (job: Record<string, unknown>) => ({
		claimed: true,
		dispatch: mockDispatchRow(job, phase),
	}));
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
		projectLookupCalls.length = 0;
		workerUpdatePushes = [];
		workerUpdatePushResult = 'pushed';
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
		promoteTaskInFlightWaits.mockClear();
		promotePullRequestInFlightWaits.mockClear();
		findExecutingWritingDispatchForPullRequest.mockReset();
		findExecutingWritingDispatchForPullRequest.mockResolvedValue(undefined);
		publishDispatchWakeUp.mockClear();
		completeDispatch.mockClear();
		failDispatch.mockClear();
		cancelClaimedDispatch.mockClear();
		markDispatchRunning.mockClear();
		recordDispatchResolution.mockClear();
		findExecutingDispatchForTask.mockClear();
		findExecutingDispatchForTask.mockResolvedValue(undefined);
		findActivePlanningDispatchForTask.mockClear();
		findActivePlanningDispatchForTask.mockResolvedValue(undefined);
		getDispatchById.mockReset();
		getDispatchById.mockImplementation(async (_id: string) => mockDispatchRow({}));
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
		failRunFromStatus.mockClear();
		failRunFromStatus.mockResolvedValue(true);
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
		scheduleCiNoFixRecovery.mockClear();
		scheduleCiNoFixRecovery.mockResolvedValue(undefined);
		getSubmittedReviewSlot.mockClear();
		getSubmittedReviewSlot.mockResolvedValue(undefined);
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

		// The dispatch goes `pending` before the run is settled, so board-phase
		// retirement (issue #909) can cancel it and settle its run in between. The
		// guard is what makes this write lose to that, instead of putting a
		// `deferred` run back under a cancelled dispatch for the backfill to find.
		it('guards the pre-run deferral’s run settle on the row still being `running`', async () => {
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

			await processJob(
				createMockScmWebhookJob({ runId: undefined }),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(completeRun).toHaveBeenCalledWith(
				'run-1',
				expect.objectContaining({ status: 'deferred', fromStatus: 'running' }),
			);
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
			claimDispatchWithPhase('review');

			const outcome = await processJob(job, registryReturning(null));

			expect(outcome.status).toBe('no-trigger');
			expect(completeRun).toHaveBeenCalledWith('run-123', {
				status: 'failed',
				error: expect.stringContaining('no-trigger'),
			});
			expect(releaseReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:17:deadbeef`);
		});

		// Issue #815: a rate-limit retry redelivers the Review's original event, the
		// trigger correctly declines because the verdict slot is already `submitted`,
		// and the branch above used to write `failed` over a run that had genuinely
		// approved the PR — losing its merge automation with it.
		describe('no-trigger redelivery of an already-completed Review run (issue #815)', () => {
			const autoMergeProject = createMockProjectConfig({
				pipeline: { respondToReview: { autoMerge: true } },
			});
			const redeliveredJob = () =>
				createMockScmWebhookJob({
					runId: 'run-123',
					continuationDispatchClaimed: true,
					event: createMockScmEvent({ headSha: 'deadbeef' }),
				});
			/** The run row behind the redelivery: the Review for the same PR. */
			const completedReviewRun = (overrides: Record<string, unknown> = {}) =>
				getRunByIdFromDb.mockResolvedValue({
					kind: 'pipeline',
					repository: 'SmartTechBrewery/swarm',
					phase: 'review',
					taskId: '17',
					prNumber: '17',
					...overrides,
				});

			it('records the ledger outcome as completed and still requests the merge', async () => {
				projectLookup = () => autoMergeProject;
				claimDispatchWithPhase('review');
				completedReviewRun();
				getSubmittedReviewSlot.mockResolvedValue({
					ordinal: 1,
					verdict: 'approve',
					reviewId: '5054356757',
				});

				const outcome = await processJob(redeliveredJob(), registryReturning(null));

				expect(outcome.status).toBe('no-trigger');
				expect(getSubmittedReviewSlot).toHaveBeenCalledWith({
					projectId: autoMergeProject.id,
					repository: autoMergeProject.repo,
					prNumber: '17',
					headSha: 'deadbeef',
				});
				expect(completeRun).toHaveBeenCalledWith('run-123', {
					status: 'completed',
					error: null,
					nextRetryAt: null,
					reviewVerdict: 'approve',
					reviewOrdinal: 1,
					reviewAutomationOutcome: undefined,
				});
				// Nothing is handed back: the review really was submitted, so releasing
				// the claim would let a sibling event post a duplicate, and abandoning
				// the ledger slot would discard that verdict's own record (issue #856
				// hands back on every *other* no-trigger path, so this is the one
				// exception it preserves).
				expect(releaseReviewDispatch).not.toHaveBeenCalled();
				expect(abandonReviewVerdict).not.toHaveBeenCalled();
				expect(requestMergeAutomation).toHaveBeenCalledExactlyOnceWith({
					project: autoMergeProject,
					reviewRunId: 'run-123',
					taskId: '17',
					prNumber: '17',
					approvedHeadSha: 'deadbeef',
				});
			});

			// `uq_dispatches_active_run` allows one non-terminal dispatch per run, so
			// the merge dispatch can only be inserted once this one is terminal.
			it('completes the no-trigger dispatch before requesting the merge', async () => {
				projectLookup = () => autoMergeProject;
				completedReviewRun();
				getSubmittedReviewSlot.mockResolvedValue({
					ordinal: 1,
					verdict: 'approve',
					reviewId: '5054356757',
				});

				await processJob(redeliveredJob(), registryReturning(null));

				expect(completeDispatch.mock.invocationCallOrder[0]).toBeLessThan(
					requestMergeAutomation.mock.invocationCallOrder[0] as number,
				);
			});

			it('records the completed outcome but requests no merge when autoMerge is off', async () => {
				completedReviewRun();
				getSubmittedReviewSlot.mockResolvedValue({
					ordinal: 1,
					verdict: 'approve',
					reviewId: '5054356757',
				});

				await processJob(redeliveredJob(), registryReturning(null));

				expect(completeRun).toHaveBeenCalledWith(
					'run-123',
					expect.objectContaining({ status: 'completed', reviewVerdict: 'approve' }),
				);
				expect(requestMergeAutomation).not.toHaveBeenCalled();
			});

			it('carries the cap-reaching request-changes automation outcome and merges nothing', async () => {
				projectLookup = () => autoMergeProject;
				completedReviewRun();
				getSubmittedReviewSlot.mockResolvedValue({
					ordinal: 3,
					verdict: 'request-changes',
					reviewId: '99',
				});

				await processJob(redeliveredJob(), registryReturning(null));

				expect(completeRun).toHaveBeenCalledWith(
					'run-123',
					expect.objectContaining({
						status: 'completed',
						reviewVerdict: 'request-changes',
						reviewOrdinal: 3,
						reviewAutomationOutcome: 'manual-intervention-required',
					}),
				);
				expect(requestMergeAutomation).not.toHaveBeenCalled();
			});

			// The ledger slot exists for this PR+head, but it is the Review's record —
			// a continuation of another phase must not adopt its verdict.
			it('still fails a non-Review continuation for the same PR and head', async () => {
				projectLookup = () => autoMergeProject;
				claimDispatchWithPhase('respond-to-review');
				completedReviewRun({ phase: 'respond-to-review' });
				getSubmittedReviewSlot.mockResolvedValue({
					ordinal: 1,
					verdict: 'approve',
					reviewId: '5054356757',
				});

				await processJob(redeliveredJob(), registryReturning(null));

				expect(completeRun).toHaveBeenCalledWith('run-123', {
					status: 'failed',
					error: expect.stringContaining('no-trigger'),
				});
				// A Respond-to-review dispatch never took the PR+SHA claim, so releasing
				// it here could hand away a live Review's slot (issue #856).
				expect(releaseReviewDispatch).not.toHaveBeenCalled();
				expect(requestMergeAutomation).not.toHaveBeenCalled();
			});

			it('still fails when the run acted on a different pull request', async () => {
				completedReviewRun({ prNumber: '999' });
				getSubmittedReviewSlot.mockResolvedValue({
					ordinal: 1,
					verdict: 'approve',
					reviewId: '5054356757',
				});

				await processJob(redeliveredJob(), registryReturning(null));

				expect(completeRun).toHaveBeenCalledWith('run-123', {
					status: 'failed',
					error: expect.stringContaining('no-trigger'),
				});
			});

			it('still fails when this head has no submitted verdict', async () => {
				claimDispatchWithPhase('review');
				completedReviewRun();

				await processJob(redeliveredJob(), registryReturning(null));

				expect(completeRun).toHaveBeenCalledWith('run-123', {
					status: 'failed',
					error: expect.stringContaining('no-trigger'),
				});
				expect(releaseReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:17:deadbeef`);
			});

			// A board-driven continuation carries no PR/head, so the ledger has no key
			// to answer with — and must not be read at all.
			it('does not read the ledger for a board-driven continuation', async () => {
				await processJob(
					{ ...createMockPmWebhookJob(), runId: 'run-123' },
					registryReturning(null),
				);

				expect(getSubmittedReviewSlot).not.toHaveBeenCalled();
				// Nor written to: a delivery that was never a Review leaves the ledger
				// exactly as it found it (issue #856).
				expect(abandonReviewVerdict).not.toHaveBeenCalled();
				expect(completeRun).toHaveBeenCalledWith('run-123', {
					status: 'failed',
					error: expect.stringContaining('no-trigger'),
				});
			});

			it('falls back to the failure settle when the ledger read throws', async () => {
				projectLookup = () => autoMergeProject;
				completedReviewRun();
				getSubmittedReviewSlot.mockRejectedValue(new Error('db down'));

				const outcome = await processJob(redeliveredJob(), registryReturning(null));

				expect(outcome.status).toBe('no-trigger');
				expect(completeRun).toHaveBeenCalledWith('run-123', {
					status: 'failed',
					error: expect.stringContaining('no-trigger'),
				});
				expect(requestMergeAutomation).not.toHaveBeenCalled();
			});
		});

		// Issue #1019: the settle's generic wording is a *guess* at the cause, and for
		// a dispatch dropped because SWARM's own PR+SHA lock is held it guessed wrong
		// in the most expensive direction — it named the board, so the operator went
		// and inspected a disposition that was fine.
		describe('a decline the handler named is reported as such (issue #1019)', () => {
			/** The live-collision shape: a continuation carrying the run it retries. */
			const collidingContinuation = (overrides: Record<string, unknown> = {}) =>
				createMockScmWebhookJob({
					runId: 'run-123',
					event: createMockScmEvent({ headSha: 'deadbeef' }),
					...overrides,
				});

			it("records the handler's reason instead of the disposition wording", async () => {
				claimDispatchWithPhase('review');

				const outcome = await processJob(collidingContinuation(), registryDecliningWithHeldClaim());

				expect(outcome.status).toBe('no-trigger');
				expect(completeRun).toHaveBeenCalledWith(
					'run-123',
					expect.objectContaining({ error: HELD_CLAIM_REASON }),
				);
				expect(completeRun).not.toHaveBeenCalledWith(
					'run-123',
					expect.objectContaining({ error: expect.stringContaining('disposition changed') }),
				);
			});

			// The other half of the acceptance criteria: a retry blocked by a claim
			// that is *genuinely* held is waiting for a holder, not failing. Marking it
			// terminal records a second Review failure for a phase nothing is wrong
			// with, and leaves the operator to click again once the holder settles.
			it('defers the carried run instead of failing it terminally', async () => {
				claimDispatchWithPhase('review');

				const outcome = await processJob(collidingContinuation(), registryDecliningWithHeldClaim());

				expect(outcome).toEqual({ status: 'no-trigger', heldClaimRetryScheduled: true });
				expect(completeRun).toHaveBeenCalledWith('run-123', {
					status: 'deferred',
					error: HELD_CLAIM_REASON,
					nextRetryAt: expect.any(Date),
				});
				expect(completeRun).not.toHaveBeenCalledWith(
					'run-123',
					expect.objectContaining({ status: 'failed' }),
				);
				// The dispatch is re-scheduled, not settled: it is the durable intent
				// that brings the retry back once the holder's lease lapses.
				expect(completeDispatch).not.toHaveBeenCalled();
				expect(scheduleDispatchRetry).toHaveBeenCalledOnce();
				const [, input] = scheduleDispatchRetry.mock.calls[0] as [string, Record<string, unknown>];
				expect(input).toMatchObject({
					waitReason: 'recheck',
					lastError: HELD_CLAIM_REASON,
					runId: 'run-123',
					attempt: 1,
				});
				// Timed by the holder's own lease (180 s here) plus the margin that puts
				// the re-check *after* it, rather than on a number of our own.
				expect((input.availableAt as Date).getTime() - Date.now()).toBeGreaterThan(180_000);
				expect((input.availableAt as Date).getTime() - Date.now()).toBeLessThanOrEqual(182_000);
				// The counter the budget is spent from rides the persisted retry payload.
				expect(updateRunJobPayload).toHaveBeenCalledWith(
					'run-123',
					expect.objectContaining({ dispatchClaimRecheckAttempt: 1 }),
				);
				expect(publishDispatchWakeUp).toHaveBeenCalledOnce();
			});

			// No lease to sit out — an unreachable Redis reads the same way — so the
			// re-check lands on its own short cadence instead of a guessed wait.
			it('falls back to its own cadence when the lease could not be read', async () => {
				claimDispatchWithPhase('review');

				await processJob(collidingContinuation(), registryDecliningWithHeldClaim({}));

				const [, input] = scheduleDispatchRetry.mock.calls[0] as [string, Record<string, unknown>];
				expect((input.availableAt as Date).getTime() - Date.now()).toBeLessThanOrEqual(30_000);
			});

			// Bounded, like every other token-free re-check: a holder that keeps
			// refreshing its claim is not out-waited forever. The report still names the
			// collision — the operator is never sent back to the board.
			it('fails with the collision reason once the re-check budget is spent', async () => {
				claimDispatchWithPhase('review');

				const outcome = await processJob(
					collidingContinuation({ dispatchClaimRecheckAttempt: 3 }),
					registryDecliningWithHeldClaim(),
				);

				expect(outcome.status).toBe('no-trigger');
				expect(scheduleDispatchRetry).not.toHaveBeenCalled();
				expect(completeRun).toHaveBeenCalledWith('run-123', {
					status: 'failed',
					error: HELD_CLAIM_REASON,
				});
				expect(completeDispatch).toHaveBeenCalledWith('dispatch-1', 'no-trigger');
			});

			// A fresh delivery that collides is the duplicate the dedup exists to drop:
			// there is no run behind it to wait for, and nothing was mis-reported.
			it('drops a colliding delivery that carries no run', async () => {
				claimDispatchWithPhase('review');

				const outcome = await processJob(
					createMockScmWebhookJob({ event: createMockScmEvent({ headSha: 'deadbeef' }) }),
					registryDecliningWithHeldClaim(),
				);

				expect(outcome.status).toBe('no-trigger');
				expect(scheduleDispatchRetry).not.toHaveBeenCalled();
				expect(completeRun).not.toHaveBeenCalled();
				expect(completeDispatch).toHaveBeenCalledWith('dispatch-1', 'no-trigger');
			});

			// And once the holder settles, the re-check it was deferred for dispatches
			// exactly like any other delivery — the spent counter gates nothing but the
			// wait itself.
			it('dispatches normally when the re-check finds the slot free', async () => {
				const outcome = await processJob(
					collidingContinuation({ dispatchClaimRecheckAttempt: 1 }),
					registryReturning(REVIEW_TRIGGER),
				);

				expect(outcome.status).toBe('phase-succeeded');
				expect(phaseCalls).toHaveLength(1);
			});

			// The hand-back releases what *this dispatch's own trigger* claimed, and a
			// dispatch declined because another one holds the slot claimed nothing. The
			// `dispatch.phase` gate cannot see that on its own: an operator's "Retry
			// now" / "Reset & restart" carries the retried run's phase from the moment
			// its row is created, so without the decline it would release a live
			// Review's claim and abandon its ledger reservation.
			it('hands back nothing it did not take', async () => {
				const job = createMockScmWebhookJob({
					runId: 'run-123',
					event: createMockScmEvent({ headSha: 'deadbeef' }),
				});
				claimDispatchWithPhase('review');

				await processJob(job, registryDecliningWithHeldClaim());

				expect(releaseReviewDispatch).not.toHaveBeenCalled();
				expect(abandonReviewVerdict).not.toHaveBeenCalled();
			});
		});

		// Issue #856: the trigger takes the PR+SHA dedup claim and the durable
		// review-verdict reservation in the router, before any run row exists, while
		// every hand-back used to be keyed on `job.runId`. A dispatch deferred for
		// worker capacity has no run, so a `no-trigger` re-evaluation leaked the
		// `pending` ledger row — and one pending row per PR makes every later Review
		// of that PR `blocked` at any head (live on `rover#116`).
		describe('a no-trigger settle hands back what the trigger claimed (issue #856)', () => {
			/** The live sequence's job: reserved and claimed, then deferred with no run. */
			const deferredWithNoRun = () =>
				createMockScmWebhookJob({
					runId: undefined,
					continuationDispatchClaimed: true,
					event: createMockScmEvent({ headSha: 'b055cb7e' }),
				});

			it('hands back both claims when the dispatch never produced a run row', async () => {
				claimDispatchWithPhase('review');

				const outcome = await processJob(deferredWithNoRun(), registryReturning(null));

				expect(outcome.status).toBe('no-trigger');
				expect(abandonReviewVerdict).toHaveBeenCalledExactlyOnceWith({
					projectId: PROJECT.id,
					repository: PROJECT.repo,
					prNumber: '17',
					headSha: 'b055cb7e',
				});
				expect(releaseReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:17:b055cb7e`);
				// There is no run row to finalize — the gate that used to suppress the
				// whole hand-back.
				expect(completeRun).not.toHaveBeenCalled();
				expect(completeDispatch).toHaveBeenCalledWith('dispatch-1', 'no-trigger');
			});

			// Respond-to-CI shares the Review's PR+SHA slot but reserves no ledger slot.
			it('hands back only the shared claim for a Respond-to-CI dispatch', async () => {
				claimDispatchWithPhase('respond-to-ci');

				await processJob(deferredWithNoRun(), registryReturning(null));

				expect(releaseReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:17:b055cb7e`);
				expect(abandonReviewVerdict).not.toHaveBeenCalled();
			});

			it('leaves both alone for a dispatch that resolved another phase', async () => {
				claimDispatchWithPhase('resolve-conflicts');

				await processJob(deferredWithNoRun(), registryReturning(null));

				expect(releaseReviewDispatch).not.toHaveBeenCalled();
				expect(abandonReviewVerdict).not.toHaveBeenCalled();
			});

			// The sibling `checks completed` event the dedup claim drops: it resolved
			// nothing, so its dispatch row carries no phase. Handing back on its behalf
			// would release a live Review's claim and abandon its pending row.
			it('leaves both alone for a delivery that resolved nothing at all', async () => {
				await processJob(deferredWithNoRun(), registryReturning(null));

				expect(releaseReviewDispatch).not.toHaveBeenCalled();
				expect(abandonReviewVerdict).not.toHaveBeenCalled();
			});

			// The hand-back is best-effort: a ledger hiccup must not fail a dispatch
			// that is being settled deliberately.
			it('still settles no-trigger when the ledger hand-back throws', async () => {
				claimDispatchWithPhase('review');
				abandonReviewVerdict.mockRejectedValueOnce(new Error('db down'));

				const outcome = await processJob(deferredWithNoRun(), registryReturning(null));

				expect(outcome.status).toBe('no-trigger');
				expect(completeDispatch).toHaveBeenCalledWith('dispatch-1', 'no-trigger');
			});
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

	// issue #684 phase 2 — the seam that makes a project's second repository routable.
	// `processJob` reads the project scoped to the repository *the job* names, so every
	// phase downstream of it (worktree, branch, prompts, delivery ids, review ledger,
	// run row, pushed assignment) runs against that repository rather than the
	// project's default entry.
	describe('repository scoping (issue #684 phase 2)', () => {
		it('scopes the project to the repository an SCM event names', async () => {
			const job = createMockScmWebhookJob({
				event: createMockScmEvent({ repoFullName: 'SmartTechBrewery/second' }),
			});

			await processJob(job, registryReturning(REVIEW_TRIGGER));

			expect(projectLookupCalls).toContainEqual({
				id: PROJECT.id,
				repo: 'SmartTechBrewery/second',
			});
		});

		// Since issue #686 phase 2 a board card *does* name a repository: ingress routed
		// it and recorded the answer on the envelope, and the same seam scopes to it.
		it('scopes a board job to the repository its card routed to', async () => {
			await processJob(
				{ ...createMockPmWebhookJob(), repository: 'SmartTechBrewery/second' },
				registryReturning({ phase: 'planning', taskId: '10', workItem: createMockWorkItem() }),
			);

			expect(projectLookupCalls).toContainEqual({
				id: PROJECT.id,
				repo: 'SmartTechBrewery/second',
			});
		});

		// A board job written before that routing carries none and keeps running against
		// the default entry — the behaviour a single-repository project always had.
		it('scopes a pre-routing board job to the default entry by naming no repository', async () => {
			await processJob(
				createMockPmWebhookJob(),
				registryReturning({ phase: 'planning', taskId: '10', workItem: createMockWorkItem() }),
			);

			expect(projectLookupCalls).toContainEqual({ id: PROJECT.id, repo: undefined });
		});

		it('scopes a merge-automation dispatch to the repository its intent recorded', async () => {
			await processJob(
				{
					type: 'merge-automation' as const,
					projectId: PROJECT.id,
					reviewRunId: 'run-1',
					repo: 'SmartTechBrewery/second',
					prNumber: '17',
					approvedHeadSha: 'deadbeef',
				},
				registryReturning(REVIEW_TRIGGER),
			);

			expect(projectLookupCalls).toContainEqual({
				id: PROJECT.id,
				repo: 'SmartTechBrewery/second',
			});
		});

		// The loud failure the phase promises: a job naming a repository the project no
		// longer owns must not fall back to the default and run the phase in the wrong
		// repository — it fails the dispatch, so the operator sees it in the queue.
		it('fails the dispatch and rethrows when the project no longer owns the repository', async () => {
			const unowned = new Error(
				"Project 'swarm' does not own repository 'SmartTechBrewery/gone' — it owns: SmartTechBrewery/swarm.",
			);
			projectLookup = () => {
				throw unowned;
			};

			await expect(
				processJob(
					createMockScmWebhookJob({
						event: createMockScmEvent({ repoFullName: 'SmartTechBrewery/gone' }),
					}),
					registryReturning(REVIEW_TRIGGER),
				),
			).rejects.toThrow(/does not own repository 'SmartTechBrewery\/gone'/);

			expect(failDispatch).toHaveBeenCalledWith(
				'dispatch-1',
				expect.stringContaining("does not own repository 'SmartTechBrewery/gone'"),
			);
			expect(phaseCalls).toEqual([]);
			expect(acquireProjectSlot).not.toHaveBeenCalled();
		});

		// Same refusal for a routed board card whose repository has since been removed
		// from the project (issue #686 phase 2 makes a `pm` job reach that path too).
		it('fails the dispatch for a board job naming a repository the project no longer owns', async () => {
			projectLookup = () => {
				throw new Error(
					"Project 'swarm' does not own repository 'SmartTechBrewery/gone' — it owns: SmartTechBrewery/swarm.",
				);
			};

			await expect(
				processJob(
					{ ...createMockPmWebhookJob(), repository: 'SmartTechBrewery/gone' },
					registryReturning({ phase: 'planning', taskId: '10', workItem: createMockWorkItem() }),
				),
			).rejects.toThrow(/does not own repository 'SmartTechBrewery\/gone'/);

			expect(failDispatch).toHaveBeenCalledWith(
				'dispatch-1',
				expect.stringContaining("does not own repository 'SmartTechBrewery/gone'"),
			);
			expect(phaseCalls).toEqual([]);
		});
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
		const job = createMockScmWebhookJob({ recheckAttempt: 5, readFailureRecheckAttempt: 2 });

		await processJob(job, registryReturning(REVIEW_TRIGGER, seen));

		expect(seen[0].recheckAttempt).toBe(5);
		// Its own budget travels beside it (issue #720) — a handler that saw only one
		// of the two would resume the outage wait against the wrong allowance.
		expect(seen[0].readFailureRecheckAttempt).toBe(2);
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

	describe('worker-update wake-ups (issue #972)', () => {
		const WORKER_UPDATE_JOB = {
			type: 'worker-update' as const,
			projectId: PROJECT.id,
			workerId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
			requestId: '66666666-6666-4666-8666-666666666666',
			target: 'main',
		};

		// It names no repository, so it is branched ahead of the project scoping and
		// never resolves a trigger, provisions a worktree, or takes a project slot.
		it('routes a claimed worker-update dispatch to the push, off every phase path', async () => {
			const seen: TriggerContext[] = [];
			const outcome = await processJob(
				{ ...WORKER_UPDATE_JOB },
				registryReturning(REVIEW_TRIGGER, seen),
			);

			expect(workerUpdatePushes).toEqual([
				{ workerId: WORKER_UPDATE_JOB.workerId, requestId: WORKER_UPDATE_JOB.requestId },
			]);
			expect(outcome).toEqual({
				status: 'worker-update-settled',
				result: 'pushed',
				workerId: WORKER_UPDATE_JOB.workerId,
			});
			expect(seen).toHaveLength(0);
			expect(phaseCalls).toHaveLength(0);
			expect(acquireProjectSlot).not.toHaveBeenCalled();
			expect(projectLookupCalls).toHaveLength(0);
		});

		// Nothing in flight is cancelled, deferred or failed to make room for it —
		// which holds because nothing was added, not because something checks.
		it('preempts nothing when the machine is offline and the request has to wait', async () => {
			workerUpdatePushResult = 'not-connected';

			const outcome = await processJob({ ...WORKER_UPDATE_JOB }, registryReturning(REVIEW_TRIGGER));

			expect(outcome).toMatchObject({ result: 'not-connected' });
			expect(phaseCalls).toHaveLength(0);
			expect(acquireProjectSlot).not.toHaveBeenCalled();
		});

		it('drops the wake-up without pushing when the dispatch claim is refused', async () => {
			claimDispatchForJob.mockResolvedValue({ claimed: false, reason: 'terminal' });

			const outcome = await processJob({ ...WORKER_UPDATE_JOB }, registryReturning(REVIEW_TRIGGER));

			expect(workerUpdatePushes).toEqual([]);
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
					// The repository the *completed* phase ran in, carried rather than
					// re-derived (issue #686 phase 2) — without it an auto-advanced next
					// phase would jump back to the project's default entry.
					repository: PROJECT.repo,
				},
			});
		});

		it('self-enqueues every split child auto-advance took along with the source task', async () => {
			const workItem = createMockWorkItem({ statusId: '3fe662f4' });
			const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };
			// A split whose children were advanced to the same status as the source
			// task (issue #911). Each needs its own synthetic job for the same reason
			// the source task does: the move is SWARM's own, so its board webhook is
			// dropped by loop prevention and nothing else would ever start it.
			phaseImpl = async () => ({
				agent: agentResult(),
				movedTo: 'todo',
				split: { subTaskItemIds: ['PVTI_child-one', 'PVTI_child-two'], mainTaskUpdated: true },
				advancedItemIds: ['PVTI_child-one', 'PVTI_child-two'],
			});

			await processJob(createMockPmWebhookJob(), registryReturning(trigger));

			expect(createAndPublishDispatch).toHaveBeenCalledTimes(3);
			const payloads = createAndPublishDispatch.mock.calls.map(
				([input]) => (input as { jobPayload: { event: { itemId: string } } }).jobPayload,
			);
			expect(payloads.map((payload) => payload.event.itemId)).toEqual([
				workItem.id,
				'PVTI_child-one',
				'PVTI_child-two',
			]);
			// Every one carries the repository the *completed* phase ran in, so an
			// advanced child's next phase cannot jump back to the project's default.
			for (const payload of payloads) {
				expect(payload).toMatchObject({
					type: 'pm',
					providerId: 'github-projects',
					projectId: PROJECT.id,
					repository: PROJECT.repo,
				});
			}
		});

		it('self-enqueues recovered children on a retry that reports no split of its own', async () => {
			const workItem = createMockWorkItem({ statusId: '3fe662f4' });
			const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };
			// The shape a retry returns after its plan comment short-circuited the split
			// (issue #911): no `split`, because this run applied none, but the children
			// an earlier attempt advanced — recovered from the board — still need the
			// synthetic job that attempt never got to report.
			phaseImpl = async () => ({
				agent: agentResult(),
				movedTo: 'todo',
				advancedItemIds: ['PVTI_child-one', 'PVTI_child-two'],
			});

			await processJob(createMockPmWebhookJob(), registryReturning(trigger));

			expect(createAndPublishDispatch).toHaveBeenCalledTimes(3);
			const itemIds = createAndPublishDispatch.mock.calls.map(
				([input]) =>
					(input as { jobPayload: { event: { itemId: string } } }).jobPayload.event.itemId,
			);
			expect(itemIds).toEqual([workItem.id, 'PVTI_child-one', 'PVTI_child-two']);
		});

		it('does not self-enqueue advanced children when the phase made no move', async () => {
			const trigger: TriggerResult = {
				phase: 'planning',
				taskId: '10',
				workItem: createMockWorkItem(),
			};
			// `autoAdvance` off: the source task did not move, so neither did any child.
			phaseImpl = async () => ({ agent: agentResult(), advancedItemIds: ['PVTI_child-one'] });

			await processJob(createMockPmWebhookJob(), registryReturning(trigger));

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
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
			agents: { planning: { cli: 'antigravity', model: 'Gemini 3.6 Flash (High)' } },
		});
		projectLookup = () => projectWithAgents;
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		const trigger: TriggerResult = { phase: 'planning', taskId: '10', workItem };

		await processJob(createMockPmWebhookJob(), registryReturning(trigger));

		expect(resolvedTarget()).toMatchObject({
			engine: 'antigravity',
			model: 'gemini-3.6-flash',
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

		// A card planned by its *parent's* Planning run (issue #992). It carries the
		// `planned` label and its plan as a validated preplan marker, and has no
		// `runs` row of its own — the run-history probe alone read that as "never
		// planned" and spent the unplanned config on every split child.
		describe('a preplanned split child (issue #992)', () => {
			/** The project both split-child paths below are dispatched under. */
			const withBothConfigs = () =>
				createMockProjectConfig({
					agents: {
						implementation: { cli: 'claude', model: 'opus' },
						implementationUnplanned: { cli: 'codex', model: 'gpt-5.6-terra' },
					},
				});

			/** The child's own backing issue — the URL a valid marker has to bind to. */
			const CHILD_URL = 'https://github.com/SmartTechBrewery/swarm/issues/10';
			/** What the split creates the child with: the automation opt-in and the child marker. */
			const SPLIT_CHILD_LABELS = [
				{ id: 'LA_swarm', name: 'swarm' },
				{ id: 'LA_child', name: 'swarm:split-child' },
			];

			/** A child's body with its parent's plan embedded, exactly as the split writes it. */
			function withPreplanMarker(humanDescription: string, itemUrl = CHILD_URL): string {
				return embedPreplanMarker(
					humanDescription,
					buildPreplanContract({
						splitId: 'split-1',
						childIndex: 1,
						parentUrl: 'https://github.com/SmartTechBrewery/swarm/issues/9',
						itemUrl,
						humanDescription,
						plan: 'Phase 2: wire the dispatch seam.',
						generatedAt: '2026-09-15T11:00:00.000Z',
					}),
				);
			}

			/** A fully prepared child: labelled `planned`, holding its parent's plan. */
			function preparedChild(overrides: Partial<WorkItem> = {}): WorkItem {
				return createMockWorkItem({
					url: CHILD_URL,
					labels: [...SPLIT_CHILD_LABELS, { id: 'LA_planned', name: 'planned' }],
					description: withPreplanMarker('Phase 2 scope.'),
					...overrides,
				});
			}

			function triggerFor(workItem: WorkItem): TriggerResult {
				return { phase: 'implementation', taskId: '10', workItem };
			}

			beforeEach(() => {
				projectLookup = withBothConfigs;
			});

			it('resolves the planned config from the label, without reading run history', async () => {
				// The child's plan rides in its body; no Planning run was ever spent on it.
				await processJob(createMockPmWebhookJob(), registryReturning(triggerFor(preparedChild())));

				expect(resolvedTarget()).toMatchObject({ engine: 'claude', model: 'opus' });
				// The board card already answered, so the dispatch pays no extra DB read.
				expect(hasCompletedRunForTask).not.toHaveBeenCalled();
			});

			it('resolves the planned config from the marker when the planned label never landed', async () => {
				// `markSplitChildPlanned` swallows a refused `addLabel`, so a child can hold
				// its parent's plan with no label on the card.
				const child = preparedChild({ labels: SPLIT_CHILD_LABELS });

				await processJob(createMockPmWebhookJob(), registryReturning(triggerFor(child)));

				expect(resolvedTarget()).toMatchObject({ engine: 'claude', model: 'opus' });
			});

			it('resolves the same config whether the label landed or a Planning run healed it', async () => {
				await processJob(createMockPmWebhookJob(), registryReturning(triggerFor(preparedChild())));
				const labelledTarget = resolvedTarget();

				phaseCalls.length = 0;
				// The label failed, so the child was dispatched to Planning, which reused the
				// marker and left a completed `planning` run behind (`completePreplannedRun`).
				const healed = preparedChild({
					labels: SPLIT_CHILD_LABELS,
					description: 'Phase 2 scope, with the marker since edited away.',
				});
				hasCompletedRunForTask.mockResolvedValueOnce(true);
				await processJob(createMockPmWebhookJob(), registryReturning(triggerFor(healed)));

				expect(resolvedTarget()).toMatchObject({
					engine: labelledTarget.engine,
					model: labelledTarget.model,
				});
				expect(resolvedTarget()).toMatchObject({ engine: 'claude', model: 'opus' });
			});

			it('keeps the unplanned config when the marker belongs to another item', async () => {
				// A copied or stale marker is no plan at all: `evaluatePreplan` rejects it and
				// the run-history fallback then answers for a child that really is unplanned.
				const child = preparedChild({
					labels: SPLIT_CHILD_LABELS,
					description: withPreplanMarker(
						'Phase 2 scope.',
						'https://github.com/SmartTechBrewery/swarm/issues/999',
					),
				});
				hasCompletedRunForTask.mockResolvedValueOnce(false);

				await processJob(createMockPmWebhookJob(), registryReturning(triggerFor(child)));

				expect(hasCompletedRunForTask).toHaveBeenCalledWith(PROJECT.id, '10', 'planning');
				expect(resolvedTarget()).toMatchObject({ engine: 'codex', model: 'gpt-5.6-terra' });
			});
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

		// No gate selection here, so no executing host is known — and the control
		// plane's own CLI set is not consulted as a stand-in, because that host
		// executes nothing (issue #703). Routing therefore declines and the phase's
		// preferred target is what runs and what the run row records.
		it('runs the preferred target when the gate selected no worker to route against', async () => {
			projectLookup = twoTargetProject;

			const outcome = await processJob(
				createMockPmWebhookJob(),
				registryReturning(planningTrigger()),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(resolvedTarget()).toMatchObject({ engine: 'codex', model: 'gpt-5.6-terra' });
		});

		it('records the preferred target on a capacity-deferred run row', async () => {
			projectLookup = twoTargetProject;
			acquireProjectSlot.mockResolvedValueOnce({ acquired: false });

			const outcome = await processJob(
				createMockPmWebhookJob(),
				registryReturning(planningTrigger()),
			);

			expect(outcome.status).toBe('phase-deferred');
			// The deferral runs *before* the gate, so the row states the phase's own
			// preference rather than a target derived from any host's CLI set (#703);
			// the wake-up re-enters `processJob` and resolves the real one.
			expect(createRun).toHaveBeenCalledWith(
				expect.objectContaining({ engine: 'codex', model: 'gpt-5.6-terra' }),
			);
		});

		it('lets a per-run override win over routing', async () => {
			projectLookup = twoTargetProject;
			// The run explicitly pins one exact target (a manual retry).
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

	// Issue #1000: the one timeout that exits 0 and must still defer. Its twin below
	// — an exit-0 timeout with no such notice — is issue #165's clean-exit case and
	// must stay terminal, which is what makes the exit-code proxy insufficient rather
	// than simply wrong.
	it('defers a timeout whose CLI ended its own turn, despite its exit 0', async () => {
		const AGY_PRINT_TIMEOUT =
			'[agy] print timeout after 5m0s with turn in progress; returning partial output';
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			throw new AgentRunError(
				`Implementation agent (antigravity) exited with code 0 (CLI timed out: ${AGY_PRINT_TIMEOUT})`,
				{ kind: 'timeout', cliSelfTimeout: AGY_PRINT_TIMEOUT },
				agentResult({ cli: 'antigravity', exitCode: 0, sessionId: 'conversation-1' }),
			);
		};

		const outcome = await processJob(
			createMockPmWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-deferred');
		expect(outcome).toMatchObject({ resumable: true });
		expect(addComment).not.toHaveBeenCalled();
	});

	it('still fails a timeout that exited 0 with no self-timeout notice (issue #165)', async () => {
		const workItem = createMockWorkItem({ statusId: '61e4505c' });
		phaseImpl = async () => {
			// A run that trapped SIGTERM and exited cleanly: it already finished and
			// cleaned up its worktree, so there is nothing to resume onto.
			throw new AgentRunError(
				'Implementation agent (claude) exited with code 0 (timed out)',
				{ kind: 'timeout' },
				agentResult({ exitCode: 0, timedOut: true }),
			);
		};

		const outcome = await processJob(
			createMockPmWebhookJob(),
			registryReturning({ phase: 'implementation', taskId: '100', workItem }),
		);

		expect(outcome.status).toBe('phase-failed');
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

	// The Planning half of the same gate (issue #889). The deferral path is keyed on
	// the error type rather than the phase, so this pins that it stays that way.
	it('defers a dependency-blocked Planning run on the same budget, then fails once it is exhausted', async () => {
		const workItem = createMockWorkItem({ statusId: '3fe662f4' });
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

		const deferred = await processJob(
			createMockPmWebhookJob(),
			registryReturning({ phase: 'planning', taskId: '100', workItem }),
		);

		// Deferred on the dependency-recheck cadence, with the board dispatch intent
		// preserved so the re-check re-enters Planning even though the card never moved.
		expect(deferred).toMatchObject({
			status: 'phase-deferred',
			dependencyRecheck: true,
			pmPhaseStarted: true,
		});
		if (deferred.status !== 'phase-deferred') throw new Error('expected phase-deferred');
		expect(deferred.reason).toContain('#319');
		expect(addComment).not.toHaveBeenCalled();

		const exhausted = await processJob(
			createMockPmWebhookJob({ dependencyRecheckAttempt: 1_000_000 }),
			registryReturning({ phase: 'planning', taskId: '100', workItem }),
		);

		expect(exhausted.status).toBe('phase-failed');
		expect(addComment).toHaveBeenCalledOnce();
		const [, body] = addComment.mock.calls[0];
		expect(body).toContain('#319');
		expect(body).toMatch(/must be done first/i);
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
			return dispatchDeps({
				executePhase: async () => {
					throw new DependencyBlockedError(workItem, [BLOCKER]);
				},
			});
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
				repository?: string | null;
				drainingSince?: Date | null;
				rateLimitedClis?: Map<AgentCli, Date>;
			} = {},
		): WorkerDispatchCandidate {
			const capabilities = overrides.capabilities ?? ['claude'];
			return {
				worker: {
					id,
					ownerUserId: overrides.ownerUserId ?? ALICE,
					displayName: `worker-${id}`,
					capabilities,
					// No declaration (issue #783), so the probe is the effective set.
					probedCapabilities: capabilities,
					declaredCapabilities: null,
					supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
					repository: overrides.repository ?? null,
					hostname: null,
					drainingSince: overrides.drainingSince ?? null,
					update: null,
					version: null,
					worktreeSweep: null,
					build: null,
					supervision: 'unknown',
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
					orderIndex: 0,
					sharingConsent: overrides.sharingConsent ?? true,
					createdAt: new Date('2026-01-01T00:00:00Z'),
					updatedAt: new Date('2026-01-01T00:00:00Z'),
				},
				availability: { connected: true, activeRuns: overrides.activeRuns ?? 0 },
				// Cooling on nothing (issue #981) — the regression bar for every case here.
				rateLimitedClis: overrides.rateLimitedClis ?? new Map(),
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

		// Issue #988. The third wait. A cooling machine is an *availability* refusal
		// (issue #981 classified it so), so without its own reason it would have read as
		// `worker-eligibility` — "no capable worker" — which sends an operator looking at
		// a fleet that is enrolled, consented, capable and simply out of allowance.
		it('records a cooling machine as its own worker-rate-limited wait', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				candidate('w-1', {
					rateLimitedClis: new Map([['claude', new Date('2026-07-01T18:00:00Z')]]),
				}),
			]);

			const outcome = await processJob(
				createMockPmWebhookJob({ rateLimitRetryAttempt: 3 }),
				registryReturning(planningTrigger()),
			);

			expect(outcome).toMatchObject({ status: 'phase-deferred', workerEligibilityRecheck: true });
			const [, input] = scheduleDispatchRetry.mock.calls[0] as [string, Record<string, unknown>];
			expect(input.waitReason).toBe('worker-rate-limited');
			// Same counter and the same untouched rate-limit budget as the other two waits:
			// the split is read-model-only, exactly as issue #607's was.
			expect(input.jobPayload).toMatchObject({
				workerEligibilityRecheckAttempt: 1,
				rateLimitRetryAttempt: 3,
			});
		});

		// The other half of the same split: every refusal that is *not* a cool-down must
		// keep the reason it already recorded, so the new value narrows rather than
		// captures.
		it('leaves every other refusal on the reason it already recorded', async () => {
			async function waitReasonFor(candidates: WorkerDispatchCandidate[]) {
				scheduleDispatchRetry.mockClear();
				listProjectDispatchCandidates.mockResolvedValue(candidates);
				await processJob(createMockPmWebhookJob(), registryReturning(planningTrigger()));
				const [, input] = scheduleDispatchRetry.mock.calls[0] as [string, Record<string, unknown>];
				return input.waitReason;
			}

			expect(await waitReasonFor([candidate('w-1', { activeRuns: 1 })])).toBe('worker-eligibility');
			expect(await waitReasonFor([candidate('w-1', { sharingConsent: false })])).toBe(
				'worker-authorization',
			);
			expect(await waitReasonFor([candidate('w-1', { drainingSince: new Date() })])).toBe(
				'worker-authorization',
			);
		});

		// Issue #714. A machine holding another repository is skipped by the gate rather
		// than selected and then refusing the assignment terminally — and the row says so
		// with the wait only a human can clear, naming the repository to point one at.
		it('records a machine holding another repository as a worker-authorization wait', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				candidate('w-1', { repository: 'smarttechbrewery/dashboard' }),
			]);

			const outcome = await processJob(
				createMockPmWebhookJob(),
				registryReturning(planningTrigger()),
			);

			expect(outcome).toMatchObject({ status: 'phase-deferred', workerEligibilityRecheck: true });
			// Nothing was provisioned: the point of skipping up front rather than letting the
			// worker refuse the assignment after a full selection and claim.
			expect(phaseCalls).toEqual([]);
			expect(createRun).not.toHaveBeenCalled();
			const [, input] = scheduleDispatchRetry.mock.calls[0] as [string, Record<string, unknown>];
			expect(input.waitReason).toBe('worker-authorization');
			// `project.repo` is the job's own repository since #684 phase 2 scoped it.
			expect(input.lastError).toContain('SmartTechBrewery/swarm');
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

			// Issue #954. The other half of the read: a continuation whose machine nobody
			// recorded used to route unpinned — the silent start-over the pin exists to
			// prevent — and is now refused, bounded, wherever there is another machine it
			// could have been handed to.
			describe('a continuation whose machine is unknown (issue #954)', () => {
				/** A run that bound a machine on its last attempt but records no pin. */
				const boundButUnrecorded = () =>
					getRunByIdFromDb.mockResolvedValue({ workerId: 'w-bound', recovery: {} });

				it('refuses it on the ordinary bounded budget rather than routing it', async () => {
					boundButUnrecorded();
					listProjectDispatchCandidates.mockResolvedValue([candidate('w-free')]);

					const outcome = await processJob(
						continuation(),
						registryReturning(planningTrigger()),
						undefined,
						executionIdentity('w-free'),
					);

					expect(outcome).toMatchObject({
						status: 'phase-deferred',
						workerEligibilityRecheck: true,
						// Not the pin's own endless wait: no machine coming online can supply
						// a record nobody wrote.
						preservedWorkerWait: false,
					});
					expect(phaseCalls).toEqual([]);
					const [, input] = scheduleDispatchRetry.mock.calls[0] as [
						string,
						Record<string, unknown>,
					];
					// The existing non-availability wait reason — no new one, so the queue read
					// model and the dashboard render it already.
					expect(input.waitReason).toBe('worker-authorization');
				});

				it('ends in an actionable terminal failure once that budget is spent', async () => {
					boundButUnrecorded();
					listProjectDispatchCandidates.mockResolvedValue([candidate('w-free')]);

					const outcome = await processJob(
						createMockPmWebhookJob({
							runId: 'run-1',
							recoveryMode: 'checkpoint',
							workerEligibilityRecheckAttempt: 1_000_000,
						}),
						registryReturning(planningTrigger()),
						undefined,
						executionIdentity('w-free'),
					);

					expect(outcome.status).toBe('phase-failed');
					expect(addComment).toHaveBeenCalledOnce();
					const [, body] = addComment.mock.calls[0];
					expect(body).toContain('Reset & restart');
					// The ending has to reach the *carried* row, not only the dispatch and the
					// board: the gate refuses before this dispatch creates a run of its own, so
					// without this the continuation stays retry-pending forever — and the
					// reconciler's orphan backfill re-dispatches exactly that shape.
					expect(failRunFromStatus).toHaveBeenCalledOnce();
					const [settledRunId, reason] = failRunFromStatus.mock.calls[0];
					expect(settledRunId).toBe('run-1');
					expect(reason).toContain('no record of which machine holds this checkout');
					// Failed, not deferred: nothing may leave it in a retry-pending status.
					expect(completeRun).not.toHaveBeenCalled();
					expect(failDispatch).toHaveBeenCalledOnce();
				});

				it('settles no run row while the wait is still within budget', async () => {
					boundButUnrecorded();
					listProjectDispatchCandidates.mockResolvedValue([candidate('w-free')]);

					await processJob(
						continuation(),
						registryReturning(planningTrigger()),
						undefined,
						executionIdentity('w-free'),
					);

					// The deferral is the one case that must *not* write the carried row: its
					// `checkpointed` status and session id are what the retry continues from.
					expect(failRunFromStatus).not.toHaveBeenCalled();
				});

				it('still runs it on an unfederated project, where nothing could be mis-routed', async () => {
					boundButUnrecorded();
					listProjectDispatchCandidates.mockResolvedValue([]);

					const outcome = await processJob(continuation(), registryReturning(planningTrigger()));

					expect(outcome.status).toBe('phase-succeeded');
				});

				it('still routes a run that never bound a machine at all', async () => {
					// `runs.worker_id IS NULL`: no attempt ever bound one, so there is no
					// machine that could have been recorded and nothing to have lost.
					getRunByIdFromDb.mockResolvedValue({ workerId: null, recovery: {} });
					listProjectDispatchCandidates.mockResolvedValue([candidate('w-free')]);

					const outcome = await processJob(
						continuation(),
						registryReturning(planningTrigger()),
						undefined,
						executionIdentity('w-free'),
					);

					expect(outcome.status).toBe('phase-succeeded');
				});
			});

			// Issue #780. The one wait with no budget must not be the one that lets a
			// held claim lapse — nothing else would ever refresh it again.
			it('keeps a pinned Review continuation’s dedup claim alive while it waits', async () => {
				listProjectDispatchCandidates.mockResolvedValue([
					candidate('w-preserved', { activeRuns: 1 }),
				]);

				const outcome = await processJob(
					createMockScmWebhookJob({ runId: 'run-1', recoveryMode: 'checkpoint' }),
					registryReturning(REVIEW_TRIGGER),
				);

				expect(outcome).toMatchObject({
					status: 'phase-deferred',
					preservedWorkerWait: true,
					continuationDispatchClaimed: true,
				});
				expect(refreshReviewDispatchClaim).toHaveBeenCalledWith(
					`${PROJECT.repo}:17:deadbeef`,
					expect.any(Number),
				);
			});
		});

		// Issue #780. The gate refuses *after* the trigger handler took this phase's
		// dispatch dedup claim, and the wait releases nothing — so it has to hold that
		// claim open and mark the retry as the claim's own owner. Without the flag the
		// woken dispatch re-enters the handler, collides with its still-live claim, is
		// dropped as a duplicate, and settles `completed` with no run row and no error
		// (reproduced live on PR #779, woken by the fast availability path of #610).
		describe('a prioritized continuation retains its dispatch dedup claim (issue #780)', () => {
			/** Settle one eligibility wait for `trigger` against a busy capable worker. */
			async function waitOn(trigger: TriggerResult) {
				listProjectDispatchCandidates.mockResolvedValue([candidate('w-1', { activeRuns: 1 })]);
				const outcome = await processJob(createMockScmWebhookJob(), registryReturning(trigger));
				const [, input] = scheduleDispatchRetry.mock.calls[0] as [string, Record<string, unknown>];
				return { outcome, input };
			}

			it('persists the reuse flag on the payload every wake path reads back', async () => {
				const { outcome, input } = await waitOn(REVIEW_TRIGGER);

				expect(outcome).toMatchObject({
					status: 'phase-deferred',
					phase: 'review',
					workerEligibilityRecheck: true,
					continuationDispatchClaimed: true,
				});
				// The durable row's payload is what both the timer and the fast availability
				// wake republish, so the flag has to live *there*, not on the outcome alone.
				expect(input).toMatchObject({
					waitReason: 'worker-eligibility',
					jobPayload: expect.objectContaining({ continuationDispatchClaimed: true }),
				});
			});

			it('holds the claim rather than freeing it, so a sibling PR+SHA event still cannot take the slot', async () => {
				const { outcome } = await waitOn(REVIEW_TRIGGER);

				expect(refreshReviewDispatchClaim).toHaveBeenCalledWith(
					`${PROJECT.repo}:17:deadbeef`,
					expect.any(Number),
				);
				// Outlives the wait it is held across, so the slot is never briefly free
				// mid-wait for an `opened`/`checks completed` sibling to claim.
				const [, ttlSec] = refreshReviewDispatchClaim.mock.calls[0] as [string, number];
				const retryDelayMs = (outcome as { retryDelayMs: number }).retryDelayMs;
				expect(ttlSec).toBeGreaterThan(retryDelayMs / 1000);
			});

			it.each([
				['Respond-to-CI', RESPOND_TO_CI_TRIGGER],
				['Resolve-conflicts', RESOLVE_CONFLICTS_TRIGGER],
			] as const)('carries the flag for a deferred %s dispatch too', async (_label, trigger) => {
				const { outcome, input } = await waitOn(trigger);

				expect(outcome).toMatchObject({
					status: 'phase-deferred',
					phase: trigger.phase,
					continuationDispatchClaimed: true,
				});
				expect(input.jobPayload).toMatchObject({ continuationDispatchClaimed: true });
			});

			it('refreshes the Resolve-conflicts head/base claim, whose TTL nothing else reaps', async () => {
				await waitOn(RESOLVE_CONFLICTS_TRIGGER);

				expect(refreshConflictResolutionClaim).toHaveBeenCalledWith(
					`${PROJECT.repo}:17:deadbeef:cafebabe`,
					expect.any(Number),
				);
			});

			it('leaves a board phase untouched — it holds no claim to reuse', async () => {
				listProjectDispatchCandidates.mockResolvedValue([candidate('w-1', { activeRuns: 1 })]);

				const outcome = await processJob(
					createMockPmWebhookJob(),
					registryReturning(planningTrigger()),
				);

				if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
				expect(outcome.continuationDispatchClaimed).toBeUndefined();
				const [, input] = scheduleDispatchRetry.mock.calls[0] as [string, Record<string, unknown>];
				expect(input.jobPayload).not.toMatchObject({ continuationDispatchClaimed: true });
				expect(refreshReviewDispatchClaim).not.toHaveBeenCalled();
				expect(refreshConflictResolutionClaim).not.toHaveBeenCalled();
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

		// Issue #919. The half of the drain gate that cannot be raced: an operator may
		// drain the machine between the gate selecting it and the claim committing, and
		// the fenced claim re-checks the flag under the worker row's lock. The work is
		// deferred, never failed, and the row records the wait only a human clears.
		it('defers as a worker-authorization wait when the claim finds the machine drained', async () => {
			listProjectDispatchCandidates.mockResolvedValue([candidate('w-1')]);
			claimWorkerForDispatch.mockResolvedValue({ claimed: false, reason: 'worker-draining' });

			const outcome = await processJob(
				createMockPmWebhookJob(),
				registryReturning(planningTrigger()),
				undefined,
				executionIdentity('w-1'),
			);

			expect(outcome).toMatchObject({ status: 'phase-deferred', workerEligibilityRecheck: true });
			// Nothing ran and nothing was recorded as a run: the claim is what gates entry.
			expect(phaseCalls).toEqual([]);
			expect(createRun).not.toHaveBeenCalled();
			const [, input] = scheduleDispatchRetry.mock.calls[0] as [string, Record<string, unknown>];
			expect(input.waitReason).toBe('worker-authorization');
			expect(input.lastError).toContain('worker-draining');
		});

		// The gate's own half of the same rule, on the read side: a drained machine is
		// simply not selected, so the work goes to whichever machine is still in the pool.
		it('routes around a machine drained before selection', async () => {
			listProjectDispatchCandidates.mockResolvedValue([
				candidate('w-draining', { drainingSince: new Date('2026-09-13T10:00:00Z') }),
				candidate('w-free'),
			]);

			const outcome = await processJob(
				createMockPmWebhookJob(),
				registryReturning(planningTrigger()),
				undefined,
				executionIdentity('w-free'),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(claimWorkerForDispatch).toHaveBeenCalledWith(
				expect.objectContaining({ selectedWorkerId: 'w-free' }),
			);
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

	// The operator-facing half of the same fact. This is the one line that names the
	// reset, and it is the line a federated deferral now also reaches with a hint in
	// hand (issue #980) instead of the `undefined` a kind-only rebuild left it.
	it('names the reported reset hint on the deferral log line', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		phaseImpl = async () => {
			throw new AgentRunError('Review agent (claude) exited with code 1 (rate limited)', {
				kind: 'rate-limit',
				resetHint: '1:40pm (Europe/Warsaw)',
				retryAfter: new Date(Date.now() + 90 * 60 * 1000),
			});
		};

		await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('rate-limited'),
			expect.objectContaining({ resetHint: '1:40pm (Europe/Warsaw)' }),
		);
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

	// The observed agy exhaustion (issue #1013): a reset well past the old six-hour
	// ceiling is waited out in full. Clamping it retried the run — and lapsed the
	// machine's `(worker, CLI)` cool-down, which is this same delay — ten hours before
	// the account had anything left.
	it('waits out a reported reset that is longer than the old six-hour ceiling', async () => {
		const observed = 16 * 60 * 60 * 1000 + 39 * 60 * 1000 + 20 * 1000;
		phaseImpl = async () => {
			throw new AgentRunError('Resolve-conflicts agent (antigravity) exited with code 0', {
				kind: 'rate-limit',
				resetHint: 'in 16h39m20s',
				retryAfter: new Date(Date.now() + observed),
			});
		};

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

		if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
		expect(outcome.retryDelayMs).toBeGreaterThan(observed);
		expect(outcome.retryDelayMs).toBeLessThanOrEqual(observed + 60 * 1000);
	});

	// The other side of the same policy: the wait stops where a wake-up stops being
	// honoured. The control plane discards a job it dequeues more than
	// `SWARM_MAX_JOB_AGE_MS` (24 h) after publication, so scheduling past that window
	// would park the run on a wake-up nothing will act on; the retry budget covers the
	// rest of a longer window.
	it('caps a reset further out than a wake-up survives at the shared ceiling', async () => {
		phaseImpl = async () => {
			throw new AgentRunError('rate limited', {
				kind: 'rate-limit',
				retryAfter: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
			});
		};

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

		if (outcome.status !== 'phase-deferred') throw new Error('expected phase-deferred');
		expect(outcome.retryDelayMs).toBe(24 * 60 * 60 * 1000 - 15 * 60 * 1000);
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
		expect(clearRunCancellation).not.toHaveBeenCalledWith('run-1', expect.anything());
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

	/**
	 * A cancellation that lands *after* the pre-start marker check — i.e. while the
	 * phase is genuinely running. Since issue #912 a marker already set at pickup
	 * makes `processJob` refuse to enter the phase at all, so a test about a run
	 * terminated mid-flight has to let the start check miss it and every later read
	 * (`handlePhaseFailure`, `finalizeFailedRun`) find it.
	 */
	function cancelAfterStartCheck(): void {
		isRunCancellationRequested.mockResolvedValueOnce(false).mockResolvedValue(true);
	}

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
		expect(clearRunCancellation).toHaveBeenCalledWith('run-1', {
			action: 'run-settled',
			projectId: 'swarm',
			taskId: '17',
			phase: 'review',
		});
	});

	it('settles a marker-only cancellation as a terminal failure, not a deferral', async () => {
		// A cancellation was requested: an aborted run that would normally defer must
		// instead fail terminally with the neutral cancellation reason (issue #166,
		// #305), flagged structurally rather than by comparing the error string.
		cancelAfterStartCheck();
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
		cancelAfterStartCheck();
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
		cancelAfterStartCheck();
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
		cancelAfterStartCheck();
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
		cancelAfterStartCheck();
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

	it('never dispatches a phase whose cancellation was already recorded (issue #912)', async () => {
		// A deferred run terminated in the window between its retry being dequeued and
		// the phase starting. The start-check used to abort the controller and run the
		// phase anyway, which only reached the agent — the phase's pre-agent work, the
		// board move reporting the pickup included, ran and left the card in the
		// phase's column for a run that never started. The phase is now not entered.
		isRunCancellationRequested.mockResolvedValue(true);

		const outcome = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

		expect(phaseCalls).toEqual([]);
		// The settlement is unchanged from a cancellation observed mid-flight.
		expect(outcome).toMatchObject({
			status: 'phase-failed',
			phase: 'review',
			taskId: '17',
			error: 'Run cancelled after a cancellation request.',
			failureDiagnosis: { kind: 'user-terminated' },
			cancelled: true,
		});
		expect(cancelClaimedDispatch).toHaveBeenCalledWith(
			expect.any(String),
			'Run cancelled after a cancellation request.',
		);
		expect(failDispatch).not.toHaveBeenCalled();
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

	// Issue #1018. The live shape: the reviewed head SHA was produced by another
	// worker, the machine this Review was routed to had no fetch that worked, and the
	// run settled terminally on `fatal: invalid reference` — then every retry came
	// back to the same machine, because nothing recorded that it had just failed.
	describe('a commit this worker could not obtain', () => {
		it('defers instead of settling terminally, and records the machine that failed', async () => {
			phaseImpl = async () => {
				throw new CommitUnavailableError('bbe9b84c4a32486778d136f4d9c0c0cbe13bbd7e', {
					repoRoot: '/Users/dev/swarm/swarm',
					taskId: '224',
					fetchError: 'Connection refused',
					fetched: true,
				});
			};
			recordRunCommitUnavailableWorker.mockClear();
			commentOnPullRequest.mockClear();

			const outcome = await processJob(
				createMockScmWebhookJob({ rateLimitRetryAttempt: 0 }),
				registryReturning(REVIEW_TRIGGER),
			);

			// Deferred, not `phase-failed`: the commit is on the remote, so the run has
			// somewhere else to go.
			expect(outcome.status).toBe('phase-deferred');
			expect(outcome).toHaveProperty('retryDelayMs');
			// The machine is on the run, so the next dispatch's gate can pass it over.
			expect(recordRunCommitUnavailableWorker).toHaveBeenCalledWith('run-1');
			// A deferral posts no "failed" comment on the pull request.
			expect(commentOnPullRequest).not.toHaveBeenCalled();
		});

		it('waits on the commit-unavailable reason, and names the fetch failure in the run error', async () => {
			phaseImpl = async () => {
				throw new CommitUnavailableError('bbe9b84c4a32486778d136f4d9c0c0cbe13bbd7e', {
					repoRoot: '/Users/dev/swarm/swarm',
					taskId: '224',
					fetchError: 'Connection refused',
					fetched: true,
				});
			};
			scheduleDispatchRetry.mockClear();

			await processJob(
				createMockScmWebhookJob({ rateLimitRetryAttempt: 0 }),
				registryReturning(REVIEW_TRIGGER),
			);

			const [, input] = scheduleDispatchRetry.mock.calls.at(-1) as [
				string,
				Record<string, unknown>,
			];
			expect(input.waitReason).toBe('commit-unavailable');
			// The cause that used to live only in a warn on the worker's own machine.
			const settle = completeRun.mock.calls.at(-1)?.[1] as { error?: string };
			expect(settle.error).toContain('Connection refused');
			expect(settle.error).not.toContain('invalid reference');
		});
	});

	// Issue #1019: the PR+SHA dispatch claim is taken before a Review starts and used
	// to survive a run that failed without ever submitting a verdict, so for five
	// minutes the guard against a *duplicate* review blocked the retry of a review
	// that never happened — and the bounced retry was reported as a changed board
	// disposition. Live on `under-control-platform#224`: eight dispatches, every
	// second one a no-op, in strict alternation.
	describe('a failed Review hands back its dispatch claim (issue #1019)', () => {
		const failWith = (err: unknown) => {
			phaseImpl = async () => {
				throw err;
			};
		};

		it('releases the claim when the run delivered no verdict', async () => {
			failWith(new Error('worktree provisioning failed'));

			const outcome = await processJob(
				createMockScmWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-failed');
			expect(getSubmittedReviewSlot).toHaveBeenCalledWith({
				projectId: PROJECT.id,
				repository: PROJECT.repo,
				prNumber: '17',
				headSha: 'deadbeef',
			});
			expect(releaseReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:17:deadbeef`);
		});

		// The acceptance criterion the whole dedup exists for: a run that *did* post
		// its review keeps the slot, or a sibling event posts a second one.
		it('keeps the claim when the ledger records a submitted verdict for the head', async () => {
			getSubmittedReviewSlot.mockResolvedValueOnce({
				ordinal: 1,
				verdict: 'approve',
				reviewId: 'review-1',
			});
			failWith(new Error('cleanup exploded after the review was submitted'));

			const outcome = await processJob(
				createMockScmWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-failed');
			expect(releaseReviewDispatch).not.toHaveBeenCalled();
		});

		// The second read, for the window the ledger alone cannot judge: the phase
		// raises `DeliveryDeferredError` for any error once delivery progress exists on
		// disk, which is written immediately before the review is submitted. Terminal
		// only once its retry budget is spent — at which point the review may well be
		// out there with no ledger row behind it.
		it('keeps the claim when the terminal failure is a spent delivery deferral', async () => {
			failWith(new DeliveryDeferredError('Review delivery deferred for retry'));

			const outcome = await processJob(
				createMockScmWebhookJob({ rateLimitRetryAttempt: 6 }),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-failed');
			expect(releaseReviewDispatch).not.toHaveBeenCalled();
		});

		// Fails closed, exactly as the claim itself does: an unreadable ledger cannot
		// establish that nothing was delivered, so the TTL reaps the claim instead.
		it('keeps the claim when the ledger read throws', async () => {
			getSubmittedReviewSlot.mockRejectedValueOnce(new Error('db down'));
			failWith(new Error('worktree provisioning failed'));

			const outcome = await processJob(
				createMockScmWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-failed');
			expect(releaseReviewDispatch).not.toHaveBeenCalled();
		});

		// A deferral keeps its slot deliberately — `retainContinuationDispatchClaim`
		// is holding it open for the prioritized retry that reuses it.
		it('leaves a deferred run\u2019s claim alone', async () => {
			failWith(new AgentRunError('rate limited', { kind: 'rate-limit' }));

			const outcome = await processJob(
				createMockScmWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-deferred');
			expect(releaseReviewDispatch).not.toHaveBeenCalled();
		});

		// Only Review owns a verdict; the other PR-driven phases have their own
		// budgets and are left strictly alone here.
		it('leaves another phase\u2019s failure alone', async () => {
			failWith(new Error('boom'));

			const outcome = await processJob(
				createMockScmWebhookJob(),
				registryReturning(RESPOND_TO_REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-failed');
			expect(releaseReviewDispatch).not.toHaveBeenCalled();
		});
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
			expect(recordDispatchResolution).toHaveBeenCalledWith('dispatch-1', {
				taskId: '216',
				phase: 'implementation',
				pullRequest: undefined,
			});
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
		//
		// Issue #759 split that verdict in two. A collision on the *same* phase is
		// still the duplicate above; a collision on a *different* phase is the pipeline
		// advancing through the checkout the board-driven pair deliberately shares
		// (Planning → Implementation, one `task-<id>` and one `issue-<n>` branch), so it
		// waits as `task-in-flight` and runs when the checkout frees.

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

		// Issue #759's regression: the board-driven pair share one `taskId` on purpose,
		// so this collision is the pipeline advancing, not a repeated delivery.
		it('defers a different phase of the same task instead of dropping it as a duplicate', async () => {
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			phaseImpl = async () => {
				await gate;
				return { agent: agentResult() };
			};

			const workItem = createMockWorkItem();
			const planning = processJob(
				createMockPmWebhookJob(),
				registryReturning({ phase: 'planning', taskId: '17', workItem }),
			);
			await new Promise((r) => setTimeout(r, 0));

			const implementation = await processJob(
				createMockPmWebhookJob(),
				registryReturning({ phase: 'implementation', taskId: '17', workItem }),
			);

			expect(implementation).toMatchObject({
				status: 'phase-deferred',
				phase: 'implementation',
				taskId: '17',
			});
			// It waited rather than running into Planning's checkout.
			expect(phaseCalls).toHaveLength(1);
			expect(deferDispatchToPending).toHaveBeenCalledWith(
				'dispatch-1',
				expect.objectContaining({ waitReason: 'task-in-flight' }),
			);
			// `skipped-duplicate` stays reserved for a repeated delivery of one phase.
			expect(completeDispatch).not.toHaveBeenCalledWith(expect.anything(), 'skipped-duplicate');
			// The wait is visible while it waits, not silently terminal.
			expect(completeRun).toHaveBeenCalledWith(
				'run-1',
				expect.objectContaining({
					status: 'deferred',
					error: expect.stringContaining('planning'),
				}),
			);

			release?.();
			await planning;

			// Planning settling is what wakes it — no operator action, no timer.
			expect(promoteTaskInFlightWaits).toHaveBeenCalledWith(PROJECT.id, '17');
		});

		it('wakes the task-in-flight waits when the holding phase fails or defers, not only on success', async () => {
			phaseImpl = async () => {
				throw new Error('boom');
			};
			const failed = await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));
			expect(failed.status).toBe('phase-failed');
			expect(promoteTaskInFlightWaits).toHaveBeenCalledWith(PROJECT.id, '17');

			promoteTaskInFlightWaits.mockClear();
			acquireProjectSlot.mockResolvedValue({ acquired: false });
			const deferred = await processJob(
				createMockScmWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);
			expect(deferred.status).toBe('phase-deferred');
			expect(promoteTaskInFlightWaits).toHaveBeenCalledWith(PROJECT.id, '17');
		});

		it('finalizes a run row carried by a dropped duplicate instead of leaving it deferred', async () => {
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

			// A dispatch that already waited once carries the run row of that wait.
			const second = await processJob(
				createMockScmWebhookJob({ runId: 'run-9' }),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(second.status).toBe('skipped-in-flight');
			expect(completeDispatch).toHaveBeenCalledWith('dispatch-1', 'skipped-duplicate');
			expect(completeRun).toHaveBeenCalledWith(
				'run-9',
				expect.objectContaining({
					status: 'failed',
					error: expect.stringContaining('already in flight'),
				}),
			);

			release?.();
			await first;
		});

		// Issue #858. The in-process entry is cleared in `processJob`'s `finally`, which
		// for a control-plane dispatch is only when the awaited worker result arrives —
		// so a dispatch cancelled while its job is parked (every "Reset & restart" of a
		// run whose worker is gone) leaves the entry standing for as long as the router
		// takes to give up. `resetRun` runs in another process and cannot see or clear
		// it, so the replacement dispatch it creates inside that window was dropped as
		// `skipped-duplicate` and the run settled `failed` on the restart Reset had just
		// reported. The holder's own dispatch row is what tells the two apart.
		describe('a replacement dispatch racing a parked job (issue #858)', () => {
			/** The harness hands every job `dispatch-1`; the *asker* is a different row. */
			const claimNextDispatchAs = (id: string) => {
				claimDispatchForJob.mockImplementationOnce(async (job: Record<string, unknown>) => ({
					claimed: true,
					dispatch: { ...mockDispatchRow(job), id },
				}));
			};
			/** Park a phase so its task stays claimed in this process's map. */
			const parkFirstJob = (trigger: TriggerResult) => {
				let release: (() => void) | undefined;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				phaseImpl = async () => {
					await gate;
					return { agent: agentResult() };
				};
				const parked = processJob(createMockScmWebhookJob(), registryReturning(trigger));
				return {
					parked,
					settle: async () => {
						release?.();
						await parked;
					},
				};
			};
			/** What `resetRun`'s `cancelActiveDispatch` leaves behind on the holder. */
			const holderState = (state: string) => {
				getDispatchById.mockImplementation(async (id: string) =>
					id === 'dispatch-1' ? { ...mockDispatchRow({}), state } : mockDispatchRow({}),
				);
			};

			it('defers the replacement as task-in-flight instead of dropping it as a duplicate', async () => {
				const { settle } = parkFirstJob(RESPOND_TO_REVIEW_TRIGGER);
				await new Promise((r) => setTimeout(r, 0));

				holderState('cancelled');
				claimNextDispatchAs('dispatch-2');
				const replacement = await processJob(
					createMockScmWebhookJob(),
					registryReturning(RESPOND_TO_REVIEW_TRIGGER),
				);

				expect(replacement).toMatchObject({
					status: 'phase-deferred',
					phase: 'respond-to-review',
					taskId: '17-respond',
				});
				expect(deferDispatchToPending).toHaveBeenCalledWith(
					'dispatch-2',
					expect.objectContaining({ waitReason: 'task-in-flight' }),
				);
				// The whole defect: this is the drop that made Reset's report a lie.
				expect(completeDispatch).not.toHaveBeenCalledWith(expect.anything(), 'skipped-duplicate');
				// A deferred dispatch holds no checkout, so the parked attempt is still the
				// only one against `task-17-respond`.
				expect(phaseCalls).toHaveLength(1);
				// The run is visibly waiting rather than terminal-and-un-restarted.
				expect(completeRun).toHaveBeenCalledWith(
					'run-1',
					expect.objectContaining({
						status: 'deferred',
						error: expect.stringContaining('releasing'),
					}),
				);

				promoteTaskInFlightWaits.mockClear();
				await settle();

				// The parked job settling is what wakes it — no operator action, no timer.
				expect(promoteTaskInFlightWaits).toHaveBeenCalledWith(PROJECT.id, '17-respond');
			});

			it('still drops a genuine duplicate while the holding dispatch is live', async () => {
				const { settle } = parkFirstJob(RESPOND_TO_REVIEW_TRIGGER);
				await new Promise((r) => setTimeout(r, 0));

				holderState('running');
				claimNextDispatchAs('dispatch-2');
				const duplicate = await processJob(
					createMockScmWebhookJob(),
					registryReturning(RESPOND_TO_REVIEW_TRIGGER),
				);

				expect(duplicate.status).toBe('skipped-in-flight');
				expect(completeDispatch).toHaveBeenCalledWith('dispatch-2', 'skipped-duplicate');
				expect(phaseCalls).toHaveLength(1);
				// The verdict is the read's, not an accident of the default.
				expect(getDispatchById).toHaveBeenCalledWith('dispatch-1');

				await settle();
			});

			it('defers when the holding dispatch row is gone entirely', async () => {
				const { settle } = parkFirstJob(RESPOND_TO_REVIEW_TRIGGER);
				await new Promise((r) => setTimeout(r, 0));

				// The project was deleted and the cascade took the row: it holds nothing
				// either, and the work must not be dropped on its behalf.
				getDispatchById.mockResolvedValue(undefined);
				claimNextDispatchAs('dispatch-2');
				const replacement = await processJob(
					createMockScmWebhookJob(),
					registryReturning(RESPOND_TO_REVIEW_TRIGGER),
				);

				expect(replacement.status).toBe('phase-deferred');
				expect(completeDispatch).not.toHaveBeenCalledWith(expect.anything(), 'skipped-duplicate');

				await settle();
			});

			it('keeps the duplicate verdict when the holder read fails', async () => {
				const { settle } = parkFirstJob(RESPOND_TO_REVIEW_TRIGGER);
				await new Promise((r) => setTimeout(r, 0));

				// Fails closed, unlike the durable hold reads: a DB hiccup must not license
				// a second attempt against a checkout a phase may genuinely be executing in.
				getDispatchById.mockRejectedValue(new Error('db down'));
				claimNextDispatchAs('dispatch-2');
				const duplicate = await processJob(
					createMockScmWebhookJob(),
					registryReturning(RESPOND_TO_REVIEW_TRIGGER),
				);

				expect(duplicate.status).toBe('skipped-in-flight');
				expect(completeDispatch).toHaveBeenCalledWith('dispatch-2', 'skipped-duplicate');

				await settle();
			});

			it('reads nothing at all for a different phase of the same task', async () => {
				let release: (() => void) | undefined;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				phaseImpl = async () => {
					await gate;
					return { agent: agentResult() };
				};
				const workItem = createMockWorkItem();
				const planning = processJob(
					createMockPmWebhookJob(),
					registryReturning({ phase: 'planning', taskId: '17', workItem }),
				);
				await new Promise((r) => setTimeout(r, 0));

				claimNextDispatchAs('dispatch-2');
				const implementation = await processJob(
					createMockPmWebhookJob(),
					registryReturning({ phase: 'implementation', taskId: '17', workItem }),
				);

				// A different phase already defers, so it is not worth a row read.
				expect(implementation.status).toBe('phase-deferred');
				expect(getDispatchById).not.toHaveBeenCalled();

				release?.();
				await planning;
			});
		});

		// The durable leg: the verdict must not depend on which worker the dispatch was
		// routed to, so a collision recorded on the dispatch table counts even when this
		// process's own map knows nothing about the task.
		describe('durable collision read (routing-independent)', () => {
			it('defers when another worker is executing a different phase of the task', async () => {
				findExecutingDispatchForTask.mockResolvedValue({ id: 'other', phase: 'planning' });

				const outcome = await processJob(
					createMockPmWebhookJob(),
					registryReturning({
						phase: 'implementation',
						taskId: '17',
						workItem: createMockWorkItem(),
					}),
				);

				expect(outcome.status).toBe('phase-deferred');
				expect(phaseCalls).toHaveLength(0);
				expect(deferDispatchToPending).toHaveBeenCalledWith(
					'dispatch-1',
					expect.objectContaining({ waitReason: 'task-in-flight' }),
				);
				// The asking dispatch is excluded — it is already `leased` with its own
				// task/phase recorded and would otherwise find itself.
				expect(findExecutingDispatchForTask).toHaveBeenCalledWith(PROJECT.id, '17', 'dispatch-1');
			});

			it('drops it as a duplicate when the executing phase is the same one', async () => {
				findExecutingDispatchForTask.mockResolvedValue({ id: 'other', phase: 'review' });

				const outcome = await processJob(
					createMockScmWebhookJob(),
					registryReturning(REVIEW_TRIGGER),
				);

				expect(outcome.status).toBe('skipped-in-flight');
				expect(completeDispatch).toHaveBeenCalledWith('dispatch-1', 'skipped-duplicate');
			});

			it('defers rather than drops when the executing row recorded no phase', async () => {
				findExecutingDispatchForTask.mockResolvedValue({ id: 'other', phase: null });

				const outcome = await processJob(
					createMockScmWebhookJob(),
					registryReturning(REVIEW_TRIGGER),
				);

				expect(outcome.status).toBe('phase-deferred');
				expect(completeDispatch).not.toHaveBeenCalledWith(expect.anything(), 'skipped-duplicate');
			});

			it('dispatches normally when the durable read finds nothing or fails', async () => {
				const outcome = await processJob(
					createMockScmWebhookJob(),
					registryReturning(REVIEW_TRIGGER),
				);
				expect(outcome.status).toBe('phase-succeeded');

				findExecutingDispatchForTask.mockRejectedValue(new Error('db down'));
				const afterFailure = await processJob(
					createMockScmWebhookJob(),
					registryReturning(REVIEW_TRIGGER),
				);
				expect(afterFailure.status).toBe('phase-succeeded');
			});
		});

		// Issue #761. The executing read above cannot see a Planning dispatch that is
		// merely *queued* — it owns no checkout — so an Implementation delivery that
		// arrived while Planning still sat in the queue used to claim first and run
		// without the plan it was dispatched to consume. Implementation now asks a
		// second, one-directional question.
		describe('queued-planning yield (issue #761)', () => {
			const workItem = createMockWorkItem();
			const implementation = () =>
				registryReturning({ phase: 'implementation', taskId: '17', workItem });

			it('defers Implementation while a Planning dispatch for the task has not settled', async () => {
				findActivePlanningDispatchForTask.mockResolvedValue({ id: 'planning-1', state: 'pending' });

				const outcome = await processJob(createMockPmWebhookJob(), implementation());

				expect(outcome).toMatchObject({
					status: 'phase-deferred',
					phase: 'implementation',
					taskId: '17',
				});
				expect(phaseCalls).toHaveLength(0);
				expect(deferDispatchToPending).toHaveBeenCalledWith(
					'dispatch-1',
					expect.objectContaining({ waitReason: 'task-in-flight' }),
				);
				// Visible with its reason, not silently dropped — and the reason must say
				// *queued*, since claiming "waiting for that checkout to free" would be a
				// lie about a Planning that has not started.
				expect(completeRun).toHaveBeenCalledWith(
					'run-1',
					expect.objectContaining({
						status: 'deferred',
						error: expect.stringContaining('planning phase queued'),
					}),
				);
				// The asking dispatch is excluded — it is already leased with its own
				// task/phase recorded and would otherwise find itself.
				expect(findActivePlanningDispatchForTask).toHaveBeenCalledWith(
					PROJECT.id,
					'17',
					'dispatch-1',
				);
			});

			// The constraint that shapes the fix: most tasks never run Planning at all, so
			// the ordinary Backlog → ToDo path must gain no gate and no delay.
			it('runs Implementation immediately when the task has no Planning dispatch', async () => {
				const outcome = await processJob(createMockPmWebhookJob(), implementation());

				expect(outcome.status).toBe('phase-succeeded');
				expect(phaseCalls).toHaveLength(1);
				expect(deferDispatchToPending).not.toHaveBeenCalled();
			});

			// One-directional by construction: nothing asks the mirror question, so no
			// pair of dispatches can defer to each other.
			it.each([
				'planning',
				'review',
			] as const)('never asks the question for a %s dispatch, so Planning cannot yield to Implementation', async (phase) => {
				findActivePlanningDispatchForTask.mockResolvedValue({
					id: 'planning-1',
					state: 'pending',
				});

				const outcome =
					phase === 'planning'
						? await processJob(
								createMockPmWebhookJob(),
								registryReturning({ phase: 'planning', taskId: '17', workItem }),
							)
						: await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

				expect(outcome.status).toBe('phase-succeeded');
				expect(findActivePlanningDispatchForTask).not.toHaveBeenCalled();
			});

			it('dispatches normally when the planning read fails — a DB hiccup must not stall the pipeline', async () => {
				findActivePlanningDispatchForTask.mockRejectedValue(new Error('db down'));

				const outcome = await processJob(createMockPmWebhookJob(), implementation());

				expect(outcome.status).toBe('phase-succeeded');
			});

			// The wait self-heals: Planning can settle between the read and this row
			// becoming `pending`, so its own promotion would find nothing to wake.
			it('publishes its own wake-up when the Planning dispatch settled while it was deferring', async () => {
				// Only the claim-time read sees it; the post-defer re-check finds it gone.
				findActivePlanningDispatchForTask.mockResolvedValueOnce({
					id: 'planning-1',
					state: 'pending',
				});

				await processJob(createMockPmWebhookJob(), implementation());

				expect(publishDispatchWakeUp).toHaveBeenCalledWith(
					expect.objectContaining({ id: 'dispatch-1' }),
				);
			});

			it('does not publish a wake-up while the Planning dispatch is still non-terminal', async () => {
				findActivePlanningDispatchForTask.mockResolvedValue({ id: 'planning-1', state: 'running' });

				await processJob(createMockPmWebhookJob(), implementation());

				expect(publishDispatchWakeUp).not.toHaveBeenCalled();
			});
		});
		// Issue #850. Neither read above can see two phases of one *pull request*: they
		// key on the worktree task id, and the four PR-driven phases carry deliberately
		// distinct suffixed ids so they can hold separate checkouts. What they contend for
		// is the PR's head branch — three of them push to it, and a Review reads a head one
		// of them is about to replace.
		describe('pull-request in-flight guard (issue #850)', () => {
			const writingHold = { id: 'other', phase: 'resolve-conflicts' };

			it('defers a writing phase behind another writing phase of the same pull request', async () => {
				findExecutingWritingDispatchForPullRequest.mockResolvedValue(writingHold);

				const outcome = await processJob(
					createMockScmWebhookJob(),
					registryReturning(RESPOND_TO_REVIEW_TRIGGER),
				);

				expect(outcome).toMatchObject({
					status: 'phase-deferred',
					phase: 'respond-to-review',
					taskId: '17-respond',
				});
				// It waited rather than pushing onto a branch the holder is about to move.
				expect(phaseCalls).toHaveLength(0);
				expect(deferDispatchToPending).toHaveBeenCalledWith(
					'dispatch-1',
					expect.objectContaining({ waitReason: 'pr-in-flight' }),
				);
				// Visible while it waits, naming the *pull request* — the two phases hold
				// different checkouts, so "waiting for that checkout to free" would be a lie.
				expect(completeRun).toHaveBeenCalledWith(
					'run-1',
					expect.objectContaining({
						status: 'deferred',
						error: expect.stringContaining('Pull request #17'),
					}),
				);
				// The asking dispatch is excluded — it recorded its own PR on claim and would
				// otherwise find itself.
				expect(findExecutingWritingDispatchForPullRequest).toHaveBeenCalledWith(
					PROJECT.id,
					PROJECT.repo,
					'17',
					'dispatch-1',
				);
			});

			it.each([
				['Respond-to-review', RESPOND_TO_REVIEW_TRIGGER],
				['Respond-to-CI', RESPOND_TO_CI_TRIGGER],
				['Resolve-conflicts', RESOLVE_CONFLICTS_TRIGGER],
			] as const)('defers %s behind the holder', async (_label, trigger) => {
				findExecutingWritingDispatchForPullRequest.mockResolvedValue(writingHold);

				const outcome = await processJob(createMockScmWebhookJob(), registryReturning(trigger));

				expect(outcome.status).toBe('phase-deferred');
				expect(phaseCalls).toHaveLength(0);
			});

			it('drops a Review behind a writing phase, spending no verdict-ledger slot', async () => {
				findExecutingWritingDispatchForPullRequest.mockResolvedValue(writingHold);

				const outcome = await processJob(
					createMockScmWebhookJob(),
					registryReturning(REVIEW_TRIGGER),
				);

				// Dropped, not deferred: a Review is pinned to a head SHA, so waking it later
				// would have it review the commit the writer has already replaced.
				expect(outcome).toEqual({
					status: 'skipped-in-flight',
					phase: 'review',
					taskId: '17',
				});
				expect(phaseCalls).toHaveLength(0);
				expect(deferDispatchToPending).not.toHaveBeenCalled();
				expect(completeDispatch).toHaveBeenCalledWith('dispatch-1', 'skipped-pr-in-flight');
				expect(releaseReviewDispatch).toHaveBeenCalledWith(`${PROJECT.repo}:17:deadbeef`);
				// The acceptance criterion: the reservation is handed back, so none of the
				// three permitted verdict slots (issue #235) is consumed by a review that
				// never ran.
				expect(abandonReviewVerdict).toHaveBeenCalledWith({
					projectId: PROJECT.id,
					repository: PROJECT.repo,
					prNumber: '17',
					headSha: 'deadbeef',
				});
			});

			it('finalizes a run row carried by a dropped Review rather than leaving it deferred', async () => {
				findExecutingWritingDispatchForPullRequest.mockResolvedValue(writingHold);

				const outcome = await processJob(
					createMockScmWebhookJob({ runId: 'run-9' }),
					registryReturning(REVIEW_TRIGGER),
				);

				expect(outcome.status).toBe('skipped-in-flight');
				expect(completeRun).toHaveBeenCalledWith(
					'run-9',
					expect.objectContaining({
						status: 'failed',
						error: expect.stringContaining('Pull request #17'),
					}),
				);
			});

			it('wakes the pr-in-flight waits when a writing phase settles — success, failure, or deferral', async () => {
				await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_REVIEW_TRIGGER));
				expect(promotePullRequestInFlightWaits).toHaveBeenCalledWith(
					PROJECT.id,
					PROJECT.repo,
					'17',
				);

				promotePullRequestInFlightWaits.mockClear();
				phaseImpl = async () => {
					throw new Error('boom');
				};
				const failed = await processJob(
					createMockScmWebhookJob(),
					registryReturning(RESPOND_TO_CI_TRIGGER),
				);
				expect(failed.status).toBe('phase-failed');
				expect(promotePullRequestInFlightWaits).toHaveBeenCalledWith(
					PROJECT.id,
					PROJECT.repo,
					'17',
				);

				promotePullRequestInFlightWaits.mockClear();
				phaseImpl = async () => ({ agent: agentResult() });
				acquireProjectSlot.mockResolvedValueOnce({ acquired: false });
				const deferred = await processJob(
					createMockScmWebhookJob(),
					registryReturning(RESOLVE_CONFLICTS_TRIGGER),
				);
				expect(deferred.status).toBe('phase-deferred');
				expect(promotePullRequestInFlightWaits).toHaveBeenCalledWith(
					PROJECT.id,
					PROJECT.repo,
					'17',
				);

				// …and when the settle is the transport-loss reap's (issue #859). The
				// orphaned Respond-to-review of the live incident unwinds as this same
				// non-deferrable failure, so the pull request it was holding is released and
				// the phase queued behind it is woken — inside the reap's grace rather than
				// at the end of the phase's own lease window.
				promotePullRequestInFlightWaits.mockClear();
				failDispatch.mockClear();
				phaseImpl = async () => {
					throw new AgentRunError(TRANSPORT_LOST_ORPHAN_REASON, { kind: 'error' });
				};
				const orphaned = await processJob(
					createMockScmWebhookJob(),
					registryReturning(RESPOND_TO_REVIEW_TRIGGER),
				);
				expect(orphaned.status).toBe('phase-failed');
				expect(promotePullRequestInFlightWaits).toHaveBeenCalledWith(
					PROJECT.id,
					PROJECT.repo,
					'17',
				);
				expect(failDispatch).toHaveBeenCalledWith(
					'dispatch-1',
					expect.stringContaining(TRANSPORT_LOST_ORPHAN_REASON),
				);
			});

			it('does not wake pr-in-flight waits after a Review settles — a Review is never waited for', async () => {
				await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

				expect(promotePullRequestInFlightWaits).not.toHaveBeenCalled();
			});

			// The wait self-heals: the holder can settle between the read and this row
			// becoming `pending`, so its own promotion would find nothing to wake.
			it('publishes its own wake-up when the holder settled while it was deferring', async () => {
				// Only the claim-time read sees the hold; the post-defer re-check finds it gone.
				findExecutingWritingDispatchForPullRequest.mockResolvedValueOnce(writingHold);

				await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_REVIEW_TRIGGER));

				expect(publishDispatchWakeUp).toHaveBeenCalledWith(
					expect.objectContaining({ id: 'dispatch-1' }),
				);
			});

			it('does not publish a wake-up while the holder is still executing', async () => {
				findExecutingWritingDispatchForPullRequest.mockResolvedValue(writingHold);

				await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_REVIEW_TRIGGER));

				expect(publishDispatchWakeUp).not.toHaveBeenCalled();
			});

			// The asymmetry that makes the relation acyclic: a Review is not in the filtered
			// set, so nothing ever waits behind one. Exercised against the real in-process
			// map here, with a Review genuinely mid-flight; the durable half of the same
			// claim (a `review` row not matching the read) is asserted in
			// `tests/integration/db/dispatchesRepository.test.ts`.
			it('lets a writing phase run while a Review of the same pull request is mid-flight', async () => {
				let release: (() => void) | undefined;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				phaseImpl = async (_phase, context) => {
					if (context.trigger.phase === 'review') await gate;
					return { agent: agentResult() };
				};

				const review = processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));
				await new Promise((r) => setTimeout(r, 0));

				const conflicts = await processJob(
					createMockScmWebhookJob(),
					registryReturning(RESOLVE_CONFLICTS_TRIGGER),
				);

				expect(conflicts.status).toBe('phase-succeeded');

				release?.();
				await review;
			});

			it.each([
				'planning',
				'implementation',
			] as const)('never asks the question for a %s dispatch, which carries no pull request', async (phase) => {
				findExecutingWritingDispatchForPullRequest.mockResolvedValue(writingHold);

				const outcome = await processJob(
					createMockPmWebhookJob(),
					registryReturning({ phase, taskId: '17', workItem: createMockWorkItem() }),
				);

				expect(outcome.status).toBe('phase-succeeded');
				expect(findExecutingWritingDispatchForPullRequest).not.toHaveBeenCalled();
				expect(promotePullRequestInFlightWaits).not.toHaveBeenCalled();
			});

			it('dispatches normally when the pull-request read fails — a DB hiccup must not stall or drop', async () => {
				findExecutingWritingDispatchForPullRequest.mockRejectedValue(new Error('db down'));

				const writer = await processJob(
					createMockScmWebhookJob(),
					registryReturning(RESPOND_TO_REVIEW_TRIGGER),
				);
				expect(writer.status).toBe('phase-succeeded');

				const review = await processJob(
					createMockScmWebhookJob(),
					registryReturning(REVIEW_TRIGGER),
				);
				expect(review.status).toBe('phase-succeeded');
			});

			it('records the pull request on the dispatch, which is what makes the hold visible', async () => {
				await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_REVIEW_TRIGGER));

				const resolution = {
					taskId: '17-respond',
					phase: 'respond-to-review',
					pullRequest: { repository: PROJECT.repo, prNumber: '17' },
				};
				expect(recordDispatchResolution).toHaveBeenCalledWith('dispatch-1', resolution);
				// Re-written when the run starts too, so a row whose best-effort resolution
				// write failed cannot become an invisible holder.
				expect(markDispatchRunning).toHaveBeenCalledWith(
					'dispatch-1',
					'run-1',
					expect.any(Date),
					resolution,
				);
			});
		});
	});

	describe('a claim that stopped being ours before the phase started (issue #854)', () => {
		// `markDispatchRunning` is a *conditional* update — it matches only a `leased`/
		// `running` row with this id. Matching nothing means the dispatch this job is
		// executing under is no longer our claim: cancelled, reclaimed by the lease sweep,
		// or deleted outright because its project was removed and the FK cascade took it.
		// From there nothing durable would record, settle or cancel the phase, so it must
		// not start — the worker-side half of `projects.delete`'s guard.
		it('abandons the phase instead of running it when the dispatch no longer matches', async () => {
			markDispatchRunning.mockResolvedValueOnce(false);

			const outcome = await processJob(
				createMockScmWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome).toMatchObject({ status: 'dispatch-refused' });
			expect(phaseCalls).toEqual([]);
		});

		// The row is gone (or terminal) already, so re-settling it would either write
		// nothing or resurrect a state something else deliberately set.
		it('does not settle the dispatch it just found unclaimed', async () => {
			markDispatchRunning.mockResolvedValueOnce(false);

			await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

			expect(completeDispatch).not.toHaveBeenCalled();
			expect(failDispatch).not.toHaveBeenCalled();
			expect(cancelClaimedDispatch).not.toHaveBeenCalled();
		});

		it('still runs the phase on the ordinary path, where the claim is still ours', async () => {
			const outcome = await processJob(
				createMockScmWebhookJob(),
				registryReturning(REVIEW_TRIGGER),
			);

			expect(outcome.status).toBe('phase-succeeded');
			expect(phaseCalls).toHaveLength(1);
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
					// The repository the run acted on, recorded on the row rather than left
					// to be joined back through the project later (issue #683).
					repository: PROJECT.repo,
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

		// The fold-in declaration is recorded and acted on nowhere yet (issue #953),
		// so the settle is the whole of its durable half.
		describe('the review’s fold-in declaration (issue #953)', () => {
			const ABSORBED = [
				{
					url: 'https://github.com/SmartTechBrewery/swarm/issues/947',
					reference: '#947',
					evidence: 'Its criteria 1-3 are met by this diff.',
				},
			];

			it('persists a Review run’s declaration on its own row', async () => {
				phaseImpl = async () => ({ agent: agentResult(), verdict: 'approve', absorbed: ABSORBED });

				await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

				expect(completeRun).toHaveBeenCalledExactlyOnceWith(
					'run-1',
					expect.objectContaining({ status: 'completed', reviewAbsorbed: ABSORBED }),
				);
			});

			// Omitted rather than emptied, so `completeRun` leaves the column as it is
			// for every phase that has no declaration to make.
			it('leaves the column untouched for a phase that declared none', async () => {
				const workItem = createMockWorkItem({ statusId: '61e4505c' });
				phaseImpl = async () => ({ agent: agentResult() });

				await processJob(
					createMockPmWebhookJob(),
					registryReturning({ phase: 'implementation', taskId: '100', workItem }),
				);

				const [, input] = completeRun.mock.calls.at(-1) as [string, Record<string, unknown>];
				expect(input.status).toBe('completed');
				expect(input.reviewAbsorbed).toBeUndefined();
			});
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

		describe('the no-fix hand-back to Review (issue #841)', () => {
			it('schedules exactly one recovery for the PR the no-fix run declined to fix', async () => {
				phaseImpl = async () => ({ agent: agentResult(), ciOutcome: 'no-fix' });

				await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_CI_TRIGGER));

				expect(scheduleCiNoFixRecovery).toHaveBeenCalledExactlyOnceWith({
					project: PROJECT,
					prNumber: '17',
					prBranch: 'issue-17',
					headSha: 'deadbeef',
				});
			});

			// The recovery re-enters `pr-review` for this very PR+head, so this
			// dispatch is made terminal before its own successor can be claimed.
			it('schedules it only after the dispatch is completed', async () => {
				phaseImpl = async () => ({ agent: agentResult(), ciOutcome: 'no-fix' });

				await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_CI_TRIGGER));

				expect(completeDispatch.mock.invocationCallOrder[0]).toBeLessThan(
					scheduleCiNoFixRecovery.mock.invocationCallOrder[0] as number,
				);
			});

			it('schedules nothing when the run fixed the build', async () => {
				phaseImpl = async () => ({ agent: agentResult(), ciOutcome: 'fixed' });

				await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_CI_TRIGGER));

				expect(scheduleCiNoFixRecovery).not.toHaveBeenCalled();
			});

			it('schedules nothing for a phase that is not Respond-to-CI', async () => {
				phaseImpl = async () => ({ agent: agentResult(), ciOutcome: 'no-fix' });

				await processJob(createMockScmWebhookJob(), registryReturning(REVIEW_TRIGGER));

				expect(scheduleCiNoFixRecovery).not.toHaveBeenCalled();
			});

			it('schedules nothing when Review is disabled — there is nothing to hand back to', async () => {
				projectLookup = () =>
					createMockProjectConfig({
						pipeline: { review: { enabled: false }, respondToReview: { enabled: false } },
					});
				phaseImpl = async () => ({ agent: agentResult(), ciOutcome: 'no-fix' });

				await processJob(createMockScmWebhookJob(), registryReturning(RESPOND_TO_CI_TRIGGER));

				expect(scheduleCiNoFixRecovery).not.toHaveBeenCalled();
			});

			// Best-effort, exactly like the next-phase self-enqueue: a scheduling
			// failure must not turn an already-succeeded phase into a failed job.
			it('logs a scheduling failure and still settles phase-succeeded', async () => {
				phaseImpl = async () => ({ agent: agentResult(), ciOutcome: 'no-fix' });
				scheduleCiNoFixRecovery.mockRejectedValue(new Error('queue down'));

				const outcome = await processJob(
					createMockScmWebhookJob(),
					registryReturning(RESPOND_TO_CI_TRIGGER),
				);

				expect(outcome.status).toBe('phase-succeeded');
				expect(completeDispatch).toHaveBeenCalledWith('dispatch-1', 'phase-succeeded');
			});
		});

		it('records the work item metadata and requested model/reasoning for a PM-driven phase', async () => {
			const projectWithAgents = createMockProjectConfig({
				agents: { planning: { cli: 'antigravity', model: 'Gemini 3.6 Flash (High)' } },
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
					repository: projectWithAgents.repo,
					taskId: '10',
					phase: 'planning',
					workItemId: workItem.id,
					workItemTitle: workItem.title,
					workItemUrl: workItem.url,
					prNumber: undefined,
					// Legacy combined string normalized to logical model + reasoning (issue #180).
					model: 'gemini-3.6-flash',
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

	// issue #684 phase 2 — the courtesy comment goes on the repository the interrupted
	// work was for, so it reads the project scoped to the job's own repository.
	it('scopes the project to the repository the interrupted job names', async () => {
		projectLookupCalls.length = 0;

		await reportInterruptedJobToBoard(
			createMockScmWebhookJob({
				event: createMockScmEvent({ repoFullName: 'SmartTechBrewery/second' }),
			}),
			'stalled',
		);

		expect(projectLookupCalls).toContainEqual({
			id: 'swarm',
			repo: 'SmartTechBrewery/second',
		});
	});

	// Best-effort: a project that no longer owns the job's repository throws out of the
	// read, and the report swallows it rather than escaping an event handler.
	it('swallows an unowned-repository throw instead of failing the handler', async () => {
		projectLookup = () => {
			throw new Error("Project 'swarm' does not own repository 'SmartTechBrewery/gone'");
		};

		await expect(
			reportInterruptedJobToBoard(
				createMockScmWebhookJob({
					event: createMockScmEvent({ repoFullName: 'SmartTechBrewery/gone' }),
				}),
				'stalled',
			),
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

	/**
	 * The repository the run recorded (issue #692) — deliberately not `PROJECT.repo`,
	 * so the review arm's assertion fails if it forwards the project's own instead.
	 */
	const RUN_REPOSITORY = 'SmartTechBrewery/run-repo';

	function baseInputs(overrides: Partial<AssignedPhaseInputs>): AssignedPhaseInputs {
		return {
			phase: 'planning',
			taskId: '17',
			project: PROJECT,
			repository: RUN_REPOSITORY,
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
		// The run's own repository, which the phase keys its verdict ledger on — not
		// `project.repo` (issue #692).
		expect(assignedPhaseCalls[0].args.repository).toBe(RUN_REPOSITORY);
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

	// A terminal delivery refusal reports itself through this body and nothing else
	// (issue #839): the error *class* does not survive the federated wire, so the
	// refusal's own message — state refused plus what clears it — is the whole
	// report the operator gets.
	it('carry a terminal delivery refusal verbatim, remedy included', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-refusal-comment-'));
		try {
			execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
			writeFileSync(join(root, HANDOFF_FILENAMES.checkpoint), '{}\n');
			execFileSync('git', ['add', '--force', '--', HANDOFF_FILENAMES.checkpoint], { cwd: root });
			const refusal = await validatePreparedTree(root).catch((e: unknown) => e);

			const body = phaseFailureCommentBody('resolve-conflicts', describeError(refusal));

			expect(body).toContain('Unsafe delivery: ');
			expect(body).toContain(`scratch artifact ${HANDOFF_FILENAMES.checkpoint} is tracked`);
			expect(body).toContain("'git rm --cached <path>'");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
