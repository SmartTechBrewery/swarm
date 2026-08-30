import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSwarmManagedPullRequest, resolveSwarmManagedPr } from '@/triggers/swarm-managed-pr.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The run-history read is injected, so these tests need no database.
const hasRunForTask = vi.fn();

beforeEach(() => {
	hasRunForTask.mockReset();
	hasRunForTask.mockResolvedValue(true);
});

const PROJECT = createMockProjectConfig();

describe('isSwarmManagedPullRequest (issue #397)', () => {
	it('treats an exact SWARM branch with an Implementation run as managed', async () => {
		await expect(
			isSwarmManagedPullRequest(PROJECT, 'issue-42', { hasRunForTask }),
		).resolves.toEqual({ managed: true, taskId: '42' });
		expect(hasRunForTask).toHaveBeenCalledWith(PROJECT.id, '42', 'implementation');
	});

	it('rejects a suffixed SWARM branch as not-a-task-branch (exact match required)', async () => {
		await expect(
			isSwarmManagedPullRequest(PROJECT, 'issue-42-runs-list', { hasRunForTask }),
		).resolves.toEqual({ managed: false, reason: 'not-a-task-branch' });
		expect(hasRunForTask).not.toHaveBeenCalled();
	});

	it('honours a custom branchPrefix with exact matching', async () => {
		const project = createMockProjectConfig({ branchPrefix: 'swarm/' });
		await expect(
			isSwarmManagedPullRequest(project, 'swarm/108', { hasRunForTask }),
		).resolves.toEqual({ managed: true, taskId: '108' });
		expect(hasRunForTask).toHaveBeenCalledWith(project.id, '108', 'implementation');
	});

	it('rejects a SWARM-style branch with no Implementation run as no-run', async () => {
		hasRunForTask.mockResolvedValue(false);
		await expect(
			isSwarmManagedPullRequest(PROJECT, 'issue-42', { hasRunForTask }),
		).resolves.toEqual({ managed: false, reason: 'no-run', taskId: '42' });
	});

	it('rejects a human-named branch without querying run history', async () => {
		await expect(
			isSwarmManagedPullRequest(PROJECT, 'contributor-patch', { hasRunForTask }),
		).resolves.toEqual({ managed: false, reason: 'not-a-task-branch' });
		// A branch outside the prefix — including one following another project's
		// convention — is a definitive no, so it must cost no query.
		await expect(isSwarmManagedPullRequest(PROJECT, 'task-42', { hasRunForTask })).resolves.toEqual(
			{
				managed: false,
				reason: 'not-a-task-branch',
			},
		);
		expect(hasRunForTask).not.toHaveBeenCalled();
	});

	it('rejects a prefixed branch that encodes no work-item number', async () => {
		await expect(
			isSwarmManagedPullRequest(PROJECT, 'issue-fix-login', { hasRunForTask }),
		).resolves.toEqual({ managed: false, reason: 'not-a-task-branch' });
		expect(hasRunForTask).not.toHaveBeenCalled();
	});

	it('rejects a missing head branch without querying run history', async () => {
		await expect(isSwarmManagedPullRequest(PROJECT, undefined, { hasRunForTask })).resolves.toEqual(
			{ managed: false, reason: 'not-a-task-branch' },
		);
		expect(hasRunForTask).not.toHaveBeenCalled();
	});

	it('propagates a run-history lookup failure so the caller owns the defer decision', async () => {
		hasRunForTask.mockRejectedValue(new Error('connection reset'));
		await expect(isSwarmManagedPullRequest(PROJECT, 'issue-42', { hasRunForTask })).rejects.toThrow(
			/connection reset/,
		);
	});
});

describe('resolveSwarmManagedPr (issue #836)', () => {
	it('passes the underlying ownership result through', async () => {
		await expect(
			resolveSwarmManagedPr(PROJECT, 'issue-42', 'resolve-conflicts', { hasRunForTask }),
		).resolves.toEqual({ managed: true, taskId: '42' });
	});

	it('classifies a run-history lookup failure as `error` rather than throwing', async () => {
		hasRunForTask.mockRejectedValue(new Error('connection reset'));
		await expect(
			resolveSwarmManagedPr(PROJECT, 'issue-42', 'resolve-conflicts', { hasRunForTask }),
		).resolves.toBe('error');
	});
});
