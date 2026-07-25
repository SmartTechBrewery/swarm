/**
 * Agent-run history persistence — mirrors the plain-function shape of
 * `projectsRepository.ts` (one `getDb()` per call, no class), trimmed to
 * SWARM's single-user scope (ai/ARCHITECTURE.md "Single-user scope"). This is
 * layer 1 of the "agent-run history" feature (issue #102): the worker records
 * one `runs` row per agent-CLI invocation and, on failure, one `run_logs` row
 * with the captured stdout/stderr. The tRPC API and dashboard UI that read
 * these are follow-up issues.
 *
 * A `runs` row is a flat record of a single pipeline-phase run — there is no
 * join against a work-item cache (SWARM has none; the UI links out via
 * `taskId` + `phase`). Writes here are best-effort from the worker's point of
 * view: a DB hiccup must never fail an actual pipeline run (`consumer.ts`).
 */

import { randomUUID } from 'node:crypto';
import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	ne,
	notExists,
	or,
	type SQL,
	sql,
} from 'drizzle-orm';
import type { AgentCli } from '../../harness/agent-cli.js';
import type { AgentUsage } from '../../harness/usage.js';
import type { ProposedScope } from '../../pipeline/planning.js';
import type { ReviewAutomationOutcome, ReviewVerdict } from '../../pipeline/review.js';
import type { CancellationOrigin } from '../../queue/cancellation.js';
import type { SwarmJob } from '../../queue/jobs.js';
import type { TriggerPhase } from '../../triggers/types.js';
import { diagnoseFailure, type FailureDiagnosis } from '../../worker/failure-diagnosis.js';
import { getDb } from '../client.js';
import { dispatches } from '../schema/dispatches.js';
import { runLogs, runOutputEvents, runs } from '../schema/runs.js';

export const MAX_RUN_OUTPUT_BYTES = 5_000_000;
export const RUN_OUTPUT_PAGE_SIZE = 200;

export interface RunOutputEventInput {
	stream: 'stdout' | 'stderr';
	content: string;
	emittedAt: Date;
}

export type RunRow = typeof runs.$inferSelect;

/** A run's terminal state — everything but the initial `running`. */
type RunStatus = 'running' | 'completed' | 'failed' | 'deferred';

export interface CreateRunInput {
	projectId: string;
	taskId: string;
	phase: TriggerPhase;
	workerId?: string;
	/**
	 * The SWARM user who owns `workerId` (`DispatchSelection.ownerUserId`) —
	 * persisted alongside the worker as the attribution record's user half
	 * (ADR-004 §4, issue #398). Omitted for an unfederated run, which resolves no
	 * worker at all.
	 */
	workerUserId?: string;
	workerFencingToken?: number;
	workItemId?: string;
	workItemTitle?: string;
	workItemUrl?: string;
	prNumber?: string;
	prTitle?: string;
	/**
	 * The effective CLI this run will launch (project phase config plus any job
	 * override, coded default otherwise), persisted at creation so the dashboard
	 * shows it while the run is still `running` (issue #169). Finalization
	 * confirms/updates it from what actually ran.
	 */
	engine?: AgentCli;
	model?: string;
	/** Explicitly requested reasoning level; null/undefined = CLI default (issue #180). */
	reasoning?: string;
	timeoutMs?: number;
	jobPayload?: SwarmJob;
}

/** Insert a `running` row (the default status); returns the new row's id. */
export async function createRun(input: CreateRunInput): Promise<string> {
	const id = randomUUID();
	const rows = await getDb()
		.insert(runs)
		.values({
			id,
			projectId: input.projectId,
			taskId: input.taskId,
			phase: input.phase,
			workerId: input.workerId,
			workerUserId: input.workerUserId,
			workerFencingToken: input.workerFencingToken,
			workItemId: input.workItemId,
			workItemTitle: input.workItemTitle,
			workItemUrl: input.workItemUrl,
			prNumber: input.prNumber,
			prTitle: input.prTitle,
			engine: input.engine,
			model: input.model,
			reasoning: input.reasoning,
			timeoutMs: input.timeoutMs,
			jobPayload: input.jobPayload,
			agentSessionId: id,
		})
		.returning({ id: runs.id });
	return rows[0].id;
}

