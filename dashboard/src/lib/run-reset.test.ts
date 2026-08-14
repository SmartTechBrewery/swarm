import { describe, expect, it } from 'vitest';
import {
	canResetRun,
	describeResetResult,
	describeRestartWait,
	type ResetRunReport,
	resetButtonLabel,
	resetConfirmMessage,
} from './run-reset.js';

/** The ordinary ending; the terminal one (issue #744) is built inline by its own test. */
type RestartedReport = Extract<ResetRunReport, { outcome: 'restarted' }>;

function makeReport(overrides: Partial<RestartedReport> = {}): RestartedReport {
	return {
		outcome: 'restarted',
		runId: 'run-1',
		dispatch: 'cancelled',
		cancellationCleared: true,
		worktree: { outcome: 'removed' },
		worktreeError: null,
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
		// `resetRun` accepts every non-completed status, so withholding the button here
		// would hide an action the server accepts.
		expect(canResetRun('checkpointed')).toBe(true);
	});

	it('allows reset for a running run, which the server no longer refuses (issue #744)', () => {
		expect(canResetRun('running')).toBe(true);
	});

	it('disallows reset for a completed run, which has nothing to restart', () => {
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
		// The flag it used to send operators back with is gone (issue #744).
		expect(describeRestartWait()).not.toContain('--force');
	});
});

describe('resetConfirmMessage', () => {
	it('names every step the reset performs', () => {
		const message = resetConfirmMessage('failed');
		expect(message).toContain('active dispatch');
		expect(message).toContain('worktree lease');
		expect(message).toContain('recovery record');
		expect(message).toContain('fresh agent session');
	});

	it('mentions the scheduled retry for a deferred run', () => {
		expect(resetConfirmMessage('deferred')).toContain('scheduled retry');
		expect(resetConfirmMessage('failed')).not.toContain('scheduled retry');
	});

	it('says a checkpointed reset discards the checkpoint and its spent budget (issue #503)', () => {
		const message = resetConfirmMessage('checkpointed');
		expect(message).toContain('scheduled continuation');
		expect(message).toContain('checkpoint');
		expect(message).toContain('continuation count');
		// The remainder is given up, not carried into the restarted phase.
		expect(message).toContain('not carried over');
		expect(resetConfirmMessage('failed')).not.toContain('checkpoint');
	});

	// Issue #744: there is no opt-in to describe, so the copy states the consequences
	// the operator is confirming rather than offering a choice.
	it('states that the discarded work cannot be recovered', () => {
		const message = resetConfirmMessage('failed');
		expect(message).toContain('discarded permanently');
		expect(message).toContain('cannot be recovered');
		expect(message).not.toContain('are kept');
	});

	it('states that a just-claimed dispatch is cancelled without stopping its agent', () => {
		const message = resetConfirmMessage('failed');
		expect(message).toContain('just claimed is cancelled');
		expect(message).toContain('already spawned');
	});

	// Issue #567: this is the action that abandons a pinned machine's work, and the
	// only one available while that machine is unreachable — so the copy has to say
	// both, rather than let "restarts this phase" read as a free retry.
	it('names the machine whose preserved work a restart abandons', () => {
		const message = resetConfirmMessage('checkpointed', 'm3_pro_tp');

		expect(message).toContain('m3_pro_tp');
		expect(message).toContain('abandoned');
		expect(message).toContain('whether or not');
	});

	it('says nothing about a machine for a run pinned to none', () => {
		expect(resetConfirmMessage('failed', null)).not.toContain('abandoned');
	});
});

describe('describeResetResult', () => {
	it('reports one line per step, ending with the new dispatch', () => {
		const lines = describeResetResult(makeReport());
		expect(lines).toEqual([
			'Dispatch: the active dispatch was cancelled.',
			'Cancellation flag: cleared, so the fresh attempt is not killed at startup.',
			'Checkout: removed and its lease released.',
			'Restart intent: the worker holding the checkout discards it — dirty and unpushed work included — before provisioning.',
			'Recovery record: cleared.',
			'Restarted: re-dispatched from scratch as dispatch dispatch-9.',
		]);
	});

	it('reports the preserved work a restart discarded, in its own line', () => {
		const lines = describeResetResult(makeReport({ abandonedPreservedWorkerId: 'w-preserved' }));

		expect(lines.some((line) => line.startsWith('Preserved work: discarded'))).toBe(true);
	});

	it('reports that no dispatch was active', () => {
		expect(describeResetResult(makeReport({ dispatch: 'none' }))[0]).toBe(
			'Dispatch: none was active.',
		);
	});

	it('warns that a cancelled claimed dispatch may leave its agent running', () => {
		expect(describeResetResult(makeReport({ dispatch: 'cancelled-claimed' }))[0]).toContain(
			'agent process it already spawned is not stopped',
		);
	});

	// Issue #744: the local teardown reaches only the control-plane host, so a throw is
	// reported instead of refusing — the restart's own discard intent settles the rest.
	it('reports a local teardown that failed and still reports the restart', () => {
		const lines = describeResetResult(
			makeReport({ worktree: null, worktreeError: 'git exploded' }),
		);

		expect(lines).toContain(
			"Checkout: this host's teardown failed — git exploded. The reset continued.",
		);
		expect(lines).toContain('Restarted: re-dispatched from scratch as dispatch dispatch-9.');
	});

	// A run nothing can be re-dispatched from is settled rather than refused, so the
	// report names the ending and claims no restart intent.
	it('reports a terminally settled run with the stated reason', () => {
		const lines = describeResetResult({
			outcome: 'terminated',
			runId: 'run-1',
			dispatch: 'cancelled',
			cancellationCleared: true,
			worktree: null,
			worktreeError: null,
			recoveryCleared: true,
			reason: 'Reset could not restart this run: it was created without a job payload.',
		});

		expect(lines).toContain(
			'Not restarted: Reset could not restart this run: it was created without a job payload.',
		);
		expect(lines.some((line) => line.startsWith('Restart intent:'))).toBe(false);
		expect(lines).toContain('Recovery record: cleared.');
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

	it('names the delegated discard intent every restart carries (issue #592)', () => {
		const lines = describeResetResult(makeReport({ worktree: { outcome: 'absent' } }));
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

	it('names what the reset discarded', () => {
		const lines = describeResetResult(
			makeReport({ worktree: { outcome: 'removed', discarded: 'dirty' } }),
		);
		expect(lines).toContain('Checkout: removed — uncommitted changes discarded as requested.');
	});

	it('names both discarded work and a released stale lease when both are present', () => {
		const lines = describeResetResult(
			makeReport({
				worktree: { outcome: 'removed', discarded: 'dirty', staleLeaseReleased: true },
			}),
		);
		expect(lines).toContain(
			'Checkout: removed — uncommitted changes discarded as requested; a stale worktree lease was released.',
		);
	});

	it('names the blocked reason when the checkout was retained, and who settles it', () => {
		const lines = describeResetResult(
			makeReport({ worktree: { outcome: 'blocked', blockedReason: 'unpushed' } }),
		);
		expect(lines).toContain(
			'Checkout: retained — unpushed commits. The worker holding it discards it when it provisions the restart.',
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
