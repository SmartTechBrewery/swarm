/**
 * Durable dispatch persistence (issue #284, ADR-002) — the state machine behind
 * every attempt to start or resume a pipeline phase. Mirrors the plain-function
 * shape of the other repositories (one `getDb()` per call, no class).
 *
 * Every lifecycle transition here is a *conditional* UPDATE (`WHERE state IN
 * (…) RETURNING`): the row's current state is the only arbiter, so two racing
 * actors — a wake-up job and a manual retry, a cancel and a slot release —
 * resolve to exactly one winner, and terminal states (`cancelled`, `completed`,
 * `failed`) can never be resurrected by a late wake-up. Orchestration (what to
 * enqueue, when to wake) lives in `src/dispatch/`; this module owns only the
 * durable record.
 */

import {
	and,
	asc,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	lte,
	ne,
	notInArray,
	or,
	type SQL,
	sql,
} from 'drizzle-orm';
import type { AgentCli } from '../../harness/agent-cli.js';
import { isSessionLive } from '../../identity/worker-session.js';
import type { SwarmJob } from '../../queue/jobs.js';
import type { TriggerPhase } from '../../triggers/types.js';
import { getDb } from '../client.js';
import { dispatches } from '../schema/dispatches.js';
import { projects } from '../schema/projects.js';
import { runs } from '../schema/runs.js';
import { workerProjectEnrollments } from '../schema/workerProjectEnrollments.js';
import { workerSessions } from '../schema/workerSessions.js';
import { workers } from '../schema/workers.js';
import { RETRY_PENDING_RUN_STATUSES } from './runsRepository.js';

export type DispatchRow = typeof dispatches.$inferSelect;

/** Every lifecycle state a dispatch can hold. */
export type DispatchState =
	| 'pending'
	| 'leased'
	| 'running'
	| 'retry-scheduled'
	| 'cancelled'
	| 'completed'
	| 'failed';

/** Non-terminal states — exactly the set the partial unique run index covers. */
export const ACTIVE_DISPATCH_STATES = [
	'pending',
	'leased',
	'running',
	'retry-scheduled',
] as const satisfies readonly DispatchState[];

/**
 * States in which a worker is actually executing against the task's checkout —
 * the dispatch-side half of the worktree-lease liveness signal (issue #427).
 * `pending`/`retry-scheduled` are deliberately excluded: a queued attempt holds
 * no checkout, and counting it as an owner would just re-create the wedge the
 * liveness check exists to break.
 */
export const EXECUTING_DISPATCH_STATES = [
	'leased',
	'running',
] as const satisfies readonly DispatchState[];

/** States awaiting a wake-up — what the Queue API/UI shows. */
export const WAITING_DISPATCH_STATES = ['pending', 'retry-scheduled'] as const;

/** Why a non-terminal dispatch is waiting rather than running. */
export type DispatchWaitReason =
	| 'project-capacity'
	| 'rate-limit'
	| 'agent-capacity'
	| 'timeout'
	| 'worker-shutdown'
	| 'delivery'
	| 'worktree-exists'
	| 'stalled'
	| 'recheck'
	/**
	 * No eligible worker could take the dispatch (issue #339's federated gate)
	 * because none is *available*: some worker cleared every structural check and
	 * is merely busy or offline, so time alone clears the wait. Narrowed to that
	 * meaning by issue #607 — it keeps the value the rows already carry, and the
	 * refusals a human must clear moved to `worker-authorization`.
	 */
	| 'worker-eligibility'
	/**
	 * The same gate refused for a reason **only a human can clear** (issue #607):
	 * no approved enrollment, no sharing consent, or no worker declaring/allowed
	 * the phase or CLI this project configures. Distinct from
	 * `worker-eligibility` because no machine connecting or freeing capacity can
	 * change the verdict — which is what the Queue shows an operator, and what a
	 * wake-up policy keys on. Same cadence, attempt counter, and budget as the
	 * availability wait.
	 */
	| 'worker-authorization'
	/**
	 * A continuation is waiting for the one machine that holds its preserved
	 * checkout (issue #567). Distinct from `worker-eligibility` on purpose: that
	 * reason means "no capable worker", while this one means the capable workers
	 * are irrelevant — only the recorded machine can continue this run. The one
	 * waiting reason with no budget behind it.
	 */
	| 'preserved-worker'
	/**
	 * A **later phase of a task whose earlier phase is still executing** (issue
	 * #759). The two board-driven phases deliberately share one `taskId` — Planning
	 * and Implementation work in the same `task-<id>` checkout on the same branch
	 * (issue #498, ai/RULES.md §2) — so "Planning finished, the card moved to ToDo"
	 * arrives while Planning may still be in flight. Such a dispatch holds no
	 * checkout, consumes no attempt budget, and is woken when the holding phase
	 * settles rather than by a timer, exactly like `project-capacity`.
	 *
	 * Distinct from two neighbours on purpose. `worktree-exists` is a *failed*
	 * provision retrying on a timer; this one never provisioned. And the
	 * `skipped-duplicate` **outcome** is the other half of the same collision — the
	 * *same* phase arriving twice — which stays terminal, so an operator can tell a
	 * dropped redelivery from a sequenced phase.
	 */
	| 'task-in-flight'
	| 'manual-retry'
	| 'recovered';

/**
 * What a dispatch runs: a pipeline phase, or the agent-less merge-automation
 * executor (issue #292) — the one dispatch kind that never provisions a
 * worktree or spawns an agent CLI.
 */
export type DispatchPhase = TriggerPhase | 'merge-automation';