/**
 * Whether retention must pin this task's checkout for a resumable deferred run —
 * any phase, any engine (cross-CLI resume). A deferred row that still holds an
 * `agentSessionId` is one the worker intends to resume; pruning its worktree
 * would strip the partial work the resume relies on.
 */
export async function hasResumableDeferredRun(projectId: string, taskId: string): Promise<boolean> {
	const rows = await getDb()
		.select({ id: runs.id })
		.from(runs)
		.where(
			and(
				eq(runs.projectId, projectId),
				eq(runs.taskId, taskId),
				inArray(runs.status, ['deferred', 'failed']),
				isNotNull(runs.agentSessionId),
			),
		)
		.limit(1);
	return rows.length > 0;
}

export interface CompleteRunInput {
	status: 'completed' | 'failed' | 'deferred';
	engine?: AgentCli;
	exitCode?: number | null;
	timedOut?: boolean;
	error?: string;
	durationMs?: number;
	nextRetryAt?: Date | null;
	usage?: AgentUsage;
	agentSessionId?: string | null;
	recovery?: typeof runs.$inferSelect.recovery | null;
	/**
	 * The verdict a completed Review run submitted (issue #218). Set only by the
	 * Review phase's success path; omitted (left as-is) for every other phase, so
	 * a non-review finalize never touches the column.
	 */
	reviewVerdict?: ReviewVerdict;
	/**
	 * This Review run's review-verdict safety-cap slot (1…`REVIEW_VERDICT_CAP`,
	 * issue #235). Set
	 * only alongside `reviewVerdict`; omitted for every other phase.
	 */
	reviewOrdinal?: number;
	/**
	 * This Review run's automation outcome (issue #235), e.g.
	 * `manual-intervention-required` when it submitted the last
	 * `request-changes` verdict the cap allows. Set only alongside
	 * `reviewVerdict`; omitted for every other phase.
	 */
	reviewAutomationOutcome?: ReviewAutomationOutcome;
	/**
	 * The PR this run *produced*, as reported in its phase result — the PR half of
	 * the worker→PR attribution record (ADR-004 §4, issue #398). Set only by a
	 * PR-producing phase (Implementation); omitted (left as-is) for every other
	 * phase, so a non-implementation finalize never touches the column.
	 */
	producedPrUrl?: string;
	/**
	 * This run's recorded cancellation origin (issue #308) — set only on a
	 * `failed` run whose cancellation was requested through the supported
	 * dashboard/API `terminate` action. Pass explicit `null` for a cancelled run
	 * whose marker carried no origin (marker-only/external); omit entirely for
	 * every non-cancellation finalize, which leaves the column untouched.
	 */
	cancellation?: CancellationOrigin | null;
	/** Structured Planning scope persisted only after a successful normal Planning run. */
	planningScope?: ProposedScope;
	/** Evidence-based explanation for a terminal failure; raw `error` remains untouched. */
	failureDiagnosis?: FailureDiagnosis;
}

/**
 * Finalize a run: set its terminal `status`, `completedAt`, and whichever of the
 * outcome columns the caller passed. Omitted fields are simply left as-is:
 * `exitCode` stays null for a run that never produced a result, and an omitted
 * `engine` preserves the effective CLI recorded at creation/reset (issue #169)
 * rather than blanking it — e.g. a deferral before the agent ran keeps showing
 * the run's engine while it is retry-pending.
 */
export async function completeRun(runId: string, input: CompleteRunInput): Promise<void> {
	await getDb()
		.update(runs)
		.set({
			status: input.status,
			engine: input.engine,
			exitCode: input.exitCode,
			timedOut: input.timedOut,
			error: input.error,
			durationMs: input.durationMs,
			nextRetryAt: input.nextRetryAt,
			usage: input.usage,
			agentSessionId: input.agentSessionId,
			reviewVerdict: input.reviewVerdict,
			reviewOrdinal: input.reviewOrdinal,
			reviewAutomationOutcome: input.reviewAutomationOutcome,
			producedPrUrl: input.producedPrUrl,
			recovery: input.recovery,
			cancellation: input.cancellation,
			planningScope: input.planningScope,
			failureDiagnosis: input.failureDiagnosis,
			completedAt: new Date(),
		})
		.where(eq(runs.id, runId));
}

