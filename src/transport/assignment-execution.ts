/**
 * The transport assignment-execution substrate — how a pushed `TaskAssignment`
 * is run (ADR-003 §2), plus the pure framing helpers the back-channel is built
 * from.
 *
 * **This is the only executor.** It used to be one of two: a same-host client
 * (`../worker/transport-client.ts`) resolved persona tokens from Postgres for the
 * control-plane host, while this one served remote workers. Issue #551 deleted
 * that second program and pointed the host's worker at the same DB-free
 * entrypoint every other machine uses (`./connect-entry.ts`), connected over
 * loopback — so "same host" is now a network distance rather than a code path.
 *
 * {@link runAssignmentDbFree} runs entirely from the assignment itself: the
 * project config is reconstructed from the non-secret slice
 * (`./db-free-project.ts`), source-carrying delivery uses the operator's own
 * credential through the registered SCM provider
 * (`SCMProvider.operatorDeliveryProvider`, `../scm/types.ts`), and the two kinds of
 * metadata write the operator token *cannot* perform — a review under the
 * project's reviewer PAT, a board write under its PM credential — ride the
 * control-plane delivery API instead (`./delivery-client.ts`, ADR-004 §2). A
 * supported-phase gate cleanly fails any phase not yet runnable this way, so a
 * premature push fails with a clear result rather than crashing on a DB/Redis
 * access. A second pre-flight gate beside it refuses an assignment for a
 * repository this worker's checkout is not (issue #688), which enrollment being
 * per `(worker, project)` otherwise makes reachable.
 *
 * Cancellation needs no Redis (issue #549): the in-flight registry below indexes
 * each running assignment by `dispatchId`, a pushed `task-cancel` frame aborts the
 * matching run's signal, and the run settles terminal-`failed` with
 * `cancelled: true`.
 *
 * Live output is the one thing this executor does not persist: it streams
 * `stream-log` frames and the control plane writes them to `run_output_events`
 * (`../router/stream-log-persistence.ts`), so a run's output looks the same
 * wherever it ran.
 */

import type { ProjectConfig } from '../config/schema.js';
import { runAgentCli } from '../harness/agent-cli.js';
import { AgentRunError, agentRunError } from '../harness/agent-failure.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { describeError } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { tryReadCheckpoint } from '../pipeline/checkpoint.js';
import { DependencyBlockedError } from '../pipeline/dependency-guard.js';
import type { ScheduleFollowUpReview } from '../pipeline/follow-up-review.js';
import { phaseLabel } from '../pipeline/phase-label.js';
import type { ReviewVerdictLedger } from '../pipeline/review-ledger.js';
import { createWriteOnlyTransportPmProvider } from '../pm/transport-delivery.js';
import type { PMProvider, WorkItem, WorkItemBlocker } from '../pm/types.js';
import { phaseRecoveryFromAssignment } from '../queue/jobs.js';
import { DeliveryDeferredError, type ScmDeliveryProvider } from '../scm/delivery.js';
import { repoSlugsMatch } from '../scm/repo-slug.js';
import { createTransportScmDeliveryProvider } from '../scm/transport-delivery.js';
import {
	type AssignedPhaseInputs,
	type DeferrableFailure,
	type PhaseRunResult,
	retryDelayForFailure,
	runAssignedPhase,
} from '../worker/consumer.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import { HEARTBEAT_MS, stillRunningLine } from '../worker/live-output.js';
import { linkRunAbortController } from '../worker/run-cancellation.js';
import { createHostLocalWorktreeRuntime } from '../worktree/host-local-runtime.js';
import { reconstructProjectConfig } from './db-free-project.js';
import type { DeliveryClientOptions, FetchLike } from './delivery-client.js';
import { createTransportFollowUpReviewScheduler } from './follow-up-review-delivery.js';
import type {
	AssignedWorkItem,
	StreamLogLine,
	TaskAssignment,
	TaskCancel,
	TaskExecutionResult,
	TaskPhase,
} from './protocol.js';
import { createTransportReviewLedger } from './review-ledger-delivery.js';
import type { AssignmentSink, TransportLogger } from './worker-client.js';

