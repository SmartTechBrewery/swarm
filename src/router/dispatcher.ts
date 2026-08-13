/**
 * Control-plane dispatcher (issue #407, ADR-003 §2 — the final split-delivery
 * phase). It hosts the BullMQ consumer + the ADR-001 eligibility gate **on the
 * router** and, on selecting a connected, eligible worker, composes the phase's
 * system prompt + target branch server-side, builds a `TaskAssignment`
 * (`../transport/assignment.ts`), and pushes it (`./worker-connections.ts`) to
 * that worker — which runs the phase (`../transport/assignment-execution.ts`) and
 * reports a `TaskExecutionResult` back over its socket for the dispatcher to
 * settle on.
 *
 * The whole dispatch/settle machine is **reused verbatim** from `processJob`
 * (`../worker/consumer.ts`): claim → trigger → automation gate → eligibility gate
 * → fenced worker bind → run-row lifecycle → durable dispatch settle → next-phase
 * self-enqueue → merge automation → cancellation. This module only supplies the
 * two collaborators (`ProcessJobDeps`) that diverge from the in-process path:
 *
 * 1. **`resolveBindIdentity`** — the control plane binds the fenced execution
 *    claim on the *selected* worker's live session (it acts on the worker's
 *    behalf), not on a host credential of its own.
 * 2. **`executePhase`** — instead of running the phase in-process, it pushes a
 *    `TaskAssignment` and awaits the worker's terminal result, adapting it back to
 *    a `PhaseRunResult` (or throwing so the shared failure path defers/fails it).
 *
 * Plus the transport-connectivity `gateOptions` (only socket-connected workers
 * are selectable) and `federatedOnly` (no local executor here, so an unfederated
 * project defers durably rather than running on the router). With no
 * eligible/connected worker the durable dispatch stays `pending` in Postgres via
 * the existing `WorkerIneligibleError` token-free deferral — exactly as the
 * in-process federated path already behaves.
 *
 * **Single-user installs dispatch over this path too** (issue #552). The gate no
 * longer bypasses itself when `SWARM_SINGLE_USER_MODE` is set, so a single-user
 * deployment registers and enrolls its one local worker like any other and is
 * routed to it here, instead of the mode's former bypass resolving no selection
 * and leaving every dispatch durably pending.
 *
 * Cancellation crosses the same transport (issue #549): this consumer subscribes
 * to run cancellations and pushes a `task-cancel` to the worker executing the run
 * (`./dispatch-cancellation.ts`), which aborts its agent and reports `cancelled`
 * for {@link adaptResultToPhaseRun} to raise as a `RunTerminatedError`.
 */

