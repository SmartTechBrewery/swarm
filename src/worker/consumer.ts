/**
 * The worker's job processor — the Phase-3 wiring: dequeued job → trigger
 * lookup → pipeline phase (ai/ARCHITECTURE.md "Components").
 *
 * A matched trigger names one of the pipeline phases plus its inputs
 * (`src/triggers/types.ts`); this dispatches on that phase and hands off to the
 * phase orchestrator (`src/pipeline/*`), which owns the whole run — worktree
 * provisioning + environment graft (SWARM-14/15), the agent CLI (SWARM-16),
 * reading its hand-off file, posting back to the PM board, and cleanup. The
 * worker's job here is just to resolve the project, build the PM provider the
 * PM-driven phases need, and translate the phase's result (or failure) into a
 * `JobOutcome`.
 *
 * Queue-agnostic on purpose: `processJob` takes an already-validated `SwarmJob`
 * and knows nothing about BullMQ, so tests drive it directly and the entry
 * point (`src/worker/index.ts`) stays a thin shell.
 */

import type { AgentDefaults, ProjectConfig } from '../config/schema.js';
import { getAppSettings } from '../db/repositories/appSettingsRepository.js';
import { upsertCliQuota } from '../db/repositories/cliQuotasRepository.js';
import {
	cancelClaimedDispatch,
	claimWorkerForDispatch,
	completeDispatch,
	type DispatchRow,
	type DispatchWaitReason,
	deferDispatchToPending,
	failDispatch,
	markDispatchRunning,
	recordDispatchResolution,
	scheduleDispatchRetry,
} from '../db/repositories/dispatchesRepository.js';
import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import { abandonReviewVerdict } from '../db/repositories/reviewVerdictsRepository.js';
import {
	type CompleteRunInput,
	completeRun,
	createRun,
	getLatestCompletedPlanningScope,
	getLatestRunForTask,
	getRunByIdFromDb,
	hasCompletedRunForTask,
	isRetryPendingStatus,
	resetRunToRunning,
	storeRunLogs,
	updateRunJobPayload,
} from '../db/repositories/runsRepository.js';
import { resolveBoardItemIdForPrBranch } from '../dispatch/board-card.js';
import {
	claimDispatchForJob,
	createAndPublishDispatch,
	DISPATCH_LEASE_OWNER,
	parseDispatchPayload,
	promoteNextCapacityDispatch,
	publishDispatchWakeUp,
} from '../dispatch/dispatcher.js';
import { deriveCapacityPendingPayload, deriveRetryJobPayload } from '../dispatch/retry-payload.js';
import type { AgentCli, AgentCliResult } from '../harness/agent-cli.js';
import {
	type AgentFailure,
	type AgentFailureKind,
	AgentRunError,
	agentRunError,
} from '../harness/agent-failure.js';
import { capabilityFor, DEFAULT_MODEL_PER_CLI, type ReasoningLevel } from '../harness/models.js';
import { discoverCliQuotas } from '../harness/quota-discovery.js';
// Side-effect import: registers every provider manifest into its registry before
// `buildTriggerContext` resolves a dequeued job's `providerId` below. Declared here,
// not only in the worker entrypoint, because the control plane's own dispatch
// consumer (`src/router/dispatcher.ts`) drives `processJob` too.
import '../integrations/entrypoint.js';
import { requireProjectPMAdapter, requireProjectPMProvider } from '../integrations/pm/registry.js';
import { requireProjectSCMProvider, requireSCMProvider } from '../integrations/scm/registry.js';
import { getControlPlaneUrl, isSingleUserMode, optionalEnv } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
	type Checkpoint,
	resolveMaxContinuations,
	tryReadCheckpoint,
} from '../pipeline/checkpoint.js';
import { DependencyBlockedError } from '../pipeline/dependency-guard.js';
import type { ScheduleFollowUpReview } from '../pipeline/follow-up-review.js';
import { runImplementationPhase } from '../pipeline/implementation.js';
import { phaseLabel } from '../pipeline/phase-label.js';
import { type ProposedScope, runPlanningPhase } from '../pipeline/planning.js';
import { runResolveConflictsPhase } from '../pipeline/resolve-conflicts.js';
import { runRespondToCiPhase } from '../pipeline/respond-to-ci.js';
import { runRespondToReviewPhase } from '../pipeline/respond-to-review.js';
import { BlockedRecoveryError, checkpointFallbackApplies } from '../pipeline/resume.js';
import {
	type ReviewAutomationOutcome,
	type ReviewVerdict,
	runReviewPhase,
} from '../pipeline/review.js';
import type { ReviewVerdictLedger } from '../pipeline/review-ledger.js';
import { issueNumberFromBranch } from '../pipeline/task-branch.js';
import {
	hasAutomationLabel,
	missingAutomationLabelMessage,
	resolveAutomationLabel,
} from '../pm/automation-label.js';
import { type PmStatusKey, resolvePipelinePhaseForStatusKey } from '../pm/pipeline.js';
import { findWorkItemForPullRequest } from '../pm/pull-request-work-item.js';
import { createTransportPmDeliveryProvider } from '../pm/transport-delivery.js';
import type { PMProvider, WorkItem } from '../pm/types.js';
import {
	type CancellationOrigin,
	clearRunCancellation,
	getRunCancellationOrigin,
	isRunCancellationRequested,
	RUN_CANCELLED_MESSAGE,
} from '../queue/cancellation.js';
import {
	type PmWebhookJob,
	type ScmWebhookJob,
	type SwarmJob,
	SwarmJobSchema,
} from '../queue/jobs.js';
import { priorityFor } from '../queue/producer.js';
import { DeliveryDeferredError, type ScmDeliveryProvider } from '../scm/delivery.js';
import { SWARM_GENERATED_FOOTER } from '../scm/swarm-origin.js';
import { createTransportScmDeliveryProvider } from '../scm/transport-delivery.js';
import type { ScmPersona } from '../scm/types.js';
import type { TriggerRegistry } from '../triggers/registry.js';
import {
	buildConflictResolutionKey,
	refreshConflictResolutionClaim,
	releaseConflictResolution,
} from '../triggers/resolve-conflicts-dedup.js';
import {
	buildRespondToCiAttemptKey,
	releaseRespondToCiAttempt,
} from '../triggers/respond-to-ci-attempts.js';
import {
	buildReviewDispatchKey,
	refreshReviewDispatchClaim,
	releaseReviewDispatch,
} from '../triggers/review-dispatch-dedup.js';
import {
	isPrioritizedContinuationPhase,
	type TriggerContext,
	type TriggerPhase,
	type TriggerResult,
} from '../triggers/types.js';
import { reconcileTerminatedWorktree } from '../worktree/termination-cleanup.js';
import {
	maxDependencyRechecks,
	resolveDependencyMaxWaitMs,
	resolveDependencyRecheckIntervalMs,
} from './dependency-recheck.js';
import {
	type DispatchGateOptions,
	type DispatchSelection,
	evaluateDispatchEligibility,
	type GateDecision,
	WorkerIneligibleError,
} from './eligibility-gate.js';
import type { WorkerExecutionIdentity } from './execution-identity.js';
import {
	diagnoseFailure,
	type FailureDiagnosis,
	type KnownFailureCondition,
} from './failure-diagnosis.js';
import { GitWorktreeManager } from './git-worktree-manager.js';
import { createLiveOutputRunner } from './live-output.js';
import {
	type MergeAutomationSettledOutcome,
	processMergeAutomationDispatch,
	requestMergeAutomation,
} from './merge-automation.js';
import {
	acquireProjectSlot,
	releaseProjectSlot,
	type SlotAcquisition,
} from './project-concurrency.js';
import {
	beginRunCancellationTracking,
	linkRunAbortController,
	RunTerminatedError,
	unregisterRunController,
} from './run-cancellation.js';
import { PHASE_DEFAULT_CLI, phaseAgentConfig, resolveTargetPolicy } from './target-policy.js';
import {
	loadAvailableClis,
	selectTarget,
	type TargetSelection,
	type WorkerCliAvailability,
} from './target-selection.js';

/** What became of a dequeued job — returned to BullMQ as the job's result. */
export type JobOutcome =
	| { status: 'no-trigger' }
	| {
			/**
			 * The wake-up's dispatch record refused the claim (cancelled, completed,
			 * superseded, held elsewhere, or a duplicate attempt for a run that
			 * already has one) — the delivery is dropped without touching anything
			 * (issue #284): terminal dispatch states cannot be resurrected.
			 */
			status: 'dispatch-refused';
			reason: string;
	  }
	| { status: 'skipped-in-flight'; phase: TriggerPhase; taskId: string }
	| {
			/**
			 * The dispatch resolved a phase, but the work item is not eligible for
			 * automation — today only "it lacks the project's automation label"
			 * (issue #131); #339's worker-authorization gate settles the same way
			 * with a different `reason`. No slot, no worktree, no tokens spent.
			 */
			status: 'skipped-not-eligible';
			phase: TriggerPhase;
			taskId: string;
			reason: string;
	  }
	// A merge-automation dispatch settled (merged, refused, retry-scheduled, or
	// failed) — the agent-less dispatch kind (issue #292).
	| MergeAutomationSettledOutcome
	| {
			status: 'phase-succeeded';
			phase: TriggerPhase;
			taskId: string;
			exitCode: number | null;
			signal: NodeJS.Signals | null;
			timedOut: boolean;
			durationMs: number;
	  }
	| {
			status: 'phase-failed';
			phase: TriggerPhase;
			taskId: string;
			error: string;
			/** Evidence-based guidance shown alongside the raw technical error. */
			failureDiagnosis?: FailureDiagnosis;
			/**
			 * True when this failure is a cancellation (the durable marker was found
			 * set), not an agent/provider failure — drives the dispatch-settle branch's
			 * cancel-vs-fail choice structurally instead of string-comparing `error`.
			 */
			cancelled?: boolean;
	  }
	| {
			status: 'phase-deferred';
			phase: TriggerPhase;
			taskId: string;
			/** How long the worker should wait before re-enqueuing this job. */
			retryDelayMs: number;
			/** The originating failure message, for the re-enqueue log line. */
			reason: string;
			/** The retry attempt count *before* this deferral (0 on the first). */
			attempt: number;
			/**
			 * True for a rate-limit or genuinely-interrupted-timeout deferral (any
			 * phase, any CLI): the retry should resume the preserved session rather
			 * than start fresh. Drives `resumeSession` on the re-enqueued job and
			 * whether the captured `agentSessionId` is kept on the deferred row.
			 */
			resumable: boolean;
			/**
			 * Set when this deferral is a **Tier 2 checkpoint continuation** (issue #503,
			 * `docs/CHECKPOINTS.md`): native session resume could not serve the stop, but
			 * the preserved checkout carries this parsed `swarm_checkpoint.json`. Its
			 * presence is the marker — there is deliberately no second boolean beside it
			 * that could disagree — and it makes the settle record `checkpointed` with the
			 * checkpoint on the row instead of `deferred` with a session id, and the retry
			 * carry `recoveryMode: 'checkpoint'`. Always accompanied by
			 * `resumable: false`: a continuation resumes no session.
			 */
			checkpoint?: Checkpoint;
			/** The run's checkpoint-continuation count after this settle — set with {@link checkpoint}. */
			continuationCount?: number;
			/** True when the retry must reuse deterministic-delivery progress, not an agent session. */
			resumeDelivery?: boolean;
			/**
			 * True when a PM-driven phase was actually entered before it deferred.
			 * This preserves board dispatch intent without implying that
			 * Implementation successfully provisioned its task branch.
			 */
			pmPhaseStarted?: boolean;
			/**
			 * The `runs` row this deferral belongs to (issue #136), when one was
			 * created/reused for this job. Carried onto the re-enqueued job so the
			 * retry resets the same row instead of inserting a new one. Absent when
			 * the deferral happened before a run row could be persisted.
			 */
			runId?: string;
			/**
			 * Set when this is a prioritized continuation deferral (issue #214): its
			 * dispatch dedup claim is being held open, so `reenqueueDeferred` threads
			 * `continuationDispatchClaimed` onto the retry job — the handler reuses the
			 * held claim rather than re-claiming (which would drop the run as a duplicate).
			 */
			continuationDispatchClaimed?: boolean;
			/**
			 * Set when this deferral should be retained in the pending-continuation
			 * registry (issue #214), so a freed project slot promotes its delayed retry
			 * ahead of new board work. `reenqueueDeferred` registers it after enqueuing
			 * the fallback retry.
			 */
			pendingContinuation?: boolean;
			/**
			 * A project-slot deferral. Unlike a provider failure, its dispatch is
			 * returned to `pending` (wait reason `project-capacity`) and awakened
			 * only by a released slot, not a timer.
			 */
			pendingDispatch?: boolean;
			/**
			 * The classified failure kind behind a scheduled-retry deferral — maps
			 * onto the dispatch record's wait reason so the Queue UI can explain
			 * *why* the retry is waiting (issue #284).
			 */
			failureKind?: DeferrableFailure['kind'];
			/**
			 * A dependency re-check deferral (issue #330), not an agent failure: the
			 * dispatch waits (`recheck`) on an unfinished prerequisite and consumes the
			 * separate {@link SwarmJob.dependencyRecheckAttempt} budget, leaving the
			 * rate-limit budget untouched.
			 */
			dependencyRecheck?: boolean;
			/**
			 * A worker-eligibility re-check deferral (issue #339): the federated
			 * dispatch gate found no eligible worker for this phase, so the dispatch
			 * waits (`worker-eligibility`) on its own budget — again token-free, since
			 * the gate runs before any worktree or agent.
			 */
			workerEligibilityRecheck?: boolean;
	  };

/**
 * A persistent usage/session limit — or a run that keeps getting aborted —
 * shouldn't retry forever. Cap the loop so a genuinely exhausted quota (or a
 * misclassified failure, or a job that reliably crashes the worker) eventually
 * surfaces as a real `phase-failed` instead of re-enqueuing indefinitely.
 */
const MAX_RATE_LIMIT_RETRIES = 6;
/**
 * Capacity is transient, but retrying the same saturated model repeatedly is
 * unlikely to help. Allow two short retries, then suggest another configured
 * model instead of applying the longer quota-reset policy.
 */
const MAX_CAPACITY_RETRIES = 2;
/**
 * Dependency re-check cadence + budget (issue #330). A blocked Implementation
 * re-checks its prerequisites every {@link DEPENDENCY_RECHECK_INTERVAL_MS} — a
 * token-free deferral (the gate runs before any worktree/agent) — for up to
 * {@link MAX_DEPENDENCY_RECHECKS} attempts, then settles failed with an actionable
 * "must be done first" message rather than waiting forever. Both derived from env
 * (`SWARM_DEPENDENCY_RECHECK_MS` / `SWARM_DEPENDENCY_MAX_WAIT_MS`).
 */
const DEPENDENCY_RECHECK_INTERVAL_MS = resolveDependencyRecheckIntervalMs();
const MAX_DEPENDENCY_RECHECKS = maxDependencyRechecks(
	DEPENDENCY_RECHECK_INTERVAL_MS,
	resolveDependencyMaxWaitMs(),
);
/**
 * The federated eligibility gate's re-check (issue #339) waits on exactly the
 * same kind of external condition as the dependency gate — a human granting
 * consent, an admin approving an enrollment, an assignee's worker finishing its
 * current run — and is equally token-free (it runs before any worktree or
 * agent), so it deliberately shares that cadence and budget rather than
 * introducing a second pair of knobs. Its *attempt counter* is separate
 * (`workerEligibilityRecheckAttempt`), so waiting on a dependency and waiting on
 * a worker never consume each other's budget.
 */
const ELIGIBILITY_RECHECK_INTERVAL_MS = DEPENDENCY_RECHECK_INTERVAL_MS;
const MAX_ELIGIBILITY_RECHECKS = MAX_DEPENDENCY_RECHECKS;
/**
 * Floor on the retry delay, deliberately above the review-dispatch-dedup TTL
 * (5 min, `src/triggers/review-dispatch-dedup.ts`): a review retry that fires
 * only after the claim has expired re-acquires it cleanly, so we never have to
 * release/refresh a claim that a *generic* failed run might have posted under.
 * A rate-limited or aborted run never posted anything anyway, but the retry
 * still has to land after the claim it (may have) left behind expires — this
 * is also the flat delay used for an `aborted` retry (see
 * {@link retryDelayForFailure}), which has no reset time to compute from.
 */
const MIN_RETRY_DELAY_MS = 6 * 60 * 1000;
/** Ceiling, so a mis-parsed reset time can't defer a job for an absurd span. */
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;
/** Backoff when the CLI gave no parseable reset time — likely lands past reset. */
const DEFAULT_RETRY_DELAY_MS = 30 * 60 * 1000;
/** Fire slightly *after* the reported reset so quota is actually back. */
const RETRY_BUFFER_MS = 60 * 1000;

/**
 * TTL the review-dispatch claim is refreshed while an SCM continuation is held
 * pending. The released job carries that claim and therefore never replays the
 * status/webhook dedup path as fresh work.
 */
const PENDING_CONTINUATION_CLAIM_TTL_SEC = Math.ceil(MIN_RETRY_DELAY_MS / 1000) + 120;

/**
 * Coded default wall-clock timeout applied to *every* phase/agent invocation
 * when a project sets no per-phase `agents.<phase>.timeoutMs` (issue #165).
 * Without it an agent that hangs — a model that never responds, a wedged CLI —
 * runs forever, holding a worker slot and leaving its run row stuck `running`
 * (confirmed live on run `dd0ad860-…`). Chosen as a 30-minute default: long
 * enough for a focused phase, while bounding a runaway run's quota use and
 * occupied worker slot. Override the
 * default globally with the `SWARM_AGENT_TIMEOUT_MS` env var
 * (README § Configuration); a per-phase `timeoutMs` in `swarm.config.json`
 * still wins over both.
 */
