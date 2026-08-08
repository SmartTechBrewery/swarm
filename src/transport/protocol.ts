/**
 * Wire protocol for the authenticated worker↔control-plane transport — the Zod
 * schemas that are the single source of truth for every frame crossing the
 * network (ai/CODING_STANDARDS.md "Zod is the source of truth"). The MVP carries
 * these over HTTP (the handshake, request/response) and a WebSocket (the
 * heartbeat stream) instead of the future gRPC pipe (PROJECT.md §3), but the
 * message *names* track that spec's `AgentMessage`/`CloudMessage` payloads —
 * `HandshakeRequest`/`HandshakeResponse`/`Heartbeat` — so a later gRPC engine can
 * adopt the same vocabulary without renaming.
 *
 * The session subset (ADR-003 §1) stands up an authenticated session and keeps
 * its `worker_sessions` lease live: handshake in both directions, plus the
 * heartbeat/ack/disconnect control frames. Split delivery (ADR-003 §2) then
 * adds the `TaskAssignment` cloud→worker frame below and the worker→cloud
 * back-channel frames it pairs with — `TaskAssignmentAck` / `StreamLog` /
 * `TaskProgress` / `TaskExecutionResult` (PROJECT.md §3) — so a connected worker
 * can acknowledge an assignment, stream its live output, and report the terminal
 * outcome the control plane settles the dispatch on.
 *
 * Capabilities are the harness's `AgentCli` vocabulary
 * (`../harness/agent-cli.ts`), never a parallel CLI enum — the same rule the
 * worker identity follows (`../identity/worker.ts`).
 */

import { z } from 'zod';
import { NonSecretProjectConfigSchema } from '../config/project-config-slice.js';
import { AgentTargetSchema } from '../config/schema.js';
import { AgentCliSchema } from '../harness/agent-cli.js';
import { CheckpointSchema } from '../pipeline/checkpoint.js';
import { RecoveryIntentSchema } from '../queue/jobs.js';
import { TriggerPhaseSchema } from '../triggers/types.js';

/**
 * Transport protocol version, sent in both handshake directions. A mismatch is
 * rejected cleanly at the handshake (a distinct 400) rather than left to surface
 * as a silent misparse of a frame shape the other side doesn't share. Bump this
 * whenever a frame shape changes incompatibly.
 */
export const TRANSPORT_PROTOCOL_VERSION = 1;

/**
 * Application-defined WebSocket close codes (the 4000–4999 range reserved for
 * private use) the `/worker/stream` transport uses. Part of the wire contract, so
 * they live here alongside the frame schemas: the router
 * (`../router/worker-transport.ts`) closes with them and the worker client
 * (`./worker-client.ts`) classifies a close by them — `UNAUTHORIZED` is fatal (a
 * fresh handshake won't fix a rejected credential/token), while `LEASE_LOST` and
 * `MALFORMED_FRAME` are recoverable by reconnecting (a fresh handshake re-acquires
 * the lease with a bumped fencing token).
 */
export const WS_CLOSE = {
	/** A frame did not parse as a known worker→cloud message. */
	MALFORMED_FRAME: 4400,
	/** The upgrade carried no credential or one that resolves to no worker. */
	UNAUTHORIZED: 4401,
	/** A heartbeat could not refresh the lease — lost, expired, or superseded. */
	LEASE_LOST: 4408,
} as const;

/**
 * Optional, best-effort host-health telemetry a worker may attach to a
 * heartbeat — the transport equivalent of PROJECT.md §3's `Heartbeat` fields.
 * Purely advisory for now (nothing in this phase consumes it); every field is
 * optional so an older/leaner daemon can heartbeat without reporting any.
 */
export const WorkerHealthSchema = z.object({
	/** Recent CPU load as a percentage in [0, 100]. */
	cpuLoadPercent: z.number().min(0).max(100).optional(),
	/** Available RAM in bytes. */
	availableRamBytes: z.number().int().nonnegative().optional(),
});
export type WorkerHealth = z.infer<typeof WorkerHealthSchema>;

/**
 * The transport's name for the pipeline phase vocabulary. It *is* the pipeline's
 * validator (`TriggerPhaseSchema`, `../triggers/types.ts`) rather than a
 * re-declaration, so the transport enum and the phase union cannot drift apart —
 * adding a phase there propagates here with no edit. The alias is kept because
 * `TaskPhase`/`TaskPhaseSchema` is the vocabulary every frame shape below is
 * written in.
 */
export const TaskPhaseSchema = TriggerPhaseSchema;
export type TaskPhase = z.infer<typeof TaskPhaseSchema>;

/**
 * `POST /worker/session` request body — the handshake that opens an authenticated
 * session. The raw `credential` authenticates the worker against the roster
 * (never logged, never echoed back); `capabilities` is the CLI set the daemon
 * declares it can run, applied to the worker on connect. `daemonVersion` and
 * `hostname` are diagnostic. Connect-time health is implicit in a successful
 * handshake; ongoing health rides the heartbeat.
 *
 * `supportedPhases` is the second capability axis (issue #467): *which pipeline
 * phases* this daemon can actually execute, not just which CLIs it has. Every
 * daemon runs the same program now (`./connect-entry.ts`, issue #551) and declares
 * `SUPPORTED_DB_FREE_PHASES` (`./assignment-execution.ts`), which since issue #536
 * is all six — but a daemon's *version* is what decides that, and daemons are
 * upgraded independently of the control plane, so an older one still declares
 * fewer. Without this the eligibility gate could select a worker for a phase it
 * refuses, failing the dispatch terminally instead of routing it to a capable
 * worker.
 *
 * **Optional on purpose.** A daemon built before this field simply omits it; the
 * router then treats it as "every phase", which is exactly the behaviour that
 * pre-dated the field. That keeps a version skew from silently narrowing an older
 * worker's eligibility, so the field needs no protocol-version bump: it is an
 * additive, backward-compatible frame change (see {@link TRANSPORT_PROTOCOL_VERSION},
 * which is reserved for *incompatible* shape changes).
 */
