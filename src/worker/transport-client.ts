/**
 * Worker-side transport *dispatch* client — the same-host worker's split-delivery
 * executor (ADR-003 §2). It layers phase execution on top of the DB-free session
 * client (`../transport/worker-client.ts`): that client owns the handshake,
 * heartbeat, and reconnect loop; this module supplies the `onAssignment` handler
 * that runs a pushed `TaskAssignment` and streams the outcome back.
 *
 * Unlike the remote session-only client (`../transport/connect-entry.ts`), this
 * one runs on a host **with** `DATABASE_URL`: it loads the full project config
 * locally (so persona tokens resolve from Postgres exactly as the in-process path
 * does — no secret ever crosses the wire), reuses the same per-phase runner switch
 * (`runAssignedPhase`, `./consumer.ts`) the BullMQ path uses so the two can't
 * diverge, forwards the agent's live output as `StreamLog` frames, and sends a
 * terminal `TaskExecutionResult` mirroring the in-process `JobOutcome` so the
 * control plane can settle the dispatch.
 *
 * It is gated behind a default-off dispatch mode (`SWARM_DISPATCH_MODE`,
 * `../lib/env.ts`): when off, `./index.ts` runs the BullMQ consumer exactly as
 * today; when on, it runs this client instead. Until phase 4 wires the
 * control-plane sending side, this is dead-but-tested code.
 */