export const DEFAULT_AGENT_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * The coded default agent CLI — used when neither a per-job override nor a phase
 * config names one. Every pipeline phase's own coded default (`DEFAULT_*_CLI` in
 * `src/pipeline/*.ts`) is `claude`, so this is the CLI a defaulted run actually
 * launches; keep it in sync if a phase default ever changes. It resolves the
 * effective engine persisted on the run row (issue #169) and keys the model
 * fallback maps in {@link resolveModel}. Exported so a unit test can assert it
 * stays equal to every phase's coded `DEFAULT_*_CLI`, guarding the drift the
 * "keep in sync" note above warns about (issue #169).
 */
export const DEFAULT_ENGINE: AgentCli = 'claude';

/**
 * Resolve the effective default agent timeout: `SWARM_AGENT_TIMEOUT_MS` when it
 * is set to a positive integer, else {@link DEFAULT_AGENT_TIMEOUT_MS}. Exported
 * so the worker entrypoint reuses the exact same value for its stale-run
 * reconciliation cutoff (`src/worker/index.ts`). Throws on a non-integer / <1
 * value so a typo surfaces at startup rather than silently disabling the safety
 * net.
 */
export function resolveAgentTimeoutMs(raw = process.env.SWARM_AGENT_TIMEOUT_MS): number {
	if (raw === undefined || raw === '') return DEFAULT_AGENT_TIMEOUT_MS;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`SWARM_AGENT_TIMEOUT_MS must be a positive integer, got '${raw}'`);
	}
	return parsed;
}

/** The effective default agent timeout, resolved once at module load. */
const AGENT_TIMEOUT_MS = resolveAgentTimeoutMs();

/**
 * Lease taken when a dispatch is claimed at dequeue (issue #284) — long enough
 * to cover trigger resolution (authoritative board/check re-reads) and worktree
 * provisioning; extended to the phase's own wall-clock timeout the moment the
 * run starts (`markDispatchRunning`).
 */
const DISPATCH_CLAIM_LEASE_MS = 15 * 60 * 1000;
/**
 * Margin past the effective agent timeout before a `running` dispatch's lease
 * is considered dead — the harness's SIGTERM→SIGKILL grace plus headroom for a
 * slow finalize, mirroring the stale-run sweep's margin (`src/worker/index.ts`).
 */
const DISPATCH_LEASE_MARGIN_MS = 10 * 60 * 1000;

/** Swallow-and-log dispatch completion — bookkeeping must never fail a settled run. */
async function tryCompleteDispatch(
	dispatchId: string,
	outcome: Parameters<typeof completeDispatch>[1],
): Promise<void> {
	try {
		await completeDispatch(dispatchId, outcome);
	} catch (err) {
		logger.error('Failed to complete dispatch record (lease sweep will repair)', {
			dispatchId,
			outcome,
			error: describeError(err),
		});
	}
}

/** Swallow-and-log dispatch failure — see {@link tryCompleteDispatch}. */
async function tryFailDispatch(dispatchId: string, error: string): Promise<void> {
	try {
		await failDispatch(dispatchId, error);
	} catch (err) {
		logger.error('Failed to fail dispatch record (lease sweep will repair)', {
			dispatchId,
			error: describeError(err),
		});
	}
}

export type DeferrableFailure = AgentFailure | { kind: 'delivery' };

/**
 * Turn a deferrable failure into a clamped retry delay. An `aborted` run (the
 * worker's own shutdown killed it — a dev `--watch` restart, a deploy, a
 * graceful SIGTERM/SIGINT) has no "resets at…" hint to parse and needs none:
 * by the time a re-enqueued job is dequeued, the worker that killed it has
 * already finished restarting, so the only reason to wait at all is the same
 * dedup-claim floor a rate-limit retry respects.
 */
export function retryDelayForFailure(failure: DeferrableFailure, now: number): number {
	if (
		failure.kind === 'aborted' ||
		failure.kind === 'capacity' ||
		failure.kind === 'delivery' ||
		failure.kind === 'worktree-exists' ||
		failure.kind === 'stalled' ||
		// A timeout has no "resets at…" hint and needs no long wait — the run
		// simply ran long; retry after the same dedup-claim floor as an abort.
		failure.kind === 'timeout'
	)
		return MIN_RETRY_DELAY_MS;
	const raw = failure.retryAfter
		? failure.retryAfter.getTime() - now + RETRY_BUFFER_MS
		: DEFAULT_RETRY_DELAY_MS;
	return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, raw));
}

function deferredPhaseMessage(failure: DeferrableFailure, phase: TriggerPhase): string {
	switch (failure.kind) {
		case 'aborted':
			return `Phase stopped - ${phaseLabel(phase)} — worker shutdown, deferring retry`;
		case 'capacity':
			return `Phase stopped - ${phaseLabel(phase)} — model at capacity, deferring short retry`;
		case 'delivery':
			return `Phase stopped - ${phaseLabel(phase)} — delivery failed, deferring retry`;
		case 'worktree-exists':
			return `Phase stopped - ${phaseLabel(phase)} — worktree already exists, deferring retry`;
		case 'stalled':
			return `Phase stopped - ${phaseLabel(phase)} — response stalled, deferring resume retry`;
		case 'timeout':
			return `Phase stopped - ${phaseLabel(phase)} — timed out, deferring resume retry`;
		default:
			return `Phase stopped - ${phaseLabel(phase)} — rate-limited, deferring retry`;
	}
}

/**
 * The Tier 2 decision for a deferrable failure (issue #503, `docs/CHECKPOINTS.md`):
 * either continue the run from the checkpoint in its preserved checkout, or report
 * that its budget for doing so is spent. When the budget cannot be read, it instead
 * releases the checkout before the ordinary retry. Resolved by {@link resolveCheckpointFallback};
 * `undefined` there means "not a Tier 2 case" and the deferral proceeds exactly as it did before.
 */
type CheckpointFallback =
	| { kind: 'continue'; checkpoint: Checkpoint; continuationCount: number }
	| { kind: 'exhausted'; spent: number; max: number }
	| { kind: 'release' };

/**
 * Decide whether this deferrable failure becomes a Tier 2 checkpoint continuation.
 *
 * Tier 1 keeps absolute priority — {@link checkpointFallbackApplies} rejects any stop
 * a resumable session can still serve — so this only ever *adds* a path for stops
 * that would otherwise restart the phase from scratch. Everything after that gate is
 * evidence gathering: a parseable checkpoint that names this phase, and the run's
 * remaining continuation budget.
 *
 * The checkpoint has two sources and one meaning. A federated worker parsed the file
 * on its own host and reported it in the deferral frame (`AgentRunError.checkpoint`,
 * rebuilt by `../router/dispatcher.ts`); the in-process worker reads the checkout it
 * owns. Either way the *divergence* check is deliberately left to the continuation's
 * own gate (`validateCheckpointForContinuation`), which runs on the host that holds
 * the tree — a settle cannot ask git about a worktree on another machine, and a
 * mismatch there is exactly the `checkpoint-divergent` block phase 2 records.
 *
 * A missing run row or DB error reading the count makes the budget unknowable, so this
 * declines continuation and tells the caller to release the checkout before an ordinary retry.
 */
async function resolveCheckpointFallback(
	err: unknown,
	job: SwarmJob,
	trigger: TriggerResult,
	project: ProjectConfig,
	runId: string | undefined,
): Promise<CheckpointFallback | undefined> {
	if (!(err instanceof AgentRunError)) return undefined;
	const wasSessionResume = job.resumeSession === true || job.recoveryMode === 'resume';
	if (!checkpointFallbackApplies(err, wasSessionResume)) return undefined;

	const checkpoint =
		err.checkpoint ??
		tryReadCheckpoint(new GitWorktreeManager(project).worktreePath(trigger.taskId));
	if (!checkpoint) return undefined;
	// A task's checkout is reused across phases, so a checkpoint another phase left
	// behind must not settle this one as continuable — the continuation gate would
	// only block on it (`checkpoint-divergent`) after paying for a dispatch.
	if (checkpoint.phase !== trigger.phase) {
		logger.debug('Ignoring a checkpoint written by another phase — no checkpoint continuation', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			checkpointPhase: checkpoint.phase,
		});
		return undefined;
	}

	if (!runId) return { kind: 'release' };
	let spent = 0;
	try {
		spent = (await getRunByIdFromDb(runId))?.continuationCount ?? 0;
	} catch (readErr) {
		logger.error('Failed to read the continuation count — deferring without a continuation', {
			runId,
			error: describeError(readErr),
		});
		return { kind: 'release' };
	}
	const max = resolveMaxContinuations(project);
	if (spent >= max) return { kind: 'exhausted', spent, max };
	return { kind: 'continue', checkpoint, continuationCount: spent + 1 };
}

async function tryReleaseCheckpointFallbackCheckout(
	project: ProjectConfig,
	taskId: string,
	runId: string | undefined,
): Promise<void> {
	try {
		await new GitWorktreeManager(project).cleanup(taskId);
	} catch (error) {
		logger.error('Tier 2 checkpoint fallback checkout release failed', {
			projectId: project.id,
			taskId,
			runId,
			error: describeError(error),
		});
	}
}

/**
 * Handle a deferrable {@link AgentRunError} (`rate-limit`, `capacity`, or `aborted`) —
 * `processJob`'s one non-terminal failure path, split out to keep that
 * function's branching within the complexity budget. Returns the
 * `phase-deferred` outcome to return from `processJob`, or `undefined` when
 * the retry budget is exhausted (the caller falls through to its own
 * `phase-failed` logging/return).
 */
function deferAgentRunError(
	failure: DeferrableFailure,
	job: SwarmJob,
	trigger: TriggerResult,
	projectId: string,
	error: string,
	runId: string | undefined,
	checkpointFallback?: CheckpointFallback,
): Extract<JobOutcome, { status: 'phase-deferred' }> | undefined {
	// The Tier 2 bound sits with the other caps rather than in the settle: a run that
	// has already spent every continuation the project allows must fall through to a
	// terminal failure, which the caller reports as an exhausted continuation budget.
	// Checked first because it is the more specific of the two exhausted budgets.
	if (checkpointFallback?.kind === 'exhausted') {
		logger.error(`Phase failed - ${phaseLabel(trigger.phase)} — continuation budget exhausted`, {
			projectId,
			phase: trigger.phase,
			taskId: trigger.taskId,
			continuationsUsed: checkpointFallback.spent,
			maxContinuations: checkpointFallback.max,
			error,
		});
		return undefined;
	}
	const checkpointContinuation =
		checkpointFallback?.kind === 'continue' ? checkpointFallback : undefined;
	const attempt = job.rateLimitRetryAttempt ?? 0;
	const maxRetries = failure.kind === 'capacity' ? MAX_CAPACITY_RETRIES : MAX_RATE_LIMIT_RETRIES;
	if (attempt >= maxRetries) {
		logger.error(`Phase failed - ${phaseLabel(trigger.phase)} — retry budget exhausted`, {
			projectId,
			phase: trigger.phase,
			taskId: trigger.taskId,
			attempt,
			error,
		});
		return undefined;
	}

	const retryDelayMs = retryDelayForFailure(failure, Date.now());
	logger.warn(deferredPhaseMessage(failure, trigger.phase), {
		projectId,
		phase: trigger.phase,
		taskId: trigger.taskId,
		attempt,
		retryDelayMs,
		resetHint: 'resetHint' in failure ? failure.resetHint : undefined,
		// Tier 2: this retry re-seeds a fresh session from the checkpoint rather than
		// re-entering the stopped run's own session.
		continuation: checkpointContinuation?.continuationCount,
		error,
	});
	return {
		status: 'phase-deferred',
		phase: trigger.phase,
		taskId: trigger.taskId,
		retryDelayMs,
		reason: error,
		attempt,
		runId,
		// A rate-limit or timeout may have interrupted useful work whose reasoning
		// lives in the agent's CLI session (and, for implementer phases, whose
		// partial edits live in the worktree) — resume it instead of redoing it.
		// Every phase and CLI now captures a resumable session id (agent-cli.ts), so
		// this is no longer gated to claude or the PM phases; a run whose session
		// wasn't captured simply persists no id and retries from scratch.
		//
		// A `capacity` deferral (Codex "at capacity", Claude 529/overloaded — issue
		// #229) deliberately stays fresh: the provider rejected the request before
		// the model did any work, so there is no partial reasoning or edit to
		// resume, and the captured session id (if any) points at a run that never
		// progressed. Starting fresh matches the pre-existing Codex-capacity
		// contract; only an explicit safety case would justify resuming instead.
		//
		// A Tier 2 continuation is never `resumable` (issue #503): there is no session
		// worth carrying — that is precisely why it fell back to the checkpoint — so the
		// settle drops the captured id and the retry mints a fresh one.
		resumable:
			checkpointFallback === undefined &&
			(failure.kind === 'rate-limit' || failure.kind === 'timeout' || failure.kind === 'stalled'),
		checkpoint: checkpointContinuation?.checkpoint,
		continuationCount: checkpointContinuation?.continuationCount,
		resumeDelivery: failure.kind === 'delivery' || undefined,
		pmPhaseStarted:
			job.type === 'pm' && (trigger.phase === 'planning' || trigger.phase === 'implementation'),
		failureKind: failure.kind,
	};
}

/**
 * Handle a {@link DependencyBlockedError} (issue #330): build the token-free
 * `recheck` deferral while the dependency-recheck budget lasts, or return
 * `undefined` once it's exhausted so the caller falls through to a terminal
 * `phase-failed` that posts the "must be done first" message on the item. Split
 * out of {@link handlePhaseFailure} to keep its branching within budget, mirroring
 * {@link deferAgentRunError}.
 */
function deferDependencyBlock(
	err: DependencyBlockedError,
	job: SwarmJob,
	trigger: TriggerResult,
	projectId: string,
	error: string,
	runId: string | undefined,
): Extract<JobOutcome, { status: 'phase-deferred' }> | undefined {
	const attempt = job.dependencyRecheckAttempt ?? 0;
	if (attempt >= MAX_DEPENDENCY_RECHECKS) {
		logger.error(
			`Phase failed - ${phaseLabel(trigger.phase)} — still blocked after ${attempt} re-checks`,
			{ projectId, phase: trigger.phase, taskId: trigger.taskId, error },
		);
		return undefined;
	}
	logger.info(`Phase deferred - ${phaseLabel(trigger.phase)} — waiting on dependency`, {
		projectId,
		phase: trigger.phase,
		taskId: trigger.taskId,
		attempt,
		retryDelayMs: DEPENDENCY_RECHECK_INTERVAL_MS,
		blockers: err.blockers.map((b) => b.reference),
	});
	return {
		status: 'phase-deferred',
		phase: trigger.phase,
		taskId: trigger.taskId,
		retryDelayMs: DEPENDENCY_RECHECK_INTERVAL_MS,
		reason: error,
		attempt,
		resumable: false,
		dependencyRecheck: true,
		// The phase was entered (its gate ran) — preserve board dispatch intent so the
		// re-check re-enters Implementation even though the card never moved.
		pmPhaseStarted:
			job.type === 'pm' && (trigger.phase === 'planning' || trigger.phase === 'implementation'),
		runId,
	};
}

/**
 * Handle a {@link WorkerIneligibleError} (issue #339): no eligible worker may
 * take this dispatch. Like {@link deferDependencyBlock} this is a wait, not a
 * failure — the gate runs before any worktree or agent, so re-checking is
 * token-free — and it consumes its own bounded budget. Returns `undefined` once
 * that budget is exhausted, so the caller falls through to a terminal
 * `phase-failed` that posts the actionable reason (missing consent, missing
 * enrollment, no capable worker, …) on the item rather than dropping the work.
 */
function deferWorkerIneligible(
	err: WorkerIneligibleError,
	job: SwarmJob,
	trigger: TriggerResult,
	projectId: string,
	error: string,
	runId: string | undefined,
): Extract<JobOutcome, { status: 'phase-deferred' }> | undefined {
	const attempt = job.workerEligibilityRecheckAttempt ?? 0;
	if (attempt >= MAX_ELIGIBILITY_RECHECKS) {
		logger.error(
			`Phase failed - ${phaseLabel(trigger.phase)} — no eligible worker after ${attempt} re-checks`,
			{ projectId, phase: trigger.phase, taskId: trigger.taskId, reason: err.reason, error },
		);
		return undefined;
	}
	logger.info(`Phase deferred - ${phaseLabel(trigger.phase)} — waiting for an eligible worker`, {
		projectId,
		phase: trigger.phase,
		taskId: trigger.taskId,
		attempt,
		retryDelayMs: ELIGIBILITY_RECHECK_INTERVAL_MS,
		reason: err.reason,
	});
	return {
		status: 'phase-deferred',
		phase: trigger.phase,
		taskId: trigger.taskId,
		retryDelayMs: ELIGIBILITY_RECHECK_INTERVAL_MS,
		reason: error,
		attempt,
		resumable: false,
		workerEligibilityRecheck: true,
		// The gate refused before anything ran, so preserve board dispatch intent
		// exactly as the dependency gate does — the re-check must re-enter the same
		// phase even though the card never moved.
		pmPhaseStarted:
			job.type === 'pm' && (trigger.phase === 'planning' || trigger.phase === 'implementation'),
		// The gate refuses before `tryCreateRun`, so a fresh dispatch has no row yet
		// (`runId` is undefined). A retry carries its originating row, which must
		// survive so the next re-check keeps re-using it rather than orphaning it —
		// the same reason the concurrency deferral carries `job.runId`.
		runId: runId ?? job.runId,
	};
}

