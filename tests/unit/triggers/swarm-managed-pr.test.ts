import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isSwarmManagedPullRequest } from '@/triggers/swarm-managed-pr.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The run-history read is injected, so these tests need no database.
const hasRunForTask = vi.fn();

beforeEach(() => {
	hasRunForTask.mockReset();
	hasRunForTask.mockResolvedValue(true);
});

const PROJECT = createMockProjectConfig();

describe('isSwarmManagedPullRequest (issue #397)', () => {
	it('treats a SWARM branch with an Implementation run as managed', async () => {
		await expect(isSwarmManagedPullRequest(PROJECT, 'issue-42', { hasRunForTask })).resolves.toBe(
			true,
		);
		expect(hasRunForTask).toHaveBeenCalledWith(PROJECT.id, '42', 'implementation');
	});

	it('decodes the work item from a suffixed SWARM branch', async () => {
		await expect(
			isSwarmManagedPullRequest(PROJECT, 'issue-42-runs-list', { hasRunForTask }),
		).resolves.toBe(true);
		expect(hasRunForTask).toHaveBeenCalledWith(PROJECT.id, '42', 'implementation');
	});

	it('honours a custom branchPrefix', async () => {
		const project = createMockProjectConfig({ branchPrefix: 'swarm/' });
		await expect(
			isSwarmManagedPullRequest(project, 'swarm/108-fix', { hasRunForTask }),
		).resolves.toBe(true);
		expect(hasRunForTask).toHaveBeenCalledWith(project.id, '108', 'implementation');
	});

	it('rejects a SWARM-style branch with no Implementation run', async () => {
		hasRunForTask.mockResolvedValue(false);
		await expect(isSwarmManagedPullRequest(PROJECT, 'issue-42', { hasRunForTask })).resolves.toBe(
			false,
		);
	});

	it('rejects a human-named branch without querying run history', async () => {
		await expect(
			isSwarmManagedPullRequest(PROJECT, 'contributor-patch', { hasRunForTask }),
		).resolves.toBe(false);
		// A branch outside the prefix — including one following another project's
		// convention — is a definitive no, so it must cost no query.
		await expect(isSwarmManagedPullRequest(PROJECT, 'task-42', { hasRunForTask })).resolves.toBe(
			false,
		);
		expect(hasRunForTask).not.toHaveBeenCalled();
	});

	it('rejects a prefixed branch that encodes no work-item number', async () => {
		await expect(
			isSwarmManagedPullRequest(PROJECT, 'issue-fix-login', { hasRunForTask }),
		).resolves.toBe(false);
		expect(hasRunForTask).not.toHaveBeenCalled();
	});

	it('rejects a missing head branch without querying run history', async () => {
		await expect(isSwarmManagedPullRequest(PROJECT, undefined, { hasRunForTask })).resolves.toBe(
			false,
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