import { Worker } from 'bullmq';
import { listAllProjectsFromDb } from '../db/repositories/projectsRepository.js';
import { failStaleRunningRuns, updateRunJobPayload } from '../db/repositories/runsRepository.js';
import { resolveBoardItemIdForPrBranch } from '../dispatch/board-card.js';
import { cancelDispatchAndWake } from '../dispatch/dispatcher.js';
import {
	reconcileDispatchesAtStartup,
	reconcileDispatchesPeriodically,
} from '../dispatch/reconciler.js';
import type { AgentCliResult, ReportedAgentResult } from '../harness/agent-cli.js';
import { type AgentFailureKind, AgentRunError } from '../harness/agent-failure.js';
import {
	getLiveSessionForWorker,
	resolveHeartbeatTtlMs,
} from '../identity/worker-session-service.js';
import { optionalEnv, requireEnv } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';
import { DependencyBlockedError } from '../pipeline/dependency-guard.js';
import type { ReviewVerdict } from '../pipeline/review.js';
import type { WorkItem } from '../pm/types.js';
import {
	closeRunCancellationRedis,
	isRunCancellationRequested,
	RUN_CANCELLED_MESSAGE,
} from '../queue/cancellation.js';
import { QUEUE_NAME, recoveryIntentFromJob, type SwarmJob, SwarmJobSchema } from '../queue/jobs.js';
import { DeliveryDeferredError } from '../scm/delivery.js';
import { buildTaskAssignment, type TaskAssignmentPr } from '../transport/assignment.js';
import type { TaskExecutionResult, TaskProgress } from '../transport/protocol.js';
import { createTriggerRegistry, registerBuiltInTriggers } from '../triggers/index.js';
import type { TriggerResult } from '../triggers/types.js';
import {
	type DispatchPhaseContext,
	type JobOutcome,
	type PhaseRunResult,
	type ProcessJobDeps,
	processJob,
	reportInterruptedJobToBoard,
	resolveAgentTimeoutMs,
} from '../worker/consumer.js';
import type { DispatchSelection } from '../worker/eligibility-gate.js';
import type { WorkerExecutionIdentity } from '../worker/execution-identity.js';
import { isJobStale, resolveMaxJobAgeMs } from '../worker/job-freshness.js';
import { RunTerminatedError } from '../worker/run-cancellation.js';
import { resolveWorkerConcurrency, resolveWorkerLockOptions } from '../worker/runtime-options.js';
import { phaseAgentConfig } from '../worker/target-policy.js';
import { composeSystemPrompt, resolveTargetBranch } from './assignment-composition.js';
import { cancelRunOnWorker, subscribeDispatchCancellations } from './dispatch-cancellation.js';
import { awaitDispatchResult, type TransportInterruptions } from './dispatch-results.js';
import { isWorkerConnected, sendToWorker } from './worker-connections.js';

/**
 * How long past the phase's own wall-clock timeout the control plane waits for a
 * worker's terminal result before treating the worker as gone (the same margin
 * the dispatch lease uses in `processJob`). A worker's harness kills its agent at
 * `timeoutMs` and reports a result, so a healthy run always reports well inside
 * this window; only a crashed/dropped worker exhausts it, whereupon the wait is
 * abandoned as a `worker-shutdown`-style deferral and the dispatch is retried once
 * the worker reconnects (the durable lease reconciler is the backstop either way).
 */
const RESULT_WAIT_MARGIN_MS = 10 * 60 * 1000;

/** The default agent wall-clock timeout, resolved once (validates the env var at load). */
const DEFAULT_PHASE_TIMEOUT_MS = resolveAgentTimeoutMs();

/** Grace past the largest configured timeout before a `running` run row is judged stale. */
const STALE_RUN_MARGIN_MS = 10 * 60 * 1000;

/**
 * How often the reconciliation loop runs — reclaiming expired dispatch leases and
 * reaping stale `running` run rows left by a worker that died mid-phase. Cheap
 * (bounded UPDATEs), so it can run far more often than the hourly worktree sweep;
 * default every 5 min.
 *
 * The knob moved here with the executor it used to belong to (issue #553): it was
 * the in-process worker's own sweep cadence, and the reap is now the control
 * plane's job. The name is kept so an existing `.env` keeps working.
 */
function resolveStaleRunSweepIntervalMs(
	raw = optionalEnv('SWARM_STALE_RUN_SWEEP_INTERVAL_MS', String(5 * 60 * 1000)),
): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`SWARM_STALE_RUN_SWEEP_INTERVAL_MS must be a positive integer, got '${raw}'`);
	}
	return value;
}

/**
 * Resolve the *selected* worker's live-session identity so the control plane can
 * bind the fenced execution claim on its behalf (`claimWorkerForDispatch` requires
 * the session id + fencing token). `undefined` when the worker's lease vanished
 * between the gate reading it and this bind — a rare race the gate's connectivity
 * check makes unlikely — in which case `bindSelectedWorker` defers durably and the
 * next re-check re-evaluates the roster.
 */
