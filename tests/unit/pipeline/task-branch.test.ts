import { describe, expect, it } from 'vitest';
import { issueNumberFromBranch, taskBranch } from '@/pipeline/task-branch.js';

describe('taskBranch', () => {
	it('composes branch prefix and task ID', () => {
		expect(taskBranch('issue-', '42')).toBe('issue-42');
		expect(taskBranch('swarm/', '100')).toBe('swarm/100');
	});
});

describe('issueNumberFromBranch', () => {
	it('extracts the issue number from the bare convention branch', () => {
		expect(issueNumberFromBranch('issue-100', 'issue-')).toBe('100');
	});

	it('extracts the issue number when a slug follows (default non-strict mode)', () => {
		expect(issueNumberFromBranch('issue-100-runs-list-screen', 'issue-')).toBe('100');
	});

	it('honours a custom branch prefix', () => {
		expect(issueNumberFromBranch('task/42-fix', 'task/')).toBe('42');
	});

	it('returns undefined for a branch that does not start with the prefix', () => {
		expect(issueNumberFromBranch('feature/login', 'issue-')).toBeUndefined();
	});

	it('returns undefined when the prefix is not followed by digits', () => {
		expect(issueNumberFromBranch('issue-fix-login', 'issue-')).toBeUndefined();
	});

	describe('strict mode', () => {
		it('returns the issue number for an exact match', () => {
			expect(issueNumberFromBranch('issue-42', 'issue-', { strict: true })).toBe('42');
		});

		it('returns undefined for a suffixed branch in strict mode', () => {
			expect(issueNumberFromBranch('issue-42-hotfix', 'issue-', { strict: true })).toBeUndefined();
			expect(
				issueNumberFromBranch('issue-100-runs-list', 'issue-', { strict: true }),
			).toBeUndefined();
		});
	});
});