/**
 * Terminal detail for a `completed` dispatch. The `merge-*` values (and
 * `merged`) settle merge-automation dispatches (issue #292): every functional
 * refusal the provider reports is a normal, visible completion — only an
 * unexpected provider failure marks the dispatch `failed`.
 *
 * `skipped-not-eligible` is the one eligibility outcome: the dispatch resolved a
 * phase, but the work item is not opted into automation (it lacks the project's
 * `pipeline.automationLabel` — issue #131). The worker-authorization gate will
 * settle through the same value with its own reason (issue #339).
 *
 * `skipped-duplicate` is narrower than it reads and deliberately so (issue #759):
 * the **same** phase of a task that is already executing that phase — a repeated
 * delivery. A *different* phase of the same task is the pipeline advancing through
 * one shared checkout, and waits as `task-in-flight` instead of settling here.
 */
export type DispatchOutcome =
	| 'phase-succeeded'
	| 'no-trigger'
	| 'skipped-duplicate'
	| 'skipped-not-eligible'
	| 'superseded'
	| 'merged'
	| 'merge-not-eligible'
	| 'merge-policy-blocked'
	| 'merge-unsupported'
	| 'merge-retry-exhausted';

export interface CreateDispatchInput {
	projectId: string;
	jobPayload: SwarmJob;
	/** Stable idempotency identity; a conflict returns the existing row instead of inserting. */
	dedupKey?: string;
	coalesceKey?: string;
	priority?: number;
	source: 'webhook' | 'synthetic' | 'recheck' | 'manual' | 'recovered' | 'adopted';
	waitReason?: DispatchWaitReason;
	availableAt?: Date;
	continuation?: boolean;
	runId?: string;
	taskId?: string;
	phase?: DispatchPhase;
	attempt?: number;
	/**
	 * `leased` is used only when adopting a legacy in-flight job at dequeue;
	 * `retry-scheduled` only by the startup backfill of orphaned deferred runs.
	 */
	state?: Extract<DispatchState, 'pending' | 'leased' | 'retry-scheduled'>;
	leaseOwner?: string;
	leaseExpiresAt?: Date;
}

/**
 * Insert a dispatch, deduplicating on `dedupKey`: a conflict leaves the
 * existing row untouched and returns it with `created: false`, so a redelivered
 * webhook or a crash-retried synthetic enqueue can never mint a second
 * dispatch. A `runId` conflict (the partial unique active-run index) throws —
 * callers treat that as "a retry for this run is already in flight".
 */
export async function createDispatch(
	input: CreateDispatchInput,
): Promise<{ dispatch: DispatchRow; created: boolean }> {
	const db = getDb();
	const inserted = await db
		.insert(dispatches)
		.values({
			projectId: input.projectId,
			jobPayload: input.jobPayload,
			dedupKey: input.dedupKey,
			coalesceKey: input.coalesceKey,
			priority: input.priority ?? 0,
			source: input.source,
			waitReason: input.waitReason,
			availableAt: input.availableAt ?? new Date(),
			continuation: input.continuation ?? false,
			runId: input.runId,
			taskId: input.taskId,
			phase: input.phase,
			attempt: input.attempt ?? 0,
			state: input.state ?? 'pending',
			leaseOwner: input.leaseOwner,
			leaseExpiresAt: input.leaseExpiresAt,
		})
		.onConflictDoNothing({ target: dispatches.dedupKey })
		.returning();
	if (inserted[0]) return { dispatch: inserted[0], created: true };
	// Dedup conflict — dedupKey is necessarily set (nothing else conflicts on
	// this path) and the prior row for it exists.
	const existing = await db
		.select()
		.from(dispatches)
		.where(eq(dispatches.dedupKey, input.dedupKey ?? ''))
		.limit(1);
	if (!existing[0]) throw new Error('Dispatch dedup conflict but no existing row found');
	return { dispatch: existing[0], created: false };
}

/**
 * Atomically claim a dispatch for execution: `pending`/`retry-scheduled` →
 * `leased`. Re-claiming a lease this owner already holds succeeds (a BullMQ
 * infra retry of the same job must not dead-end its own dispatch). Returns the
 * claimed row, or `null` when the dispatch is terminal, already running, or
 * held by another owner — the caller skips the wake-up as superseded.
 */
export async function claimDispatch(
	id: string,
	owner: string,
	leaseMs: number,
): Promise<DispatchRow | null> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'leased',
			leaseOwner: owner,
			leaseExpiresAt: new Date(now.getTime() + leaseMs),
			waitReason: null,
			selectedWorkerId: sql`CASE WHEN ${dispatches.state} IN ('pending', 'retry-scheduled') THEN NULL ELSE ${dispatches.selectedWorkerId} END`,
			workerSessionId: sql`CASE WHEN ${dispatches.state} IN ('pending', 'retry-scheduled') THEN NULL ELSE ${dispatches.workerSessionId} END`,
			workerFencingToken: sql`CASE WHEN ${dispatches.state} IN ('pending', 'retry-scheduled') THEN NULL ELSE ${dispatches.workerFencingToken} END`,
			updatedAt: now,
		})
		.where(
			and(
				eq(dispatches.id, id),
				sql`(${dispatches.state} IN ('pending', 'retry-scheduled') OR (${dispatches.state} = 'leased' AND ${dispatches.leaseOwner} = ${owner}))`,
			),
		)
		.returning();
	return rows[0] ?? null;
}

/**
 * Mark a claimed dispatch `running` against its run row, renewing the lease to
 * cover the phase's effective wall-clock timeout (plus the caller's margin) so
 * a live run is never reclaimed mid-flight.
 */
export async function markDispatchRunning(
	id: string,
	runId: string | undefined,
	leaseUntil: Date,
	taskId: string,
	phase: TriggerPhase,
): Promise<boolean> {
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'running',
			runId,
			taskId,
			phase,
			leaseExpiresAt: leaseUntil,
			updatedAt: new Date(),
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning({ id: dispatches.id });
	return rows.length > 0;
}

/** Record the resolved task/phase on a claimed dispatch (before a run row exists). */
export async function recordDispatchResolution(
	id: string,
	taskId: string,
	phase: TriggerPhase,
): Promise<void> {
	await getDb()
		.update(dispatches)
		.set({ taskId, phase, updatedAt: new Date() })
		.where(eq(dispatches.id, id));
}