export const HandshakeRequestSchema = z.object({
	credential: z.string().min(1),
	daemonVersion: z.string().min(1),
	hostname: z.string().min(1),
	capabilities: z.array(AgentCliSchema).nonempty(),
	supportedPhases: z.array(TaskPhaseSchema).nonempty().optional(),
	protocolVersion: z.number().int(),
});
export type HandshakeRequest = z.infer<typeof HandshakeRequestSchema>;

/**
 * `POST /worker/session` success body. Carries the acquired lease's identifiers
 * — `sessionId` and the `fencingToken` the daemon must present on every
 * subsequent heartbeat — plus the `heartbeatTtlMs` that governs how long the
 * lease stays live between heartbeats. A failed handshake never uses this shape;
 * it returns a constant-shape error body (see `../router/worker-transport.ts`)
 * that never reflects the credential.
 */
export const HandshakeResponseSchema = z.object({
	authenticated: z.literal(true),
	workerId: z.string().uuid(),
	sessionId: z.string().uuid(),
	fencingToken: z.number().int().positive(),
	heartbeatTtlMs: z.number().int().positive(),
	protocolVersion: z.number().int(),
});
export type HandshakeResponse = z.infer<typeof HandshakeResponseSchema>;

/**
 * Worker→cloud heartbeat frame carried on `GET /worker/stream`. Presents the
 * `fencingToken` from the handshake so the control plane refreshes only the
 * lease this daemon actually holds; a stale/superseded token refreshes nothing.
 * `health` is optional advisory telemetry.
 */
export const HeartbeatSchema = z.object({
	type: z.literal('heartbeat'),
	fencingToken: z.number().int().positive(),
	health: WorkerHealthSchema.optional(),
});
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

/** Cloud→worker acknowledgement that a heartbeat refreshed the live lease. */
export const HeartbeatAckSchema = z.object({
	type: z.literal('heartbeat-ack'),
});
export type HeartbeatAck = z.infer<typeof HeartbeatAckSchema>;

/**
 * Cloud→worker control frame telling the daemon its session is over — sent just
 * before the socket closes when a heartbeat cannot refresh the lease (it was
 * lost, expired, or superseded by a newer daemon). `reason` is human-readable
 * for the daemon's log; it never carries the credential.
 */
export const DisconnectSchema = z.object({
	type: z.literal('disconnect'),
	reason: z.string(),
});
export type Disconnect = z.infer<typeof DisconnectSchema>;

/**
 * The transport's serialization view of a PM `WorkItem` (`../pm/types.ts`) — the
 * fields a planning/implementation phase reads on the worker, as a Zod schema (a
 * `WorkItem` is a plain interface, so it has no schema of its own). Deliberately
 * a tight subset: a field a future phase needs on the worker must be added here
 * too. Nothing on a `WorkItem` is secret, so this drops nothing sensitive.
 */
export const AssignedWorkItemSchema = z.object({
	id: z.string().min(1),
	title: z.string(),
	description: z.string(),
	url: z.string(),
	/**
	 * The card's SCM artifact reference (`WorkItem.taskRef`) the provider resolved —
	 * what SWARM keys the worktree/branch/PR on (ai/ARCHITECTURE.md "Task identity").
	 */
	taskRef: z.string().optional(),
	status: z.string().optional(),
	statusId: z.string().optional(),
	/** The canonical pipeline status key (`WorkItem.statusKey`) the provider resolved. */
	statusKey: z.string().optional(),
	labels: z.array(z.object({ id: z.string(), name: z.string(), color: z.string().optional() })),
	assignees: z.array(
		z.object({
			handle: z.string(),
			displayName: z.string().optional(),
			providerId: z.string().optional(),
		}),
	),
});
export type AssignedWorkItem = z.infer<typeof AssignedWorkItemSchema>;

/**
 * Cloud→worker frame assigning one pipeline phase to a connected worker. It
 * carries everything the worker's phase runner needs to execute and settle the
 * dispatch idempotently: the work-item payload (or PR coordinates, per phase),
 * the already-resolved target branch, the already-composed system prompt, the
 * routing `target`, and the NON-SECRET project-config slice — never a persona
 * token or a credential reference.
 *
 * The secret boundary is enforced by the builder (`./assignment.ts`), which
 * derives `projectConfig` from the full config itself; this schema simply types
 * the wire shape. `targetBranch` and `systemPrompt` arrive already computed (the
 * control plane composes them — phase 4), so this frame is a pure data carrier.
 */
export const TaskAssignmentSchema = z.object({
	type: z.literal('task-assignment'),
	protocolVersion: z.number().int(),
	dispatchId: z.string().uuid(),
	runId: z.string().uuid().optional(),
	phase: TaskPhaseSchema,
	taskId: z.string().min(1),
	projectConfig: NonSecretProjectConfigSchema,
	targetBranch: z.string().min(1),
	systemPrompt: z.string().min(1),
	customPrompt: z.string().optional(),
	target: AgentTargetSchema,
	timeoutMs: z.number().int().positive().optional(),
	// Session threading / resume: the run's whole recovery intent, spread from the
	// single declaration the job payload also spreads (`RecoveryIntentSchema`,
	// `../queue/jobs.ts`) rather than restated member by member — which is how
	// `recoveryMode` went missing here and left every Tier 2 continuation to
	// silently start over (issue #591). Additive in both directions, so
	// `TRANSPORT_PROTOCOL_VERSION` is deliberately not bumped: an older worker
	// ignores a member it does not know, and an older router simply omits it.
	...RecoveryIntentSchema.shape,
	// The one member the wire deliberately types *looser* than the job payload
	// does. A session id reaches here from a `runs` row the control plane already
	// accepted (`tryReuseLatestRun`, `../worker/consumer.ts`), so re-validating its
	// shape at this seam would fail the whole dispatch over a value whose only use
	// is to be handed to a CLI as a resume id.
	agentSessionId: z.string().optional(),
	// Phase-specific inputs — mirror `TriggerResult` (`src/triggers/types.ts`):
	// planning/implementation carry `workItem`; the PR phases carry the PR
	// coordinates, with `reviewId` only for respond-to-review and
	// `baseBranch`/`baseSha` only for resolve-conflicts.
	workItem: AssignedWorkItemSchema.optional(),
	prNumber: z.string().optional(),
	prBranch: z.string().optional(),
	headSha: z.string().optional(),
	reviewId: z.string().optional(),
	/**
	 * respond-to-review only: the board card the PR's task was dispatched from,
	 * resolved control-plane side from the durable `runs.work_item_id` link (issue
	 * #498) so the worker needs no database to report board status (ADR-003 §2).
	 * Absent when nothing links the task to a card.
	 */
	boardItemId: z.string().optional(),
	baseBranch: z.string().optional(),
	baseSha: z.string().optional(),
});
export type TaskAssignment = z.infer<typeof TaskAssignmentSchema>;