/** Map a classified deferrable failure onto the dispatch record's wait reason. */
function waitReasonForDeferral(kind: DeferrableFailure['kind'] | undefined): DispatchWaitReason {
	switch (kind) {
		case 'capacity':
			return 'agent-capacity';
		case 'aborted':
			return 'worker-shutdown';
		case 'timeout':
			return 'timeout';
		case 'stalled':
			return 'stalled';
		case 'delivery':
			return 'delivery';
		case 'worktree-exists':
			return 'worktree-exists';
		default:
			return 'rate-limit';
	}
}

/**
 * Persist the derived retry payload on the run row too (best-effort): a manual
 * "Retry now" for a legacy row with no dispatch reconstructs from it, and the
 * startup backfill uses it to rebuild lost dispatches.
 */
async function persistRetryPayloadOnRun(runId: string | undefined, job: SwarmJob): Promise<void> {
	if (!runId) return;
	try {
		await updateRunJobPayload(runId, job);
	} catch (err) {
		logger.error('Failed to persist retry payload on run row (continuing)', {
			runId,
			error: describeError(err),
		});
	}
}

/**
 * The dispatch record's wait reason for a deferral. The two token-free
 * re-checks wait on an external condition rather than on a failure, so each
 * reads as its own reason (like merge-automation's `recheck`) instead of a
 * failure-driven one.
 */
function deferralWaitReason(
	outcome: Extract<JobOutcome, { status: 'phase-deferred' }>,
): DispatchWaitReason {
	if (outcome.dependencyRecheck) return 'recheck';
	if (outcome.workerEligibilityRecheck) return 'worker-eligibility';
	return waitReasonForDeferral(outcome.failureKind);
}

/** The attempt counter this deferral consumed — each wait tracks its own (see {@link deferralWaitReason}). */
function deferralAttempt(
	outcome: Extract<JobOutcome, { status: 'phase-deferred' }>,
	next: SwarmJob,
): number {
	if (outcome.dependencyRecheck) return next.dependencyRecheckAttempt ?? 0;
	if (outcome.workerEligibilityRecheck) return next.workerEligibilityRecheckAttempt ?? 0;
	return next.rateLimitRetryAttempt ?? 0;
}

/**
 * Settle a claimed dispatch as `retry-scheduled`: derive the next attempt's
 * payload, persist it durably on the dispatch (the crash-safe retry intent —
 * issue #284), then publish the delayed wake-up. A publish failure is logged,
 * not thrown — the durable record already exists and the reconciler re-publishes
 * it. A dispatch that is no longer claimed (a user cancellation settled it
 * first) is left alone: the cancel wins.
 */
async function settleDispatchRetry(
	dispatch: DispatchRow,
	job: SwarmJob,
	outcome: Extract<JobOutcome, { status: 'phase-deferred' }>,
): Promise<void> {
	const next = deriveRetryJobPayload(job, {
		phase: outcome.phase,
		runId: outcome.runId,
		resumable: outcome.resumable,
		// Tier 2 (issue #503): the retry adopts the preserved checkout on the strength of
		// the checkpoint rather than a session, so it runs `recoveryMode: 'checkpoint'`
		// with a fresh session id.
		checkpointed: outcome.checkpoint !== undefined,
		resumeDelivery: outcome.resumeDelivery,
		pmPhaseStarted: outcome.pmPhaseStarted,
		continuationDispatchClaimed: outcome.continuationDispatchClaimed,
		dependencyRecheck: outcome.dependencyRecheck,
		workerEligibilityRecheck: outcome.workerEligibilityRecheck,
	});
	await persistRetryPayloadOnRun(outcome.runId, next);
	const updated = await scheduleDispatchRetry(dispatch.id, {
		jobPayload: next,
		availableAt: new Date(Date.now() + outcome.retryDelayMs),
		waitReason: deferralWaitReason(outcome),
		attempt: deferralAttempt(outcome, next),
		runId: outcome.runId,
	});
	if (!updated) {
		logger.debug('Dispatch no longer claimed — skipping retry schedule (cancelled?)', {
			dispatchId: dispatch.id,
			taskId: outcome.taskId,
		});
		return;
	}
	try {
		await publishDispatchWakeUp(updated);
	} catch (err) {
		logger.warn('Failed to publish retry wake-up (reconciler will repair)', {
			dispatchId: dispatch.id,
			error: describeError(err),
		});
	}
}

function deferForConcurrencyLimit(
	job: SwarmJob,
	trigger: TriggerResult,
	projectId: string,
): Extract<JobOutcome, { status: 'phase-deferred' }> | undefined {
	const reason = `Project '${projectId}' is at its concurrent-job limit`;

	logger.warn(`Phase deferred - ${phaseLabel(trigger.phase)} — project at concurrency limit`, {
		projectId,
		phase: trigger.phase,
		taskId: trigger.taskId,
	});
	return {
		status: 'phase-deferred',
		phase: trigger.phase,
		taskId: trigger.taskId,
		retryDelayMs: 0,
		reason,
		attempt: job.rateLimitRetryAttempt ?? 0,
		resumable: false,
		pendingDispatch: true,
		// A fresh webhook has no row yet (this defers before `tryCreateRun`); a
		// retry carries its originating row's id, which must survive so the next
		// re-enqueue keeps resetting the same row rather than orphaning it.
		runId: job.runId,
	};
}

/**
 * Handle a job blocked by the project's concurrency limit — `processJob`'s
 * pre-run deferral path, split out so that function stays within the complexity
 * budget (the file already splits helpers this way).
 *
 * The claimed dispatch is returned to `pending` (wait reason
 * `project-capacity`) with its exact dispatch intent persisted — PM jobs carry
 * `resumePmPhase` so a stale board status cannot deduplicate the resumed
 * phase — and is woken by a freed slot, not a timer (issue #284). Its run row
 * becomes visible immediately. SCM continuations retain their dispatch dedup
 * claim and optionally receive priority over board work.
 */
async function handleConcurrencyDeferral(
	dispatch: DispatchRow,
	job: SwarmJob,
	trigger: TriggerResult,
	project: ProjectConfig,
): Promise<JobOutcome> {
	const deferred = deferForConcurrencyLimit(job, trigger, project.id);
	if (!deferred) throw new Error('Concurrency deferral must always produce a pending dispatch');

	// Every blocked phase gets a run row now. This makes new Planning and
	// Implementation work visible while it waits, rather than creating a row only
	// after a timer happens to fire.
	// No gate selection here: this defers *before* the eligibility gate runs, so
	// the row records the target local routing would pick. The eventual wake-up
	// re-enters `processJob` and resolves its target through the gate.
	const runId = await tryCreateRun(
		project,
		{ globalDefaults: await loadGlobalDefaults(), availableClis: await loadAvailableClis() },
		trigger,
		job,
	);
	if (runId) deferred.runId = runId;

	// Retain a concurrency-blocked SCM phase as a prioritized continuation once
	// a slot frees.
	if (isPrioritizedContinuationPhase(trigger.phase)) {
		deferred.continuationDispatchClaimed = true;
		deferred.pendingContinuation = project.pipeline?.prioritizeContinuations !== false;
		if (trigger.phase === 'review' || trigger.phase === 'respond-to-ci') {
			// Review and Respond-to-CI share the PR+SHA dispatch slot.
			await refreshReviewDispatchClaim(
				buildReviewDispatchKey(project.repo, trigger.prNumber, trigger.headSha),
				PENDING_CONTINUATION_CLAIM_TTL_SEC,
			);
		} else if (trigger.phase === 'resolve-conflicts') {
			await refreshConflictResolutionClaim(
				buildConflictResolutionKey(
					project.repo,
					trigger.prNumber,
					trigger.headSha,
					trigger.baseSha,
				),
				PENDING_CONTINUATION_CLAIM_TTL_SEC,
			);
		}
	}

	// Persist the durable capacity wait *before* settling the visible run: the
	// dispatch row is the retry intent, so a crash after this line loses nothing.
	const pendingPayload = deriveCapacityPendingPayload(job, {
		phase: trigger.phase,
		runId: deferred.runId,
		resumable: false,
		continuationDispatchClaimed: deferred.continuationDispatchClaimed,
	});
	await persistRetryPayloadOnRun(deferred.runId, pendingPayload);
	await deferDispatchToPending(dispatch.id, {
		jobPayload: pendingPayload,
		waitReason: 'project-capacity',
		continuation: deferred.pendingContinuation === true,
		runId: deferred.runId,
	});

	// This pre-try/catch path must settle the visible run now. A slot deferral has
	// no scheduled timestamp: a release, not polling, wakes it.
	await finalizeFailedRun(deferred.runId, deferred, undefined);
	return deferred;
}

/**
 * Task IDs whose phase is currently running in *this* worker process, keyed by
 * the worktree task id a phase provisions (`task-<id>`, `src/worker/git-worktree-manager.ts`).
 *
 * A single drag of a board card fires two `projects_v2_item` webhooks
 * (`reordered` + `edited`), which arrive as two jobs. The Redis dedup
 * (`src/triggers/pm-status-dedup.ts`) collapses them only while its short TTL is
 * live; a duplicate that waits in the queue longer than that TTL — stuck behind
 * other multi-minute phase runs — re-passes the dedup once its key has expired
 * and re-dispatches the *same* phase for the *same* task while the first run is
 * still in flight. That second run's `provision()` then collides on the
 * existing `task-<id>` worktree and fails the (redundant) job with a hard
 * "worktree already exists" error, even though the original run completes fine.
 *
 * This in-process guard closes that window at the worktree's own granularity:
 * if a phase's worktree task id is already running here, the duplicate is
 * skipped as a no-op instead of dispatched into a collision. The check-and-add
 * is synchronous — no `await` between {@link Set.has} and {@link Set.add} — so
 * BullMQ concurrency can't interleave two callers past it. It intentionally does
 * *not* touch a stale worktree left by a previous crashed process (that's not in
 * this set); reclaiming those is issue #99's job, and surfacing the collision
 * they still cause is issue #98's. Single-worker MVP, so in-memory suffices; a
 * multi-worker deployment would need a Redis lease keyed the same way.
 */
const inFlightTaskIds = new Set<string>();

/**
 * Resolve the model for a phase, walking a four-tier fallback chain (most to
 * least specific):
 *
 *   per-phase model → project `agents.defaults[cli]` → global
 *   `agents.defaults[cli]` (`globalDefaults`, the DB-backed app settings,
 *   `src/config/app-settings.ts`) → coded `DEFAULT_MODEL_PER_CLI[cli]`.
 *
 * The per-phase CLI may itself be undefined (meaning the pipeline phase's own
 * coded default); when so, `'claude'` is used only to key the defaults maps and
 * the coded fallback — the *actual* phase CLI is resolved pipeline-side.
 */
function resolveModel(
	project: ProjectConfig,
	globalDefaults: AgentDefaults | undefined,
	phaseCli?: AgentCli,
	phaseModel?: string,
): string {
	if (phaseModel) return phaseModel;
	const cli = phaseCli ?? DEFAULT_ENGINE;
	return project.agents?.defaults?.[cli] ?? globalDefaults?.[cli] ?? DEFAULT_MODEL_PER_CLI[cli];
}

/**
 * Check whether Planning **completed** for this work item — a failed or
 * deferred attempt does not count (issue #247). The history lookup is
 * best-effort: an error assumes planning occurred so dispatch keeps using the
 * established Implementation config rather than changing behavior on a DB hiccup.
 */
async function wasPrecededByPlanning(projectId: string, taskId: string): Promise<boolean> {
	try {
		return await hasCompletedRunForTask(projectId, taskId, 'planning');
	} catch (err) {
		logger.error('Failed to check for a prior planning run (assuming planned)', {
			projectId,
			taskId,
			error: describeError(err),
		});
		return true;
	}
}

/**
 * Resolve the *explicitly requested* reasoning level for a phase — the selected
 * target's level, which `resolveTargetPolicy` has already folded a per-run
 * `reasoningOverride` into. Unlike `model`, reasoning has no per-CLI defaults
 * tier: a default level valid for one model can be invalid for another (issue
 * #180). Omitting it here means the CLI keeps its own default behavior
 * (claude/codex get no reasoning flag; antigravity's combined-variant string
 * falls back to the model's default inside `resolveModelLaunch`), which is what
 * we persist as "Default (unknown)".
 *
 * A requested level is dropped (→ `undefined`) when the effective model doesn't
 * support it, so a stale override left over from a different model/CLI can't
 * launch an invalid variant — it degrades to the CLI/model default instead.
 */
function resolveReasoning(
	cli: AgentCli | undefined,
	model: string,
	requested?: ReasoningLevel,
): ReasoningLevel | undefined {
	if (!requested) return undefined;
	if (!cli) return requested;
	const cap = capabilityFor(cli, model);
	if (!cap) return requested; // legacy/unknown model — trust the value
	return (cap.reasoningChoices as readonly ReasoningLevel[]).includes(requested)
		? requested
		: undefined;
}

/**
 * Everything one dequeued job's model-target resolution depends on, resolved
 * once per job and threaded through run creation, the dispatch lease, and the
 * phase invocation — so all three agree on the *same* target instead of each
 * re-deriving one (issue #339's ordered-target addendum).
 */
export interface PhaseResolution {
	/** Global per-CLI default models — the tier between project and coded defaults. */
	globalDefaults: AgentDefaults | undefined;
	/** The CLIs this worker can run, for local capability routing (issue #346). */
	availableClis: WorkerCliAvailability;
	/**
	 * The target the federated eligibility gate selected together with its worker
	 * (issue #339). Absent for an unfederated project, where local routing picks
	 * the target instead.
	 */
	selection?: DispatchSelection;
	/** Authenticated session that claimed `selection`; present exactly when selection is bound. */
	executionIdentity?: WorkerExecutionIdentity;
}

/**
 * The already-resolved inputs the pluggable phase executor runs from — exactly
 * the arguments {@link runPhase} takes, plus the claimed `dispatch` (so the
 * control-plane transport executor can build and push a `TaskAssignment` keyed by
 * `dispatch.id`). Issue #407 splits `processJob` into a dispatcher half (claim →
 * trigger → gates → bind → run-row → settle, all shared) and this one pluggable
 * step: the in-process executor ignores `dispatch` and calls `runPhase`; the
 * control-plane executor (`src/router/dispatcher.ts`) composes and pushes the
 * assignment and awaits the worker's `TaskExecutionResult`, adapting it back to a
 * {@link PhaseRunResult} (or throwing so the shared failure path settles it).
 */
export interface DispatchPhaseContext {
	trigger: TriggerResult;
	project: ProjectConfig;
	resolution: PhaseResolution;
	job: SwarmJob;
	runId: string | undefined;
	signal: AbortSignal;
	implementationUnplanned: boolean;
	dispatch: DispatchRow;
}

/**
 * Collaborators that let the control-plane transport path (issue #407) reuse
 * {@link processJob} verbatim while diverging only where it must. Every field is
 * optional and the defaults reproduce today's in-process behavior exactly, so the
 * host worker's call is unchanged.
 */
export interface ProcessJobDeps {
	/**
	 * Options folded into the eligibility gate — the transport path passes a
	 * connectivity predicate so only socket-connected workers are selected
	 * (`src/worker/eligibility-gate.ts`).
	 */
	gateOptions?: DispatchGateOptions;
	/**
	 * Require a selected worker. In transport mode there is no local executor, so
	 * an unfederated/single-user project (the gate returns no selection) has
	 * nowhere to run: it defers durably as a token-free `worker-eligibility` wait
	 * rather than running on the host.
	 */
	federatedOnly?: boolean;
	/**
	 * Resolve the execution identity a selected worker is bound with. Default: the
	 * host's own identity (which must equal the selection — the in-process host is
	 * the selected worker). The transport path resolves the *selected* worker's
	 * live session identity instead, so the control plane binds the fenced claim on
	 * that worker's behalf.
	 */
	resolveBindIdentity?: (
		selection: DispatchSelection,
	) => Promise<WorkerExecutionIdentity | undefined>;
	/** Run the resolved phase. Default: {@link runPhase} (in-process execution). */
	executePhase?: (context: DispatchPhaseContext) => Promise<PhaseRunResult>;
}

/** Adapt the federated worker+target selection to the shared target-routing shape. */
function targetSelectionFor(selection: DispatchSelection | undefined): TargetSelection | undefined {
	if (!selection) return undefined;
	return {
		target: selection.target,
		index: selection.targetIndex,
		skipped: selection.skippedClis,
		fallback: false,
	};
}

/**
 * Make a phase's routing decision (issue #346) visible in the worker log: quiet
 * (debug) when the preferred target won, louder when this worker had to route
 * around a CLI it cannot run — the case an operator needs to see, since it
 * explains why a run used a model the project didn't ask for first.
 */
function logAgentRouting(
	project: ProjectConfig,
	trigger: TriggerResult,
	routing?: TargetSelection,
): void {
	if (!routing) return;
	const context = {
		projectId: project.id,
		phase: trigger.phase,
		taskId: trigger.taskId,
		// An undefined `cli` means the phase's own coded default (`DEFAULT_*_CLI`).
		cli: routing.target.cli ?? 'phase default',
		model: routing.target.model,
		targetIndex: routing.index,
	};
	if (routing.fallback) {
		logger.warn('No configured target CLI is available here - using the preferred target', context);
	} else if (routing.skipped.length > 0) {
		logger.info('Routed the phase to a lower-priority target', {
			...context,
			unavailable: routing.skipped,
		});
	} else {
		logger.debug('Routed the phase to its preferred target', context);
	}
}

