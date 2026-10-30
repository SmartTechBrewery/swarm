/**
 * The one rule for which task id a board card names in a given repository
 * (ai/ARCHITECTURE.md "Task identity"), shared by every caller that keys a
 * worktree, a branch, or a WIP slot on a card — `pm-status` and the dashboard's
 * Put back — so the precedence below cannot drift between private copies.
 */

import type { WorkItem } from '../pm/types.js';
import { repoSlugsMatch } from '../scm/repo-slug.js';
import { isTaskId } from './task-branch.js';

/**
 * The task id `workItem` names in `repository`, or `undefined` when it names none
 * there.
 *
 * - **The card's SCM artifact wins.** When the provider resolved any linkage
 *   (`taskRef` or `taskRepository`), it alone decides: the artifact number when its
 *   repository is `repository` (through `repoSlugsMatch`, so casing and a `.git`
 *   suffix are noise), else nothing. A link into another repository therefore stays
 *   a skip rather than falling back to the card's own key, and a lone `taskRef`
 *   from an older frame stays unplaceable (issue #710).
 * - **Otherwise the card's own key** (`ownTaskRef`, issue #1230), when it is a task
 *   id every branch reader can parse back (`isTaskId`).
 */
export function taskIdForRepository(workItem: WorkItem, repository: string): string | undefined {
	if (workItem.taskRef !== undefined || workItem.taskRepository !== undefined) {
		return workItem.taskRef &&
			workItem.taskRepository &&
			repoSlugsMatch(workItem.taskRepository, repository)
			? workItem.taskRef
			: undefined;
	}
	const own = workItem.ownTaskRef;
	return own && isTaskId(own) ? own : undefined;
}
