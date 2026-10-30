import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findBoardItemIdForTask, findTaskIdForStoredTaskBranch } = vi.hoisted(() => ({
	findBoardItemIdForTask: vi.fn(),
	findTaskIdForStoredTaskBranch: vi.fn(),
}));
vi.mock('@/db/repositories/runsRepository.js', () => ({
	findBoardItemIdForTask,
	findTaskIdForStoredTaskBranch,
}));

import { resolveBoardItemIdForPrBranch } from '@/dispatch/board-card.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The PR→card seam (issue #498): the card comes from SWARM's own durable
// `runs.work_item_id` link keyed by the task the branch encodes — never from a
// provider-shaped URL — and it resolves here, control-plane side, because the
// worker that runs the phase may have no database at all (ADR-003 §2).
describe('resolveBoardItemIdForPrBranch', () => {
	const project = createMockProjectConfig({ id: 'proj-1', branchPrefix: 'issue-' });

	beforeEach(() => {
		findBoardItemIdForTask.mockReset();
		findTaskIdForStoredTaskBranch.mockReset();
		findTaskIdForStoredTaskBranch.mockResolvedValue(undefined);
	});

	// Issue #1247: the branch Implementation recorded names the task whatever the
	// repository's naming says now.
	it('looks the card up by the task that recorded the branch, after the prefix is cleared', async () => {
		findTaskIdForStoredTaskBranch.mockResolvedValue('VT-1538');
		findBoardItemIdForTask.mockResolvedValue('ITEM_VT');
		const cleared = createMockProjectConfig({ id: 'proj-1', branchPrefix: '' });

		await expect(resolveBoardItemIdForPrBranch(cleared, 'issue-VT-1538')).resolves.toBe('ITEM_VT');
		expect(findBoardItemIdForTask).toHaveBeenCalledWith('proj-1', 'VT-1538');
	});

	it('looks the card up by the task id the PR branch encodes', async () => {
		findBoardItemIdForTask.mockResolvedValue('ITEM_21');

		await expect(resolveBoardItemIdForPrBranch(project, 'issue-21')).resolves.toBe('ITEM_21');
		expect(findBoardItemIdForTask).toHaveBeenCalledWith('proj-1', '21');
	});

	it('looks the card up by a board-key task id the PR branch encodes (issue #1226)', async () => {
		findBoardItemIdForTask.mockResolvedValue('ITEM_VT');

		await expect(resolveBoardItemIdForPrBranch(project, 'issue-VT-1538')).resolves.toBe('ITEM_VT');
		expect(findBoardItemIdForTask).toHaveBeenCalledWith('proj-1', 'VT-1538');
	});

	it('returns undefined for a branch that encodes no task', async () => {
		await expect(resolveBoardItemIdForPrBranch(project, 'hotfix/typo')).resolves.toBeUndefined();
		await expect(resolveBoardItemIdForPrBranch(project, 'issue-hotfix-2')).resolves.toBeUndefined();
		expect(findBoardItemIdForTask).not.toHaveBeenCalled();
	});

	it('returns undefined when no branch is known', async () => {
		await expect(resolveBoardItemIdForPrBranch(project, undefined)).resolves.toBeUndefined();
		expect(findBoardItemIdForTask).not.toHaveBeenCalled();
	});

	it('swallows a lookup failure so a cosmetic report can never fail a dispatch', async () => {
		findBoardItemIdForTask.mockRejectedValue(new Error('connection terminated'));

		await expect(resolveBoardItemIdForPrBranch(project, 'issue-21')).resolves.toBeUndefined();
	});
});