async function resolveSelectedWorkerIdentity(
	selection: DispatchSelection,
): Promise<WorkerExecutionIdentity | undefined> {
	const session = await getLiveSessionForWorker(selection.workerId);
	if (!session) return undefined;
	return {
		workerId: session.workerId,
		sessionId: session.id,
		fencingToken: session.fencingToken,
		heartbeatTtlMs: resolveHeartbeatTtlMs(),
	};
}

/** The PR coordinates the assignment carries for an SCM-driven phase (none for the board phases). */
function prCoordinates(trigger: TriggerResult): TaskAssignmentPr | undefined {
	switch (trigger.phase) {
		case 'planning':
		case 'implementation':
			return undefined;
		case 'review':
			return { prNumber: trigger.prNumber, headSha: trigger.headSha };
		case 'respond-to-review':
			return {
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				headSha: trigger.headSha,
				reviewId: trigger.reviewId,
			};
		case 'respond-to-ci':
			return { prNumber: trigger.prNumber, prBranch: trigger.prBranch, headSha: trigger.headSha };
		case 'resolve-conflicts':
			return {
				prNumber: trigger.prNumber,
				prBranch: trigger.prBranch,
				headSha: trigger.headSha,
				baseBranch: trigger.baseBranch,
				baseSha: trigger.baseSha,
			};
	}
}

/** The exit metadata a worker's terminal frame reports, in stand-in form. */
interface ReportedAgentFields {
	exitCode?: number | null;
	signal?: string | null;
	durationMs?: number;
	timedOut?: boolean;
	aborted?: boolean;
}

/**
 * A minimal captured-run stand-in built from a worker's result frame (the router ran
 * no agent). A field the frame never reported stays **unset** rather than defaulting
 * to `0 ms` / `did not time out` (issue #596): the settle drops an undefined column,
 * so an older worker's metadata-less frame records "unknown" instead of a placeholder
 * that contradicts the `error` written by the same settle.
 */
function reportedAgent(
	cli: AgentCliResult['cli'],
	fields: ReportedAgentFields = {},
): ReportedAgentResult {
	return {
		cli,
		exitCode: fields.exitCode ?? null,
		signal: (fields.signal ?? null) as AgentCliResult['signal'],
		stdout: '',
		stderr: '',
		durationMs: fields.durationMs,
		timedOut: fields.timedOut,
		aborted: fields.aborted ?? false,
		outputTruncated: false,
	};
}

/**
 * The same stand-in, completed for the succeeded path — whose frame always reports
 * both fields, and whose `PhaseRunResult.agent` is a full {@link AgentCliResult}.
 */
function capturedAgent(cli: AgentCliResult['cli'], fields: ReportedAgentFields): AgentCliResult {
	const agent = reportedAgent(cli, fields);
	return { ...agent, durationMs: agent.durationMs ?? 0, timedOut: agent.timedOut ?? false };
}

/**
 * Narrow a worker's reported Review verdict to the two SWARM still produces.
 *
 * The completion frame's enum (`src/transport/protocol.ts`) deliberately still
 * accepts `comment` so that an older worker's whole frame isn't rejected over one
 * optional telemetry field — but the verdict is what gates merge automation, and
 * `comment` never gated it, so dropping it here changes no behaviour while
 * keeping the removed verdict out of the run record (issue #470). An old worker
 * can no longer *submit* one either: the delivery route rejects it explicitly
 * (`src/router/worker-delivery.ts`).
 */
function reportedVerdict(verdict: TaskExecutionResult['verdict']): ReviewVerdict | undefined {
	if (verdict === undefined) return undefined;
	if (verdict === 'comment') {
		logger.warn('dispatcher: worker reported the removed comment verdict — recording none', {
			verdict,
		});
		return undefined;
	}
	return verdict;
}

