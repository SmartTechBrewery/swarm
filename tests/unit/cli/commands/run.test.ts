import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResetRunResult } from '@/dispatch/run-reset.js';

const { resetRun, closeQueue, closeDb, RunResetError } = vi.hoisted(() => {
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
		resetRun: vi.fn<(runId: string, options?: { force?: boolean }) => Promise<unknown>>(),
		closeQueue: vi.fn<() => Promise<void>>(),
		closeDb: vi.fn<() => Promise<void>>(),
		RunResetError,
	};
});

vi.mock('@/dispatch/run-reset.js', () => ({ resetRun, RunResetError }));
vi.mock('@/queue/producer.js', () => ({ closeQueue }));
vi.mock('@/db/client.js', () => ({ closeDb }));

import { run } from '@/cli/commands/run.js';

/** `runs.id` is a uuid column, and the command validates the shape before dialling out. */
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN_ID = '22222222-2222-4222-8222-222222222222';

function resetResult(overrides: Partial<ResetRunResult> = {}): ResetRunResult {
	return {
		runId: RUN_ID,
		forced: false,
		dispatch: 'cancelled',
		cancellationCleared: true,
		worktree: { outcome: 'removed' },
		recoveryCleared: true,
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

	it('resets the run unforced, reports each step, and closes the connections', async () => {
		await expect(run(['reset', RUN_ID])).resolves.toBe(0);
		expect(resetRun).toHaveBeenCalledExactlyOnceWith(RUN_ID, { force: false });
		expect(closeQueue).toHaveBeenCalledOnce();
		expect(closeDb).toHaveBeenCalledOnce();

		const report = logged.join('\n');
		expect(report).toContain('dispatch: the active dispatch was cancelled');
		expect(report).toContain('cancellation flag: cleared');
		expect(report).toContain('checkout: removed and its lease released');
		expect(report).toContain('recovery record: cleared');
		expect(report).toContain('re-dispatched from scratch as dispatch dispatch-9');
	});

	it('threads --force through and warns before acting', async () => {
		resetRun.mockResolvedValue(
			resetResult({
				forced: true,
				dispatch: 'force-cancelled-claimed',
				worktree: { outcome: 'removed', discarded: 'dirty', staleLeaseReleased: true },
			}),
		);

		await expect(run(['reset', RUN_ID, '--force'])).resolves.toBe(0);
		expect(resetRun).toHaveBeenCalledExactlyOnceWith(RUN_ID, { force: true });

		const report = logged.join('\n');
		expect(report).toContain('discarded permanently');
		expect(report).toContain('a worker-claimed dispatch was force-cancelled');
		expect(report).toContain('uncommitted changes discarded as requested');
		expect(report).toContain('a stale worktree lease no live run owned was released');
	});

	it('reports a retained checkout with its reason', async () => {
		resetRun.mockResolvedValue(
			resetResult({ worktree: { outcome: 'blocked', blockedReason: 'unpushed' } }),
		);

		await expect(run(['reset', RUN_ID])).resolves.toBe(0);
		expect(logged.join('\n')).toContain('checkout: retained — unpushed commits');
	});

	it('prints a refusal verbatim and exits 1', async () => {
		const refusal = `Run "${RUN_ID}" is still running — terminate it first.`;
		resetRun.mockRejectedValue(new RunResetError('running-not-forced', refusal));

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