/**
 * Cloud→worker control frame asking the daemon to abort one in-flight
 * {@link TaskAssignmentSchema} — the transport half of the dashboard's Terminate
 * action (issue #166). The control plane records the durable cancellation marker
 * and publishes it (`../queue/cancellation.ts`); the dispatcher turns that
 * notification into this frame, addressed to the worker it actually pushed the
 * dispatch to (`../router/dispatch-cancellation.ts`). The worker aborts the
 * matching run's `AbortSignal` — the same SIGTERM→SIGKILL path shutdown uses —
 * and settles the dispatch terminal-`failed` with `cancelled: true`, never
 * `deferred`, which would re-run the very phase the user killed.
 *
 * Keyed on `dispatchId`, which is what a worker indexes its in-flight assignments
 * by (`./assignment-execution.ts`); `runId` rides along for correlation and the
 * daemon's log. `reason` is human-readable for that log, exactly as
 * {@link DisconnectSchema}'s is, and never becomes the run's terminal message —
 * the control plane owns that wording (`RUN_CANCELLED_MESSAGE`).
 *
 * Additive, so `TRANSPORT_PROTOCOL_VERSION` is deliberately **not** bumped: a
 * daemon that predates the frame does not recognise it, and an unrecognised
 * control frame is a logged no-op there rather than a closed socket
 * (`./worker-client.ts`). A version skew therefore costs only the promptness this
 * frame buys — the durable marker still settles the run — whereas a bump would
 * reject every frame from an already-deployed worker.
 */
export const TaskCancelSchema = z.object({
	type: z.literal('task-cancel'),
	dispatchId: z.string().uuid(),
	runId: z.string().uuid().optional(),
	reason: z.string().optional(),
});
export type TaskCancel = z.infer<typeof TaskCancelSchema>;

/**
 * One captured agent-output line, the transport mirror of a `run_output_events`
 * row (`../worker/live-output.ts`): the `stream` it came from, its `content`
 * (newline-terminated, as the batcher stores it), and the ISO-8601 instant it
 * was emitted. Carried in batches by {@link StreamLogSchema}.
 */
export const StreamLogLineSchema = z.object({
	stream: z.enum(['stdout', 'stderr']),
	content: z.string(),
	emittedAt: z.string().min(1),
});
export type StreamLogLine = z.infer<typeof StreamLogLineSchema>;

/**
 * Worker→cloud frame carrying a batch of live output lines for an in-flight
 * assignment so the control plane can persist them to the run's output stream
 * exactly as the in-process worker's live-output batcher does. Lines are batched
 * (never one frame per line) to bound socket chatter, mirroring
 * `../worker/live-output.ts`'s `BATCH_MS`/`BATCH_SIZE` window.
 */
export const StreamLogSchema = z.object({
	type: z.literal('stream-log'),
	dispatchId: z.string().uuid(),
	runId: z.string().uuid().optional(),
	lines: z.array(StreamLogLineSchema).nonempty(),
});
export type StreamLog = z.infer<typeof StreamLogSchema>;

/**
 * A still-open prerequisite as it crosses the transport — the provider-neutral
 * `WorkItemBlocker` shape (`../pm/types.ts`). Shared by the two frames that carry
 * blockers: the `POST /worker/delivery/pm/blockers` response the dependency gate
 * reads ({@link ListBlockersDeliveryResponseSchema}), and the `dependency` deferral
 * a blocked run settles with (issue #438). No provider-specific field crosses the
 * wire (ai/RULES.md §2).
 */
export const WorkItemBlockerFrameSchema = z.object({
	id: z.string().min(1).optional(),
	reference: z.string().min(1),
	// Exactly as permissive as `WorkItemBlocker`, which allows an empty URL (the
	// GitHub adapter's `issue.html_url ?? ''`). A stricter wire schema would throw
	// here, and `findOpenBlockers` swallows a throw as "no blockers" — so tightening
	// this field could silently un-gate the very check this serves.
	url: z.string(),
	title: z.string(),
	open: z.boolean(),
	source: z.enum(['dependency', 'mention']),
});
export type WorkItemBlockerFrame = z.infer<typeof WorkItemBlockerFrameSchema>;

/**
 * Worker→cloud coarse progress marker for an in-flight assignment — the phase
 * lifecycle transitions the control plane surfaces on the board/run while the
 * agent works, distinct from the line-level {@link StreamLogSchema}. `running`
 * is emitted once the phase actually starts; `branch-provisioned` reports the
 * Implementation task-branch checkpoint so a re-pushed assignment can resume on
 * the existing branch (the transport mirror of `implementationBranchProvisioned`).
 */
export const TaskProgressSchema = z.object({
	type: z.literal('task-progress'),
	dispatchId: z.string().uuid(),
	runId: z.string().uuid().optional(),
	phase: TaskPhaseSchema,
	taskId: z.string().min(1),
	state: z.enum(['running', 'branch-provisioned']),
});
export type TaskProgress = z.infer<typeof TaskProgressSchema>;

/**
 * Worker→cloud acknowledgement that a pushed {@link TaskAssignmentSchema} was
 * received and accepted for execution. `duplicate` is true when this worker is
 * already running the same dispatch (a re-pushed assignment): the worker keeps
 * the in-flight run rather than starting a second, so the control plane can drop
 * the re-push instead of treating the silence as a lost assignment.
 */
