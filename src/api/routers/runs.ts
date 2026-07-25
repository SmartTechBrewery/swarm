import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	getActiveDispatchByRunId,
	getDispatchById,
	listWaitingDispatches,
	reopenDispatchForManualRetry,
} from '../../db/repositories/dispatchesRepository.js';
import {
	getProjectByIdFromDb,
	listAllProjectsFromDb,
} from '../../db/repositories/projectsRepository.js';
import {
	cancelDeferredRunInDb,
	getRunByIdFromDb,
	getRunLogsFromDb,
	getRunOutputEvents,
	listRunsFromDb,
	recordRunCleanupBlocked,
} from '../../db/repositories/runsRepository.js';
import {
	cancelDispatchAndWake,
	createAndPublishDispatch,
	publishDispatchWakeUp,
} from '../../dispatch/dispatcher.js';
import { reconstructRetryJob } from '../../dispatch/retry-payload.js';
import { RunResetError, type RunResetRefusal, resetRun } from '../../dispatch/run-reset.js';
import { AgentCliSchema } from '../../harness/agent-cli.js';
import { ReasoningLevelSchema } from '../../harness/models.js';
import { resolvePipelinePhaseForOptionId } from '../../integrations/pm/github-projects/status-mapping.js';
import { getPMProvider } from '../../integrations/pm/registry.js';
import { describeError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
	type CancellationOrigin,
	clearRunCancellation,
	RUN_CANCELLED_MESSAGE,
	requestRunCancellation,
} from '../../queue/cancellation.js';
import { type SwarmJob, SwarmJobSchema } from '../../queue/jobs.js';
import { priorityFor, removePendingJobById } from '../../queue/producer.js';
import {
	deriveDispatchPhaseHint,
	deriveQueuedPhaseHint,
	type QueuedPhaseHint,
	type QueuedRun,
	toQueuedRuns,
} from '../../queue/queued-runs.js';
import type { TriggerPhase } from '../../triggers/types.js';
import { GitWorktreeManager } from '../../worker/git-worktree-manager.js';
import { reconcileTerminatedWorktree } from '../../worktree/termination-cleanup.js';
import { accessibleProjectScope, assertProjectAccess } from '../authz.js';
import { authedProcedure, router } from '../trpc.js';

const QUEUED_WORK_ITEM_CACHE_TTL_MS = 30_000;
const queuedWorkItemCache = new Map<
	string,
	{ expiresAt: number; title?: string; url?: string; nodeId?: string; phaseHint?: QueuedPhaseHint }
>();

function queuedWorkItemCacheKey(item: QueuedRun): string | null {
	if (item.type === 'github-projects' && item.workItemNodeId) {
		return `${item.projectId}:${item.workItemNodeId}`;
	}
	if (item.type === 'github' && item.prNumber) {
		return `${item.projectId}:github:${item.prNumber}`;
	}
	return null;
}

function withQueuedWorkItemDetails(
	item: QueuedRun,
	details: { title?: string; url?: string; nodeId?: string; phaseHint?: QueuedPhaseHint },
): QueuedRun {
	return {
		...item,
		workItemTitle: details.title,
		workItemUrl: details.url,
		workItemNodeId: details.nodeId || item.workItemNodeId,
		phaseHint: details.phaseHint || item.phaseHint,
	};
}

async function resolveQueuedWorkItemDetails(
	item: QueuedRun,
	workItemNodeId: string,
): Promise<{ title?: string; url?: string; isSupported?: boolean } | null> {
	const project = await getProjectByIdFromDb(item.projectId);
	if (!project) return null;

	const manifest = getPMProvider(project.pm.type);
	if (!manifest) return null;

	const workItem = await manifest.createProvider(project).getWorkItem(workItemNodeId);
	let isSupported = false;
	if (workItem.statusId) {
		const targetPhase = resolvePipelinePhaseForOptionId(project.githubProjects, workItem.statusId);
		if (targetPhase === 'planning' || targetPhase === 'implementation') {
			isSupported = true;
		}
	}
	return {
		title: workItem.title || undefined,
		url: workItem.url || undefined,
		isSupported,
	};
}