/**
 * Reset an existing run row back to `running` for a retry (issue #136), so a
 * re-run reuses its original row rather than inserting a second one — the
 * dashboard then shows one run whose status flips, not two. Clears the terminal
 * columns a prior settle wrote (`completedAt`/`error`/`nextRetryAt`) and the
 * outcome columns (`engine`/`exitCode`/`timedOut`/`durationMs`/`usage`) so the
 * fresh attempt records its own; `model`/`reasoning` can be updated if a new one
 * is selected (pass `reasoning: null` to clear a now-incompatible level after a
 * CLI/model change; both left as-is when the arg is `undefined`). `engine` is the
 * effective CLI to record for this attempt (issue #169): a passed value is stored
 * so the row shows its engine while `running`, and an omitted one clears the
 * column (the worker repopulates it on pickup, or finalization records what ran).
 * Returns `true` when a row was updated, `false` when no row matched (it was
 * pruned, or no longer has `fromStatus` when that atomic guard is supplied) — the
 * caller then falls back to `createRun`. Best-effort like the rest of run
 * tracking: the worker swallows/logs any throw.
 *
 * `startedAt` is bumped to now so the row's age reflects *this* attempt, not the
 * original one: the dashboard's live duration measures the current run, and the
 * stale-row reconciliation ({@link failStaleRunningRuns}) — which fails a
 * `running` row once it outlives any plausible timeout — measures each attempt
 * from its own start rather than wrongly reaping a just-retried row for the
 * elapsed time of a hours-old first attempt (issue #165).
 */
