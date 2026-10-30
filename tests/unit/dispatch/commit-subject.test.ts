import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findStoredCommitSubject, findTaskIdForStoredTaskBranch } = vi.hoisted(() => ({
	findStoredCommitSubject: vi.fn(),
	findTaskIdForStoredTaskBranch: vi.fn(),
}));
vi.mock('@/db/repositories/runsRepository.js', () => ({
	findStoredCommitSubject,
	findTaskIdForStoredTaskBranch,
}));

import { resolveCommitSubjectForPrBranch } from '@/dispatch/commit-subject.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The PR→subject seam (issue #1242): a fix commit carries the subject Implementation
// stored for the task the branch encodes, resolved here because the worker running
// the fix may have no database at all (ADR-003 §2).
describe('resolveCommitSubjectForPrBranch', () => {
	const project = createMockProjectConfig({
		id: 'proj-1',
		repo: 'org/kuchnia-vikinga',
		branchPrefix: 'issue-',
		branchPattern: '{issue_key}/{friendly_name}',
	});

	beforeEach(() => {
		findStoredCommitSubject.mockReset();
		findTaskIdForStoredTaskBranch.mockReset();
		findTaskIdForStoredTaskBranch.mockResolvedValue(undefined);
	});

	// Issue #1247: a branch the pattern no longer decodes still names its task by record.
	it('looks the subject up by the task that recorded the branch, after the pattern changed', async () => {
		findTaskIdForStoredTaskBranch.mockResolvedValue('VT-1538');
		findStoredCommitSubject.mockResolvedValue('VT-1538 Add the starting page');
		const changed = createMockProjectConfig({
			...project,
			branchPrefix: '',
			branchPattern: '{work_type}/{issue_key}/{friendly_name}',
		});

		await expect(resolveCommitSubjectForPrBranch(changed, 'issue-VT-1538')).resolves.toBe(
			'VT-1538 Add the starting page',
		);
		expect(findStoredCommitSubject).toHaveBeenCalledWith(
			'proj-1',
			'org/kuchnia-vikinga',
			'VT-1538',
		);
	});

	it('looks the subject up by the task the PR branch encodes, in this repository', async () => {
		findStoredCommitSubject.mockResolvedValue('VT-1538 Add the starting page');

		await expect(
			resolveCommitSubjectForPrBranch(project, 'VT-1538/pierwsza-strona-testowa'),
		).resolves.toBe('VT-1538 Add the starting page');
		expect(findStoredCommitSubject).toHaveBeenCalledWith(
			'proj-1',
			'org/kuchnia-vikinga',
			'VT-1538',
		);
	});

	it('returns undefined for a branch that encodes no task, or none at all', async () => {
		await expect(resolveCommitSubjectForPrBranch(project, 'hotfix/typo')).resolves.toBeUndefined();
		await expect(resolveCommitSubjectForPrBranch(project, undefined)).resolves.toBeUndefined();
		expect(findStoredCommitSubject).not.toHaveBeenCalled();
	});

	it('swallows a lookup failure so the phase falls back instead of the dispatch failing', async () => {
		findStoredCommitSubject.mockRejectedValue(new Error('connection terminated'));

		await expect(resolveCommitSubjectForPrBranch(project, 'issue-21')).resolves.toBeUndefined();
	});
});
