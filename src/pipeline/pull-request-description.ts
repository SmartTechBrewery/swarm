/**
 * The body of the pull request the Implementation phase opens (issue #1277): the
 * agent's filled-in description structure, then one line SWARM always adds itself,
 * naming the work item the pull request delivers.
 *
 * That last line depends on whether the provider can close the work item:
 *
 * - `Closes: #<n>` when the card is linked to an issue in the very repository the
 *   pull request is opened in, on an SCM provider whose description keyword closes
 *   it (`SCM_CLOSING_REFERENCE`, today GitHub only);
 * - otherwise `Work item: [<key or title>](<url>)` — a Jira, Linear or Trello card
 *   with no linked issue, an issue in another repository, or any work item on a
 *   provider with no closing keyword.
 *
 * No URL parsing and no `pm.type` branch is needed: `WorkItem.taskRef` is only ever
 * filled from a linked SCM issue, paired with the repository it belongs to
 * (`WorkItem.taskRepository`), and `WorkItem.ownTaskRef` carries the card's own key
 * when it has no such link (ai/ARCHITECTURE.md "Task identity").
 */

import type { ProjectConfig } from '@/config/schema.js';
import type { WorkItem } from '@/pm/types.js';
import { SCM_CLOSING_REFERENCE } from '@/scm/closing-reference.js';
import { repoSlugsMatch } from '@/scm/repo-slug.js';

type BodyProject = Pick<ProjectConfig, 'repo' | 'scm'>;
type BodyWorkItem = Pick<WorkItem, 'title' | 'url' | 'taskRef' | 'taskRepository' | 'ownTaskRef'>;

/** Escape the characters that would end or break Markdown link text. */
function escapeLinkText(text: string): string {
	return text.replace(/[\\[\]]/g, (char) => `\\${char}`);
}

/** The `Closes: #<n>` line, when this pull request can close the card's linked issue. */
function closingLine(workItem: BodyWorkItem, project: BodyProject): string | undefined {
	const close = project.scm ? SCM_CLOSING_REFERENCE[project.scm] : undefined;
	const { taskRef, taskRepository } = workItem;
	if (!close || !taskRef || !taskRepository) return undefined;
	return repoSlugsMatch(taskRepository, project.repo) ? close(taskRef) : undefined;
}

/** The `Work item: [<key or title>](<url>)` line that links any other work item. */
function workItemLine(workItem: BodyWorkItem): string {
	const label = escapeLinkText(workItem.ownTaskRef?.trim() || workItem.title.trim());
	const url = workItem.url.trim();
	return url ? `Work item: [${label}](${url})` : `Work item: ${label}`;
}

/** The line SWARM appends to every pull request description it writes. */
export function pullRequestWorkItemLine(workItem: BodyWorkItem, project: BodyProject): string {
	return closingLine(workItem, project) ?? workItemLine(workItem);
}

/**
 * Compose the pull request body: the agent's description, then SWARM's work-item
 * line as the last line, outside the project's editable structure.
 */
export function composePullRequestBody({
	description,
	workItem,
	project,
}: {
	description: string;
	workItem: BodyWorkItem;
	project: BodyProject;
}): string {
	return `${description.trim()}\n\n${pullRequestWorkItemLine(workItem, project)}`;
}