/**
 * Adapt a worker's terminal `TaskExecutionResult` back into the shape
 * `processJob`'s shared settle path consumes: a `PhaseRunResult` for a success, or
 * a throw that the shared `handlePhaseFailure` classifies exactly as an in-process
 * failure would — `RunTerminatedError` for a user cancellation, `DependencyBlockedError`,
 * `DeliveryDeferredError` or an `AgentRunError` (with the reported failure kind) for a
 * deferral, and an `AgentRunError` carrying the reported exit metadata otherwise. The
 * synthetic agent result carries what the frame *reported* rather than a stand-in
 * default (issue #596), so the run row records the same stop its `error` describes and
 * a frame that reported nothing records "unknown"; its non-zero exit keeps a
 * genuinely-interrupted `timeout` deferrable, matching the in-process rule.
 */
export function adaptResultToPhaseRun(
	result: TaskExecutionResult,
	selection: DispatchSelection,
	/** The dispatched board item, for rebuilding a reported dependency block (issue #438). */
	workItem?: WorkItem,
): PhaseRunResult {
	if (result.status === 'succeeded') {
		return {
			agent: capturedAgent(selection.cli, {
				exitCode: result.exitCode ?? 0,
				signal: result.signal,
				durationMs: result.durationMs,
				timedOut: result.timedOut ?? false,
			}),
			movedTo: result.movedTo,
			verdict: reportedVerdict(result.verdict),
			reviewOrdinal: result.reviewOrdinal,
			automationOutcome: result.reviewAutomationOutcome,
			// Feeds the shared settle path's attribution write (issue #398); absent
			// from a phase that produced no PR, and from an older worker's frame.
			prUrl: result.prUrl,
		};
	}
	if (result.status === 'failed') {
		if (result.cancelled) throw new RunTerminatedError(result.error || RUN_CANCELLED_MESSAGE);
		// An `AgentRunError` rather than a plain `Error` purely so the reported exit
		// metadata reaches the run row: `finalizeFailedRun` (`../worker/consumer.ts`)
		// records the columns only from `AgentRunError.agent`, and a plain throw is why
		// a terminally-failed federated run recorded nothing at all (issue #596).
		//
		// `kind: 'error'` is deliberate, and is *not* the frame's own `failureKind`: the
		// worker already applied the terminal/deferrable split (`classifyDeferrable`,
		// `../transport/assignment-execution.ts`), so re-deriving a kind here would
		// re-enter the shared deferral rule and retry a run the worker settled for good.
		// `'error'` is inert in every branch that reads a kind — `isDeferrable` excludes
		// it, `tryLoadPlanningScope` only acts on `stalled`, `diagnoseFailure` returns
		// `undefined` for it, and `knownFailureCondition('error', msg)` falls through to
		// the same message check a plain `Error` gets today.
		throw new AgentRunError(
			result.error || result.reason || 'Phase failed on the worker',
			{ kind: 'error' },
			reportedAgent(selection.cli, {
				exitCode: result.exitCode,
				signal: result.signal,
				timedOut: result.timedOut,
				durationMs: result.durationMs,
			}),
		);
	}
	// deferred: rebuild the classified failure so the shared deferral path applies
	// its budget and retry-delay policy exactly as it does for an in-process failure.
	//
	// A dependency block (issue #438): rebuild the error the in-process gate throws so
	// the shared path applies the same bounded, token-free recheck budget and posts the
	// same "must be done first" message once it is exhausted. Both the item and a
	// non-empty blocker list are needed for that message and the deferral log line to
	// name the prerequisites, so a frame missing either stays terminal — today's
	// behaviour — rather than deferring with a message that names nothing. Only
	// Implementation gates on dependencies and its trigger always carries the work item
	// (`../triggers/types.ts`), so that is a wiring bug, never a real case.
	if (result.failureKind === 'dependency') {
		if (workItem && result.blockers?.length) {
			throw new DependencyBlockedError(workItem, result.blockers);
		}
		throw new Error(result.reason ?? 'Phase blocked on an unfinished prerequisite');
	}
	if (result.failureKind === 'delivery') {
		throw new DeliveryDeferredError(result.reason ?? 'Delivery deferred on the worker');
	}
	const kind = (result.failureKind ?? 'rate-limit') as AgentFailureKind;
	throw new AgentRunError(
		result.reason ?? `Phase deferred (${kind}) on the worker`,
		{ kind },
		// The frame's own reported metadata, not a `?? 1 / 0 ms / false` stand-in
		// (issue #596). A frame that reports no exit code leaves `exitCode: null`, which
		// still satisfies the shared "genuinely interrupted" timeout rule
		// (`handlePhaseFailure` requires `exitCode !== 0`, `../worker/consumer.ts`), so an
		// older worker's timeout deferral behaves exactly as before while its run records
		// "unknown" instead of "exit 1, 0 ms, did not time out".
		reportedAgent(selection.cli, {
			exitCode: result.exitCode,
			signal: result.signal,
			timedOut: result.timedOut,
			durationMs: result.durationMs,
			aborted: kind === 'aborted',
		}),
		// The Tier 2 checkpoint the worker read off its own disk (issue #503). Carried on
		// the rebuilt error so the shared deferral path applies the identical continuation
		// policy and budget it applies in-process — the control plane cannot read that
		// worktree itself, and this is the only channel that reaches `deferAgentRunError`.
		result.checkpoint,
	);
}

