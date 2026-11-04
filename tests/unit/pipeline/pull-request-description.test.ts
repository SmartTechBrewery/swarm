import { describe, expect, it } from 'vitest';
import {
	composePullRequestBody,
	pullRequestWorkItemLine,
} from '@/pipeline/pull-request-description.js';
import { SCM_CLOSING_REFERENCE } from '@/scm/closing-reference.js';
import { SCM_TYPES } from '@/scm/types.js';
import { createMockWorkItem } from '../../helpers/factories.js';

const GITHUB = { scm: 'github', repo: 'SmartTechBrewery/swarm' } as const;

describe('pullRequestWorkItemLine (issue #1277)', () => {
	it('closes a GitHub issue in the same repository, whatever the slug’s casing', () => {
		const workItem = createMockWorkItem({
			taskRef: '42',
			taskRepository: 'smarttechbrewery/SWARM',
		});
		expect(pullRequestWorkItemLine(workItem, GITHUB)).toBe('Closes: #42');
	});

	it('links a GitHub issue in another repository instead of closing it', () => {
		const workItem = createMockWorkItem({
			title: 'Fix the board',
			url: 'https://github.com/other/repo/issues/7',
		});
		expect(pullRequestWorkItemLine(workItem, GITHUB)).toBe(
			'Work item: [Fix the board](https://github.com/other/repo/issues/7)',
		);
	});

	it('links a Jira card by its own key on Azure DevOps', () => {
		const workItem = createMockWorkItem({
			title: 'Add robots.txt',
			url: 'https://core3.atlassian.net/browse/VT-1557',
			taskRef: undefined,
			taskRepository: undefined,
			ownTaskRef: 'VT-1557',
		});
		const line = pullRequestWorkItemLine(workItem, {
			scm: 'azure-devops',
			repo: 'core3pl/KV-TMS/ai-sdlc',
		});
		expect(line).toBe('Work item: [VT-1557](https://core3.atlassian.net/browse/VT-1557)');
	});

	it('links rather than closes a same-repository issue on a provider with no closing keyword', () => {
		const workItem = createMockWorkItem({ title: 'T', taskRef: '42', taskRepository: 'a/b' });
		expect(pullRequestWorkItemLine(workItem, { scm: 'gitlab', repo: 'a/b' })).toMatch(
			/^Work item: \[T\]\(/,
		);
	});

	it('escapes link text and drops the link when the work item has no URL', () => {
		const workItem = createMockWorkItem({
			title: 'Fix [draft] path\\x',
			url: '',
			taskRef: undefined,
			taskRepository: undefined,
		});
		expect(pullRequestWorkItemLine(workItem, GITHUB)).toBe('Work item: Fix \\[draft\\] path\\\\x');
	});
});

describe('composePullRequestBody', () => {
	it('appends the work-item line as the last line, after the description', () => {
		const body = composePullRequestBody({
			description: '\nAdds robots.txt.\n\n## Out of scope\nNone\n',
			workItem: createMockWorkItem({ taskRef: '42', taskRepository: GITHUB.repo }),
			project: GITHUB,
		});
		expect(body).toBe('Adds robots.txt.\n\n## Out of scope\nNone\n\nCloses: #42');
	});
});

describe('SCM_CLOSING_REFERENCE', () => {
	it('names every SCM provider, and only GitHub closes from a description', () => {
		expect(Object.keys(SCM_CLOSING_REFERENCE).sort()).toEqual([...SCM_TYPES].sort());
		expect(SCM_CLOSING_REFERENCE.github?.('5')).toBe('Closes: #5');
	});
});
