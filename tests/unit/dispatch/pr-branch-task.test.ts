import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findTaskIdForStoredTaskBranch, loggerWarn } = vi.hoisted(() => ({
	findTaskIdForStoredTaskBranch: vi.fn(),
	loggerWarn: vi.fn(),
}));
vi.mock('@/db/repositories/runsRepository.js', () => ({ findTaskIdForStoredTaskBranch }));
vi.mock('@/lib/logger.js', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: loggerWarn, error: vi.fn() },
}));

import { findTaskIdForPrBranch } from '@/dispatch/pr-branch-task.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The PR branch → task seam (issue #1247): the branch Implementation recorded wins over
// whatever the repository's current naming decodes it to.
describe('findTaskIdForPrBranch', () => {
	const project = createMockProjectConfig({
		id: 'proj-1',
		repo: 'org/kuchnia-vikinga',
		branchPrefix: 'issue-',
	});

	beforeEach(() => {
		findTaskIdForStoredTaskBranch.mockReset();
		findTaskIdForStoredTaskBranch.mockResolvedValue(undefined);
		loggerWarn.mockReset();
	});

	it('returns the recorded task over a different decode', async () => {
		findTaskIdForStoredTaskBranch.mockResolvedValue('VT-1538');

		await expect(findTaskIdForPrBranch(project, 'issue-42')).resolves.toBe('VT-1538');
		expect(findTaskIdForStoredTaskBranch).toHaveBeenCalledWith(
			'proj-1',
			'org/kuchnia-vikinga',
			'issue-42',
		);
	});

	it('recognises a recorded branch after the prefix is cleared', async () => {
		findTaskIdForStoredTaskBranch.mockResolvedValue('VT-1538');
		const cleared = createMockProjectConfig({ ...project, branchPrefix: '' });

		await expect(findTaskIdForPrBranch(cleared, 'issue-VT-1538')).resolves.toBe('VT-1538');
	});

	it('decodes the branch on a miss, honouring strict', async () => {
		await expect(findTaskIdForPrBranch(project, 'issue-42-some-slug')).resolves.toBe('42');
		await expect(
			findTaskIdForPrBranch(project, 'issue-42-some-slug', { strict: true }),
		).resolves.toBeUndefined();
		await expect(findTaskIdForPrBranch(project, 'hotfix/typo')).resolves.toBeUndefined();
	});

	it('logs a failed lookup and falls back to the decode', async () => {
		findTaskIdForStoredTaskBranch.mockRejectedValue(new Error('connection terminated'));

		await expect(findTaskIdForPrBranch(project, 'issue-21')).resolves.toBe('21');
		expect(loggerWarn).toHaveBeenCalledOnce();
	});

	it('returns undefined with no query when there is no branch', async () => {
		await expect(findTaskIdForPrBranch(project, undefined)).resolves.toBeUndefined();
		expect(findTaskIdForStoredTaskBranch).not.toHaveBeenCalled();
	});
});
