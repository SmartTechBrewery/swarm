import { describe, expect, it } from 'vitest';
import {
	canResetRun,
	describeResetResult,
	describeRestartWait,
	type ResetRunReport,
	resetButtonLabel,
	resetConfirmMessage,
} from './run-reset.js';

function makeReport(overrides: Partial<ResetRunReport> = {}): ResetRunReport {
	return {
		runId: 'run-1',
		forced: false,
		dispatch: 'cancelled',
		cancellationCleared: true,
		worktree: { outcome: 'removed' },
		worktreeIntent: 'reclaim',
		recoveryCleared: true,
		dispatchId: 'dispatch-9',
		...overrides,
	};
}

describe('canResetRun', () => {
	it('allows reset for a failed or deferred run', () => {
		expect(canResetRun('failed')).toBe(true);
		expect(canResetRun('deferred')).toBe(true);
	});

	it('allows reset for a checkpointed run (issue #503)', () => {
		// `resetRun` refuses only a `running` row unless forced, so withholding the
		// button here would hide an action the server accepts.
		expect(canResetRun('checkpointed')).toBe(true);
	});

	it('disallows reset for running and completed runs', () => {
		expect(canResetRun('running')).toBe(false);
		expect(canResetRun('completed')).toBe(false);
	});

	it('disallows reset for an unknown status', () => {
		expect(canResetRun('whatever')).toBe(false);
	});
});

describe('resetButtonLabel', () => {
	it('reads "Resetting…" while the mutation is pending', () => {
		expect(resetButtonLabel(true)).toBe('Resetting…');
	});

	it('reads "Reset & restart" when idle', () => {
		expect(resetButtonLabel(false)).toBe('Reset & restart');
	});

	it('names the wait once the restart is accepted (issue #561)', () => {
		expect(resetButtonLabel(false, true)).toBe('Waiting to restart…');
	});

	it('prefers the accepted restart over the mutation, which it outlives', () => {
		expect(resetButtonLabel(true, true)).toBe('Waiting to restart…');
	});
});

describe('describeRestartWait (issue #561)', () => {
	it('says the restart was accepted and what has to happen for it to take effect', () => {
		const copy = describeRestartWait();
		expect(copy).toContain('accepted');
		expect(copy).toContain('a worker claims it');
	});

	it('names the CLI escape for a restart no worker ever picks up', () => {
		expect(describeRestartWait()).toContain('swarm run reset <runId>');
		expect(describeRestartWait()).not.toContain('"swarm run reset <runId> --force"');
		expect(describeRestartWait()).toContain('discard dirty or unpushed work');
	});
});

describe('resetConfirmMessage', () => {
	it('names every step the reset performs', () => {
		const message = resetConfirmMessage('failed', false);
		expect(message).toContain('active dispatch');
		expect(message).toContain('worktree lease');
		expect(message).toContain('recovery record');
		expect(message).toContain('fresh agent session');
	});

	it('mentions the scheduled retry for a deferred run', () => {
		expect(resetConfirmMessage('deferred', false)).toContain('scheduled retry');
		expect(resetConfirmMessage('failed', false)).not.toContain('scheduled retry');
	});

	it('says a checkpointed reset discards the checkpoint and its spent budget (issue #503)', () => {
		const message = resetConfirmMessage('checkpointed', false);
		expect(message).toContain('scheduled continuation');
		expect(message).toContain('checkpoint');
		expect(message).toContain('continuation count');
		// The remainder is given up, not carried into the restarted phase.
		expect(message).toContain('not carried over');
		expect(resetConfirmMessage('failed', false)).not.toContain('checkpoint');
	});

	it('says protected work is kept when force is off', () => {
		expect(resetConfirmMessage('failed', false)).toContain('are kept');
	});

	it('warns that discarded work cannot be recovered when force is on', () => {
		const message = resetConfirmMessage('failed', true);
		expect(message).toContain('discarded permanently');
		expect(message).toContain('cannot be recovered');
	});
});

