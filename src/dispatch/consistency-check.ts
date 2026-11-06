/**
 * The operator consistency check (issue #1344) — the stuck states SWARM will not
 * leave by itself, read for the operator MCP server's `consistency_check` tool
 * through `runs.consistencyCheck`. Two kinds, and nothing here fixes either:
 *
 * - **`merged-pr-open-work-item`** — merge automation merged a pull request in the
 *   window, but the work item it implements is still open on the board. SWARM never
 *   closes a card on merge itself (the provider's own link — a `Closes #N` — does),
 *   so a missed close leaves the card, and every dependent waiting on it, where it is.
 * - **`dependency-wait-blockers-done`** — a dispatch is parked on the dependency gate
 *   although the gate, asked now, would no longer defer it: none of its recorded
 *   blockers is still open. It sits until its re-check timer instead of starting.
 *
 * **Board reads go through the `PMProvider` contract alone** (ai/RULES.md §2) and are
 * one-card lookups, never `listWorkItems` (issue #735): a merged pull request costs at
 * most two `findWorkItemForArtifact` calls (or one `getWorkItem` when its run recorded
 * the card), a dependency wait the gate's own blocker read plus one `getWorkItem` when
 * it is reported. Both candidate lists are capped, so one call's cost is bounded
 * whatever the window, and `truncated` says when a cap bit.
 *
 * "Finished" is the dependency gate's own predicate, {@link classifyOpenBlockers},
 * never a re-derivation here — so this cannot report a wait the gate would still hold.
 *
 * Read-only and fail-soft per candidate: a lookup that fails becomes an `unchecked`
 * entry naming why, never a finding and never a failed call — an unreadable card is
 * not evidence that it is stuck, and one bad card must not hide the rest.
 */

import type { ProjectConfig } from '../config/schema.js';
import { type DispatchRow, listDependencyWaits } from '../db/repositories/dispatchesRepository.js';
import { getProjectByIdFromDb } from '../db/repositories/projectsRepository.js';
import {
	listMergedReviewRunsSince,
	type PipelineRunRow,
} from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { classifyOpenBlockers } from '../pipeline/dependency-guard.js';
import { isArtifactNumberTaskId } from '../pipeline/task-branch.js';
import type { PMProvider, WorkItem, WorkItemArtifact } from '../pm/types.js';
import { normalizeStoredJobPayload, repositoryForJob, type SwarmJob } from '../queue/jobs.js';
import { findTaskIdForPrBranch } from './pr-branch-task.js';

/** The window a check looks back over when the caller names none. */
export const DEFAULT_CONSISTENCY_WINDOW_HOURS = 24;
/** The longest window a check accepts — thirty days. */
export const MAX_CONSISTENCY_WINDOW_HOURS = 720;
/** At most this many merged pull requests are looked behind per call. */
export const MAX_MERGED_PULL_REQUESTS_CHECKED = 50;
/** At most this many dependency waits are re-read per call. */
export const MAX_DEPENDENCY_WAITS_CHECKED = 50;

export type ConsistencyFindingKind = 'merged-pr-open-work-item' | 'dependency-wait-blockers-done';

/** One stuck state, with what to do about it. */
export interface ConsistencyFinding {
	kind: ConsistencyFindingKind;
	/** The repository the pull request or dispatch belongs to (`owner/repo`). */
	repository: string;
	/** The merged pull request — `merged-pr-open-work-item` only. */
	prNumber?: number;
	/** The task the work belongs to, when SWARM recorded or can derive one. */
	taskId: string | null;
	/** The waiting dispatch — `dependency-wait-blockers-done` only. */
	dispatchId?: string;
	/** The provider-native id of the board work item. */
	workItemId: string;
	/** The work item's URL as the provider reports it. */
	workItemUrl: string;
	/** What was found, in a sentence. */
	detail: string;
	/** What an operator does about it. */
	suggestedAction: string;
}

/** A candidate the check could not decide about, and why. */
export interface ConsistencyUnchecked {
	kind: ConsistencyFindingKind;
	repository: string;
	prNumber?: number;
	taskId: string | null;
	dispatchId?: string;
	workItemId?: string;
	reason: string;
}

export interface ConsistencyCheckResult {
	/** The window merged pull requests were read over, in hours. */
	windowHours: number;
	/** The window's start (ISO 8601). */
	since: string;
	findings: ConsistencyFinding[];
	unchecked: ConsistencyUnchecked[];
	/** Whether a candidate cap left merged pull requests or dependency waits unread. */
	truncated: boolean;
}