/** Batch window/size for forwarded output — mirrors `../worker/live-output.ts`. */
const BATCH_MS = 100;
const BATCH_SIZE = 100;

/**
 * How long a Claude run may stay silent before the live log says so (issue #356).
 * Claude can work for minutes without emitting a readable event (one long tool
 * call), and on the run page that is indistinguishable from a hung process. It
 * lives here, on the streaming wrapper both executors share, rather than in the
 * worker-local batcher that used to append it: since the control plane owns the
 * `run_output_events` write (`../router/stream-log-persistence.ts`), a line only
 * reaches the run page by travelling as a `stream-log` — which is also what finally
 * gives a remote worker the heartbeat. The in-process BullMQ path keeps its own
 * copy in `../worker/live-output.ts`, which does not go through this wrapper.
 * Claude-only, and an internal constant rather than a setting: it exists to make
 * "alive" legible, not to be tuned.
 */
// Interval and rendered line both come from `../worker/live-output.ts` so the two
// paths cannot drift on a user-visible string (issue #544 review, F3).

/** Map the transport's serialization subset back to a PM `WorkItem` for the phase runner. */
export function fromAssignedWorkItem(item: AssignedWorkItem): WorkItem {
	return {
		id: item.id,
		title: item.title,
		description: item.description,
		url: item.url,
		taskRef: item.taskRef,
		taskRepository: item.taskRepository,
		status: item.status,
		statusId: item.statusId,
		statusKey: item.statusKey,
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
 * `../worker/live-output.ts`'s DB batcher, and, since the control plane took over
 * the `run_output_events` write (`../router/stream-log-persistence.ts`), the only
 * way a transport-dispatched run's output reaches the run page. `base` is the
 * underlying runner: **both** executors pass the raw `runAgentCli`, so neither
 * persists locally and no line is written twice. Injectable so a test can drive
 * the forwarding without a real CLI.
 *
 * A silent Claude run emits the {@link HEARTBEAT_MS} "still running" line as an
 * ordinary streamed line, so it lands in the same output stream as everything else.
 */
export function createAssignmentRunAgent(
	assignment: TaskAssignment,
	sink: AssignmentSink,
	base: typeof runAgentCli,
): typeof runAgentCli {
	return async (options) => {
		let queue: StreamLogLine[] = [];
		let timer: ReturnType<typeof setTimeout> | undefined;
		let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
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
		const stopHeartbeat = (): void => {
			if (heartbeatTimer) clearTimeout(heartbeatTimer);
			heartbeatTimer = undefined;
		};
		const armHeartbeat = (): void => {
			if (options.cli !== 'claude') return;
			stopHeartbeat();
			heartbeatTimer = setTimeout(() => {
				enqueue('stdout', stillRunningLine());
				armHeartbeat();
			}, HEARTBEAT_MS);
		};

		armHeartbeat();
		try {
			return await base({
				...options,
				onStdout: (line) => {
					armHeartbeat();
					options.onStdout?.(line);
					enqueue('stdout', line);
				},
				onStderr: (line) => {
					armHeartbeat();
					options.onStderr?.(line);
					enqueue('stderr', line);
				},
			});
		} finally {
			// Flush whatever the run produced before it settled, even on the throwing
			// paths — the same "preserve the last output" contract `../worker/live-output.ts` keeps.
			// Stop the heartbeat first, so a settled run never emits one more line.
			stopHeartbeat();
			flush();
		}
	};
}

/**
 * What {@link classifyDeferrable} reports. Beyond the shared
 * {@link DeferrableFailure} kinds it models the dependency block (issue #438),
 * which is not an agent or delivery failure at all: the item's prerequisites are
 * still open, so the run waits on the control plane's token-free recheck budget
 * rather than a retry budget. It carries the open blockers, because the control
 * plane rebuilds the error from them.
 */
export type DeferrableAssignmentFailure =
	| DeferrableFailure
	| { kind: 'dependency'; blockers: WorkItemBlocker[] };

/**
 * Classify a phase failure into the deferrable failure the control plane should
 * wait on, or `undefined` for a terminal failure — the exact rule the in-process
 * `handlePhaseFailure` applies (`../worker/consumer.ts`): a dependency block, a
 * rate-limit, capacity, aborted, or stalled agent error, a genuinely-interrupted
 * timeout (non-zero/absent exit — a clean SIGTERM exit already cleaned up), or a
 * deterministic-delivery deferral.
 *
 * An `auth` failure is deliberately absent (issue #343): the remote CLI is logged
 * out, so it settles terminal-`failed` carrying the already-suffixed
 * `(authentication failed)` message — the same actionable headline the in-process
 * path produces. That also keeps it out of the `deferred` frame, whose
 * unrecognised-kind fallback on the control plane re-reads a kind it doesn't model
 * as a `rate-limit` retry (`../router/dispatcher.ts`).
 */
export function classifyDeferrable(err: unknown): DeferrableAssignmentFailure | undefined {
	if (err instanceof DependencyBlockedError) return { kind: 'dependency', blockers: err.blockers };
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

/**
 * The exit metadata of the agent run this failure carries, for its terminal frame
 * (issue #596): the worker holds the real `AgentCliResult` on {@link AgentRunError.agent}
 * at settle time, and sending none of it is what left the control plane inventing
 * `exit 1 / 0 ms / not timed out` over a 30-minute wall-clock kill. A failure that
 * ran no agent (a delivery deferral, a dependency block, a worktree/setup error)
 * reports nothing, so the run records "unknown" rather than a placeholder.
 */
function reportedAgentExit(
	err: unknown,
): Pick<TaskExecutionResult, 'exitCode' | 'signal' | 'timedOut' | 'durationMs'> {
	if (!(err instanceof AgentRunError) || err.agent === undefined) return {};
	const { exitCode, signal, timedOut, durationMs } = err.agent;
	return { exitCode, signal, timedOut, durationMs };
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
		// The PR an Implementation run produced, so the control plane can record the
		// worker→PR attribution this worker may have no DB to write (ADR-004 §4,
		// issue #398). Absent for every phase that creates no PR.
		prUrl: result.prUrl,
	};
}

/** One in-flight assignment this worker can still abort, plus whether it was. */
interface CancellableAssignment {
	controller: AbortController;
	/**
	 * Set by {@link cancelAssignment} before it aborts, so the executor's `catch`
	 * can tell a user termination from an ordinary abort. Without it the abort
	 * arrives as a plain `aborted` `AgentRunError`, which {@link classifyDeferrable}
	 * would defer — re-running the very phase the user killed.
	 */
	cancelled: boolean;
}

/**
 * The assignments currently executing in *this* worker process, keyed by
 * `dispatchId` — the bridge between a pushed `task-cancel` frame and the
 * per-run `AbortSignal` threaded into the phase runner (issue #549). It mirrors
 * `../worker/run-cancellation.ts`'s run-id registry, but keyed the way the
 * transport addresses work and with no Redis behind it: a DB-free worker learns
 * about a cancellation only from the frame.
 *
 * Module-level rather than per-run, so `./connect-entry.ts` can resolve a cancel
 * against whichever of this daemon's in-flight assignments it names.
 */
const cancellableAssignments = new Map<string, CancellableAssignment>();

/** Make an in-flight assignment cancellable; call {@link untrackAssignment} when it settles. */
export function trackAssignment(dispatchId: string, controller: AbortController): void {
	cancellableAssignments.set(dispatchId, { controller, cancelled: false });
}

/** Drop a settled assignment from the registry (called from the executor's `finally`). */
export function untrackAssignment(dispatchId: string): void {
	cancellableAssignments.delete(dispatchId);
}

/**
 * Abort the in-flight assignment for `dispatchId`, if it is running here, and mark
 * it cancelled so it settles terminal-`failed` rather than deferring. Returns
 * whether one was found — `false` means this worker is not running that dispatch
 * (it already settled, or was never pushed here), in which case the frame is a
 * no-op and the control plane's durable marker still governs the run.
 */
export function cancelAssignment(dispatchId: string): boolean {
	const entry = cancellableAssignments.get(dispatchId);
	if (!entry) return false;
	entry.cancelled = true;
	entry.controller.abort();
	return true;
}

/** Whether the assignment for `dispatchId` was cancelled by a pushed `task-cancel`. */
export function isAssignmentCancelled(dispatchId: string): boolean {
	return cancellableAssignments.get(dispatchId)?.cancelled === true;
}

/**
 * Apply a pushed `task-cancel` frame — the `onCancel` handler `./connect-entry.ts`
 * registers. It lives beside the registry it reads, and answers an unknown
 * dispatch with an ordinary, non-fatal miss rather than an error.
 */
export function handleTaskCancel(frame: TaskCancel, logger: TransportLogger = defaultLogger): void {
	const context = { dispatchId: frame.dispatchId, runId: frame.runId, reason: frame.reason };
	if (cancelAssignment(frame.dispatchId)) {
		logger.info('aborting in-flight assignment after a cancellation request', context);
		return;
	}
	logger.info('ignoring task-cancel — that assignment is not running here', context);
}

/**
 * Build the terminal frame for an assignment a `task-cancel` stopped: `failed`
 * with `cancelled: true`, which `../router/dispatcher.ts` turns back into a
 * `RunTerminatedError` so the shared settle path treats it as the user
 * termination it is — never a deferral, which would re-run the killed phase.
 *
 * It carries no `error`: the control plane substitutes its own neutral
 * `RUN_CANCELLED_MESSAGE` (issue #305) for an absent one, which is exactly the
 * wording this used to send, and sourcing the constant here would put
 * `../queue/cancellation.ts` — a Redis module — back on a DB-free worker's import
 * path for a string the control plane already owns.
 */
function cancelledResult(assignment: TaskAssignment): TaskExecutionResult {
	return {
		type: 'task-execution-result',
		dispatchId: assignment.dispatchId,
		runId: assignment.runId,
		phase: assignment.phase,
		taskId: assignment.taskId,
		status: 'failed',
		cancelled: true,
	};
}

/**
 * The terminal frame for a failed assignment: the cancelled settlement above when
 * a `task-cancel` stopped this dispatch, otherwise the classified
 * failure/deferral. One helper so both executors settle a cancellation
 * identically (issue #549).
 */
export function settleAssignmentFailure(
	err: unknown,
	assignment: TaskAssignment,
	worktreePath?: string,
): TaskExecutionResult {
	if (isAssignmentCancelled(assignment.dispatchId)) return cancelledResult(assignment);
	return deferrableOrFailedResult(err, assignment, worktreePath);
}

/**
 * Build the terminal failure/deferral frame for a non-cancelled failure: a
 * deferrable failure settles `deferred` with the retry hint + resume flags a
 * `phase-deferred` outcome carries; a dependency block settles `deferred` too, but
 * reports the open prerequisites instead of a delay (issue #438); everything else
 * settles terminal-`failed`. A *cancelled* run never reaches here — both executors
 * route through {@link settleAssignmentFailure}, which answers a `task-cancel`
 * with the terminal cancelled frame before this classification could defer the
 * abort it caused.
 *
 * `worktreePath` is this task's checkout on *this* host, present once the assignment
 * got far enough to reconstruct the project. It is what lets a remote worker report
 * the same Tier 2 settle the in-process one does (issue #503): the control plane owns
 * the continuation policy and its budget but cannot read this filesystem, so the
 * worker parses the checkpoint the stopped agent left behind and attaches it to the
 * deferral. Read for the same `rate-limit`/`timeout`/`stalled` set that preserves the
 * checkout at all, so a failure that discards the worktree never reports one.
 *
 * Every frame this builds also reports the exit metadata of the agent run the failure
 * carried, when it carried one ({@link reportedAgentExit}, issue #596), so the run row
 * records the same stop the `error` describes.
 */
export function deferrableOrFailedResult(
	err: unknown,
	assignment: TaskAssignment,
	worktreePath?: string,
): TaskExecutionResult {
	const error = describeError(err);
	const terminal = {
		type: 'task-execution-result' as const,
		dispatchId: assignment.dispatchId,
		runId: assignment.runId,
		phase: assignment.phase,
		taskId: assignment.taskId,
		// Shared by all three returns below, so a deferral and a terminal failure report
		// the stop identically, and the two error types that never hold an agent result
		// (a delivery deferral, a dependency block) contribute nothing.
		...reportedAgentExit(err),
	};
	const failure = classifyDeferrable(err);
	if (failure?.kind === 'dependency') {
		return {
			...terminal,
			status: 'deferred',
			// The recheck cadence and budget live with the dispatch record on the control
			// plane (`deferDependencyBlock`, `../worker/consumer.ts`), so the worker reports
			// the block — and the blockers its message must name — rather than a delay of
			// its own. 0 mirrors the synthetic deferral frame in `../router/dispatch-results.ts`.
			retryDelayMs: 0,
			resumable: false,
			failureKind: 'dependency',
			reason: error,
			blockers: failure.blockers,
		};
	}
	if (failure) {
		const resumable =
			failure.kind === 'rate-limit' || failure.kind === 'timeout' || failure.kind === 'stalled';
		return {
			...terminal,
			status: 'deferred',
			retryDelayMs: retryDelayForFailure(failure, Date.now()),
			resumable,
			resumeDelivery: failure.kind === 'delivery' || undefined,
			failureKind: failure.kind,
			reason: error,
			// The control plane decides whether this becomes a checkpoint continuation
			// (Tier 1 keeps priority, and the continuation budget lives with the dispatch
			// record); the worker only reports what it can see on its own disk.
			checkpoint: resumable && worktreePath ? tryReadCheckpoint(worktreePath) : undefined,
		};
	}
	return { ...terminal, status: 'failed', error };
}

/**
 * The pipeline phases a DB-free worker can run — since issue #536, **all six**, so
 * which phases an instance can run no longer depends on which machine a worker
 * happens to be. Each, and how it is delivered:
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
 *   never hold, and its three review-verdict ledger calls (the verdict cap
 *   and the re-review signal) go through the control-plane ledger routes, which
 *   own the `review_verdicts` table this worker has no database for.
 * - `respond-to-review` — the fix commit, its push, and the response comment are
 *   the *implementer's*, so they stay on the operator token exactly as
 *   Implementation's do; what travels is the best-effort board report (resolve
 *   the card by its backing issue URL, then move it In progress → In review)
 *   under the PM credential, and the follow-up-Review enqueue a pushed fix owes
 *   (issue #241), which needs the dispatch store and queue this worker has
 *   neither of.
 * - `planning` — the agent run, the plan file it writes and the deterministic
 *   scope gate are all worker-side; every board operation rides the delivery API
 *   under the project's PM credential. That is a wider PM surface than any other
 *   phase's (post the plan, re-scope the parent, create each split child, embed its
 *   preplan marker, move it, label it, chain its dependency edges, and find its own
 *   plan comment on a replay), which is why ADR-003 originally deferred it — but
 *   width alone was never a boundary violation: no project credential crosses the
 *   wire, every write is idempotent or best-effort at the provider, and the split's
 *   replay guard (`findComment` on the plan-delivery marker) is one of the calls
 *   that travels, so a retry still short-circuits before re-creating a child. The
 *   alternative — Planning running only where the database is — pinned the whole
 *   instance to one machine (issue #536).
 */
export const SUPPORTED_DB_FREE_PHASES: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
	'respond-to-ci',
	'resolve-conflicts',
	'implementation',
	'review',
	'respond-to-review',
	'planning',
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
 * routing it through a composite built for the reviewer persona would have the
 * reviewer answering its own review, and the author-persona routing that decides
 * what a comment event means (`SCMProvider.personaForActor`, `../scm/types.ts`)
 * would read the wrong persona off it. The composite states `persona: 'reviewer'`
 * explicitly, so the frame carries the identity this Review write runs under
 * rather than leaving the server to infer one (issue #444).
 */
function resolveDbFreeDelivery(
	phase: TaskPhase,
	operator: ScmDeliveryProvider,
	transport: DeliveryClientOptions,
	projectId: string,
): ScmDeliveryProvider {
	if (phase !== 'review') return operator;
	return createTransportScmDeliveryProvider({
		...transport,
		projectId,
		persona: 'reviewer',
		localDelegate: operator,
	});
}

/** The phases that act on a board card, and so need a PM provider injected. */
const BOARD_DRIVEN_DB_FREE_PHASES: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
	'planning',
	'implementation',
	'respond-to-review',
]);

/**
 * The PM provider a DB-free phase runs against, or `undefined` for a phase that
 * takes none (review / respond-to-ci / resolve-conflicts — `runAssignedPhase`
 * then constructs nothing). Every board-driven phase gets the same delegate-less
 * transport writer: its board writes ride the delivery API under the server-held
 * PM credential, as do the four narrow reads it serves — Implementation's
 * `listBlockers`, Respond-to-review's card lookups, and Planning's `findComment`
 * replay guard. The two enumerating reads still refuse, because the control plane
 * performed the reads this assignment was composed from.
 */
function resolveDbFreePm(
	phase: TaskPhase,
	project: ProjectConfig,
	transport: DeliveryClientOptions,
): PMProvider | undefined {
	if (!BOARD_DRIVEN_DB_FREE_PHASES.has(phase)) return undefined;
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
 * disable the review-verdict cap (issue #235) and prompt every re-review as a first
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
 * phase-runner switch and the registered provider's operator-credential delivery;
 * a unit test injects fakes so it can drive succeeded/deferred/failed settlements
 * without a real agent CLI or a live provider client — and, by never providing a
 * DB, prove the path touches neither Postgres nor Redis.
 */
export interface DbFreeAssignmentDeps {
	runPhase: (inputs: AssignedPhaseInputs) => Promise<PhaseRunResult>;
	/**
	 * Build the operator-credential delivery provider for a repo. Omitted in
	 * production, where it resolves through the registry
	 * ({@link resolveOperatorDelivery}); kept provider-free — `(repo, credential)`,
	 * no `ProjectConfig` — so a test injects a stub without standing up a manifest.
	 */
	buildDelivery?: (repo: string, credential: string) => Promise<ScmDeliveryProvider>;
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
		buildDelivery: overrides.buildDelivery,
		baseRunAgent: overrides.baseRunAgent ?? runAgentCli,
		fetchImpl: overrides.fetchImpl,
		logger: overrides.logger ?? defaultLogger,
	};
}

/**
 * Build the operator-credential delivery provider every DB-free phase runs its
 * source-carrying ops on, through the project's registered SCM provider
 * (`SCMProvider.operatorDeliveryProvider`, `../scm/types.ts`) rather than by
 * naming a concrete one (ai/RULES.md §2, issue #462). The registry is populated by
 * the entrypoint import in `./connect-entry.ts`.
 *
 * Resolved here — the one place holding the reconstructed project — rather than in
 * {@link resolveDbFreeDeps}, which runs before the project exists and must stay
 * able to log a duplicate ack without one. That also keeps
 * {@link DbFreeAssignmentDeps.buildDelivery} on its provider-free
 * `(repo, credential)` shape.
 */
function resolveOperatorDelivery(
	project: ProjectConfig,
	credential: string,
	override: DbFreeAssignmentDeps['buildDelivery'],
): Promise<ScmDeliveryProvider> {
	if (override) return override(project.repo, credential);
	return requireProjectSCMProvider(project).operatorDeliveryProvider(project.repo, credential);
}

/** Options {@link runAssignmentDbFree} reads. */
export interface RunAssignmentDbFreeOptions {
	/** Absolute path to this worker host's checkout of the assigned repository. */
	repoRoot: string;
	/**
	 * Which repository {@link RunAssignmentDbFreeOptions.repoRoot} actually is, as
	 * this daemon declared it at handshake (issue #687) — the fact the pre-flight
	 * check below refuses a mismatched assignment on. Absent when the checkout could
	 * not be identified (no `origin`, a remote no slug reads from), in which case
	 * nothing is refused here.
	 *
	 * Passed in rather than re-read per assignment: `./connect-entry.ts` resolves it
	 * once at startup for the handshake, and re-reading would only invite this
	 * worker's two answers to differ.
	 */
	checkoutRepository?: string;
	/**
	 * The worker operator's own account credential for the project's SCM provider,
	 * resolved from this machine's environment by `./connect-entry.ts`
	 * (`SWARM_OPERATOR_GH_TOKEN` on GitHub) — never a project credential.
	 *
	 * **This is the agent's identity on every worker, not a fallback for the ones
	 * without a database** (ADR-004 §2; issue #551 made it universal by retiring the
	 * control-plane host's own second executor). The implementer identity *is* the
	 * worker operator's own account: it authors the branch, the commits, the pull
	 * request and the implementer-side comments, and the loop-prevention split still
	 * holds because it is a different account from the project's reviewer PAT. Two
	 * consequences worth stating where they bite:
	 *
	 * - `credentials.implementer` is not read anywhere on this path — it is not even
	 *   in `ScmCredentialReferencesSchema` any more (issue #396), so there is no
	 *   per-project persona token for the agent to resolve from Postgres, on any
	 *   host. What changes with a project is the repository, not who commits to it.
	 * - The identities that must stay per-project — the **reviewer** PAT and the
	 *   **PM** credential — never reach a worker at all: those writes ride the
	 *   control-plane delivery API (`./delivery-client.ts`), so a submitted review's
	 *   author and a board write's actor are unchanged by which machine ran the phase.
	 */
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
	/** Collaborators (defaulted to the shared phase runner + registry-resolved operator delivery). */
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
	worktrees: GitWorktreeManager;
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
	worktrees,
}: DbFreePhaseInputsParams): AssignedPhaseInputs {
	return {
		phase: assignment.phase,
		taskId: assignment.taskId,
		project,
		// Resolved control-plane side, where the run row that records it is written
		// (issue #683) — this worker has no DB to read that row from. The fallback
		// exists solely for router/worker version skew (a router predating the field
		// omits it) and is still correct for a multi-repository project: the
		// dispatcher scoped the project it sent to the job's own repository (issue
		// #699), so `project.repo` here is that repository, not the project's default
		// entry (issue #685).
		repository: assignment.repository ?? project.repo,
		cli: assignment.target.cli,
		model: assignment.target.model,
		reasoning: assignment.target.reasoning,
		customPrompt: assignment.customPrompt,
		timeoutMs: assignment.timeoutMs,
		// The whole recovery intent, resolved by the mapper the job payload owns
		// (`../queue/jobs.ts`) rather than re-derived here — the duplication that
		// let the wire and this executor disagree about `recoveryMode` (issue #591).
		recovery: phaseRecoveryFromAssignment(assignment),
		runId: assignment.runId,
		worktrees,
		signal,
		// Non-persisting base: lines stream over the transport and the control plane
		// writes them — this worker has no `run_output_events` table to write to.
		runAgent: createAssignmentRunAgent(assignment, sink, baseRunAgent),
		workItem: assignment.workItem ? fromAssignedWorkItem(assignment.workItem) : undefined,
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
		// Resolved control-plane side (issue #498) — this worker has no DB to read
		// the `runs.work_item_id` link from itself.
		boardItemId: assignment.boardItemId,
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
 * Execute one pushed `TaskAssignment` DB/Redis-free and stream its lifecycle back
 * through the sink: an immediate ack (marking a re-pushed dispatch a duplicate so
 * the control plane drops it), a `running` progress marker, batched live output,
 * and a terminal `TaskExecutionResult`. Idempotent by `dispatchId`: a re-pushed
 * assignment for a dispatch already running here keeps the in-flight run rather
 * than starting a second (ADR-003 §2). Never throws — every settlement is a frame.
 *
 * It reads no database and no queue, on any host: the project is reconstructed
 * from the assignment's non-secret slice, source delivery uses the operator's own
 * token, and the reviewer / PM metadata writes ride the control-plane delivery API
 * under credentials that stay on the server. That holds for the control-plane
 * host's own worker too — since issue #551 it runs this same path over loopback
 * rather than a second executor that read Postgres because it happened to be able
 * to. A user termination reaches it as a pushed `task-cancel`
 * ({@link cancelAssignment}) rather than a Redis read. A phase not in
 * {@link SUPPORTED_DB_FREE_PHASES} is failed cleanly with a clear reason rather
 * than crashing on a DB/Redis access.
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
	// Registered synchronously, before the first await, so a `task-cancel` pushed
	// straight after the assignment can never arrive ahead of the registration.
	trackAssignment(dispatchId, controller);
	// Resolved as soon as the project is, so the failure path below can read the Tier 2
	// checkpoint out of this host's checkout (issue #503). Still unset for a failure
	// that happened before there was a project — and so before there was a worktree.
	let worktreePath: string | undefined;
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

		// Refuse an assignment for a repository this worker's one checkout is not
		// (issue #688). Enrollment is per (worker, project), so a worker enrolled in
		// two projects with different repositories is pushed both — and this daemon
		// holds a single `repoRoot` to run them in. Checked before the project is
		// reconstructed, so the refusal names the two repositories that disagree
		// instead of surfacing as `assertRepoIdentity` failing deep inside worktree
		// provisioning, after a checkout has already been touched.
		//
		// Terminal `failed`, never `deferred`: no retry on *this* worker can make the
		// repositories match, so a deferral would re-push impossible work until the
		// budget ran out — the same reasoning the phase gate above applies.
		//
		// An absent declaration skips the check entirely, preserving today's behaviour
		// for a checkout that could not be identified; `assertRepoIdentity` still
		// refuses at provision time whenever it *can* identify one.
		const declaredRepository = options.checkoutRepository;
		const assignedRepository = assignment.projectConfig.repo;
		if (declaredRepository && !repoSlugsMatch(assignedRepository, declaredRepository)) {
			sink.send({
				type: 'task-execution-result',
				dispatchId,
				runId,
				status: 'failed',
				phase,
				taskId,
				error:
					`assignment for repository '${assignedRepository}' cannot run on this worker's ` +
					`checkout of '${declaredRepository}' (SWARM_WORKER_REPO_ROOT=${options.repoRoot}). ` +
					'Enroll a worker whose checkout is that repository, or point this one at it.',
			});
			return;
		}

		const project = reconstructProjectConfig(assignment.projectConfig, options.repoRoot);
		const worktrees = new GitWorktreeManager(
			project,
			createHostLocalWorktreeRuntime({
				repoRoot: project.repoRoot,
				worktreeRoot: project.worktreeRoot,
				ownerId: dispatchId,
				runId,
				isOwnerLive: (ownerId) => inFlight.has(ownerId),
				shutdownSignal: options.shutdownSignal,
			}),
		);
		worktreePath = worktrees.worktreePath(taskId);
		const operatorDelivery = await resolveOperatorDelivery(
			project,
			options.operatorToken,
			deps.buildDelivery,
		);
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
			worktrees,
		});
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
		// Logged because the *absence* of this line is the only evidence that a phase
		// finished its work and then never reported it — the failure that leaves a
		// dispatch waiting out `RESULT_WAIT_MARGIN_MS` and settles a successful run as
		// a timeout. The failure path below already logs; without this one, "did the
		// worker send its result?" cannot be answered from a worker log at all.
		deps.logger.info('assignment phase finished — sending result', {
			dispatchId,
			runId,
			phase,
			taskId,
		});
		sink.send(succeededResult(assignment, result));
	} catch (err) {
		deps.logger.warn('assignment phase failed', {
			dispatchId,
			phase,
			taskId,
			error: describeError(err),
		});
		sink.send(settleAssignmentFailure(err, assignment, worktreePath));
	} finally {
		detach();
		untrackAssignment(dispatchId);
		inFlight.delete(dispatchId);
	}
}