/**
 * How a result-wait timeout is attributed (issue #723). With no interruption
 * recorded, "the worker never reported" is the honest reading and keeps today's
 * wording. With one, it is not: the phase may well have finished and its result
 * been dropped with the dead socket, so the failure names the drop and points at
 * the one line on the worker that settles which it was.
 */
function resultWaitTimeoutReason(
	selection: DispatchSelection,
	interruptions: TransportInterruptions,
): string {
	if (interruptions.count === 0) {
		return `Worker '${selection.workerName}' did not report a result within the lease window`;
	}
	return (
		`Worker '${selection.workerName}' lost its transport session ${interruptions.count}× during ` +
		'this phase and never delivered a result — the phase may have completed there ' +
		"(check the worker log for 'assignment phase finished — sending result')"
	);
}

/**
 * Await the worker's terminal result, but give up if the control plane is
 * shutting down (`signal`) or the worker never reports within the lease window —
 * both surface as an `aborted` `AgentRunError` so the shared path defers the
 * dispatch for a bounded retry rather than hanging the BullMQ job forever.
 *
 * Exported for its message alone (issue #723): what a timeout *says* is the whole
 * point of the branch, and asserting it through a live BullMQ consumer would cost
 * far more than it proves.
 */
export function awaitResultWithGuards(
	result: Promise<TaskExecutionResult>,
	signal: AbortSignal,
	selection: DispatchSelection,
	waitMs: number,
	dispatchId: string,
	/** What this router saw happen to the worker's transport while it was awaiting this dispatch. */
	interruptions: () => TransportInterruptions,
): Promise<TaskExecutionResult> {
	return new Promise<TaskExecutionResult>((resolve, reject) => {
		const abort = (reason: string): void => {
			cleanup();
			reject(
				new AgentRunError(
					reason,
					{ kind: 'aborted' },
					reportedAgent(selection.cli, { aborted: true }),
				),
			);
		};
		const timer = setTimeout(() => {
			// Logged where it happens, not inferred later from the settle time: this is
			// the branch that turns "the worker never reported" into a phase failure, and
			// it looks identical in the run row to a phase that genuinely failed. The
			// pair to look for is this line with no matching "assignment phase finished —
			// sending result" on the worker (`src/transport/assignment-execution.ts`), and
			// the interruption count is what says whether that pair is even worth checking
			// — a dropped session is the reading under which the worker did report.
			const interrupted = interruptions();
			logger.warn('dispatch back-channel: no result within the lease window — failing', {
				dispatchId,
				workerId: selection.workerId,
				worker: selection.workerName,
				waitMs,
				interruptions: interrupted.count,
				lastInterruptedAt: interrupted.lastAt?.toISOString(),
			});
			abort(resultWaitTimeoutReason(selection, interrupted));
		}, waitMs);
		const onAbort = (): void => abort('Control plane is shutting down');
		const cleanup = (): void => {
			clearTimeout(timer);
			signal.removeEventListener('abort', onAbort);
		};
		if (signal.aborted) return onAbort();
		signal.addEventListener('abort', onAbort);
		result.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(err) => {
				cleanup();
				reject(err);
			},
		);
	});
}

