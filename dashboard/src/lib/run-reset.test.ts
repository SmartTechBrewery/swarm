import { describe, expect, it } from 'vitest';
import {
	canResetRun,
	describeResetResult,
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

	it('reports an absent checkout', () => {
		const lines = describeResetResult(makeReport({ worktree: { outcome: 'absent' } }));
		expect(lines).toContain('Checkout: none on disk — nothing to remove.');
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