/**
 * A phase run's result — the shape every `runXPhase` resolves to as far as the
 * worker cares. The orchestrators differ in their inputs and return richer
 * types, but all carry the agent run (`.agent`); the optional fields below are
 * the ones the worker (and the transport back-channel) read off the result.
 */
/**
 * Resolve the SCM delivery provider for a PR-driven phase, choosing the delivery
 * mode in one place (ADR-004 §2). In **control-plane delivery mode** — a
 * federated worker with both `SWARM_CONTROL_PLANE_URL` and
 * `SWARM_WORKER_CREDENTIAL` set — the metadata-only calls (`submitReview` /
 * `postComment`) travel up the transport to the router's server-side delivery
 * API, which performs them under the persona this phase asked for — the
 * per-project reviewer PAT for a Review, the implementer for a Respond-to-review
 * reply, which must not be authored by the reviewer it answers (issue #444); the
 * source-carrying / attribution ops (commit identity, find/create PR, push) stay
 * local via the in-process delegate, keeping the operator's own token
 * worker-side. Otherwise — the **local host worker**, the default — it returns
 * `undefined`, so the phase builds today's in-process provider itself, lazily,
 * byte-for-byte unchanged; single-user mode and the same-machine worker are
 * unaffected.
 */
export async function resolveScmDelivery(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<ScmDeliveryProvider | undefined> {
	const controlPlaneUrl = getControlPlaneUrl();
	const workerCredential = optionalEnv('SWARM_WORKER_CREDENTIAL', '').trim();
	if (!controlPlaneUrl || !workerCredential) return undefined;
	return createTransportScmDeliveryProvider({
		controlPlaneUrl,
		workerCredential,
		projectId: project.id,
		persona,
		localDelegate: await requireProjectSCMProvider(project).deliveryProvider(project, persona),
	});
}

/**
 * Resolve the PM provider a board-driven phase (planning / implementation /
 * respond-to-review) writes through, choosing the delivery mode in the same one
 * place as {@link resolveScmDelivery} (ADR-004 §2, Phase 2/2). In **control-plane
 * delivery mode** — a federated worker with both `SWARM_CONTROL_PLANE_URL` and
 * `SWARM_WORKER_CREDENTIAL` set — the two metadata-only PM writes
 * (`moveWorkItem` / `addComment`) travel up the transport to the router's
 * server-side delivery API, which performs them under the per-project PM
 * credential; every read and non-metadata write stays local via the in-process
 * delegate, so the worker never holds that credential. Otherwise — the **local
 * host worker**, the default — it returns `undefined`, so `runAssignedPhase`
 * builds today's in-process provider itself, byte-for-byte unchanged;
 * single-user mode and the same-machine worker are unaffected.
 */
export function resolvePmDelivery(project: ProjectConfig): PMProvider | undefined {
	const controlPlaneUrl = getControlPlaneUrl();
	const workerCredential = optionalEnv('SWARM_WORKER_CREDENTIAL', '').trim();
	if (!controlPlaneUrl || !workerCredential) return undefined;
	return createTransportPmDeliveryProvider({
		controlPlaneUrl,
		workerCredential,
		projectId: project.id,
		localDelegate: requireProjectPMProvider(project),
	});
}

export interface PhaseRunResult {
	agent: AgentCliResult;
	/**
	 * The canonical completion status a PM-driven phase moved the item to, if any
	 * — `processJob` uses it to self-enqueue the next PM-driven phase
	 * (see {@link selfEnqueueNextPhase}).
	 */
	movedTo?: PmStatusKey;
	split?: { subTaskItemIds: string[]; mainTaskUpdated: boolean };
	/** Validated Planning scope, available only after a successful normal Planning run. */
	planningScope?: ProposedScope;
	/** The submitted verdict of a Review run — persisted onto its history row (issue #218). */
	verdict?: ReviewVerdict;
	/** This Review run's review-verdict safety-cap slot (1…`REVIEW_VERDICT_CAP`) — persisted onto its history row (issue #235). */
	reviewOrdinal?: number;
	/** This Review run's automation outcome (e.g. `manual-intervention-required`) — persisted onto its history row (issue #235). */
	automationOutcome?: ReviewAutomationOutcome;
	/**
	 * The PR this phase produced (Implementation only) — persisted onto its history
	 * row as the run's attribution PR (ADR-004 §4, issue #398). Absent for every
	 * phase that creates no PR.
	 */
	prUrl?: string;
}

/**
 * The already-resolved inputs a single pipeline phase runs from — the normalized
 * shape both dispatch paths build before invoking a phase: the in-process path
 * ({@link runPhase}, from a `TriggerResult` + routing overrides + the job's
 * session fields) and the transport path (`../worker/transport-client.ts`, from
 * a pushed `TaskAssignment`). Centralizing the per-phase runner switch in
 * {@link runAssignedPhase} is what keeps the two paths from diverging — the
 * mapping of "which phase → which `runXPhase`, with which arguments" lives in
 * exactly one place.
 */
export interface AssignedPhaseInputs {
	phase: TriggerPhase;
	taskId: string;
	project: ProjectConfig;
	cli?: AgentCli;
	model?: string;
	reasoning?: ReasoningLevel;
	customPrompt?: string;
	timeoutMs?: number;
	/** Deterministic session handle assigned to a fresh run (claude's `--session-id`). */
	sessionId?: string;
	/** Session to resume on a rate-limit/timeout retry — undefined on a fresh run. */
	resumeSessionId?: string;
	/** Resume deterministic-delivery progress rather than an agent session. */
	resumeDelivery: boolean;
	/** The database run id, when one exists for this attempt. */
	runId?: string;
	/** External cancellation — aborting kills the agent CLI. */
	signal?: AbortSignal;
	/** Agent runner (live-output-wrapped by the caller); defaults are the phase's own. */
	runAgent: ReturnType<typeof createLiveOutputRunner>;
	/** planning / implementation: the board item to act on. */
	workItem?: WorkItem;
	/**
	 * planning / implementation / respond-to-review only: the resolved
	 * control-plane PM write delegate (ADR-004 §2, {@link resolvePmDelivery}) or
	 * DB-free dispatch injection (ADR-003 §2, `../transport/assignment-execution.ts`),
	 * or `undefined` to use the phase's own in-process provider (the local host
	 * worker, via `requireProjectPMProvider`). Mirrors {@link delivery} on the
	 * SCM side.
	 */
	pm?: PMProvider;
	/** implementation: reuse an already-provisioned task branch on a resumed retry. */
	resumeExistingBranch?: boolean;
	/** implementation: called once the task branch has been acquired, for resume idempotency. */
	onBranchProvisioned?: () => Promise<void>;
	/** PR-driven phases (review / respond-to-* / resolve-conflicts). */
	prNumber?: string;
	prBranch?: string;
	headSha?: string;
	/** respond-to-review only. */
	reviewId?: string;
	/**
	 * respond-to-review only: the board card this PR's task was dispatched from,
	 * resolved control-plane side from the durable `runs.work_item_id` link
	 * (`../dispatch/board-card.ts`, issue #498) so the DB-free worker needs no
	 * database to report board status (ADR-003 §2). Undefined when nothing links
	 * the task to a card, in which case the phase falls back to its legacy
	 * URL-suffix lookup.
	 */
	boardItemId?: string;
	/** resolve-conflicts only. */
	baseBranch?: string;
	baseSha?: string;
	/**
	 * review / respond-to-review only: the resolved control-plane SCM delivery
	 * provider (ADR-004 §2, {@link resolveScmDelivery}) or DB-free dispatch
	 * injection (ADR-003 §2, `../transport/assignment-execution.ts`), or
	 * `undefined` to use the phase's own in-process delegate (the local host
	 * worker, via the project's registered SCM provider).
	 *
	 * A remote worker with no `DATABASE_URL` additionally injects an
	 * operator-token `agentToken` alongside `delivery` (and, for board-driven
	 * phases, a `pm`; for review, a `reviewLedger`) so no phase reaches into the
	 * secret store or the DB.
	 * Forwarding both `delivery` and `agentToken` keeps the delivery-owning
	 * phases' `legacyMode` guard false (it is `getToken !== undefined &&
	 * delivery === undefined`), i.e. deterministic delivery stays on. The
	 * in-process ({@link runPhase}) and same-host (`./transport-client.ts`)
	 * paths leave both unset, so the phase resolves its own default exactly
	 * as before — the agent token from `getPersonaToken`.
	 */
	delivery?: ScmDeliveryProvider;
	agentToken?: string;
	/**
	 * review only: the review-verdict ledger the phase reads the re-review signal
	 * and writes its submitted slot through (`../pipeline/review-ledger.ts`).
	 * Injected by a DB-free worker with the transport-backed implementation
	 * (ADR-003 §2, `../transport/review-ledger-delivery.ts`), since that worker
	 * cannot reach `review_verdicts` itself. Left unset by the in-process and
	 * same-host paths, which keep the phase's own repository defaults.
	 */
	reviewLedger?: ReviewVerdictLedger;
	/**
	 * respond-to-review only: how the phase schedules the one follow-up Review a
	 * pushed fix owes (issue #241). Injected by a DB-free worker with the
	 * transport-backed implementation (ADR-003 §2,
	 * `../transport/follow-up-review-delivery.ts`), since the default writes a
	 * dispatch row and enqueues a job — a `DATABASE_URL`/`REDIS_URL` that worker
	 * does not have. Left unset by the in-process and same-host paths, which keep
	 * the phase's own `scheduleFollowUpReviewDefault`.
	 */
	scheduleFollowUpReview?: ScheduleFollowUpReview;
}

/**
 * Dispatch already-resolved {@link AssignedPhaseInputs} to the matching
 * `runXPhase` orchestrator — the single per-phase switch both the in-process and
 * transport dispatch paths share. The phase owns its own worktree lifecycle, so
 * this provisions nothing; it only forwards each phase its inputs, defaulting a
 * board-driven phase's PM provider to the concrete in-process one when no
 * control-plane write delegate was injected (`inputs.pm` — {@link
 * resolvePmDelivery}). That fallback is the one place a concrete provider is
 * named, per ai/RULES.md §2.
 *
 * A missing phase-required input (a planning/implementation call with no
 * `workItem`, a PR phase with no coordinates) throws here rather than reaching
 * the orchestrator with an undefined argument — the trigger union and the
 * `TaskAssignment` schema both guarantee these upstream, so a violation is a
 * programming error at this seam.
 */
export async function runAssignedPhase(inputs: AssignedPhaseInputs): Promise<PhaseRunResult> {
	const { project, taskId, runId, signal, runAgent, cli, model, reasoning, customPrompt } = inputs;
	const timeoutMs = inputs.timeoutMs;
	// Session threading, uniform across every phase (issue: cross-CLI resume). On a
	// resume retry the persisted id is handed back as the CLI's resume id; on a
	// fresh run it's assigned as claude's `--session-id` (codex/agy ignore the
	// assign and have their id captured post-run).
	const session = {
		sessionId: inputs.sessionId,
		resumeSessionId: inputs.resumeSessionId,
		resumeDelivery: inputs.resumeDelivery,
	};
	// Additive DB-free injection (see `AssignedPhaseInputs`): forward an injected
	// PM/delivery/token straight through, defaulting the PM to the project's
	// registry-resolved provider (never a concrete one, per ai/RULES.md §2) and
	// leaving delivery/`getToken` unset so a phase builds its own DB-backed default
	// on the in-process path. `agentToken` becomes the phase's `getToken` seam.
	const { delivery } = inputs;
	const agentToken = inputs.agentToken;
	const getToken = agentToken !== undefined ? async () => agentToken : undefined;
	// Resolved lazily so a phase that takes no PM provider (review / respond-to-ci /
	// resolve-conflicts) constructs none — preserving the in-process path exactly.
	const resolvePm = () => inputs.pm ?? requireProjectPMProvider(project);
	switch (inputs.phase) {
		case 'planning':
			if (!inputs.workItem) throw new Error('planning phase requires a workItem');
			return runPlanningPhase({
				project,
				workItem: inputs.workItem,
				taskId,
				pm: resolvePm(),
				cli,
				model,
				reasoning,
				customPrompt,
				autoAdvance: project.pipeline?.planning?.autoAdvance,
				autoSplit: project.pipeline?.planning?.autoSplit,
				maxConcerns: project.pipeline?.planning?.maxConcerns,
				timeoutMs,
				signal,
				// The run-row id anchors the plan comment's per-delivery idempotency
				// marker (planning.ts `planDeliveryMarker`): stable across a retry of
				// this run, fresh for a later replan, so a retry reuses its comment
				// while a replan posts anew.
				runId,
				...session,
				runAgent,
			});
		case 'implementation':
			if (!inputs.workItem) throw new Error('implementation phase requires a workItem');
			return runImplementationPhase({
				project,
				workItem: inputs.workItem,
				taskId,
				pm: resolvePm(),
				delivery,
				getToken,
				cli,
				model,
				reasoning,
				customPrompt,
				resumeExistingBranch: inputs.resumeExistingBranch === true,
				onBranchProvisioned: inputs.onBranchProvisioned,
				// Identifies this attempt to the provision-time collision gate, so a
				// lease left behind by a crashed run is recognised as an orphan instead
				// of wedging this one as `live-leased` (issue #427). Every phase below
				// passes it for the same reason.
				runId,
				...session,
				timeoutMs,
				signal,
				runAgent,
			});
		case 'review':
			if (inputs.prNumber === undefined || inputs.headSha === undefined) {
				throw new Error('review phase requires prNumber and headSha');
			}
			return runReviewPhase({
				project,
				prNumber: inputs.prNumber,
				headSha: inputs.headSha,
				taskId,
				delivery,
				getToken,
				// Undefined on the in-process/same-host paths, where the phase keeps its
				// own `review_verdicts` repository defaults; set only by the DB-free
				// worker, whose ledger calls travel to the control plane.
				getPriorSubmittedReview: inputs.reviewLedger?.getPriorSubmittedReview,
				markReviewVerdictSubmitted: inputs.reviewLedger?.markReviewVerdictSubmitted,
				abandonReviewVerdict: inputs.reviewLedger?.abandonReviewVerdict,
				cli,
				model,
				reasoning,
				customPrompt,
				runId,
				...session,
				timeoutMs,
				signal,
				runAgent,
			});
		case 'respond-to-review':
			if (
				inputs.prNumber === undefined ||
				inputs.prBranch === undefined ||
				inputs.reviewId === undefined ||
				inputs.headSha === undefined
			) {
				throw new Error(
					'respond-to-review phase requires prNumber, prBranch, reviewId and headSha',
				);
			}
			return runRespondToReviewPhase({
				project,
				prNumber: inputs.prNumber,
				prBranch: inputs.prBranch,
				reviewId: inputs.reviewId,
				headSha: inputs.headSha,
				taskId,
				pm: resolvePm(),
				boardItemId: inputs.boardItemId,
				delivery,
				getToken,
				// Undefined on the in-process/same-host paths, where the phase keeps its
				// own dispatch+queue scheduler; set only by the DB-free worker, whose
				// follow-up enqueue travels to the control plane.
				scheduleFollowUpReview: inputs.scheduleFollowUpReview,
				cli,
				model,
				reasoning,
				customPrompt,
				runId,
				...session,
				timeoutMs,
				signal,
				runAgent,
			});
		case 'respond-to-ci':
			if (
				inputs.prNumber === undefined ||
				inputs.prBranch === undefined ||
				inputs.headSha === undefined
			) {
				throw new Error('respond-to-ci phase requires prNumber, prBranch and headSha');
			}
			return runRespondToCiPhase({
				project,
				prNumber: inputs.prNumber,
				prBranch: inputs.prBranch,
				headSha: inputs.headSha,
				taskId,
				delivery,
				getToken,
				cli,
				model,
				reasoning,
				customPrompt,
				runId,
				...session,
				timeoutMs,
				signal,
				runAgent,
			});
		case 'resolve-conflicts':
			if (
				inputs.prNumber === undefined ||
				inputs.prBranch === undefined ||
				inputs.headSha === undefined ||
				inputs.baseBranch === undefined ||
				inputs.baseSha === undefined
			) {
				throw new Error(
					'resolve-conflicts phase requires prNumber, prBranch, headSha, baseBranch and baseSha',
				);
			}
			return runResolveConflictsPhase({
				project,
				prNumber: inputs.prNumber,
				prBranch: inputs.prBranch,
				headSha: inputs.headSha,
				baseBranch: inputs.baseBranch,
				baseSha: inputs.baseSha,
				taskId,
				delivery,
				cli,
				model,
				reasoning,
				customPrompt,
				runId,
				...session,
				timeoutMs,
				signal,
				runAgent,
			});
	}
}

/**
 * Run the pipeline phase a matched trigger resolved to (the in-process dispatch
 * path). Resolves routing overrides and the job's session-threading fields into
 * {@link AssignedPhaseInputs}, then hands off to the shared
 * {@link runAssignedPhase} switch. `signal` (the worker's shutdown signal) is
 * threaded through so a graceful shutdown kills any in-flight agent CLI.
 */
async function runPhase(
	trigger: TriggerResult,
	project: ProjectConfig,
	resolution: PhaseResolution,
	job: SwarmJob,
	runId: string | undefined,
	signal?: AbortSignal,
	implementationUnplanned = false,
): Promise<PhaseRunResult> {
	const overrides = agentOverrideFor(
		project,
		resolution,
		trigger.phase,
		job,
		implementationUnplanned,
	);
	logAgentRouting(project, trigger, overrides.routing);
	const runAgent = createLiveOutputRunner(runId);
	const markImplementationBranchProvisioned = async (): Promise<void> => {
		job.implementationBranchProvisioned = true;
		if (!runId) return;
		try {
			await updateRunJobPayload(runId, job);
		} catch (err) {
			logger.error('Failed to persist Implementation branch checkpoint', {
				runId,
				taskId: trigger.taskId,
				error: describeError(err),
			});
		}
	};
	const base = {
		phase: trigger.phase,
		taskId: trigger.taskId,
		project,
		cli: overrides.cli,
		model: overrides.model,
		reasoning: overrides.reasoning,
		customPrompt: overrides.customPrompt,
		timeoutMs: overrides.timeoutMs,
		sessionId: job.resumeSession ? undefined : job.agentSessionId,
		resumeSessionId: job.resumeSession ? job.agentSessionId : undefined,
		resumeDelivery: job.resumeDelivery === true,
		runId,
		signal,
		runAgent,
	};
	switch (trigger.phase) {
		case 'planning':
		case 'implementation':
			return runAssignedPhase({
				...base,
				workItem: trigger.workItem,
				pm: resolvePmDelivery(project),
				resumeExistingBranch: job.implementationBranchProvisioned === true,
				onBranchProvisioned: markImplementationBranchProvisioned,
			});
		case 'review':
			return runAssignedPhase({
				...base,
				prNumber: trigger.prNumber,
				headSha: trigger.headSha,
				delivery: await resolveScmDelivery(project, 'reviewer'),
			});
		case 'respond-to-review':
			return runAssignedPhase({
				...base,
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				reviewId: trigger.reviewId,
				headSha: trigger.headSha,
				pm: resolvePmDelivery(project),
				// Resolved here, where the DB is — the phase itself must run without one
				// (ADR-003 §2). Best-effort: `undefined` simply falls back in the phase.
				boardItemId: await resolveBoardItemIdForPrBranch(project, trigger.prBranch),
				delivery: await resolveScmDelivery(project, 'implementer'),
			});
		case 'respond-to-ci':
			return runAssignedPhase({
				...base,
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				headSha: trigger.headSha,
			});
		case 'resolve-conflicts':
			return runAssignedPhase({
				...base,
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				headSha: trigger.headSha,
				baseBranch: trigger.baseBranch,
				baseSha: trigger.baseSha,
			});
	}
}

/**
 * The per-phase agent override (`cli`/`model`) a project configured, resolving
 * `runPhase`'s own `project.agents?.<phase>?.{cli,model}` lookup once so a run
 * row can record the *requested* model at creation without threading it through
 * `runPhase`'s signature. `model` may be undefined — "the phase's coded default
 * is in effect", the same convention `describeAgent` uses.
 *
 * `engine` is the resolved effective CLI (`cli` with the coded {@link
 * DEFAULT_ENGINE} applied), persisted on the run row at creation/reset so the
 * dashboard shows it while a run is still `running` (issue #169); `cli` stays
 * undefined-preserving because the phase orchestrators expect that (they apply
 * their own `DEFAULT_*_CLI`). Finalization still records what actually ran
 * (`AgentCliResult.cli`), confirming or correcting the persisted engine.
 *
 * The model is resolved through the same fallback chain `runPhase` uses
 * (per-phase → project default → global default → coded default), so the
 * recorded value matches what actually runs.
 *
 * Which of the phase's `targets` is resolved comes from {@link PhaseResolution}:
 * the federated gate's chosen target when a worker was selected for it (issue
 * #339), else the highest-priority target *this* worker can run (issue #346, see
 * {@link selectTarget}). A per-run override still pins one exact target and is
 * never routed around.
 */
function agentOverrideFor(
	project: ProjectConfig,
	resolution: PhaseResolution,
	phase: TriggerPhase,
	job?: SwarmJob,
	implementationUnplanned = false,
): {
	cli?: AgentCli;
	engine: AgentCli;
	model?: string;
	reasoning?: ReasoningLevel;
	timeoutMs?: number;
	customPrompt?: string;
	/** The routing decision behind `cli`, when the phase configured targets. */
	routing?: TargetSelection;
} {
	const phaseConfig = phaseAgentConfig(project, phase, implementationUnplanned);
	// A per-run override pins one exact selection (a manual "retry with this
	// CLI/model" — `src/api/routers/runs.ts`), so it wins over routing: the run
	// resolves against the phase's own configured selection, as it did before.
	const policy = resolveTargetPolicy(phaseConfig, job);
	const routing = policy.pinned
		? undefined
		: (targetSelectionFor(resolution.selection) ??
			selectTarget(phaseConfig.targets, resolution.availableClis));
	// With no routing decision the policy's own first entry applies: the pinned
	// target, or the phase's coded defaults when it configured no list at all.
	const target = routing?.target ?? policy.targets[0];
	const cli = target.cli;
	const model = resolveModel(project, resolution.globalDefaults, cli, target.model);
	const reasoning = resolveReasoning(cli, model, target.reasoning);
	// Fall back to the worker's default wall-clock timeout when the project set no
	// per-phase override, so *every* agent invocation is bounded (issue #165).
	return {
		cli,
		engine: cli ?? DEFAULT_ENGINE,
		model,
		reasoning,
		routing,
		timeoutMs: phaseConfig.timeoutMs ?? AGENT_TIMEOUT_MS,
		// The project's optional per-phase custom prompt (issue #135). No default —
		// absent means the phase composes exactly its static prompt.
		customPrompt: phaseConfig.prompt,
	};
}

/**
 * Best-effort load of the global per-CLI default models (`agents.defaults` in
 * the DB-backed app settings, `src/config/app-settings.ts`) — the tier
 * `resolveModel` walks between a project's own defaults and the coded defaults.
 * A DB hiccup here must never fail a real pipeline run, so this swallows+logs
 * any error and returns `undefined` (fall through to the coded defaults),
 * consistent with the "run tracking is best-effort" contract in this file.
 */
async function loadGlobalDefaults(): Promise<AgentDefaults | undefined> {
	try {
		return (await getAppSettings()).agents?.defaults;
	} catch (err) {
		logger.error('Failed to load global agent defaults (using coded defaults)', {
			error: describeError(err),
		});
		return undefined;
	}
}

/**
 * The `agent_session_id` column a run reset writes. A resume leaves the stored
 * id untouched (`undefined`) — it is the very id being resumed. An attempt that
 * *assigns* instead records the id it is about to hand the CLI, mirroring
 * `createRun`'s `agentSessionId: id` for a first attempt, so a retry that dies
 * before it can finalize still leaves a recoverable session behind rather than a
 * null column.
 */
function resetSessionColumn(job: SwarmJob): string | null | undefined {
	return job.resumeSession ? undefined : (job.agentSessionId ?? null);
}

async function tryReuseLatestRun(
	project: ProjectConfig,
	resolution: PhaseResolution,
	trigger: TriggerResult,
	job: SwarmJob,
	implementationUnplanned = false,
): Promise<string | undefined> {
	const prior = await getLatestRunForTask(project.id, trigger.taskId, trigger.phase);
	if (!prior || (!isRetryPendingStatus(prior.status) && prior.status !== 'failed'))
		return undefined;
	if (job.resumeSession && prior.agentSessionId) {
		job.agentSessionId = prior.agentSessionId;
	} else if (!job.resumeSession) {
		// Deliberately stricter than the carried-run path below: a job that names no
		// run row can be an older payload whose id was never re-derived, and this
		// path has no row-level check to tell a spent id from a fresh one. Dropping
		// it lets the CLI mint its own rather than risk re-assigning a used one.
		delete job.agentSessionId;
	}
	const overrides = agentOverrideFor(
		project,
		resolution,
		trigger.phase,
		job,
		implementationUnplanned,
	);
	const recoveryVal = job.recoveryMode
		? { state: 'recovered' as const, agentSessionId: job.agentSessionId ?? null }
		: null;
	const claimed = await resetRunToRunning(
		prior.id,
		{ ...job, runId: prior.id },
		prior.status,
		overrides.model,
		overrides.timeoutMs,
		overrides.reasoning ?? null,
		overrides.engine,
		resetSessionColumn(job),
		recoveryVal,
		resolution.selection?.workerId,
		resolution.executionIdentity?.fencingToken,
		resolution.selection?.ownerUserId,
	);
	if (!claimed) return undefined;
	job.runId = prior.id;
	return prior.id;
}

async function tryResetCarriedRun(
	project: ProjectConfig,
	resolution: PhaseResolution,
	trigger: TriggerResult,
	job: SwarmJob,
	implementationUnplanned = false,
): Promise<string | undefined> {
	const runId = job.runId;
	if (!runId) return undefined;
	try {
		const overrides = agentOverrideFor(
			project,
			resolution,
			trigger.phase,
			job,
			implementationUnplanned,
		);
		const recoveryVal = job.recoveryMode
			? { state: 'recovered' as const, agentSessionId: job.agentSessionId ?? null }
			: null;
		return (await resetRunToRunning(
			runId,
			job,
			undefined,
			overrides.model,
			overrides.timeoutMs,
			overrides.reasoning ?? null,
			overrides.engine,
			resetSessionColumn(job),
			recoveryVal,
			resolution.selection?.workerId,
			resolution.executionIdentity?.fencingToken,
			resolution.selection?.ownerUserId,
		))
			? runId
			: undefined;
	} catch (err) {
		logger.error('Failed to reset run row for retry (creating a new one)', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			runId,
			error: describeError(err),
		});
		return undefined;
	}
}

