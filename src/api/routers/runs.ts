import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { ProjectConfig } from '../../config/schema.js';
import {
	getActiveDispatchByRunId,
	getDispatchById,
	listActiveDispatchTaskRefs,
	listWaitingDispatches,
	reopenDispatchForManualRetry,
	WAITING_DISPATCH_STATES,
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
	isRetryPendingStatus,
	type ListRunsFilter,
	listRunsFromDb,
	listTaskActivitySince,
	recordRunCleanupBlocked,
} from '../../db/repositories/runsRepository.js';
import {
	listStalledDismissals,
	recordStalledDismissal,
} from '../../db/repositories/stalledDismissalsRepository.js';
import { getUserById } from '../../db/repositories/usersRepository.js';
import {
	cancelDispatchAndWake,
	createAndPublishDispatch,
	publishDispatchWakeUp,
} from '../../dispatch/dispatcher.js';
import {
	ForceReReviewError,
	type ForceReReviewRefusal,
	forceReReview,
} from '../../dispatch/force-re-review.js';
import {
	ITEM_ACTIVITY_LOOKBACK_MS,
	type ItemLivenessDismissal,
	type ItemLivenessPolicy,
	ItemLivenessUnitKindSchema,
	type StalledItem,
	toStalledItems,
} from '../../dispatch/item-liveness.js';
import { reconstructRetryJob } from '../../dispatch/retry-payload.js';
import { RunResetError, type RunResetRefusal, resetRun } from '../../dispatch/run-reset.js';
import { AgentCliSchema } from '../../harness/agent-cli.js';
import { ReasoningLevelSchema } from '../../harness/models.js';
import { getWorker, getWorkers } from '../../identity/worker-service.js';
import { getPMProvider } from '../../integrations/pm/registry.js';
import { requireProjectSCMProvider } from '../../integrations/scm/registry.js';
import { describeError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { type Checkpoint, resolveMaxContinuations } from '../../pipeline/checkpoint.js';
import { resolvePipelinePhaseForStatusKey } from '../../pm/pipeline.js';
import {
	type CancellationOrigin,
	clearRunCancellation,
	getRunCancellationOrigin,
	isRunCancellationRequested,
	RUN_CANCELLED_MESSAGE,
	requestRunCancellation,
} from '../../queue/cancellation.js';
import {
	normalizeStoredJobPayload,
	type RecoveryMode,
	type SwarmJob,
	SwarmJobSchema,
} from '../../queue/jobs.js';
import { priorityFor, removePendingJobById } from '../../queue/producer.js';
import {
	deriveDispatchPhaseHint,
	deriveQueuedPhaseHint,
	type QueuedBoardOutcome,
	type QueuedRun,
	toQueuedRuns,
} from '../../queue/queued-runs.js';
import type { SCMProvider } from '../../scm/types.js';
import type { TriggerPhase } from '../../triggers/types.js';
import { GitWorktreeManager } from '../../worker/git-worktree-manager.js';
import { reconcileTerminatedWorktree } from '../../worktree/termination-cleanup.js';
import { accessibleProjectScope, assertInstanceAdmin, assertProjectAccess } from '../authz.js';
import { authedProcedure, router } from '../trpc.js';

const QUEUED_WORK_ITEM_CACHE_TTL_MS = 30_000;

/**
 * What one board read established about a queued dispatch's backing card/PR.
 * `startsPhase` is a fact about the **card** — its current status maps to a
 * pipeline phase — which {@link resolveQueuedBoardOutcome} turns into a fact
 * about a *row* only where the card is still what decides that row's phase.
 */
interface QueuedWorkItemDetails {
	title?: string;
	url?: string;
	nodeId?: string;
	startsPhase?: boolean;
}

/**
 * The board read, cached per card/PR for {@link QUEUED_WORK_ITEM_CACHE_TTL_MS}.
 *
 * `readAt` is what keeps that window from turning a merely wrong label into a
 * *missing row* (issue #570): an entry cannot describe a dispatch enqueued after
 * it was written, so a card dragged to Todo a second after a `no-trigger` read
 * re-reads instead of inheriting that verdict and being filtered out of the queue
 * for the rest of the window.
 *
 * **A miss is cached too** — `details: null`, "the read ran and nothing backs this
 * row" (issue #735). It used to fall through uncached, which made the *common*
 * answer for an SCM row the one the window never covered: this endpoint is polled
 * every two seconds while anything is queued (`dashboard/src/lib/runs-refresh.ts`)
 * and enriches every row, so a pull request with no card on the board re-asked its
 * provider on every poll, forever. That is cheap on a GitHub board and expensive on
 * a Jira one, whose `findWorkItemForArtifact` is a documented bounded *scan* — the
 * board-budget failure issue #735 is about, reached from the other direction. A
 * *failed* read is still not cached: that is "unknown", not "nothing".
 */
const queuedWorkItemCache = new Map<
	string,
	{ expiresAt: number; readAt: number; details: QueuedWorkItemDetails | null }
>();

function queuedWorkItemCacheKey(item: QueuedRun): string | null {
	if (item.type === 'pm' && item.workItemNodeId) {
		return `${item.projectId}:${item.workItemNodeId}`;
	}
	if (item.type === 'scm' && item.prNumber) {
		return `${item.projectId}:${item.providerId ?? 'scm'}:${item.prNumber}`;
	}
	return null;
}

/**
 * The board outcome to report for `item`, given what the read established about
 * its card (issue #570) — `undefined` whenever nothing was proven about *this
 * row*, which is every case the filter must leave alone.
 *
 * Only a fresh, unresolved board dispatch is decided by the card's current
 * status, so the guards mirror the queue view's own board fold (`boardGroupKey`,
 * `dashboard/src/lib/queued-runs.ts`): a dispatch a worker already resolved a
 * phase for, and one that owns a run — a deferred Planning/Implementation retry,
 * whose card the Implementation phase itself moved to `inProgress` — are real
 * pending work the board no longer speaks for.
 */
function resolveQueuedBoardOutcome(
	item: QueuedRun,
	startsPhase: boolean | undefined,
): QueuedBoardOutcome | undefined {
	if (startsPhase === undefined) return undefined;
	if (item.type !== 'pm' || item.phaseHint !== 'board' || item.runId) return undefined;
	return startsPhase ? 'starts-phase' : 'no-trigger';
}

function withQueuedWorkItemDetails(item: QueuedRun, details: QueuedWorkItemDetails): QueuedRun {
	const boardOutcome = resolveQueuedBoardOutcome(item, details.startsPhase);
	return {
		...item,
		workItemTitle: details.title,
		workItemUrl: details.url,
		workItemNodeId: details.nodeId || item.workItemNodeId,
		...(boardOutcome ? { boardOutcome } : {}),
	};
}

async function resolveQueuedWorkItemDetails(
	item: QueuedRun,
	workItemNodeId: string,
): Promise<{ title?: string; url?: string; startsPhase: boolean } | null> {
	const project = await getProjectByIdFromDb(item.projectId);
	if (!project) return null;

	const manifest = getPMProvider(project.pm.type);
	if (!manifest) return null;

	const workItem = await manifest.createProvider(project).getWorkItem(workItemNodeId);
	// The provider already resolved its opaque native status into the canonical
	// pipeline key on the way out of the board read (ai/RULES.md §2).
	let startsPhase = false;
	if (workItem.statusKey) {
		const targetPhase = resolvePipelinePhaseForStatusKey(workItem.statusKey);
		if (targetPhase === 'planning' || targetPhase === 'implementation') {
			startsPhase = true;
		}
	}
	return {
		title: workItem.title || undefined,
		url: workItem.url || undefined,
		startsPhase,
	};
}

async function enrichQueuedWorkItem(item: QueuedRun): Promise<QueuedRun> {
	const cacheKey = queuedWorkItemCacheKey(item);
	if (!cacheKey) return item;

	const cached = queuedWorkItemCache.get(cacheKey);
	// A cached read describes only the dispatches that already existed when it was
	// taken (see `queuedWorkItemCache`). A cached miss leaves the row exactly as an
	// uncached miss does — untouched.
	if (cached && cached.expiresAt > Date.now() && cached.readAt >= Date.parse(item.enqueuedAt)) {
		return cached.details ? withQueuedWorkItemDetails(item, cached.details) : item;
	}

	try {
		// `undefined` is "no read happened" — no project on file, no manifest, an
		// unenrichable row — which is *unknown* rather than "nothing backs this row"
		// and so must not be cached, exactly like the failure the catch below handles.
		// `null` is the real, cacheable miss: the provider was asked and had no card.
		let details: QueuedWorkItemDetails | null | undefined;
		if (item.type === 'pm' && item.workItemNodeId) {
			const resolved = await resolveQueuedWorkItemDetails(item, item.workItemNodeId);
			if (resolved) {
				details = {
					title: resolved.title,
					url: resolved.url,
					nodeId: item.workItemNodeId,
					startsPhase: resolved.startsPhase,
				};
			}
		} else if (item.type === 'scm' && item.prNumber) {
			const project = await getProjectByIdFromDb(item.projectId);
			if (project) {
				const manifest = getPMProvider(project.pm.type);
				if (manifest) {
					const pm = manifest.createProvider(project);
					// The contract's one-card lookups, not a whole-board read filtered down to
					// one card (issue #735): this is a *lookup* — "which card backs this pull
					// request?" — and reading the board to answer it is what exhausted the
					// board credential's budget. Both artifact kinds are asked for, as the URL
					// match this replaced did; what keeps that from costing twice per poll on a
					// provider whose artifact lookup is a scan is that the miss is now cached
					// (see `queuedWorkItemCache`). `repo` is absent only on a dispatch enqueued
					// before it was recorded, where the URL suffix is all there is to go on —
					// and on a multi-repository project that suffix resolves against the
					// project's default repository entry, which is what `getProjectByIdFromDb`
					// scopes to. Cosmetic either way: a miss just leaves the row without its
					// card title.
					//
					// Called directly rather than through `findWorkItemForPullRequest`, whose
					// fail-open swallow is right for the automation gate and wrong here: it
					// would turn a transient provider failure into a `null` this then *caches*
					// as "nothing backs this row" for the whole window.
					const match = item.repo
						? ((await pm.findWorkItemForArtifact({
								repository: item.repo,
								kind: 'issue',
								number: item.prNumber,
							})) ??
							(await pm.findWorkItemForArtifact({
								repository: item.repo,
								kind: 'pullRequest',
								number: item.prNumber,
							})))
						: ((await pm.findWorkItemByUrlSuffix(`/issues/${item.prNumber}`)) ??
							(await pm.findWorkItemByUrlSuffix(`/pull/${item.prNumber}`)));
					details = match
						? { title: match.title || undefined, url: match.url || undefined, nodeId: match.id }
						: null;
				}
			}
		}

		if (details === undefined) return item;

		const readAt = Date.now();
		queuedWorkItemCache.set(cacheKey, {
			expiresAt: readAt + QUEUED_WORK_ITEM_CACHE_TTL_MS,
			readAt,
			details,
		});
		return details ? withQueuedWorkItemDetails(item, details) : item;
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

/**
 * The `runs.queued` response (issue #570). `items` is the queue — work that is
 * going to happen — and `noTrigger` carries the board dispatches this server's
 * own board read has already **proven** cannot start a phase, so no client has to
 * learn to hide them for itself and none can list them as pending work.
 *
 * The split is a *view*, not a lifecycle: every dispatch in either array is the
 * same row in the dispatch table, still claimed and settled exactly as before (a
 * `noTrigger` one settles as a no-trigger when a worker reaches it). Reported
 * rather than dropped because an accumulation of them is a real state — one
 * survived a router restart and was re-imported by the dispatch reconciler — so
 * the dashboard renders them as a collapsed, counted group.
 */
export interface QueuedRunsPage {
	items: QueuedRun[];
	noTrigger: QueuedRun[];
}

/**
 * Split enriched queue rows into {@link QueuedRunsPage}. Keys on the proven case
 * alone: a row whose board read failed, was unavailable, or doesn't decide its
 * phase carries no `boardOutcome` and stays in the default view — the enrichment
 * already fails open, and that behaviour has to survive the filter.
 */
function partitionQueuedRuns(items: QueuedRun[]): QueuedRunsPage {
	const page: QueuedRunsPage = { items: [], noTrigger: [] };
	for (const item of items) {
		if (item.boardOutcome === 'no-trigger') page.noTrigger.push(item);
		else page.items.push(item);
	}
	return page;
}

// `RunStatus`/`RunRow` are local (non-exported) types in the repository, so the
// router declares its own filter enums — keeping Zod the source of truth for the
// API boundary and rejecting garbage filter values before they reach the DB.
const RunStatusEnum = z.enum(['running', 'completed', 'failed', 'deferred', 'checkpointed']);
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

/**
 * How each reset refusal (`src/dispatch/run-reset.ts`) surfaces over tRPC. Only
 * two exist since issue #744 — nothing to reset, and a reset already under way —
 * because no other state may leave a run un-reset.
 */
const RESET_REFUSAL_CODES: Record<RunResetRefusal, TRPCError['code']> = {
	'run-not-found': 'NOT_FOUND',
	'already-resetting': 'CONFLICT',
};

/** How each force refusal (`src/dispatch/force-re-review.ts`) surfaces over tRPC. */
const FORCE_RE_REVIEW_REFUSAL_CODES: Record<ForceReReviewRefusal, TRPCError['code']> = {
	'run-not-found': 'NOT_FOUND',
	'project-not-found': 'PRECONDITION_FAILED',
	'respond-to-review-disabled': 'PRECONDITION_FAILED',
	'not-capped': 'PRECONDITION_FAILED',
	'missing-coordinates': 'PRECONDITION_FAILED',
	'missing-review-record': 'PRECONDITION_FAILED',
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
	const duplicates = siblings.filter((sibling) => {
		const payload = normalizeStoredJobPayload(sibling.jobPayload);
		return (
			sibling.id !== keepDispatchId &&
			!sibling.runId &&
			payload.type === 'pm' &&
			payload.event.itemId === workItemNodeId &&
			deriveDispatchPhaseHint(sibling) === 'board'
		);
	});
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
 *
 * `repository` is the run's own (`runs.repository`), so the worktree manager is built
 * from the repository entry the run actually held rather than the project's default
 * one (issue #684 phase 2) — a project spanning several repositories has a distinct
 * `baseBranch`/`branchPrefix` per entry. A repository the project no longer owns
 * throws out of the read into the same best-effort catch as everything else here.
 */
async function reconcileDeferredTermination(
	runId: string,
	projectId: string,
	repository: string,
	taskId: string,
	preservedSession: string | null,
): Promise<void> {
	try {
		const project = await getProjectByIdFromDb(projectId, repository);
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

/**
 * Display labels for the worker that executed a run and the SWARM user who owns
 * it (ADR-004 §4, issue #446) — the read side of the attribution the row records
 * at dispatch. Ids are carried alongside the names so the UI can fall back to an
 * id when a name no longer resolves.
 */
export interface RunAttribution {
	workerId: string | null;
	workerName: string | null;
	userId: string | null;
	userDisplayName: string | null;
}

/**
 * Resolve a run's recorded worker/user into display labels, or `null` when the
 * row records no attribution at all — an unfederated run, and every row written
 * before the columns existed.
 *
 * Each field is named explicitly rather than spreading a worker/user row, the
 * same way `assembleDashboardWorker` assembles its dashboard view
 * (`src/identity/worker-enrollment-service.ts`): no credential hash and no
 * config may ride along on a run payload.
 *
 * `workerUserId ?? worker.ownerUserId`: a run dispatched before phase 1/2 of
 * issue #398 has a `worker_id` but no `worker_user_id`, so the worker row's
 * current owner is the best attribution available for it.
 *
 * A failed lookup degrades to null names rather than throwing — a deleted worker
 * or user must not turn the run detail page into an error.
 */
async function resolveRunAttribution(run: {
	workerId: string | null;
	workerUserId: string | null;
}): Promise<RunAttribution | null> {
	if (!run.workerId && !run.workerUserId) return null;
	try {
		const worker = run.workerId ? await getWorker(run.workerId) : undefined;
		const userId = run.workerUserId ?? worker?.ownerUserId ?? null;
		const user = userId ? await getUserById(userId) : undefined;
		return {
			workerId: run.workerId,
			workerName: worker?.displayName ?? null,
			userId,
			userDisplayName: user?.displayName ?? null,
		};
	} catch (error) {
		logger.warn('runs.getById: attribution lookup failed; reporting ids without names', {
			workerId: run.workerId,
			workerUserId: run.workerUserId,
			error: describeError(error),
		});
		return {
			workerId: run.workerId,
			workerName: null,
			userId: run.workerUserId,
			userDisplayName: null,
		};
	}
}

/**
 * The machine a run's preserved checkout is on, resolved to a display label
 * (issue #567) — the read side of `recovery.preservedWorkerId`, and of the
 * `abandonedWorkerId` an operator's "Reset & restart" leaves in its place.
 *
 * Exactly one of the two is reported, `preserved` taking precedence: a run either
 * still holds machine-local state or has given it up, never both at once.
 */
export interface RunPreservedWorker {
	state: 'preserved' | 'abandoned';
	workerId: string;
	/** Null when the worker row no longer resolves — the UI then falls back to the id. */
	workerName: string | null;
	/**
	 * Whether the run is *currently* blocked on that machine, rather than merely
	 * pinned to it. Read from the active dispatch's `preserved-worker` wait reason,
	 * because the two are genuinely different states and only one of them is the
	 * unbounded wait: an ordinary rate-limit deferral also preserves its checkout
	 * and records a machine, but its retry fires on a timer. Saying "this wait does
	 * not time out" about that one would be false, so the UI keys its copy on this
	 * rather than on the run's status.
	 */
	waiting: boolean;
}

/**
 * Resolve the run's recorded preserved/abandoned machine into a display label, or
 * `null` when it records neither (every run that never preserved a checkout, and
 * every row written before issue #567).
 *
 * This is what lets a run *say which machine it is waiting for*, to every viewer,
 * for as long as it waits — the wait is unbounded by design, so it must never read
 * as a wedged run. Resolved server-side like every other display label here, and a
 * failed lookup degrades to a null name (and to "not waiting", the weaker claim)
 * rather than throwing.
 */
async function resolveRunPreservedWorker(run: {
	id: string;
	recovery: { preservedWorkerId?: string | null; abandonedWorkerId?: string | null } | null;
}): Promise<RunPreservedWorker | null> {
	const preserved = run.recovery?.preservedWorkerId ?? null;
	const abandoned = run.recovery?.abandonedWorkerId ?? null;
	const workerId = preserved ?? abandoned;
	if (!workerId) return null;
	const state = preserved ? 'preserved' : 'abandoned';
	try {
		const [worker, dispatch] = await Promise.all([
			getWorker(workerId),
			// Only a still-pinned run can be waiting on its pin; an abandoned record is
			// history and never queries the queue.
			preserved ? getActiveDispatchByRunId(run.id) : Promise.resolve(undefined),
		]);
		return {
			state,
			workerId,
			workerName: worker?.displayName ?? null,
			waiting: dispatch?.waitReason === 'preserved-worker',
		};
	} catch (error) {
		logger.warn('runs.getById: preserved-worker lookup failed; reporting the id without a name', {
			workerId,
			error: describeError(error),
		});
		return { state, workerId, workerName: null, waiting: false };
	}
}

/**
 * Label a page of runs with the display name of the worker machine that
 * executed each one (issue #523) — the list-shaped counterpart to
 * {@link resolveRunAttribution}, which `getById` resolves for the detail view.
 * A run row records only the worker's id, and the dashboard must not have to
 * join a separate roster query to turn it into a machine name, so the name is
 * resolved here the same way every other server-resolved display label is.
 *
 * One batched read per page over the *distinct* recorded ids, so a full page
 * costs a single query rather than one per row. A run with no recorded worker
 * (unfederated, and every row predating the columns), a worker whose row no
 * longer resolves, and a failed lookup all yield `null`: the UI then shows no
 * machine at all rather than a stale or invented one.
 */
async function withWorkerNames<T extends { workerId: string | null }>(
	rows: T[],
): Promise<(T & { workerName: string | null })[]> {
	const ids = [...new Set(rows.map((row) => row.workerId).filter((id) => id !== null))];
	let names = new Map<string, string>();
	if (ids.length > 0) {
		try {
			names = new Map((await getWorkers(ids)).map((worker) => [worker.id, worker.displayName]));
		} catch (error) {
			logger.warn('runs.list: worker-name lookup failed; listing runs without machine names', {
				error: describeError(error),
			});
		}
	}
	return rows.map((row) => ({
		...row,
		workerName: row.workerId ? (names.get(row.workerId) ?? null) : null,
	}));
}

/** {@link listRunsFromDb}, with each row's executing machine named (issue #523). */
async function listRunsWithWorkerNames(filter: ListRunsFilter) {
	const { data, total } = await listRunsFromDb(filter);
	return { data: await withWorkerNames(data), total };
}

/**
 * The checkpoint-continuation budget that bounds this run's Tier 2 fallback
 * (issue #504) — the project's `pipeline.maxContinuations`, or the coded default
 * ({@link resolveMaxContinuations}). Resolved server-side, so the dashboard can
 * show the spent `continuationCount` against its ceiling without re-declaring
 * that default in the web bundle where it would go stale.
 *
 * Only a row that actually carries a checkpoint has a budget worth reporting, so
 * every other run skips the project read entirely — the same shape
 * {@link resolveRunAttribution} uses for a run with no recorded worker. Returns
 * `null` when the project no longer resolves or the read throws, so the panel
 * shows the spent count alone rather than a fabricated ceiling.
 */
async function resolveContinuationBudget(run: {
	projectId: string;
	checkpoint: Checkpoint | null;
}): Promise<number | null> {
	if (!run.checkpoint) return null;
	try {
		const project = await getProjectByIdFromDb(run.projectId);
		return project ? resolveMaxContinuations(project) : null;
	} catch (error) {
		logger.warn('runs.getById: continuation-budget lookup failed; reporting the count alone', {
			projectId: run.projectId,
			error: describeError(error),
		});
		return null;
	}
}

/**
 * An accepted operator request against a run that has not taken effect yet
 * (issue #561) — the durable, run-scoped answer to "is something outstanding?"
 * that the dashboard's Terminate / Reset & restart buttons need in order to
 * disable themselves and say what is being waited for.
 *
 * Both actions record their intent and return long before anything observable
 * happens (a cancellation waits for the worker to notice and unwind; a restart
 * waits for a worker to claim the replacement dispatch), so the mutation's own
 * `isPending` covers only the HTTP round-trip. Derived here from facts that
 * already exist and are already written at request time, so the state survives a
 * reload and is identical for every viewer of the run.
 */
export interface PendingRunRequest {
	action: 'terminate' | 'restart';
	/** ISO 8601 — when the request was recorded; null when only the bare marker exists. */
	requestedAt: string | null;
	/** ISO 8601 upper bound of the wait, when the run records one; null otherwise. */
	waitUntil: string | null;
}

/**
 * The accepted-but-not-yet-effective request outstanding against `run`, or
 * `null` when there is none (issue #561). Derived, never stored — the two
 * durable facts it reads are written by the request paths themselves:
 *
 *  - **terminate**, for a `running` run: the run-id-keyed Redis cancellation
 *    marker `runs.terminate` writes ({@link requestRunCancellation}). Gating on
 *    `running` is what clears the pending state when the worker settles the row,
 *    even if a stale marker outlives it, and keeps a phantom wait off the two
 *    retry-pending statuses that `terminate` settles synchronously.
 *  - **restart**, for a run that is not running: its active dispatch, when that
 *    dispatch is still *waiting* and was opened as a `manual-retry` — the wait
 *    reason `resetRun`/`retryNow` record and nothing automatic does. Narrowing
 *    to {@link WAITING_DISPATCH_STATES} clears the pending state as soon as a
 *    worker claims the restart; the wait-reason check is what keeps an ordinary
 *    `deferred` run's scheduled auto-retry from reading as an operator request
 *    and permanently disabling the button meant to unwedge it.
 *
 * Only the status that can have one issues a read, so a `completed` run's poll
 * costs nothing extra. Fails soft to `null`: a Redis or dispatch read that
 * throws must show the run without a fabricated wait, never fail the page.
 */
async function resolvePendingRunRequest(run: {
	id: string;
	status: string;
	startedAt: Date;
	timeoutMs: number | null;
}): Promise<PendingRunRequest | null> {
	try {
		if (run.status === 'running') {
			if (!(await isRunCancellationRequested(run.id))) return null;
			const origin = await getRunCancellationOrigin(run.id);
			// The run's own agent timeout is the bound the operator can see. It is an
			// outer bound, not the settle instant — the control plane adds its own
			// result-wait margin on the transport path — and a run without one
			// reports no bound rather than a guessed one.
			const waitUntil =
				run.timeoutMs && run.timeoutMs > 0
					? new Date(run.startedAt.getTime() + run.timeoutMs).toISOString()
					: null;
			return {
				action: 'terminate',
				requestedAt: origin?.requestedAt ?? null,
				waitUntil,
			};
		}
		if (run.status === 'completed') return null;
		const dispatch = await getActiveDispatchByRunId(run.id);
		if (!dispatch || dispatch.waitReason !== 'manual-retry') return null;
		if (!(WAITING_DISPATCH_STATES as readonly string[]).includes(dispatch.state)) return null;
		return {
			action: 'restart',
			requestedAt: dispatch.updatedAt.toISOString(),
			waitUntil: null,
		};
	} catch (error) {
		logger.warn('runs.getById: pending-request lookup failed; reporting no outstanding request', {
			runId: run.id,
			error: describeError(error),
		});
		return null;
	}
}

/**
 * The two project policies the liveness classification consults, read exactly as
 * the pipeline itself reads them (issue #840): Planning's `autoAdvance` is off
 * unless set (`DEFAULT_AUTO_ADVANCE`, `src/pipeline/planning.ts`) and merge
 * automation is opt-in (`src/worker/consumer.ts`). A project that no longer
 * resolves gets those same defaults rather than an exception — a stalled-work view
 * that throws because one project row went missing is worse than one that reports
 * that project under the pipeline's own defaults.
 */
function itemLivenessPolicyFor(project: ProjectConfig | undefined): ItemLivenessPolicy {
	return {
		planningAutoAdvance: project?.pipeline?.planning?.autoAdvance === true,
		autoMerge: project?.pipeline?.respondToReview?.autoMerge === true,
	};
}

/**
 * Narrow the stored dismissal rows onto the read model's own input shape (issue
 * #880). `stalled_dismissals.unit` is `text` — the enum lives in
 * `ItemLivenessUnitKindSchema`, not in Postgres — so a row naming a kind this build
 * does not know is dropped rather than handed on: it can only ever *suppress* a
 * row, and suppressing on an unreadable key is worse than reporting the unit.
 */
function toLivenessDismissals(
	rows: readonly {
		projectId: string;
		repository: string;
		unit: string;
		reference: string;
		lastActivityAt: Date;
	}[],
): ItemLivenessDismissal[] {
	const dismissals: ItemLivenessDismissal[] = [];
	for (const row of rows) {
		const unit = ItemLivenessUnitKindSchema.safeParse(row.unit);
		if (!unit.success) continue;
		dismissals.push({ ...row, unit: unit.data });
	}
	return dismissals;
}

/**
 * Fill each `pull-request` stalled row's `prUrl` with the **provider's own** web
 * URL for that pull request, so the dashboard links a stalled PR out without
 * assembling a URL of its own — which is how a GitLab or Bitbucket project's rows
 * ended up pointing at `github.com`.
 *
 * The repository is the row's own (issue #683), not `project.repo`: a project may
 * span several repositories, and the stalled row already records which one the run
 * acted on. The lookup is a registry lookup on `project.scm`
 * (`requireProjectSCMProvider`) and the method it calls is pure, so this adds no
 * request and no per-row I/O to a procedure that deliberately touches nothing but
 * Postgres.
 *
 * A project that resolves no runtime-ready provider — unregistered id, or an
 * unmigrated project naming no `scm` — leaves `prUrl` unset and is logged once per
 * project rather than throwing: the stalled view's job is to report work nobody is
 * looking at, and losing the whole report over one project's configuration would
 * hide exactly the rows an operator needs.
 */
function withPullRequestUrls(
	items: StalledItem[],
	projects: Map<string, ProjectConfig>,
): StalledItem[] {
	const urlForProject = new Map<string, SCMProvider['pullRequestUrl'] | null>();
	const resolve = (projectId: string): SCMProvider['pullRequestUrl'] | null => {
		const cached = urlForProject.get(projectId);
		if (cached !== undefined) return cached;
		const project = projects.get(projectId);
		let resolved: SCMProvider['pullRequestUrl'] | null = null;
		if (project) {
			try {
				const provider = requireProjectSCMProvider(project);
				resolved = provider.pullRequestUrl.bind(provider);
			} catch (error) {
				logger.warn(
					'runs.stalled: no source-control provider resolved; listing that project’s pull requests unlinked',
					{ projectId, error: describeError(error) },
				);
			}
		}
		urlForProject.set(projectId, resolved);
		return resolved;
	};

	return items.map((item) => {
		if (item.unit !== 'pull-request' || !item.prNumber) return item;
		const pullRequestUrl = resolve(item.projectId);
		if (!pullRequestUrl) return item;
		return { ...item, prUrl: pullRequestUrl(item.repository, item.prNumber) };
	});
}

export const runsRouter = router({
	// Paginated, filtered list; returns { data, total } from the repo, each row
	// widened with the additive, server-resolved `workerName` naming the machine
	// that executed it (issue #523 — see `withWorkerNames`). The name is resolved
	// only after the access check below, so a non-member never triggers an
	// identity read.
	// Project-scoped (#281 task 4): an explicit `projectId` filter requires read
	// access to that project, so a non-member never sees another project's runs.
	// Without one this is the cross-project list behind the global /runs screen,
	// open to **every** signed-in user since issue #821 and bounded to what each
	// one may see: an instance administrator reads the whole installation
	// unfiltered (`accessibleProjectScope` → `null`), and anyone else reads only
	// the projects they are a member of. A user who belongs to no project gets an
	// empty page rather than a denial — an empty scope would otherwise widen the
	// query back to every project, so it short-circuits without querying at all.
	list: authedProcedure.input(ListRunsInputSchema).query(async ({ ctx, input }) => {
		if (input.projectId) {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			return await listRunsWithWorkerNames(input);
		}
		const scope = await accessibleProjectScope(ctx.user);
		if (scope === null) return await listRunsWithWorkerNames(input);
		if (scope.length === 0) return { data: [], total: 0 };
		return await listRunsWithWorkerNames({ ...input, projectIds: scope });
	}),

	// Every canonical waiting dispatch (pending / capacity-blocked /
	// retry-scheduled) — the durable queue read model (issues #234, #284), never
	// a BullMQ snapshot, so nothing pending can be invisible here. No pagination:
	// the pending set is small and bounded by worker throughput. A chosen
	// `projectId` needs read access, exactly like `list`; the unscoped,
	// installation-wide queue remains an instance administrator's view (issue
	// #647) and was deliberately left there when issue #821 opened the unscoped
	// `list` to every member — the queue is an operator's dispatch view, and
	// giving it the same membership scoping is its own change.
	//
	// Returns the two-part {@link QueuedRunsPage}: the queue itself, and the board
	// dispatches the enrichment's own board read proved cannot start a phase
	// (issue #570), reported separately instead of listed as pending work.
	queued: authedProcedure
		.input(z.object({ projectId: z.string().min(1).optional() }).optional())
		.query(async ({ ctx, input }): Promise<QueuedRunsPage> => {
			if (input?.projectId) {
				await assertProjectAccess(ctx.user, input.projectId, 'contributor');
				const project = await getProjectByIdFromDb(input.projectId);
				const policy = project?.pipeline?.prioritizeContinuations !== false;
				const policies = { [input.projectId]: policy };
				return partitionQueuedRuns(
					await enrichQueuedWorkItems(
						toQueuedRuns(await listWaitingDispatches(input.projectId), policies),
					),
				);
			}
			assertInstanceAdmin(ctx.user, 'queue');
			const dispatches = await listWaitingDispatches(input?.projectId);
			const projects = await listAllProjectsFromDb();
			const policies = Object.fromEntries(
				projects.map((p) => [p.id, p.pipeline?.prioritizeContinuations !== false]),
			);
			return partitionQueuedRuns(await enrichQueuedWorkItems(toQueuedRuns(dispatches, policies)));
		}),

	// The item-centric read model (issue #840) — the third one beside Queue
	// (dispatch-centric) and Runs (run-centric). It folds `runs` and `dispatches`
	// onto the unit an operator recognises (a pull request, a board card) and
	// reports the units with no forward path. The whole decision lives in the pure
	// `src/dispatch/item-liveness.ts`; this procedure only supplies the three bounded
	// reads and the per-project policy map, and touches nothing but Postgres — no
	// provider call, no cache, no enrichment, unlike `queued`.
	//
	// "Stalled" is a computed view, never a persisted status: nothing here writes,
	// and a unit stays listed until it moves, is dismissed by an operator
	// ({@link runsRouter.dismissStalled}, issue #880), or ages out of the lookback
	// window.
	//
	// Authorization is `queued`'s shape verbatim, so no new access decision is made
	// here: a chosen `projectId` needs read access, and the unscoped,
	// installation-wide view remains an instance administrator's.
	stalled: authedProcedure
		.input(z.object({ projectId: z.string().min(1).optional() }).optional())
		.query(async ({ ctx, input }): Promise<StalledItem[]> => {
			const since = new Date(Date.now() - ITEM_ACTIVITY_LOOKBACK_MS);
			if (input?.projectId) {
				await assertProjectAccess(ctx.user, input.projectId, 'contributor');
				const project = await getProjectByIdFromDb(input.projectId);
				const projectIds = [input.projectId];
				const [activity, activeDispatches, dismissals] = await Promise.all([
					listTaskActivitySince({ since, projectIds }),
					listActiveDispatchTaskRefs(projectIds),
					listStalledDismissals({ since, projectIds }),
				]);
				return withPullRequestUrls(
					toStalledItems(
						activity,
						activeDispatches,
						{ [input.projectId]: itemLivenessPolicyFor(project) },
						toLivenessDismissals(dismissals),
					),
					new Map(project ? [[project.id, project]] : []),
				);
			}
			assertInstanceAdmin(ctx.user, 'stalled work');
			const [activity, activeDispatches, projects, dismissals] = await Promise.all([
				listTaskActivitySince({ since }),
				listActiveDispatchTaskRefs(),
				listAllProjectsFromDb(),
				listStalledDismissals({ since }),
			]);
			const policies = Object.fromEntries(
				projects.map((project) => [project.id, itemLivenessPolicyFor(project)]),
			);
			return withPullRequestUrls(
				toStalledItems(activity, activeDispatches, policies, toLivenessDismissals(dismissals)),
				new Map(projects.map((project) => [project.id, project])),
			);
		}),

	// Single run by id; NOT_FOUND when unknown or when the caller is not a member
	// of the run's project (existence hidden with identical run-not-found message).
	// The row is returned as-is — including the persisted Tier 2 `checkpoint` and
	// `continuationCount` (issue #503) the detail page's checkpoint panel renders —
	// plus four additive, server-resolved fields: an `attribution` object resolving
	// the recorded worker/user to display labels (issue #446), the
	// `maxContinuations` ceiling that count reads against (issue #504), the
	// `pendingRequest` naming an accepted Terminate/Reset request that hasn't taken
	// effect yet (issue #561 — the Redis cancellation marker for a `running` run, the
	// run's waiting `manual-retry` dispatch otherwise), and the `preservedWorker`
	// naming the machine that holds (or has had discarded) this run's preserved
	// checkout (issue #567). All four are looked up only after the access check, so a
	// non-member never triggers an identity, project, or queue read.
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
			return {
				...run,
				attribution: await resolveRunAttribution(run),
				maxContinuations: await resolveContinuationBudget(run),
				pendingRequest: await resolvePendingRunRequest(run),
				preservedWorker: await resolveRunPreservedWorker(run),
			};
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
			if (run.status !== 'deferred' && run.status !== 'failed' && run.status !== 'checkpointed') {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: `Only a deferred, checkpointed, or failed run can be retried; run "${input.runId}" is ${run.status}.`,
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
			let recoveryMode: RecoveryMode | undefined;
			if (isRecovery) {
				recoveryMode = applyingOverride ? 'fresh' : 'resume';
				startFresh = applyingOverride;
			}
			// A `checkpointed` run's preserved checkout is adopted on the strength of its
			// Tier 2 checkpoint, never a session (issue #503) — and a cli/model override is
			// compatible with that, since a continuation always runs a fresh session and is
			// CLI-agnostic by construction. Without this the manual retry would try to
			// provision over a deliberately preserved worktree and settle blocked.
			if (run.status === 'checkpointed') {
				recoveryMode = 'checkpoint';
				startFresh = false;
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
	//  - `running`: the published notification reaches the worker as a pushed
	//    `task-cancel` (`src/router/dispatch-cancellation.ts`, issue #549) and the
	//    worker answers it. If the phase is still executing there it aborts via its
	//    `AbortSignal` and settles the row `failed` with the user-termination reason;
	//    if it is *not* — it already finished, or this daemon restarted — the worker
	//    answers the frame with the same terminal cancelled result rather than
	//    ignoring it (issue #724), and re-reports the real outcome instead when it
	//    still holds one undelivered. Either way we don't write the row here: the
	//    worker owns an in-flight run's terminal state, and it is the only party that
	//    knows which of those two it is. So we report `terminating` and let the UI
	//    poll for a settle that now arrives within a round trip rather than at the
	//    `timeoutMs + RESULT_WAIT_MARGIN_MS` lease-window boundary.
	//
	//    The one case that still waits it out is a worker whose transport is down:
	//    nothing can be pushed to it, and the phase may genuinely still be executing
	//    there, so writing the row from here would take the terminal state away from
	//    its owner. Issue #719 settles the narrower, knowable case where a different
	//    daemon process succeeds a session; this remains the lease reconciler's
	//    backstop when no successor handshakes. Since issue #827 the router bounds
	//    the *quiet* end of that case on a liveness heuristic — a worker whose last
	//    heartbeat is older than `max(2 × SWARM_WORKER_HEARTBEAT_TTL_MS, 2m)`, well
	//    past its reconnect ladder — settling such a run about a minute later
	//    (`SWARM_OFFLINE_WORKER_CANCEL_TIMEOUT_MS`) rather than at the phase's agent
	//    timeout, and re-pushing the cancel instead if the worker turns up inside
	//    that minute. Still not from here, and still through the shared settle.
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

			// Both retry-pending statuses settle the same way (issue #503): a `checkpointed`
			// run has a waiting dispatch and no live agent, exactly like a `deferred` one.
			if (isRetryPendingStatus(run.status)) {
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
						run.repository,
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
	// the same row from its stored payload with a fresh agent session.
	//
	// It takes no options (issue #744): a reset always discards. It cancels a
	// dispatch a worker just claimed, removes the checkout with any uncommitted
	// changes and unpushed commits — including one on another worker, which honours
	// the `'discard'` intent the replacement dispatch carries — releases a **stale**
	// `live-leased` lease, and resets a `running` row without it being terminated
	// first — since issue #745 by stopping that row's agent itself, over the same
	// cancellation `terminate` records, and waiting for the run to leave `running`
	// before it tears anything down. A stop that never confirms is reported
	// (`agentStop: 'timed-out'`) and the restart happens anyway. A run that cannot be
	// re-dispatched at all comes back `outcome: 'terminated'` with the reason, not as
	// a refusal.
	//
	// The sequence itself lives in `src/dispatch/run-reset.ts` so the CLI can call
	// it without tRPC context; this procedure only authorizes and maps refusals.
	reset: authedProcedure
		.input(z.object({ runId: z.string().min(1) }))
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
				return await resetRun(input.runId);
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

	// Force a re-review past the review-verdict safety cap ("Force re-review",
	// issue #511).
	//
	// The recovery action for the one state the cap deliberately leaves stopped: a
	// completed Review run whose last permitted `request-changes` verdict set
	// `manual-intervention-required`, so no further Respond-to-review/re-review is
	// enqueued automatically. Invoking it grants the PR exactly one extra review
	// slot and enqueues the corrective Respond-to-review run; the normal pipeline
	// (response → follow-up Review) carries on from there unchanged.
	//
	// Authorized exactly like the comparable run-recovery action, "Reset &
	// restart": driving a run is `member`+ on its project, and a non-member gets
	// the same run-not-found shape rather than learning the run exists.
	//
	// The sequence lives in `src/dispatch/force-re-review.ts`, where its guards run
	// before any mutation and both writes are conditional (so repeated clicks and
	// concurrent requests resolve to one corrective cycle); this procedure only
	// authorizes and maps refusals.
	forceReReview: authedProcedure
		.input(z.object({ runId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			// Resolved here for authorization only — the service re-reads the row.
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
				'member',
				`Run with ID "${input.runId}" not found`,
			);

			try {
				return await forceReReview(input.runId);
			} catch (error) {
				if (error instanceof ForceReReviewError) {
					throw new TRPCError({
						code: FORCE_RE_REVIEW_REFUSAL_CODES[error.reason],
						message: error.message,
					});
				}
				throw new TRPCError({
					code: 'INTERNAL_SERVER_ERROR',
					message: `Failed to force a re-review for run "${input.runId}": ${describeError(error)}`,
				});
			}
		}),

	// Put back action for queued work items (issues #251, #284).
	// Dismiss one stalled liveness unit from the Stalled view (issue #880) — the
	// operator's way of forcing the age-out of a unit that is finished but whose
	// finish SWARM never recorded (a human merged the pull request, a human closed
	// the card), instead of waiting out the 30-day lookback window.
	//
	// The write is a record of the *dismissal*, never a status on the unit: it lands
	// in `stalled_dismissals`, keyed on the unit the operator sees, and `runs.stalled`
	// re-derives the suppression by comparison on every read. No `runs` row is
	// modified or deleted — this touches neither that table nor `dispatches`.
	//
	// **Authorization** is project-scoped at `member`, this router's uniform gate for
	// every mutation (`retryNow`, `terminate`, `reset`, `forceReReview`, `putBack`)
	// and the "drive a project's runs" row of the `src/api/authz.ts` matrix. It is
	// never weaker than the read it mirrors — viewing a project's stalled work is
	// `contributor` on that project, and the unscoped view an instance
	// administrator's — and deliberately stricter than a literal reading of the
	// acceptance criterion, because `contributor` is documented read-only and a
	// dismissal writes a durable row.
	//
	// **`lastActivityAt` is the client's, verbatim, and that is safe by construction.**
	// If a run landed between render and click, the stored instant is the *older* one,
	// the unit's current activity is already past it, and the row is reported again on
	// the next poll: a stale client under-suppresses and can never over-suppress.
	// Recomputing it server-side would cost a second `listTaskActivitySince` to reach
	// the same or a worse answer.
	dismissStalled: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				/** The row's own `owner/repo` — the unit key's second component. */
				repository: z.string().min(1),
				unit: ItemLivenessUnitKindSchema,
				/** The PR number for a `pull-request` unit, the task id for a `work-item` one. */
				reference: z.string().min(1),
				/** The `lastActivityAt` of the row the operator dismissed, verbatim. */
				lastActivityAt: z.string().datetime(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'member');
			// Resolved for its existence alone: the row carries an FK to `projects`, so
			// an instance administrator naming a bogus id gets a clear refusal here
			// rather than a raw constraint violation from Postgres.
			const project = await getProjectByIdFromDb(input.projectId);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}

			const { dismissedAt } = await recordStalledDismissal({
				projectId: input.projectId,
				repository: input.repository,
				unit: input.unit,
				reference: input.reference,
				lastActivityAt: new Date(input.lastActivityAt),
				dismissedBy: ctx.user.id,
			});
			return { dismissedAt: dismissedAt.toISOString() };
		}),

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

			if (jobData.type === 'pm') {
				workItemNodeId = jobData.event.itemId;
				const workItem = await pm.getWorkItem(workItemNodeId);
				if (!workItem.statusId) {
					throw new TRPCError({
						code: 'PRECONDITION_FAILED',
						message: `Work item has no status ID.`,
					});
				}
				// The provider resolved its native status into the canonical pipeline key
				// on the way out of the board read (ai/RULES.md §2); an unmapped status
				// carries none and simply starts no phase.
				const targetPhase = workItem.statusKey
					? resolvePipelinePhaseForStatusKey(workItem.statusKey)
					: undefined;
				if (!targetPhase) {
					throw new TRPCError({
						code: 'PRECONDITION_FAILED',
						message: `Work item status does not start a Planning or Implementation phase.`,
					});
				}
			} else if (jobData.type === 'scm') {
				const prNumber = jobData.event.workItemId;
				const repoFullName = jobData.event.repoFullName;
				if (prNumber && repoFullName) {
					// The contract's one-card lookup rather than a whole-board read (issue
					// #735). Called directly rather than through `findWorkItemForPullRequest`,
					// whose fail-open swallow is right for the automation gate and wrong here:
					// a provider error must surface, not read as "no linked board card".
					const match =
						(await pm.findWorkItemForArtifact({
							repository: repoFullName,
							kind: 'issue',
							number: prNumber,
						})) ??
						(await pm.findWorkItemForArtifact({
							repository: repoFullName,
							kind: 'pullRequest',
							number: prNumber,
						}));
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
			if (jobData.type === 'pm') {
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
