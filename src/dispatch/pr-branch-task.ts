/**
 * Resolving the task behind a pull request's head branch, control-plane side (issue #1247).
 *
 * Every Implementation run records the branch it decided on its job payload (issue
 * #1241), so the task a pull request belongs to is a read model away — and that answer
 * survives the repository's branch pattern or legacy `branchPrefix` being changed or
 * cleared, which re-deriving the task from the *current* naming does not. The decode
 * (`taskIdFromTaskBranch`) stays the fallback for a pull request whose run stored no
 * branch: one opened before issue #1241, or one whose best-effort payload write failed.
 *
 * The ownership gate (`../triggers/swarm-managed-pr.ts`) reads the recorded branch
 * itself, because there a failed lookup must defer rather than decide. Every other
 * control-plane branch → task reader resolves through here, best-effort: a lookup
 * failure logs and falls back to the decode, which is exactly the pre-#1247 answer.
 */

import type { ProjectConfig } from '../config/schema.js';
import { findTaskIdForStoredTaskBranch } from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { type TaskIdFromBranchOptions, taskIdFromTaskBranch } from '../pipeline/task-branch.js';

/**
 * The task a pull request's head branch belongs to: the task whose Implementation
 * recorded this branch in this repository, or — on a miss or a failed lookup — the task
 * the branch decodes to under the repository's current naming. `options.strict` applies
 * to the decode only; a recorded branch is an exact name. `undefined` when neither names
 * a task, or there is no branch.
 */
export async function findTaskIdForPrBranch(
	project: ProjectConfig,
	prBranch: string | undefined,
	options: TaskIdFromBranchOptions = {},
): Promise<string | undefined> {
	if (!prBranch) return undefined;
	try {
		const recorded = await findTaskIdForStoredTaskBranch(project.id, project.repo, prBranch);
		if (recorded) return recorded;
	} catch (error) {
		logger.warn('Could not look up the recorded task branch — decoding the branch instead', {
			projectId: project.id,
			prBranch,
			error: describeError(error),
		});
	}
	return taskIdFromTaskBranch(prBranch, project, options);
}