export type WorkerDispatchClaimRefusal =
	| 'not-claimable'
	| 'wrong-worker-host'
	| 'project-capacity'
	| 'worker-unavailable'
	| 'missing-enrollment'
	| 'missing-consent'
	| 'missing-cli-capability';

export type WorkerDispatchClaimResult =
	| { claimed: true; dispatch: DispatchRow }
	| { claimed: false; reason: WorkerDispatchClaimRefusal };

export interface ClaimWorkerForDispatchInput {
	dispatchId: string;
	dispatchLeaseOwner: string;
	projectId: string;
	selectedWorkerId: string;
	executionWorkerId: string;
	workerSessionId: string;
	workerFencingToken: number;
	cli: AgentCli;
	heartbeatTtlMs: number;
}

function dispatchClaimRefusal(
	dispatch: DispatchRow | undefined,
	input: ClaimWorkerForDispatchInput,
): WorkerDispatchClaimRefusal | undefined {
	if (!dispatch) return 'not-claimable';
	if (dispatch.state !== 'leased') return 'not-claimable';
	if (dispatch.leaseOwner !== input.dispatchLeaseOwner) return 'not-claimable';
	if (dispatch.projectId !== input.projectId) return 'not-claimable';
	return undefined;
}

function sessionClaimRefusal(
	session: typeof workerSessions.$inferSelect | undefined,
	input: ClaimWorkerForDispatchInput,
	now: Date,
): WorkerDispatchClaimRefusal | undefined {
	if (!session) return 'worker-unavailable';
	if (session.workerId !== input.selectedWorkerId) return 'worker-unavailable';
	if (session.fencingToken !== input.workerFencingToken) return 'worker-unavailable';
	if (session.released) return 'worker-unavailable';
	if (!isSessionLive(session.lastHeartbeatAt, input.heartbeatTtlMs, now)) {
		return 'worker-unavailable';
	}
	return undefined;
}

/**
 * Re-checks, under the session-row lock, the structural signals the gate observed
 * a moment earlier — closing the observe-then-execute race.
 *
 * Deliberately **not** re-checking the worker's declared `supportedPhases` (issue
 * #467), even though the gate does: the claim input carries a `cli`, not a phase,
 * and the only way the phase set changes mid-flight is a daemon re-handshaking as
 * the *other* worker program (in-process ↔ DB-free) inside that window. If that
 * ever happens the DB-free worker's own unsupported-phase gate
 * (`SUPPORTED_DB_FREE_PHASES`, `src/transport/assignment-execution.ts`) refuses the
 * assignment — the pre-#467 symptom, not a worse one. Widening the claim to carry
 * a phase is the fix if that race is ever observed; it is not worth the surface
 * today.
 */
function eligibilityClaimRefusal(
	worker: typeof workers.$inferSelect | undefined,
	enrollment: typeof workerProjectEnrollments.$inferSelect | undefined,
	cli: AgentCli,
): WorkerDispatchClaimRefusal | undefined {
	if (!worker || !enrollment || enrollment.status !== 'active') return 'missing-enrollment';
	if (!enrollment.sharingConsent) return 'missing-consent';
	if (!worker.capabilities.includes(cli) || !enrollment.allowedClis.includes(cli)) {
		return 'missing-cli-capability';
	}
	return undefined;
}

/**
 * Whether a worker's active-run count meets or exceeds its share of this project
 * (`concurrencyAllocation`, always a positive integer — issue #480). A missing
 * enrollment is refused earlier by {@link eligibilityClaimRefusal}, so it cannot
 * exceed anything here.
 */
function workerAllocationExceeded(
	enrollment: typeof workerProjectEnrollments.$inferSelect | undefined,
	activeRuns: number,
): boolean {
	return enrollment !== undefined && activeRuns >= enrollment.concurrencyAllocation;
}

/**
 * Bind a leased dispatch to the selected worker's authenticated live session and
 * atomically reserve one project allocation slot. The worker-session row is the
 * serialization lock: every claim for the same worker queues behind it, so the
 * active-claim count and insert/update form one capacity decision.
 */
export async function claimWorkerForDispatch(
	input: ClaimWorkerForDispatchInput,
): Promise<WorkerDispatchClaimResult> {
	if (input.selectedWorkerId !== input.executionWorkerId) {
		return { claimed: false, reason: 'wrong-worker-host' };
	}

	return getDb().transaction(async (tx) => {
		const now = new Date();
		const [dispatch] = await tx
			.select()
			.from(dispatches)
			.where(eq(dispatches.id, input.dispatchId))
			.for('update')
			.limit(1);
		const dispatchRefusal = dispatchClaimRefusal(dispatch, input);
		if (dispatchRefusal) return { claimed: false, reason: dispatchRefusal };
		const [project] = await tx
			.select({ maxConcurrentJobs: projects.maxConcurrentJobs })
			.from(projects)
			.where(eq(projects.id, input.projectId))
			.for('update')
			.limit(1);

		const [session] = await tx
			.select()
			.from(workerSessions)
			.where(eq(workerSessions.id, input.workerSessionId))
			.for('update')
			.limit(1);
		const sessionRefusal = sessionClaimRefusal(session, input, now);
		if (sessionRefusal) return { claimed: false, reason: sessionRefusal };

		const [worker] = await tx
			.select()
			.from(workers)
			.where(eq(workers.id, input.selectedWorkerId))
			.limit(1);
		const [enrollment] = await tx
			.select()
			.from(workerProjectEnrollments)
			.where(
				and(
					eq(workerProjectEnrollments.workerId, input.selectedWorkerId),
					eq(workerProjectEnrollments.projectId, input.projectId),
				),
			)
			.for('update')
			.limit(1);
		const eligibilityRefusal = eligibilityClaimRefusal(worker, enrollment, input.cli);
		if (eligibilityRefusal) return { claimed: false, reason: eligibilityRefusal };

		const activeClaimPredicate = and(
			ne(dispatches.id, input.dispatchId),
			inArray(dispatches.state, ['leased', 'running']),
			gt(dispatches.leaseExpiresAt, now),
		);
		const [projectCapacity] = await tx
			.select({ activeRuns: sql<number>`count(*)::int` })
			.from(dispatches)
			.where(
				and(
					eq(dispatches.projectId, input.projectId),
					sql`${dispatches.selectedWorkerId} IS NOT NULL`,
					activeClaimPredicate,
				),
			);
		if ((projectCapacity?.activeRuns ?? 0) >= (project?.maxConcurrentJobs ?? 0)) {
			return { claimed: false, reason: 'project-capacity' };
		}

		const [workerCapacity] = await tx
			.select({ activeRuns: sql<number>`count(*)::int` })
			.from(dispatches)
			.where(
				and(
					eq(dispatches.projectId, input.projectId),
					eq(dispatches.selectedWorkerId, input.selectedWorkerId),
					activeClaimPredicate,
				),
			);
		if (workerAllocationExceeded(enrollment, workerCapacity?.activeRuns ?? 0)) {
			return { claimed: false, reason: 'worker-unavailable' };
		}

		const [claimed] = await tx
			.update(dispatches)
			.set({
				selectedWorkerId: input.selectedWorkerId,
				workerSessionId: input.workerSessionId,
				workerFencingToken: input.workerFencingToken,
				updatedAt: now,
			})
			.where(
				and(
					eq(dispatches.id, input.dispatchId),
					eq(dispatches.state, 'leased'),
					eq(dispatches.leaseOwner, input.dispatchLeaseOwner),
				),
			)
			.returning();
		return { claimed: true, dispatch: claimed as DispatchRow };
	});
}

