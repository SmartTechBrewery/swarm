/**
 * Task branch naming and parsing utilities.
 *
 * A repository names its task branches by a **branch name pattern** (issue #1241,
 * `./branch-pattern.ts`) — `{issue_key}/{friendly_name}`, `fix/{issue_key}-…` — or,
 * when it states none, by its legacy `branchPrefix` as `<branchPrefix><taskId>` (e.g.
 * `issue-42`, `issue-VT-1538`), which is the pattern `<prefix>{issue_key}`. A task id
 * takes exactly one of two forms (ai/ARCHITECTURE.md "Task identity"): an SCM artifact
 * number (`42`) or a board key (`VT-1538` — an uppercase project key, a hyphen and a
 * number). The grammar is closed and names a shape, not a provider, so a branch stays
 * recognisable across a PM provider switch and a lowercase or slugged human branch
 * under the prefix (`issue-hotfix-2`) is still not a task branch. The two forms cannot
 * overlap: a number starts with a digit, a key with a letter.
 *
 * A branch is recognised under the repository's pattern **and** under its legacy
 * prefix shape ({@link taskIdFromTaskBranch}), so a pull request opened before a
 * pattern was first set stays SWARM's own without any migration. Only those two are
 * tried: a branch rendered by an *earlier* pattern is not recognised once the pattern
 * changes again, which the dashboard's pattern editor warns about.
 */

import {
	branchPatternFromPrefix,
	branchPatternNeedsImplementer,
	DEFAULT_BRANCH_PREFIX,
	renderBranchName,
	TASK_ID_FORMS,
	taskIdFromPatternBranch,
} from './branch-pattern.js';

const EXACT_TASK_ID = new RegExp(`^(${TASK_ID_FORMS})$`);
const LEADING_TASK_ID = new RegExp(`^(${TASK_ID_FORMS})`);
const ARTIFACT_NUMBER_TASK_ID = /^\d+$/;

/**
 * Compose the legacy-shaped task branch name for a prefix and task id
 * (`<branchPrefix><taskId>`). What a repository with no pattern names its branches,
 * and the provisional name a pattern with implementer-chosen parts is checked out on
 * until the implementer has chosen them ({@link provisionalTaskBranch}).
 */
export function taskBranch(branchPrefix: string, taskId: string): string {
	return `${branchPrefix}${taskId}`;
}

/** The two keys a repository (or the config scoped to it) names its task branches by. */
export interface TaskBranchNaming {
	/** The repository's branch name pattern (issue #1241); unset means its legacy prefix. */
	branchPattern?: string;
	/** The legacy prefix — still the pattern when none is set, and always still recognised. */
	branchPrefix?: string;
}

/**
 * The pattern a repository names its task branches by: its own `branchPattern`, or its
 * legacy `branchPrefix` as `<prefix>{issue_key}` (issue #1241) — so an existing
 * repository keeps its exact branch names with no data migration.
 */
export function resolveBranchPattern(naming: TaskBranchNaming): string {
	return naming.branchPattern ?? branchPatternFromPrefix(legacyPrefix(naming));
}

/**
 * The branch Implementation checks a task out on before any agent has run. When the
 * pattern needs no implementer-chosen part it is the task branch itself, rendered from
 * the task id alone. Otherwise the name is only known once the implementer has chosen
 * its `{work_type}`/`{friendly_name}`, so the checkout starts on the legacy-shaped
 * `<branchPrefix><taskId>` and is renamed at delivery.
 */
export function provisionalTaskBranch(naming: TaskBranchNaming, taskId: string): string {
	const pattern = resolveBranchPattern(naming);
	return branchPatternNeedsImplementer(pattern)
		? taskBranch(legacyPrefix(naming), taskId)
		: renderBranchName(pattern, { issueKey: taskId });
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
 * Extract the task id encoded in a branch name under `branchPrefix` — the legacy
 * shape only. Shared code reads a repository's branches through
 * {@link taskIdFromTaskBranch}, which also knows its pattern.
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

/**
 * The task id a branch of this repository carries — under its branch name pattern
 * (issue #1241), or under its legacy `<branchPrefix><taskId>` shape, which stays
 * recognised after a pattern is set so every branch already open under the prefix
 * keeps being SWARM's own. A branch named by an earlier *pattern* is not: only the
 * current one is tried. `strict` applies to the legacy shape exactly as in
 * {@link taskIdFromBranch}; the pattern always matches the whole branch.
 */
export function taskIdFromTaskBranch(
	branch: string,
	naming: TaskBranchNaming,
	options: TaskIdFromBranchOptions = {},
): string | undefined {
	const fromPattern = naming.branchPattern
		? taskIdFromPatternBranch(branch, naming.branchPattern)
		: undefined;
	return fromPattern ?? taskIdFromBranch(branch, legacyPrefix(naming), options);
}

function legacyPrefix(naming: TaskBranchNaming): string {
	return naming.branchPrefix ?? DEFAULT_BRANCH_PREFIX;
}