export const TaskAssignmentAckSchema = z.object({
	type: z.literal('task-assignment-ack'),
	dispatchId: z.string().uuid(),
	runId: z.string().uuid().optional(),
	duplicate: z.boolean(),
});
export type TaskAssignmentAck = z.infer<typeof TaskAssignmentAckSchema>;

/**
 * Worker→cloud terminal frame settling a pushed {@link TaskAssignmentSchema}. It
 * mirrors the fields the in-process `JobOutcome` (`../worker/consumer.ts`) carries
 * so the control plane can settle the dispatch exactly as `processJob` does
 * locally: `succeeded` with the agent exit metadata, `deferred` with the retry
 * hint and resume flags a `phase-deferred` outcome carries, or `failed` with the
 * error (and `cancelled` set for a user termination, so the control plane cancels
 * rather than fails the dispatch). The worker reports the classification and the
 * derived retry delay; the retry-budget accounting stays with the control plane,
 * which owns the dispatch record (phase 4).
 */
export const TaskExecutionResultSchema = z.object({
	type: z.literal('task-execution-result'),
	dispatchId: z.string().uuid(),
	runId: z.string().uuid().optional(),
	status: z.enum(['succeeded', 'deferred', 'failed']),
	phase: TaskPhaseSchema,
	taskId: z.string().min(1),
	// `succeeded` — the agent run's exit metadata (mirrors the `phase-succeeded`
	// outcome fields).
	exitCode: z.number().int().nullable().optional(),
	signal: z.string().nullable().optional(),
	timedOut: z.boolean().optional(),
	durationMs: z.number().int().nonnegative().optional(),
	// `deferred` — the retry hint + resume flags (mirrors `phase-deferred`).
	retryDelayMs: z.number().int().nonnegative().optional(),
	resumable: z.boolean().optional(),
	resumeDelivery: z.boolean().optional(),
	// `deferred` — the Tier 2 checkpoint the stopped run left in its worktree
	// (`docs/CHECKPOINTS.md`, issue #503), parsed by the worker because only the
	// worker's host holds that worktree: the control plane cannot read the file, so it
	// takes the worker's word for it and maps a deferral carrying one onto the
	// `checkpointed` run status. The wire `status` stays `deferred` deliberately — a
	// continuation *is* a deferral whose retry happens to run from a checkpoint, and
	// keeping the status set unchanged means no `TRANSPORT_PROTOCOL_VERSION` bump.
	// Optional and additive in both directions: an older worker simply omits it and its
	// deferrals behave exactly as before.
	checkpoint: CheckpointSchema.optional(),
	// One of the `AgentFailureKind`s, `delivery`, or `dependency` — the last being a
	// wait on an external condition rather than a failure of the run itself.
	failureKind: z.string().optional(),
	// `deferred` with `failureKind: 'dependency'` — the still-**open** prerequisites
	// gating the run (issue #438). The control plane rebuilds a
	// `DependencyBlockedError` from these, so its bounded token-free recheck
	// (`deferDependencyBlock`, `../worker/consumer.ts`) applies unchanged and its
	// log/board message names the prerequisites instead of a generic reason.
	blockers: z.array(WorkItemBlockerFrameSchema).optional(),
	// `deferred`/`failed` — the human-readable originating reason.
	reason: z.string().optional(),
	// `failed` — the terminal error and whether it was a user termination.
	error: z.string().optional(),
	cancelled: z.boolean().optional(),
	// `succeeded` — the terminal PM/verdict context the control plane settles on
	// (issue #407, split delivery). A PM-driven phase (planning/implementation)
	// reports the status it auto-advanced the item to so the control plane can
	// self-enqueue the next phase (`selfEnqueueNextPhase`, `../worker/consumer.ts`)
	// instead of waiting on the dropped persona-authored webhook. A Review run
	// reports its `verdict` (which gates merge automation) plus the safety-cap slot
	// and automation outcome persisted on its run row. These mirror the
	// `PhaseRunResult` fields the in-process path reads; the literals track
	// `PM_STATUS_KEYS` (`../pm/pipeline.ts`) and `REVIEW_VERDICTS` /
	// `REVIEW_AUTOMATION_OUTCOMES` (`../pipeline/review.ts`).
	movedTo: z.enum(['backlog', 'planning', 'todo', 'inProgress', 'inReview', 'done']).optional(),
	// `comment` is retired (issue #470) but stays accepted here: this is a terminal
	// result frame, so rejecting it would fail the whole settle — losing the run's
	// outcome — over one optional telemetry field an older worker might still send.
	// `../router/dispatcher.ts` drops it when adapting the frame, and
	// `../router/worker-delivery.ts` rejects any attempt to *submit* it. Narrowing
	// this enum instead would need a `TRANSPORT_PROTOCOL_VERSION` bump, which
	// rejects every frame from that worker rather than just this field.
	verdict: z.enum(['approve', 'request-changes', 'comment']).optional(),
	reviewOrdinal: z.number().int().positive().optional(),
	reviewAutomationOutcome: z.enum(['manual-intervention-required']).optional(),
	// `succeeded` — the pull request this run *produced*, reported so the control
	// plane can record the worker→PR attribution a DB-free worker cannot write
	// itself (ADR-004 §4, issue #398). Only a PR-producing phase (Implementation)
	// sends it. Validated as a non-empty string rather than a URL: a terminal
	// result frame must never fail to parse — and so lose the whole settle — over
	// an attribution nicety. Optional and additive in both directions, so it needs
	// no `TRANSPORT_PROTOCOL_VERSION` bump: an older worker simply omits it.
	prUrl: z.string().min(1).optional(),
});
export type TaskExecutionResult = z.infer<typeof TaskExecutionResultSchema>;

/**
 * Every worker→cloud stream frame, discriminated on `type`: the `heartbeat` that
 * keeps the session lease live (ADR-003 §1) plus the split-delivery back-channel
 * frames (ADR-003 §2) — the assignment ack, batched live output, coarse
 * progress, and the terminal execution result — the worker sends while running a
 * pushed {@link TaskAssignmentSchema}.
 */
