import { describe, expect, it, vi } from 'vitest';
import { hasLiveWorktreeLeaseOwner } from '@/worktree/lease-liveness.js';

const RUN_ID = 'run-current';

function deps(hasRunningRun = false, hasExecutingDispatch = false) {
	return {
		hasRunningRun: vi.fn().mockResolvedValue(hasRunningRun),
		hasExecutingDispatch: vi.fn().mockResolvedValue(hasExecutingDispatch),
	};
}

describe('hasLiveWorktreeLeaseOwner', () => {
	it('is live when another run for the task is running', async () => {
		const d = deps(true, false);
		expect(await hasLiveWorktreeLeaseOwner('project-1', '14', RUN_ID, d)).toBe(true);
		// Short-circuits: no need to ask the dispatch side once a run owns it.
		expect(d.hasExecutingDispatch).not.toHaveBeenCalled();
	});

	it('is live when another attempt holds an executing dispatch', async () => {
		expect(await hasLiveWorktreeLeaseOwner('project-1', '14', RUN_ID, deps(false, true))).toBe(
			true,
		);
	});

	it('is stale when neither a running run nor an executing dispatch exists', async () => {
		expect(await hasLiveWorktreeLeaseOwner('project-1', '14', RUN_ID, deps())).toBe(false);
	});

	it('excludes the asking run from both lookups', async () => {
		const d = deps();
		await hasLiveWorktreeLeaseOwner('project-1', '14', RUN_ID, d);
		expect(d.hasRunningRun).toHaveBeenCalledWith('project-1', '14', RUN_ID);
		expect(d.hasExecutingDispatch).toHaveBeenCalledWith('project-1', '14', RUN_ID);
	});

	it('reports live without any lookup when the asking run is unknown', async () => {
		const d = deps();
		expect(await hasLiveWorktreeLeaseOwner('project-1', '14', undefined, d)).toBe(true);
		expect(d.hasRunningRun).not.toHaveBeenCalled();
		expect(d.hasExecutingDispatch).not.toHaveBeenCalled();
	});

	it('fails closed (live) when a lookup rejects', async () => {
		const d = {
			hasRunningRun: vi.fn().mockRejectedValue(new Error('db down')),
			hasExecutingDispatch: vi.fn().mockResolvedValue(false),
		};
		expect(await hasLiveWorktreeLeaseOwner('project-1', '14', RUN_ID, d)).toBe(true);
	});
});