export async function resetRunToRunning(
	runId: string,
	jobPayload?: SwarmJob,
	fromStatus?: RunStatus,
	model?: string,
	timeoutMs?: number,
	reasoning?: string | null,
	engine?: AgentCli,
	agentSessionId?: string | null,
	recovery?: typeof runs.$inferSelect.recovery | null,
	workerId?: string,
	workerFencingToken?: number,
	workerUserId?: string,
): Promise<boolean> {
	const rows = await getDb()
		.update(runs)
		.set({
			status: 'running',
			workerId: workerId ?? null,
			workerUserId: workerUserId ?? null,
			workerFencingToken: workerFencingToken ?? null,
			startedAt: new Date(),
			completedAt: null,
			error: null,
			nextRetryAt: null,
			engine: engine ?? null,
			exitCode: null,
			timedOut: false,
			durationMs: null,
			usage: null,
			// Clear any prior verdict so a re-running Review row shows lifecycle
			// status, not a stale verdict, until it submits a fresh one (issue #218).
			reviewVerdict: null,
			// Same for the safety-cap slot/automation outcome (issue #235) — a retry
			// re-marks them once it re-submits.
			reviewOrdinal: null,
			reviewAutomationOutcome: null,
			// Same for merge-automation state (issue #278): a re-run Review that
			// approves again starts a fresh outcome generation rather than showing
			// a previous attempt's stale merge status while it re-submits.
			reviewMergeOutcome: null,
			reviewMergeMessage: null,
			reviewMergeAttempt: null,
			reviewMergeApprovedHeadSha: null,
			// `producedPrUrl` is deliberately *not* cleared (issue #398): the PR is a
			// real external artifact that outlives the attempt, so a resumed
			// Implementation retry re-reports the same URL and overwrites it, whereas
			// clearing would erase the record of a PR that exists.
			// A retried attempt hasn't (yet) been cancelled — clear a prior attempt's
			// recorded origin so a genuine failure this time never shows a stale
			// "cancelled via dashboard" origin left over from before the retry.
			cancellation: null,
			// A retry must not carry forward an explanation from its prior terminal
			// attempt. Planning scope remains as its last successful artifact until a
			// new successful Planning attempt replaces it.
			failureDiagnosis: null,
			...(jobPayload !== undefined ? { jobPayload } : {}),
			...(model !== undefined ? { model } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
			...(reasoning !== undefined ? { reasoning } : {}),
			...(agentSessionId !== undefined ? { agentSessionId } : {}),
			...(recovery !== undefined ? { recovery } : {}),
		})
		.where(fromStatus ? and(eq(runs.id, runId), eq(runs.status, fromStatus)) : eq(runs.id, runId))
		.returning({ id: runs.id });
	return rows.length > 0;
}

/** Persist a newer retry checkpoint without changing the run's lifecycle state. */
export async function updateRunJobPayload(runId: string, jobPayload: SwarmJob): Promise<void> {
	await getDb().update(runs).set({ jobPayload }).where(eq(runs.id, runId));
}

/**
 * Atomically finalize a run as user-terminated (issue #166): flip it to `failed`
 * with the explicit user-termination `reason`, stamp `completedAt`, and clear the
 * retry-shaped columns (`nextRetryAt`, `agentSessionId`) so it can't be picked up
 * or resumed. Preserves the run's other columns (logs live in `run_logs`, which
 * this never touches) so the terminated run keeps whatever it produced.
 *
 * The optional `fromStatus` makes the write a conditional claim: pass `'deferred'`
 * and the update only lands while the row is still deferred — losing the race to
 * a concurrent worker pickup (which flipped it to `running`) returns `false`
 * rather than clobbering an in-flight run, so the caller can fall back to the
 * notify-the-worker path. Returns whether a row was updated.
 */
export async function markRunUserTerminated(
	runId: string,
	reason: string,
	fromStatus?: RunStatus,
): Promise<boolean> {
	return failRunFromStatus(
		runId,
		reason,
		fromStatus,
		diagnoseFailure({ knownCondition: 'user-terminated' }),
	);
}

/**
 * Atomically fail a run with `reason`, clearing the retry-shaped columns
 * (`nextRetryAt`, `agentSessionId`) so it can't be picked up or resumed. The
 * generic primitive behind {@link markRunUserTerminated} and the dispatch
 * reconciler's dead-lease repair (issue #284). `fromStatus` makes the write a
 * conditional claim; returns whether a row was updated.
 */
export async function failRunFromStatus(
	runId: string,
	reason: string,
	fromStatus?: RunStatus,
	failureDiagnosis?: FailureDiagnosis,
): Promise<boolean> {
	const rows = await getDb()
		.update(runs)
		.set({
			status: 'failed',
			error: reason,
			nextRetryAt: null,
			agentSessionId: null,
			failureDiagnosis,
			completedAt: new Date(),
		})
		.where(fromStatus ? and(eq(runs.id, runId), eq(runs.status, fromStatus)) : eq(runs.id, runId))
		.returning({ id: runs.id });
	return rows.length > 0;
}

/**
 * Atomic transaction to cancel a deferred run and its active dispatch consistently,
 * preserving session info and payload for future recovery retry. `cancellation`
 * (issue #308) is persisted on the row alongside the neutral `reason` — the
 * `terminate` mutation's already-recorded origin, so the row and the durable
 * Redis origin agree without a second read.
 */
export async function cancelDeferredRunInDb(
	runId: string,
	reason: string,
	cancellation: CancellationOrigin,
): Promise<{
	success: boolean;
	dispatch: { id: string; wakeSeq: number } | null;
	/**
	 * The session id this cancellation preserved as resumable recovery, or `null`
	 * when the deferred run had none. The terminate mutation uses it to reconcile
	 * the checkout: a preserved session keeps it, no session lets a clean checkout
	 * be removed.
	 */
	preservedSession: string | null;
}> {
	const db = getDb();
	return await db.transaction(async (tx) => {
		const runRows = await tx
			.select({
				status: runs.status,
				agentSessionId: runs.agentSessionId,
				jobPayload: runs.jobPayload,
			})
			.from(runs)
			.where(eq(runs.id, runId))
			.limit(1);
		const run = runRows[0];
		if (!run || run.status !== 'deferred') {
			return { success: false, dispatch: null, preservedSession: null };
		}

		const dispatchRows = await tx
			.select({ id: dispatches.id, state: dispatches.state, wakeSeq: dispatches.wakeSeq })
			.from(dispatches)
			.where(
				and(
					eq(dispatches.runId, runId),
					inArray(dispatches.state, ['pending', 'leased', 'running', 'retry-scheduled']),
				),
			)
			.limit(1);
		const dispatch = dispatchRows[0];

		if (dispatch) {
			await tx
				.update(dispatches)
				.set({
					state: 'cancelled',
					lastError: reason,
					waitReason: null,
					leaseOwner: null,
					leaseExpiresAt: null,
					completedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(dispatches.id, dispatch.id));
		}

		const hasSession = run.agentSessionId !== null;
		const recoveryVal = hasSession
			? {
					state: 'preserved' as const,
					agentSessionId: run.agentSessionId,
				}
			: null;

		await tx
			.update(runs)
			.set({
				status: 'failed',
				error: reason,
				nextRetryAt: null,
				agentSessionId: run.agentSessionId,
				recovery: recoveryVal,
				cancellation,
				failureDiagnosis: diagnoseFailure({ knownCondition: 'user-terminated' }),
				completedAt: new Date(),
			})
			.where(eq(runs.id, runId));

		return {
			success: true,
			dispatch: dispatch ? { id: dispatch.id, wakeSeq: dispatch.wakeSeq } : null,
			preservedSession: hasSession ? run.agentSessionId : null,
		};
	});
}

/**
 * Record that terminating a run left protected work behind that could not be
 * safely removed (`src/worktree/termination-cleanup.ts`). A narrow update of the
 * recovery record only: it never reopens or reschedules the already-cancelled
 * dispatch, so a blocked cleanup on the deferred-termination path stays a
 * terminal, non-resumable outcome. Idempotent and best-effort — a caller swallows
 * a throw the same way the rest of run tracking does.
 */
export async function recordRunCleanupBlocked(
	runId: string,
	blockedReason: 'dirty' | 'unpushed' | 'live-leased',
): Promise<void> {
	await getDb()
		.update(runs)
		.set({ recovery: { state: 'blocked', blockedReason } })
		.where(eq(runs.id, runId));
}

/**
 * Clear a run's recovery record for a "Reset & restart" (issue #424): the fresh
 * attempt starts from a clean slate, so a `blocked`/`preserved` record must not
 * keep misleading retention (`hasResumableDeferredRun`), the reclaim gate, or
 * the UI. The captured session id goes with it — a retained session must never
 * outlive the checkout it would have resumed.
 */
export async function clearRunRecovery(runId: string): Promise<void> {
	await getDb()
		.update(runs)
		.set({ recovery: null, agentSessionId: null })
		.where(eq(runs.id, runId));
}

/**
 * Whether a *different* run is still live (`running`) for this project task —
 * the "is this worktree lease genuinely owned, or stale?" question asked before
 * reclaiming a `live-leased` checkout. Two callers share it so the two paths
 * cannot drift apart: the reset action (issue #424,
 * `src/dispatch/run-reset.ts`), and the run-side half of the provision-time
 * collision gate's liveness signal (issue #427,
 * `src/worktree/lease-liveness.ts`, which additionally weighs executing
 * dispatches).
 *
 * `excludeRunId` is the asking run, and omitting it means "any live run counts".
 * The reset path excludes the run being reset — its own lease is precisely the
 * stale marker to clear — and the collision gate excludes the provisioning
 * attempt, whose row is already `running` by then, so an un-excluded query would
 * always see itself. A zombie `running` row (a worker killed without settling it)
 * deliberately still counts as live; `failOrphanedRunningRuns` /
 * `failStaleRunningRuns` reap those, after which the next attempt recovers.
 */
export async function hasLiveRunForTask(
	projectId: string,
	taskId: string,
	excludeRunId?: string,
): Promise<boolean> {
	const conditions = [
		eq(runs.projectId, projectId),
		eq(runs.taskId, taskId),
		eq(runs.status, 'running'),
	];
	if (excludeRunId) conditions.push(ne(runs.id, excludeRunId));
	const rows = await getDb()
		.select({ id: runs.id })
		.from(runs)
		.where(and(...conditions))
		.limit(1);
	return rows.length > 0;
}

/**
 * Resolve the most recent run for one project task and phase. Fresh webhook
 * reruns use this to find a deferred or failed row that can be reused.
 */
export async function getLatestRunForTask(
	projectId: string,
	taskId: string,
	phase: TriggerPhase,
): Promise<RunRow | undefined> {
	const rows = await getDb()
		.select()
		.from(runs)
		.where(and(eq(runs.projectId, projectId), eq(runs.taskId, taskId), eq(runs.phase, phase)))
		.orderBy(desc(runs.startedAt))
		.limit(1);
	return rows[0];
}

/**
 * Resolve the newest successful Planning scope for this exact project/task.
 * Failed, deferred, unrelated, and pre-scope historical runs are intentionally
 * ignored: absence is evidence we do not have, never evidence of oversized work.
 */
export async function getLatestCompletedPlanningScope(
	projectId: string,
	taskId: string,
): Promise<ProposedScope | undefined> {
	const rows = await getDb()
		.select({ planningScope: runs.planningScope })
		.from(runs)
		.where(
			and(
				eq(runs.projectId, projectId),
				eq(runs.taskId, taskId),
				eq(runs.phase, 'planning'),
				eq(runs.status, 'completed'),
				isNotNull(runs.planningScope),
			),
		)
		.orderBy(desc(runs.completedAt), desc(runs.startedAt))
		.limit(1);
	return rows[0]?.planningScope ?? undefined;
}

/**
 * Whether this project's task has a *completed* run for the given phase — a
 * failed or deferred attempt does not count (issue #247). Implementation's
 * planned/unplanned config selection uses this so a merely-attempted Planning
 * run doesn't make the item look planned.
 */
export async function hasCompletedRunForTask(
	projectId: string,
	taskId: string,
	phase: TriggerPhase,
): Promise<boolean> {
	const rows = await getDb()
		.select({ id: runs.id })
		.from(runs)
		.where(
			and(
				eq(runs.projectId, projectId),
				eq(runs.taskId, taskId),
				eq(runs.phase, phase),
				eq(runs.status, 'completed'),
			),
		)
		.limit(1);
	return rows.length > 0;
}

export interface ReviewMergeOutcomeUpdate {
	/** `MergePullRequestOutcome['status']` or `'retry-exhausted'` (`src/worker/merge-automation.ts`). */
	status: string;
	message: string;
	/** The merge dispatch attempt this write reports (0 = the dispatch's first attempt). */
	attempt: number;
	/** The head SHA this outcome generation's approval covers. */
	approvedHeadSha: string;
}

/**
 * Persist a Review run's provider-neutral merge-automation outcome — written
 * by each attempt of the run's durable merge dispatch
 * (`processMergeAutomationDispatch`, issue #292).
 *
 * The write only lands while the row's `reviewMergeApprovedHeadSha` is either
 * unset or already equal to `input.approvedHeadSha` — i.e. it belongs to the
 * *current* outcome generation. This is the guard against a stale attempt
 * left over from a superseded review (the run row was retried and re-approved
 * a different head in the meantime): its write simply no-ops instead of
 * overwriting the newer generation's outcome. Returns whether the row was
 * updated.
 */
export async function updateReviewMergeOutcome(
	runId: string,
	input: ReviewMergeOutcomeUpdate,
): Promise<boolean> {
	const rows = await getDb()
		.update(runs)
		.set({
			reviewMergeOutcome: input.status,
			reviewMergeMessage: input.message,
			reviewMergeAttempt: input.attempt,
			reviewMergeApprovedHeadSha: input.approvedHeadSha,
		})
		.where(
			and(
				eq(runs.id, runId),
				or(
					isNull(runs.reviewMergeApprovedHeadSha),
					eq(runs.reviewMergeApprovedHeadSha, input.approvedHeadSha),
				),
			),
		)
		.returning({ id: runs.id });
	return rows.length > 0;
}

/**
 * Review runs whose merge automation last reported the transient `not-ready`
 * — read once at worker startup by the dispatch reconciler's legacy backfill
 * (`backfillLegacyMergeFollowUps`, `src/dispatch/reconciler.ts`) to import
 * pre-#292 merge-follow-up intent as durable merge dispatches. Rows whose
 * dispatch already exists are skipped there via the dispatch dedup key.
 */
export async function getPendingReviewMergeFollowUps(): Promise<RunRow[]> {
	return getDb()
		.select()
		.from(runs)
		.where(and(eq(runs.phase, 'review'), eq(runs.reviewMergeOutcome, 'not-ready')));
}

/**
 * Upsert the run's captured stdout/stderr. `run_logs.run_id` is unique (one log
 * row per run), so a retry path that re-stores overwrites rather than
 * duplicates — the write stays idempotent.
 */
export async function storeRunLogs(runId: string, stdout: string, stderr: string): Promise<void> {
	await getDb()
		.insert(runLogs)
		.values({ runId, stdout, stderr })
		.onConflictDoUpdate({ target: runLogs.runId, set: { stdout, stderr } });
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value) <= maxBytes) return value;
	return Buffer.from(value)
		.subarray(0, maxBytes)
		.toString('utf8')
		.replace(/\uFFFD$/, '');
}