export const WorkerStreamMessageSchema = z.discriminatedUnion('type', [
	HeartbeatSchema,
	TaskAssignmentAckSchema,
	StreamLogSchema,
	TaskProgressSchema,
	TaskExecutionResultSchema,
]);
export type WorkerStreamMessage = z.infer<typeof WorkerStreamMessageSchema>;

/**
 * Every cloud→worker stream frame, discriminated on `type`: the lease-liveness
 * control frames plus `TaskAssignment` (PROJECT.md §3), which the control-plane
 * dispatcher pushes to a selected connected worker (ADR-003 §2, issue #407), and
 * the `TaskCancel` that stops one it already pushed. The back-channel frames they
 * pair with — `TaskExecutionResult`/`StreamLog`/`TaskProgress`/`TaskAssignmentAck`
 * on the worker→cloud union above — settle the dispatch on the control plane.
 */
export const ControlPlaneMessageSchema = z.discriminatedUnion('type', [
	HeartbeatAckSchema,
	DisconnectSchema,
	TaskAssignmentSchema,
	TaskCancelSchema,
]);
export type ControlPlaneMessage = z.infer<typeof ControlPlaneMessageSchema>;

/**
 * Control-plane SCM metadata delivery frames (ADR-004 §2). The metadata-only
 * SCM delivery calls — submit a review, post a PR comment — move server-side so
 * the per-project reviewer PAT stays on the router and never reaches a worker: a
 * federated worker sends only the verdict + comment body + PR number up the
 * transport, and the router performs the GitHub write under the requested
 * persona's credential (the review still lands as a genuine GitHub review,
 * keeping the `pull_request_review` respond-to-review trigger working —
 * PROJECT.md §5.4).
 *
 * The PR-comment frame names its author persona; the review frame does not,
 * because only the Review phase submits a review and it is always the reviewer.
 *
 * These are **HTTP request/response** frames — carried by the router's
 * `POST /worker/delivery/*` routes exactly as the handshake rides
 * `POST /worker/session` — so they are deliberately *not* added to the WebSocket
 * `WorkerStreamMessageSchema`/`ControlPlaneMessageSchema` unions above (those
 * stay the handshake/heartbeat control stream). The fields carry no GitHub
 * vocabulary (ai/RULES.md §2) so a second SCM provider can reuse the same wire.
 * `protocolVersion` handshakes exactly as the session handshake does: a mismatch
 * is a clean 400 rather than a silent misparse.
 */
export const SubmitReviewDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	prNumber: z.number().int().positive(),
	verdict: z.enum(['approve', 'request-changes', 'comment']),
	body: z.string().min(1),
	deliveryId: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type SubmitReviewDeliveryRequest = z.infer<typeof SubmitReviewDeliveryRequestSchema>;

/** `POST /worker/delivery/review` success body — the created review's id. */
export const SubmitReviewDeliveryResponseSchema = z.object({
	reviewId: z.number().int().positive(),
});
export type SubmitReviewDeliveryResponse = z.infer<typeof SubmitReviewDeliveryResponseSchema>;

/**
 * `POST /worker/delivery/pr-comment` request body — a top-level PR comment.
 *
 * `persona` names who authors the comment, because only the requesting phase
 * knows whose reply it is: a Review comments as the `reviewer`, while a
 * Respond-to-review reply is the `implementer` answering that review. A server
 * left to infer it defaulted to the reviewer, so the reviewer answered its own
 * review (issue #444). Defaulting the field to `reviewer` keeps a client that
 * sends no persona on its previous behaviour, so the frame stays
 * wire-compatible without a protocol bump. Provider-neutral like every other
 * field here: the two persona names, no GitHub type imported into the protocol.
 */
export const PostCommentDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	prNumber: z.number().int().positive(),
	body: z.string().min(1),
	deliveryId: z.string().min(1),
	persona: z.enum(['reviewer', 'implementer']).default('reviewer'),
	protocolVersion: z.number().int(),
});
export type PostCommentDeliveryRequest = z.infer<typeof PostCommentDeliveryRequestSchema>;

/** The persona a delivery request names as the author of its write. */
export type DeliveryPersona = PostCommentDeliveryRequest['persona'];

/** `POST /worker/delivery/pr-comment` success body — the created comment's id. */
export const PostCommentDeliveryResponseSchema = z.object({
	commentId: z.number().int().positive(),
});
export type PostCommentDeliveryResponse = z.infer<typeof PostCommentDeliveryResponseSchema>;

/**
 * Control-plane PM metadata delivery frames (ADR-004 §2, the independent Phase
 * 2/2 half of the SCM frames above). The metadata-only PM board writes — move a
 * card to a canonical pipeline status, add a comment on the item's backing
 * Issue/PR — move server-side so the **per-project PM credential** stays on the
 * router and never reaches a worker: a federated worker sends only the canonical
 * status key / comment body up the transport, and the router performs the board
 * write under that credential (`../router/worker-delivery.ts`).
 *
 * Same shape and contract as the SCM delivery frames — HTTP request/response
 * carried by the router's `POST /worker/delivery/pm/*` routes (deliberately
 * *not* part of the WebSocket `WorkerStreamMessageSchema`/`ControlPlaneMessageSchema`
 * unions), `protocolVersion`-handshaked so a mismatch is a clean 400. The fields
 * carry no GitHub vocabulary (ai/RULES.md §2): `status` is a canonical
 * `PmStatusKey` (`../pm/pipeline.ts`), never a board option ID — the adapter
 * resolves it to an option ID server-side — so a second PM provider reuses the
 * same wire. Only metadata crosses; the repository tree never does.
 */
export const MoveWorkItemDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	itemId: z.string().min(1),
	/** Canonical SWARM pipeline status key (`PmStatusKey`), never a board option ID. */
	status: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type MoveWorkItemDeliveryRequest = z.infer<typeof MoveWorkItemDeliveryRequestSchema>;