/** The datastore reads a check makes — injected so the check is testable without one. */
export interface ConsistencyCheckDeps {
	listMergedReviewRuns(projectId: string, since: Date, limit: number): Promise<PipelineRunRow[]>;
	listDependencyWaits(projectId: string): Promise<DispatchRow[]>;
	/** The task a pull request's head branch belongs to in `repository`, if any. */
	taskIdForPrBranch(
		projectId: string,
		repository: string,
		prBranch: string,
	): Promise<string | undefined>;
	now(): Date;
}

export const defaultConsistencyCheckDeps: ConsistencyCheckDeps = {
	listMergedReviewRuns: listMergedReviewRunsSince,
	listDependencyWaits: (projectId) => listDependencyWaits(projectId),
	async taskIdForPrBranch(projectId, repository, prBranch) {
		// Scoped to the pull request's own repository, whose branch naming decodes it.
		const project = await getProjectByIdFromDb(projectId, repository);
		return project ? findTaskIdForPrBranch(project, prBranch) : undefined;
	},
	now: () => new Date(),
};

/**
 * Run both checks for `project` against its board `pm`. `windowHours` bounds the
 * merged pull requests looked at; dependency waits are every one currently parked.
 */
export async function runConsistencyCheck(
	project: ProjectConfig,
	pm: PMProvider,
	windowHours: number = DEFAULT_CONSISTENCY_WINDOW_HOURS,
	deps: ConsistencyCheckDeps = defaultConsistencyCheckDeps,
): Promise<ConsistencyCheckResult> {
	const since = new Date(deps.now().getTime() - windowHours * 60 * 60 * 1000);
	const result: ConsistencyCheckResult = {
		windowHours,
		since: since.toISOString(),
		findings: [],
		unchecked: [],
		truncated: false,
	};
	await checkMergedPullRequests(project, pm, since, deps, result);
	await checkDependencyWaits(project, pm, deps, result);
	return result;
}

/** The status a finding's detail names: the board's own label, else the canonical key. */
function statusLabel(item: WorkItem): string {
	return item.status ?? item.statusKey ?? 'an unmapped status';
}

async function checkMergedPullRequests(
	project: ProjectConfig,
	pm: PMProvider,
	since: Date,
	deps: ConsistencyCheckDeps,
	result: ConsistencyCheckResult,
): Promise<void> {
	const runs = await deps.listMergedReviewRuns(project.id, since, MAX_MERGED_PULL_REQUESTS_CHECKED);
	if (runs.length >= MAX_MERGED_PULL_REQUESTS_CHECKED) result.truncated = true;
	const seen = new Set<string>();
	for (const run of runs) {
		if (!run.prNumber) continue;
		// Newest first, so a pull request's latest merged Review run is the one kept.
		const key = `${run.repository}#${run.prNumber}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const prNumber = Number(run.prNumber);
		let taskId: string | null = run.taskId;
		try {
			const branchTaskId = await taskIdOfMergedPullRequest(project.id, run, deps);
			taskId = branchTaskId ?? run.taskId;
			const item = await findMergedWorkItem(pm, run, branchTaskId);
			// No card behind the pull request is not a stuck state: nothing waits on it.
			if (!item || item.statusKey === 'done') continue;
			result.findings.push({
				kind: 'merged-pr-open-work-item',
				repository: run.repository,
				prNumber,
				taskId,
				workItemId: item.id,
				workItemUrl: item.url,
				detail:
					`Pull request #${run.prNumber} in ${run.repository} was merged by SWARM ` +
					`(Review run ${run.id}), but its work item "${item.title}" is still in ` +
					`${statusLabel(item)} on the board.`,
				suggestedAction:
					'Close the work item and move it to Done on the board ' +
					'(`work_item_close`, where this server offers it). Its dependents wake once it is done.',
			});
		} catch (error) {
			const reason = describeError(error);
			logger.warn('consistency check: could not read the work item behind a merged pull request', {
				projectId: project.id,
				repository: run.repository,
				prNumber: run.prNumber,
				error: reason,
			});
			result.unchecked.push({
				kind: 'merged-pr-open-work-item',
				repository: run.repository,
				prNumber,
				taskId,
				reason,
			});
		}
	}
}

