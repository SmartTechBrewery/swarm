import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorktreeSweep, WorktreeSweepProject } from '@/transport/protocol.js';
import {
	createWorktreeSweepHandler,
	WORKTREE_SWEEP_REPORT_PATH,
	type WorktreeSweepHandlerOptions,
	type WorktreeSweepReport,
} from '@/transport/worktree-sweep.js';
import type { SweepAbandonedWorktreesResult } from '@/worktree/abandoned.js';

/**
 * The daemon side of the fleet worktree sweep (issue #955): what a machine sweeps,
 * what it says about it, and what it refuses to do twice.
 *
 * Both collaborators are replaced — the mechanism (`sweepAbandonedWorktrees`) and
 * the POST — because both are covered where they live: phase 1's own suite for the
 * removal decision, the delivery-client suite for the wire. What is under test here
 * is the layer between them, which is the whole of this module: the per-project
 * isolation, the report, and the bookkeeping that makes a re-push safe.
 */

const REQUEST_ID = '77777777-7777-4777-8777-777777777777';
const SECOND_ID = '88888888-8888-4888-8888-888888888888';

const PROJECT: WorktreeSweepProject = {
	projectId: 'swarm',
	worktreeRoot: '.swarm-workspaces',
	abandonedAfterDays: 10,
};
const OTHER_PROJECT: WorktreeSweepProject = {
	projectId: 'cascade',
	worktreeRoot: '.worktrees',
	abandonedAfterDays: 30,
};

function frame(overrides: Partial<WorktreeSweep> = {}): WorktreeSweep {
	return {
		type: 'worktree-sweep',
		requestId: REQUEST_ID,
		projects: [PROJECT],
		...overrides,
	};
}

/** What phase 1 answers for a project with one removal and one live checkout. */
function sweptOne(taskId = '955'): SweepAbandonedWorktreesResult {
	return {
		removed: [
			{
				taskId,
				path: `/home/ada/swarm/.swarm-workspaces/task-${taskId}`,
				lastTouchedAt: '2026-08-30T09:00:00.000Z',
				ageDays: 15,
				hadUncommittedChanges: true,
				hadUnpushedCommits: false,
			},
		],
		keptRecent: ['/home/ada/swarm/.swarm-workspaces/task-960'],
		keptLive: [{ path: '/home/ada/swarm/.swarm-workspaces/task-961', reason: 'live-leased' }],
		failed: [],
		ignored: [],
	};
}

function sweptNothing(): SweepAbandonedWorktreesResult {
	return { removed: [], keptRecent: [], keptLive: [], failed: [], ignored: [] };
}

function silentLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface Harness {
	handle: (sweep: WorktreeSweep) => void;
	sweep: ReturnType<typeof vi.fn>;
	report: ReturnType<typeof vi.fn>;
	inFlight: Set<string>;
	shutdownSignal: AbortController;
	logger: ReturnType<typeof silentLogger>;
	/** Every report this handler sent, oldest first. */
	reports: () => WorktreeSweepReport[];
}

function harness(overrides: Partial<WorktreeSweepHandlerOptions> = {}): Harness {
	const sweep = (overrides.sweep ??
		vi
			.fn<(entry: WorktreeSweepProject) => Promise<SweepAbandonedWorktreesResult>>()
			.mockResolvedValue(sweptOne())) as ReturnType<typeof vi.fn>;
	const report = (overrides.report ?? vi.fn().mockResolvedValue({ recorded: true })) as ReturnType<
		typeof vi.fn
	>;
	const inFlight = new Set<string>();
	const shutdownSignal = new AbortController();
	const logger = silentLogger();
	const handle = createWorktreeSweepHandler({
		repoRoot: '/home/ada/swarm',
		controlPlaneUrl: 'https://swarm.example',
		workerCredential: 'worker-credential',
		inFlight,
		shutdownSignal: shutdownSignal.signal,
		logger,
		...overrides,
		sweep,
		report,
	});
	return {
		handle,
		sweep,
		report,
		inFlight,
		shutdownSignal,
		logger,
		reports: () => report.mock.calls.map((call) => call[0] as WorktreeSweepReport),
	};
}