/** Active, unexpired execution claims for a worker, optionally within one project. */
export async function getWorkerDispatchClaimState(
	workerId: string,
	projectId?: string,
): Promise<{ activeRuns: number; currentRunId: string | null }> {
	const predicates = [
		eq(dispatches.selectedWorkerId, workerId),
		inArray(dispatches.state, ['leased', 'running']),
		gt(dispatches.leaseExpiresAt, new Date()),
	];
	if (projectId) predicates.push(eq(dispatches.projectId, projectId));
	const [summary] = await getDb()
		.select({
			activeRuns: sql<number>`count(*)::int`,
			currentRunId: sql<string | null>`min(${dispatches.runId}::text)`,
		})
		.from(dispatches)
		.where(and(...predicates));
	return {
		activeRuns: summary?.activeRuns ?? 0,
		currentRunId: summary?.currentRunId ?? null,
	};
}

/**
 * Retrieve active, unexpired durable dispatch claims for a worker.
 */
export async function getActiveWorkerClaims(
	workerId: string,
): Promise<{ runId: string | null; projectId: string }[]> {
	return getDb()
		.select({
			runId: dispatches.runId,
			projectId: dispatches.projectId,
		})
		.from(dispatches)
		.where(
			and(
				eq(dispatches.selectedWorkerId, workerId),
				inArray(dispatches.state, ['leased', 'running']),
				gt(dispatches.leaseExpiresAt, new Date()),
			),
		)
		.orderBy(asc(dispatches.runId));
}

/** Settle a leased/running dispatch as `completed` with a terminal outcome. */
export async function completeDispatch(id: string, outcome: DispatchOutcome): Promise<boolean> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'completed',
			outcome,
			waitReason: null,
			leaseOwner: null,
			leaseExpiresAt: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning({ id: dispatches.id });
	return rows.length > 0;
}

/** Settle a leased/running dispatch as terminally `failed`. */
export async function failDispatch(id: string, error: string): Promise<boolean> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'failed',
			lastError: error,
			waitReason: null,
			leaseOwner: null,
			leaseExpiresAt: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning({ id: dispatches.id });
	return rows.length > 0;
}

/**
 * Cancel a waiting (`pending`/`retry-scheduled`) dispatch — the canonical
 * "never run this" operation behind terminate/put-back/queue-clear. Returns the
 * cancelled row (for best-effort wake-up removal), or `null` when the dispatch
 * was not in a cancellable state (already claimed, or already terminal).
 */
export async function cancelWaitingDispatch(
	id: string,
	reason: string,
): Promise<DispatchRow | null> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'cancelled',
			lastError: reason,
			waitReason: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, [...WAITING_DISPATCH_STATES])))
		.returning();
	return rows[0] ?? null;
}

/** Settle a leased/running dispatch as `cancelled` (user terminated the run). */
export async function cancelClaimedDispatch(id: string, reason: string): Promise<boolean> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'cancelled',
			lastError: reason,
			waitReason: null,
			leaseOwner: null,
			leaseExpiresAt: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning({ id: dispatches.id });
	return rows.length > 0;
}

export interface ScheduleDispatchRetryInput {
	jobPayload: SwarmJob;
	availableAt: Date;
	waitReason: DispatchWaitReason;
	attempt: number;
	runId?: string;
	/**
	 * The human-readable reason this attempt deferred (issue #567). `waitReason` is
	 * a category; this is the sentence an operator can act on — which for the
	 * unbounded `preserved-worker` wait is the only place outside the run-detail
	 * page that names the machine being waited for, since a gate refusal settles
	 * before any run row exists to write an `error` onto.
	 */
	lastError?: string;
}

/**
 * Defer a claimed dispatch to a scheduled retry: `leased`/`running` →
 * `retry-scheduled`, persisting the *derived* next-attempt payload (session
 * resume, PM dispatch intent, attempt counter) before any queue work happens.
 * Bumps `wakeSeq` so the retry's wake-up job id is fresh. Returns the updated
 * row (the publisher needs id + wakeSeq + availableAt), or `null` when the
 * dispatch was not claimed (e.g. a user cancellation settled it first).
 */
