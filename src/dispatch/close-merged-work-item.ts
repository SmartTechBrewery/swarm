/**
 * Closing the work item behind a merged pull request (issue #1351) — the fix for
 * the consistency check's `merged-pr-open-work-item` finding, served to the operator
 * MCP server's `work_item_close` tool through `runs.closeMergedWorkItem` and its dry
 * run `runs.previewCloseMergedWorkItem`.
 *
 * SWARM never closes a card on merge itself: the provider's own link (a `Closes #N`)
 * does, so a missed link leaves the card open and every dependent parked on the
 * dependency gate behind it. This closes it, and only under two conditions read
 * fresh on every call: the pull request is **merged** (the project's own
 * `SCMProvider` read, never a declined or abandoned one), and its work item is
 * **not already done**.
 *
 * Everything goes through the provider-agnostic contracts (ai/RULES.md §2): the pull
 * request through `SCMProvider.getPullRequest`, the card through one-card
 * `PMProvider` lookups (never `listWorkItems`, issue #735), and the write through
 * `closeWorkItem` plus `moveWorkItem` to the canonical `done` key. The card is
 * resolved the way the consistency check resolves it
 * (`./consistency-check.ts`), so the tool fixes exactly what the check reports:
 * SWARM's own `runs.work_item_id` link on the pull request's latest completed Review
 * run when it recorded one, else the issue its head branch's task names, else the
 * pull request itself. A lookup that fails throws — a swallowed miss would read as
 * "no work item".
 *
 * Once closed, the project's dependency waits are woken (`promoteDependencyWaits`,
 * cause `operator`) so dependents start now rather than at their re-check timer.
 */

import type { ProjectConfig } from '../config/schema.js';
import type { DispatchRow } from '../db/repositories/dispatchesRepository.js';
import {
	getLatestCompletedReviewRunForPullRequest,
	type RunRow,
} from '../db/repositories/runsRepository.js';
import { isArtifactNumberTaskId } from '../pipeline/task-branch.js';
import type { PmStatusKey } from '../pm/pipeline.js';
import type { PMProvider, WorkItem, WorkItemArtifact } from '../pm/types.js';
import type { PullRequestDetails, SCMProvider } from '../scm/types.js';
import { type DependencyWakeCause, promoteDependencyWaits } from './dispatcher.js';
import { findTaskIdForPrBranch } from './pr-branch-task.js';

/** The canonical status key a closed work item's card is moved to. */
const DONE_STATUS_KEY: PmStatusKey = 'done';

/** What the close acts on: one pull request of a project scoped to its repository. */
export interface CloseMergedWorkItemTarget {
	/** The project, scoped to the pull request's repository (`project.repo`). */
	project: ProjectConfig;
	pm: PMProvider;
	scm: SCMProvider;
	prNumber: number;
}

/** The datastore reads and the wake the close makes — injected so it is testable without them. */
export interface CloseMergedWorkItemDeps {
	/** The pull request's latest completed Review run, whose `workItemId` SWARM recorded. */
	latestReviewRun(
		projectId: string,
		repository: string,
		prNumber: string,
	): Promise<RunRow | undefined>;
	/** The task a pull request's head branch belongs to, if any. */
	taskIdForPrBranch(project: ProjectConfig, prBranch: string): Promise<string | undefined>;
	promoteDependencyWaits(projectId: string, cause: DependencyWakeCause): Promise<DispatchRow[]>;
}

export const defaultCloseMergedWorkItemDeps: CloseMergedWorkItemDeps = {
	latestReviewRun: getLatestCompletedReviewRunForPullRequest,
	taskIdForPrBranch: (project, prBranch) => findTaskIdForPrBranch(project, prBranch),
	promoteDependencyWaits,
};

/** Why a close is refused. */
export type CloseMergedWorkItemRefusalReason = 'not-merged' | 'no-work-item' | 'already-done';

/** How the work item behind the pull request was found. */
export type WorkItemResolution = 'run-link' | 'task-issue' | 'pull-request';

/** The work item as the dry run reports it. */
export interface ResolvedWorkItem {
	id: string;
	title: string;
	url: string;
	/** The board's own status label, when the provider reports one. */
	status: string | null;
	/** The canonical status key the provider resolved, or `null` for an unmapped status. */
	statusKey: string | null;
	resolvedVia: WorkItemResolution;
}

/** What closing would do, decided from fresh reads — the dry run's answer. */
export interface CloseMergedWorkItemPlan {
	projectId: string;
	repository: string;
	prNumber: number;
	pullRequest: Pick<PullRequestDetails, 'state' | 'merged' | 'headBranch'>;
	/** `null` when no work item on the board backs the pull request. */
	workItem: ResolvedWorkItem | null;
	refusal: { reason: CloseMergedWorkItemRefusalReason; message: string } | null;
	intendedChanges: string[];
}

