/**
 * Task branch naming and parsing utilities.
 *
 * SWARM names every task branch as `<branchPrefix><taskId>` (e.g. `issue-42`).
 */

/**
 * Compose the task branch name for a given project and task ID (`<branchPrefix><taskId>`).
 */
export function taskBranch(branchPrefix: string, taskId: string): string {
	return `${branchPrefix}${taskId}`;
}

export interface IssueNumberFromBranchOptions {
	/**
	 * When `true`, requires the branch to match `<branchPrefix><digits>` exactly with no trailing suffix.
	 * Default is `false` (matches leading digits).
	 */
	strict?: boolean;
}

/**
 * Extract the backing work-item ID encoded in a branch name under `branchPrefix`.
 *
 * @param branch The branch name to parse.
 * @param branchPrefix The project's branch prefix (e.g. `issue-`).
 * @param options Parsing options (`strict`: whether to require exact match without suffixes).
 * @returns The extracted work item ID string (digits), or `undefined` if parsing failed.
 */
export function issueNumberFromBranch(
	branch: string,
	branchPrefix: string,
	options: IssueNumberFromBranchOptions = {},
): string | undefined {
	if (!branch.startsWith(branchPrefix)) return undefined;
	const rest = branch.slice(branchPrefix.length);
	const pattern = options.strict ? /^(\d+)$/ : /^(\d+)/;
	const match = rest.match(pattern);
	return match ? match[1] : undefined;
}
