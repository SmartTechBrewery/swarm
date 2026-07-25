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
 * slice (`./db-free-project.ts`), source-carrying delivery uses the operator's
 * own token (`../integrations/scm/github/operator-delivery.ts`), the two kinds of
 * metadata write the operator token *cannot* perform — a review under the
 * project's reviewer PAT, a board write under its PM credential — ride the
 * control-plane delivery API instead (`./delivery-client.ts`, ADR-004 §2), live
 * output streams over the transport only (no DB write), and cancellation rides
 * the shutdown signal alone (no Redis). A supported-phase gate cleanly fails any
 * phase not yet runnable this way, so a premature push fails with a clear result
 * rather than crashing on a DB/Redis access.
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
import type { ScheduleFollowUpReview } from '../pipeline/follow-up-review.js';
import { phaseLabel } from '../pipeline/phase-label.js';
import type { ReviewVerdictLedger } from '../pipeline/review-ledger.js';
import { createWriteOnlyTransportPmProvider } from '../pm/transport-delivery.js';
import type { PMProvider, WorkItem } from '../pm/types.js';
import { DeliveryDeferredError, type ScmDeliveryProvider } from '../scm/delivery.js';
import { createTransportScmDeliveryProvider } from '../scm/transport-delivery.js';
import {
	type AssignedPhaseInputs,
	type DeferrableFailure,
	type PhaseRunResult,
	retryDelayForFailure,
	runAssignedPhase,
} from '../worker/consumer.js';
import { linkRunAbortController } from '../worker/run-cancellation.js';
import { reconstructProjectConfig } from './db-free-project.js';
import type { DeliveryClientOptions, FetchLike } from './delivery-client.js';
import { createTransportFollowUpReviewScheduler } from './follow-up-review-delivery.js';
import type {
	AssignedWorkItem,
	StreamLogLine,
	TaskAssignment,
	TaskExecutionResult,
	TaskPhase,
} from './protocol.js';
import { createTransportReviewLedger } from './review-ledger-delivery.js';
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
		// The terminal PM/verdict context the control plane settles on (issue #407):
		// a PM-driven phase's auto-advance status drives the next phase's
		// self-enqueue on the control plane; a Review run's verdict/ordinal/outcome
		// are persisted on its run row and gate merge automation. Absent for phases
		// that produce none.
		movedTo: result.movedTo,
		verdict: result.verdict,
		reviewOrdinal: result.reviewOrdinal,
		reviewAutomationOutcome: result.automationOutcome,
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
 * The pipeline phases a DB-free worker can run today, and how each is delivered:
 *
 * - `respond-to-ci` / `resolve-conflicts` — entirely worker-side source ops
 *   (implementer `postComment` + `pushBranch` under the operator's own token,
 *   ADR-003 §2). No server call, no board write.
 * - `implementation` — source ops stay on the operator token (the operator *is*
 *   the implementer identity, so the PR and its comment are authored by that
 *   account and loop-prevention keeps working); its two board writes go through
 *   the control-plane PM delivery API under the project's PM credential.
 * - `review` — the diff read and the agent run stay worker-side under the
 *   operator token; `submitReview` goes through the control-plane SCM delivery
 *   API under the project's **reviewer PAT**, which a federated worker must
 *   never hold, and its three review-verdict ledger calls (the two-verdict cap
 *   and the re-review signal) go through the control-plane ledger routes, which
 *   own the `review_verdicts` table this worker has no database for.
 * - `respond-to-review` — the fix commit, its push, and the response comment are
 *   the *implementer's*, so they stay on the operator token exactly as
 *   Implementation's do; what travels is the best-effort board report (resolve
 *   the card by its backing issue URL, then move it In progress → In review)
 *   under the PM credential, and the follow-up-Review enqueue a pushed fix owes
 *   (issue #241), which needs the dispatch store and queue this worker has
 *   neither of.
 *
 * `planning`'s PM write surface (`createWorkItem`/`updateWorkItem`/`addLabel`/
 * `addBlockedBy`/`findComment` plus the split logic) is wider than a delivery seam
 * should carry, so it stays on the local host worker and is failed cleanly by the
 * gate below.
 */
const SUPPORTED_DB_FREE_PHASES: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
	'respond-to-ci',
	'resolve-conflicts',
	'implementation',
	'review',
	'respond-to-review',
]);

