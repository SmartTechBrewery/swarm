import { describe, expect, it } from 'vitest';

import type { ProjectConfig } from '@/config/schema.js';
import type { WorkItem } from '@/pm/types.js';
import { composeSystemPrompt, resolveTargetBranch } from '@/router/assignment-composition.js';
import type { TriggerResult } from '@/triggers/types.js';

// A minimal project carrying only the fields the pure prompt builders + branch
// resolution read (repo, baseBranch, branchPrefix, planning knobs).
const PROJECT = {
	id: 'swarm',
	repo: 'jkwiecien/swarm',
	baseBranch: 'main',
	branchPrefix: 'swarm/',
	pipeline: {},
} as unknown as ProjectConfig;

const WORK_ITEM: WorkItem = {
	id: 'PVTI_item',
	title: 'Add a widget',
	description: 'Implement the widget end to end.',
	url: 'https://github.com/jkwiecien/swarm/issues/407',
	labels: [],
	assignees: [],
};

describe('resolveTargetBranch', () => {
	it('pins the board phases and review to the task branch <branchPrefix><taskId>', () => {
		const planning: TriggerResult = { phase: 'planning', taskId: '407', workItem: WORK_ITEM };
		const implementation: TriggerResult = {
			phase: 'implementation',
			taskId: '407',
			workItem: WORK_ITEM,
		};
		const review: TriggerResult = {
			phase: 'review',
			taskId: '407',
			prNumber: '88',
			headSha: 'abc',
		};
		expect(resolveTargetBranch(PROJECT, planning)).toBe('swarm/407');
		expect(resolveTargetBranch(PROJECT, implementation)).toBe('swarm/407');
		expect(resolveTargetBranch(PROJECT, review)).toBe('swarm/407');
	});

	it('carries the PR head branch for the SCM continuation phases', () => {
		const respondReview: TriggerResult = {
			phase: 'respond-to-review',
			taskId: '88',
			prNumber: '88',
			prBranch: 'swarm/407',
			reviewId: '999',
			headSha: 'abc',
		};
		const respondCi: TriggerResult = {
			phase: 'respond-to-ci',
			taskId: '88',
			prNumber: '88',
			prBranch: 'feature/x',
			headSha: 'abc',
		};
		const resolveConflicts: TriggerResult = {
			phase: 'resolve-conflicts',
			taskId: '88',
			prNumber: '88',
			prBranch: 'feature/x',
			headSha: 'abc',
			baseBranch: 'main',
			baseSha: 'def',
		};
		expect(resolveTargetBranch(PROJECT, respondReview)).toBe('swarm/407');
		expect(resolveTargetBranch(PROJECT, respondCi)).toBe('feature/x');
		expect(resolveTargetBranch(PROJECT, resolveConflicts)).toBe('feature/x');
	});
});

describe('composeSystemPrompt', () => {
	it('composes the implementation prompt with the repo, task branch, and base branch', () => {
		const prompt = composeSystemPrompt(PROJECT, {
			phase: 'implementation',
			taskId: '407',
			workItem: WORK_ITEM,
		});
		expect(prompt).toContain('implementing a work item');
		expect(prompt).toContain('jkwiecien/swarm');
		expect(prompt).toContain('swarm/407');
		expect(prompt).toContain('main');
		expect(prompt).toContain(WORK_ITEM.title);
	});

	it('composes the planning prompt for a board item', () => {
		const prompt = composeSystemPrompt(PROJECT, {
			phase: 'planning',
			taskId: '407',
			workItem: WORK_ITEM,
		});
		expect(prompt).toContain('implementation plan');
		expect(prompt).toContain(WORK_ITEM.title);
	});

	it('composes the review prompt pinned to the PR head SHA', () => {
		const prompt = composeSystemPrompt(PROJECT, {
			phase: 'review',
			taskId: '407',
			prNumber: '88',
			headSha: 'deadbeef',
		});
		expect(prompt).toContain('reviewing a pull request');
		expect(prompt).toContain('#88');
		expect(prompt).toContain('deadbeef');
	});

	it('composes the respond-to-review prompt with the PR branch and review id', () => {
		const prompt = composeSystemPrompt(PROJECT, {
			phase: 'respond-to-review',
			taskId: '88',
			prNumber: '88',
			prBranch: 'swarm/407',
			reviewId: '999',
			headSha: 'abc',
		});
		expect(prompt).toContain('swarm/407');
		expect(prompt).toContain('999');
	});

	it('appends the project per-phase custom prompt when supplied', () => {
		const prompt = composeSystemPrompt(
			PROJECT,
			{ phase: 'implementation', taskId: '407', workItem: WORK_ITEM },
			'ALWAYS run the widget linter.',
		);
		expect(prompt).toContain('ALWAYS run the widget linter.');
	});
});