/** Persist the Implementation branch checkpoint on the run row so a re-push can resume it (best-effort). */
async function persistBranchProvisioned(
	runId: string | undefined,
	job: SwarmJob,
	taskId: string,
): Promise<void> {
	if (!runId) return;
	try {
		await updateRunJobPayload(runId, { ...job, implementationBranchProvisioned: true });
	} catch (err) {
		logger.error('Failed to persist Implementation branch checkpoint (control plane)', {
			runId,
			taskId,
			error: describeError(err),
		});
	}
}

/**
 * The control-plane `executePhase`: compose the assignment server-side, push it to
 * the selected worker, and await the worker's terminal result. Everything around
 * this — run-row lifecycle, dispatch settle, self-enqueue, merge automation — is
 * `processJob`'s shared logic; this only performs the push/await and adapts the
 * result.
 */
async function pushAndAwaitResult(context: DispatchPhaseContext): Promise<PhaseRunResult> {
	const { trigger, project, resolution, job, runId, signal, implementationUnplanned, dispatch } =
		context;
	const selection = resolution.selection;
	// `federatedOnly` guarantees a selection reached here; guard defensively.
	if (!selection) {
		throw new AgentRunError('Control-plane dispatch reached execution with no selected worker', {
			kind: 'aborted',
		});
	}

	const phaseConfig = phaseAgentConfig(project, trigger.phase, implementationUnplanned);
	const customPrompt = phaseConfig.prompt;
	const timeoutMs = phaseConfig.timeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS;

	const assignment = buildTaskAssignment({
		dispatchId: dispatch.id,
		runId,
		project,
		phase: trigger.phase,
		taskId: trigger.taskId,
		targetBranch: resolveTargetBranch(project, trigger),
		systemPrompt: composeSystemPrompt(project, trigger, customPrompt),
		customPrompt,
		target: selection.target,
		timeoutMs,
		// The run's whole recovery intent, derived from the job by its own schema
		// rather than hand-listed here — a member this dispatcher forgot is exactly
		// how `recoveryMode` stopped reaching the worker that holds the checkout
		// (issue #591).
		session: recoveryIntentFromJob(job),
		workItem: 'workItem' in trigger ? trigger.workItem : undefined,
		pr: prCoordinates(trigger),
		// Resolved here, where the DB is: the worker this is pushed to may have none
		// (ADR-003 §2), so its board status report needs the card handed to it
		// (issue #498). Best-effort — `undefined` falls back inside the phase.
		boardItemId:
			trigger.phase === 'respond-to-review'
				? await resolveBoardItemIdForPrBranch(project, trigger.prBranch)
				: undefined,
		// The repository this run acts on, read off the project `processJob` already
		// scoped to the job's own repository (issue #684 phase 2) — the same value
		// `tryCreateRun`'s sibling write puts in the `runs.repository` column
		// (`../worker/consumer.ts`, issue #683), so the pushed frame and the row cannot
		// disagree about which repository the phase ran against. Not read back off the
		// run row — creation is best-effort, so `runId` can be undefined here.
		repository: project.repo,
	});

	// Register the result wait *before* pushing so a fast worker's ack/progress/
	// result can't race ahead of the registration.
	const awaiting = awaitDispatchResult(
		dispatch.id,
		// Recorded here, not read off the worker's frames: this is what authorizes the
		// one back-channel frame that writes durably (`stream-log`), and — since issue
		// #724 — what a pushed `task-cancel` states so the worker can answer one it
		// cannot apply with a terminal result naming this phase and task.
		{ workerId: selection.workerId, runId, phase: trigger.phase, taskId: trigger.taskId },
		{
			onProgress: (progress: TaskProgress) => {
				if (progress.state === 'branch-provisioned') {
					void persistBranchProvisioned(runId, job, trigger.taskId);
				}
			},
		},
	);
	try {
		if (!sendToWorker(selection.workerId, assignment)) {
			// The socket dropped between the connectivity check and the push — defer
			// durably (the worker will re-connect) rather than fail the work.
			throw new DeliveryDeferredError(
				`Failed to push the assignment to worker '${selection.workerName}' — its transport is not connected`,
			);
		}
		logger.info('Pushed assignment to worker', {
			projectId: project.id,
			phase: trigger.phase,
			taskId: trigger.taskId,
			dispatchId: dispatch.id,
			workerId: selection.workerId,
			worker: selection.workerName,
		});
		// A cancellation recorded *before* this push had nothing to cancel when its
		// notification arrived, so read the durable marker once — after the push, not
		// before it (issue #549). The ordering is what makes the pair airtight: a
		// marker set before this read is seen by it, and one set after it is published
		// to a worker that is already running the assignment. The worker registers a
		// pushed assignment synchronously, so a cancel sent right behind it aborts the
		// run before its agent is spawned.
		if (runId && (await isRunCancellationRequested(runId))) {
			logger.info('Cancelling a just-pushed assignment — its run was already terminated', {
				dispatchId: dispatch.id,
				runId,
			});
			cancelRunOnWorker(runId);
		}
		const result = await awaitResultWithGuards(
			awaiting.result,
			signal,
			selection,
			timeoutMs + RESULT_WAIT_MARGIN_MS,
			dispatch.id,
			awaiting.interruptions,
		);
		return adaptResultToPhaseRun(
			result,
			selection,
			'workItem' in trigger ? trigger.workItem : undefined,
		);
	} finally {
		awaiting.dispose();
	}
}

