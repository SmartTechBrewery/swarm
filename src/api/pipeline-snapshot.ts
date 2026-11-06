/**
 * The pipeline snapshot and dispatch history read models (issue #1340) — what the
 * operator MCP server's `pipeline_snapshot` and `dispatch_history` tools return,
 * served by `runs.pipelineSnapshot` / `runs.dispatchHistory` (`./routers/runs.ts`),
 * which own the authorization. Everything here runs after that check and touches
 * Postgres only: no provider call, no board read, no cache.
 *
 * The snapshot is one project's whole pipeline state in one call — the runs still
 * moving (and those that failed in the window), every open dispatch, and how many
 * runs settled in the window by status — so a periodic guard can watch a project
 * without paging the runs list and the queue separately. Every list is bounded
 * ({@link PIPELINE_SNAPSHOT_ROW_LIMIT}, {@link DISPATCH_HISTORY_ROW_LIMIT}) and says
 * when the bound bit, rather than growing with a backlog.
 */

import {
	type DispatchHistoryFilter,
	type DispatchRow,
	listDispatchesForTask,
	listOpenDispatchesForProject,
} from '../db/repositories/dispatchesRepository.js';
import {
	countRunsSettledSinceByStatus,
	listSnapshotRunsForProject,
	type RunRow,
} from '../db/repositories/runsRepository.js';
import { getWorkers } from '../identity/worker-service.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { normalizeStoredJobPayload, repositoryForJob } from '../queue/jobs.js';
import { deriveDispatchPhaseHint, type QueuedPhaseHint } from '../queue/queued-runs.js';

/** The most runs, and separately the most open dispatches, one snapshot lists. */
export const PIPELINE_SNAPSHOT_ROW_LIMIT = 100;
/** The most dispatches one history lists — the newest ones, when there are more. */
export const DISPATCH_HISTORY_ROW_LIMIT = 200;
/** The snapshot's window when the caller names none. */
export const DEFAULT_SNAPSHOT_WINDOW_HOURS = 12;
/** The widest window a snapshot accepts: a week. Anything wider is statistics. */
export const MAX_SNAPSHOT_WINDOW_HOURS = 24 * 7;

const HOUR_MS = 60 * 60 * 1000;

/** One run as the snapshot reports it. Instants are ISO 8601. */
export interface SnapshotRun {
	id: string;
	kind: string;
	status: string;
	phase: string;
	repository: string | null;
	taskId: string | null;
	prNumber: string | null;
	/** The board card's or pull request's title, whichever the run recorded. */
	title: string | null;
	/** The machine that executed the run, by display name. */
	workerName: string | null;
	startedAt: string;
	completedAt: string | null;
	/** Milliseconds since the run started, as of `generatedAt`. */
	ageMs: number;
	continuationCount: number;
	error: string | null;
	nextRetryAt: string | null;
}

/** One dispatch as the snapshot and the history report it. Instants are ISO 8601. */
export interface SnapshotDispatch {
	id: string;
	state: string;
	/** The resolved phase, or the queue's best-effort hint before a claim resolved it. */
	phase: QueuedPhaseHint;
	repository: string | null;
	taskId: string | null;
	prNumber: string | null;
	waitReason: string | null;
	/** Terminal detail of a `completed` dispatch (`phase-succeeded`, `no-trigger`, …). */
	outcome: string | null;
	lastError: string | null;
	/** Deferred-retry attempts so far. */
	attempt: number;
	/** The run this dispatch's attempts executed against, once one exists. */
	runId: string | null;
	source: string;
	priority: number;
	/** The machine selected for the attempt, by display name. */
	workerName: string | null;
	createdAt: string;
	availableAt: string;
	completedAt: string | null;
	/** Milliseconds since the dispatch was created, as of `generatedAt`. */
	ageMs: number;
}

export interface PipelineSnapshot {
	projectId: string;
	generatedAt: string;
	windowHours: number;
	/** Every unsettled run, plus every run that failed in the window; newest first. */
	runs: SnapshotRun[];
	/** Every open dispatch (waiting or executing), in dispatch-intent order. */
	dispatches: SnapshotDispatch[];
	/** Runs settled in the window, by status; a status with none is absent. */
	completedCounts: { since: string; byStatus: Record<string, number> };
	/** Whether a list hit {@link PIPELINE_SNAPSHOT_ROW_LIMIT} and was cut. */
	truncated: { runs: boolean; dispatches: boolean };
}

export interface DispatchHistory {
	projectId: string;
	generatedAt: string;
	/** Every dispatch of the task or pull request, oldest first. */
	dispatches: SnapshotDispatch[];
	/** Whether older dispatches beyond {@link DISPATCH_HISTORY_ROW_LIMIT} were left out. */
	truncated: boolean;
}

/**
 * Display names for the machines `ids` name. Fails open — a lookup failure lists
 * the rows without names rather than failing a read whose point is diagnosis.
 */
async function workerNames(ids: (string | null)[]): Promise<Map<string, string>> {
	const unique = [...new Set(ids.filter((id): id is string => id !== null))];
	if (unique.length === 0) return new Map();
	try {
		return new Map((await getWorkers(unique)).map((worker) => [worker.id, worker.displayName]));
	} catch (error) {
		logger.warn('pipeline snapshot: worker-name lookup failed; listing rows without names', {
			error: describeError(error),
		});
		return new Map();
	}
}

