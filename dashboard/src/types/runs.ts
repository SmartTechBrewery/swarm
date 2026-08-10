import { z } from 'zod';

/**
 * Run status/phase filter values, mirroring the router's `RunStatusEnum`/
 * `RunPhaseEnum` (`src/api/routers/runs.ts`). The web package doesn't import
 * server modules, so these are re-declared here as the single source for the
 * UI layer — reused by both the global `/runs` route search schema and the
 * project-scoped Runs panel so a new phase/status only has to be added once.
 * Zod is the source of truth per `ai/CODING_STANDARDS.md`; the types are
 * `z.infer`'d rather than hand-written.
 */
export const runStatusFilterSchema = z.enum([
	'running',
	'completed',
	'failed',
	'deferred',
	'checkpointed',
]);
export type RunStatusFilter = z.infer<typeof runStatusFilterSchema>;

export const runPhaseFilterSchema = z.enum([
	'planning',
	'implementation',
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
]);
export type RunPhaseFilter = z.infer<typeof runPhaseFilterSchema>;

/**
 * Mirrors `CancellationOriginSchema` (`src/queue/cancellation.ts`, issue #308) —
 * the dashboard package doesn't import server modules, so this re-declares the shape
 * here the same way `runStatusFilterSchema` mirrors the router's status enum.
 * A cancellation's recorded origin: at minimum distinguishes the supported
 * dashboard/API termination action from an unknown/external marker (which has
 * no record at all — see `RunRow.cancellation`).
 */
export const cancellationOriginSchema = z.object({
	source: z.enum(['dashboard', 'api']),
	actor: z.string().optional(),
	requestedAt: z.string(),
	requestId: z.string().optional(),
});
export type CancellationOrigin = z.infer<typeof cancellationOriginSchema>;

/**
 * Mirrors `FailureDiagnosisSchema` (`src/worker/failure-diagnosis.ts`). The web
 * package does not import worker modules, so it declares the persisted shape at
 * this boundary and keeps the raw run error separate for technical detail.
 */
export const failureDiagnosisSchema = z.object({
	kind: z.enum([
		'likely-scope-exceeded',
		'provider-stalled-early',
		'provider-rate-limit',
		'provider-capacity',
		'launch-or-authentication',
		'worker-shutdown',
		'user-terminated',
		'continuation-budget-exhausted',
	]),
	title: z.string(),
	message: z.string(),
	recovery: z.string(),
});
export type FailureDiagnosis = z.infer<typeof failureDiagnosisSchema>;

/**
 * Mirrors `CheckpointSchema` (`src/pipeline/checkpoint.ts`) — the Tier 2 hand-off
 * a `checkpointed` run was settled with (`docs/CHECKPOINTS.md`, issue #503). The
 * dashboard package can't import that module (it reads git and the filesystem),
 * so the shape is re-declared here the same way `failureDiagnosisSchema` mirrors
 * the worker's. Keep the two in step; the server's schema stays the validator.
 */