/**
 * The `ProcessJobDeps` that turn `processJob` into the control-plane dispatcher:
 * only socket-connected workers are selectable, an unfederated project defers
 * durably (no local executor), the fenced claim binds the selected worker's
 * session, and the phase runs by pushing an assignment rather than in-process.
 */
export function createControlPlaneDispatchDeps(): ProcessJobDeps {
	return {
		gateOptions: { isWorkerConnected },
		federatedOnly: true,
		resolveBindIdentity: resolveSelectedWorkerIdentity,
		executePhase: pushAndAwaitResult,
	};
}

/** A running control-plane dispatch consumer — closed on router shutdown. */
export interface DispatchConsumerHandle {
	close: () => Promise<void>;
}

/**
 * Start the control-plane dispatch consumer: reconcile the durable dispatch state
 * machine, then run the BullMQ consumer that dequeues wake-ups and drives each
 * through `processJob` with the transport dispatch deps — stale-job discard,
 * dispatch settle on a stale wake-up, periodic lease/run reconciliation — but
 * never runs a phase itself; every phase runs on a connected worker.
 *
 * The router always starts this (`../router/index.ts`) and is the queue's only
 * consumer: issue #553 deleted the in-process executor that used to be the other
 * side, so there is no mode in which this is skipped.
 */