/** `POST /worker/delivery/pm/move` success body — a card move carries no return value. */
export const MoveWorkItemDeliveryResponseSchema = z.object({});
export type MoveWorkItemDeliveryResponse = z.infer<typeof MoveWorkItemDeliveryResponseSchema>;

/** `POST /worker/delivery/pm/comment` request body — a comment on the item's backing Issue/PR. */
export const AddPmCommentDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	itemId: z.string().min(1),
	body: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type AddPmCommentDeliveryRequest = z.infer<typeof AddPmCommentDeliveryRequestSchema>;

/**
 * `POST /worker/delivery/pm/comment` success body — the created comment's id. A
 * `string` (unlike the SCM PR-comment's numeric id) because `PMProvider.addComment`
 * returns a provider-native comment id as a string (`../pm/types.ts`).
 */
export const AddPmCommentDeliveryResponseSchema = z.object({
	commentId: z.string().min(1),
});
export type AddPmCommentDeliveryResponse = z.infer<typeof AddPmCommentDeliveryResponseSchema>;

/**
 * `POST /worker/delivery/pm/blockers` request body — the prerequisites gating a
 * work item. The one PM **read** the split serves (ADR-003 §2): Implementation's
 * dependency gate (`../pipeline/dependency-guard.ts`) must not be skipped on a
 * federated worker, or a task whose prerequisites are still open would be built
 * out of order — the failure issue #330 exists to prevent. The read runs
 * server-side under the per-project PM credential, like the writes above.
 */
export const ListBlockersDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	itemId: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type ListBlockersDeliveryRequest = z.infer<typeof ListBlockersDeliveryRequestSchema>;

/**
 * `POST /worker/delivery/pm/blockers` success body — the item's blockers in the
 * provider-neutral shape `PMProvider.listBlockers` returns (`../pm/types.ts`);
 * `[]` both when nothing gates the item and when the provider models no
 * dependencies. No provider-specific fields cross the wire (ai/RULES.md §2).
 */
export const ListBlockersDeliveryResponseSchema = z.object({
	blockers: z.array(WorkItemBlockerFrameSchema),
});
export type ListBlockersDeliveryResponse = z.infer<typeof ListBlockersDeliveryResponseSchema>;

/**
 * `POST /worker/delivery/pm/find-item` request body — resolve the single board
 * card whose backing Issue/PR URL ends with `urlSuffix`. The second PM **read**
 * the split serves (ADR-003 §2): Respond-to-review resolves the card for the
 * issue its PR branch names before reporting In progress / In review, and a
 * federated worker holds no PM credential to look it up with.
 *
 * Narrow on purpose — one suffix in, at most one card out. Proxying
 * `listWorkItems` instead would pull a whole board across the wire to answer a
 * one-card question, and would hand a worker an enumeration of every item on a
 * board it only needs one card from. `urlSuffix` carries no provider vocabulary:
 * it matches `WorkItem.url`, the generic field every provider populates
 * (ai/RULES.md §2).
 */
export const FindWorkItemDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	urlSuffix: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type FindWorkItemDeliveryRequest = z.infer<typeof FindWorkItemDeliveryRequestSchema>;

/** Resolve one board card by a repository-scoped backing artifact. */
export const FindWorkItemForArtifactDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	repository: z.string().min(1),
	kind: z.enum(['issue', 'pullRequest']),
	number: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type FindWorkItemForArtifactDeliveryRequest = z.infer<
	typeof FindWorkItemForArtifactDeliveryRequestSchema
>;

/**
 * `POST /worker/delivery/pm/find-item-by-marker` request body — resolve the single
 * board card whose `description` contains `marker` (issue #543). The read that makes
 * Planning's split **resumable**: each child is created carrying a marker keyed on
 * the delivery and the child's index, so a retried delivery recognises a child it
 * already created rather than spawning a duplicate.
 *
 * Narrow in exactly the sense {@link FindWorkItemDeliveryRequestSchema} is — one
 * marker in, at most one card out — which is why the enumerating `listWorkItems`
 * stays refused on the worker even though this lookup is served: a worker asks a
 * one-card question and gets a one-card answer. `marker` carries no provider
 * vocabulary; it matches `WorkItem.description`, the generic field every provider
 * populates (ai/RULES.md §2), and the answer rides the same narrow card frame as
 * the two lookups above.
 */
export const FindWorkItemByMarkerDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	/** Unique substring identifying at most one card (`PMProvider.findWorkItemByDescriptionMarker`). */
	marker: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type FindWorkItemByMarkerDeliveryRequest = z.infer<
	typeof FindWorkItemByMarkerDeliveryRequestSchema
>;

/**
 * Dedicated schema for the card resolved by `POST /worker/delivery/pm/find-item`.
 * Narrow wire frame containing only what `findWorkItemByUrlSuffix` needs to identify
 * and move the card (`id`, `title`, `url`, `status?`, `statusId?`) — omitting labels,
 * assignees, and description so assignees never cross the wire from a provider where
 * `supportsAssignees: false` (ai/RULES.md §2).
 */
export const FoundWorkItemSchema = z.object({
	id: z.string().min(1),
	title: z.string(),
	url: z.string(),
	status: z.string().optional(),
	statusId: z.string().optional(),
});
export type FoundWorkItem = z.infer<typeof FoundWorkItemSchema>;

/**
 * `POST /worker/delivery/pm/find-item` success body — the matching card, or
 * `item: null` when the board has none (`null` rather than an absent key so "not
 * on the board" is an explicit answer, never a dropped field).
 */
export const FindWorkItemDeliveryResponseSchema = z.object({
	item: FoundWorkItemSchema.nullable(),
});
export type FindWorkItemDeliveryResponse = z.infer<typeof FindWorkItemDeliveryResponseSchema>;

