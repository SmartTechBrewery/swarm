/**
 * Task branch naming and parsing utilities.
 *
 * SWARM names every task branch as `<branchPrefix><taskId>` (e.g. `issue-42`,
 * `issue-VT-1538`). A task id takes exactly one of two forms (ai/ARCHITECTURE.md
 * "Task identity"): an SCM artifact number (`42`) or a board key (`VT-1538` — an
 * uppercase project key, a hyphen and a number). The grammar is closed and names a
 * shape, not a provider, so a branch stays recognisable across a PM provider switch
 * and a lowercase or slugged human branch under the prefix (`issue-hotfix-2`) is
 * still not a task branch. The two forms cannot overlap: a number starts with a
 * digit, a key with a letter.
 */

const TASK_ID_FORMS = String.raw`\d+|[A-Z][A-Z0-9_]*-\d+`;
const EXACT_TASK_ID = new RegExp(`^(${TASK_ID_FORMS})$`);
const LEADING_TASK_ID = new RegExp(`^(${TASK_ID_FORMS})`);
const ARTIFACT_NUMBER_TASK_ID = /^\d+$/;

/**
 * Compose the task branch name for a given project and task ID (`<branchPrefix><taskId>`).
 */
export function taskBranch(branchPrefix: string, taskId: string): string {
	return `${branchPrefix}${taskId}`;
}

/** Whether `value` is, in its entirety, a task id of either form. */
export function isTaskId(value: string): boolean {
	return EXACT_TASK_ID.test(value);
}

/**
 * Whether `taskId` is the SCM artifact-number form (`42`) — the only form that also
 * names an SCM issue, so the only one a reader wanting an issue number may use as one.
 */
export function isArtifactNumberTaskId(taskId: string): boolean {
	return ARTIFACT_NUMBER_TASK_ID.test(taskId);
}

export interface TaskIdFromBranchOptions {
	/**
	 * When `true`, requires the whole remainder after `branchPrefix` to be one task id,
	 * with no trailing suffix. Default is `false` (matches a leading task id, so
	 * `issue-100-runs-list-screen` → `100` and `issue-VT-1538-fix` → `VT-1538`).
	 */
	strict?: boolean;
}

/**
 * Extract the task id encoded in a branch name under `branchPrefix`.
 *
 * @param branch The branch name to parse.
 * @param branchPrefix The project's branch prefix (e.g. `issue-`).
 * @param options Parsing options (`strict`: whether to require exact match without suffixes).
 * @returns The task id (an SCM artifact number or a board key), or `undefined` if the
 *   branch is not a task branch.
 */
export function taskIdFromBranch(
	branch: string,
	branchPrefix: string,
	options: TaskIdFromBranchOptions = {},
): string | undefined {
	if (!branch.startsWith(branchPrefix)) return undefined;
	const rest = branch.slice(branchPrefix.length);
	const match = rest.match(options.strict ? EXACT_TASK_ID : LEADING_TASK_ID);
	return match ? match[1] : undefined;
}