/** Let the fired-and-forgotten handler run to completion. */
async function settle(): Promise<void> {
	for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

beforeEach(() => {
	vi.useRealTimers();
});

describe('createWorktreeSweepHandler — sweeping and reporting', () => {
	it('sweeps every project the frame names and reports what it removed', async () => {
		const h = harness();

		h.handle(frame({ projects: [PROJECT, OTHER_PROJECT] }));
		await settle();

		expect(h.sweep).toHaveBeenCalledTimes(2);
		expect(h.sweep).toHaveBeenNthCalledWith(1, PROJECT);
		expect(h.sweep).toHaveBeenNthCalledWith(2, OTHER_PROJECT);
		expect(h.reports()[0]).toMatchObject({
			requestId: REQUEST_ID,
			status: 'swept',
			removedCount: 2,
			keptLiveCount: 2,
			failedCount: 0,
		});
	});

	// Each removal is attributed, because one report spans every project the machine
	// was asked about and a bare path names no project.
	it('attributes each removal to the project it was swept under', async () => {
		const h = harness();

		h.handle(frame());
		await settle();

		expect(h.reports()[0].removed).toEqual([
			{
				projectId: 'swarm',
				taskId: '955',
				path: '/home/ada/swarm/.swarm-workspaces/task-955',
				lastTouchedAt: '2026-08-30T09:00:00.000Z',
				ageDays: 15,
				hadUncommittedChanges: true,
				hadUnpushedCommits: false,
			},
		]);
	});

	// A sweep that removed nothing is still an answer: the request is pending until
	// something reports, and "nothing was old enough" is the ordinary outcome.
	it('reports a sweep that removed nothing', async () => {
		const h = harness({ sweep: vi.fn().mockResolvedValue(sweptNothing()) });

		h.handle(frame());
		await settle();

		expect(h.reports()[0]).toMatchObject({ status: 'swept', removedCount: 0 });
		expect(h.reports()[0].message).toContain('removed 0');
	});

	it('reports to the route the control plane serves', () => {
		expect(WORKTREE_SWEEP_REPORT_PATH).toBe('/worker/delivery/worktree-sweep-report');
	});
});

describe('createWorktreeSweepHandler — one project never ends the sweep', () => {
	it('sweeps the rest and counts the failure when one project throws', async () => {
		const sweep = vi
			.fn<(entry: WorktreeSweepProject) => Promise<SweepAbandonedWorktreesResult>>()
			.mockRejectedValueOnce(new Error('worktree root is not a git checkout'))
			.mockResolvedValueOnce(sweptOne());
		const h = harness({ sweep });

		h.handle(frame({ projects: [OTHER_PROJECT, PROJECT] }));
		await settle();

		expect(sweep).toHaveBeenCalledTimes(2);
		const report = h.reports()[0];
		expect(report).toMatchObject({ status: 'failed', failedCount: 1, removedCount: 1 });
		expect(report.message).toContain('cascade: worktree root is not a git checkout');
	});

	// A checkout the mechanism could not remove is the same kind of failure as a
	// project that threw: the operator asked for it to be gone and it is not.
	it('counts a removal the mechanism itself could not complete', async () => {
		const h = harness({
			sweep: vi.fn().mockResolvedValue({
				...sweptNothing(),
				failed: [
					{ path: '/home/ada/swarm/.swarm-workspaces/task-12', taskId: '12', error: 'EBUSY' },
				],
			}),
		});

		h.handle(frame());
		await settle();

		expect(h.reports()[0]).toMatchObject({ status: 'failed', failedCount: 1 });
		expect(h.reports()[0].message).toContain('EBUSY');
	});
});

describe('createWorktreeSweepHandler — a re-pushed request', () => {
	// The point of remembering a request: re-sweeping would mean re-removing, and the
	// reconnect re-push is the ordinary path rather than an edge.
	it('never sweeps a request it has already reported', async () => {
		const h = harness();

		h.handle(frame());
		await settle();
		h.handle(frame());
		await settle();

		expect(h.sweep).toHaveBeenCalledTimes(1);
		expect(h.report).toHaveBeenCalledTimes(1);
	});

	// The work is not redone, but the *answer* is: a blip while POSTing would
	// otherwise leave the request reading pending forever on a machine that had long
	// since done the work.
	it('re-sends a report the control plane never received, without sweeping again', async () => {
		const report = vi
			.fn()
			.mockRejectedValueOnce(new Error('control plane unreachable'))
			.mockResolvedValueOnce({ recorded: true });
		const h = harness({ report });

		h.handle(frame());
		await settle();
		h.handle(frame());
		await settle();

		expect(h.sweep).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledTimes(2);
		expect(h.reports()[1]).toMatchObject({ requestId: REQUEST_ID, removedCount: 1 });
	});

	it('stops re-sending once the report lands', async () => {
		const report = vi
			.fn()
			.mockRejectedValueOnce(new Error('control plane unreachable'))
			.mockResolvedValue({ recorded: true });
		const h = harness({ report });

		h.handle(frame());
		await settle();
		h.handle(frame());
		await settle();
		h.handle(frame());
		await settle();

		expect(report).toHaveBeenCalledTimes(2);
	});

	// `recorded: false` is information, not a failure: the row moved on, so there is
	// nothing left to re-send.
	it('treats a superseded request as answered rather than owed', async () => {
		const h = harness({ report: vi.fn().mockResolvedValue({ recorded: false }) });

		h.handle(frame());
		await settle();
		h.handle(frame());
		await settle();

		expect(h.report).toHaveBeenCalledTimes(2);
	});
});

describe('createWorktreeSweepHandler — one sweep at a time', () => {
	// Held rather than dropped: the control plane pushes once per notification, so a
	// request dropped here would sit pending on a machine that stayed connected.
	it('holds a second request until the one in flight finishes, then runs it', async () => {
		let release: (() => void) | undefined;
		const sweep = vi
			.fn<(entry: WorktreeSweepProject) => Promise<SweepAbandonedWorktreesResult>>()
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						release = () => resolve(sweptOne());
					}),
			)
			.mockResolvedValue(sweptOne('960'));
		const h = harness({ sweep });

		h.handle(frame());
		await settle();
		h.handle(frame({ requestId: SECOND_ID }));
		await settle();
		expect(sweep).toHaveBeenCalledTimes(1);

		release?.();
		await settle();

		expect(sweep).toHaveBeenCalledTimes(2);
		expect(h.reports().map((report) => report.requestId)).toEqual([REQUEST_ID, SECOND_ID]);
	});
});