/** Append ordered CLI events while keeping each run below its durable retention cap. */
export async function appendRunOutputEvents(
	runId: string,
	events: RunOutputEventInput[],
): Promise<void> {
	if (events.length === 0) return;
	await getDb().transaction(async (tx) => {
		const rows = await tx
			.select({ outputBytes: runs.outputBytes, outputTruncated: runs.outputTruncated })
			.from(runs)
			.where(eq(runs.id, runId))
			.for('update')
			.limit(1);
		const run = rows[0];
		if (!run || run.outputTruncated) return;

		let remaining = MAX_RUN_OUTPUT_BYTES - run.outputBytes;
		let storedBytes = 0;
		let truncated = false;
		const retained: RunOutputEventInput[] = [];
		for (const event of events) {
			const content = truncateUtf8(event.content, remaining);
			const bytes = Buffer.byteLength(content);
			if (content) retained.push({ ...event, content });
			storedBytes += bytes;
			remaining -= bytes;
			if (content !== event.content || remaining === 0) {
				truncated = true;
				break;
			}
		}
		if (retained.length > 0)
			await tx.insert(runOutputEvents).values(retained.map((e) => ({ ...e, runId })));
		await tx
			.update(runs)
			.set({
				outputBytes: sql`${runs.outputBytes} + ${storedBytes}`,
				outputTruncated: truncated,
			})
			.where(eq(runs.id, runId));
	});
}