describe('describeResetResult', () => {
	it('reports one line per step, ending with the new dispatch', () => {
		const lines = describeResetResult(makeReport());
		expect(lines).toEqual([
			'Dispatch: the active dispatch was cancelled.',
			'Cancellation flag: cleared, so the fresh attempt is not killed at startup.',
			'Checkout: removed and its lease released.',
			'Restart intent: the worker holding the checkout reclaims it only if it is safe to; dirty or unpushed work is retained.',
			'Recovery record: cleared.',
			'Restarted: re-dispatched from scratch as dispatch dispatch-9.',
		]);
	});

	it('reports that no dispatch was active', () => {
		expect(describeResetResult(makeReport({ dispatch: 'none' }))[0]).toBe(
			'Dispatch: none was active.',
		);
	});

	it('warns that a force-cancelled claimed dispatch may leave its agent running', () => {
		expect(describeResetResult(makeReport({ dispatch: 'force-cancelled-claimed' }))[0]).toContain(
			'agent process it already spawned is not stopped',
		);
	});

	// Issue #592: "nothing to remove" was the reset's whole answer even when the
	// checkout was alive on another worker — the exact case the operator is resetting.
	it('says who settles a checkout the control-plane host cannot see', () => {
		const lines = describeResetResult(makeReport({ worktree: { outcome: 'absent' } }));
		expect(lines.some((line) => line.includes('nothing to remove'))).toBe(false);
		expect(lines).toContain(
			'Checkout: none on this host — one held by another worker is settled by that worker when it provisions the restart.',
		);
	});

	it('names the delegated intent of a forced reset (issue #592)', () => {
		const lines = describeResetResult(
			makeReport({ forced: true, worktreeIntent: 'discard', worktree: { outcome: 'absent' } }),
		);
		expect(lines).toContain(
			'Restart intent: the worker holding the checkout discards it — dirty and unpushed work included — before provisioning.',
		);
	});

	it('reports a reclaimed stale lease when the checkout was removed', () => {
		const lines = describeResetResult(
			makeReport({ worktree: { outcome: 'removed', staleLeaseReleased: true } }),
		);
		expect(lines.some((line) => line.includes('stale worktree lease'))).toBe(true);
	});

	it('names what a forced reset discarded', () => {
		const lines = describeResetResult(
			makeReport({ forced: true, worktree: { outcome: 'removed', discarded: 'dirty' } }),
		);
		expect(lines).toContain('Checkout: removed — uncommitted changes discarded as requested.');
	});

	it('names both discarded work and a released stale lease when both are present', () => {
		const lines = describeResetResult(
			makeReport({
				forced: true,
				worktree: { outcome: 'removed', discarded: 'dirty', staleLeaseReleased: true },
			}),
		);
		expect(lines).toContain(
			'Checkout: removed — uncommitted changes discarded as requested; a stale worktree lease was released.',
		);
	});

	it('names the blocked reason when the checkout was retained', () => {
		const lines = describeResetResult(
			makeReport({ worktree: { outcome: 'blocked', blockedReason: 'unpushed' } }),
		);
		expect(lines).toContain(
			'Checkout: retained — unpushed commits. The restarted run re-checks it before provisioning.',
		);
	});

	it('falls back to the raw reason for an unknown blocked reason', () => {
		const lines = describeResetResult(
			makeReport({ worktree: { outcome: 'blocked', blockedReason: 'something-new' } }),
		);
		expect(lines.some((line) => line.includes('something-new'))).toBe(true);
	});

	it('reports a preserved checkout', () => {
		const lines = describeResetResult(
			makeReport({ worktree: { outcome: 'preserved', agentSessionId: 'sess-1' } }),
		);
		expect(lines.some((line) => line.includes('saved agent session'))).toBe(true);
	});

	it('omits the flag and recovery lines when the server did not clear them', () => {
		const lines = describeResetResult(
			makeReport({ cancellationCleared: false, recoveryCleared: false }),
		);
		expect(lines.some((line) => line.startsWith('Cancellation flag:'))).toBe(false);
		expect(lines.some((line) => line.startsWith('Recovery record:'))).toBe(false);
	});
});
