/**
 * Resolving the board card behind a pull request, control-plane side (issue #498).
 *
 * A PR-driven phase (today: Respond-to-review) reports its progress on the board
 * card the work started from, but nothing in a pull request names that card. The
 * durable link SWARM already keeps is `runs.work_item_id`, written by every
 * board-driven run next to its `(project_id, task_id)` — so the card is a read
 * model away, keyed by the task the branch encodes. That is deliberately *not* a
 * PM-provider question: it is answered from SWARM's own tables, with SWARM's own
 * branch naming (`<branchPrefix><taskId>`), so it holds for a Jira/Linear/Trello
 * board paired with a GitHub repo exactly as it does today (ai/RULES.md §2,
 * ai/ARCHITECTURE.md "Task identity").
 *
 * It lives here, not in the phase, because the DB is here: a federated worker
 * must be able to run the phase with no database at all (ADR-003 §2 / ADR-004
 * §3), so both dispatch paths resolve the id before the phase starts — the local
 * one in `runPhase` (`../worker/consumer.ts`), the federated one in the
 * dispatcher's assignment (`../router/dispatcher.ts`) — and inject it.
 *
 * Best-effort by contract: the board report it feeds is cosmetic, so a lookup
 * failure logs and yields `undefined` rather than failing a dispatch.
 */

import type { ProjectConfig } from '../config/schema.js';
import { findBoardItemIdForTask } from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { issueNumberFromBranch } from '../pipeline/task-branch.js';

/**
 * The board card a PR branch's task was dispatched from, or `undefined` when
 * there is none to report on: a human-named branch that encodes no task, a task
 * the board never drove, or run rows that have since been pruned. The phase then
 * falls back to its legacy URL-suffix lookup (`../pipeline/respond-to-review.ts`).
 */
export async function resolveBoardItemIdForPrBranch(
	project: ProjectConfig,
	prBranch: string | undefined,
): Promise<string | undefined> {
	if (!prBranch) return undefined;
	const taskId = issueNumberFromBranch(prBranch, project.branchPrefix);
	if (!taskId) return undefined;
	try {
		return await findBoardItemIdForTask(project.id, taskId);
	} catch (error) {
		logger.warn('Could not resolve the board card for a PR branch — falling back', {
			projectId: project.id,
			prBranch,
			taskId,
			error: describeError(error),
		});
		return undefined;
	}
}