async function enrichQueuedWorkItem(item: QueuedRun): Promise<QueuedRun> {
	const cacheKey = queuedWorkItemCacheKey(item);
	if (!cacheKey) return item;

	const cached = queuedWorkItemCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return withQueuedWorkItemDetails(item, cached);
	}

	try {
		let details: {
			title?: string;
			url?: string;
			nodeId?: string;
			phaseHint?: QueuedPhaseHint;
		} | null = null;
		if (item.type === 'github-projects' && item.workItemNodeId) {
			const resolved = await resolveQueuedWorkItemDetails(item, item.workItemNodeId);
			if (resolved) {
				details = {
					title: resolved.title,
					url: resolved.url,
					nodeId: item.workItemNodeId,
					phaseHint: resolved.isSupported ? 'board' : 'unknown',
				};
			}
		} else if (item.type === 'github' && item.prNumber) {
			const project = await getProjectByIdFromDb(item.projectId);
			if (project) {
				const manifest = getPMProvider(project.pm.type);
				if (manifest) {
					const pm = manifest.createProvider(project);
					const items = await pm.listWorkItems();
					const repoFullName = item.repo;
					const match = items.find((i) =>
						repoFullName
							? i.url.endsWith(`/${repoFullName}/issues/${item.prNumber}`) ||
								i.url.endsWith(`/${repoFullName}/pull/${item.prNumber}`)
							: i.url.endsWith(`/issues/${item.prNumber}`) ||
								i.url.endsWith(`/pull/${item.prNumber}`),
					);
					if (match) {
						details = {
							title: match.title || undefined,
							url: match.url || undefined,
							nodeId: match.id,
						};
					}
				}
			}
		}

		if (!details) return item;

		const cachedDetails = {
			expiresAt: Date.now() + QUEUED_WORK_ITEM_CACHE_TTL_MS,
			...details,
		};
		queuedWorkItemCache.set(cacheKey, cachedDetails);
		return withQueuedWorkItemDetails(item, cachedDetails);
	} catch (error) {
		logger.debug('runs.queued: backing work item lookup failed; using fallback', {
			projectId: item.projectId,
			workItemNodeId: item.workItemNodeId,
			prNumber: item.prNumber,
			error: error instanceof Error ? error.message : String(error),
		});
		return item;
	}
}

/** Add the same backing Issue/PR metadata that the persisted runs list uses. */
async function enrichQueuedWorkItems(items: QueuedRun[]): Promise<QueuedRun[]> {
	return Promise.all(items.map(enrichQueuedWorkItem));
}

// `RunStatus`/`RunRow` are local (non-exported) types in the repository, so the
// router declares its own filter enums — keeping Zod the source of truth for the
// API boundary and rejecting garbage filter values before they reach the DB.
const RunStatusEnum = z.enum(['running', 'completed', 'failed', 'deferred']);
const RunPhaseEnum = z.enum([
	'planning',
	'implementation',
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
]);

const ListRunsInputSchema = z.object({
	projectId: z.string().min(1).optional(),
	status: RunStatusEnum.optional(),
	phase: RunPhaseEnum.optional(),
	limit: z.number().int().positive().max(200).default(50),
	offset: z.number().int().nonnegative().default(0),
});

function wakeJobId(dispatch: { id: string; wakeSeq: number }): string {
	return `dispatch_${dispatch.id}_w${dispatch.wakeSeq}`;
}

/** How each reset refusal (`src/dispatch/run-reset.ts`) surfaces over tRPC. */
const RESET_REFUSAL_CODES: Record<RunResetRefusal, TRPCError['code']> = {
	'run-not-found': 'NOT_FOUND',
	'already-resetting': 'CONFLICT',
	'project-not-found': 'PRECONDITION_FAILED',
	'missing-job-payload': 'PRECONDITION_FAILED',
	'running-not-forced': 'PRECONDITION_FAILED',
	'dispatch-claimed': 'PRECONDITION_FAILED',
	'worktree-teardown-failed': 'PRECONDITION_FAILED',
};

function alreadyRetrying(): TRPCError {
	return new TRPCError({
		code: 'CONFLICT',
		message: 'This run is already retrying. Refresh to see its current status.',
	});
}

