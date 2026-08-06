import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findBoardItemIdForTask } = vi.hoisted(() => ({ findBoardItemIdForTask: vi.fn() }));
vi.mock('@/db/repositories/runsRepository.js', () => ({ findBoardItemIdForTask }));

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
	});

	it('looks the card up by the task id the PR branch encodes', async () => {
		findBoardItemIdForTask.mockResolvedValue('ITEM_21');

		await expect(resolveBoardItemIdForPrBranch(project, 'issue-21')).resolves.toBe('ITEM_21');
		expect(findBoardItemIdForTask).toHaveBeenCalledWith('proj-1', '21');
	});

	it('returns undefined for a branch that encodes no task', async () => {
		await expect(resolveBoardItemIdForPrBranch(project, 'hotfix/typo')).resolves.toBeUndefined();
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