export async function getRunOutputEvents(
	runId: string,
	after: number,
): Promise<{
	events: Array<{ id: number; stream: 'stdout' | 'stderr'; content: string; emittedAt: Date }>;
	nextCursor: number;
	hasMore: boolean;
	truncated: boolean;
	retentionBytes: number;
}> {
	const db = getDb();
	const [runRows, events] = await Promise.all([
		db.select({ truncated: runs.outputTruncated }).from(runs).where(eq(runs.id, runId)).limit(1),
		db
			.select({
				id: runOutputEvents.id,
				stream: runOutputEvents.stream,
				content: runOutputEvents.content,
				emittedAt: runOutputEvents.emittedAt,
			})
			.from(runOutputEvents)
			.where(and(eq(runOutputEvents.runId, runId), gt(runOutputEvents.id, after)))
			.orderBy(asc(runOutputEvents.id))
			.limit(RUN_OUTPUT_PAGE_SIZE + 1),
	]);
	const page = events.slice(0, RUN_OUTPUT_PAGE_SIZE);
	return {
		events: page,
		nextCursor: page.at(-1)?.id ?? after,
		hasMore: events.length > RUN_OUTPUT_PAGE_SIZE,
		truncated: runRows[0]?.truncated ?? false,
		retentionBytes: MAX_RUN_OUTPUT_BYTES,
	};
}