describe('createWorktreeSweepHandler — shutdown', () => {
	// Silently abandoned: the request is durable on the row and re-pushed on the next
	// connection, where reporting a failure nobody asked for would leave an operator
	// reading an outcome for a machine that simply restarted.
	it('reports nothing when the daemon is already shutting down', async () => {
		const h = harness();
		h.shutdownSignal.abort();

		h.handle(frame());
		await settle();

		expect(h.sweep).not.toHaveBeenCalled();
		expect(h.report).not.toHaveBeenCalled();
	});

	it('stops between projects and reports nothing when a shutdown arrives mid-sweep', async () => {
		const h = harness();
		h.sweep.mockImplementation(async () => {
			h.shutdownSignal.abort();
			return sweptOne();
		});

		h.handle(frame({ projects: [PROJECT, OTHER_PROJECT] }));
		await settle();

		expect(h.sweep).toHaveBeenCalledTimes(1);
		expect(h.report).not.toHaveBeenCalled();
	});

	// The attempt is forgotten rather than remembered as handled, so a re-push sweeps
	// from scratch instead of being ignored as the repeat of something never done.
	// The signal is a stub here because a real one cannot be un-aborted, and this
	// module reads nothing but `aborted` off it.
	it('lets a re-pushed request sweep after an abandoned attempt', async () => {
		const signal = { aborted: true } as { aborted: boolean } as AbortSignal;
		const h = harness({ shutdownSignal: signal });

		h.handle(frame());
		await settle();
		expect(h.sweep).not.toHaveBeenCalled();

		(signal as unknown as { aborted: boolean }).aborted = false;
		h.handle(frame());
		await settle();

		expect(h.sweep).toHaveBeenCalledTimes(1);
		expect(h.reports()[0]).toMatchObject({ requestId: REQUEST_ID });
	});
});
