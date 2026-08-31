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
	gte,
	inArray,
	isNotNull,
	isNull,
	ne,
	notExists,
	notInArray,
	or,
	type SQL,
	sql,
} from 'drizzle-orm';
import type { AgentCli } from '../../harness/agent-cli.js';
import type { AgentUsage } from '../../harness/usage.js';
import type { Checkpoint } from '../../pipeline/checkpoint.js';
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

/**
 * A run's terminal state — everything but the initial `running`.
 *
 * `checkpointed` (issue #503) is a *second* retry-pending state alongside
 * `deferred`, not a terminal one: the run stopped involuntarily, native session
 * resume could not serve it, and its preserved checkout carries a Tier 2 checkpoint
 * the enqueued continuation will pick up (`docs/CHECKPOINTS.md`). It differs from
 * `deferred` in exactly one way that matters to queries — it deliberately holds no
 * `agentSessionId` — so anything keying retry-pendingness on that column has to name
 * the status instead (see {@link hasResumableDeferredRun}).
 */
type RunStatus = 'running' | 'completed' | 'failed' | 'deferred' | 'checkpointed';

/** The retry-pending statuses: a run that has settled but is waiting on a scheduled continuation. */
export const RETRY_PENDING_RUN_STATUSES = ['deferred', 'checkpointed'] as const;

/** Whether a stored status string is one of {@link RETRY_PENDING_RUN_STATUSES}. */
export function isRetryPendingStatus(
	status: string,
): status is (typeof RETRY_PENDING_RUN_STATUSES)[number] {
	return (RETRY_PENDING_RUN_STATUSES as readonly string[]).includes(status);
}

