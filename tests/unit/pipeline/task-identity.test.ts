import { describe, expect, it } from 'vitest';
import { taskBranch, taskIdFromBranch } from '@/pipeline/task-branch.js';
import { taskIdForRepository } from '@/pipeline/task-identity.js';
import { createMockWorkItem } from '../../helpers/factories.js';

const REPO = 'SmartTechBrewery/swarm';
const JIRA_URL = 'https://acme.atlassian.net/browse/VT-1538';

describe('taskIdForRepository', () => {
	it('returns the artifact number for a link in the matching repository', () => {
		const item = createMockWorkItem({
			taskRef: '42',
			taskRepository: 'smarttechbrewery/SWARM.git',
		});
		expect(taskIdForRepository(item, REPO)).toBe('42');
	});

	it('skips a link into another repository rather than falling back to the own key', () => {
		const item = createMockWorkItem({
			url: JIRA_URL,
			taskRef: '42',
			taskRepository: 'SmartTechBrewery/other',
			ownTaskRef: 'VT-1538',
		});
		expect(taskIdForRepository(item, REPO)).toBeUndefined();
	});

	it('returns the card’s own key when it has no link', () => {
		const item = createMockWorkItem({ url: JIRA_URL, ownTaskRef: 'VT-1538' });
		expect(taskIdForRepository(item, REPO)).toBe('VT-1538');
	});

	it.each(['vt-1538', 'a/b', 'VT-'])('ignores an own key that is not a task id (%s)', (key) => {
		const item = createMockWorkItem({ url: JIRA_URL, ownTaskRef: key });
		expect(taskIdForRepository(item, REPO)).toBeUndefined();
	});

	it('treats a lone taskRef as unplaceable', () => {
		const item = createMockWorkItem({ url: JIRA_URL, taskRef: '42', ownTaskRef: 'VT-1538' });
		expect(taskIdForRepository(item, REPO)).toBeUndefined();
	});

	it('returns nothing for a card naming no task at all', () => {
		expect(taskIdForRepository(createMockWorkItem({ url: JIRA_URL }), REPO)).toBeUndefined();
	});

	it('names a branch every branch reader parses back to the same key', () => {
		const item = createMockWorkItem({ url: JIRA_URL, ownTaskRef: 'VT-1538' });
		const taskId = taskIdForRepository(item, REPO);
		expect(taskId).toBe('VT-1538');
		const branch = taskBranch('issue-', taskId as string);
		expect(branch).toBe('issue-VT-1538');
		expect(taskIdFromBranch(branch, 'issue-', { strict: true })).toBe('VT-1538');
	});
});