/**
 * Fail runs still marked `running` for one startup owner. An authenticated
 * worker passes its id; an unfederated worker passes `null` and may reconcile
 * only legacy/local rows with no worker id. Any matched row is a zombie: a
 * phase whose process died before writing its terminal status. Flip it to
 * `failed` with an explanatory `error` and `completedAt`, and return the count
 * reconciled. Best-effort like the rest of run tracking: callers log and
 * continue on error.
 */
export async function failOrphanedRunningRuns(
	reason: string,
	workerId: string | null,
): Promise<number> {
	const rows = await getDb()
		.update(runs)
		.set({ status: 'failed', error: reason, completedAt: new Date() })
		.where(
			workerId !== null
				? and(eq(runs.status, 'running'), eq(runs.workerId, workerId))
				: and(eq(runs.status, 'running'), isNull(runs.workerId)),
		)
		.returning({ id: runs.id });
	return rows.length;
}

/**
 * Fail every `running` row whose `startedAt` predates `olderThan` — the periodic
 * stale-row reconciliation the worker runs *while serving jobs* (issue #165),
 * the running-worker counterpart to {@link failOrphanedRunningRuns}'s
 * startup-only sweep. Unlike that one it cannot fail *all* `running` rows (a
 * genuinely in-flight phase has one), so it only reaps rows old enough that no
 * live agent could still be behind them: every agent is killed at its wall-clock
 * timeout ({@link resetRunToRunning} keeps `startedAt` per-attempt), so a row
 * still `running` well past the largest configured timeout is a settled phase
 * whose finalize never landed (its process died, but the worker survived). Flip
 * those to `failed` with an explanatory `error`; return the count reconciled.
 * Best-effort like the rest of run tracking: callers log and continue on error.
 */