function toSnapshotRun(run: RunRow, names: Map<string, string>, now: number): SnapshotRun {
	return {
		id: run.id,
		kind: run.kind,
		status: run.status,
		phase: run.phase,
		repository: run.repository,
		taskId: run.taskId,
		prNumber: run.prNumber,
		title: run.workItemTitle ?? run.prTitle,
		workerName: (run.workerId ? names.get(run.workerId) : undefined) ?? run.maintenanceMachine,
		startedAt: run.startedAt.toISOString(),
		completedAt: run.completedAt?.toISOString() ?? null,
		ageMs: Math.max(0, now - run.startedAt.getTime()),
		continuationCount: run.continuationCount,
		error: run.error,
		nextRetryAt: run.nextRetryAt?.toISOString() ?? null,
	};
}

/**
 * A dispatch's repository and pull request: the columns a claim resolved, else
 * what the stored job names — so a dispatch still waiting for its first claim
 * reports the artifact it is for, read through the same helper the worker scopes
 * its project with (`repositoryForJob`).
 */
function dispatchArtifact(dispatch: DispatchRow): {
	repository: string | null;
	prNumber: string | null;
} {
	const job = normalizeStoredJobPayload(dispatch.jobPayload);
	const jobPrNumber =
		job.type === 'scm'
			? job.event.workItemId
			: job.type === 'merge-automation'
				? job.prNumber
				: undefined;
	return {
		repository: dispatch.repository ?? repositoryForJob(job) ?? null,
		prNumber: dispatch.prNumber ?? jobPrNumber ?? null,
	};
}

function toSnapshotDispatch(
	dispatch: DispatchRow,
	names: Map<string, string>,
	now: number,
): SnapshotDispatch {
	return {
		id: dispatch.id,
		state: dispatch.state,
		phase: deriveDispatchPhaseHint(dispatch),
		...dispatchArtifact(dispatch),
		taskId: dispatch.taskId,
		waitReason: dispatch.waitReason,
		outcome: dispatch.outcome,
		lastError: dispatch.lastError,
		attempt: dispatch.attempt,
		runId: dispatch.runId,
		source: dispatch.source,
		priority: dispatch.priority,
		workerName: dispatch.selectedWorkerId ? (names.get(dispatch.selectedWorkerId) ?? null) : null,
		createdAt: dispatch.createdAt.toISOString(),
		availableAt: dispatch.availableAt.toISOString(),
		completedAt: dispatch.completedAt?.toISOString() ?? null,
		ageMs: Math.max(0, now - dispatch.createdAt.getTime()),
	};
}

/** One project's pipeline snapshot. The caller has already authorized the read. */
export async function loadPipelineSnapshot(
	projectId: string,
	windowHours: number,
	now: Date = new Date(),
): Promise<PipelineSnapshot> {
	const since = new Date(now.getTime() - windowHours * HOUR_MS);
	// One row past the bound in each list tells the reader whether the bound bit.
	const [runRows, dispatchRows, byStatus] = await Promise.all([
		listSnapshotRunsForProject(projectId, since, PIPELINE_SNAPSHOT_ROW_LIMIT + 1),
		listOpenDispatchesForProject(projectId, PIPELINE_SNAPSHOT_ROW_LIMIT + 1),
		countRunsSettledSinceByStatus(projectId, since),
	]);
	const runs = runRows.slice(0, PIPELINE_SNAPSHOT_ROW_LIMIT);
	const dispatches = dispatchRows.slice(0, PIPELINE_SNAPSHOT_ROW_LIMIT);
	const names = await workerNames([
		...runs.map((run) => run.workerId),
		...dispatches.map((dispatch) => dispatch.selectedWorkerId),
	]);
	const at = now.getTime();
	return {
		projectId,
		generatedAt: now.toISOString(),
		windowHours,
		runs: runs.map((run) => toSnapshotRun(run, names, at)),
		dispatches: dispatches.map((dispatch) => toSnapshotDispatch(dispatch, names, at)),
		completedCounts: { since: since.toISOString(), byStatus },
		truncated: {
			runs: runRows.length > PIPELINE_SNAPSHOT_ROW_LIMIT,
			dispatches: dispatchRows.length > PIPELINE_SNAPSHOT_ROW_LIMIT,
		},
	};
}

/**
 * Every dispatch of one task or pull request. The caller has already authorized
 * the read and required the filter to name a task or a pull request.
 */
export async function loadDispatchHistory(
	projectId: string,
	filter: DispatchHistoryFilter,
	now: Date = new Date(),
): Promise<DispatchHistory> {
	// Oldest first, so the extra row that proves truncation is the oldest one.
	const rows = await listDispatchesForTask(projectId, filter, DISPATCH_HISTORY_ROW_LIMIT + 1);
	const truncated = rows.length > DISPATCH_HISTORY_ROW_LIMIT;
	const kept = truncated ? rows.slice(rows.length - DISPATCH_HISTORY_ROW_LIMIT) : rows;
	const names = await workerNames(kept.map((dispatch) => dispatch.selectedWorkerId));
	const at = now.getTime();
	return {
		projectId,
		generatedAt: now.toISOString(),
		dispatches: kept.map((dispatch) => toSnapshotDispatch(dispatch, names, at)),
		truncated,
	};
}