/**
 * The SCM delivery provider a DB-free phase runs against. `operator` is the
 * provider built from the operator's own token, which already serves every
 * source-carrying / attribution op. Review is the one phase whose metadata write
 * needs an identity the worker must not hold — the project's reviewer PAT — so it
 * gets the transport-backed composite: `submitReview`/`postComment` POST to the
 * control plane, everything else still runs on `operator`.
 *
 * Respond-to-review deliberately stays on `operator` even though it also posts a
 * PR comment: that comment is the *implementer's* reply to the review, so it must
 * be authored by the implementer identity (the operator, as in Implementation) —
 * routing it through the reviewer-PAT composite would have the reviewer answering
 * its own review, and the author-persona routing that decides what a comment event
 * means (`getPersonaForLogin`, `../router/adapters/github.ts`) would read the
 * wrong persona off it.
 */
function resolveDbFreeDelivery(
	phase: TaskPhase,
	operator: ScmDeliveryProvider,
	transport: DeliveryClientOptions,
	projectId: string,
): ScmDeliveryProvider {
	if (phase !== 'review') return operator;
	return createTransportScmDeliveryProvider({ ...transport, projectId, localDelegate: operator });
}

/**
 * The PM provider a DB-free phase runs against, or `undefined` for a phase that
 * takes none (review / respond-to-ci / resolve-conflicts — `runAssignedPhase`
 * then constructs nothing). The two board-driven phases get the delegate-less
 * transport writer: their board writes ride the delivery API under the
 * server-held PM credential, as do the two narrow reads it serves —
 * Implementation's `listBlockers` and Respond-to-review's card lookup. Every
 * other board read refuses, because the control plane performed the reads this
 * assignment was composed from.
 */
function resolveDbFreePm(
	phase: TaskPhase,
	project: ProjectConfig,
	transport: DeliveryClientOptions,
): PMProvider | undefined {
	if (phase !== 'implementation' && phase !== 'respond-to-review') return undefined;
	return createWriteOnlyTransportPmProvider({
		...transport,
		projectId: project.id,
		providerType: project.pm.type,
	});
}

/**
 * The follow-up-Review scheduler a DB-free phase runs against, or `undefined` for
 * a phase that schedules none (only Respond-to-review does). Routed to the
 * control plane, which holds the dispatch store and the queue: skipping it would
 * leave a pushed fix sitting on the PR unreviewed (issue #241). It stays *inside*
 * the phase's deterministic delivery rather than becoming a fact reported in the
 * terminal result, so a failed enqueue still defers and re-schedules on the retry.
 */
function resolveDbFreeFollowUpReview(
	phase: TaskPhase,
	projectId: string,
	transport: DeliveryClientOptions,
): ScheduleFollowUpReview | undefined {
	if (phase !== 'respond-to-review') return undefined;
	return createTransportFollowUpReviewScheduler({ ...transport, projectId });
}

/**
 * The review-verdict ledger a DB-free phase runs against, or `undefined` for a
 * phase that keeps none (only Review consults the ledger). Routed to the control
 * plane, which holds the database: skipping the ledger instead would silently
 * disable the two-verdict cap (issue #235) and prompt every re-review as a first
 * review (issue #328).
 */
function resolveDbFreeReviewLedger(
	phase: TaskPhase,
	projectId: string,
	transport: DeliveryClientOptions,
): ReviewVerdictLedger | undefined {
	if (phase !== 'review') return undefined;
	return createTransportReviewLedger({ ...transport, projectId });
}

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
	/**
	 * The `fetch` the control-plane delivery adapters POST with — the global by
	 * default. A test injects a fake so it can assert the metadata calls that ride
	 * the delivery API without a network or a live router.
	 */
	fetchImpl?: FetchLike;
	logger: TransportLogger;
}

function resolveDbFreeDeps(overrides: Partial<DbFreeAssignmentDeps> = {}): DbFreeAssignmentDeps {
	return {
		runPhase: overrides.runPhase ?? runAssignedPhase,
		buildDelivery: overrides.buildDelivery ?? createOperatorDeliveryProvider,
		baseRunAgent: overrides.baseRunAgent ?? runAgentCli,
		fetchImpl: overrides.fetchImpl,
		logger: overrides.logger ?? defaultLogger,
	};
}