/**
 * Best-effort creation of a run-history row before a phase runs. Run tracking is
 * a secondary, single-dev dashboard view (issue #102); a DB hiccup here must
 * never fail an actual pipeline run, so this swallows and logs any error and
 * returns `undefined` — the completion path then no-ops for a run with no id.
 *
 * When the job carries an `existingRunId` (a re-enqueued deferred run, or a
 * manual "Retry now" — issue #136), the originating row is *reset* to `running`
 * and reused rather than inserting a second one, so a retry shows as one run on
 * the dashboard, not two. If that row no longer exists (pruned between the
 * deferral and the retry), this falls through to creating a fresh row.
 */
/**
 * Best-effort PR title for a PR-driven run's history row (review / respond-to-*),
 * so the dashboard shows the human-readable title instead of the synthetic
 * `<pr>-respond` taskId. Swallows+logs any error and returns `undefined` — a
 * failed title lookup (transient API blip, missing token) must never fail the
 * run, consistent with the "run tracking is best-effort" contract in this file.
 */
async function tryFetchPrTitle(
	project: ProjectConfig,
	prNumber: string,
): Promise<string | undefined> {
	try {
		const title = await requireProjectSCMProvider(project).getPullRequestTitle(
			project,
			Number(prNumber),
		);
		return title ?? undefined;
	} catch (err) {
		logger.debug('Failed to fetch PR title for run row (continuing without it)', {
			projectId: project.id,
			prNumber,
			error: describeError(err),
		});
		return undefined;
	}
}

/**
 * Reuse an existing `runs` row for this job rather than inserting a new one:
 * the carried row when the job names one (a re-enqueued deferral or manual
 * retry — issue #136), otherwise the latest terminal row for the task. Returns
 * the reused row's id, or `undefined` when there's nothing to reuse (the caller
 * then creates a fresh row). Restores a resumable Claude session id from the
 * carried row onto the job before resetting it, so a resumed retry threads the
 * session through to the phase.
 */
async function reuseRunRow(
	project: ProjectConfig,
	resolution: PhaseResolution,
	trigger: TriggerResult,
	job: SwarmJob,
	implementationUnplanned = false,
): Promise<string | undefined> {
	const existingRunId = job.runId;
	if (existingRunId) {
		try {
			const existing = await getRunByIdFromDb(existingRunId);
			// Only when this attempt is actually resuming that session. An attempt
			// that isn't *assigns* its `agentSessionId` (`claude --session-id`), and
			// the payload already carries a freshly minted, unused id for that
			// (`deriveRetryJobPayload` / `reconstructRetryJob`); overwriting it with
			// the row's spent id makes the attempt exit 1 on `Session ID <id> is
			// already in use` before doing any work. The row can still hold one — a
			// terminated run preserves its session, and a swallowed finalize error
			// leaves the previous attempt's id in place — so the flag, not the
			// column, decides.
			if (job.resumeSession && existing?.agentSessionId) {
				job.agentSessionId = existing.agentSessionId;
			}
		} catch (err) {
			logger.debug('Failed to load resumable agent session (retrying from scratch)', {
				runId: existingRunId,
				error: describeError(err),
			});
		}
		return tryResetCarriedRun(project, resolution, trigger, job, implementationUnplanned);
	}
	try {
		return await tryReuseLatestRun(project, resolution, trigger, job, implementationUnplanned);
	} catch (err) {
		logger.error('Failed to reuse terminal run row (creating a new one)', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			error: describeError(err),
		});
		return undefined;
	}
}

async function tryCreateRun(
	project: ProjectConfig,
	resolution: PhaseResolution,
	trigger: TriggerResult,
	job: SwarmJob,
	implementationUnplanned = false,
): Promise<string | undefined> {
	const reusedRunId = await reuseRunRow(project, resolution, trigger, job, implementationUnplanned);
	if (reusedRunId) return reusedRunId;
	const prNumber = 'prNumber' in trigger ? trigger.prNumber : undefined;
	try {
		const overrides = agentOverrideFor(
			project,
			resolution,
			trigger.phase,
			job,
			implementationUnplanned,
		);
		const runId = await createRun({
			projectId: project.id,
			taskId: trigger.taskId,
			phase: trigger.phase,
			workerId: resolution.selection?.workerId,
			// The owner of that worker, already resolved by the dispatch gate — the
			// user half of the attribution record (ADR-004 §4, issue #398).
			workerUserId: resolution.selection?.ownerUserId,
			workerFencingToken: resolution.executionIdentity?.fencingToken,
			workItemId: 'workItem' in trigger ? trigger.workItem.id : undefined,
			workItemTitle: 'workItem' in trigger ? trigger.workItem.title : undefined,
			workItemUrl: 'workItem' in trigger && trigger.workItem.url ? trigger.workItem.url : undefined,
			prNumber,
			prTitle: prNumber ? await tryFetchPrTitle(project, prNumber) : undefined,
			engine: overrides.engine,
			model: overrides.model,
			reasoning: overrides.reasoning,
			timeoutMs: overrides.timeoutMs,
			jobPayload: job,
		});
		job.agentSessionId = runId;
		return runId;
	} catch (err) {
		logger.error('Failed to create run row (continuing)', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			error: describeError(err),
		});
		return undefined;
	}
}

/**
 * Best-effort finalization of a run-history row: set its terminal columns and,
 * when the run produced captured output, store its stdout/stderr. No-ops when
 * `runId` is undefined (creation failed) and swallows+logs any DB error, so the
 * two completion sites (success/failure) don't each repeat the try/catch and a
 * DB hiccup can't turn a settled pipeline run into a failed job (issue #102).
 */
async function finalizeRun(
	runId: string | undefined,
	input: CompleteRunInput,
	agent?: AgentCliResult,
): Promise<void> {
	if (!runId) return;
	try {
		await completeRun(runId, input);
		if (agent) await storeRunLogs(runId, agent.stdout, agent.stderr);
	} catch (err) {
		logger.error('Failed to finalize run row (continuing)', {
			runId,
			error: describeError(err),
		});
	}
}

/**
 * Finalize a run row for a failed/deferred outcome. A `phase-deferred` outcome
 * records `deferred` (the run will retry — not an error); anything else records
 * `failed`. When the failure carried its agent result ({@link AgentRunError.agent}),
 * its engine/exit/timing columns and captured logs are persisted too; a failure
 * that never ran an agent (missing hand-off file, worktree setup) records the
 * `error` message only.
 */
