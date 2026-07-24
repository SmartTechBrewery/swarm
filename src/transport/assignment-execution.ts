/**
 * The transport assignment-execution substrate — the DB/Redis-free half of
 * running a pushed `TaskAssignment` (ADR-003 §2), plus the pure framing helpers
 * both the same-host and remote executors share.
 *
 * `../worker/transport-client.ts` runs an assignment on a host **with**
 * `DATABASE_URL` (persona tokens from Postgres, live output persisted to
 * `run_output_events`, cancellation via Redis). This module adds the **remote**
 * counterpart, {@link runAssignmentDbFree}, which runs entirely from the
 * assignment itself: the project config is reconstructed from the non-secret
 * slice (`./db-free-project.ts`), delivery uses the operator's own token
 * (`../integrations/scm/github/operator-delivery.ts`), live output streams over
 * the transport only (no DB write), and cancellation rides the shutdown signal
 * alone (no Redis). A supported-phase gate cleanly fails any phase not yet
 * runnable this way, so a premature push fails with a clear result rather than
 * crashing on a DB/Redis access.
 *
 * The pure helpers (`fromAssignedWorkItem`, `createAssignmentRunAgent`,
 * `classifyDeferrable`, `succeededResult`, `deferrableOrFailedResult`) live here
 * rather than in the DB-importing same-host client so both paths frame the
 * back-channel identically; the same-host client re-exports them, so its public
 * surface and behaviour are unchanged.
 */

import type { ProjectConfig } from '../config/schema.js';
import { runAgentCli } from '../harness/agent-cli.js';
import { AgentRunError, agentRunError } from '../harness/agent-failure.js';
import { createOperatorDeliveryProvider } from '../integrations/scm/github/operator-delivery.js';
import { describeError } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { phaseLabel } from '../pipeline/phase-label.js';
import type { WorkItem } from '../pm/types.js';
import { DeliveryDeferredError, type ScmDeliveryProvider } from '../scm/delivery.js';
import {
	type AssignedPhaseInputs,
	type DeferrableFailure,
	type PhaseRunResult,
	retryDelayForFailure,
	runAssignedPhase,
} from '../worker/consumer.js';
import { linkRunAbortController } from '../worker/run-cancellation.js';
import { reconstructProjectConfig } from './db-free-project.js';
import type {
	AssignedWorkItem,
	StreamLogLine,
	TaskAssignment,
	TaskExecutionResult,
	TaskPhase,
} from './protocol.js';
import type { AssignmentSink, TransportLogger } from './worker-client.js';

/** Batch window/size for forwarded output — mirrors `../worker/live-output.ts`. */
const BATCH_MS = 100;
const BATCH_SIZE = 100;

/** Map the transport's serialization subset back to a PM `WorkItem` for the phase runner. */
export function fromAssignedWorkItem(item: AssignedWorkItem): WorkItem {
	return {
		id: item.id,
		title: item.title,
		description: item.description,
		url: item.url,
		status: item.status,
		statusId: item.statusId,
		labels: item.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
		assignees: item.assignees.map((assignee) => ({
			handle: assignee.handle,
			displayName: assignee.displayName,
			providerId: assignee.providerId,
		})),
	};
}

/**
 * Wrap an agent runner so every emitted line is forwarded to the control plane
 * as a batched `StreamLog` frame — the transport analogue of
 * `../worker/live-output.ts`'s DB batcher. `base` is the underlying runner: the
 * same-host client passes its `run_output_events` batcher (DB access), the
 * DB-free executor passes the raw `runAgentCli` so lines stream over the wire
 * *only*. Injectable so a test can drive the forwarding without a real CLI.
 */
export function createAssignmentRunAgent(
	assignment: TaskAssignment,
	sink: AssignmentSink,
	base: typeof runAgentCli,
): typeof runAgentCli {
	return async (options) => {
		let queue: StreamLogLine[] = [];
		let timer: ReturnType<typeof setTimeout> | undefined;
		const flush = (): void => {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			const batch = queue;
			queue = [];
			const [first, ...rest] = batch;
			if (!first) return;
			sink.send({
				type: 'stream-log',
				dispatchId: assignment.dispatchId,
				runId: assignment.runId,
				lines: [first, ...rest],
			});
		};
		const enqueue = (stream: 'stdout' | 'stderr', line: string): void => {
			queue.push({ stream, content: `${line}\n`, emittedAt: new Date().toISOString() });
			if (queue.length >= BATCH_SIZE) flush();
			else timer ??= setTimeout(flush, BATCH_MS);
		};
		try {
			return await base({
				...options,
				onStdout: (line) => {
					options.onStdout?.(line);
					enqueue('stdout', line);
				},
				onStderr: (line) => {
					options.onStderr?.(line);
					enqueue('stderr', line);
				},
			});
		} finally {
			// Flush whatever the run produced before it settled, even on the throwing
			// paths — the same "preserve the last output" contract `../worker/live-output.ts` keeps.
			flush();
		}
	};
}