/**
 * Control-plane PM frames the **Planning** phase needs (issue #536), the last set
 * that kept a phase off a DB-free worker. Same contract as the PM frames above —
 * worker-credential-authenticated `POST /worker/delivery/pm/*`, the project taken
 * from the authenticated enrollment rather than the body, `protocolVersion`
 * handshaked, no provider vocabulary on the wire — so the reasoning there applies
 * unchanged and only the operations are new.
 *
 * They are deliberately **one frame per `PMProvider` method** rather than one
 * coarse "apply this split" frame. The split's idempotency does not live in the
 * grouping of its writes: a replayed Planning delivery that got as far as posting is
 * short-circuited *before* `applySplit` runs at all, by finding its own plan comment
 * through {@link FindPmCommentDeliveryRequestSchema} (`planDeliveryMarker`,
 * `../pipeline/planning.ts`); one that died mid-split resumes instead, recognising
 * each child it already created through
 * {@link FindWorkItemByMarkerDeliveryRequestSchema} (issue #543); and each individual
 * write is idempotent or best-effort by the provider's own contract. A coarse frame
 * would instead have to
 * carry the agent-authored split — preplan contracts, marker bodies, per-child
 * ordering — up to the control plane and re-implement Planning's per-child failure
 * handling there, moving pipeline logic off the phase that owns it and changing the
 * same-host path this issue must leave untouched.
 *
 * `TRANSPORT_PROTOCOL_VERSION` is deliberately **not** bumped: every existing frame
 * keeps its shape, and a bump would reject every frame from an already-deployed
 * worker rather than just these new ones. An older worker simply never calls these
 * routes; a newer worker against an older router gets a 404, which surfaces as the
 * same failed write any other non-2xx does.
 */
export const FindPmCommentDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	itemId: z.string().min(1),
	/** Unique substring identifying at most one comment (`PMProvider.findComment`). */
	marker: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type FindPmCommentDeliveryRequest = z.infer<typeof FindPmCommentDeliveryRequestSchema>;

/**
 * `POST /worker/delivery/pm/find-comment` success body — the matching comment's
 * provider-native id, or `null` when no comment carries the marker. `null` rather
 * than an absent key, for the same reason as the card lookup above: "no such
 * comment" must be an explicit answer, never a dropped field, because the caller
 * treats it as "this delivery has not posted yet" and posts.
 */
export const FindPmCommentDeliveryResponseSchema = z.object({
	commentId: z.string().min(1).nullable(),
});
export type FindPmCommentDeliveryResponse = z.infer<typeof FindPmCommentDeliveryResponseSchema>;

/**
 * `POST /worker/delivery/pm/create-item` request body — spawn one sibling card for
 * Planning's task split. `status` is a canonical `PmStatusKey` and `labels` are
 * label *names*, exactly as `CreateWorkItemInput` defines them (`../pm/types.ts`):
 * resolving either to a board option id or to a provider label object is the
 * adapter's job, server-side.
 */
export const CreateWorkItemDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	title: z.string().min(1),
	description: z.string(),
	/** Canonical SWARM pipeline status key (`PmStatusKey`), never a board option ID. */
	status: z.string().min(1),
	labels: z.array(z.string().min(1)).optional(),
	protocolVersion: z.number().int(),
});
export type CreateWorkItemDeliveryRequest = z.infer<typeof CreateWorkItemDeliveryRequestSchema>;

/**
 * `POST /worker/delivery/pm/create-item` success body — the created card on the
 * same narrow {@link FoundWorkItemSchema} frame the lookups use, which is exactly
 * what Planning reads off a fresh sibling (its `id` to write to, its `title`/`url`
 * to name it in the next child's blocked-by comment). Not nullable: unlike a
 * lookup, a creation that resolved no item is a failure, not an ordinary miss.
 */
export const CreateWorkItemDeliveryResponseSchema = z.object({
	item: FoundWorkItemSchema,
});
export type CreateWorkItemDeliveryResponse = z.infer<typeof CreateWorkItemDeliveryResponseSchema>;

/**
 * `POST /worker/delivery/pm/update-item` request body — patch a card's mutable
 * fields. Both fields are optional and independently omittable, mirroring
 * `UpdateWorkItemPatch` (`../pm/types.ts`), so "leave the title alone" stays
 * distinguishable from "set the title to this". `description` accepts the empty
 * string, which a re-scope may legitimately write; `title` does not, since no
 * provider models an untitled item.
 */
export const UpdateWorkItemDeliveryRequestSchema = z
	.object({
		projectId: z.string().min(1),
		itemId: z.string().min(1),
		title: z.string().min(1).optional(),
		description: z.string().optional(),
		protocolVersion: z.number().int(),
	})
	// Both fields optional means "leave this one alone", so *neither* means the
	// request asks for nothing — a caller bug that would otherwise reach the provider
	// as an empty patch and spend a board write saying nothing. Planning never sends
	// one (`buildMainTaskPatch` returns undefined when nothing changed, and the call
	// is guarded on that), so rejecting it costs no legitimate traffic.
	.refine((request) => request.title !== undefined || request.description !== undefined, {
		message: 'update-item requires at least one of title or description',
	});
export type UpdateWorkItemDeliveryRequest = z.infer<typeof UpdateWorkItemDeliveryRequestSchema>;

/** `POST /worker/delivery/pm/update-item` success body — a patch carries no return value. */
export const UpdateWorkItemDeliveryResponseSchema = z.object({});
export type UpdateWorkItemDeliveryResponse = z.infer<typeof UpdateWorkItemDeliveryResponseSchema>;

/**
 * `POST /worker/delivery/pm/label` request body — apply one label by *name* to a
 * card's backing artifact (`planned`, a project's automation label). Creating the
 * label if it is missing and making a repeat a no-op are the adapter's job
 * (`PMProvider.addLabel`), so nothing here needs a read-then-write.
 */
export const AddPmLabelDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	itemId: z.string().min(1),
	name: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type AddPmLabelDeliveryRequest = z.infer<typeof AddPmLabelDeliveryRequestSchema>;

/** `POST /worker/delivery/pm/label` success body — a label write carries no return value. */
export const AddPmLabelDeliveryResponseSchema = z.object({});
export type AddPmLabelDeliveryResponse = z.infer<typeof AddPmLabelDeliveryResponseSchema>;

