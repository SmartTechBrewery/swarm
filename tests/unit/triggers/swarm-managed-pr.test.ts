import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSwarmManagedPullRequest, resolveSwarmManagedPr } from '@/triggers/swarm-managed-pr.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The run-history reads are injected, so these tests need no database.
const hasRunForTask = vi.fn();
const findTaskIdForStoredTaskBranch = vi.fn();
const deps = { hasRunForTask, findTaskIdForStoredTaskBranch };

beforeEach(() => {
	hasRunForTask.mockReset();
	hasRunForTask.mockResolvedValue(true);
	// No recorded branch by default, so every decode case below runs unchanged.
	findTaskIdForStoredTaskBranch.mockReset();
	findTaskIdForStoredTaskBranch.mockResolvedValue(undefined);
});

const PROJECT = createMockProjectConfig();

describe('isSwarmManagedPullRequest (issue #397)', () => {
	it('treats an exact SWARM branch with an Implementation run as managed', async () => {
		await expect(isSwarmManagedPullRequest(PROJECT, 'issue-42', deps)).resolves.toEqual({
			managed: true,
			taskId: '42',
		});
		expect(hasRunForTask).toHaveBeenCalledWith(PROJECT.id, '42', 'implementation');
	});

	it('rejects a suffixed SWARM branch as not-a-task-branch (exact match required)', async () => {
		await expect(isSwarmManagedPullRequest(PROJECT, 'issue-42-runs-list', deps)).resolves.toEqual({
			managed: false,
			reason: 'not-a-task-branch',
		});
		expect(hasRunForTask).not.toHaveBeenCalled();
	});

	it('honours a custom branchPrefix with exact matching', async () => {
		const project = createMockProjectConfig({ branchPrefix: 'swarm/' });
		await expect(isSwarmManagedPullRequest(project, 'swarm/108', deps)).resolves.toEqual({
			managed: true,
			taskId: '108',
		});
		expect(hasRunForTask).toHaveBeenCalledWith(project.id, '108', 'implementation');
	});

	// Issue #1241: a branch named by the repository's pattern is SWARM's own, and a
	// branch opened under the legacy prefix before the pattern was set still is.
	it('recognises a pattern-named branch, and the legacy prefix shape beside it', async () => {
		const project = createMockProjectConfig({ branchPattern: '{issue_key}/{friendly_name}' });
		await expect(
			isSwarmManagedPullRequest(project, 'VT-1538/pierwsza-strona-testowa', deps),
		).resolves.toEqual({ managed: true, taskId: 'VT-1538' });
		await expect(isSwarmManagedPullRequest(project, 'issue-VT-1538', deps)).resolves.toEqual({
			managed: true,
			taskId: 'VT-1538',
		});
		await expect(
			isSwarmManagedPullRequest(project, 'VT-1538/Some-Human-Branch', deps),
		).resolves.toEqual({ managed: false, reason: 'not-a-task-branch' });
	});

	it('rejects a SWARM-style branch with no Implementation run as no-run', async () => {
		hasRunForTask.mockResolvedValue(false);
		await expect(isSwarmManagedPullRequest(PROJECT, 'issue-42', deps)).resolves.toEqual({
			managed: false,
			reason: 'no-run',
			taskId: '42',
		});
	});

	it('rejects a human-named branch without querying run history', async () => {
		await expect(isSwarmManagedPullRequest(PROJECT, 'contributor-patch', deps)).resolves.toEqual({
			managed: false,
			reason: 'not-a-task-branch',
		});
		// A branch outside the prefix — including one following another project's
		// convention — is a definitive no once nothing recorded it, so it must cost no
		// run-history query.
		await expect(isSwarmManagedPullRequest(PROJECT, 'task-42', deps)).resolves.toEqual({
			managed: false,
			reason: 'not-a-task-branch',
		});
		expect(hasRunForTask).not.toHaveBeenCalled();
	});

	it('treats a board-key task branch with an Implementation run as managed (issue #1226)', async () => {
		await expect(isSwarmManagedPullRequest(PROJECT, 'issue-VT-1538', deps)).resolves.toEqual({
			managed: true,
			taskId: 'VT-1538',
		});
		expect(hasRunForTask).toHaveBeenCalledWith(PROJECT.id, 'VT-1538', 'implementation');
	});

	it('still rejects a lowercase human branch under the prefix without a query', async () => {
		await expect(isSwarmManagedPullRequest(PROJECT, 'issue-hotfix-2', deps)).resolves.toEqual({
			managed: false,
			reason: 'not-a-task-branch',
		});
		expect(hasRunForTask).not.toHaveBeenCalled();
	});

	it('rejects a prefixed branch that encodes no work-item number', async () => {
		await expect(isSwarmManagedPullRequest(PROJECT, 'issue-fix-login', deps)).resolves.toEqual({
			managed: false,
			reason: 'not-a-task-branch',
		});
		expect(hasRunForTask).not.toHaveBeenCalled();
	});

	it('rejects a missing head branch without querying run history', async () => {
		await expect(isSwarmManagedPullRequest(PROJECT, undefined, deps)).resolves.toEqual({
			managed: false,
			reason: 'not-a-task-branch',
		});
		expect(hasRunForTask).not.toHaveBeenCalled();
		expect(findTaskIdForStoredTaskBranch).not.toHaveBeenCalled();
	});

	// Issue #1247: the branch Implementation recorded decides, whatever the naming says now.
	describe('a recorded task branch', () => {
		const cleared = createMockProjectConfig({
			branchPrefix: '',
			branchPattern: '{work_type}/{issue_key}/{friendly_name}',
		});

		it('is managed after the prefix is cleared and the pattern changed', async () => {
			findTaskIdForStoredTaskBranch.mockResolvedValue('VT-1538');
			await expect(isSwarmManagedPullRequest(cleared, 'issue-VT-1538', deps)).resolves.toEqual({
				managed: true,
				taskId: 'VT-1538',
			});
			expect(findTaskIdForStoredTaskBranch).toHaveBeenCalledWith(
				cleared.id,
				cleared.repo,
				'issue-VT-1538',
			);
			// The recorded row is itself the Implementation run, so no second read.
			expect(hasRunForTask).not.toHaveBeenCalled();
		});

		it('falls back to the decode when nothing recorded the branch', async () => {
			await expect(isSwarmManagedPullRequest(cleared, 'issue-VT-1538', deps)).resolves.toEqual({
				managed: false,
				reason: 'not-a-task-branch',
			});
		});

		it('propagates a failing lookup so resolveSwarmManagedPr reports `error`', async () => {
			findTaskIdForStoredTaskBranch.mockRejectedValue(new Error('connection reset'));
			await expect(
				resolveSwarmManagedPr(cleared, 'issue-VT-1538', 'pr-review', deps),
			).resolves.toBe('error');
			expect(hasRunForTask).not.toHaveBeenCalled();
		});
	});

	it('propagates a run-history lookup failure so the caller owns the defer decision', async () => {
		hasRunForTask.mockRejectedValue(new Error('connection reset'));
		await expect(isSwarmManagedPullRequest(PROJECT, 'issue-42', deps)).rejects.toThrow(
			/connection reset/,
		);
	});
});

describe('resolveSwarmManagedPr (issue #836)', () => {
	it('passes the underlying ownership result through', async () => {
		await expect(
			resolveSwarmManagedPr(PROJECT, 'issue-42', 'resolve-conflicts', deps),
		).resolves.toEqual({ managed: true, taskId: '42' });
	});

	it('classifies a run-history lookup failure as `error` rather than throwing', async () => {
		hasRunForTask.mockRejectedValue(new Error('connection reset'));
		await expect(
			resolveSwarmManagedPr(PROJECT, 'issue-42', 'resolve-conflicts', deps),
		).resolves.toBe('error');
	});
});
