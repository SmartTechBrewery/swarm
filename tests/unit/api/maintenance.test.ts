import { hostname } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startHostMaintenance } from '@/api/maintenance.js';
import type { ProjectConfig } from '@/config/schema.js';
import type { CliQuotaSnapshot } from '@/harness/quota.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const QUOTA_INTERVAL_MS = 6 * 60 * 60 * 1000;

function createSnapshot(overrides: Partial<CliQuotaSnapshot> = {}): CliQuotaSnapshot {
	return {
		cli: 'claude',
		status: 'available',
		source: 'live',
		lastUpdated: '2026-08-07T00:00:00.000Z',
		...overrides,
	};
}

/**
 * Injected collaborators for every test, so nothing here touches Postgres, the
 * filesystem, or an agent CLI.
 */
function createCollaborators(projects: ProjectConfig[]) {
	return {
		failOrphanedRuns: vi.fn<(reason: string, workerId: string | null) => Promise<number>>(
			async () => 0,
		),
		listProjects: vi.fn<() => Promise<ProjectConfig[]>>(async () => projects),
		pruneWorktrees: vi.fn<(project: ProjectConfig) => Promise<unknown>>(async () => ({})),
		discoverQuotas: vi.fn<(cheap?: boolean) => Promise<CliQuotaSnapshot[]>>(async () => [
			createSnapshot(),
		]),
		persistQuota: vi.fn<
			(
				host: string,
				cli: CliQuotaSnapshot['cli'],
				status: CliQuotaSnapshot['status'],
				snapshot: CliQuotaSnapshot,
			) => Promise<void>
		>(async () => {}),
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

		await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS * 2);
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

	it('discovers CLI quotas immediately (full) and then cheaply on its interval', async () => {
		const collaborators = createCollaborators([]);

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(collaborators.discoverQuotas).toHaveBeenCalledTimes(1);
		expect(collaborators.discoverQuotas).toHaveBeenLastCalledWith(false);
		// Issue #703: the snapshot is a host-local fact, so the probing machine is
		// stamped on it rather than the row standing for the whole installation.
		expect(collaborators.persistQuota).toHaveBeenCalledWith(
			hostname(),
			'claude',
			'available',
			expect.objectContaining({ cli: 'claude' }),
		);

		await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS);
		expect(collaborators.discoverQuotas).toHaveBeenCalledTimes(2);
		expect(collaborators.discoverQuotas).toHaveBeenLastCalledWith(true);

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
		collaborators.discoverQuotas.mockRejectedValue(new Error('no CLI on PATH'));

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(handle).toBeDefined();

		await vi.advanceTimersByTimeAsync(SWEEP_INTERVAL_MS);
		expect(collaborators.listProjects).toHaveBeenCalledTimes(2);

		await handle.close();
	});

	it('clears every timer on close', async () => {
		const collaborators = createCollaborators([createMockProjectConfig()]);

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);
		await handle.close();

		expect(vi.getTimerCount()).toBe(0);

		const sweeps = collaborators.pruneWorktrees.mock.calls.length;
		const discoveries = collaborators.discoverQuotas.mock.calls.length;
		await vi.advanceTimersByTimeAsync(QUOTA_INTERVAL_MS * 2);
		expect(collaborators.pruneWorktrees).toHaveBeenCalledTimes(sweeps);
		expect(collaborators.discoverQuotas).toHaveBeenCalledTimes(discoveries);
	});

	it('honours injected cadences over the coded defaults', async () => {
		const collaborators = createCollaborators([createMockProjectConfig()]);

		const handle = startHostMaintenance({
			worktreeSweepIntervalMs: 1_000,
			quotaDiscoveryIntervalMs: 2_000,
			...collaborators,
		});
		await vi.advanceTimersByTimeAsync(2_000);

		expect(collaborators.pruneWorktrees).toHaveBeenCalledTimes(3);
		expect(collaborators.discoverQuotas).toHaveBeenCalledTimes(2);

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
