import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResetRunResult } from '@/dispatch/run-reset.js';

const { resetRun, closeQueue, closeDb, closeCancellationRedis, RunResetError } = vi.hoisted(() => {
	// Stands in for the service's own class, so the command's `instanceof` refusal
	// check matches. Declared inside `vi.hoisted` because the mock factory below
	// runs before any module-level class declaration is initialized.
	class RunResetError extends Error {
		constructor(
			readonly reason: string,
			message: string,
		) {
			super(message);
			this.name = 'RunResetError';
		}
	}
	return {
		resetRun: vi.fn<(runId: string) => Promise<ResetRunResult>>(),
		closeQueue: vi.fn<() => Promise<void>>(),
		closeDb: vi.fn<() => Promise<void>>(),
		closeCancellationRedis: vi.fn<() => Promise<void>>(),
		RunResetError,
	};
});

vi.mock('@/dispatch/run-reset.js', () => ({ resetRun, RunResetError }));
vi.mock('@/queue/producer.js', () => ({ closeQueue }));
vi.mock('@/db/client.js', () => ({ closeDb }));
vi.mock('@/queue/cancellation.js', () => ({
	closeRunCancellationRedis: closeCancellationRedis,
}));

import { run } from '@/cli/commands/run.js';

/** `runs.id` is a uuid column, and the command validates the shape before dialling out. */
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';

/** The ordinary ending; the terminal one (issue #744) is built inline by its own test. */
type RestartedResult = Extract<ResetRunResult, { outcome: 'restarted' }>;

function resetResult(overrides: Partial<RestartedResult> = {}): RestartedResult {
	return {
		outcome: 'restarted',
		runId: RUN_ID,
		agentStop: 'not-running',
		dispatch: 'cancelled',
		cancellationCleared: true,
		worktree: { outcome: 'removed' },
		worktreeError: null,
		recoveryCleared: true,
		abandonedPreservedWorkerId: null,
		dispatchId: 'dispatch-9',
		...overrides,
	};
}

