import {
	bigint,
	bigserial,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uuid,
} from 'drizzle-orm/pg-core';
import type { AgentUsage } from '../../harness/usage.js';
import type { Checkpoint } from '../../pipeline/checkpoint.js';
import type { ProposedScope } from '../../pipeline/planning.js';
import type { CancellationOrigin } from '../../queue/cancellation.js';
import type { SwarmJob } from '../../queue/jobs.js';
import type { FailureDiagnosis } from '../../worker/failure-diagnosis.js';
import { projects } from './projects.js';
import { users } from './users.js';
import { workers } from './workers.js';

export const runs = pgTable(
	'runs',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		/**
		 * The repository this run acted on, in `ProjectConfig.repo`'s `owner/repo`
		 * form (issue #683) — denormalized alongside `project_id` rather than joined
		 * through it, exactly as `review_verdicts.repository` is
		 * (`src/db/schema/reviewVerdicts.ts`).
		 *
		 * A project id alone does not identify a repository: it does so only while a
		 * project owns exactly one repo, which is what makes every value derived from
		 * `project.repo` (PR links, prior-review lookups) ambiguous the moment a
		 * project spans several. Recording it here makes the run itself the answer to
		 * "which repo was this for?".
		 *
		 * Written once, at creation (`createRun`), from the repository the dispatch
		 * resolved; deliberately *not* rewritten by a retry
		 * ({@link resetRunToRunning}) — a retry re-runs the same work against the
		 * same repository.
		 */
		repository: text('repository').notNull(),
		taskId: text('task_id').notNull(),
		workItemId: text('work_item_id'),
		workItemTitle: text('work_item_title'),
		workItemUrl: text('work_item_url'),
		prNumber: text('pr_number'),
		/**
		 * PR title for PR-driven phases (review / respond-to-*), fetched
		 * best-effort at run creation (`tryCreateRun`). Nullable: board-driven
		 * phases (planning/implementation) carry a `workItemTitle` instead, and
		 * pre-existing rows have none.
		 */
		prTitle: text('pr_title'),
		/**
		 * The pull request this run *produced*, as its provider-neutral URL — the PR
		 * end of the worker→PR attribution record (ADR-004 §4, issue #398). Distinct
		 * from `prNumber`, which is the PR a PR-*driven* run acted on: only a phase
		 * that creates a PR (Implementation) sets this, reported in its phase result
		 * and persisted at settle. Nullable for every other phase and every
		 * pre-existing row. Deliberately *not* cleared on a retry
		 * ({@link resetRunToRunning}): the PR is a real external artifact that
		 * outlives the attempt.
		 */
		producedPrUrl: text('produced_pr_url'),
		phase: text('phase').notNull(),
		/** Registered worker that was authenticated and capacity-claimed for this attempt. */
		workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'set null' }),
		/**
		 * The SWARM user who owns the worker this attempt was dispatched to — the
		 * "whose worker produced this?" half of the attribution record (ADR-004 §4,
		 * issue #398), taken from `DispatchSelection.ownerUserId`. Stored rather than
		 * joined through `workers.owner_user_id` so the attribution survives the
		 * worker row being removed (`worker_id` is `ON DELETE SET NULL`). Nullable:
		 * an unfederated run (no worker enrolled in the project) resolves no
		 * selection and records no worker at all, as does every pre-existing row.
		 */
		workerUserId: uuid('worker_user_id').references(() => users.id, { onDelete: 'set null' }),
		/** Session fencing token used to bind this attempt to that worker host. */
		workerFencingToken: bigint('worker_fencing_token', { mode: 'number' }),
		engine: text('engine'),
		model: text('model'),
		/**
		 * The explicitly requested normalized reasoning level for this attempt
		 * (`src/harness/models.ts`, issue #180). Nullable: null means "Default" —
		 * no reasoning was configured, so the CLI/model used its own default.
		 */
		reasoning: text('reasoning'),
		status: text('status').notNull().default('running'),
		/**
		 * The formal verdict a completed Review run submitted (`REVIEW_VERDICTS`,
		 * `src/pipeline/review.ts` — `approve` or `request-changes`), issue #218.
		 * Rows written before issue #470 can also hold the retired `comment`
		 * verdict; nothing produces one any more, but they stay readable.
		 * Persisted so the runs list can show the review's actual outcome
		 * instead of a generic "Completed". Nullable: only Review runs that
		 * submitted a review set it — every other phase, and any pre-existing row,
		 * leaves it null. Cleared on a retry ({@link resetRunToRunning}) so a
		 * re-running review never shows a stale verdict.
		 */
		reviewVerdict: text('review_verdict'),
		/**
		 * This Review run's slot number in the review-verdict safety-cap ledger
		 * (`review_verdicts`, issue #235) — 1 (initial review) or 2–3 (the two
		 * permitted re-reviews). Nullable: only a completed Review run whose
		 * verdict was recorded in the ledger sets it; every other phase, and any
		 * pre-existing row, leaves it null. Cleared on a retry alongside
		 * `reviewVerdict` ({@link resetRunToRunning}).
		 */
		reviewOrdinal: integer('review_ordinal'),
		/**
		 * The review-automation outcome for a completed Review run — currently only
		 * `manual-intervention-required`, set when this run submitted the last
		 * `request-changes` verdict the cap allows, so Respond-to-review stops the
		 * automatic cycle instead of dispatching a further review. Nullable: every
		 * other outcome (approvals, the first verdict, non-Review phases) leaves it
		 * null. Cleared on a retry alongside `reviewVerdict`.
		 */
		reviewAutomationOutcome: text('review_automation_outcome'),
		/**
		 * Provider-neutral merge-automation outcome for this Review run's approval
		 * (`src/scm/merge.ts`; written by the durable merge dispatch,
		 * `src/worker/merge-automation.ts`, issue #292) — one of
		 * `MergePullRequestOutcome['status']` (`merged`/`not-ready`/`not-eligible`/
		 * `policy-blocked`/`unsupported`/`provider-error`) or `retry-exhausted`
		 * once the dispatch's bounded retry budget is spent while still
		 * `not-ready`. Nullable: only a Review run whose verdict was `approve`
		 * with merge automation enabled ever sets it. Cleared on a retry
		 * alongside `reviewVerdict`.
		 */
		reviewMergeOutcome: text('review_merge_outcome'),
		/** Human-readable detail for `reviewMergeOutcome` — always set alongside it. */
		reviewMergeMessage: text('review_merge_message'),
		/**
		 * The merge dispatch attempt the current `reviewMergeOutcome` was written
		 * by (0 = the dispatch's first attempt). Lets a worker restart resume
		 * attempt numbering instead of restarting the backoff schedule from
		 * scratch.
		 */
		reviewMergeAttempt: integer('review_merge_attempt'),
		/**
		 * The head SHA the current `reviewMergeOutcome` generation covers. An
		 * attempt's write is only accepted while this still matches the
		 * generation it was scheduled for (`updateReviewMergeOutcome`), so a
		 * stale attempt left over from a superseded review (e.g. after a
		 * retried Review re-submits) can't clobber a newer outcome.
		 */
		reviewMergeApprovedHeadSha: text('review_merge_approved_head_sha'),
		exitCode: integer('exit_code'),
		timedOut: boolean('timed_out').notNull().default(false),
		error: text('error'),
		startedAt: timestamp('started_at').defaultNow().notNull(),
		completedAt: timestamp('completed_at'),
		nextRetryAt: timestamp('next_retry_at'),
		durationMs: integer('duration_ms'),
		/**
		 * Stored agent timeout (issue #165 review), capture the effective timeout
		 * in milliseconds for this attempt to accurately reconcile stale runs.
		 */
		timeoutMs: integer('timeout_ms'),
		/**
		 * Per-run token usage (issue #138), reported by the agent CLI where it
		 * exposes one — nullable: unsupported CLIs (`antigravity`/`codex`, until a
		 * follow-up task) and every pre-existing run have none.
		 */
		usage: jsonb('usage').$type<AgentUsage>(),
		// Retained solely to preserve historical run data from the removed delegation feature.
		delegations: jsonb('delegations'),
		/**
		 * Persisted SwarmJob payload (issue #152) to allow retrying terminally
		 * failed runs. Nullable for backward compatibility.
		 */
		jobPayload: jsonb('job_payload').$type<SwarmJob>(),
		/**
		 * Structured scope declaration persisted from a completed normal Planning
		 * run. Nullable for older rows, non-Planning runs, and preplanned children.
		 */
		planningScope: jsonb('planning_scope').$type<ProposedScope>(),
		/**
		 * Evidence-based explanation for a terminal failure. The raw `error` stays
		 * separate so the dashboard can show both the recovery guidance and detail.
		 */
		failureDiagnosis: jsonb('failure_diagnosis').$type<FailureDiagnosis>(),
		/** Claude Code session handle used to continue a deferred PM phase. */
		agentSessionId: uuid('agent_session_id'),
		/**
		 * The Tier 2 checkpoint hand-off this run was settled `checkpointed` with
		 * (`docs/CHECKPOINTS.md`, issue #503) — the parsed `swarm_checkpoint.json` the
		 * stopped agent left in its worktree. Stored on the row, not read back off
		 * disk, so the API and dashboard can show the recorded remainder without
		 * reaching into a (possibly remote) worker's filesystem. Nullable: only a
		 * `checkpointed` settle writes one, and it survives an ordinary retry as the
		 * record of what the current attempt was seeded from — "Reset & restart"
		 * ({@link clearRunRecovery}) clears it.
		 */
		checkpoint: jsonb('checkpoint').$type<Checkpoint>(),
		/**
		 * How many times this run has already been continued from a checkpoint. The
		 * bound on the Tier 2 fallback: once it reaches the project's
		 * `pipeline.maxContinuations`, the next involuntary stop fails terminally
		 * ("continuation budget exhausted") instead of handing off again. Deliberately
		 * **not** cleared by a retry ({@link resetRunToRunning}) — that would unbound
		 * the loop — only by "Reset & restart" ({@link clearRunRecovery}).
		 */
		continuationCount: integer('continuation_count').notNull().default(0),
		outputBytes: integer('output_bytes').notNull().default(0),
		outputTruncated: boolean('output_truncated').notNull().default(false),
		recovery: jsonb('recovery').$type<{
			/**
			 * Optional since issue #567: the two machine-location facts below are
			 * recorded on runs that have no recovery *state* at all — a `deferred` or
			 * `checkpointed` run preserves a checkout without ever writing one.
			 */
			state?: 'preserved' | 'recovered' | 'blocked';
			// Kept in sync with `BlockedRecoveryReason` (`src/worktree/reclaim.ts`).
			// `resumable-owner` (issue #367) marks a collision blocked because a
			// resumable deferred/failed run still pins the checkout;
			// `checkpoint-divergent` (issue #502) marks a Tier 2 continuation blocked
			// because the checkpoint no longer describes the checkout. Widening this
			// union needs no SQL migration — the column is free-form `jsonb`.
			blockedReason?:
				| 'dirty'
				| 'unpushed'
				| 'live-leased'
				| 'missing-validation'
				| 'resumable-owner'
				| 'checkpoint-divergent';
			agentSessionId?: string | null;
			/**
			 * The worker whose machine holds this run's **preserved checkout** (issue
			 * #567) — recorded at the settle that preserved it
			 * ({@link recordRunPreservedWorker}), from the attempt's own `worker_id`.
			 *
			 * It lives here rather than being read back off `worker_id` because that
			 * column is the *last attempt's* worker and is overwritten at every bind:
			 * once a continuation re-binds the run to another machine, the location of
			 * the surviving checkout would be unrecoverable. A checkpoint, a resumable
			 * session, and a delivery sidecar are all machine-local, so a continuation
			 * that lands anywhere else silently redoes the work — which is exactly what
			 * this pins against (`src/worker/eligibility-gate.ts`).
			 *
			 * Survives a re-bind ({@link resetRunToRunning} carries it forward onto the
			 * `recovered` record the next attempt writes) and is dropped only when the
			 * run stops recovering: a fresh, non-recovery attempt, or the operator's
			 * "Reset & restart" ({@link clearRunRecovery}).
			 */
			preservedWorkerId?: string | null;
			/**
			 * The machine whose preserved checkout an operator deliberately **discarded**
			 * (issue #567) — written by "Reset & restart" ({@link clearRunRecovery}) from
			 * the `preservedWorkerId` it just cleared.
			 *
			 * The durable record that this run started over rather than continued, which
			 * nothing said before. Unlike every other field here it is a historical fact
			 * about the row rather than live recovery state, so it is the one key a fresh
			 * attempt's recovery rewrite does not clear.
			 */
			abandonedWorkerId?: string | null;
		}>(),
		/**
		 * This run's recorded cancellation origin (issue #308), mirroring
		 * `CancellationOrigin` (`src/queue/cancellation.ts`). Nullable: only a
		 * `failed` run whose cancellation was requested through the supported
		 * dashboard/API `terminate` action has one — a marker-only (external/
		 * unknown) cancellation, a run never cancelled, and every pre-existing row
		 * leave it null. Cleared on a retry alongside the other terminal-outcome
		 * columns ({@link resetRunToRunning}) so a re-run never inherits a stale
		 * origin from a prior cancelled attempt.
		 */
		cancellation: jsonb('cancellation').$type<CancellationOrigin>(),
	},
	(table) => [
		index('idx_runs_project_id').on(table.projectId),
		index('idx_runs_status').on(table.status),
		index('idx_runs_started_at').on(table.startedAt),
		index('idx_runs_worker_id').on(table.workerId),
	],
);

export const runLogs = pgTable('run_logs', {
	id: uuid('id').primaryKey().defaultRandom(),
	runId: uuid('run_id')
		.notNull()
		.unique()
		.references(() => runs.id, { onDelete: 'cascade' }),
	stdout: text('stdout'),
	stderr: text('stderr'),
});

export const runOutputEvents = pgTable(
	'run_output_events',
	{
		id: bigserial('id', { mode: 'number' }).primaryKey(),
		runId: uuid('run_id')
			.notNull()
			.references(() => runs.id, { onDelete: 'cascade' }),
		stream: text('stream').$type<'stdout' | 'stderr'>().notNull(),
		content: text('content').notNull(),
		emittedAt: timestamp('emitted_at').defaultNow().notNull(),
	},
	(table) => [index('idx_run_output_events_cursor').on(table.runId, table.id)],
);