/**
 * Classify a phase failure into the deferrable failure the control plane should
 * schedule a retry for, or `undefined` for a terminal failure — the exact rule
 * the in-process `handlePhaseFailure` applies (`../worker/consumer.ts`): a
 * rate-limit, capacity, aborted, or stalled agent error, a genuinely-interrupted
 * timeout (non-zero/absent exit — a clean SIGTERM exit already cleaned up), or a
 * deterministic-delivery deferral.
 */
export function classifyDeferrable(err: unknown): DeferrableFailure | undefined {
	if (err instanceof DeliveryDeferredError) return { kind: 'delivery' };
	if (err instanceof AgentRunError) {
		const kind = err.failure.kind;
		if (kind === 'rate-limit' || kind === 'capacity' || kind === 'aborted' || kind === 'stalled') {
			return err.failure;
		}
		if (kind === 'timeout' && err.agent !== undefined && err.agent.exitCode !== 0) {
			return err.failure;
		}
	}
	return undefined;
}

/** Build the terminal `succeeded` result frame from a completed phase run. */
export function succeededResult(
	assignment: TaskAssignment,
	result: PhaseRunResult,
): TaskExecutionResult {
	return {
		type: 'task-execution-result',
		dispatchId: assignment.dispatchId,
		runId: assignment.runId,
		status: 'succeeded',
		phase: assignment.phase,
		taskId: assignment.taskId,
		exitCode: result.agent.exitCode,
		signal: result.agent.signal,
		timedOut: result.agent.timedOut,
		durationMs: result.agent.durationMs,
	};
}

/**
 * Build the terminal failure/deferral frame for a non-cancelled failure: a
 * deferrable failure settles `deferred` with the retry hint + resume flags a
 * `phase-deferred` outcome carries; everything else settles terminal-`failed`.
 * The cancelled-settlement (a user termination) is the caller's concern — the
 * same-host client checks Redis for it; the DB-free path has no such channel and
 * so never produces one.
 */
export function deferrableOrFailedResult(
	err: unknown,
	assignment: TaskAssignment,
): TaskExecutionResult {
	const error = describeError(err);
	const terminal = {
		type: 'task-execution-result' as const,
		dispatchId: assignment.dispatchId,
		runId: assignment.runId,
		phase: assignment.phase,
		taskId: assignment.taskId,
	};
	const failure = classifyDeferrable(err);
	if (failure) {
		return {
			...terminal,
			status: 'deferred',
			retryDelayMs: retryDelayForFailure(failure, Date.now()),
			resumable:
				failure.kind === 'rate-limit' || failure.kind === 'timeout' || failure.kind === 'stalled',
			resumeDelivery: failure.kind === 'delivery' || undefined,
			failureKind: failure.kind,
			reason: error,
		};
	}
	return { ...terminal, status: 'failed', error };
}

/**
 * The pipeline phases a DB-free worker can run today: those whose entire
 * delivery is worker-side source ops (implementer `postComment` + `pushBranch`
 * under the operator's own token, ADR-003 §2) with no server API or PM write.
 * Phases 2/3 widen this set as the server delivery API and the PM read seam land.
 */
const SUPPORTED_DB_FREE_PHASES: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
	'respond-to-ci',
	'resolve-conflicts',
]);

/**
 * Collaborators {@link runAssignmentDbFree} resolves. Defaulted to the shared
 * phase-runner switch and the operator-token delivery builder; a unit test
 * injects fakes so it can drive succeeded/deferred/failed settlements without a
 * real agent CLI or a live GitHub client — and, by never providing a DB, prove
 * the path touches neither Postgres nor Redis.
 */
export interface DbFreeAssignmentDeps {
	runPhase: (inputs: AssignedPhaseInputs) => Promise<PhaseRunResult>;
	buildDelivery: (repo: string, token: string) => Promise<ScmDeliveryProvider>;
	/** The underlying agent runner the streaming wrapper wraps — the raw CLI by default. */
	baseRunAgent: typeof runAgentCli;
	logger: TransportLogger;
}