describe('run command', () => {
	let logged: string[];
	let errored: string[];

	beforeEach(() => {
		logged = [];
		errored = [];
		resetRun.mockReset().mockResolvedValue(resetResult());
		closeQueue.mockReset().mockResolvedValue(undefined);
		closeDb.mockReset().mockResolvedValue(undefined);
		closeCancellationRedis.mockReset().mockResolvedValue(undefined);
		vi.spyOn(console, 'log').mockImplementation((line: string) => {
			logged.push(line);
		});
		vi.spyOn(console, 'warn').mockImplementation((line: string) => {
			logged.push(line);
		});
		vi.spyOn(console, 'error').mockImplementation((line: string) => {
			errored.push(line);
		});
	});

	it('resets the run, reports each step, and closes the connections', async () => {
		await expect(run(['reset', RUN_ID])).resolves.toBe(0);
		// Issue #744: the run id is the whole call — there is no flag to thread.
		expect(resetRun).toHaveBeenCalledExactlyOnceWith(RUN_ID);
		expect(closeQueue).toHaveBeenCalledOnce();
		expect(closeDb).toHaveBeenCalledOnce();
		expect(closeCancellationRedis).toHaveBeenCalledOnce();

		const report = logged.join('\n');
		// Stated up front, since there is no opt-in left to decline.
		expect(report).toContain('a reset discards');
		// A run that had no agent to stop claims no step for it.
		expect(report).not.toContain('agent:');
		expect(report).toContain('dispatch: the active dispatch was cancelled');
		expect(report).toContain('cancellation flag: cleared');
		expect(report).toContain('checkout: removed and its lease released');
		expect(report).toContain('restart intent: the worker holding the checkout discards it');
		expect(report).toContain('recovery record: cleared');
		expect(report).toContain('re-dispatched from scratch as dispatch dispatch-9');
	});

	it('reports a cancelled claimed dispatch and the work it discarded', async () => {
		resetRun.mockResolvedValue(
			resetResult({
				dispatch: 'cancelled-claimed',
				worktree: { outcome: 'removed', discarded: 'dirty', staleLeaseReleased: true },
			}),
		);

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);

		const report = logged.join('\n');
		expect(report).toContain('a dispatch a worker had already claimed was cancelled');
		// The caveat this used to carry is gone with issue #745 — a reset stops the
		// agent that dispatch spawned, so there is nothing left to terminate by hand.
		expect(report).not.toContain('is not stopped by a reset');
		expect(report).toContain('uncommitted changes discarded as requested');
		expect(report).toContain('a stale worktree lease no live run owned was released');
	});

	// Issue #745 — the step that ended the two-step "Terminate, then Reset" dance.
	it('reports the live agent it stopped before tearing anything down', async () => {
		resetRun.mockResolvedValue(resetResult({ agentStop: 'stopped' }));

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);

		const report = logged.join('\n');
		expect(report).toContain('agent: the running agent was asked to stop');
		expect(report).toContain('before anything was torn down');
	});

	it('warns when the agent never confirmed the stop, and still reports the restart', async () => {
		resetRun.mockResolvedValue(resetResult({ agentStop: 'timed-out' }));

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);

		const report = logged.join('\n');
		expect(report).toContain('had not confirmed within the wait');
		// Never a refusal: the checkout went and the phase restarted regardless.
		expect(report).toContain('re-dispatched from scratch as dispatch dispatch-9');
		expect(errored).toEqual([]);
	});

	// Issue #744: this teardown reaches only the control-plane host, so a throw is
	// reported rather than fatal — the restart's own discard intent settles the rest.
	it('reports a local teardown that failed and still reports the restart', async () => {
		resetRun.mockResolvedValue(resetResult({ worktree: null, worktreeError: 'git exploded' }));

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);

		const report = logged.join('\n');
		expect(report).toContain("checkout: this host's teardown failed — git exploded");
		expect(report).toContain('re-dispatched from scratch as dispatch dispatch-9');
	});

	// A run nothing can be re-dispatched from is settled rather than refused, so the
	// command reports it as an ordinary outcome and exits 0.
	it('reports a terminally settled run as a normal outcome', async () => {
		resetRun.mockResolvedValue({
			outcome: 'terminated',
			runId: RUN_ID,
			agentStop: 'not-running',
			dispatch: 'cancelled',
			cancellationCleared: true,
			worktree: null,
			worktreeError: null,
			recoveryCleared: true,
			abandonedPreservedWorkerId: null,
			reason: 'Reset could not restart this run: it was created without a job payload.',
		});

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);

		const report = logged.join('\n');
		expect(report).toContain('not restarted: Reset could not restart this run');
		expect(report).toContain('recovery record: cleared');
		// Nothing carries a restart intent when nothing restarted.
		expect(report).not.toContain('restart intent:');
		expect(errored).toEqual([]);
	});

	it('reports a retained checkout with its reason', async () => {
		resetRun.mockResolvedValue(
			resetResult({ worktree: { outcome: 'blocked', blockedReason: 'unpushed' } }),
		);

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);
		expect(logged.join('\n')).toContain('checkout: retained — unpushed commits');
	});

	it('reports a checkout retained by a lease another live run holds', async () => {
		resetRun.mockResolvedValue(
			resetResult({ worktree: { outcome: 'blocked', blockedReason: 'live-leased' } }),
		);

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);
		const report = logged.join('\n');
		expect(report).toContain('checkout: retained — a lease held by another live run');
		// The operator needs to know who settles it, not to be sent back with a flag
		// that no longer exists (issue #744).
		expect(report).toContain('the worker holding it discards it');
		expect(report).not.toContain('--force');
	});

	it('reports an absent checkout and a dispatch that was not active', async () => {
		resetRun.mockResolvedValue(
			resetResult({
				dispatch: 'none',
				cancellationCleared: false,
				worktree: { outcome: 'absent' },
				recoveryCleared: false,
			}),
		);

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);
		const report = logged.join('\n');
		expect(report).toContain('dispatch: none was active');
		// Issue #592: not "nothing to remove" — the checkout may be alive on another
		// worker, which is the case the operator is resetting.
		expect(report).toContain('checkout: none on this host');
		expect(report).not.toContain('nothing to remove');
		expect(report).toContain('leftover lease marker here was dropped');
		// Steps the service did not perform are not claimed.
		expect(report).not.toContain('cancellation flag:');
		expect(report).not.toContain('recovery record:');
	});

	it('leaves an unknown option for the CLI dispatcher to map to exit 1', async () => {
		// `parseArgs` throws on an unknown option rather than returning a code; the
		// mapping to exit 1 belongs to `src/cli/index.ts`, which catches it.
		await expect(run(['reset', RUN_ID, '--nope'])).rejects.toThrow();
		// The removed opt-in is now one of those unknown options (issue #744).
		await expect(run(['reset', RUN_ID, '--force'])).rejects.toThrow();
		expect(resetRun).not.toHaveBeenCalled();
	});

	it('prints a refusal verbatim and exits 1', async () => {
		const refusal = `Run "${RUN_ID}" is already being restarted.`;
		resetRun.mockRejectedValue(new RunResetError('already-resetting', refusal));

		await expect(run(['reset', RUN_ID])).resolves.toBe(1);
		expect(errored.join('\n')).toContain(refusal);
		expect(closeQueue).toHaveBeenCalledOnce();
		expect(closeDb).toHaveBeenCalledOnce();
	});

	it('exits 1 on an unexpected failure and still closes the connections', async () => {
		resetRun.mockRejectedValue(new Error('redis down'));

		await expect(run(['reset', RUN_ID])).resolves.toBe(1);
		expect(errored.join('\n')).toContain('run reset failed: redis down');
		expect(closeDb).toHaveBeenCalledOnce();
	});

	it('prints usage without opening connections', async () => {
		await expect(run([])).resolves.toBe(1);
		await expect(run(['--help'])).resolves.toBe(0);
		await expect(run(['reset', '--help'])).resolves.toBe(0);
		expect(resetRun).not.toHaveBeenCalled();
		expect(closeQueue).not.toHaveBeenCalled();
		expect(closeDb).not.toHaveBeenCalled();
	});

	it('rejects an unknown subcommand, a missing/extra id, and a malformed id without opening connections', async () => {
		await expect(run(['restart'])).resolves.toBe(1);
		await expect(run(['reset'])).resolves.toBe(1);
		await expect(run(['reset', RUN_ID, OTHER_RUN_ID])).resolves.toBe(1);
		// A typo'd id would otherwise surface as a raw Postgres uuid-cast error.
		await expect(run(['reset', 'not-a-uuid'])).resolves.toBe(1);
		expect(errored.join('\n')).toContain("'not-a-uuid' is not a valid run id");
		expect(resetRun).not.toHaveBeenCalled();
		expect(closeQueue).not.toHaveBeenCalled();
		expect(closeDb).not.toHaveBeenCalled();
	});
});