/**
 * The task a merged pull request belongs to: the one its head branch names
 * (`./pr-branch-task.ts`), or `undefined` for a branch outside SWARM's naming. A
 * Review run's own `taskId` is the pull request number, not the task.
 */
async function taskIdOfMergedPullRequest(
	projectId: string,
	run: PipelineRunRow,
	deps: ConsistencyCheckDeps,
): Promise<string | undefined> {
	const prBranch = prBranchOf(run.jobPayload);
	return prBranch ? deps.taskIdForPrBranch(projectId, run.repository, prBranch) : undefined;
}

/**
 * The board card behind a merged pull request. The card the run recorded wins;
 * otherwise the same two one-card lookups the automation gate makes — the issue the
 * PR's task branch names, then the pull request itself
 * (`src/pm/pull-request-work-item.ts`) — but with provider errors thrown rather than
 * swallowed, since a swallowed miss here would read as "nothing stuck".
 */
async function findMergedWorkItem(
	pm: PMProvider,
	run: PipelineRunRow,
	branchTaskId: string | undefined,
): Promise<WorkItem | undefined> {
	if (run.workItemId) return pm.getWorkItem(run.workItemId);
	const artifacts: WorkItemArtifact[] = [
		...(branchTaskId && isArtifactNumberTaskId(branchTaskId)
			? [{ repository: run.repository, kind: 'issue' as const, number: branchTaskId }]
			: []),
		{ repository: run.repository, kind: 'pullRequest', number: run.prNumber ?? '' },
	];
	for (const artifact of artifacts) {
		const item = await pm.findWorkItemForArtifact(artifact);
		if (item) return item;
	}
	return undefined;
}

/** The head branch an SCM job's event names, read from a run's stored payload. */
function prBranchOf(payload: SwarmJob | null): string | undefined {
	if (!payload) return undefined;
	const job = normalizeStoredJobPayload(payload);
	return job.type === 'scm' ? job.event.prBranch : undefined;
}

async function checkDependencyWaits(
	project: ProjectConfig,
	pm: PMProvider,
	deps: ConsistencyCheckDeps,
	result: ConsistencyCheckResult,
): Promise<void> {
	// A provider without dependencies never gates (`findGatingBlockers`), so nothing
	// of its can be parked on the gate — and it has no blockers to read.
	if (!pm.supportsDependencies) return;
	const waits = await deps.listDependencyWaits(project.id);
	if (waits.length > MAX_DEPENDENCY_WAITS_CHECKED) result.truncated = true;
	for (const dispatch of waits.slice(0, MAX_DEPENDENCY_WAITS_CHECKED)) {
		const job = normalizeStoredJobPayload(dispatch.jobPayload);
		const repository = dispatch.repository ?? repositoryForJob(job) ?? project.repo;
		const base = { repository, taskId: dispatch.taskId, dispatchId: dispatch.id };
		// The gate runs only in the board-driven phases, whose job names the card.
		if (job.type !== 'pm') {
			result.unchecked.push({
				kind: 'dependency-wait-blockers-done',
				...base,
				reason: `The waiting dispatch is a ${job.type} job, which names no board work item.`,
			});
			continue;
		}
		const workItemId = job.event.itemId;
		try {
			const { gating } = await classifyOpenBlockers(pm, workItemId);
			if (gating.length > 0) continue;
			const item = await pm.getWorkItem(workItemId);
			const recorded = (job.dependencyBlockers ?? []).map((b) => b.reference);
			result.findings.push({
				kind: 'dependency-wait-blockers-done',
				...base,
				workItemId,
				workItemUrl: item.url,
				detail:
					`The ${dispatch.phase ?? 'board'} dispatch for "${item.title}" is waiting on the ` +
					'dependency gate' +
					(recorded.length > 0 ? ` (it was blocked by ${recorded.join(', ')})` : '') +
					', but none of its recorded blockers is still open. It re-checks only at ' +
					`${dispatch.availableAt.toISOString()}.`,
				suggestedAction:
					"Wake the project's dependency waits now (`dependency_waits_wake`, where this " +
					'server offers it), or use Retry now on the Queue screen.',
			});
		} catch (error) {
			const reason = describeError(error);
			logger.warn('consistency check: could not re-read a dependency wait', {
				projectId: project.id,
				dispatchId: dispatch.id,
				workItemId,
				error: reason,
			});
			result.unchecked.push({
				kind: 'dependency-wait-blockers-done',
				...base,
				workItemId,
				reason,
			});
		}
	}
}
