/**
 * Control-plane dispatcher (issue #407, ADR-003 §2 — the final split-delivery
 * phase). It hosts the BullMQ consumer + the ADR-001 eligibility gate **on the
 * router** and, on selecting a connected, eligible worker, composes the phase's
 * system prompt + target branch server-side, builds a `TaskAssignment`
 * (`../transport/assignment.ts`), and pushes it (`./worker-connections.ts`) to
 * that worker — which runs the phase (`../worker/transport-client.ts`) and reports
 * a `TaskExecutionResult` back over its socket for the dispatcher to settle on.
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
 * are selectable) and `federatedOnly` (no local executor here, so an
 * unfederated/single-user project defers durably rather than running on the
 * router). With no eligible/connected worker the durable dispatch stays `pending`
 * in Postgres via the existing `WorkerIneligibleError` token-free deferral —
 * exactly as the in-process federated path already behaves.
 */

import { Worker } from 'bullmq';
import { listAllProjectsFromDb } from '../db/repositories/projectsRepository.js';
import { failStaleRunningRuns, updateRunJobPayload } from '../db/repositories/runsRepository.js';
import { cancelDispatchAndWake } from '../dispatch/dispatcher.js';
import {
	reconcileDispatchesAtStartup,
	reconcileDispatchesPeriodically,
} from '../dispatch/reconciler.js';
import type { AgentCliResult } from '../harness/agent-cli.js';
import { type AgentFailureKind, AgentRunError } from '../harness/agent-failure.js';
import {
	getLiveSessionForWorker,
	resolveHeartbeatTtlMs,
} from '../identity/worker-session-service.js';
import { requireEnv } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';
import { RUN_CANCELLED_MESSAGE } from '../queue/cancellation.js';
import { QUEUE_NAME, type SwarmJob, SwarmJobSchema } from '../queue/jobs.js';
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
import { awaitDispatchResult } from './dispatch-results.js';
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

/** A minimal captured-run stand-in built from a worker's result frame (the router ran no agent). */
function resultAgent(
	cli: AgentCliResult['cli'],
	fields: {
		exitCode?: number | null;
		signal?: string | null;
		durationMs?: number;
		timedOut?: boolean;
		aborted?: boolean;
	} = {},
): AgentCliResult {
	return {
		cli,
		exitCode: fields.exitCode ?? null,
		signal: (fields.signal ?? null) as AgentCliResult['signal'],
		stdout: '',
		stderr: '',
		durationMs: fields.durationMs ?? 0,
		timedOut: fields.timedOut ?? false,
		aborted: fields.aborted ?? false,
		outputTruncated: false,
	};
}

/**
 * Adapt a worker's terminal `TaskExecutionResult` back into the shape
 * `processJob`'s shared settle path consumes: a `PhaseRunResult` for a success, or
 * a throw that the shared `handlePhaseFailure` classifies exactly as an in-process
 * failure would — `RunTerminatedError` for a user cancellation, `DeliveryDeferredError`
 * or an `AgentRunError` (with the reported failure kind) for a deferral, and a
 * plain terminal error otherwise. The synthetic agent result carries the reported
 * exit metadata; its non-zero exit keeps a genuinely-interrupted `timeout`
 * deferrable, matching the in-process rule.
 */
export function adaptResultToPhaseRun(
	result: TaskExecutionResult,
	selection: DispatchSelection,
): PhaseRunResult {
	if (result.status === 'succeeded') {
		return {
			agent: resultAgent(selection.cli, {
				exitCode: result.exitCode ?? 0,
				signal: result.signal,
				durationMs: result.durationMs,
				timedOut: result.timedOut ?? false,
			}),
			movedTo: result.movedTo,
			verdict: result.verdict,
			reviewOrdinal: result.reviewOrdinal,
			automationOutcome: result.reviewAutomationOutcome,
		};
	}
	if (result.status === 'failed') {
		if (result.cancelled) throw new RunTerminatedError(result.error || RUN_CANCELLED_MESSAGE);
		throw new Error(result.error || result.reason || 'Phase failed on the worker');
	}
	// deferred: rebuild the classified failure so the shared deferral path applies
	// its budget and retry-delay policy exactly as it does for an in-process failure.
	if (result.failureKind === 'delivery') {
		throw new DeliveryDeferredError(result.reason ?? 'Delivery deferred on the worker');
	}
	const kind = (result.failureKind ?? 'rate-limit') as AgentFailureKind;
	throw new AgentRunError(
		result.reason ?? `Phase deferred (${kind}) on the worker`,
		{ kind },
		resultAgent(selection.cli, { exitCode: result.exitCode ?? 1, aborted: kind === 'aborted' }),
	);
}

/**
 * Await the worker's terminal result, but give up if the control plane is
 * shutting down (`signal`) or the worker never reports within the lease window —
 * both surface as an `aborted` `AgentRunError` so the shared path defers the
 * dispatch for a bounded retry rather than hanging the BullMQ job forever.
 */
function awaitResultWithGuards(
	result: Promise<TaskExecutionResult>,
	signal: AbortSignal,
	selection: DispatchSelection,
	waitMs: number,
): Promise<TaskExecutionResult> {
	return new Promise<TaskExecutionResult>((resolve, reject) => {
		const abort = (reason: string): void => {
			cleanup();
			reject(
				new AgentRunError(
					reason,
					{ kind: 'aborted' },
					resultAgent(selection.cli, { aborted: true }),
				),
			);
		};
		const timer = setTimeout(
			() =>
				abort(`Worker '${selection.workerName}' did not report a result within the lease window`),
			waitMs,
		);
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
		session: {
			agentSessionId: job.agentSessionId,
			resumeSession: job.resumeSession,
			resumeDelivery: job.resumeDelivery,
			implementationBranchProvisioned: job.implementationBranchProvisioned,
		},
		workItem: 'workItem' in trigger ? trigger.workItem : undefined,
		pr: prCoordinates(trigger),
	});

	// Register the result wait *before* pushing so a fast worker's ack/progress/
	// result can't race ahead of the registration.
	const awaiting = awaitDispatchResult(dispatch.id, {
		onProgress: (progress: TaskProgress) => {
			if (progress.state === 'branch-provisioned') {
				void persistBranchProvisioned(runId, job, trigger.taskId);
			}
		},
	});
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
		const result = await awaitResultWithGuards(
			awaiting.result,
			signal,
			selection,
			timeoutMs + RESULT_WAIT_MARGIN_MS,
		);
		return adaptResultToPhaseRun(result, selection);
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
 * through `processJob` with the transport dispatch deps. Mirrors the host worker's
 * consumer wiring (`../worker/index.ts`) — stale-job discard, dispatch settle on a
 * stale wake-up, periodic lease/run reconciliation — but never runs a phase itself.
 * Only started when `SWARM_DISPATCH_MODE=transport` (see `../router/index.ts`), so
 * the queue is consumed by exactly one side.
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
	const reconcileInterval = setInterval(() => void reconcile(), 5 * 60 * 1000);
	reconcileInterval.unref();

	logger.info('swarm-router: control-plane dispatch consumer started', {
		queue: QUEUE_NAME,
		concurrency: resolveWorkerConcurrency(),
	});

	return {
		close: async () => {
			clearInterval(reconcileInterval);
			await worker.close();
		},
	};
}