/**
 * Cancel the *other* fresh board dispatches for one card while putting it back
 * (issue #366). A single board-card interaction fans out into several dispatches
 * for the same card — the two `projects_v2_item` webhooks a drag fires
 * (`reordered` + `edited`) and the synthetic Planning→Implementation
 * self-enqueue — which the queue view folds into one row. Putting the item back
 * means none of them should fire, so its duplicates are cancelled here rather
 * than left to no-op one by one at claim time (and reappear as a stale queue
 * row). Cancel-only and best-effort: it never touches a dispatch that already
 * owns a run (`runId` — a deferred/resuming run), and a sibling that was just
 * claimed simply fails its conditional cancel.
 *
 * Its filter mirrors the queue view's fold (`boardGroupKey` in
 * `dashboard/src/lib/queued-runs.ts`) exactly: only *unresolved* board
 * dispatches (phase hint still `board`) are folded into the put-back row, so a
 * sibling whose worker-resolved phase is already `planning`/`implementation`
 * renders on its own row and must not be silently cancelled here.
 */
async function cancelDuplicateBoardDispatches(
	projectId: string,
	workItemNodeId: string,
	keepDispatchId: string,
): Promise<void> {
	const siblings = await listWaitingDispatches(projectId);
	const duplicates = siblings.filter(
		(sibling) =>
			sibling.id !== keepDispatchId &&
			!sibling.runId &&
			sibling.jobPayload.type === 'github-projects' &&
			sibling.jobPayload.event.itemNodeId === workItemNodeId &&
			deriveDispatchPhaseHint(sibling) === 'board',
	);
	for (const duplicate of duplicates) {
		await cancelDispatchAndWake(
			duplicate.id,
			'Put back to Backlog from the dashboard (duplicate board dispatch)',
		).catch(() => null);
	}
}

/**
 * Settle a just-cancelled deferred run's checkout (issue #361). Best-effort: the
 * dispatch and row are already terminally cancelled, so a filesystem/DB hiccup
 * here must never fail the termination the user asked for — it is logged and the
 * worktree is left for the retention sweep. When settlement retains protected
 * work, its blocked reason is recorded on the run without touching the cancelled
 * dispatch (`recordRunCleanupBlocked`).
 */
async function reconcileDeferredTermination(
	runId: string,
	projectId: string,
	taskId: string,
	preservedSession: string | null,
): Promise<void> {
	try {
		const project = await getProjectByIdFromDb(projectId);
		if (!project) return;
		const result = await reconcileTerminatedWorktree(
			new GitWorktreeManager(project),
			projectId,
			taskId,
			preservedSession,
			false,
		);
		if (result.outcome === 'blocked') {
			await recordRunCleanupBlocked(runId, result.blockedReason);
		}
	} catch (error) {
		logger.warn(
			'runs.terminate: deferred worktree settlement failed (retention sweep will repair)',
			{ projectId, taskId, error: describeError(error) },
		);
	}
}

