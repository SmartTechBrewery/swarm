import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startHostMaintenance } from '@/api/maintenance.js';
import type { ProjectConfig } from '@/config/schema.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Injected collaborators for every test, so nothing here touches Postgres or the
 * filesystem.
 */
function createCollaborators(projects: ProjectConfig[]) {
	return {
		failOrphanedRuns: vi.fn<(reason: string, workerId: string | null) => Promise<number>>(
			async () => 0,
		),
		listProjects: vi.fn<() => Promise<ProjectConfig[]>>(async () => projects),
		pruneWorktrees: vi.fn<(project: ProjectConfig) => Promise<unknown>>(async () => ({})),
	};
}

describe('startHostMaintenance', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('reaps worker-less orphaned runs exactly once, at startup', async () => {
		const collaborators = createCollaborators([]);

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(collaborators.failOrphanedRuns).toHaveBeenCalledTimes(1);
		// `null` — the worker-less runs. A federated run belongs to the host executing
		// it and stays with the dispatch-lease reconciler.
		expect(collaborators.failOrphanedRuns.mock.calls[0]?.[1]).toBeNull();

		await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);
		expect(collaborators.failOrphanedRuns).toHaveBeenCalledTimes(1);

		await handle.close();
	});

	it('sweeps worktrees immediately and then on the configured interval', async () => {
		const projects = [
			createMockProjectConfig({ id: 'alpha' }),
			createMockProjectConfig({ id: 'beta' }),
		];
		const collaborators = createCollaborators(projects);

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(collaborators.pruneWorktrees).toHaveBeenCalledTimes(2);
		expect(collaborators.pruneWorktrees.mock.calls.map(([p]) => p.id)).toEqual(['alpha', 'beta']);

		await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
		expect(collaborators.pruneWorktrees).toHaveBeenCalledTimes(4);

		await handle.close();
	});

	it('steps over a project whose prune throws and keeps sweeping the rest', async () => {
		const projects = [
			createMockProjectConfig({ id: 'broken' }),
			createMockProjectConfig({ id: 'healthy' }),
		];
		const collaborators = createCollaborators(projects);
		collaborators.pruneWorktrees.mockImplementation(async (project) => {
			if (project.id === 'broken') throw new Error('worktree list failed');
			return {};
		});

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(collaborators.pruneWorktrees.mock.calls.map(([p]) => p.id)).toEqual([
			'broken',
			'healthy',
		]);

		// A failing iteration must not stop the interval either.
		await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
		expect(collaborators.pruneWorktrees).toHaveBeenCalledTimes(4);

		await handle.close();
	});

	it('keeps running when a chore rejects outright', async () => {
		const collaborators = createCollaborators([]);
		collaborators.failOrphanedRuns.mockRejectedValue(new Error('database unreachable'));
		collaborators.listProjects.mockRejectedValue(new Error('database unreachable'));

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(handle).toBeDefined();

		await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
		expect(collaborators.listProjects).toHaveBeenCalledTimes(2);

		await handle.close();
	});

	it('clears the sweep timer on close', async () => {
		const collaborators = createCollaborators([createMockProjectConfig()]);

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);
		await handle.close();

		expect(vi.getTimerCount()).toBe(0);

		const sweeps = collaborators.pruneWorktrees.mock.calls.length;
		await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS * 2);
		expect(collaborators.pruneWorktrees).toHaveBeenCalledTimes(sweeps);
	});

	it('honours an injected cadence over the coded default', async () => {
		const collaborators = createCollaborators([createMockProjectConfig()]);

		const handle = startHostMaintenance({
			worktreeSweepIntervalMs: 1_000,
			...collaborators,
		});
		await vi.advanceTimersByTimeAsync(2_000);

		expect(collaborators.pruneWorktrees).toHaveBeenCalledTimes(3);

		await handle.close();
	});

	it('rejects a non-positive SWARM_WORKTREE_SWEEP_INTERVAL_MS at startup', () => {
		const previous = process.env.SWARM_WORKTREE_SWEEP_INTERVAL_MS;
		process.env.SWARM_WORKTREE_SWEEP_INTERVAL_MS = '0';
		try {
			expect(() => startHostMaintenance()).toThrow(
				/SWARM_WORKTREE_SWEEP_INTERVAL_MS must be a positive integer/,
			);
		} finally {
			if (previous === undefined) delete process.env.SWARM_WORKTREE_SWEEP_INTERVAL_MS;
			else process.env.SWARM_WORKTREE_SWEEP_INTERVAL_MS = previous;
		}
	});
});