async function finalizeFailedRun(
	runId: string | undefined,
	outcome: JobOutcome,
	err: unknown,
	// Present only for the in-worker phase-failure path: lets a user-terminated
	// run reconcile its checkout (`src/worktree/termination-cleanup.ts`) now that
	// its agent has exited, so the persisted recovery record matches what was left
	// on disk. Omitted for the pre-run concurrency deferral (a `phase-deferred`
	// outcome that never provisioned a worktree).
	reconcile?: { project: ProjectConfig; taskId: string; worktrees?: GitWorktreeManager },
): Promise<void> {
	const agent = err instanceof AgentRunError ? err.agent : undefined;
	if (outcome.status === 'phase-deferred') {
		await finalizeRun(
			runId,
			{
				// A Tier 2 continuation settles as its own retry-pending status (issue
				// #503) so every read model can tell "waiting to resume its session" from
				// "waiting to continue from a checkpoint" — the latter having no session id
				// at all. The checkpoint travels onto the row so the API/dashboard can show
				// the recorded remainder without reading a (possibly remote) worker's disk.
				status: outcome.checkpoint ? 'checkpointed' : 'deferred',
				error: outcome.reason,
				nextRetryAt: outcome.pendingDispatch ? null : new Date(Date.now() + outcome.retryDelayMs),
				...agentColumns(agent),
				// Persist the session id the run captured so the retry can resume it —
				// for claude the id it assigned/echoed, for codex/agy the id captured
				// from their output/store. `null` when not resumable, or when the run
				// created no session to resume (retry then starts from scratch) — which
				// includes every checkpoint continuation.
				agentSessionId: outcome.resumable ? (agent?.sessionId ?? null) : null,
				checkpoint: outcome.checkpoint,
				continuationCount: outcome.continuationCount,
			},
			agent,
		);
	} else if (outcome.status === 'phase-failed') {
		let recoveryVal: any = null;
		let sessionToRetain: string | null = null;
		// The recorded cancellation origin (issue #308), when this failure is a
		// cancellation: the object when the supported dashboard/API `terminate`
		// action recorded one, `null` for a marker-only (external/unknown)
		// cancellation, `undefined` when this failure isn't a cancellation at all
		// (leaves the column untouched — see `CompleteRunInput.cancellation`).
		let cancellationOrigin: CancellationOrigin | null | undefined;

		if (err instanceof BlockedRecoveryError) {
			recoveryVal = {
				state: 'blocked',
				blockedReason: err.reason,
			};
		} else {
			const isCancelled = runId ? await isRunCancellationRequested(runId) : false;
			if (isCancelled && runId) {
				cancellationOrigin = await getRunCancellationOrigin(runId);
				const run = await getRunByIdFromDb(runId);
				const activeSessionId = agent?.sessionId ?? run?.agentSessionId ?? null;
				if (reconcile) {
					// The run has stopped (its agent exited): reconcile the checkout it
					// left behind. A running run owns its own worktree lease, so a present
					// lease never blocks removal (`stoppedRunHeldLease: true`).
					const worktrees = reconcile.worktrees ?? new GitWorktreeManager(reconcile.project);
					const result = await reconcileTerminatedWorktree(
						worktrees,
						reconcile.project.id,
						reconcile.taskId,
						activeSessionId,
						true,
					);
					if (result.outcome === 'preserved') {
						sessionToRetain = result.agentSessionId;
						recoveryVal = { state: 'preserved', agentSessionId: result.agentSessionId };
					} else if (result.outcome === 'blocked') {
						recoveryVal = { state: 'blocked', blockedReason: result.blockedReason };
					}
					// 'removed'/'absent': no recovery, no retained session — a session id
					// must never outlive the checkout it would have resumed.
				} else if (activeSessionId) {
					// Defensive fallback (no reconcile context): preserve the session as
					// before rather than silently dropping recoverable work.
					sessionToRetain = activeSessionId;
					recoveryVal = { state: 'preserved', agentSessionId: activeSessionId };
				}
			}
		}

		await finalizeRun(
			runId,
			{
				status: 'failed',
				error: outcome.error,
				agentSessionId: sessionToRetain,
				recovery: recoveryVal,
				cancellation: cancellationOrigin,
				failureDiagnosis: outcome.failureDiagnosis,
				...agentColumns(agent),
			},
			agent,
		);
	}
}

/** The run's engine/exit/timing columns, pulled from a captured agent result. */
function agentColumns(agent: AgentCliResult | undefined): Partial<CompleteRunInput> {
	return {
		engine: agent?.cli,
		exitCode: agent?.exitCode,
		timedOut: agent?.timedOut,
		durationMs: agent?.durationMs,
		usage: agent?.usage,
	};
}

/**
 * After a PM-driven phase's own `autoAdvance` moves the item to a status that
 * starts the *next* phase (currently only Planning → "ToDo" → Implementation,
 * `src/pm/pipeline.ts`), self-enqueue a synthetic board-status job for it
 * instead of waiting on the provider's webhook echo of that move.
 *
 * The router's loop-prevention gate (`PMRouterAdapter.isSelfAuthored`)
 * drops *every* board status-change webhook authored by a SWARM persona —
 * correctly, since that's exactly the feedback loop it exists to break. But
 * Planning moves its own card using the `implementer` persona
 * (`src/integrations/scm/github/personas.ts`), the very identity that move's
 * webhook gets checked against — so the direct webhook for this transition is
 * dropped every time, and the pipeline previously advanced only when some
 * other, differently-attributed webhook for the same item happened to arrive
 * later (an unbounded wait — confirmed live: an item sat in "ToDo" for hours
 * with Implementation never dispatching). This bypasses the router and webhook
 * entirely — a manual/synthetic job with no `deliveryId`, exactly the
 * `enqueueJob` carve-out already documented in `src/queue/producer.ts` — and
 * drives it through the *same* trigger-match → authoritative-re-read → dedup
 * path a real webhook would, so "which phase does this status start" is
 * resolved in exactly one place.
 *
 * Best-effort: a failure to self-enqueue is logged, not thrown, so it can't
 * turn an already-succeeded phase into a failed job — worst case the item is
 * left exactly where the phase left it, same as before this existed.
 */
