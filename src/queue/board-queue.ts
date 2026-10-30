/**
 * The board-queue count shown on each repository's **Tickets in progress** table
 * header: how many automation-labelled cards sit on the board outside Backlog and
 * Done without holding a WIP slot — the tickets lined up behind the ones in flight.
 *
 * Unlike the rest of `runs.wip`, this needs the board itself, and there is no
 * one-card question to ask: it is a whole-board `listWorkItems()` (ai/RULES.md §2,
 * issue #735 — the read that once spent a board credential's hourly budget). So the
 * read is cached per project for {@link BOARD_QUEUE_TTL_MS}, shared by every
 * dashboard poll, and a failed read is logged and reported as "unknown" rather than
 * failing the view.
 */

import { hasAutomationLabel } from '../pm/automation-label.js';
import type { WorkItem } from '../pm/types.js';
import { repoSlugsMatch } from '../scm/repo-slug.js';

/** How long one project's board read serves the count. */
export const BOARD_QUEUE_TTL_MS = 5 * 60 * 1000;

/** Statuses a queued card is never in: not yet on the pipeline, or finished. */
const NOT_QUEUED_STATUS_KEYS = new Set(['backlog', 'done']);

export interface BoardQueueScope {
	/** The repository whose table this count heads. */
	repository: string;
	/** Whether a card naming no repository counts here — the project's default repository. */
	isDefaultRepository: boolean;
	/** The project's automation label, or `undefined` when the gate is off. */
	label: string | undefined;
	/** Card ids holding a WIP slot — in flight, not queued. */
	heldWorkItemIds: ReadonlySet<string>;
}

/** Pure: how many of `items` are queued for `scope`'s repository. */
export function countBoardQueue(items: readonly WorkItem[], scope: BoardQueueScope): number {
	return items.filter((item) => {
		if (!item.statusKey || NOT_QUEUED_STATUS_KEYS.has(item.statusKey)) return false;
		if (scope.label && !hasAutomationLabel(item, scope.label)) return false;
		if (scope.heldWorkItemIds.has(item.id)) return false;
		return item.taskRepository
			? repoSlugsMatch(item.taskRepository, scope.repository)
			: scope.isDefaultRepository;
	}).length;
}

const cache = new Map<string, { at: number; items: Promise<WorkItem[]> }>();

/**
 * The project's board items, read at most once per {@link BOARD_QUEUE_TTL_MS}.
 * Concurrent callers share the in-flight read; a rejected read is evicted so the
 * next poll retries instead of serving the failure for the whole window.
 */
export function cachedBoardItems(
	projectId: string,
	read: () => Promise<WorkItem[]>,
	now: number = Date.now(),
): Promise<WorkItem[]> {
	const hit = cache.get(projectId);
	if (hit && now - hit.at < BOARD_QUEUE_TTL_MS) return hit.items;
	const items = read();
	cache.set(projectId, { at: now, items });
	items.catch(() => {
		if (cache.get(projectId)?.items === items) cache.delete(projectId);
	});
	return items;
}

/** Test seam: forget every cached board read. */
export function clearBoardQueueCache(): void {
	cache.clear();
}