export interface CreateRunInput {
	projectId: string;
	/**
	 * The repository this run acts on (`owner/repo`) — recorded on the row rather
	 * than derived from the project later (issue #683). Required: the dispatcher is
	 * the party that knows which repository the work is for, so a run is never
	 * created without stating it.
	 */
	repository: string;
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
			repository: input.repository,
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
 * The narrow input for {@link createFailedRun} — deliberately not
 * {@link CreateRunInput}: a run that never launched an agent has no engine,
 * model, reasoning, timeout, or worker to record, and stating them would invite
 * a caller to invent them.
 */
export interface CreateFailedRunInput {
	projectId: string;
	/** The repository this abandoned work was for (`owner/repo`) — see {@link CreateRunInput.repository}. */
	repository: string;
	taskId: string;
	phase: TriggerPhase;
	/** Why the work was abandoned — the operator-facing text the runs list renders. */
	error: string;
	prNumber?: string;
	/** The payload a "Retry now" on this row rebuilds its dispatch from. */
	jobPayload?: SwarmJob;
}

/**
 * Insert a run row that is **terminal from the start** (issue #742): one `failed`
 * row recording work SWARM abandoned before any agent ran, so an operator asking
 * "why did this stop?" finds the answer in the runs list rather than in worker
 * logs — and finds it in SWARM's own Postgres, which survives the source-control
 * provider that caused the give-up being unreachable.
 *
 * Deliberately one write rather than {@link createRun} + {@link failRunFromStatus}:
 * that pair passes through a `running` row holding an `agentSessionId`, and losing
 * its second half to the same outage that caused the give-up would strand a task
 * that looks live ({@link hasLiveRunForTask}) and resumable
 * ({@link hasResumableDeferredRun}) with nothing behind it. The column is left null
 * here for the same reason: there is no session to resume.
 *
 * `work_item_id` is deliberately never written — it is the *board card* link
 * ({@link findBoardItemIdForTask}), and a PR number recorded there would answer a
 * later phase's card lookup with a value no board ever issued.
 *
 * Returns the new row's id.
 */
export async function createFailedRun(input: CreateFailedRunInput): Promise<string> {
	const rows = await getDb()
		.insert(runs)
		.values({
			projectId: input.projectId,
			repository: input.repository,
			taskId: input.taskId,
			phase: input.phase,
			prNumber: input.prNumber,
			jobPayload: input.jobPayload,
			status: 'failed',
			error: input.error,
			completedAt: new Date(),
		})
		.returning({ id: runs.id });
	return rows[0].id;
}

/**
 * Whether retention must pin this task's checkout for a resumable deferred run —
 * any phase, any engine (cross-CLI resume). A deferred row that still holds an
 * `agentSessionId` is one the worker intends to resume; pruning its worktree
 * would strip the partial work the resume relies on.
 *
 * A `checkpointed` row (issue #503) pins the checkout just as hard, but cannot be
 * recognised the same way: its whole point is that there is no session to resume,
 * so it deliberately carries a **null** `agentSessionId` and the `isNotNull` clause
 * would exclude it — and pruning it would delete the very working tree its
 * checkpoint describes, turning the continuation into a `checkpoint-divergent`
 * block. Hence the OR: a session id *or* the status itself is evidence of intent.
 */
export async function hasResumableDeferredRun(projectId: string, taskId: string): Promise<boolean> {
	const rows = await getDb()
		.select({ id: runs.id })
		.from(runs)
		.where(
			and(
				eq(runs.projectId, projectId),
				eq(runs.taskId, taskId),
				inArray(runs.status, ['deferred', 'failed', 'checkpointed']),
				or(isNotNull(runs.agentSessionId), eq(runs.status, 'checkpointed')),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** The `runs.recovery` record, named so the sticky-key helpers below can talk about it. */
export type RunRecoveryRecord = NonNullable<typeof runs.$inferSelect.recovery>;

/**
 * The recovery-column write expression, with the two machine-location facts
 * (issue #567) carried across it rather than clobbered.
 *
 * `recovery` is rewritten wholesale on every settle and every re-bind, which is
 * precisely what used to make the location of a preserved checkout unrecoverable.
 * Two keys therefore survive the rewrite:
 *
 * - `preservedWorkerId` — live pin state, so it survives onto *another* recovery
 *   record (the `recovered` one a continuation's re-bind writes) but not a `null`
 *   write, which is the fresh, non-recovery attempt that gives the checkout up.
 * - `abandonedWorkerId` — a historical fact about the row, so it survives even a
 *   `null` write; nothing but a later abandonment replaces it.
 *
 * Written as one SQL expression so the merge reads the row's current value under
 * the same statement that replaces it — no read-modify-write race with a
 * concurrent settle.
 */
function recoveryWriteSql(next: RunRecoveryRecord | null): SQL {
	const sticky =
		next === null
			? sql`jsonb_build_object('abandonedWorkerId', ${runs.recovery} -> 'abandonedWorkerId')`
			: sql`jsonb_build_object(
					'abandonedWorkerId', ${runs.recovery} -> 'abandonedWorkerId',
					'preservedWorkerId', ${runs.recovery} -> 'preservedWorkerId'
				)`;
	const base = next === null ? sql`'{}'::jsonb` : sql`${JSON.stringify(next)}::jsonb`;
	// `jsonb_strip_nulls` drops the absent sticky keys (`jsonb -> key` is SQL NULL
	// when missing); `nullif` keeps "no record at all" as a real NULL column rather
	// than an empty object, so every `recovery IS NULL` reader is unaffected.
	return sql`nullif(jsonb_strip_nulls(${sticky} || ${base}), '{}'::jsonb)`;
}

export interface CompleteRunInput {
	status: 'completed' | 'failed' | 'deferred' | 'checkpointed';
	engine?: AgentCli;
	exitCode?: number | null;
	timedOut?: boolean;
	/**
	 * Pass explicit `null` to *clear* a previous attempt's message on a settle that
	 * records success without going through {@link resetRunToRunning} first (issue
	 * #815): an omitted field is dropped from the update, so a run finalized as
	 * `completed` straight off a deferral would otherwise keep showing the
	 * rate-limit text that deferral wrote.
	 */
	error?: string | null;
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
	/**
	 * The Tier 2 checkpoint a `checkpointed` settle hands its continuation
	 * (issue #503). Set only alongside `status: 'checkpointed'`; omitted for every
	 * other settle, which leaves the column as-is.
	 */
	checkpoint?: Checkpoint;
	/**
	 * The run's checkpoint-continuation count *after* this settle — written only by a
	 * `checkpointed` settle, which is the one thing that spends the budget.
	 */
	continuationCount?: number;
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
			// Spread rather than assigned so an omitted `recovery` still leaves the
			// column untouched, while a supplied one goes through the sticky-key merge
			// (issue #567) instead of clobbering the run's recorded machine location.
			...(input.recovery !== undefined ? { recovery: recoveryWriteSql(input.recovery) } : {}),
			cancellation: input.cancellation,
			planningScope: input.planningScope,
			failureDiagnosis: input.failureDiagnosis,
			checkpoint: input.checkpoint,
			continuationCount: input.continuationCount,
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
			// `repository` is deliberately left alone too (issue #683): a retry re-runs
			// the same work against the same repository, so the row keeps the one it
			// was created for.
			// `continuationCount` and `checkpoint` are deliberately *not* cleared either
			// (issue #503): the count is the bound on the Tier 2 fallback, so resetting
			// it on the very retry the fallback scheduled would make the loop unbounded,
			// and the checkpoint is what this attempt is being seeded from. "Reset &
			// restart" ({@link clearRunRecovery}) is what discards both.
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
			// The re-bind this issue's defect hid behind (#567): `worker_id` above is
			// being overwritten with *this* attempt's worker, so the machine holding the
			// preserved checkout would be lost here if the recovery record were replaced
			// wholesale. `recoveryWriteSql` carries it onto the new record.
			...(recovery !== undefined ? { recovery: recoveryWriteSql(recovery) } : {}),
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
 *
 * A `checkpointed` run (issue #503) is claimed by the same path: it is the other
 * retry-pending state, so a user terminating it must settle its waiting dispatch
 * exactly as for a `deferred` one. It reports no `preservedSession` (it has none),
 * which is what makes the caller's checkout reconciliation treat its worktree as
 * ordinary protected work rather than a resumable session's.
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
		if (!run || !isRetryPendingStatus(run.status)) {
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
				// Through the sticky-key merge like every other recovery write (issue
				// #567): terminating a deferred run keeps its session *and*, when the
				// checkout is on another host, keeps the checkout — so the operator's next
				// "Resume" is still a continuation and must still be pinned. Replacing the
				// record wholesale here would drop the machine and send that resume to
				// whichever worker was free, which is the defect this pin exists to close.
				recovery: recoveryWriteSql(recoveryVal),
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
		// Merged rather than replaced (issue #567): a checkout that could not be removed
		// is *still on* the machine that holds it, so this is the last write that should
		// forget where that is — and an `abandonedWorkerId` is a historical fact no
		// later write may erase.
		.set({ recovery: recoveryWriteSql({ state: 'blocked', blockedReason }) })
		.where(eq(runs.id, runId));
}

/**
 * Record the machine that holds this run's **preserved checkout** (issue #567),
 * taken from the attempt's own `worker_id` — the one moment at which the two are
 * still the same fact, since `worker_id` is overwritten by every later bind.
 *
 * Called at each settle that leaves a checkout behind for a continuation to adopt:
 * a resumable/`checkpointed`/delivery-resume deferral, and a cancellation that
 * preserved its session. Merged into whatever recovery record that settle wrote
 * rather than replacing it, so it composes with `preserved`/`blocked` alike.
 *
 * A run with no recorded worker (an unfederated one) matches nothing and records
 * nothing: there is no other machine it could have been dispatched to, so there is
 * nothing to pin. Best-effort like the rest of run tracking — the caller swallows
 * and logs a throw.
 */
export async function recordRunPreservedWorker(runId: string): Promise<void> {
	await getDb()
		.update(runs)
		.set({
			recovery: sql`coalesce(${runs.recovery}, '{}'::jsonb) || jsonb_build_object('preservedWorkerId', ${runs.workerId})`,
		})
		.where(and(eq(runs.id, runId), isNotNull(runs.workerId)));
}

/**
 * Clear a run's recovery record for a "Reset & restart" (issue #424): the fresh
 * attempt starts from a clean slate, so a `blocked`/`preserved` record must not
 * keep misleading retention (`hasResumableDeferredRun`), the reclaim gate, or
 * the UI. The captured session id goes with it — a retained session must never
 * outlive the checkout it would have resumed.
 *
 * The Tier 2 record goes too (issue #503): the reset discards the checkout, so the
 * `checkpoint` describes a working tree that no longer exists, and the whole point
 * of the action is to start over — which means the spent `continuationCount` is
 * forgiven. This is the *only* path that resets that count; an ordinary retry keeps
 * it, or the fallback would never be bounded.
 *
 * One thing is not cleared but *converted* (issue #567): a recorded
 * `preservedWorkerId` becomes an `abandonedWorkerId`. Clearing the pin is what frees
 * the run to restart on any machine — the point of the action — but a run that
 * started over instead of continuing used to leave no trace at all, so the machine
 * whose work was given up is kept as the record of it. An existing
 * `abandonedWorkerId` is retained when there is no pin to replace it, and a run with
 * neither ends up with a `NULL` column exactly as before.
 */
export async function clearRunRecovery(runId: string): Promise<void> {
	await getDb()
		.update(runs)
		.set({
			recovery: sql`nullif(
				jsonb_strip_nulls(
					jsonb_build_object(
						'abandonedWorkerId',
						coalesce(${runs.recovery} -> 'preservedWorkerId', ${runs.recovery} -> 'abandonedWorkerId')
					)
				),
				'{}'::jsonb
			)`,
			agentSessionId: null,
			checkpoint: null,
			continuationCount: 0,
		})
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
 * How many runs this project has in flight, using the same liveness notion as
 * {@link hasLiveRunForTask}: a `running` row, zombies included, since
 * `failOrphanedRunningRuns` / `failStaleRunningRuns` are what reap those.
 *
 * The project-scoped twin of the worker-side `deriveWorkerRunState().busy`, and read
 * for the same reason — `projects.delete` refuses while the answer is non-zero
 * (issue #854), because deleting the project cascades those very `runs` and
 * `dispatches` rows out from under a worker still executing them. It is a count
 * rather than a boolean so the refusal can say how many.
 *
 * Takes an executor so the delete guard can read it inside the same transaction
 * that locked the project and its dispatches (`deleteIdleProjectFromDb`): a row
 * this count is compared against must not be able to appear between the read and
 * the `DELETE`.
 */
export async function countRunningRunsForProject(
	projectId: string,
	db: Pick<ReturnType<typeof getDb>, 'select'> = getDb(),
): Promise<number> {
	const rows = await db
		.select({ total: count() })
		.from(runs)
		.where(and(eq(runs.projectId, projectId), eq(runs.status, 'running')));
	return rows[0].total;
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
 * The board card SWARM last recorded for this project task — the provider-native
 * work-item id of the most recent run that carried one.
 *
 * The durable card↔task link the PR-driven phases resolve their board card
 * through (issue #498): every board-driven run persists `runs.work_item_id`
 * alongside its `(project_id, task_id)`, so a later phase that knows only the
 * task can recover the card without guessing a provider-shaped URL for it
 * (ai/ARCHITECTURE.md "Task identity"). Rows carrying no card — the PR-driven
 * phases' own rows, which sit alongside the board-driven ones for the same task
 * and are usually *newer* — are skipped rather than read as "no card"; so is the
 * empty-string id a provider with an unresolvable item would have written.
 *
 * `undefined` when nothing links the task to a card: the board never drove it, or
 * the run rows have since been pruned. The caller falls back or skips its report;
 * this is a soft miss, not bad input.
 */
export async function findBoardItemIdForTask(
	projectId: string,
	taskId: string,
): Promise<string | undefined> {
	const rows = await getDb()
		.select({ workItemId: runs.workItemId })
		.from(runs)
		.where(
			and(
				eq(runs.projectId, projectId),
				eq(runs.taskId, taskId),
				isNotNull(runs.workItemId),
				ne(runs.workItemId, ''),
			),
		)
		.orderBy(desc(runs.startedAt))
		.limit(1);
	return rows[0]?.workItemId ?? undefined;
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

/**
 * Whether this project's task has *any* run row for the given phase — running,
 * failed, or completed. Unlike {@link hasCompletedRunForTask} the status is
 * deliberately ignored: Implementation opens the PR from *inside* its own
 * still-running agent process, so `pull_request opened` arrives while that row
 * is still `running` (see `src/triggers/handlers/review.ts`'s header on that
 * race). The Review trigger's ownership gate uses this as the durable record
 * that SWARM dispatched this work item (issue #397).
 */
export async function hasRunForTask(
	projectId: string,
	taskId: string,
	phase: TriggerPhase,
): Promise<boolean> {
	const rows = await getDb()
		.select({ id: runs.id })
		.from(runs)
		.where(and(eq(runs.projectId, projectId), eq(runs.taskId, taskId), eq(runs.phase, phase)))
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
	/**
	 * The head SHA this write *replaces*, when the dispatch itself advanced the
	 * approved head by bringing the pull request up to date with its base (issue
	 * #874). Widens the generation guard below by exactly one value, so the one
	 * write that legitimately changes the generation lands while a superseded
	 * review's leftover attempt — which names neither head — still no-ops.
	 */
	advancedFrom?: string;
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
 *
 * `input.advancedFrom` is the one way the generation itself moves on: the merge
 * dispatch that brought a stale head up to date with its base names the head it
 * replaced, so that single write lands and every write after it belongs to the
 * new generation (issue #874).
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
					...(input.advancedFrom ? [eq(runs.reviewMergeApprovedHeadSha, input.advancedFrom)] : []),
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
 * the canonical list for waiting dispatches, so Runs hides only a retry-pending
 * attempt — `deferred`, or `checkpointed` (issue #503) — linked to a
 * pending/retry-scheduled dispatch. Retry-pending attempts with no waiting dispatch
 * remain visible as history and for operator recovery.
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
	const conditions: SQL[] = [
		or(
			notInArray(runs.status, [...RETRY_PENDING_RUN_STATUSES]),
			notExists(hasWaitingDispatch),
		) as SQL,
	];
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

/**
 * One row per `(project_id, repository, task_id)` — the latest run of each task
 * plus the group's aggregates. The run-side half of the item-liveness read model
 * (issue #840, `src/dispatch/item-liveness.ts`), which folds these onto the unit
 * an operator recognises: a pull request, or a board card.
 */
export interface TaskActivityRow {
	projectId: string;
	repository: string;
	taskId: string;
	/** The group's latest run, by `coalesce(completed_at, started_at)` desc. */
	runId: string;
	phase: string;
	status: string;
	prNumber: string | null;
	prTitle: string | null;
	workItemId: string | null;
	workItemTitle: string | null;
	workItemUrl: string | null;
	producedPrUrl: string | null;
	reviewVerdict: string | null;
	reviewAutomationOutcome: string | null;
	reviewMergeOutcome: string | null;
	/** `max(coalesce(completed_at, started_at))` across the group. */
	lastActivityAt: Date;
	/** How many runs in the group are still `running`. */
	liveRunCount: number;
}

/**
 * Every task with run activity since `since`, as {@link TaskActivityRow}s.
 *
 * Three things this read is, deliberately:
 *
 * - **Bounded by `since`.** That is what keeps it cheap and stops years of
 *   finished history filling the view; `idx_runs_started_at` covers the predicate.
 *   A task whose newest run started before the window ages out of the liveness
 *   view rather than being reported forever.
 * - **Grouped on the run's own `repository`** (issue #683), not on the project
 *   alone: a project spanning several repositories answers per repository, so two
 *   repos' identically-numbered work never folds together.
 * - **Run activity only.** A dispatch that settled without producing a run — a
 *   `no-trigger`, a `skipped-duplicate` — is deliberately not "movement": it *is*
 *   the absence of forward progress, which is the thing being detected.
 *
 * `projectIds` is the authorization scope, same convention as
 * {@link ListRunsFilter.projectIds}: callers pass a non-empty array, and an empty
 * scope is short-circuited to an empty result without querying.
 */
export async function listTaskActivitySince(input: {
	since: Date;
	projectIds?: readonly string[];
}): Promise<TaskActivityRow[]> {
	// An empty scope is "no accessible project", not "every project": answer it
	// before building a query, so a caller that narrowed to nothing can never be
	// widened back to the whole installation by a missing `inArray` term.
	if (input.projectIds && input.projectIds.length === 0) return [];

	const db = getDb();
	const conditions: SQL[] = [gte(runs.startedAt, input.since)];
	if (input.projectIds) {
		conditions.push(inArray(runs.projectId, [...input.projectIds]));
	}
	const where = and(...conditions);

	const activity = db
		.select({
			projectId: runs.projectId,
			repository: runs.repository,
			taskId: runs.taskId,
			// `.mapWith` rather than a bare `sql<Date>`: drizzle's node-postgres driver
			// hands raw SQL its own driver value, and a `timestamp` column arrives as
			// the string `2026-02-02 00:10:00`. Decoding through the column the
			// aggregate is built from is what makes the declared `Date` the runtime
			// type too — the classifier does date arithmetic on it
			// (`src/dispatch/item-liveness.ts`).
			lastActivityAt: sql`max(coalesce(${runs.completedAt}, ${runs.startedAt}))`
				.mapWith(runs.startedAt)
				.as('last_activity_at'),
			liveRunCount: sql<number>`count(*) filter (where ${runs.status} = 'running')::int`.as(
				'live_run_count',
			),
		})
		.from(runs)
		.where(where)
		.groupBy(runs.projectId, runs.repository, runs.taskId)
		.as('task_activity');

	return db
		.selectDistinctOn([runs.projectId, runs.repository, runs.taskId], {
			projectId: runs.projectId,
			repository: runs.repository,
			taskId: runs.taskId,
			runId: runs.id,
			phase: runs.phase,
			status: runs.status,
			prNumber: runs.prNumber,
			prTitle: runs.prTitle,
			workItemId: runs.workItemId,
			workItemTitle: runs.workItemTitle,
			workItemUrl: runs.workItemUrl,
			producedPrUrl: runs.producedPrUrl,
			reviewVerdict: runs.reviewVerdict,
			reviewAutomationOutcome: runs.reviewAutomationOutcome,
			reviewMergeOutcome: runs.reviewMergeOutcome,
			lastActivityAt: activity.lastActivityAt,
			liveRunCount: activity.liveRunCount,
		})
		.from(runs)
		.innerJoin(
			activity,
			and(
				eq(runs.projectId, activity.projectId),
				eq(runs.repository, activity.repository),
				eq(runs.taskId, activity.taskId),
			),
		)
		.where(where)
		.orderBy(
			runs.projectId,
			runs.repository,
			runs.taskId,
			desc(sql`coalesce(${runs.completedAt}, ${runs.startedAt})`),
			desc(runs.startedAt),
		);
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