export const runsRouter = router({
	// Paginated, filtered list; returns { data, total } straight from the repo.
	// Project-scoped (#281 task 4): an explicit `projectId` filter requires read
	// access to that project; without one the result is bounded to the caller's
	// accessible projects (every project for an `instanceAdmin`), so a non-member
	// never sees another project's runs through the cross-project view.
	list: authedProcedure.input(ListRunsInputSchema).query(async ({ ctx, input }) => {
		if (input.projectId) {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			return await listRunsFromDb(input);
		}
		const scope = await accessibleProjectScope(ctx.user);
		if (scope === null) return await listRunsFromDb(input);
		if (scope.length === 0) return { data: [], total: 0 };
		return await listRunsFromDb({ ...input, projectIds: scope });
	}),

	// Every canonical waiting dispatch (pending / capacity-blocked /
	// retry-scheduled) — the durable queue read model (issues #234, #284), never
	// a BullMQ snapshot, so nothing pending can be invisible here. No pagination:
	// the pending set is small and bounded by worker throughput. Scoped like
	// `list`: a chosen `projectId` needs read access, and the unscoped view is
	// filtered to the caller's accessible projects in-memory (the set is small).
	queued: authedProcedure
		.input(z.object({ projectId: z.string().min(1).optional() }).optional())
		.query(async ({ ctx, input }) => {
			if (input?.projectId) {
				await assertProjectAccess(ctx.user, input.projectId, 'contributor');
				const project = await getProjectByIdFromDb(input.projectId);
				const policy = project?.pipeline?.prioritizeContinuations !== false;
				const policies = { [input.projectId]: policy };
				return enrichQueuedWorkItems(
					toQueuedRuns(await listWaitingDispatches(input.projectId), policies),
				);
			}
			const scope = await accessibleProjectScope(ctx.user);
			const dispatches = await listWaitingDispatches(input?.projectId);
			const projects = await listAllProjectsFromDb();
			const policies = Object.fromEntries(
				projects.map((p) => [p.id, p.pipeline?.prioritizeContinuations !== false]),
			);
			const items = toQueuedRuns(dispatches, policies);
			if (scope === null) return enrichQueuedWorkItems(items);
			const accessible = new Set(scope);
			return enrichQueuedWorkItems(items.filter((item) => accessible.has(item.projectId)));
		}),

	// Single run by id; NOT_FOUND when unknown or when the caller is not a member
	// of the run's project (existence hidden with identical run-not-found message).
	getById: authedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const run = await getRunByIdFromDb(input.id);
			if (!run) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Run with ID "${input.id}" not found`,
				});
			}
			await assertProjectAccess(
				ctx.user,
				run.projectId,
				'contributor',
				`Run with ID "${input.id}" not found`,
			);
			return run;
		}),

	// Captured stdout/stderr for a run; null when the run stored no logs (a run
	// that succeeded, or failed before its output was captured) — not an error.
	// Needs read access to the run's project (its output can contain sensitive
	// detail), so the run is resolved first to find that project.
	getLogs: authedProcedure
		.input(z.object({ runId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const run = await getRunByIdFromDb(input.runId);
			if (!run) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Run with ID "${input.runId}" not found`,
				});
			}
			await assertProjectAccess(
				ctx.user,
				run.projectId,
				'contributor',
				`Run with ID "${input.runId}" not found`,
			);
			return (await getRunLogsFromDb(input.runId)) ?? null;
		}),

	getOutput: authedProcedure
		.input(z.object({ runId: z.string().min(1), after: z.number().int().nonnegative().default(0) }))
		.query(async ({ ctx, input }) => {
			const run = await getRunByIdFromDb(input.runId);
			if (!run) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Run with ID "${input.runId}" not found`,
				});
			}
			await assertProjectAccess(
				ctx.user,
				run.projectId,
				'contributor',
				`Run with ID "${input.runId}" not found`,
			);
			return await getRunOutputEvents(input.runId, input.after);
		}),

	// Fire a run's retry immediately ("Retry now", issues #136, #284).
	//
	// Scope: `deferred` or terminally `failed` runs. The retry is a *dispatch*
	// transition, never a direct run-row flip: the run stays `deferred`/`failed`
	// until the worker actually claims the dispatch and starts the attempt, so a
	// failed enqueue can no longer strand a false `running` run (the exact
	// orphan issue #284 calls out). Two shapes:
	//
	//  1. The run has an active dispatch (`retry-scheduled`, or capacity-blocked
	//     `pending`) — the common case. Its stored payload gets the operator's
	//     overrides folded in and the dispatch is atomically re-opened for an
	//     immediate attempt (`reopenDispatchForManualRetry`); losing that
	//     conditional update to a concurrent pickup returns CONFLICT.
	//  2. No active dispatch (a terminally `failed` run, or a legacy row whose
	//     retry intent was lost) — reconstruct from the run's stored
	//     `jobPayload` and create a fresh dispatch. The one-active-dispatch-per-
	//     run unique index turns a double-click into CONFLICT, not two runs.
	//
	// Cap-bypass: every path resets `rateLimitRetryAttempt` to 0, so a manual
	// retry always gets a fresh budget — including a run whose next *automatic*
	// attempt would itself have tripped `MAX_RATE_LIMIT_RETRIES`.
	//
	// Only limit: reconstruction needs a stored `jobPayload`. A run recorded
	// without one (older rows, or a create path that didn't persist it) can't be
	// rebuilt and is rejected with a clear message.
	retryNow: authedProcedure
		.input(
			z.object({
				runId: z.string().min(1),
				cli: AgentCliSchema.optional(),
				model: z.string().min(1).optional(),
				reasoning: ReasoningLevelSchema.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const run = await getRunByIdFromDb(input.runId);
			if (!run) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Run with ID "${input.runId}" not found`,
				});
			}
			// Driving a run (retrying it) is a `member`+ action on its project.
			await assertProjectAccess(
				ctx.user,
				run.projectId,
				'member',
				`Run with ID "${input.runId}" not found`,
			);
			if (run.status !== 'deferred' && run.status !== 'failed') {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Only a deferred or failed run can be retried; run "${input.runId}" is ${run.status}.`,
				});
			}

			// Clear any stale user-termination flag before re-running this row: a run
			// terminated while deferred keeps its cancellation entry (issue #166), and
			// re-running reuses the same immutable run id — without this the worker's
			// start-check would instantly terminate the fresh attempt.
			await clearRunCancellation(input.runId);

			const isRecovery = run.recovery?.state === 'preserved';
			const applyingOverride =
				input.cli !== undefined || input.model !== undefined || input.reasoning !== undefined;
			let startFresh = run.status === 'failed' || run.agentSessionId === null || applyingOverride;
			let recoveryMode: 'resume' | 'fresh' | undefined;
			if (isRecovery) {
				recoveryMode = applyingOverride ? 'fresh' : 'resume';
				startFresh = applyingOverride;
			}

			const active = await getActiveDispatchByRunId(run.id);
			if (active) {
				// Fold the overrides into the dispatch's stored payload (authoritative
				// at claim time) and re-open it for an immediate attempt.
				const stored = SwarmJobSchema.safeParse(active.jobPayload);
				if (!stored.success) {
					throw new TRPCError({
						code: 'PRECONDITION_FAILED',
						message: `Cannot retry run "${input.runId}" — its dispatch payload no longer validates.`,
					});
				}
				const job = reconstructRetryJob(
					stored.data,
					run.id,
					run.phase,
					input.cli,
					input.model,
					input.reasoning,
					startFresh,
					recoveryMode,
					run.recovery?.agentSessionId ?? run.agentSessionId,
				);
				const reopened = await reopenDispatchForManualRetry(active.id, job);
				if (!reopened) throw alreadyRetrying();
				try {
					await publishDispatchWakeUp(reopened);
				} catch (err) {
					// The durable intent is already recorded; the reconciler re-publishes.
					logger.warn('retryNow: failed to publish wake-up (reconciler will repair)', {
						dispatchId: reopened.id,
						error: describeError(err),
					});
				}
				return { runId: input.runId, status: 'retrying' as const };
			}

			// No active dispatch — reconstruct from the run row's stored payload.
			if (!run.jobPayload) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Cannot retry run "${input.runId}" — it was created without a job payload.`,
				});
			}
			const job = reconstructRetryJob(
				run.jobPayload,
				run.id,
				run.phase,
				input.cli,
				input.model,
				input.reasoning,
				startFresh,
				recoveryMode,
				run.recovery?.agentSessionId ?? run.agentSessionId,
			);
			try {
				await createAndPublishDispatch({
					projectId: run.projectId,
					jobPayload: job,
					priority: priorityFor(job) ?? 0,
					source: 'manual',
					waitReason: 'manual-retry',
					runId: run.id,
					taskId: run.taskId,
					phase: run.phase as TriggerPhase,
				});
			} catch (err) {
				const message = describeError(err);
				// The one-active-dispatch-per-run unique index: a concurrent retry won.
				if (message.includes('uq_dispatches_active_run') || message.includes('duplicate key')) {
					throw alreadyRetrying();
				}
				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to create the retry dispatch: ${message}`,
				});
			}

			return { runId: input.runId, status: 'retrying' as const };
		}),

	// Terminate a running or deferred run ("Terminate", issue #166).
	//
	// The dashboard and worker are separate processes, so this never touches a
	// PID: it records a durable, run-id-keyed cancellation request in Redis
	// (`requestRunCancellation`) and notifies the worker, then handles the two
	// live states:
	//
	//  - `running`: the worker is executing the agent. The published notification
	//    (and, failing that, the worker's own start-check against the durable set)
	//    aborts the run via its `AbortSignal`, and the phase settles the row as
	//    `failed` with the user-termination reason. We don't write the row here —
	//    the worker owns an in-flight run's terminal state — so we report
	//    `terminating` and let the UI poll for the settle.
	//
	//  - `deferred`: no agent is running; a delayed BullMQ retry job is waiting.
	//    Remove that job so nothing resurrects the run, then atomically flip the
	//    row `deferred → failed`. If that conditional loses to a concurrent
	//    automatic pickup (the row is now `running`), we fall through to the
	//    running case — the flag we already set makes the worker terminate it.
	//
	// Idempotent and race-safe: a run that already settled (`completed`/`failed`)
	// returns its current state rather than erroring, so a second click or a
	// settle-during-terminate can't terminate a different run or double-act.
	// Keyed on the immutable run id, so a later retry of the same task is never
	// caught by this request.
	terminate: authedProcedure
		.input(z.object({ runId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const run = await getRunByIdFromDb(input.runId);
			if (!run) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Run with ID "${input.runId}" not found`,
				});
			}
			// Terminating a run is a `member`+ action on its project.
			await assertProjectAccess(
				ctx.user,
				run.projectId,
				'member',
				`Run with ID "${input.runId}" not found`,
			);

			// Already terminal — nothing to terminate; report its settled state so a
			// second click (or a run that finished as we clicked) is a no-op, not an
			// error. Only `running`/`deferred` runs are actionable.
			if (run.status === 'completed' || run.status === 'failed') {
				return { runId: run.id, status: run.status };
			}

			// Durably record the intent and notify the worker before doing anything
			// else, so a pickup that races the branches below still sees it. This is
			// the one supported termination action, so its origin is always
			// recorded (issue #308) — `source: 'dashboard'`. `actor` stays absent:
			// tRPC has no auth context today (`src/api/trpc.ts`), so no identity is
			// available at this boundary to record.
			const origin: CancellationOrigin = {
				source: 'dashboard',
				requestedAt: new Date().toISOString(),
			};
			await requestRunCancellation(run.id, origin);

			if (run.status === 'deferred') {
				// Cancel the canonical dispatch and fail the row atomically while still deferred (issue #284).
				// Preserves session info and payload for future recovery retry (issue #306).
				const res = await cancelDeferredRunInDb(run.id, RUN_CANCELLED_MESSAGE, origin);
				if (res.success) {
					if (res.dispatch) {
						await removePendingJobById(wakeJobId(res.dispatch)).catch(() => false);
					}
					// The claim landed while still deferred, so no agent is (or can become)
					// active for this run — reconcile its checkout now (issue #361). A
					// deferred run never held the worktree lease itself, so a present lease
					// means a *different* live run owns the checkout: keep it as
					// `live-leased`. A preserved session keeps the checkout for resume
					// (recorded by `cancelDeferredRunInDb`); with no session, a clean,
					// pushed, unleased checkout is removed and anything else is retained.
					await reconcileDeferredTermination(
						run.id,
						run.projectId,
						run.taskId,
						res.preservedSession,
					);
					return { runId: run.id, status: 'failed' as const };
				}
				// Report its current state — the flag we set drives the worker to
				// terminate it if it's running.
				const latest = await getRunByIdFromDb(run.id);
				if (latest && (latest.status === 'failed' || latest.status === 'completed')) {
					return { runId: run.id, status: latest.status };
				}
				return { runId: run.id, status: 'terminating' as const };
			}

			// `running`: the worker aborts the agent and settles the row.
			return { runId: run.id, status: 'terminating' as const };
		}),

	// Reset and restart a wedged run ("Reset & restart", issue #424).
	//
	// The last-resort action for a run that neither "Retry now" nor "Terminate"
	// can move because its dispatch, Redis cancellation flag, worktree lease, and
	// recovery record disagree — the state that today needs manual DB and git
	// surgery. It cancels the active dispatch, clears the cancellation flag, tears
	// down the checkout and its lease, clears the recovery record, and re-dispatches
	// the same row from its stored payload with a fresh agent session. It is the
	// only action able to release a **stale** `live-leased` lease (one no live run
	// owns) and, with `force`, to discard a dirty/unpushed checkout.
	//
	// `force` additionally allows resetting a `running` run and cancelling a
	// dispatch a worker already claimed. It cannot stop an already-spawned agent
	// process (only Terminate does), so it stays an explicit operator choice.
	//
	// The sequence itself lives in `src/dispatch/run-reset.ts` so the CLI can call
	// it without tRPC context; this procedure only authorizes and maps refusals.
	reset: authedProcedure
		.input(z.object({ runId: z.string().min(1), force: z.boolean().default(false) }))
		.mutation(async ({ ctx, input }) => {
			// Resolved here for authorization only — the service re-reads the row.
			const run = await getRunByIdFromDb(input.runId);
			if (!run) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Run with ID "${input.runId}" not found`,
				});
			}
			// Resetting a run is a drive-the-run action: `member`+, like retry/terminate.
			await assertProjectAccess(
				ctx.user,
				run.projectId,
				'member',
				`Run with ID "${input.runId}" not found`,
			);

			try {
				return await resetRun(input.runId, { force: input.force });
			} catch (error) {
				if (error instanceof RunResetError) {
					throw new TRPCError({ code: RESET_REFUSAL_CODES[error.reason], message: error.message });
				}
				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to reset run "${input.runId}": ${describeError(error)}`,
				});
			}
		}),

	// Put back action for queued work items (issues #251, #284).
	// Cancels a waiting dispatch (the canonical record — nothing can resurrect
	// it afterwards) and moves its linked card back to backlog.
	putBack: authedProcedure
		.input(
			z.object({
				/** The dispatch id shown by `runs.queued` as `jobId`. */
				jobId: z.string().min(1),
				projectId: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Putting a queued item back is a `member`+ action on its project; a
			// non-member gets NOT_FOUND before the project is even resolved.
			await assertProjectAccess(ctx.user, input.projectId, 'member');
			const project = await getProjectByIdFromDb(input.projectId);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}

			const dispatch = await getDispatchById(input.jobId);
			if (!dispatch) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Queued dispatch with ID "${input.jobId}" not found`,
				});
			}
			if (dispatch.state !== 'pending' && dispatch.state !== 'retry-scheduled') {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Dispatch "${input.jobId}" is ${dispatch.state} and cannot be put back.`,
				});
			}
			const parsedJob = SwarmJobSchema.safeParse(dispatch.jobPayload);
			if (!parsedJob.success) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Dispatch "${input.jobId}" has an invalid stored payload.`,
				});
			}
			const jobData: SwarmJob = parsedJob.data;

			const phaseHint = deriveQueuedPhaseHint(jobData);
			if (phaseHint !== 'board' && phaseHint !== 'review') {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Job phase hint "${phaseHint}" is not supported for Put back.`,
				});
			}

			let workItemNodeId: string | undefined;
			const pmManifest = getPMProvider(project.pm.type);
			if (!pmManifest) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `PM Provider for type "${project.pm.type}" not found`,
				});
			}
			const pm = pmManifest.createProvider(project);

			if (jobData.type === 'github-projects') {
				workItemNodeId = jobData.event.itemNodeId;
				const workItem = await pm.getWorkItem(workItemNodeId);
				if (!workItem.statusId) {
					throw new TRPCError({
						code: 'PRECONDITION_FAILED',
						message: `Work item has no status ID.`,
					});
				}
				const targetPhase = resolvePipelinePhaseForOptionId(
					project.githubProjects,
					workItem.statusId,
				);
				if (!targetPhase) {
					throw new TRPCError({
						code: 'PRECONDITION_FAILED',
						message: `Work item status does not start a Planning or Implementation phase.`,
					});
				}
			} else if (jobData.type === 'github') {
				const prNumber = jobData.event.workItemId;
				const repoFullName = jobData.event.repoFullName;
				if (prNumber && repoFullName) {
					const items = await pm.listWorkItems();
					const match = items.find(
						(item) =>
							item.url.endsWith(`/${repoFullName}/issues/${prNumber}`) ||
							item.url.endsWith(`/${repoFullName}/pull/${prNumber}`),
					);
					workItemNodeId = match?.id;
				}
			}

			if (!workItemNodeId) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Job has no linked board card.`,
				});
			}

			// Cancel the canonical dispatch *before* moving the card: once cancelled,
			// no wake-up or reconciliation can start the phase, so the card move can
			// never race a pickup. Losing the conditional cancel means a worker
			// claimed it in the meantime — surface that instead of moving the card
			// out from under a starting run.
			const cancelled = await cancelDispatchAndWake(
				dispatch.id,
				'Put back to Backlog from the dashboard',
			);
			if (!cancelled) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Dispatch "${input.jobId}" was picked up while putting it back — refresh to see its run.`,
				});
			}

			// Putting a board item back must silence its duplicate dispatches too
			// (issue #366), before the single card move below.
			if (jobData.type === 'github-projects') {
				await cancelDuplicateBoardDispatches(project.id, workItemNodeId, dispatch.id);
			}

			try {
				await pm.moveWorkItem(workItemNodeId, 'backlog');
			} catch (error) {
				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Dispatch cancelled, but moving the board card to backlog failed: ${error instanceof Error ? error.message : String(error)}`,
				});
			}

			return { success: true };
		}),
});