export async function scheduleDispatchRetry(
	id: string,
	input: ScheduleDispatchRetryInput,
): Promise<DispatchRow | null> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'retry-scheduled',
			jobPayload: input.jobPayload,
			availableAt: input.availableAt,
			waitReason: input.waitReason,
			attempt: input.attempt,
			lastError: input.lastError,
			wakeSeq: sql`${dispatches.wakeSeq} + 1`,
			leaseOwner: null,
			leaseExpiresAt: null,
			selectedWorkerId: null,
			workerSessionId: null,
			workerFencingToken: null,
			...(input.runId !== undefined ? { runId: input.runId } : {}),
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning();
	return rows[0] ?? null;
}

export interface DeferDispatchToPendingInput {
	jobPayload: SwarmJob;
	waitReason: DispatchWaitReason;
	continuation?: boolean;
	runId?: string;
}

/**
 * Return a claimed dispatch to `pending` — the project-capacity wait: eligible
 * immediately, woken by a freed slot (or the reconciler), not by a timer.
 */
export async function deferDispatchToPending(
	id: string,
	input: DeferDispatchToPendingInput,
): Promise<DispatchRow | null> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'pending',
			jobPayload: input.jobPayload,
			availableAt: now,
			waitReason: input.waitReason,
			wakeSeq: sql`${dispatches.wakeSeq} + 1`,
			leaseOwner: null,
			leaseExpiresAt: null,
			selectedWorkerId: null,
			workerSessionId: null,
			workerFencingToken: null,
			...(input.continuation !== undefined ? { continuation: input.continuation } : {}),
			...(input.runId !== undefined ? { runId: input.runId } : {}),
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, ['leased', 'running'])))
		.returning();
	return rows[0] ?? null;
}

/**
 * Re-open a waiting dispatch for an immediate manual retry: reset the attempt
 * budget, apply the operator's overrides (already folded into `jobPayload`),
 * and make it eligible now. Conditional on the dispatch still waiting, so a
 * double-click or a race with the automatic pickup resolves to one retry.
 */
export async function reopenDispatchForManualRetry(
	id: string,
	jobPayload: SwarmJob,
): Promise<DispatchRow | null> {
	const now = new Date();
	const rows = await getDb()
		.update(dispatches)
		.set({
			state: 'pending',
			jobPayload,
			availableAt: now,
			waitReason: 'manual-retry',
			attempt: 0,
			wakeSeq: sql`${dispatches.wakeSeq} + 1`,
			updatedAt: now,
		})
		.where(and(eq(dispatches.id, id), inArray(dispatches.state, [...WAITING_DISPATCH_STATES])))
		.returning();
	return rows[0] ?? null;
}

/** Resolve one dispatch by id. */
export async function getDispatchById(id: string): Promise<DispatchRow | undefined> {
	const rows = await getDb().select().from(dispatches).where(eq(dispatches.id, id)).limit(1);
	return rows[0];
}

/** The single active (non-terminal) dispatch for a run row, when one exists. */
export async function getActiveDispatchByRunId(runId: string): Promise<DispatchRow | undefined> {
	const rows = await getDb()
		.select()
		.from(dispatches)
		.where(and(eq(dispatches.runId, runId), inArray(dispatches.state, [...ACTIVE_DISPATCH_STATES])))
		.limit(1);
	return rows[0];
}

/**
 * Whether some *other* attempt is mid-execution against this task's checkout —
 * the dispatch-side worktree-lease liveness signal (issue #427). Counts only
 * {@link EXECUTING_DISPATCH_STATES}, and skips the asking attempt's own run
 * (which is already `running` by the time it provisions).
 *
 * A row whose `runId` is `null` always counts as live: a dispatch executing
 * without a run row is degraded, not idle, and still owns the checkout. That leg
 * is explicit because SQL `NULL <> 'x'` is unknown, not true, so `ne` alone would
 * silently drop it.
 *
 * One blind spot, by construction: `dispatches.taskId` is null until the trigger
 * registry resolves it (`src/db/schema/dispatches.ts`), so a just-claimed
 * `leased` dispatch is invisible here. It is harmless — such an attempt has not
 * provisioned yet and therefore holds no lease, so whichever of the two wins the
 * take-over blocks the other at its own gate — but do not read this leg as
 * "no executing attempt exists for this task".
 */
export async function hasExecutingDispatchForTask(
	projectId: string,
	taskId: string,
	excludeRunId?: string,
): Promise<boolean> {
	const conditions: (SQL | undefined)[] = [
		eq(dispatches.projectId, projectId),
		eq(dispatches.taskId, taskId),
		inArray(dispatches.state, [...EXECUTING_DISPATCH_STATES]),
	];
	if (excludeRunId) {
		conditions.push(or(isNull(dispatches.runId), ne(dispatches.runId, excludeRunId)));
	}
	const rows = await getDb()
		.select({ id: dispatches.id })
		.from(dispatches)
		.where(and(...conditions))
		.limit(1);
	return rows.length > 0;
}

/**
 * The attempt currently executing against this task's checkout, and **which
 * phase** it is running — the worker-independent half of the in-flight collision
 * guard (issue #759). `inFlightPhaseByTask` (`src/worker/consumer.ts`) answers the
 * same question for one process only, which is why the guard's verdict used to
 * depend on which worker a dispatch happened to be routed to.
 *
 * Three legs carry the meaning:
 *
 * - Only {@link EXECUTING_DISPATCH_STATES}, for the same reason
 *   {@link hasExecutingDispatchForTask} counts only those: a `pending` or
 *   `retry-scheduled` attempt holds no checkout, and treating a queued one as an
 *   owner would make the wait it feeds unwakeable.
 * - `excludeDispatchId` skips **the asking dispatch**, which is already `leased`
 *   with its own `taskId`/`phase` recorded (`recordDispatchResolution`) by the time
 *   the guard runs and would otherwise find itself.
 * - `merge-automation` never counts: that dispatch kind carries a `taskId` but
 *   provisions no worktree and takes no slot (issue #292), so an approving Review's
 *   merge dispatch must not hold up the task's next phase. Written as `IS DISTINCT
 *   FROM` because SQL `NULL <> 'x'` is unknown, not true — `ne` alone would drop
 *   the null-`phase` rows this read exists to report.
 *
 * A row whose `phase` is null (the best-effort resolution write failed) is
 * returned with `phase: null`, which the caller must treat as *some other* phase:
 * only a known phase match may justify discarding work.
 *
 * One indexed row at most, on `(project_id, state)` — the same read cost the
 * lease-liveness gate above already pays on the dispatch path.
 */
