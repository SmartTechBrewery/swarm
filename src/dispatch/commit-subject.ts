/**
 * Resolving the commit subject behind a pull request, control-plane side (issue #1242).
 *
 * A repository's commit subject pattern is rendered once per task, by Implementation,
 * and every later commit SWARM makes for the task — the Respond-to-review and
 * Respond-to-CI fixes — carries that same subject, so an integration keyed on it (a
 * Jira–Azure DevOps link reading the leading `VT-1538`) sees every one of them. Those
 * phases start from a pull request, which names no subject; the subject is stored on
 * the task's Implementation runs, keyed by the task the branch belongs to (the branch
 * Implementation recorded, else its decode — `./pr-branch-task.ts`, issue #1247) — the same read
 * model `./board-card.ts` resolves the board card from.
 *
 * It lives here, not in the phase, because the DB is here: a federated worker runs the
 * phase with no database (ADR-003 §2 / ADR-004 §3), so the subject is resolved in the
 * dispatcher's assignment (`../router/dispatcher.ts`) and injected.
 *
 * Best-effort: a lookup failure logs and yields `undefined`, and the phase then falls
 * back to the agent's own subject rendered through the pattern (`fixCommitSubject`,
 * `../pipeline/commit-subject-pattern.ts`) rather than failing a dispatch.
 */

import type { ProjectConfig } from '../config/schema.js';
import { findStoredCommitSubject } from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { findTaskIdForPrBranch } from './pr-branch-task.js';

/**
 * The commit subject Implementation stored for a PR branch's task, or `undefined` when
 * there is none: a branch that encodes no task, a task whose delivery predates issue
 * #1242, or run rows that have since been pruned.
 */
export async function resolveCommitSubjectForPrBranch(
	project: ProjectConfig,
	prBranch: string | undefined,
): Promise<string | undefined> {
	if (!prBranch) return undefined;
	const taskId = await findTaskIdForPrBranch(project, prBranch);
	if (!taskId) return undefined;
	try {
		return await findStoredCommitSubject(project.id, project.repo, taskId);
	} catch (error) {
		logger.warn('Could not resolve the commit subject for a PR branch — falling back', {
			projectId: project.id,
			prBranch,
			taskId,
			error: describeError(error),
		});
		return undefined;
	}
}