export async function failStaleRunningRuns(
	defaultTimeoutMs: number,
	marginMs: number,
	reason: string,
): Promise<number> {
	const rows = await getDb()
		.update(runs)
		.set({ status: 'failed', error: reason, completedAt: new Date() })
		.where(
			and(
				eq(runs.status, 'running'),
				sql`${runs.startedAt} < NOW() - (COALESCE(${runs.timeoutMs}, ${defaultTimeoutMs}) + ${marginMs}) * INTERVAL '1 millisecond'`,
			),
		)
		.returning({ id: runs.id });
	return rows.length;
}

export interface ListRunsFilter {
	projectId?: string;
	/**
	 * Restrict the result to this set of project ids — the authorization scope a
	 * non-admin caller is limited to (#281 task 4). Distinct from the single
	 * `projectId` filter above: `projectId` is a user-chosen filter, `projectIds`
	 * is the accessible-project boundary the API layer imposes. Callers pass a
	 * non-empty array (an empty scope is short-circuited to an empty result
	 * without querying).
	 */
	projectIds?: readonly string[];
	status?: RunStatus;
	phase?: TriggerPhase;
	limit: number;
	offset: number;
}

/**
 * Paginated, filtered list of runs ordered by `startedAt` desc. `total` is the
 * count of the *filtered* set (not the page), so a UI can render page counts;
 * it runs as a separate query against the same conditions. Sort order is fixed
 * (`startedAt desc`) — sortable columns and date-range filters are out of scope.
 *
 * Queue and Runs are complementary read models (issues #279/#316): Queue is
 * the canonical list for waiting dispatches, so Runs hides only a deferred
 * attempt linked to a pending/retry-scheduled dispatch. Deferred attempts with
 * no waiting dispatch remain visible as history and for operator recovery.
 */
export async function listRunsFromDb(
	filter: ListRunsFilter,
): Promise<{ data: RunRow[]; total: number }> {
	const db = getDb();
	const hasWaitingDispatch = db
		.select({ id: dispatches.id })
		.from(dispatches)
		.where(
			and(eq(dispatches.runId, runs.id), inArray(dispatches.state, ['pending', 'retry-scheduled'])),
		);
	const conditions: SQL[] = [or(ne(runs.status, 'deferred'), notExists(hasWaitingDispatch)) as SQL];
	if (filter.projectId) conditions.push(eq(runs.projectId, filter.projectId));
	if (filter.projectIds && filter.projectIds.length > 0) {
		conditions.push(inArray(runs.projectId, [...filter.projectIds]));
	}
	if (filter.status) conditions.push(eq(runs.status, filter.status));
	if (filter.phase) conditions.push(eq(runs.phase, filter.phase));

	const where = and(...conditions);

	const data = await db
		.select()
		.from(runs)
		.where(where)
		.orderBy(desc(runs.startedAt))
		.limit(filter.limit)
		.offset(filter.offset);
	const totalRows = await db.select({ total: count() }).from(runs).where(where);
	return { data, total: totalRows[0].total };
}

/** Resolve a single run by its id. Returns `undefined` when unknown. */
export async function getRunByIdFromDb(id: string): Promise<RunRow | undefined> {
	const rows = await getDb().select().from(runs).where(eq(runs.id, id)).limit(1);
	return rows[0];
}

/**
 * Fetch a run's captured stdout/stderr. Returns `undefined` when the run has no
 * `run_logs` row (a run that succeeded, or failed before its output was stored).
 */
export async function getRunLogsFromDb(
	runId: string,
): Promise<{ stdout: string | null; stderr: string | null } | undefined> {
	const rows = await getDb()
		.select({ stdout: runLogs.stdout, stderr: runLogs.stderr })
		.from(runLogs)
		.where(eq(runLogs.runId, runId))
		.limit(1);
	return rows[0];
}