import type { ProjectConfig } from '../config/schema.js';
import { findProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import type { AgentCli } from '../harness/agent-cli.js';
import { agentRunError } from '../harness/agent-failure.js';
import { describeError } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { phaseLabel } from '../pipeline/phase-label.js';
import {
	clearRunCancellation,
	isRunCancellationRequested,
	RUN_CANCELLED_MESSAGE,
} from '../queue/cancellation.js';
import {
	createAssignmentRunAgent,
	deferrableOrFailedResult,
	fromAssignedWorkItem,
	succeededResult,
} from '../transport/assignment-execution.js';
import type { TaskAssignment, TaskExecutionResult } from '../transport/protocol.js';
import {
	type AssignmentSink,
	type BackoffConfig,
	connectWorkerTransport,
	type TransportLogger,
	type WorkerTransportClient,
} from '../transport/worker-client.js';
import { type AssignedPhaseInputs, type PhaseRunResult, runAssignedPhase } from './consumer.js';
import { createLiveOutputRunner } from './live-output.js';
import {
	beginRunCancellationTracking,
	linkRunAbortController,
	unregisterRunController,
} from './run-cancellation.js';

// The pure back-channel framing helpers now live in the shared execution
// substrate (`../transport/assignment-execution.ts`) so the same-host and
// DB-free executors frame identically; re-exported here so this module's public
// surface (and its tests) are unchanged.
export { createAssignmentRunAgent, fromAssignedWorkItem };

/**
 * Collaborators the assignment executor resolves per phase. Defaulted to the real
 * DB lookup and the shared phase-runner switch; a unit test injects fakes so it
 * can drive succeeded/deferred/failed settlements without a database or a real
 * agent CLI.
 */
export interface AssignmentDeps {
	/** Load the FULL project config (with credentials) so persona tokens resolve locally. */
	loadProject: (id: string) => Promise<ProjectConfig | undefined>;
	/** The shared per-phase runner switch (`./consumer.ts`). */
	runPhase: (inputs: AssignedPhaseInputs) => Promise<PhaseRunResult>;
	logger: TransportLogger;
}

function resolveAssignmentDeps(overrides: Partial<AssignmentDeps> = {}): AssignmentDeps {
	return {
		loadProject: overrides.loadProject ?? findProjectByIdFromDb,
		runPhase: overrides.runPhase ?? runAssignedPhase,
		logger: overrides.logger ?? defaultLogger,
	};
}

/** Assemble the normalized phase inputs from a pushed assignment + the locally-loaded project. */
function buildAssignedPhaseInputs(
	assignment: TaskAssignment,
	project: ProjectConfig,
	signal: AbortSignal,
	sink: AssignmentSink,
): AssignedPhaseInputs {
	return {
		phase: assignment.phase,
		taskId: assignment.taskId,
		project,
		cli: assignment.target.cli,
		model: assignment.target.model,
		reasoning: assignment.target.reasoning,
		customPrompt: assignment.customPrompt,
		timeoutMs: assignment.timeoutMs,
		sessionId: assignment.resumeSession ? undefined : assignment.agentSessionId,
		resumeSessionId: assignment.resumeSession ? assignment.agentSessionId : undefined,
		resumeDelivery: assignment.resumeDelivery === true,
		runId: assignment.runId,
		signal,
		// Same-host base: persists live output to `run_output_events` (DB access)
		// *and* forwards it over the transport.
		runAgent: createAssignmentRunAgent(assignment, sink, createLiveOutputRunner(assignment.runId)),
		workItem: assignment.workItem ? fromAssignedWorkItem(assignment.workItem) : undefined,
		resumeExistingBranch: assignment.implementationBranchProvisioned === true,
		// Report the branch checkpoint so the control plane can persist
		// `implementationBranchProvisioned` for a resumed re-push (idempotency).
		onBranchProvisioned: async () => {
			sink.send({
				type: 'task-progress',
				dispatchId: assignment.dispatchId,
				runId: assignment.runId,
				phase: assignment.phase,
				taskId: assignment.taskId,
				state: 'branch-provisioned',
			});
		},
		prNumber: assignment.prNumber,
		prBranch: assignment.prBranch,
		headSha: assignment.headSha,
		reviewId: assignment.reviewId,
		baseBranch: assignment.baseBranch,
		baseSha: assignment.baseSha,
	};
}

/**
 * Build the terminal failure/deferral result frame. A user termination (issue
 * #166) settles terminal-`failed` with `cancelled: true` (never deferred, which
 * would re-run the very phase the user killed); every other failure is classified
 * by the shared {@link deferrableOrFailedResult} — a deferrable failure settles
 * `deferred` with the retry hint + resume flags, everything else terminal-`failed`.
 * The cancelled check is same-host-only (it reads Redis); the DB-free executor has
 * no such channel.
 */
async function settleFailure(
	err: unknown,
	assignment: TaskAssignment,
): Promise<TaskExecutionResult> {
	if (assignment.runId && (await isRunCancellationRequested(assignment.runId))) {
		return {
			type: 'task-execution-result',
			dispatchId: assignment.dispatchId,
			runId: assignment.runId,
			phase: assignment.phase,
			taskId: assignment.taskId,
			status: 'failed',
			error: RUN_CANCELLED_MESSAGE,
			cancelled: true,
		};
	}
	return deferrableOrFailedResult(err, assignment);
}

/** Options {@link runAssignment} reads — a shared in-flight set, the shutdown signal, and its deps. */
export interface RunAssignmentOptions {
	/** Dedup set keyed by `dispatchId`, shared across every assignment on the session. */
	inFlight?: Set<string>;
	/** Worker shutdown signal — aborting kills the in-flight agent CLI. */
	shutdownSignal?: AbortSignal;
	/** Collaborators (defaulted to the real DB lookup + shared phase runner). */
	deps?: Partial<AssignmentDeps>;
}

/**
 * Execute one pushed `TaskAssignment` and stream its lifecycle back through the
 * sink: an immediate ack (marking a re-pushed dispatch a duplicate so the control
 * plane drops it), a `running` progress marker, batched live output, and a
 * terminal `TaskExecutionResult`. Idempotent by `dispatchId`: a re-pushed
 * assignment for a dispatch already running here keeps the in-flight run rather
 * than starting a second (ADR-003 §2). Never throws — every settlement is a frame.
 */
export async function runAssignment(
	assignment: TaskAssignment,
	sink: AssignmentSink,
	options: RunAssignmentOptions = {},
): Promise<void> {
	const deps = resolveAssignmentDeps(options.deps);
	const inFlight = options.inFlight ?? new Set<string>();
	const { dispatchId, runId, phase, taskId } = assignment;

	const duplicate = inFlight.has(dispatchId);
	sink.send({ type: 'task-assignment-ack', dispatchId, runId, duplicate });
	if (duplicate) {
		deps.logger.info('ignoring re-pushed assignment already running here', { dispatchId, taskId });
		return;
	}
	inFlight.add(dispatchId);

	const { controller, detach } = linkRunAbortController(options.shutdownSignal);
	try {
		const project = await deps.loadProject(assignment.projectConfig.id);
		if (!project) {
			sink.send({
				type: 'task-execution-result',
				dispatchId,
				runId,
				status: 'failed',
				phase,
				taskId,
				error: `Assignment references unknown project '${assignment.projectConfig.id}'`,
			});
			return;
		}

		// Make the run cancellable by id and honour a cancellation already recorded
		// (a re-push whose run the operator terminated meanwhile).
		await beginRunCancellationTracking(runId, controller);

		sink.send({ type: 'task-progress', dispatchId, runId, phase, taskId, state: 'running' });

		const inputs = buildAssignedPhaseInputs(assignment, project, controller.signal, sink);
		const result = await deps.runPhase(inputs);
		// A run the harness killed for exceeding its wall-clock timeout is a terminal
		// failure even if the agent trapped SIGTERM and still exited 0 (issue #165) —
		// route it through the failure path like the in-process `processJob` does.
		if (result.agent.timedOut) {
			throw agentRunError(
				result.agent,
				`${phaseLabel(phase)} agent exceeded its wall-clock timeout`,
				` for task '${taskId}'`,
			);
		}
		sink.send(succeededResult(assignment, result));
	} catch (err) {
		deps.logger.warn('assignment phase failed', {
			dispatchId,
			phase,
			taskId,
			error: describeError(err),
		});
		sink.send(await settleFailure(err, assignment));
	} finally {
		detach();
		if (runId) {
			unregisterRunController(runId);
			await clearRunCancellation(runId).catch(() => {});
		}
		inFlight.delete(dispatchId);
	}
}

/** Options for {@link startWorkerTransportDispatch}. */
export interface WorkerTransportDispatchOptions {
	controlPlaneUrl: string;
	credential: string;
	capabilities: AgentCli[];
	hostname: string;
	daemonVersion: string;
	/** Worker shutdown signal — aborting kills any in-flight agent CLI. */
	shutdownSignal?: AbortSignal;
	/** Reconnect backoff overrides. */
	backoff?: Partial<BackoffConfig>;
}

/**
 * Start the same-host transport-dispatch client: it keeps an authenticated
 * session live and, on each pushed `TaskAssignment`, runs the phase locally and
 * streams the result back. Returns the {@link WorkerTransportClient} handle so
 * `./index.ts` can await `done` and `stop()` it on shutdown. The `inFlight` set
 * is shared across every assignment on the client for cross-assignment idempotency.
 */
export function startWorkerTransportDispatch(
	options: WorkerTransportDispatchOptions,
	deps: Partial<AssignmentDeps> = {},
): WorkerTransportClient {
	const resolved = resolveAssignmentDeps(deps);
	const inFlight = new Set<string>();
	return connectWorkerTransport({
		controlPlaneUrl: options.controlPlaneUrl,
		credential: options.credential,
		capabilities: options.capabilities,
		hostname: options.hostname,
		daemonVersion: options.daemonVersion,
		backoff: options.backoff,
		onAssignment: (assignment, sink) => {
			void runAssignment(assignment, sink, {
				inFlight,
				shutdownSignal: options.shutdownSignal,
				deps: resolved,
			});
		},
	});
}