export async function findExecutingDispatchForTask(
	projectId: string,
	taskId: string,
	excludeDispatchId?: string,
): Promise<{ id: string; phase: string | null } | undefined> {
	const rows = await getDb()
		.select({ id: dispatches.id, phase: dispatches.phase })
		.from(dispatches)
		.where(
			and(
				eq(dispatches.projectId, projectId),
				eq(dispatches.taskId, taskId),
				inArray(dispatches.state, [...EXECUTING_DISPATCH_STATES]),
				sql`${dispatches.phase} IS DISTINCT FROM 'merge-automation'`,
				...(excludeDispatchId ? [ne(dispatches.id, excludeDispatchId)] : []),
			),
		)
		.orderBy(asc(dispatches.createdAt))
		.limit(1);
	return rows[0];
}

/**
 * Select the phase that may take a shared task checkout when several dispatches
 * have reached the in-flight guard together (issue #759). The transaction-scoped
 * lock makes concurrent consumers agree on one answer; Planning sorts ahead of
 * Implementation because the two deliberately share a checkout and branch.
 *
 * The caller has already recorded its own task/phase before this read. Other
 * phases do not share a task id by design, so their stable creation order keeps
 * the duplicate guard deterministic without imposing an invented pipeline order.
 */
export async function selectTaskPhaseForExecution(
	projectId: string,
	taskId: string,
	pmItemId?: string,
): Promise<{ id: string; phase: string | null } | undefined> {
	return getDb().transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`${projectId}:${taskId}`}, 0))`,
		);
		// A Planning delivery can still be resolving its task id while a later
		// Implementation delivery for the same board item reaches this guard. Keep
		// that earlier leased row ahead of Implementation rather than letting the
		// latter claim the checkout during the resolution window.
		const unresolvedPmItem = pmItemId
			? and(
					eq(dispatches.projectId, projectId),
					isNull(dispatches.taskId),
					inArray(dispatches.state, [...EXECUTING_DISPATCH_STATES]),
					sql`${dispatches.jobPayload} ->> 'type' = 'pm'`,
					sql`${dispatches.jobPayload} -> 'event' ->> 'itemId' = ${pmItemId}`,
				)
			: undefined;
		const rows = await tx
			.select({ id: dispatches.id, phase: dispatches.phase })
			.from(dispatches)
			.where(
				or(
					and(
						eq(dispatches.projectId, projectId),
						eq(dispatches.taskId, taskId),
						inArray(dispatches.state, [...EXECUTING_DISPATCH_STATES]),
						sql`${dispatches.phase} IS DISTINCT FROM 'merge-automation'`,
					),
					unresolvedPmItem,
				),
			)
			.orderBy(
				sql`CASE WHEN ${dispatches.phase} IS NULL THEN 0 WHEN ${dispatches.phase} = 'planning' THEN 1 WHEN ${dispatches.phase} = 'implementation' THEN 2 ELSE 3 END`,
				asc(dispatches.createdAt),
			)
			.limit(1);
		return rows[0];
	});
}

/**
 * The dispatches waiting for this task's checkout to free (issue #759) — what a
 * settling phase wakes, the task-level twin of {@link selectNextCapacityDispatch}.
 *
 * Returns every waiter rather than only the first: realistically a task has at
 * most one (the next phase in its sequence), and a second would otherwise sit
 * until the reconciler's next pass. Whichever loses the resulting race re-defers
 * under the same reason. Ordered on `availableAt` so the answer is deterministic.
 */
export async function listTaskInFlightWaits(
	projectId: string,
	taskId: string,
): Promise<DispatchRow[]> {
	return getDb()
		.select()
		.from(dispatches)
		.where(
			and(
				eq(dispatches.projectId, projectId),
				eq(dispatches.taskId, taskId),
				eq(dispatches.state, 'pending'),
				eq(dispatches.waitReason, 'task-in-flight'),
			),
		)
		.orderBy(asc(dispatches.availableAt), asc(dispatches.createdAt));
}

/**
 * Every waiting dispatch (`pending`/`retry-scheduled`) — the canonical queue
 * read model (issue #284). Ordered to mirror dispatch intent: eligible-now
 * before scheduled-later, then priority (0 highest), then FIFO on availability.
 */
export async function listWaitingDispatches(projectId?: string): Promise<DispatchRow[]> {
	const where = projectId
		? and(
				eq(dispatches.projectId, projectId),
				inArray(dispatches.state, [...WAITING_DISPATCH_STATES]),
			)
		: inArray(dispatches.state, [...WAITING_DISPATCH_STATES]);
	return getDb()
		.select()
		.from(dispatches)
		.where(where)
		.orderBy(asc(dispatches.priority), asc(dispatches.availableAt), asc(dispatches.createdAt));
}

/**
 * How many runnable dispatches the pool scheduler looks at (issue #533). The read
 * is ordered by the same dispatch intent as {@link listWaitingDispatches}, so a
 * backlog deeper than this drops only its lowest-ranked tail — work that would lose
 * every slot to the rows above it anyway. Bounded because this runs on the dispatch
 * path: a project sitting on hundreds of pending dispatches must not turn each
 * selection into a hundred-way match.
 */
export const POOL_DEMAND_LIMIT = 50;

/**
 * The project's runnable dispatches that still need a worker — the demand side of
 * pool-aware scheduling (issue #533). A dispatch qualifies when it is non-terminal,
 * has not already claimed a worker (`selectedWorkerId` — one that has consumed that
 * worker's capacity, which the availability snapshot already reflects), and is due
 * now rather than scheduled into the future.
 *
 * `leased` rows are deliberately included: with the consumer processing several
 * dispatches at once, the contender that most needs a scarce worker is often one
 * being gated at this very moment, and both sides matching over the same snapshot is
 * what lets them agree without a shared lock.
 */
export async function listRunnableDispatchesForPool(
	projectId: string,
	asOf: Date = new Date(),
): Promise<DispatchRow[]> {
	return getDb()
		.select()
		.from(dispatches)
		.where(
			and(
				eq(dispatches.projectId, projectId),
				inArray(dispatches.state, ['pending', 'retry-scheduled', 'leased']),
				isNull(dispatches.selectedWorkerId),
				lte(dispatches.availableAt, asOf),
			),
		)
		.orderBy(asc(dispatches.priority), asc(dispatches.availableAt), asc(dispatches.createdAt))
		.limit(POOL_DEMAND_LIMIT);
}

/**
 * The next capacity-blocked dispatch a freed project slot should wake. With
 * continuation priority on, the oldest SCM continuation wins; otherwise strict
 * FIFO on when the dispatch became pending.
 */
export async function selectNextCapacityDispatch(
	projectId: string,
	prioritizeContinuations: boolean,
): Promise<DispatchRow | undefined> {
	const base = and(
		eq(dispatches.projectId, projectId),
		eq(dispatches.state, 'pending'),
		eq(dispatches.waitReason, 'project-capacity'),
	);
	const rows = await getDb()
		.select()
		.from(dispatches)
		.where(base)
		.orderBy(
			...(prioritizeContinuations
				? [desc(dispatches.continuation), asc(dispatches.availableAt)]
				: [asc(dispatches.availableAt)]),
		)
		.limit(1);
	return rows[0];
}

/**
 * The wait reasons an *availability* wake-up may promote (issue #610) — the two
 * the dispatch gate records when nothing structural is wrong and a machine
 * merely has to become available (issue #607 is what made them distinguishable
 * on the row).
 *
 * `worker-authorization` is deliberately absent: a worker connecting or freeing
 * capacity cannot grant sharing consent, approve an enrollment, permit a phase,
 * or teach a machine a CLI, so promoting such a row would only spend its budget
 * faster while changing nothing. It keeps the timed cadence.
 */
export const PROMOTABLE_AVAILABILITY_WAIT_REASONS = [
	'worker-eligibility',
	'preserved-worker',
] as const satisfies readonly DispatchWaitReason[];

/**
 * Availability-blocked dispatches that this worker becoming available could
 * start (issue #610) — the candidate set for an early wake-up, keyed on the two
 * different things the two waits are actually waiting for:
 *
 * - `worker-eligibility` — any dispatch in a project this worker is **routable**
 *   enrolled in (`isRoutable`: an active enrollment with its owner's sharing
 *   consent). Deliberately no narrower: the row records a category, not the
 *   roster walk behind it, and re-deriving affinity or target capability here
 *   would mean a board read per waiting dispatch. A wake-up it did not need
 *   costs one token-free re-evaluation, which is what the gate does anyway.
 * - `preserved-worker` — keyed on the **recorded machine**
 *   (`runs.recovery.preservedWorkerId`), never on project enrollment: the gate
 *   honours a pin to a machine that is no longer an enrolled candidate at all
 *   (issue #567), so enrollment is the wrong question for this wait.
 *
 * Only rows whose wake-up is still *delayed* (`availableAt` in the future) are
 * candidates — a dispatch already due needs no promotion, and its wake-up may
 * be mid-flight, which is what makes {@link promoteDispatchToImmediateWake}'s
 * remove-then-re-date sequence safe for the caller.
 */
export async function listAvailabilityWaitsForWorker(
	workerId: string,
	asOf: Date = new Date(),
): Promise<DispatchRow[]> {
	const db = getDb();
	const routableProjects = db
		.select({ projectId: workerProjectEnrollments.projectId })
		.from(workerProjectEnrollments)
		.where(
			and(
				eq(workerProjectEnrollments.workerId, workerId),
				eq(workerProjectEnrollments.status, 'active'),
				eq(workerProjectEnrollments.sharingConsent, true),
			),
		);
	const pinnedRuns = db
		.select({ id: runs.id })
		.from(runs)
		.where(sql`${runs.recovery} ->> 'preservedWorkerId' = ${workerId}`);
	return db
		.select()
		.from(dispatches)
		.where(
			and(
				eq(dispatches.state, 'retry-scheduled'),
				gt(dispatches.availableAt, asOf),
				or(
					and(
						eq(dispatches.waitReason, 'worker-eligibility'),
						inArray(dispatches.projectId, routableProjects),
					),
					and(eq(dispatches.waitReason, 'preserved-worker'), inArray(dispatches.runId, pinnedRuns)),
				),
			),
		)
		.orderBy(asc(dispatches.priority), asc(dispatches.availableAt), asc(dispatches.createdAt));
}

/**
 * Re-date one availability-blocked dispatch to be eligible **now** and bump its
 * wake sequence, so the caller can publish a fresh wake-up in place of the
 * delayed one it just removed (issue #610).
 *
 * Conditional on the row still sitting on `wakeSeq` — which is what makes
 * concurrent wake-ups from two workers resolve to at most one promotion per
 * dispatch, and what stops a row that was claimed, cancelled, or re-deferred in
 * the meantime from being dragged back. The `availableAt > asOf` leg makes a
 * repeat call a no-op rather than a second promotion. Returns the updated row,
 * or `null` when the dispatch moved on.
 *
 * It does **not** touch the attempt counter or the stored payload: the woken job
 * re-enters `processJob` exactly as the timer would have, spending the budget the
 * previous settle persisted rather than a fresh one, and may defer again.
 */
export async function promoteDispatchToImmediateWake(
	id: string,
	wakeSeq: number,
	asOf: Date = new Date(),
): Promise<DispatchRow | null> {
	const rows = await getDb()
		.update(dispatches)
		.set({
			availableAt: asOf,
			wakeSeq: sql`${dispatches.wakeSeq} + 1`,
			updatedAt: asOf,
		})
		.where(
			and(
				eq(dispatches.id, id),
				eq(dispatches.state, 'retry-scheduled'),
				eq(dispatches.wakeSeq, wakeSeq),
				gt(dispatches.availableAt, asOf),
				inArray(dispatches.waitReason, [...PROMOTABLE_AVAILABILITY_WAIT_REASONS]),
			),
		)
		.returning();
	return rows[0] ?? null;
}

/**
 * Supersede prior waiting dispatches carrying this coalesce key — the
 * cancel-and-replace half of a bounded recheck. Returns the superseded rows so
 * the caller can best-effort remove their wake-up jobs.
 */
export async function supersedeDispatchesByCoalesceKey(
	coalesceKey: string,
	excludeId?: string,
): Promise<DispatchRow[]> {
	const now = new Date();
	return getDb()
		.update(dispatches)
		.set({
			state: 'completed',
			outcome: 'superseded',
			waitReason: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(dispatches.coalesceKey, coalesceKey),
				inArray(dispatches.state, [...WAITING_DISPATCH_STATES]),
				...(excludeId ? [ne(dispatches.id, excludeId)] : []),
			),
		)
		.returning();
}

/**
 * Fail every leased/running dispatch whose lease expired before `asOf` — the
 * reconciler's dead-worker reclaim. The cutoff is required so no caller can
 * accidentally reap another worker host's still-live lease.
 */
export async function failExpiredDispatchLeases(
	reason: string,
	asOf: Date,
): Promise<DispatchRow[]> {
	const now = new Date();
	return getDb()
		.update(dispatches)
		.set({
			state: 'failed',
			lastError: reason,
			leaseOwner: null,
			leaseExpiresAt: null,
			waitReason: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(inArray(dispatches.state, ['leased', 'running']), lte(dispatches.leaseExpiresAt, asOf)),
		)
		.returning();
}

/**
 * Fail this worker's claims from an older fenced session. A newly acquired
 * session proves every different token for the same worker is stale even when
 * its dispatch lease has not reached its longer agent-timeout expiry yet.
 */
export async function failSupersededWorkerDispatchClaims(
	workerId: string,
	activeFencingToken: number,
	reason: string,
): Promise<DispatchRow[]> {
	const now = new Date();
	return getDb()
		.update(dispatches)
		.set({
			state: 'failed',
			lastError: reason,
			leaseOwner: null,
			leaseExpiresAt: null,
			waitReason: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(dispatches.selectedWorkerId, workerId),
				inArray(dispatches.state, ['leased', 'running']),
				sql`${dispatches.workerFencingToken} IS DISTINCT FROM ${activeFencingToken}`,
			),
		)
		.returning();
}

/**
 * Cancel every waiting dispatch (optionally project-scoped) — the canonical
 * "clear the queue" operation. Returns the cancelled rows for wake-up cleanup.
 */
export async function cancelAllWaitingDispatches(
	reason: string,
	projectId?: string,
): Promise<DispatchRow[]> {
	const now = new Date();
	const stateCond = inArray(dispatches.state, [...WAITING_DISPATCH_STATES]);
	return getDb()
		.update(dispatches)
		.set({
			state: 'cancelled',
			lastError: reason,
			waitReason: null,
			completedAt: now,
			updatedAt: now,
		})
		.where(projectId ? and(eq(dispatches.projectId, projectId), stateCond) : stateCond)
		.returning();
}

/**
 * Waiting dispatches that need a wake-up (re-)published: every
 * `retry-scheduled` row plus `pending` rows not waiting on project capacity
 * (those are woken by slot releases, not timers). Publishing is idempotent
 * (deterministic wake ids), so returning rows whose wake-up still exists is
 * fine — the re-add is a queue no-op.
 */
export async function listWakeablePendingDispatches(): Promise<DispatchRow[]> {
	return getDb()
		.select()
		.from(dispatches)
		.where(
			sql`(${dispatches.state} = 'retry-scheduled') OR (${dispatches.state} = 'pending' AND (${dispatches.waitReason} IS NULL OR ${dispatches.waitReason} <> 'project-capacity'))`,
		);
}

/** Project ids that currently hold capacity-blocked pending dispatches. */
export async function listProjectsWithCapacityPending(): Promise<string[]> {
	const rows = await getDb()
		.selectDistinct({ projectId: dispatches.projectId })
		.from(dispatches)
		.where(and(eq(dispatches.state, 'pending'), eq(dispatches.waitReason, 'project-capacity')));
	return rows.map((r) => r.projectId);
}

/**
 * Retry-pending runs (`deferred`, or `checkpointed` — issue #503) with no active
 * dispatch — legacy orphans whose retry intent survives only on the run row
 * (`job_payload`, `next_retry_at`). The startup backfill turns each into a
 * `retry-scheduled` dispatch (issue #284's #269/#279 repair).
 */
export async function listDeferredRunsWithoutActiveDispatch(): Promise<
	Array<typeof runs.$inferSelect>
> {
	const active = getDb()
		.select({ runId: dispatches.runId })
		.from(dispatches)
		.where(
			and(
				inArray(dispatches.state, [...ACTIVE_DISPATCH_STATES]),
				sql`${dispatches.runId} IS NOT NULL`,
			),
		);
	return getDb()
		.select()
		.from(runs)
		.where(and(inArray(runs.status, [...RETRY_PENDING_RUN_STATUSES]), notInArray(runs.id, active)));
}

/** Whether any dispatch rows exist at all — used to gate one-time backfills. */
export async function countDispatches(): Promise<number> {
	const rows = await getDb().select({ n: sql<number>`count(*)::int` }).from(dispatches);
	return rows[0]?.n ?? 0;
}