/** What a close did. */
export interface CloseMergedWorkItemResult {
	projectId: string;
	repository: string;
	prNumber: number;
	workItem: ResolvedWorkItem;
	closed: true;
	/** How many dependency-waiting dispatches the wake re-opened. */
	woken: number;
	wokenDispatchIds: string[];
}

/**
 * Read the pull request and the work item behind it, and decide whether the close
 * would go ahead. Read-only; a provider read that fails throws.
 */
export async function planCloseMergedWorkItem(
	target: CloseMergedWorkItemTarget,
	deps: CloseMergedWorkItemDeps = defaultCloseMergedWorkItemDeps,
): Promise<CloseMergedWorkItemPlan> {
	const { project, scm, prNumber } = target;
	const pr = `Pull request #${prNumber} in ${project.repo}`;
	const details = await scm.getPullRequest(project, prNumber);
	const found = await findWorkItem(target, details.headBranch, deps);
	const workItem = found ? toResolvedWorkItem(found.item, found.via) : null;

	let refusal: CloseMergedWorkItemPlan['refusal'] = null;
	if (!details.merged) {
		refusal = {
			reason: 'not-merged',
			message:
				details.state === 'open'
					? `${pr} is still open, so its work item is not closed.`
					: `${pr} was closed without being merged, so its work item is not closed.`,
		};
	} else if (!workItem) {
		refusal = {
			reason: 'no-work-item',
			message: `${pr} is merged, but no work item on the board backs it.`,
		};
	} else if (workItem.statusKey === DONE_STATUS_KEY) {
		refusal = {
			reason: 'already-done',
			message: `Work item "${workItem.title}" behind ${pr} is already done.`,
		};
	}

	return {
		projectId: project.id,
		repository: project.repo,
		prNumber,
		pullRequest: { state: details.state, merged: details.merged, headBranch: details.headBranch },
		workItem,
		refusal,
		intendedChanges:
			refusal || !workItem
				? []
				: [
						`Close work item "${workItem.title}" (${workItem.url}), now in ${workItem.status ?? workItem.statusKey ?? 'an unmapped status'}.`,
						'Move its card to Done.',
						"Wake the project's dependency-waiting dispatches, so its dependents start now.",
					],
	};
}

/**
 * Close the work item a {@link planCloseMergedWorkItem} plan resolved, move its card
 * to `done`, and wake the project's dependency waits. The caller has already refused
 * a plan carrying a refusal.
 */
export async function applyCloseMergedWorkItem(
	plan: CloseMergedWorkItemPlan & { workItem: ResolvedWorkItem },
	pm: PMProvider,
	deps: CloseMergedWorkItemDeps = defaultCloseMergedWorkItemDeps,
): Promise<CloseMergedWorkItemResult> {
	await pm.closeWorkItem(plan.workItem.id);
	await pm.moveWorkItem(plan.workItem.id, DONE_STATUS_KEY);
	const woken = await deps.promoteDependencyWaits(plan.projectId, 'operator');
	return {
		projectId: plan.projectId,
		repository: plan.repository,
		prNumber: plan.prNumber,
		workItem: plan.workItem,
		closed: true,
		woken: woken.length,
		wokenDispatchIds: woken.map((row) => row.id),
	};
}

async function findWorkItem(
	target: CloseMergedWorkItemTarget,
	headBranch: string,
	deps: CloseMergedWorkItemDeps,
): Promise<{ item: WorkItem; via: WorkItemResolution } | undefined> {
	const { project, pm, prNumber } = target;
	const run = await deps.latestReviewRun(project.id, project.repo, String(prNumber));
	if (run?.workItemId) return { item: await pm.getWorkItem(run.workItemId), via: 'run-link' };

	const taskId = await deps.taskIdForPrBranch(project, headBranch);
	const artifacts: { artifact: WorkItemArtifact; via: WorkItemResolution }[] = [
		...(taskId && isArtifactNumberTaskId(taskId)
			? [
					{
						artifact: { repository: project.repo, kind: 'issue' as const, number: taskId },
						via: 'task-issue' as const,
					},
				]
			: []),
		{
			artifact: { repository: project.repo, kind: 'pullRequest', number: String(prNumber) },
			via: 'pull-request',
		},
	];
	for (const { artifact, via } of artifacts) {
		const item = await pm.findWorkItemForArtifact(artifact);
		if (item) return { item, via };
	}
	return undefined;
}

function toResolvedWorkItem(item: WorkItem, via: WorkItemResolution): ResolvedWorkItem {
	return {
		id: item.id,
		title: item.title,
		url: item.url,
		status: item.status ?? null,
		statusKey: item.statusKey ?? null,
		resolvedVia: via,
	};
}