/**
 * `POST /worker/delivery/pm/blocked-by` request body — record that `itemId` is
 * blocked by `blockerId`, the dependency edge a split chains its phases with
 * (issue #330). Both are provider-native work-item ids, and the write is
 * idempotent — a no-op entirely on a provider that models no dependencies
 * (`PMProvider.addBlockedBy`).
 */
export const AddBlockedByDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	itemId: z.string().min(1),
	blockerId: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type AddBlockedByDeliveryRequest = z.infer<typeof AddBlockedByDeliveryRequestSchema>;

/** `POST /worker/delivery/pm/blocked-by` success body — a dependency write carries no return value. */
export const AddBlockedByDeliveryResponseSchema = z.object({});
export type AddBlockedByDeliveryResponse = z.infer<typeof AddBlockedByDeliveryResponseSchema>;

/**
 * `POST /worker/delivery/follow-up-review` request body — schedule the one
 * follow-up Review a `fixed` Respond-to-review response owes its newly pushed
 * commit (issue #241). Unlike the delivery frames above this fronts no
 * credential: what stays server-side is the **dispatch record + queue** a DB-free
 * worker has no `DATABASE_URL`/`REDIS_URL` to reach.
 *
 * The enqueue must stay inside the phase's deterministic delivery — it runs
 * before the checkpoint that guards it, so a failure defers and a resumed retry
 * re-schedules rather than dropping the follow-up — hence a route the phase calls
 * rather than a fact reported in the terminal result. The scheduler's own
 * deterministic dedup identity (project, PR, new head) absorbs a retry, so a
 * re-sent request cannot produce a second dispatch. The project is taken from the
 * **authenticated** worker enrollment, never from this body.
 */
export const FollowUpReviewDeliveryRequestSchema = z.object({
	projectId: z.string().min(1),
	prNumber: z.string().min(1),
	prBranch: z.string().min(1),
	/** The newly pushed commit SHA the follow-up Review must cover. */
	headSha: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type FollowUpReviewDeliveryRequest = z.infer<typeof FollowUpReviewDeliveryRequestSchema>;

/** `POST /worker/delivery/follow-up-review` success body — scheduling carries no return value. */
export const FollowUpReviewDeliveryResponseSchema = z.object({});
export type FollowUpReviewDeliveryResponse = z.infer<typeof FollowUpReviewDeliveryResponseSchema>;

/**
 * Control-plane **review-verdict ledger** frames (ADR-003 §2). Unlike the
 * delivery frames above, these front no credential — they front the
 * `review_verdicts` **table** (`../db/repositories/reviewVerdictsRepository.ts`),
 * which a DB-free worker cannot reach at all. The Review phase must still consult
 * it: it carries the review-verdict safety cap (issue #235) and the
 * prior-submitted-verdict answer that makes a run a re-review (issue #328).
 *
 * The worker sends only the PR coordinates (and, when marking, the verdict it
 * submitted); the server derives the ledger key's `projectId`/`repository` from
 * the **authenticated** project, so a worker can never key a row to a project or
 * repository it isn't enrolled in. Carried by `POST /worker/delivery/review-ledger/*`
 * (`../router/worker-delivery.ts`), same auth and `protocolVersion` handshake as
 * the delivery routes.
 */
export const PriorReviewLedgerRequestSchema = z.object({
	projectId: z.string().min(1),
	prNumber: z.string().min(1),
	/** The head being reviewed now — excluded from the lookup, so a same-head retry isn't a re-review. */
	currentHeadSha: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type PriorReviewLedgerRequest = z.infer<typeof PriorReviewLedgerRequestSchema>;

/**
 * `POST /worker/delivery/review-ledger/prior` success body — the prior submitted
 * verdict's slot, or `record: null` when this is the PR's first review (`null`
 * rather than an absent key so "no prior review" is an explicit answer, never a
 * dropped field).
 */
export const PriorReviewLedgerResponseSchema = z.object({
	record: z
		.object({
			ordinal: z.number().int().positive(),
			state: z.enum(['pending', 'submitted', 'abandoned']),
			verdict: z.string().nullable(),
			headSha: z.string().min(1),
		})
		.nullable(),
});
export type PriorReviewLedgerResponse = z.infer<typeof PriorReviewLedgerResponseSchema>;

/** `POST /worker/delivery/review-ledger/mark` request body — the verdict this run submitted. */
export const MarkReviewLedgerRequestSchema = z.object({
	projectId: z.string().min(1),
	prNumber: z.string().min(1),
	headSha: z.string().min(1),
	verdict: z.string().min(1),
	/** The created review's id, once GitHub has confirmed it. */
	reviewId: z.string().min(1).optional(),
	protocolVersion: z.number().int(),
});
export type MarkReviewLedgerRequest = z.infer<typeof MarkReviewLedgerRequestSchema>;

/**
 * `POST /worker/delivery/review-ledger/mark` success body — the marked slot, or
 * `slot: null` when no record exists for this PR/head (a reservation that was
 * never made; the phase treats it as an unknown ordinal rather than an error).
 */
export const MarkReviewLedgerResponseSchema = z.object({
	slot: z
		.object({
			id: z.string().min(1),
			ordinal: z.number().int().positive(),
		})
		.nullable(),
});
export type MarkReviewLedgerResponse = z.infer<typeof MarkReviewLedgerResponseSchema>;

/** `POST /worker/delivery/review-ledger/abandon` request body — release a pending slot. */
export const AbandonReviewLedgerRequestSchema = z.object({
	projectId: z.string().min(1),
	prNumber: z.string().min(1),
	headSha: z.string().min(1),
	protocolVersion: z.number().int(),
});
export type AbandonReviewLedgerRequest = z.infer<typeof AbandonReviewLedgerRequestSchema>;

/** `POST /worker/delivery/review-ledger/abandon` success body — the release carries no return value. */
export const AbandonReviewLedgerResponseSchema = z.object({});
export type AbandonReviewLedgerResponse = z.infer<typeof AbandonReviewLedgerResponseSchema>;
