import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core';
import type { SwarmJob } from '../../queue/jobs.js';
import { projects } from './projects.js';
import { runs } from './runs.js';
import { workerSessions } from './workerSessions.js';
import { workers } from './workers.js';

/**
 * The durable dispatch record — the single source of truth for every attempt to
 * start or resume a pipeline phase (issue #284, ADR-002). BullMQ jobs are pure
 * wake-ups pointing at one of these rows; the worker may act on a dispatch only
 * after atomically claiming it, so every future delivery path (a redelivered
 * wake-up, a delayed retry, a slot release, reconciliation) re-checks this row's
 * state and terminal states can never be resurrected.
 *
 * States: `pending` → `leased` → `running` → terminal (`completed`/`failed`),
 * with `retry-scheduled` for a deferred attempt awaiting its scheduled wake-up
 * and `cancelled` for user/operator cancellation. All transitions are
 * conditional updates in `dispatchesRepository.ts`.
 */
export const dispatches = pgTable(
	'dispatches',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		/** Worktree task id, known only once the trigger resolved (null before). */
		taskId: text('task_id'),
		/** Resolved pipeline phase; null until the trigger registry resolves it. */
		phase: text('phase'),
		/**
		 * The repository this dispatch acts on, in `ProjectConfig.repo`'s `owner/repo`
		 * form — denormalized beside `project_id` exactly as `runs.repository` (issue
		 * #683) and `review_verdicts.repository` are, because a project id alone stopped
		 * identifying a repository at issue #684. Null until the trigger registry
		 * resolves the phase; null for ever on a dispatch that never was claimed.
		 */
		repository: text('repository'),
		/**
		 * The pull request this phase acts on — the artifact the PR-scoped hold is keyed
		 * on (issue #850). Written with `repository` when the trigger resolves; null for
		 * the board-driven phases, which act on a card rather than a PR, and for the
		 * agent-less `merge-automation` kind, which never contends for the branch.
		 */
		prNumber: text('pr_number'),
		state: text('state').notNull().default('pending'),
		/**
		 * Why a non-terminal dispatch is waiting: `project-capacity`, `rate-limit`,
		 * `agent-capacity`, `timeout`, `worker-shutdown`, `delivery`,
		 * `worktree-exists`, `stalled`, `recheck`, `worker-eligibility`,
		 * `worker-authorization`, `preserved-worker`, `task-in-flight` (a later phase
		 * of a task whose earlier phase is still executing — issue #759 — or an
		 * Implementation behind a Planning dispatch it must not overtake, queued or
		 * executing — issue #761), `pr-in-flight` (a branch-writing phase behind
		 * another one executing against the same pull request's head branch — issue
		 * #850), `manual-retry`, `recovered`. Null while leased/running and for
		 * terminal states.
		 */
		waitReason: text('wait_reason'),
		/**
		 * Terminal detail for `completed`: `phase-succeeded`, `no-trigger`,
		 * `skipped-duplicate` (a repeated delivery of the *same* phase already
		 * executing for this task — a *different* phase waits as `task-in-flight`
		 * instead, issue #759), `skipped-not-eligible` (the work item is not opted
		 * into automation — issue #131), `skipped-pr-in-flight` (a Review a writing
		 * phase of the same pull request made moot — issue #850), or `superseded` (a
		 * coalesced recheck replaced it).
		 */
		outcome: text('outcome'),
		/**
		 * Stable idempotency identity — webhook delivery ids (`delivery:<id>`) and
		 * deterministic synthetic identities (follow-up review hashes). Unique for
		 * all time, so a redelivery or a crash-retried enqueue can't mint a second
		 * dispatch.
		 */
		dedupKey: text('dedup_key'),
		/**
		 * Coalescing identity for bounded rechecks (`check-suite:…`,
		 * `resolve-conflicts:…`): scheduling a new recheck supersedes prior
		 * non-terminal dispatches carrying the same key.
		 */
		coalesceKey: text('coalesce_key'),
		/** SCM continuations jump ahead of new board work when the project opts in. */
		continuation: boolean('continuation').notNull().default(false),
		/** Effective queue priority (BullMQ ranks 0/unset highest). */
		priority: integer('priority').notNull().default(0),
		/** Deferred-retry attempt counter (mirrors the payload's rateLimitRetryAttempt). */
		attempt: integer('attempt').notNull().default(0),
		/**
		 * Monotonic wake-up sequence. Bumped on every transition into a wakeable
		 * state; the BullMQ wake-up job id is `dispatch_<id>_w<wakeSeq>`, so a
		 * repair re-publish is a queue no-op while a completed stale wake-up can
		 * never suppress a fresh one.
		 */
		wakeSeq: integer('wake_seq').notNull().default(0),
		/** When this dispatch becomes eligible to run (retry time, or now). */
		availableAt: timestamp('available_at').notNull().defaultNow(),
		/** The full validated SwarmJob payload — the exact dispatch intent. */
		jobPayload: jsonb('job_payload').$type<SwarmJob>().notNull(),
		/** The runs row this dispatch's attempts execute against, once one exists. */
		runId: uuid('run_id').references(() => runs.id, { onDelete: 'set null' }),
		/** Worker selected and capacity-claimed for this attempt; retained on terminal rows for audit. */
		selectedWorkerId: uuid('selected_worker_id').references(() => workers.id, {
			onDelete: 'set null',
		}),
		/** The live worker session that owned this attempt's execution claim. */
		workerSessionId: uuid('worker_session_id').references(() => workerSessions.id, {
			onDelete: 'set null',
		}),
		/** Fencing token observed while atomically claiming the selected session/capacity. */
		workerFencingToken: bigint('worker_fencing_token', { mode: 'number' }),
		leaseOwner: text('lease_owner'),
		leaseExpiresAt: timestamp('lease_expires_at'),
		lastError: text('last_error'),
		/** Where this dispatch came from: `webhook`, `synthetic`, `recheck`, `manual`, `recovered`, `adopted`. */
		source: text('source').notNull().default('webhook'),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at').notNull().defaultNow(),
		completedAt: timestamp('completed_at'),
	},
	(table) => [
		uniqueIndex('uq_dispatches_dedup_key').on(table.dedupKey),
		// At most one non-terminal dispatch per run row — the durable guard that
		// stops a double retry (manual + automatic, or backfill + legacy job) from
		// ever producing two concurrent attempts of the same logical run.
		uniqueIndex('uq_dispatches_active_run')
			.on(table.runId)
			.where(sql`state IN ('pending', 'leased', 'running', 'retry-scheduled')`),
		index('idx_dispatches_state').on(table.state),
		index('idx_dispatches_project_state').on(table.projectId, table.state),
		index('idx_dispatches_coalesce_key').on(table.coalesceKey),
		index('idx_dispatches_selected_worker').on(table.selectedWorkerId, table.state),
	],
);