async function selfEnqueueNextPhase(
	project: ProjectConfig,
	workItem: WorkItem,
	movedTo: PmStatusKey | undefined,
): Promise<void> {
	if (!movedTo) return;
	const nextPhase = resolvePipelinePhaseForStatusKey(movedTo);
	if (!nextPhase) return;

	try {
		// The synthetic event is the *provider's* to shape: assembling one needs its
		// own board mapping, so it comes off the adapter rather than being built from
		// `project.pm`'s provider config here (ai/RULES.md §2).
		const job: SwarmJob = {
			type: 'pm',
			providerId: project.pm.type,
			projectId: project.id,
			event: requireProjectPMAdapter(project).synthesizeStateChange(project, workItem.id),
		};
		await createAndPublishDispatch({
			projectId: project.id,
			jobPayload: job,
			priority: priorityFor(job) ?? 0,
			source: 'synthetic',
		});
		logger.debug('pm-status: self-enqueued next phase after auto-advance', {
			projectId: project.id,
			itemId: workItem.id,
			movedTo,
			nextPhase,
		});
	} catch (err) {
		logger.error('Failed to self-enqueue next phase after auto-advance', {
			projectId: project.id,
			itemId: workItem.id,
			movedTo,
			nextPhase,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Persist a durable merge dispatch after an eligible Review approval (issue
 * #292). The eligibility gate lives here, at the composition root, so pipeline
 * code neither merges nor schedules queue work (`ai/RULES.md` §2): only a
 * completed Review run's submitted `approve` verdict with
 * `pipeline.respondToReview.autoMerge` on requests a merge — the sole
 * eligibility rule (issue #235); Respond-to-review's own outcomes never do.
 * Execution happens later, when the dispatch's wake-up is claimed
 * (`processMergeAutomationDispatch`), never inline in the Review job.
 */
async function requestMergeAutomationIfEligible(
	trigger: TriggerResult,
	project: ProjectConfig,
	runId: string | undefined,
	verdict: ReviewVerdict | undefined,
): Promise<void> {
	if (trigger.phase !== 'review') return;
	if (verdict !== 'approve') return;
	if (project.pipeline?.respondToReview?.autoMerge !== true) return;
	if (!runId) {
		// The dispatch's dedup identity and outcome persistence both key on the
		// Review run row; without one (a degraded `tryCreateRun`) there is no safe
		// way to carry the intent — surface the miss instead of merging blindly.
		logger.warn('Review approval eligible for merge automation, but no run row exists — skipping', {
			projectId: project.id,
			prNumber: trigger.prNumber,
			headSha: trigger.headSha,
		});
		return;
	}
	await requestMergeAutomation({
		project,
		reviewRunId: runId,
		taskId: trigger.taskId,
		prNumber: trigger.prNumber,
		approvedHeadSha: trigger.headSha,
	});
}

/**
 * The comment SWARM posts on a work item's backing Issue when its phase fails
 * terminally. It names the phase and carries the failure message so a human
 * watching the board sees *why* the item stalled without digging through worker
 * logs — a failed phase leaves the item where it is (typically "In progress"),
 * so until now the failure had no board-visible signal at all.
 */
export function phaseFailureCommentBody(
	phase: TriggerPhase,
	error: string,
	failureDiagnosis?: FailureDiagnosis,
): string {
	const lines = [
		'## ⚠️ SWARM run failed',
		'',
		`The **${phase}** phase did not complete — no result was produced.`,
		'',
		'```',
		error,
		'```',
		'',
		"This item hasn't moved. Re-trigger the phase once the cause is addressed; the agent's full output is in the worker logs.",
	];
	if (failureDiagnosis) {
		lines.push(
			'',
			`### ${failureDiagnosis.title}`,
			'',
			failureDiagnosis.message,
			failureDiagnosis.recovery,
		);
	}
	lines.push('', '---', SWARM_GENERATED_FOOTER);
	return lines.join('\n');
}

/**
 * Post a phase-failure comment on the backing Issue of a work-item-carrying
 * phase (planning/implementation) or on the backing PR of a PR-driven phase
 * (review/respond-*). Best-effort: a failed comment is swallowed and logged so
 * it can't mask the phase failure it's reporting (the same swallow-and-log
 * contract the phases use for worktree cleanup).
 */
async function reportPhaseFailureToBoardOrPr(
	trigger: TriggerResult,
	project: ProjectConfig,
	error: string,
	failureDiagnosis?: FailureDiagnosis,
): Promise<void> {
	try {
		const body = phaseFailureCommentBody(trigger.phase, error, failureDiagnosis);
		if ('workItem' in trigger) {
			const pm = requireProjectPMProvider(project);
			const commentId = await pm.addComment(trigger.workItem.id, body);
			logger.debug('Posted phase-failure comment to the board item', {
				projectId: project.id,
				phase: trigger.phase,
				taskId: trigger.taskId,
				workItemId: trigger.workItem.id,
				commentId,
			});
		} else if ('prNumber' in trigger) {
			const scm = requireProjectSCMProvider(project);
			const commentId = await scm.commentOnPullRequest(project, Number(trigger.prNumber), body);
			logger.debug('Posted phase-failure comment to the PR', {
				projectId: project.id,
				phase: trigger.phase,
				taskId: trigger.taskId,
				prNumber: trigger.prNumber,
				commentId,
			});
		}
	} catch (commentErr) {
		logger.error('Failed to post phase-failure comment', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			error: commentErr instanceof Error ? commentErr.message : String(commentErr),
		});
	}
}

/**
 * The comment SWARM posts when a job is killed by the queue itself — a *stalled*
 * job (BullMQ reclaimed it because the worker couldn't renew its lock in time)
 * rather than a phase that ran and failed. Unlike {@link phaseFailureCommentBody}
 * this can't name the phase's own error (there isn't one — the queue gave up on
 * the job), so it explains the interruption and carries the queue's message.
 *
 * Crucially it does *not* claim the run produced nothing: a stall is the queue
 * abandoning the job, not the phase's process dying, so the orphaned agent run
 * often keeps going and posts its result *after* the queue reclaimed the job —
 * observed live: a Review job reclaimed as stalled still submitted its approval
 * ~2.5 min later. So the wording covers both outcomes (recovered vs genuinely
 * lost) rather than telling a human to re-trigger a phase that already finished.
 */
export function interruptedRunCommentBody(error: string): string {
	return [
		'## ⚠️ SWARM run interrupted',
		'',
		'A SWARM run for this item was reclaimed by the queue as *stalled* — the worker ' +
			'could not renew the job’s lock in time (an overloaded, restarted, or crashed worker).',
		'',
		'```',
		error,
		'```',
		'',
		'The run may have finished anyway after the queue gave up: if a result already ' +
			'appeared for it (a review, a plan, a PR comment, a moved card), it recovered and no ' +
			'action is needed. If nothing appeared, re-trigger the phase once the worker is healthy ' +
			'(move the card, re-open/push the PR, or re-run its checks).',
		'',
		'---',
		SWARM_GENERATED_FOOTER,
	].join('\n');
}

/**
 * Leave a board-visible trace when a job is failed by the queue *outside*
 * `processJob` — a stalled job (lock lost → reclaimed; `maxStalledCount: 0` fails
 * it terminally with no retry). Those never reach {@link handlePhaseFailure}, so
 * without this the run vanishes into the worker log with nothing on the board.
 * Called from the entrypoint's `failed` handler with the raw job data.
 *
 * Best-effort and fully self-contained: it re-validates the (Redis-round-tripped)
 * job data, resolves the project itself, and swallows every error — a failure to
 * comment must not throw out of an event handler. The target is derived straight
 * from the job's event (no trigger re-dispatch, which would re-run dedup claims
 * and API calls): a board event → the work item (Issue) via the PM provider; a
 * PR/check event → the PR via the provider the job itself names (the PM provider
 * has no PR-number → comment mapping, mirroring {@link reportPhaseFailureToBoard}).
 */
export async function reportInterruptedJobToBoard(jobData: unknown, error: string): Promise<void> {
	let job: SwarmJob;
	try {
		job = SwarmJobSchema.parse(jobData);
	} catch (parseErr) {
		logger.warn('Interrupted-job report: job data did not validate — skipping comment', {
			error: parseErr instanceof Error ? parseErr.message : String(parseErr),
		});
		return;
	}

	try {
		const project = await findProjectByIdFromDb(job.projectId);
		if (!project) {
			// Unknown project (deleted mid-flight, or the non-stall `processJob` throw
			// that also lands here) — nothing to comment on.
			logger.debug('Interrupted-job report: project not found — skipping comment', {
				projectId: job.projectId,
			});
			return;
		}

		// A merge-automation dispatch has no board item and posts nothing — its
		// outcome is already visible on the Review run and the dispatch record.
		if (job.type === 'merge-automation') {
			logger.debug('Interrupted-job report: merge-automation dispatch — skipping comment', {
				projectId: job.projectId,
				prNumber: job.prNumber,
			});
			return;
		}

		const body = interruptedRunCommentBody(error);

		if (job.type === 'pm') {
			const pm = requireProjectPMProvider(project);
			const commentId = await pm.addComment(job.event.itemId, body);
			logger.info('Posted interrupted-run comment on board item', {
				projectId: project.id,
				itemId: job.event.itemId,
				commentId,
			});
			return;
		}

		const prNumber = job.event.workItemId;
		if (!prNumber) {
			logger.debug('Interrupted-job report: SCM job carries no PR/issue number — skipping', {
				projectId: project.id,
				eventKind: job.event.kind,
			});
			return;
		}
		// The job carries the provider its own ingress wrote, so resolve by that id
		// rather than by project — the event-accurate lookup (issue #385's pattern).
		const scm = requireSCMProvider(job.providerId);
		const commentId = await scm.commentOnPullRequest(project, Number(prNumber), body);
		logger.info('Posted interrupted-run comment on PR', {
			projectId: project.id,
			prNumber,
			commentId,
		});
	} catch (commentErr) {
		logger.error('Failed to post interrupted-run comment', {
			projectId: job.projectId,
			error: commentErr instanceof Error ? commentErr.message : String(commentErr),
		});
	}
}

/**
 * Process one dequeued job end to end.
 *
 * A job no handler claims completes as `no-trigger`. A job whose phase ran but
 * failed — the agent exited non-zero, a hand-off file was missing, or worktree
 * setup failed — completes as `phase-failed` rather than throwing: an agent run
 * isn't idempotent, so a BullMQ retry storm is worse than surfacing the failure
 * in the outcome (the phase already logs the agent's own stdout/stderr, and
 * reporting to the PM board is the phase's job). The one thing that still
 * throws is an unknown project — infrastructure the job can't proceed without.
 *
 * The exception to "failed phases don't retry" is a deferrable
 * {@link AgentRunError}: a usage/session-limit hit (classified `rate-limit`,
 * issue #91) or a run the worker itself cancelled (classified `aborted` — the
 * *worker* shutting down while a phase was mid-run, e.g. a dev `--watch`
 * restart, a deploy, or a graceful SIGTERM/SIGINT; confirmed live when
 * unrelated code edits during active development kept restarting the worker
 * mid-review and permanently failing it, since a SIGTERM-killed run doesn't
 * look like a rate limit and there was no other path back to `phase-deferred`).
 * Either way the agent never did any *lasting* work of its own accord, so
 * instead of `phase-failed` this returns `phase-deferred` with a delay, and the
 * worker entrypoint re-enqueues the job once it's safe to retry. Capped at
 * {@link MAX_RATE_LIMIT_RETRIES} so a persistent limit — or a job that reliably
 * crashes the worker — eventually surfaces as a real failure.
 *
 * `signal` is the worker's shutdown signal: aborting kills a running agent CLI
 * (SIGTERM→SIGKILL) so graceful shutdown doesn't hang behind a long run.
 */
function buildTriggerContext(
	job: ScmWebhookJob | PmWebhookJob,
	project: ProjectConfig,
): TriggerContext {
	return job.type === 'scm'
		? {
				project,
				deliveryId: job.deliveryId,
				recheckAttempt: job.recheckAttempt,
				rateLimitRetryAttempt: job.rateLimitRetryAttempt,
				runId: job.runId,
				continuationDispatchClaimed: job.continuationDispatchClaimed,
				forcedReReview: job.forcedReReview,
				source: 'scm',
				providerId: job.providerId,
				event: job.event,
				// The composition root resolves the concrete provider exactly once, from
				// the registry, so no trigger handler ever names one (ai/RULES.md §2).
				scm: requireSCMProvider(job.providerId),
			}
		: {
				project,
				deliveryId: job.deliveryId,
				recheckAttempt: job.recheckAttempt,
				rateLimitRetryAttempt: job.rateLimitRetryAttempt,
				runId: job.runId,
				continuationDispatchClaimed: job.continuationDispatchClaimed,
				resumePmPhase: job.resumePmPhase,
				source: 'pm',
				providerId: job.providerId,
				event: job.event,
				// Same as the SCM branch: the composition root resolves the concrete
				// provider exactly once, from the registry, so no trigger handler ever
				// names one (ai/RULES.md §2).
				pm: requireProjectPMProvider(project),
			};
}

/**
 * The work item the automation-label gate judges a dispatch on, or `undefined`
 * when there is none to judge.
 *
 * A board-driven phase carries its item on the trigger. The four SCM
 * continuation phases (Review, Respond-to-review, Respond-to-CI,
 * Resolve-conflicts) carry a pull request instead, so their item is resolved
 * from the board here (issue #354) — through the PM contract and the PR's task
 * branch, never a provider-specific URL shape (ai/RULES.md §2). Costs one board
 * read per SCM dispatch; the gate calls it only while it is enabled.
 *
 * **Fails open**: an unlinked PR, a branch outside the project's `branchPrefix`,
 * an unreadable board, and an unresolvable PM provider all return `undefined`,
 * which the gate treats as eligible. A board blip must never wedge review/CI work.
 */
async function resolveGatedWorkItem(
	project: ProjectConfig,
	trigger: TriggerResult,
): Promise<WorkItem | undefined> {
	if ('workItem' in trigger) return trigger.workItem;
	const logContext = {
		projectId: project.id,
		phase: trigger.phase,
		taskId: trigger.taskId,
		prNumber: trigger.prNumber,
	};
	try {
		return await findWorkItemForPullRequest(
			requireProjectPMProvider(project),
			{
				repository: project.repo,
				// SWARM opens every PR from `<branchPrefix><itemNumber>`, so the branch
				// names the backing item (the same decode `src/pipeline/respond-to-review.ts`
				// performs for its board report).
				issueNumber: issueNumberFromBranch(trigger.prBranch, project.branchPrefix),
				prNumber: trigger.prNumber,
			},
			logContext,
		);
	} catch (error) {
		// Only resolving the provider can throw — the lookup swallows its own board
		// errors — so this is a wiring/credential problem. Fail open all the same.
		logger.warn('Automation-label gate could not resolve the PM provider — dispatching anyway', {
			...logContext,
			error: describeError(error),
		});
		return undefined;
	}
}

function isLaunchOrAuthenticationFailure(error: string): boolean {
	return /(?:failed to launch|\benoent\b|permission denied|\beacces\b|not authenticated|authentication (?:failed|required)|login required|please log in)/i.test(
		error,
	);
}

function knownFailureCondition(
	failureKind: AgentFailureKind | undefined,
	error: string,
): KnownFailureCondition | undefined {
	if (failureKind === 'rate-limit') return 'provider-rate-limit';
	if (failureKind === 'capacity') return 'provider-capacity';
	if (failureKind === 'aborted') return 'worker-shutdown';
	// A classified auth failure (issue #343) diagnoses off its kind, like the three
	// above, rather than depending on the exact wording of its message.
	if (failureKind === 'auth') return 'launch-or-authentication';
	if (isLaunchOrAuthenticationFailure(error)) return 'launch-or-authentication';
	return undefined;
}

async function tryLoadPlanningScope(
	projectId: string,
	taskId: string,
	failureKind: AgentFailureKind | undefined,
): Promise<ProposedScope | undefined> {
	if (failureKind !== 'stalled') return undefined;
	try {
		return await getLatestCompletedPlanningScope(projectId, taskId);
	} catch (err) {
		logger.debug('Failed to load Planning scope for terminal stall diagnosis', {
			projectId,
			taskId,
			error: describeError(err),
		});
		return undefined;
	}
}

async function handlePhaseFailure(
	err: unknown,
	job: SwarmJob,
	trigger: TriggerResult,
	project: ProjectConfig,
	runId: string | undefined,
	deps: ProcessJobDeps = {},
): Promise<JobOutcome> {
	// Delivery errors deliberately wrap a resumable checkpoint around the
	// underlying push/hook/API failure. Preserve that cause chain in the run row,
	// dashboard, and logs instead of reducing every incident to the opaque
	// "delivery deferred" wrapper.
	const error = describeError(err);

	// A control-plane transport settle raised by a worker's `cancelled` result
	// (issue #407): the worker already cleared the durable cancellation marker in
	// its own cleanup, so the `isRunCancellationRequested` check below cannot see
	// it — route it through the same terminal, user-initiated failure as the
	// in-process cancellation (never a deferral, which would re-run the killed
	// phase). Placed first so it wins before any deferrable-failure classification.
	if (err instanceof RunTerminatedError) {
		logger.info(`Phase cancelled after cancellation request - ${phaseLabel(trigger.phase)}`, {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			runId,
		});
		return {
			status: 'phase-failed',
			phase: trigger.phase,
			taskId: trigger.taskId,
			error: error || RUN_CANCELLED_MESSAGE,
			failureDiagnosis: diagnoseFailure({ knownCondition: 'user-terminated' }),
			cancelled: true,
		};
	}

	// If the failure looks like a missing binary, permission issue, or authentication/login failure,
	// run capability discovery immediately to refresh the dashboard status. Skipped
	// on the control-plane dispatch path (issue #407): the CLIs run on the remote
	// worker, not here, so probing the control plane's own PATH would record a
	// bogus "unavailable" for a failure that has nothing to do with its host.
	const isLaunchOrAuthFailure =
		!deps.executePhase &&
		(isLaunchOrAuthenticationFailure(error) ||
			(err instanceof AgentRunError &&
				// `auth` is named explicitly (issue #343): it used to reach here through
				// the catch-all `error` kind, and the dashboard's CLI/quota status must
				// still refresh after a login failure now that it classifies separately.
				(err.failure.kind === 'error' || err.failure.kind === 'auth')));

	if (isLaunchOrAuthFailure) {
		void discoverCliQuotas()
			.then(async (snapshots) => {
				for (const snapshot of snapshots) {
					await upsertCliQuota(snapshot.cli, snapshot.status, snapshot);
				}
			})
			.catch((discoverErr) => {
				logger.error('Failed to run recovery quota discovery after launch failure', {
					error: String(discoverErr),
				});
			});
	}

	// A user asked to terminate this run (issue #166): its abort must settle as a
	// terminal, user-initiated failure — never a deferral, which would re-enqueue
	// the very run the user just killed. Checked before the deferrable-abort branch
	// below, since a user-termination abort is classified `aborted` and would
	// otherwise be deferred. The captured agent output is still persisted by
	// `finalizeFailedRun` (logs preserved); we only skip the board "failed" comment,
	// as an intentional stop isn't a stall a human needs to investigate.
	if (runId && (await isRunCancellationRequested(runId))) {
		logger.info(`Phase cancelled after cancellation request - ${phaseLabel(trigger.phase)}`, {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			runId,
		});
		return {
			status: 'phase-failed',
			phase: trigger.phase,
			taskId: trigger.taskId,
			error: RUN_CANCELLED_MESSAGE,
			failureDiagnosis: diagnoseFailure({ knownCondition: 'user-terminated' }),
			cancelled: true,
		};
	}

	// A dependency block (issue #330) is neither a failure nor a rate-limit: the
	// work item is `blocked by` an unfinished prerequisite. Defer as a token-free
	// `recheck` on its own budget while the budget lasts; once exhausted, fall
	// through to the terminal path below, which posts this "must be done first"
	// message on the item. Placed after the cancellation check so a user can still
	// cancel a run that is merely waiting on a dependency.
	if (err instanceof DependencyBlockedError) {
		const deferred = deferDependencyBlock(err, job, trigger, project.id, error, runId);
		if (deferred) return deferred;
	}

	// The federated dispatch gate refused this attempt (issue #339): no eligible
	// worker may take the phase. Like a dependency block this is a wait, not a
	// failure — nothing ran, nothing was provisioned — so defer on its own budget
	// and, once exhausted, fall through to the terminal path below, which posts
	// the actionable reason (grant consent, approve the enrollment, enroll a
	// worker that can run the configured CLI) on the item.
	if (err instanceof WorkerIneligibleError) {
		const deferred = deferWorkerIneligible(err, job, trigger, project.id, error, runId);
		if (deferred) return deferred;
	}

	const failureKind =
		err instanceof AgentRunError
			? err.failure.kind
			: err instanceof BlockedRecoveryError
				? 'blocked-recovery'
				: undefined;

	// A usage/session-limit hit or a worker-shutdown abort is transient/recoverable:
	// rather than failing the job, we defer it and let the worker re-enqueue it once
	// it's safe to retry. Capped so a persistent limit can't loop forever. A worktree
	// collision is deliberately NOT deferrable (issue #367): provisioning already
	// reclaimed the checkout if it was safe, so a surviving collision is a protected
	// checkout raised as a terminal BlockedRecoveryError — re-deferring it would just
	// loop on the same protected worktree. An `auth` failure is deliberately absent
	// too (issue #343): the CLI is logged out, so retrying burns the shared retry
	// budget on a run only a human re-`/login` can unblock — it stays terminal and
	// its `(authentication failed)` headline tells the operator what to do.
	const isDeferrable =
		(err instanceof AgentRunError &&
			(err.failure.kind === 'rate-limit' ||
				err.failure.kind === 'capacity' ||
				err.failure.kind === 'aborted' ||
				err.failure.kind === 'stalled' ||
				// A timeout resumes only when the run was genuinely interrupted: it
				// carries an agent result whose exit was non-zero/null (the phase threw
				// and preserved its worktree). A run that trapped SIGTERM and still
				// exited 0 (issue #165's clean-exit case) already finished and cleaned up
				// its worktree, so it stays a terminal failure rather than deferring onto
				// a checkout that's gone.
				(err.failure.kind === 'timeout' && err.agent !== undefined && err.agent.exitCode !== 0))) ||
		err instanceof DeliveryDeferredError;
	// Tier 2's decision (issue #503) is resolved once and used twice: by the deferral,
	// which turns it into a `checkpointed` settle, and by the terminal path below, which
	// reports an exhausted continuation budget as the reason the run stopped for good.
	const checkpointFallback = isDeferrable
		? await resolveCheckpointFallback(err, job, trigger, project, runId)
		: undefined;
	if (checkpointFallback?.kind === 'release') {
		await tryReleaseCheckpointFallbackCheckout(project, trigger.taskId, runId);
	}
	if (isDeferrable) {
		const failure: DeferrableFailure =
			err instanceof AgentRunError ? err.failure : { kind: 'delivery' };
		const deferred = deferAgentRunError(
			failure,
			job,
			trigger,
			project.id,
			error,
			runId,
			checkpointFallback,
		);
		if (deferred) return deferred;
	}

	// A stop that Tier 2 would have continued from, had the run not already used every
	// continuation the project allows. Say so in the run's own `error`, not only in the
	// diagnosis, so the reason survives wherever the raw message is shown.
	const budgetExhausted = checkpointFallback?.kind === 'exhausted' ? checkpointFallback : undefined;
	const terminalError = budgetExhausted
		? `${error} — checkpoint continuation budget exhausted (${budgetExhausted.spent} of ${budgetExhausted.max} used)`
		: error;
	logger.error(`Phase failed - ${phaseLabel(trigger.phase)}`, {
		projectId: project.id,
		phase: trigger.phase,
		taskId: trigger.taskId,
		error: terminalError,
	});
	const planningScope = await tryLoadPlanningScope(project.id, trigger.taskId, failureKind);
	const failureDiagnosis = diagnoseFailure({
		failureKind,
		agent: err instanceof AgentRunError ? err.agent : undefined,
		planningScope,
		knownCondition: budgetExhausted
			? 'continuation-budget-exhausted'
			: knownFailureCondition(failureKind, error),
	});
	// Report the terminal failure on the backing Issue or PR so a human sees why
	// the item stalled. Reached only for non-deferrable failures (the deferral
	// above returns early), so a run that's about to be retried never posts a
	// premature "failed".
	await reportPhaseFailureToBoardOrPr(trigger, project, terminalError, failureDiagnosis);
	// The review handler's claim intentionally survives a failed run: the review
	// agent submits its formal `gh pr review` *inside* the run, so a phase that
	// threw afterward may have already posted the review — releasing the claim
	// here would let a sibling event for the same PR+SHA post a duplicate, the
	// exact incident the dedup guards against. The 5-minute TTL reaps a claim
	// whose run genuinely failed before submitting. See review-dispatch-dedup.ts.
	return {
		status: 'phase-failed',
		phase: trigger.phase,
		taskId: trigger.taskId,
		error: terminalError,
		failureDiagnosis,
	};
}

/**
 * Run the federated eligibility gate for this dispatch (issue #339) and return
 * the selected target, or `undefined` when the project is not federated (no
 * enrolled workers — the local worker runs it, exactly as before).
 *
 * Local single-user mode (issue #373) short-circuits to that same `undefined`
 * result *before* the roster or assignee link is read: an install running in
 * single-user mode treats the host process as the implicit local executor for
 * every project, so dispatch never consults enrollment, sharing consent,
 * assignee affinity, live sessions, or worker capacity — even when worker and
 * enrollment rows exist — and runs on the host worker exactly as an unfederated
 * project does (local target selection, the project slot, a null worker
 * identity). Disabling the mode restores the complete federated policy below.
 *
 * Throws {@link WorkerIneligibleError} when no eligible worker may take the
 * phase: `handlePhaseFailure` turns that into a bounded, token-free
 * `worker-eligibility` deferral, and finally into an actionable board comment.
 * A failure to *read* the roster defers the same way rather than dispatching
 * unchecked — sharing consent is a hard prerequisite (ADR-001), so an unknown
 * answer must never be treated as permission.
 */
async function gateDispatch(
	project: ProjectConfig,
	trigger: TriggerResult,
	job: SwarmJob,
	implementationUnplanned: boolean,
	gateOptions?: DispatchGateOptions,
): Promise<DispatchSelection | undefined> {
	// Single-user mode routes every phase through the implicit local host worker
	// (issue #373): skip the federated roster/assignee evaluation entirely and
	// take the same no-selection local path an unfederated project uses. This runs
	// before `listProjectDispatchCandidates` or the assignee-provider construction
	// so no enrollment, consent, or affinity is ever read in this mode.
	if (isSingleUserMode()) return undefined;
	const phaseConfig = phaseAgentConfig(project, trigger.phase, implementationUnplanned);
	// PR-driven phases carry no board item, so they take the unassigned path.
	const workItem = 'workItem' in trigger ? trigger.workItem : undefined;
	let decision: GateDecision;
	try {
		decision = await evaluateDispatchEligibility(
			{
				projectId: project.id,
				targets: resolveTargetPolicy(phaseConfig, job).targets,
				phaseDefaultCli: PHASE_DEFAULT_CLI[trigger.phase],
				// Gates on the worker's declared phase repertoire too, so a phase a
				// candidate's daemon cannot run never selects it (issue #467).
				phase: trigger.phase,
				workItem,
				// Only an item that actually names an assignee needs the provider (for
				// its `type`, to resolve the identity link) — an unassigned item takes
				// the unassigned path without one being constructed.
				pm: workItem?.assignees.length ? requireProjectPMProvider(project) : undefined,
			},
			gateOptions,
		);
	} catch (err) {
		throw new WorkerIneligibleError(
			'worker-unavailable',
			`Could not read this project's worker roster to confirm dispatch eligibility: ${describeError(err)}`,
		);
	}
	if (decision.status === 'unfederated') return undefined;
	if (decision.status === 'ineligible') {
		throw new WorkerIneligibleError(decision.reason, decision.message);
	}
	const { selection } = decision;
	logger.info('Routed the phase to an eligible worker', {
		projectId: project.id,
		phase: trigger.phase,
		taskId: trigger.taskId,
		workerId: selection.workerId,
		worker: selection.workerName,
		assignedUserId: selection.assignedUserId,
		cli: selection.cli,
		model: selection.target.model,
		targetIndex: selection.targetIndex,
		unavailable: selection.skippedClis,
	});
	return selection;
}

/**
 * Convert the gate's read-side selection into a fenced, atomic execution claim.
 * The claim re-checks the session, enrollment, consent, CLI, and capacity under
 * one worker-session row lock, closing the observation-to-execution race.
 */
async function bindSelectedWorker(
	dispatch: DispatchRow,
	selection: DispatchSelection,
	executionIdentity: WorkerExecutionIdentity | undefined,
): Promise<void> {
	if (!executionIdentity) {
		throw new WorkerIneligibleError(
			selection.assignedUserId ? 'assignee-worker-unavailable' : 'worker-unavailable',
			`Worker '${selection.workerName}' was selected, but this process has no authenticated SWARM_WORKER_CREDENTIAL and may not execute that worker's dispatch. Waiting for the selected worker host.`,
		);
	}
	const claim = await claimWorkerForDispatch({
		dispatchId: dispatch.id,
		dispatchLeaseOwner: DISPATCH_LEASE_OWNER,
		projectId: dispatch.projectId,
		selectedWorkerId: selection.workerId,
		executionWorkerId: executionIdentity.workerId,
		workerSessionId: executionIdentity.sessionId,
		workerFencingToken: executionIdentity.fencingToken,
		cli: selection.cli,
		heartbeatTtlMs: executionIdentity.heartbeatTtlMs,
	});
	if (claim.claimed) return;

	const assignedUnavailable = selection.assignedUserId
		? 'assignee-worker-unavailable'
		: 'worker-unavailable';
	switch (claim.reason) {
		case 'wrong-worker-host':
			throw new WorkerIneligibleError(
				assignedUnavailable,
				`Worker '${selection.workerName}' was selected, but this queue job was claimed by a different authenticated worker host. Waiting for the selected worker host; cross-worker execution is forbidden.`,
			);
		case 'worker-unavailable':
			throw new WorkerIneligibleError(
				assignedUnavailable,
				`Worker '${selection.workerName}' lost its live session or available capacity before execution could be claimed. Waiting and re-checking eligibility.`,
			);
		case 'project-capacity':
			throw new WorkerIneligibleError(
				'worker-unavailable',
				`Project '${dispatch.projectId}' reached its configured concurrent-job limit before worker execution could be claimed. Waiting for an active dispatch to settle.`,
			);
		case 'missing-enrollment':
		case 'missing-consent':
		case 'missing-cli-capability':
			throw new WorkerIneligibleError(
				claim.reason,
				`Worker '${selection.workerName}' became ineligible (${claim.reason}) before execution could be claimed. Re-checking the project worker roster before retry.`,
			);
		case 'not-claimable':
			throw new WorkerIneligibleError(
				assignedUnavailable,
				'The durable dispatch changed state before its selected-worker claim could be persisted. Re-checking before retry.',
			);
	}
}

export async function processJob(
	job: SwarmJob,
	registry: TriggerRegistry,
	signal?: AbortSignal,
	executionIdentity?: WorkerExecutionIdentity,
	deps: ProcessJobDeps = {},
): Promise<JobOutcome> {
	// Claim the durable dispatch behind this wake-up before acting on anything
	// (issue #284): a cancelled/completed/superseded dispatch refuses the claim,
	// so no delivery path — redelivery, delayed retry, slot release,
	// reconciliation — can resurrect terminal work. Legacy dispatch-less jobs
	// are adopted into the model here.
	const claim = await claimDispatchForJob(job, DISPATCH_CLAIM_LEASE_MS);
	if (!claim.claimed) {
		logger.info('Dispatch wake-up refused — dropping delivery', {
			projectId: job.projectId,
			dispatchId: job.dispatchId,
			reason: claim.reason,
		});
		return { status: 'dispatch-refused', reason: claim.reason };
	}
	const dispatch = claim.dispatch;
	try {
		// The dispatch row's stored payload is authoritative — a manual retry's
		// overrides land there, not on the wake-up job.
		job = parseDispatchPayload(dispatch);
	} catch (err) {
		const error = `Dispatch payload failed validation: ${describeError(err)}`;
		await tryFailDispatch(dispatch.id, error);
		logger.error('Dispatch payload failed validation — failing dispatch', {
			dispatchId: dispatch.id,
			error,
		});
		return { status: 'dispatch-refused', reason: 'invalid-payload' };
	}

	const project = await findProjectByIdFromDb(job.projectId);
	if (!project) {
		// The producer only enqueues for projects it resolved from Postgres, so a
		// miss here means the project was deleted mid-flight — fail loudly.
		await tryFailDispatch(dispatch.id, `Job references unknown project '${job.projectId}'`);
		throw new Error(`Job references unknown project '${job.projectId}'`);
	}

	// The agent-less dispatch kind (issue #292): a merge-automation dispatch
	// carries no webhook event, resolves no trigger, provisions no worktree, and
	// takes no project slot — it settles itself (complete / fail / bounded
	// retry-scheduled) against the claimed dispatch record.
	if (job.type === 'merge-automation') {
		return processMergeAutomationDispatch(dispatch, job, project);
	}

	const ctx = buildTriggerContext(job, project);

	const trigger = await registry.dispatch(ctx);
	if (!trigger) {
		logger.debug('Job matched no trigger — completing as a no-op', {
			projectId: project.id,
			source: ctx.source,
			event: ctx.source === 'scm' ? ctx.event.kind : ctx.event.action,
			deliveryId: job.deliveryId,
		});
		if (job.runId) {
			await finalizeRun(job.runId, {
				status: 'failed',
				error:
					'The pending continuation re-evaluated to no-trigger (e.g. disposition changed or was disabled)',
			});
			if (job.type === 'scm' && job.event.workItemId && job.event.headSha) {
				const dispatchKey = buildReviewDispatchKey(
					project.repo,
					job.event.workItemId,
					job.event.headSha,
				);
				await releaseReviewDispatch(dispatchKey);
			}
		}
		await tryCompleteDispatch(dispatch.id, 'no-trigger');
		return { status: 'no-trigger' };
	}

	// Record the resolved task/phase on the dispatch so the Queue UI can name
	// what a waiting dispatch will run, even before a run row exists.
	try {
		await recordDispatchResolution(dispatch.id, trigger.taskId, trigger.phase);
	} catch (err) {
		logger.debug('Failed to record dispatch resolution (continuing)', {
			dispatchId: dispatch.id,
			error: describeError(err),
		});
	}

	// Explicit automation opt-in (issues #131 and #354): the work item behind a
	// dispatch must carry the project's configured automation label before SWARM
	// starts an agent phase for it. Checked here, at the composition root, on *every*
	// dispatch — a fresh webhook, a delayed retry, a self-enqueued next phase, a
	// capacity promotion, a reconciler republish, a manual "Retry now" — so removing
	// the label stops all later dispatches (it never terminates a run already in
	// flight). It runs before the in-flight guard and `acquireProjectSlot`, so a skip
	// costs no slot, no worktree, and no tokens. This is also where #339's
	// worker-eligibility check belongs: a dispatch is eligible only when the worker is
	// authorized *and* the item is opted in. Every phase is gated: the board-driven
	// ones carry their work item on the trigger, and the four SCM continuation phases
	// resolve theirs from the pull request ({@link resolveGatedWorkItem}).
	const automationLabel = resolveAutomationLabel(project.pipeline);
	// Resolved only when the gate is on, so a project that opted out
	// (`automationLabel: ""`) pays no board read on an SCM dispatch.
	const gatedItem = automationLabel ? await resolveGatedWorkItem(project, trigger) : undefined;
	if (automationLabel && gatedItem && !hasAutomationLabel(gatedItem, automationLabel)) {
		const reason = missingAutomationLabelMessage(automationLabel);
		logger.info('Phase skipped — work item is missing the automation label', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			workItemId: gatedItem.id,
			label: automationLabel,
		});
		// A deferred run being retried after the label was pulled must not sit in
		// `deferred` forever — finalize it with the same honest reason, exactly as
		// the `no-trigger` branch above does.
		if (job.runId) {
			await finalizeRun(job.runId, { status: 'failed', error: reason });
		}
		// Hand back every handler-side claim this dispatch took before the gate. A
		// skipped phase consumes nothing, so a later correctly labelled attempt must
		// not be treated as a duplicate, remain blocked by a ledger reservation, or
		// spend a CI-fix attempt.
		if (trigger.phase === 'review' || trigger.phase === 'respond-to-ci') {
			await releaseReviewDispatch(
				buildReviewDispatchKey(project.repo, trigger.prNumber, trigger.headSha),
			);
		}
		if (trigger.phase === 'review') {
			try {
				await abandonReviewVerdict({
					projectId: project.id,
					repository: project.repo,
					prNumber: trigger.prNumber,
					headSha: trigger.headSha,
				});
			} catch (error) {
				logger.warn('Could not abandon skipped Review verdict reservation', {
					projectId: project.id,
					prNumber: trigger.prNumber,
					headSha: trigger.headSha,
					error: describeError(error),
				});
			}
		}
		if (trigger.phase === 'resolve-conflicts') {
			await releaseConflictResolution(
				buildConflictResolutionKey(
					project.repo,
					trigger.prNumber,
					trigger.headSha,
					trigger.baseSha,
				),
			);
		}
		if (trigger.phase === 'respond-to-ci') {
			await releaseRespondToCiAttempt(buildRespondToCiAttemptKey(project.repo, trigger.prNumber));
		}
		await tryCompleteDispatch(dispatch.id, 'skipped-not-eligible');
		return {
			status: 'skipped-not-eligible',
			phase: trigger.phase,
			taskId: trigger.taskId,
			reason,
		};
	}

	// A duplicate webhook (or a delayed retry) that resolved to a phase whose
	// worktree task is already running here would collide on `task-<id>`; skip it
	// rather than dispatch into that collision. See `inFlightTaskIds`.
	if (inFlightTaskIds.has(trigger.taskId)) {
		logger.debug('Skipping phase — its worktree task is already running in this worker', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
		});
		await tryCompleteDispatch(dispatch.id, 'skipped-duplicate');
		return { status: 'skipped-in-flight', phase: trigger.phase, taskId: trigger.taskId };
	}
	inFlightTaskIds.add(trigger.taskId);
	let slot: SlotAcquisition = { acquired: true, tracked: false };

	let runId: string | undefined;
	// A deferred outcome hands the run to `reenqueueDeferred`, which relies on
	// this durable marker to prevent a termination racing that queue hand-off
	// from resurrecting the run. Terminal outcomes consume the marker here.
	let preserveCancellationMarker = false;
	// Per-run abort signal, linked to the worker's shutdown signal (see
	// {@link linkRunAbortController}): the run is aborted by the worker's own
	// shutdown *or* a user-initiated dashboard termination (issue #166).
	const { controller: runAbort, detach } = linkRunAbortController(signal);
	try {
		// The global per-CLI default models (DB-backed app settings) — the fallback
		// tier between the project's own defaults and the coded defaults. Loaded once
		// per job, best-effort: a DB hiccup falls through to the coded defaults rather
		// than failing the run.
		const globalDefaults = await loadGlobalDefaults();
		// The CLIs this worker can actually run, for capability-aware target routing
		// (issue #346). Loaded once per job for the same reason, and equally
		// best-effort: an unknown answer routes to the phase's preferred target.
		const availableClis = await loadAvailableClis();
		const implementationUnplanned =
			trigger.phase === 'implementation' &&
			!(await wasPrecededByPlanning(project.id, trigger.taskId));

		// The federated dispatch gate (issue #339): confirm an eligible worker may
		// take this phase — and on which configured target — *before* anything is
		// provisioned or invoked. Runs on every (re)dispatch, so a revocation between
		// attempts blocks the next one; it never touches a run already in flight.
		const selection = await gateDispatch(
			project,
			trigger,
			job,
			implementationUnplanned,
			deps.gateOptions,
		);
		// Control-plane transport dispatch has no local executor (issue #407): an
		// unfederated/single-user project resolves no selection and has nowhere to
		// run, so defer durably rather than falling through to the host's local path.
		// The throw lands in the catch below as a token-free `worker-eligibility`
		// wait — the durable dispatch stays pending exactly as the no-eligible-worker
		// path does — and re-checks until a worker enrolls and connects.
		if (!selection && deps.federatedOnly) {
			throw new WorkerIneligibleError(
				'worker-unavailable',
				`No eligible, connected worker is enrolled for project '${project.id}'. Control-plane dispatch requires one; waiting for a worker to enroll and connect.`,
			);
		}
		// Bind on the selected worker's identity: the host's own for the in-process
		// path, or the selected worker's live session for the control-plane transport
		// path, which claims the fenced execution slot on that worker's behalf.
		const bindIdentity =
			selection && deps.resolveBindIdentity
				? await deps.resolveBindIdentity(selection)
				: executionIdentity;
		const resolution: PhaseResolution = {
			globalDefaults,
			availableClis,
			selection,
			executionIdentity: selection ? bindIdentity : undefined,
		};
		if (selection) await bindSelectedWorker(dispatch, selection, bindIdentity);
		if (!selection) {
			slot = await acquireProjectSlot(project.id, project.maxConcurrentJobs);
			if (!slot.acquired) return handleConcurrencyDeferral(dispatch, job, trigger, project);
		}

		// Record a run-history row for this agent-CLI invocation. Everything here is
		// best-effort (own try/catch inside the helpers, logged not thrown): the
		// dashboard is a secondary view, so a DB hiccup must never fail a real run.
		runId = await tryCreateRun(project, resolution, trigger, job, implementationUnplanned);

		// The dispatch is now `running` against its run row; renew the lease to
		// cover this phase's own wall-clock timeout so a live run is never
		// reclaimed, while a dead one is reclaimed soon after the timeout passes.
		const effectiveTimeoutMs =
			agentOverrideFor(project, resolution, trigger.phase, job, implementationUnplanned)
				.timeoutMs ?? AGENT_TIMEOUT_MS;
		await markDispatchRunning(
			dispatch.id,
			runId,
			new Date(Date.now() + effectiveTimeoutMs + DISPATCH_LEASE_MARGIN_MS),
			trigger.taskId,
			trigger.phase,
		);

		// Make this run cancellable by id and honour a cancellation that already
		// landed (a deferred run terminated as its retry was dequeued).
		await beginRunCancellationTracking(runId, runAbort);

		// Run the resolved phase: in-process (the default {@link runPhase}) or, when
		// the caller injects one, the control-plane transport executor that pushes a
		// `TaskAssignment` to the selected worker and awaits its result (issue #407).
		// Everything around this call — run-row lifecycle, dispatch settle, self-
		// enqueue, merge automation, cancellation — is shared across both paths.
		const result = deps.executePhase
			? await deps.executePhase({
					trigger,
					project,
					resolution,
					job,
					runId,
					signal: runAbort.signal,
					implementationUnplanned,
					dispatch,
				})
			: await runPhase(
					trigger,
					project,
					resolution,
					job,
					runId,
					runAbort.signal,
					implementationUnplanned,
				);
		// A run the harness killed for exceeding its wall-clock timeout is a terminal
		// failure, even in the rare case the agent trapped SIGTERM and still exited 0
		// before SIGKILL (so the phase read a stale/partial hand-off and "succeeded").
		// Re-route it through the failure path so the row finalizes `failed` with
		// `timedOut: true` rather than a contradictory `completed` (issue #165).
		if (result.agent.timedOut) {
			throw agentRunError(
				result.agent,
				`${phaseLabel(trigger.phase)} agent exceeded its wall-clock timeout`,
				` for task '${trigger.taskId}'`,
			);
		}
		// The phase itself logs the scannable `Phase finished - <label>` line (it
		// carries the run's result — PR URL, verdict, …); this is just the
		// orchestration-level echo, kept at debug so success shows one finish line.
		logger.debug('Job phase completed', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
		});
		await finalizeRun(
			runId,
			{
				status: 'completed',
				engine: result.agent.cli,
				exitCode: result.agent.exitCode,
				timedOut: result.agent.timedOut,
				durationMs: result.agent.durationMs,
				usage: result.agent.usage,
				// Only a Review run carries a verdict; every other phase leaves it
				// undefined, so the column is written only for reviews (issue #218).
				reviewVerdict: result.verdict,
				// Same: only a Review run carries a safety-cap slot/automation outcome
				// (issue #235).
				reviewOrdinal: result.reviewOrdinal,
				reviewAutomationOutcome: result.automationOutcome,
				// Only a PR-producing phase (Implementation) reports one; every other
				// phase leaves the attribution column untouched (ADR-004 §4, issue #398).
				producedPrUrl: result.prUrl,
				planningScope: result.planningScope,
			},
			result.agent,
		);
		await tryCompleteDispatch(dispatch.id, 'phase-succeeded');
		if (trigger.phase === 'planning' || trigger.phase === 'implementation') {
			await selfEnqueueNextPhase(project, trigger.workItem, result.movedTo);
		}
		// Ordering matters: this must run *after* `tryCompleteDispatch` above. The
		// merge dispatch it persists is linked to this same `runId`, and the
		// partial unique `uq_dispatches_active_run` index (issue #284) allows only
		// one non-terminal dispatch per run — creating it while the Review dispatch
		// is still active would raise a unique violation that `requestMergeAutomation`
		// only swallows, silently dropping the merge. Completing the Review dispatch
		// first drops it out of that partial index, so the insert is safe.
		await requestMergeAutomationIfEligible(trigger, project, runId, result.verdict);
		return {
			status: 'phase-succeeded',
			phase: trigger.phase,
			taskId: trigger.taskId,
			exitCode: result.agent.exitCode,
			signal: result.agent.signal,
			timedOut: result.agent.timedOut,
			durationMs: result.agent.durationMs,
		};
	} catch (err) {
		const outcome = await handlePhaseFailure(err, job, trigger, project, runId, deps);
		preserveCancellationMarker = outcome.status === 'phase-deferred';
		// Reconcile the terminated run's checkout before the `finally` clears
		// cancellation tracking and releases the project slot.
		await finalizeFailedRun(runId, outcome, err, { project, taskId: trigger.taskId });
		// Settle the durable dispatch to match: a deferral persists its derived
		// retry intent *before* any wake-up is queued (crash-safe — issue #284); a
		// user termination cancels rather than fails, so nothing resurrects it.
		// All swallowed on error: a bookkeeping failure must never rethrow into a
		// BullMQ retry that would re-run a non-idempotent agent — a dispatch left
		// `leased`/`running` is reclaimed by the reconciler's lease sweep instead.
		try {
			if (outcome.status === 'phase-deferred') {
				await settleDispatchRetry(dispatch, job, outcome);
			} else if (outcome.status === 'phase-failed') {
				if (outcome.cancelled) {
					await cancelClaimedDispatch(dispatch.id, RUN_CANCELLED_MESSAGE);
				} else {
					await failDispatch(dispatch.id, outcome.error);
				}
			}
		} catch (settleErr) {
			logger.error('Failed to settle dispatch after phase failure (lease sweep will repair)', {
				dispatchId: dispatch.id,
				error: describeError(settleErr),
			});
		}
		return outcome;
	} finally {
		// Detach the shutdown listener and drop this run from the cancellation
		// registry now that it has settled. A deferred outcome deliberately keeps
		// its marker until `reenqueueDeferred` observes it: a dashboard termination
		// can land after `deferred` is persisted but before the retry is queued.
		// Terminal outcomes clear it so a stale request cannot terminate a later
		// re-run that reuses this run id.
		detach();
		if (runId) {
			unregisterRunController(runId);
			if (!preserveCancellationMarker) await clearRunCancellation(runId);
		}
		// Release the slot once the run settles (success, failure, or deferral) so
		// a later legitimate dispatch for the same task — a genuine retry, or a
		// re-run after this one finished — isn't blocked. A deferred job is
		// re-enqueued and re-enters `processJob` fresh, past this release.
		if (slot.acquired && slot.tracked) {
			await releaseProjectSlot(project.id);
			// A slot just freed — wake the next capacity-blocked dispatch for this
			// project (issues #214/#219, #284) so SCM work blocked only by concurrency
			// runs ahead of new board work. No-op when nothing is pending or the
			// policy is off; never reserves a slot.
			await promoteNextCapacityDispatch(
				project.id,
				project.pipeline?.prioritizeContinuations !== false,
			);
		}
		inFlightTaskIds.delete(trigger.taskId);
	}
}