/** Options {@link runAssignmentDbFree} reads. */
export interface RunAssignmentDbFreeOptions {
	/** The worker operator's own GitHub token (`SWARM_OPERATOR_GH_TOKEN`). */
	operatorToken: string;
	/**
	 * Base URL of the control plane (`SWARM_CONTROL_PLANE_URL`) — where the
	 * metadata delivery calls this worker cannot perform itself are POSTed.
	 */
	controlPlaneUrl: string;
	/**
	 * This worker's raw registered credential (`SWARM_WORKER_CREDENTIAL`), which
	 * authenticates those delivery calls. It is the worker's *own* identity, never
	 * a project credential.
	 */
	workerCredential: string;
	/** Worker shutdown signal — aborting kills the in-flight agent CLI. */
	shutdownSignal?: AbortSignal;
	/** Dedup set keyed by `dispatchId`, shared across every assignment on the session. */
	inFlight?: Set<string>;
	/** Collaborators (defaulted to the shared phase runner + operator delivery). */
	deps?: Partial<DbFreeAssignmentDeps>;
}

/** What {@link buildDbFreePhaseInputs} assembles the normalized phase inputs from. */
interface DbFreePhaseInputsParams {
	assignment: TaskAssignment;
	project: ProjectConfig;
	signal: AbortSignal;
	sink: AssignmentSink;
	/** The SCM delivery provider this phase runs against ({@link resolveDbFreeDelivery}). */
	delivery: ScmDeliveryProvider;
	/** The PM provider this phase runs against, or undefined for a phase that takes none. */
	pm: PMProvider | undefined;
	/** Review only: the transport-backed review-verdict ledger ({@link resolveDbFreeReviewLedger}). */
	reviewLedger: ReviewVerdictLedger | undefined;
	/**
	 * Respond-to-review only: the transport-backed follow-up-Review scheduler
	 * ({@link resolveDbFreeFollowUpReview}).
	 */
	scheduleFollowUpReview: ScheduleFollowUpReview | undefined;
	operatorToken: string;
	baseRunAgent: typeof runAgentCli;
}

/** Assemble the normalized phase inputs from a pushed assignment + the reconstructed project. */
function buildDbFreePhaseInputs({
	assignment,
	project,
	signal,
	sink,
	delivery,
	pm,
	reviewLedger,
	scheduleFollowUpReview,
	operatorToken,
	baseRunAgent,
}: DbFreePhaseInputsParams): AssignedPhaseInputs {
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
		// The DB-free injection seam: the phase's resolved delivery/PM providers plus
		// the operator token as the agent's `getToken`, so no phase reaches the secret
		// store or DB. Source ops run under the operator's own token; the metadata
		// writes it cannot perform ride the control-plane delivery API.
		delivery,
		pm,
		reviewLedger,
		scheduleFollowUpReview,
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
 * non-secret slice, source delivery uses the operator's own token, the reviewer /
 * PM metadata writes ride the control-plane delivery API under credentials that
 * stay on the server, and cancellation rides the shutdown signal alone. A phase
 * not in {@link SUPPORTED_DB_FREE_PHASES} is failed cleanly with a clear reason
 * rather than crashing on a DB/Redis access.
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
		// — see {@link SUPPORTED_DB_FREE_PHASES} for what a DB-free worker can run.
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
		const operatorDelivery = await deps.buildDelivery(project.repo, options.operatorToken);
		// Where a metadata write this worker cannot perform itself is delivered: the
		// control plane, authenticated by the worker's own credential (never a
		// project credential — those stay server-side, ADR-004 §2).
		const transport: DeliveryClientOptions = {
			controlPlaneUrl: options.controlPlaneUrl,
			workerCredential: options.workerCredential,
			fetchImpl: deps.fetchImpl,
		};

		sink.send({ type: 'task-progress', dispatchId, runId, phase, taskId, state: 'running' });

		const inputs = buildDbFreePhaseInputs({
			assignment,
			project,
			signal: controller.signal,
			sink,
			delivery: resolveDbFreeDelivery(phase, operatorDelivery, transport, project.id),
			pm: resolveDbFreePm(phase, project, transport),
			reviewLedger: resolveDbFreeReviewLedger(phase, project.id, transport),
			scheduleFollowUpReview: resolveDbFreeFollowUpReview(phase, project.id, transport),
			operatorToken: options.operatorToken,
			baseRunAgent: deps.baseRunAgent,
		});
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
