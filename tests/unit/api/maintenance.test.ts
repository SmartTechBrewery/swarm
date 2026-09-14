import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { startHostMaintenance } from '@/api/maintenance.js';
import type { WorktreeSweepFanoutEntry } from '@/api/worktree-sweep-fanout.js';
import type { ProjectConfig } from '@/config/schema.js';
import type { Worker } from '@/identity/worker.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** The coded default cadence at which a fleet-wide sweep falls due (7 days). */
const FLEET_SWEEP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** How often due-ness is *checked* — a coded hourly tick, not the cadence itself. */
const FLEET_DUE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** A machine for the fleet sweep to be fanned out to; only the id is ever read here. */
function makeWorker(id: string): Worker {
	return { id, displayName: id } as Worker;
}

/**
 * Injected collaborators for every test, so nothing here touches Postgres or the
 * filesystem.
 *
 * The fleet-sweep half is injected the same way: the durable marker is an
 * in-memory instant and the fan-out is a spy, so the due-check's own arithmetic is
 * what is under test rather than `app_settings` or the `workers` table.
 */
function createCollaborators(projects: ProjectConfig[], workers: Worker[] = []) {
	return {
		failOrphanedRuns: vi.fn<(reason: string, workerId: string | null) => Promise<number>>(
			async () => 0,
		),
		listProjects: vi.fn<() => Promise<ProjectConfig[]>>(async () => projects),
		pruneWorktrees: vi.fn<(project: ProjectConfig) => Promise<unknown>>(async () => ({})),
		listWorkers: vi.fn<() => Promise<Worker[]>>(async () => workers),
		fanOutSweep: vi.fn<(workers: Worker[]) => Promise<WorktreeSweepFanoutEntry[]>>(async (asked) =>
			asked.map((worker) => ({
				workerId: worker.id,
				displayName: worker.displayName,
				disposition: 'requested' as const,
				worktreeSweep: null,
			})),
		),
		readMarker: vi.fn<() => Promise<Date | null>>(async () => null),
		writeMarker: vi.fn<(at: Date) => Promise<void>>(async () => {}),
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

/**
 * Issue #956 — the weekly fleet sweep. What is under test is the *due* check, not
 * the fan-out (which has its own suite): the setting is an interval against a
 * durable marker rather than a timer period, and that is the whole of what makes
 * the cadence survive a restart.
 */
describe('startHostMaintenance — the weekly fleet worktree sweep (issue #956)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('fans out at startup when no sweep has ever been recorded, and advances the marker', async () => {
		const collaborators = createCollaborators([], [makeWorker('worker-a'), makeWorker('worker-b')]);

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(collaborators.fanOutSweep).toHaveBeenCalledTimes(1);
		expect(collaborators.fanOutSweep.mock.calls[0]?.[0].map((w) => w.id)).toEqual([
			'worker-a',
			'worker-b',
		]);
		expect(collaborators.writeMarker).toHaveBeenCalledTimes(1);
		expect(collaborators.writeMarker.mock.calls[0]?.[0]).toBeInstanceOf(Date);

		await handle.close();
	});

	// The restart case, and the reason the marker exists at all: an API server
	// restarted daily must not fan out daily.
	it('does not fan out while the recorded sweep is still within the interval', async () => {
		const collaborators = createCollaborators([], [makeWorker('worker-a')]);
		collaborators.readMarker.mockResolvedValue(new Date(Date.now() - 24 * 60 * 60 * 1000));

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(collaborators.fanOutSweep).not.toHaveBeenCalled();
		expect(collaborators.listWorkers).not.toHaveBeenCalled();
		expect(collaborators.writeMarker).not.toHaveBeenCalled();

		await handle.close();
	});

	// The hourly tick is cheap and the marker decides: a full interval later the
	// same process fans out without being restarted.
	it('fans out on the tick that first finds a full interval elapsed', async () => {
		const collaborators = createCollaborators([], [makeWorker('worker-a')]);
		const sweptAt = new Date(Date.now() - (FLEET_SWEEP_INTERVAL_MS - FLEET_DUE_CHECK_INTERVAL_MS));
		collaborators.readMarker.mockResolvedValue(sweptAt);

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);
		expect(collaborators.fanOutSweep).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(FLEET_DUE_CHECK_INTERVAL_MS);
		expect(collaborators.fanOutSweep).toHaveBeenCalledTimes(1);

		await handle.close();
	});

	// Once per due interval, not once per tick: the fan-out writes the marker, and
	// every tick inside the new interval reads it and returns early.
	it('fans out exactly once across an interval of hourly ticks', async () => {
		const collaborators = createCollaborators([], [makeWorker('worker-a')]);
		let marker: Date | null = null;
		collaborators.readMarker.mockImplementation(async () => marker);
		collaborators.writeMarker.mockImplementation(async (at) => {
			marker = at;
		});

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(FLEET_SWEEP_INTERVAL_MS - FLEET_DUE_CHECK_INTERVAL_MS);

		expect(collaborators.fanOutSweep).toHaveBeenCalledTimes(1);

		// …and the tick that crosses the interval asks again.
		await vi.advanceTimersByTimeAsync(FLEET_DUE_CHECK_INTERVAL_MS * 2);
		expect(collaborators.fanOutSweep).toHaveBeenCalledTimes(2);

		await handle.close();
	});

	it('honours an injected due interval over the coded default', async () => {
		const collaborators = createCollaborators([], [makeWorker('worker-a')]);
		collaborators.readMarker.mockResolvedValue(
			new Date(Date.now() - 2 * FLEET_DUE_CHECK_INTERVAL_MS),
		);

		const handle = startHostMaintenance({
			fleetSweepIntervalMs: FLEET_DUE_CHECK_INTERVAL_MS,
			...collaborators,
		});
		await vi.advanceTimersByTimeAsync(0);

		expect(collaborators.fanOutSweep).toHaveBeenCalledTimes(1);

		await handle.close();
	});

	// A failing chore must never stop the API server, and must not advance the
	// marker either — a fan-out that threw outright is retried on the next tick
	// rather than skipped for a whole interval.
	it('swallows a throwing fan-out, leaves the marker alone, and keeps ticking', async () => {
		const collaborators = createCollaborators([], [makeWorker('worker-a')]);
		collaborators.fanOutSweep.mockRejectedValue(new Error('database unreachable'));

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(collaborators.writeMarker).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(FLEET_DUE_CHECK_INTERVAL_MS);
		expect(collaborators.fanOutSweep).toHaveBeenCalledTimes(2);

		await handle.close();
	});

	// The other half of the same rule: the fan-out swallows each
	// machine's own failure by design and returns normally, so "asked nobody" is
	// indistinguishable from "threw" as far as the fleet is concerned — and must not
	// buy a whole interval of silence.
	it('leaves the marker alone when a non-empty fleet produced no entries', async () => {
		const collaborators = createCollaborators([], [makeWorker('worker-a'), makeWorker('worker-b')]);
		collaborators.fanOutSweep.mockResolvedValue([]);

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(collaborators.fanOutSweep).toHaveBeenCalledTimes(1);
		expect(collaborators.writeMarker).not.toHaveBeenCalled();

		// Still due on the next hourly tick, rather than a week from now.
		await vi.advanceTimersByTimeAsync(FLEET_DUE_CHECK_INTERVAL_MS);
		expect(collaborators.fanOutSweep).toHaveBeenCalledTimes(2);

		await handle.close();
	});

	// A machine that *was* asked is an entry, whatever its disposition — including
	// one already carrying an unanswered request — so a fleet nobody had to ask
	// again still advances the marker.
	it('advances the marker when every machine was already asked', async () => {
		const collaborators = createCollaborators([], [makeWorker('worker-a')]);
		collaborators.fanOutSweep.mockResolvedValue([
			{
				workerId: 'worker-a',
				displayName: 'worker-a',
				disposition: 'already-asked',
				worktreeSweep: null,
			},
		]);

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(collaborators.writeMarker).toHaveBeenCalledTimes(1);

		await handle.close();
	});

	it('keeps the schedule moving for an installation with no workers', async () => {
		const collaborators = createCollaborators([], []);

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);

		expect(collaborators.fanOutSweep).toHaveBeenCalledExactlyOnceWith([]);
		expect(collaborators.writeMarker).toHaveBeenCalledTimes(1);

		await handle.close();
	});

	it('clears both timers on close', async () => {
		const collaborators = createCollaborators(
			[createMockProjectConfig()],
			[makeWorker('worker-a')],
		);

		const handle = startHostMaintenance({ ...collaborators });
		await vi.advanceTimersByTimeAsync(0);
		await handle.close();

		expect(vi.getTimerCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(FLEET_SWEEP_INTERVAL_MS * 2);
		expect(collaborators.fanOutSweep).toHaveBeenCalledTimes(1);
	});

	it('rejects a non-positive SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS at startup', () => {
		const previous = process.env.SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS;
		process.env.SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS = 'weekly';
		try {
			expect(() => startHostMaintenance({ worktreeSweepIntervalMs: 1_000 })).toThrow(
				/SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS must be a positive integer/,
			);
		} finally {
			if (previous === undefined) delete process.env.SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS;
			else process.env.SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS = previous;
		}
	});
});