export const checkpointSchema = z.object({
	/** The phase that wrote it — a continuation never adopts another phase's checkpoint. */
	phase: z.string(),
	/** What the stopped agent finished, and a continuation must not re-derive. */
	completed: z.array(z.string()),
	/** What is still left, in order — the remainder a continuation picks up. */
	remaining: z.array(z.string()),
	/** Decisions/caveats carried over rather than re-decided. */
	decisions: z.array(z.string()),
	/** The paths it claims it left changed, by change kind. */
	workingTree: z.object({
		modified: z.array(z.string()),
		added: z.array(z.string()),
		deleted: z.array(z.string()),
	}),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

/**
 * Mirrors the server `runs.queued` contract (`QueuedRunSchema`,
 * `src/queue/queued-runs.ts`) for a job enqueued in BullMQ but not yet picked up
 * by the worker (issue #234). The web package doesn't import server modules, so
 * this re-declares the shape here the same way `runStatusFilterSchema` mirrors
 * the router's status enum — keep it exactly in step with the server schema.
 *
 * `phaseHint` is best-effort (derived without a GitHub lookup), so it is NOT the
 * same closed set as {@link runPhaseFilterSchema}: `board` covers Planning/Impl
 * before authoritative dispatch, and `unknown` is a real value — but only for an
 * event kind the server couldn't classify. Whether a board dispatch can start a
 * phase at all is a decided fact once its card has been read, and is carried by
 * {@link queuedBoardOutcomeSchema} instead (issue #570).
 */
export const queuedPhaseHintSchema = z.enum([
	'board',
	'planning',
	'implementation',
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
	'merge-automation',
	'unknown',
]);
export type QueuedPhaseHint = z.infer<typeof queuedPhaseHintSchema>;

/**
 * Mirrors `QueuedBoardOutcomeSchema` (`src/queue/queued-runs.ts`, issue #570):
 * what a live board read proved about a fresh board dispatch — `starts-phase`
 * when the card's current status maps to Planning/Implementation, `no-trigger`
 * when it maps to none (SWARM's own `inProgress` status report echoing back, a
 * card being filed, a backlog reorder). Absent means undetermined: no board read,
 * a failed one, or a dispatch whose phase the board no longer decides.
 */
export const queuedBoardOutcomeSchema = z.enum(['starts-phase', 'no-trigger']);
export type QueuedBoardOutcome = z.infer<typeof queuedBoardOutcomeSchema>;

/**
 * The queue-facing state of a waiting dispatch (mirrors
 * `PendingJobStateSchema`, issue #284): `waiting`/`prioritized` for
 * eligible-now work, `blocked` for a dispatch waiting on a free project slot,
 * `delayed` for a scheduled retry/recheck.
 */
export const queuedRunStateSchema = z.enum(['waiting', 'prioritized', 'delayed', 'blocked']);
export type QueuedRunState = z.infer<typeof queuedRunStateSchema>;

/** Why a waiting dispatch isn't running (mirrors `QueuedWaitReasonSchema`). */
export const queuedWaitReasonSchema = z.enum([
	'project-capacity',
	'rate-limit',
	'agent-capacity',
	'timeout',
	'worker-shutdown',
	'delivery',
	'worktree-exists',
	'stalled',
	'recheck',
	'worker-eligibility',
	'worker-authorization',
	'preserved-worker',
	'manual-retry',
	'recovered',
]);
export type QueuedWaitReason = z.infer<typeof queuedWaitReasonSchema>;

/** The normalized SCM lifecycle event kind a review-gate job's metadata was derived from (mirrors `ReviewGateSourceEventSchema`). */
export const queuedReviewGateSourceEventSchema = z.enum(['pull-request', 'checks']);
export type QueuedReviewGateSourceEvent = z.infer<typeof queuedReviewGateSourceEventSchema>;

/**
 * Mirrors the server `QueuedReviewGateSchema` (`src/queue/queued-runs.ts`,
 * issue #275): diagnostic metadata for a `review`-hinted SCM job — a normalized
 * lifecycle event *entering* the review-gate, not proof a Review agent is
 * already queued. Present only when the job carries the PR number and head SHA
 * needed to classify it safely.
 */
export const queuedReviewGateSchema = z.object({
	sourceEvent: queuedReviewGateSourceEventSchema,
	/** The normalized `action` on the source event (e.g. `opened`, `updated`, `completed`). */
	sourceAction: z.string().optional(),
	/** The PR head commit SHA this event evaluates — the review dispatch dedup key. */
	headSha: z.string(),
	/** Deferred aggregate-check recheck attempt count, when this job is a coalesced recheck. */
	recheckAttempt: z.number().int().nonnegative().optional(),
});
export type QueuedReviewGate = z.infer<typeof queuedReviewGateSchema>;

export const queuedRunSchema = z.object({
	/** The canonical dispatch id (issue #284) — the handle Put back operates on. */
	jobId: z.string(),
	projectId: z.string(),
	type: z.enum(['scm', 'pm', 'merge-automation']),
	providerId: z.string().optional(),
	state: queuedRunStateSchema,
	phaseHint: queuedPhaseHintSchema,
	/** Why this dispatch is waiting, when it recorded a reason. */
	waitReason: queuedWaitReasonSchema.optional(),
	/** The run row this dispatch retries, when one exists (deferred runs). */
	runId: z.string().optional(),
	/** Deferred-retry attempt counter. */
	attempt: z.number().int().nonnegative().optional(),
	/** `github` and `merge-automation` jobs only — `owner/repo`. */
	repo: z.string().optional(),
	/** `github` and `merge-automation` jobs only — the PR/issue number. */
	prNumber: z.string().optional(),
	/** `pm` jobs only — the opaque board item id. */
	workItemNodeId: z.string().optional(),
	/** `pm` jobs only — the provider's display-only content descriptor (`Issue`, `PullRequest`, …). */
	contentType: z.string().optional(),
	/** `pm` jobs only — what a board read proved about this dispatch's trigger (issue #570). */
	boardOutcome: queuedBoardOutcomeSchema.optional(),
	/** Resolved backing Issue/PR title for a board job, when available. */
	workItemTitle: z.string().optional(),
	/** Resolved backing Issue/PR URL for a board job, when available. */
	workItemUrl: z.string().optional(),
	/** Effective BullMQ priority; 0 is highest. */
	priority: z.number().int().nonnegative(),
	/**
	 * Whether this dispatch is a prioritized SCM continuation (Review /
	 * Respond-to-review / Respond-to-CI / Resolve-conflicts resumed after a
	 * capacity wait) — the primary key the scheduler orders the capacity-blocked
	 * bucket by (mirrors the server `QueuedRunSchema.continuation`, issue #374).
	 */
	continuation: z.boolean(),
	/** Whether the project has SCM continuation prioritization active. */
	prioritizeContinuations: z.boolean(),
	/** ISO 8601 — when the job was enqueued. */
	enqueuedAt: z.string(),
	/**
	 * ISO 8601 — when the dispatch became eligible; the capacity wake selector's
	 * secondary ordering key, distinct from `enqueuedAt` (mirrors the server
	 * `QueuedRunSchema.availableAt`, issue #374).
	 */
	availableAt: z.string(),
	/** ISO 8601 — `delayed` jobs only, scheduled run time. */
	runsAt: z.string().optional(),
	/**
	 * Present only for a `review`-hinted `github` job carrying the PR number and
	 * head SHA needed to classify it safely (see {@link queuedReviewGateSchema}).
	 */
	reviewGate: queuedReviewGateSchema.optional(),
});
export type QueuedRun = z.infer<typeof queuedRunSchema>;

/**
 * Mirrors `AgentUsage` (`src/harness/usage.ts`) — the dashboard package doesn't
 * import server modules, so this hand-mirrors the shape the same way `RunRow`
 * hand-mirrors the DB row.
 */
export interface AgentUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheCreationTokens?: number;
	reasoningTokens?: number;
	totalTokens?: number;
}

/**
 * Mirrors the server `RunAttribution` (`src/api/routers/runs.ts`, issue #446):
 * display labels for the worker that executed a run and the SWARM user who owns
 * it, resolved server-side from the row's `workerId`/`workerUserId`. A name is
 * null when the worker/user row no longer resolves; the ids ride along so the UI
 * can fall back to one instead of showing nothing.
 */
export interface RunAttribution {
	workerId: string | null;
	workerName: string | null;
	userId: string | null;
	userDisplayName: string | null;
}

/**
 * Mirrors the server `PendingRunRequest` (`src/api/routers/runs.ts`, issue #561):
 * an operator request against the run that has been accepted but has not taken
 * effect yet, so the matching button must stay disabled and say what it is
 * waiting for.
 *
 * *Derived* server-side on every `runs.getById` read — from the durable Redis
 * cancellation marker for a `running` run, and from the run's waiting
 * `manual-retry` dispatch otherwise — not a column, and never the local
 * mutation's lifetime. That is what makes it survive a reload and read the same
 * for every viewer of the run rather than only the operator who clicked.
 */
/**
 * Mirrors the server `RunPreservedWorker` (`src/api/routers/runs.ts`, issue #567):
 * the machine holding this run's preserved checkout, or — once an operator has
 * restarted the run instead of continuing it — the machine whose preserved work
 * was discarded.
 *
 * A continuation runs *only* on the preserved machine, and waits for it without a
 * timeout, so the run has to be able to say which machine that is for as long as it
 * waits. Resolved server-side on every `runs.getById` read, so it reads the same for
 * every viewer rather than only for whoever triggered the wait.
 */
export interface RunPreservedWorker {
	state: 'preserved' | 'abandoned';
	workerId: string;
	/** Null when the worker row no longer resolves — fall back to the id. */
	workerName: string | null;
	/**
	 * Whether the run is *currently* blocked on that machine, resolved server-side
	 * from the active dispatch's `preserved-worker` wait reason — not from the run's
	 * status, which cannot tell the unbounded pin wait from an ordinary rate-limit
	 * deferral that merely also preserved its checkout.
	 */
	waiting: boolean;
}

export interface PendingRunRequest {
	action: 'terminate' | 'restart';
	/** ISO 8601 — when the request was recorded; null when only the bare marker exists. */
	requestedAt: string | null;
	/** ISO 8601 upper bound of the wait, when the run records one; null otherwise. */
	waitUntil: string | null;
}

export interface RunRow {
	id: string;
	projectId: string;
	taskId: string;
	workItemId: string | null;
	workItemTitle: string | null;
	workItemUrl: string | null;
	prNumber: string | null;
	prTitle: string | null;
	/**
	 * URL of the pull request *this* run opened (ADR-004 §4, issue #398) — set
	 * only by a PR-producing phase (Implementation), and never cleared on retry
	 * since the PR outlives the attempt. Distinct from `prNumber`, which is the PR
	 * a run *acted on*. Null for every other phase and pre-existing rows.
	 */
	producedPrUrl: string | null;
	phase: string;
	/** The worker that executed this run; null for an unfederated run and pre-existing rows. */
	workerId: string | null;
	/**
	 * Display name of the worker machine that executed this run, resolved
	 * server-side by `runs.list` (issue #523) so the run list can name the machine
	 * without a second roster query. Null when the run recorded no worker and when
	 * the recorded worker's row no longer resolves — the list then shows no machine
	 * rather than a stale or invented one. Optional because `runs.getById` carries
	 * the richer {@link RunAttribution} instead.
	 */
	workerName?: string | null;
	/** The SWARM user owning `workerId`, denormalized at dispatch so it survives the worker row's removal. */
	workerUserId: string | null;
	/**
	 * Server-resolved display labels for `workerId`/`workerUserId` (issue #446);
	 * null when the run recorded no worker. Returned by `runs.getById` only — the
	 * runs list carries the raw ids without the identity lookup.
	 */
	attribution?: RunAttribution | null;
	engine: string | null;
	model: string | null;
	/** Explicitly requested reasoning level; null = CLI/model default (issue #180). */
	reasoning: string | null;
	status: string;
	/**
	 * Verdict a completed Review run submitted (`approve`/`request-changes`/
	 * `comment`, issue #218); null for non-review phases and pre-existing rows.
	 * Drives the verdict badge a completed Review row shows instead of "Completed".
	 */
	reviewVerdict: string | null;
	/**
	 * This Review run's slot in the review-verdict safety-cap ledger (1 = the
	 * initial review, then one slot per permitted re-review — `REVIEW_VERDICT_CAP`
	 * in `src/db/repositories/reviewVerdictsRepository.ts` is the ceiling,
	 * issue #235); null for non-Review phases, a Review run whose verdict wasn't
	 * ledgered, and pre-existing rows.
	 */
	reviewOrdinal: number | null;
	/**
	 * This Review run's automation outcome (issue #235) — currently only
	 * `manual-intervention-required`, set when this run submitted the last
	 * `request-changes` verdict the cap allows, so Respond-to-review stopped the
	 * automatic cycle instead of dispatching a further review. Null for every other
	 * outcome and pre-existing rows. Drives the "Manual action required" badge
	 * and run-detail callout (issue #242).
	 */
	reviewAutomationOutcome: string | null;
	/**
	 * Provider-neutral merge-automation outcome for a completed Review run's
	 * `approve` verdict (issue #278): one of `merged`/`not-ready`/
	 * `not-eligible`/`policy-blocked`/`unsupported`/`provider-error`/
	 * `retry-exhausted`. Null when merge automation never ran (disabled, or the
	 * verdict wasn't an approval) and for pre-existing rows.
	 */
	reviewMergeOutcome: string | null;
	/** Human-readable detail for `reviewMergeOutcome`; null alongside it. */
	reviewMergeMessage: string | null;
	exitCode: number | null;
	timedOut: boolean;
	error: string | null;
	startedAt: string;
	completedAt: string | null;
	nextRetryAt: string | null;
	durationMs: number | null;
	usage: AgentUsage | null;
	jobPayload: unknown | null;
	/**
	 * Captured agent-session id kept on a resumable `deferred` run, so its pending
	 * retry can continue the CLI session rather than start fresh (issue #227).
	 * Non-null only while `deferred` and resumable — the server clears it for a
	 * non-resumable deferral and a terminal `failed` run (see the router's
	 * `hasResumableDeferredRun` guard). Mirrors the `agent_session_id` column.
	 */
	agentSessionId: string | null;
	/**
	 * The Tier 2 checkpoint this run was settled `checkpointed` with (issue #503) —
	 * the hand-off the stopped agent left in its worktree, persisted on the row so
	 * the detail page can show the recorded remainder without reading a (possibly
	 * remote) worker's filesystem. Null for every run that never handed off, and it
	 * survives an ordinary retry as the record of what the current attempt was
	 * seeded from. Mirrors the `checkpoint` column.
	 */
	checkpoint?: Checkpoint | null;
	/**
	 * How many times this run has already been continued from its checkpoint — the
	 * spent half of the bounded Tier 2 fallback. Deliberately *not* cleared by a
	 * retry (that would unbound the loop), only by "Reset & restart". Optional here
	 * because pre-#503 payloads carry no such field.
	 */
	continuationCount?: number;
	/**
	 * The project's checkpoint-continuation ceiling this run's `continuationCount`
	 * reads against — `pipeline.maxContinuations`, resolved server-side by
	 * `runs.getById` (issue #504) so the default never has to be re-declared here.
	 * Returned only for a run that carries a checkpoint; null otherwise, and for a
	 * project that no longer resolves, in which case the panel shows the spent count
	 * without a ceiling rather than a fabricated one.
	 */
	maxContinuations?: number | null;
	/**
	 * Preservation/recovery state for failed or resumed runs.
	 */
	recovery?: {
		/** Optional since issue #567 — a recorded machine can stand alone (see below). */
		state?: 'preserved' | 'recovered' | 'blocked';
		/** Mirrors `BlockedRecoveryReason` (`src/worktree/reclaim.ts`); keep the unions in sync. */
		blockedReason?:
			| 'dirty'
			| 'unpushed'
			| 'live-leased'
			| 'missing-validation'
			| 'resumable-owner'
			| 'checkpoint-divergent';
		agentSessionId?: string | null;
		/** The machine holding this run's preserved checkout (issue #567). */
		preservedWorkerId?: string | null;
		/** The machine whose preserved checkout a "Reset & restart" discarded (issue #567). */
		abandonedWorkerId?: string | null;
	} | null;
	/**
	 * Mirrors the server `RunPreservedWorker` (`src/api/routers/runs.ts`, issue
	 * #567): the machine that holds — or has had discarded — this run's preserved
	 * checkout, resolved server-side to a display label. Returned by `runs.getById`
	 * only; null when the run records neither.
	 */
	preservedWorker?: RunPreservedWorker | null;
	/**
	 * Recorded cancellation origin (issue #308); null for a marker-only
	 * (external/unknown) cancellation, a run never cancelled, and every
	 * pre-existing row. Mirrors the `cancellation` column.
	 */
	cancellation?: CancellationOrigin | null;
	/**
	 * The accepted Terminate / Reset & restart request still outstanding against
	 * this run (issue #561), or null when there is none. Returned by
	 * `runs.getById` only — the runs list renders neither button, so it carries no
	 * such field; optional for exactly that reason.
	 */
	pendingRequest?: PendingRunRequest | null;
	/** Evidence-based terminal diagnosis; null for ordinary and historical runs. */
	failureDiagnosis: FailureDiagnosis | null;
}