export async function startControlPlaneDispatch(options: {
	shutdownSignal: AbortSignal;
}): Promise<DispatchConsumerHandle> {
	const registry = createTriggerRegistry();
	registerBuiltInTriggers(registry);

	// Reclaim leases abandoned by a dead process and re-publish any wake-up a crash
	// window lost, before the consumer starts (so a backfilled dispatch can't race
	// its own legacy delayed job).
	await reconcileDispatchesAtStartup();

	const deps = createControlPlaneDispatchDeps();
	const maxJobAgeMs = resolveMaxJobAgeMs();
	const { lockDuration, lockRenewTime } = resolveWorkerLockOptions();

	const worker = new Worker(
		QUEUE_NAME,
		async (job) => {
			if (isJobStale(job.timestamp, maxJobAgeMs)) {
				logger.warn('Discarded stale queued job', {
					jobId: job.id,
					name: job.name,
					ageMs: Date.now() - job.timestamp,
					maxJobAgeMs,
				});
				// A stale wake-up must also settle its durable dispatch, or the reconciler
				// would faithfully re-publish work the operator already handled while the
				// system was offline (issue #284).
				const parsed = SwarmJobSchema.safeParse(job.data);
				if (parsed.success && parsed.data.dispatchId) {
					await cancelDispatchAndWake(
						parsed.data.dispatchId,
						'Wake-up exceeded the maximum job age while the control plane was offline',
					).catch((err) =>
						logger.warn('Failed to cancel stale dispatch', {
							dispatchId: parsed.data.dispatchId,
							error: describeError(err),
						}),
					);
				}
				return { status: 'no-trigger' } as const;
			}
			return await processJob(
				SwarmJobSchema.parse(job.data),
				registry,
				options.shutdownSignal,
				undefined,
				deps,
			);
		},
		{
			connection: parseRedisUrl(requireEnv('REDIS_URL')),
			concurrency: resolveWorkerConcurrency(),
			lockDuration,
			lockRenewTime,
			// A pushed assignment is not idempotent for the worker's side effects, so a
			// stalled job must fail visibly rather than be silently re-run (mirrors the
			// host worker).
			maxStalledCount: 0,
		},
	);

	worker.on('completed', (job, outcome: JobOutcome) => {
		logger.debug('Dispatch completed', { jobId: job.id, name: job.name, outcome });
	});
	worker.on('failed', (job, err) => {
		logger.error('Dispatch failed', { jobId: job?.id, name: job?.name, error: err.message });
		if (job?.data) void reportInterruptedJobToBoard(job.data, err.message);
	});
	worker.on('error', (err) => {
		logger.error('Dispatch consumer queue error', { error: err.message });
	});

	// Periodic reconciliation: reclaim expired dispatch leases (a crashed/dropped
	// worker's dispatch), re-publish lost wake-ups, and reap `running` run rows left
	// behind by a worker that died mid-phase.
	async function reconcile(): Promise<void> {
		try {
			const projects = await listAllProjectsFromDb();
			const prioritize = new Map(
				projects.map((p) => [p.id, p.pipeline?.prioritizeContinuations !== false]),
			);
			await reconcileDispatchesPeriodically((projectId) => prioritize.get(projectId) ?? true);
			await failStaleRunningRuns(
				DEFAULT_PHASE_TIMEOUT_MS,
				STALE_RUN_MARGIN_MS,
				'Run exceeded its wall-clock timeout without a worker result — reconciled as stale',
			);
		} catch (err) {
			logger.error('Failed to run periodic dispatch reconciliation', {
				error: describeError(err),
			});
		}
	}
	const reconcileInterval = setInterval(() => void reconcile(), resolveStaleRunSweepIntervalMs());
	reconcileInterval.unref();

	// Deliver user terminations to the worker running the run (issue #549). A
	// dispatched run is otherwise unstoppable until its wall-clock timeout, and a
	// DB-free worker has no Redis to read the durable marker with either.
	const cancellations = subscribeDispatchCancellations();

	logger.info('swarm-router: control-plane dispatch consumer started', {
		queue: QUEUE_NAME,
		concurrency: resolveWorkerConcurrency(),
	});

	return {
		close: async () => {
			clearInterval(reconcileInterval);
			// Drain the consumer first: an in-flight dispatch still reads the durable
			// cancellation marker on this client, so closing it underneath would only
			// make that read fail safe into "not cancelled".
			await worker.close();
			await cancellations.close();
			await closeRunCancellationRedis();
		},
	};
}