function resolveDbFreeDeps(overrides: Partial<DbFreeAssignmentDeps> = {}): DbFreeAssignmentDeps {
	return {
		runPhase: overrides.runPhase ?? runAssignedPhase,
		buildDelivery: overrides.buildDelivery ?? createOperatorDeliveryProvider,
		baseRunAgent: overrides.baseRunAgent ?? runAgentCli,
		logger: overrides.logger ?? defaultLogger,
	};
}

/** Options {@link runAssignmentDbFree} reads. */
export interface RunAssignmentDbFreeOptions {
	/** The worker operator's own GitHub token (`SWARM_OPERATOR_GH_TOKEN`). */
	operatorToken: string;
	/** Worker shutdown signal — aborting kills the in-flight agent CLI. */
	shutdownSignal?: AbortSignal;
	/** Dedup set keyed by `dispatchId`, shared across every assignment on the session. */
	inFlight?: Set<string>;
	/** Collaborators (defaulted to the shared phase runner + operator delivery). */
	deps?: Partial<DbFreeAssignmentDeps>;
}

/** Assemble the normalized phase inputs from a pushed assignment + the reconstructed project. */
function buildDbFreePhaseInputs(
	assignment: TaskAssignment,
	project: ProjectConfig,
	signal: AbortSignal,
	sink: AssignmentSink,
	delivery: ScmDeliveryProvider,
	operatorToken: string,
	baseRunAgent: typeof runAgentCli,
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
		// Non-persisting base: lines stream over the transport only — this worker
		// has no `run_output_events` table to write to.
		runAgent: createAssignmentRunAgent(assignment, sink, baseRunAgent),
		workItem: assignment.workItem ? fromAssignedWorkItem(assignment.workItem) : undefined,
		resumeExistingBranch: assignment.implementationBranchProvisioned === true,
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
		// The DB-free injection seam: operator-token delivery + the operator token
		// as the agent's `getToken`, so no phase reaches the secret store or DB.
		delivery,
		agentToken: operatorToken,
	};
}

/**
 * Execute one pushed `TaskAssignment` on a DB/Redis-free remote worker and stream
 * its lifecycle back through the sink: an immediate ack (marking a re-pushed
 * dispatch a duplicate so the control plane drops it), a `running` progress
 * marker, batched live output, and a terminal `TaskExecutionResult`. Idempotent
 * by `dispatchId`: a re-pushed assignment for a dispatch already running here
 * keeps the in-flight run rather than starting a second (ADR-003 §2). Never
 * throws — every settlement is a frame.
 *
 * Unlike the same-host executor (`../worker/transport-client.ts`), it reads no
 * database and no queue: the project is reconstructed from the assignment's
 * non-secret slice, delivery uses the operator's own token, and cancellation
 * rides the shutdown signal alone. A phase not in {@link SUPPORTED_DB_FREE_PHASES}
 * is failed cleanly with a clear reason rather than crashing on a DB/Redis access.
 */
export async function runAssignmentDbFree(
	assignment: TaskAssignment,
	sink: AssignmentSink,
	options: RunAssignmentDbFreeOptions,
): Promise<void> {
	const deps = resolveDbFreeDeps(options.deps);
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
		// Fail an unsupported phase cleanly, before touching the project or delivery
		// — a DB-free worker can only run the source-only phases in Phase 1.
		if (!SUPPORTED_DB_FREE_PHASES.has(phase)) {
			sink.send({
				type: 'task-execution-result',
				dispatchId,
				runId,
				status: 'failed',
				phase,
				taskId,
				error: `phase ${phase} is not yet runnable on a DB-free worker`,
			});
			return;
		}

		const project = reconstructProjectConfig(assignment.projectConfig);
		const delivery = await deps.buildDelivery(project.repo, options.operatorToken);

		sink.send({ type: 'task-progress', dispatchId, runId, phase, taskId, state: 'running' });

		const inputs = buildDbFreePhaseInputs(
			assignment,
			project,
			controller.signal,
			sink,
			delivery,
			options.operatorToken,
			deps.baseRunAgent,
		);
		const result = await deps.runPhase(inputs);
		// A run the harness killed for exceeding its wall-clock timeout is a terminal
		// failure even if the agent trapped SIGTERM and still exited 0 (issue #165) —
		// route it through the failure path like the same-host executor does.
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
		sink.send(deferrableOrFailedResult(err, assignment));
	} finally {
		detach();
		inFlight.delete(dispatchId);
	}
}
