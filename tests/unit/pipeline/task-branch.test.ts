import { describe, expect, it } from 'vitest';
import {
	isArtifactNumberTaskId,
	isTaskId,
	taskBranch,
	taskIdFromBranch,
} from '@/pipeline/task-branch.js';

describe('taskBranch', () => {
	it('composes branch prefix and task ID', () => {
		expect(taskBranch('issue-', '42')).toBe('issue-42');
		expect(taskBranch('swarm/', '100')).toBe('swarm/100');
	});
});

describe('taskIdFromBranch', () => {
	it('extracts the issue number from the bare convention branch', () => {
		expect(taskIdFromBranch('issue-100', 'issue-')).toBe('100');
	});

	it('extracts the issue number when a slug follows (default non-strict mode)', () => {
		expect(taskIdFromBranch('issue-100-runs-list-screen', 'issue-')).toBe('100');
	});

	it('honours a custom branch prefix', () => {
		expect(taskIdFromBranch('task/42-fix', 'task/')).toBe('42');
	});

	it('returns undefined for a branch that does not start with the prefix', () => {
		expect(taskIdFromBranch('feature/login', 'issue-')).toBeUndefined();
	});

	it('returns undefined when the prefix is not followed by digits', () => {
		expect(taskIdFromBranch('issue-fix-login', 'issue-')).toBeUndefined();
	});

	it('extracts a leading board-key task id when a slug follows', () => {
		expect(taskIdFromBranch('issue-VT-1538-slug', 'issue-')).toBe('VT-1538');
	});

	it('still treats a lowercase or slugged human branch as no task branch', () => {
		expect(taskIdFromBranch('issue-hotfix-2', 'issue-')).toBeUndefined();
		expect(taskIdFromBranch('issue-vt-1538', 'issue-')).toBeUndefined();
	});

	describe('strict mode', () => {
		it('returns the issue number for an exact match', () => {
			expect(taskIdFromBranch('issue-42', 'issue-', { strict: true })).toBe('42');
		});

		it('returns undefined for a suffixed branch in strict mode', () => {
			expect(taskIdFromBranch('issue-42-hotfix', 'issue-', { strict: true })).toBeUndefined();
			expect(taskIdFromBranch('issue-100-runs-list', 'issue-', { strict: true })).toBeUndefined();
		});

		it('returns a board-key task id for an exact match', () => {
			expect(taskIdFromBranch('issue-VT-1538', 'issue-', { strict: true })).toBe('VT-1538');
			expect(taskIdFromBranch('feature/VT-1538', 'feature/', { strict: true })).toBe('VT-1538');
			expect(taskIdFromBranch('issue-AB_2C-7', 'issue-', { strict: true })).toBe('AB_2C-7');
		});

		it.each([
			'issue-VT-1538-fix',
			'issue-vt-1538',
			'issue-Vt-1538',
			'issue-hotfix-2',
			'issue-VT-',
			'issue-VT1538',
			'issue-1VT-2',
			'issue-',
		])('rejects %s', (branch) => {
			expect(taskIdFromBranch(branch, 'issue-', { strict: true })).toBeUndefined();
		});
	});

	describe.each(['issue-', 'feature/', ''])('round trip under prefix %j', (prefix) => {
		it.each(['42', 'VT-1538'])('recovers %s from its own task branch', (taskId) => {
			expect(taskIdFromBranch(taskBranch(prefix, taskId), prefix, { strict: true })).toBe(taskId);
			expect(taskIdFromBranch(taskBranch(prefix, taskId), prefix)).toBe(taskId);
		});
	});
});

describe('isTaskId', () => {
	it.each(['42', '0', 'VT-1538', 'ENG-12', 'A-1', 'AB_2C-7'])('accepts %s', (value) => {
		expect(isTaskId(value)).toBe(true);
	});

	it.each([
		'',
		'vt-1538',
		'VT-1538-fix',
		'42-fix',
		'VT1538',
		'VT-',
		'-12',
		'1VT-2',
		'hotfix',
	])('rejects %j', (value) => {
		expect(isTaskId(value)).toBe(false);
	});
});

describe('isArtifactNumberTaskId', () => {
	it('accepts the SCM artifact-number form only', () => {
		expect(isArtifactNumberTaskId('42')).toBe(true);
		expect(isArtifactNumberTaskId('VT-1538')).toBe(false);
		expect(isArtifactNumberTaskId('42-fix')).toBe(false);
		expect(isArtifactNumberTaskId('')).toBe(false);
	});
});
