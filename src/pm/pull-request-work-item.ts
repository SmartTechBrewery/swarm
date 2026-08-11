/**
 * "Which board work item backs this pull request?" — the lookup the
 * automation-label gate needs for the four SCM-event-driven phases (Review,
 * Respond-to-review, Respond-to-CI, Resolve-conflicts, issue #354), whose trigger
 * results carry a pull request rather than a {@link WorkItem}.
 *
 * Provider-agnostic by construction (ai/RULES.md §2): the match runs inside the
 * provider ({@link PMProvider.findWorkItemForArtifact}), so no GitHub URL shape,
 * GraphQL node id, or `projects_v2` payload assumption enters worker/pipeline code —
 * and a federated worker can serve it as
 * one narrow read through the control plane instead of proxying the whole board
 * (`src/pm/transport-delivery.ts`). It is the same seam
 * `src/pipeline/respond-to-review.ts` resolves its board card through.
 *
 * **Fails open.** A pull request with no board card behind it, and a board read
 * that fails transiently, both resolve to `undefined` — the caller treats that as
 * "nothing to gate on" and lets the phase run. An unlinked PR or a network blip
 * must never wedge review/CI work, so a swallowed error here is deliberate
 * (the same posture as `findGatingBlockers`, `src/pipeline/dependency-guard.ts`).
 */

import { logger } from '../lib/logger.js';
import type { PMProvider, WorkItem } from './types.js';

/** How a pull request identifies its board work item. */
export interface PullRequestWorkItemQuery {
	/** Repository the pull request belongs to, in the project's configured owner/name form. */
	repository: string;
	/**
	 * The work-item number the PR's head branch decodes to under the project's
	 * `branchPrefix`, when it is a SWARM task branch — the usual case, since SWARM
	 * names every task branch after the item it implements. Absent for a branch
	 * outside that convention.
	 */
	issueNumber?: string;
	/** The pull request's own number — for a board that tracks the PR itself as a card. */
	prNumber: string;
}

/**
 * The board work item backing `query`'s pull request, or `undefined` when none is
 * on the board (or the board couldn't be read — see the module header).
 *
 * The backing **work item** wins over the PR: SWARM's own PRs are opened from a
 * `<branchPrefix><itemNumber>` branch and the card tracks that item, so the issue
 * artifact is tried first and the PR artifact only when it misses. Each attempt is one
 * board read, so the second is paid only by a PR whose item is not on the board.
 *
 * `logContext` is merged into the log lines (the caller's `projectId`/`phase`/
 * `taskId`) so a fail-open decision is traceable to the dispatch it belongs to.
 */
export async function findWorkItemForPullRequest(
	pm: PMProvider,
	query: PullRequestWorkItemQuery,
	logContext: Record<string, unknown> = {},
): Promise<WorkItem | undefined> {
	const artifacts = [
		...(query.issueNumber
			? [{ repository: query.repository, kind: 'issue' as const, number: query.issueNumber }]
			: []),
		{ repository: query.repository, kind: 'pullRequest' as const, number: query.prNumber },
	];
	try {
		for (const artifact of artifacts) {
			const match = await pm.findWorkItemForArtifact(artifact);
			if (match) return match;
		}
		logger.debug('No board work item backs this pull request', { ...logContext, artifacts });
		return undefined;
	} catch (error) {
		logger.warn('Could not resolve the board work item for this pull request', {
			...logContext,
			artifacts,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}
