import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BOARD_QUEUE_TTL_MS,
	type BoardQueueScope,
	cachedBoardItems,
	clearBoardQueueCache,
	countBoardQueue,
} from '@/queue/board-queue.js';
import { createMockWorkItem } from '../../helpers/factories.js';

function scope(overrides: Partial<BoardQueueScope> = {}): BoardQueueScope {
	return {
		repository: 'acme/widgets',
		isDefaultRepository: true,
		label: 'swarm',
		heldWorkItemIds: new Set(),
		...overrides,
	};
}

function card(id: string, statusKey: string | undefined, overrides = {}) {
	return createMockWorkItem({
		id,
		statusKey,
		url: `https://github.com/acme/widgets/issues/${id}`,
		...overrides,
	});
}

describe('countBoardQueue', () => {
	it('counts labelled cards outside Backlog and Done that hold no slot', () => {
		const items = [
			card('1', 'planning'),
			card('2', 'todo'),
			card('3', 'backlog'),
			card('4', 'done'),
			card('5', undefined),
			card('6', 'todo', { labels: [] }),
			card('7', 'inProgress'),
		];
		expect(countBoardQueue(items, scope({ heldWorkItemIds: new Set(['7']) }))).toBe(2);
	});

	it('counts every status when the automation gate is off', () => {
		expect(countBoardQueue([card('1', 'todo', { labels: [] })], scope({ label: undefined }))).toBe(
			1,
		);
	});

	it('counts a card only for its own repository, and an unplaced card for the default one', () => {
		const items = [
			card('1', 'todo'),
			card('2', 'todo', { url: 'https://github.com/acme/gadgets/issues/2' }),
			card('3', 'todo', { url: 'https://example.com/draft', taskRepository: undefined }),
		];
		expect(countBoardQueue(items, scope())).toBe(2);
		expect(
			countBoardQueue(items, scope({ repository: 'acme/gadgets', isDefaultRepository: false })),
		).toBe(1);
	});
});

describe('cachedBoardItems', () => {
	beforeEach(() => clearBoardQueueCache());

	it('reads a project’s board once per window', async () => {
		const read = vi.fn().mockResolvedValue([]);
		await cachedBoardItems('p1', read, 0);
		await cachedBoardItems('p1', read, BOARD_QUEUE_TTL_MS - 1);
		expect(read).toHaveBeenCalledTimes(1);
		await cachedBoardItems('p1', read, BOARD_QUEUE_TTL_MS);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it('does not cache a failed read', async () => {
		const read = vi.fn().mockRejectedValueOnce(new Error('rate limited')).mockResolvedValue([]);
		await expect(cachedBoardItems('p1', read, 0)).rejects.toThrow('rate limited');
		await expect(cachedBoardItems('p1', read, 1)).resolves.toEqual([]);
		expect(read).toHaveBeenCalledTimes(2);
	});
});
