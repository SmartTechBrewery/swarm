import { describe, expect, it } from 'vitest';
import {
	canRecoverRun,
	recoverButtonLabel,
	recoveryChoices,
	recoveryOverrideSubmitLabel,
} from './run-recovery.js';
import { retryButtonLabel } from './run-retry.js';

describe('recoveryChoices', () => {
	it('offers both a fresh retry and a reset for a plain failed run', () => {
		expect(recoveryChoices({ status: 'failed', agentSessionId: null })).toEqual({
			retry: 'retry',
			reset: true,
		});
	});

	it('names the retry choice by the run’s own recovery state', () => {
		expect(
			recoveryChoices({ status: 'failed', agentSessionId: null, recovery: { state: 'preserved' } })
				.retry,
		).toBe('resume');
		expect(
			recoveryChoices({ status: 'failed', agentSessionId: null, recovery: { state: 'blocked' } })
				.retry,
		).toBe('recheck');
	});

	it('offers a continuation for a checkpointed run', () => {
		expect(recoveryChoices({ status: 'checkpointed', agentSessionId: null })).toEqual({
			retry: 'continue',
			reset: true,
		});
	});

	it('offers nothing for a run in no recovery state at all', () => {
		const choices = recoveryChoices({ status: 'completed', agentSessionId: null });
		expect(choices).toEqual({ retry: null, reset: false });
		expect(canRecoverRun(choices)).toBe(false);
		expect(canRecoverRun(recoveryChoices({ status: 'running', agentSessionId: null }))).toBe(false);
	});

	it('is recoverable whenever at least one choice is eligible', () => {
		expect(canRecoverRun({ retry: 'retry', reset: true })).toBe(true);
		expect(canRecoverRun({ retry: null, reset: true })).toBe(true);
		expect(canRecoverRun({ retry: 'retry', reset: false })).toBe(true);
		expect(canRecoverRun({ retry: null, reset: false })).toBe(false);
	});
});

describe('recoverButtonLabel', () => {
	const both = { retry: 'retry', reset: true } as const;

	it('reads as the neutral opener while nothing is in flight', () => {
		expect(recoverButtonLabel(both, null)).toBe('Recover');
	});

	it.each([
		['retry', 'Retrying…'],
		['resume', 'Resuming…'],
		['recheck', 'Rechecking…'],
		['continue', 'Continuing…'],
	] as const)('names the %s choice while it is submitting', (kind, label) => {
		expect(recoverButtonLabel({ retry: kind, reset: true }, 'retry')).toBe(label);
	});

	it('names the reset choice while it is submitting', () => {
		expect(recoverButtonLabel(both, 'reset')).toBe('Resetting…');
	});

	it('lets the durable outstanding request win over the local pending state', () => {
		// The accepted restart is the fact a second viewer and a reloaded page both
		// see, so it must name the wait even while this browser's mutation is still
		// in flight — and for either choice, since both queue the same restart.
		expect(recoverButtonLabel(both, null, true)).toBe('Waiting to restart…');
		expect(recoverButtonLabel(both, 'retry', true)).toBe('Waiting to restart…');
		expect(recoverButtonLabel(both, 'reset', true)).toBe('Waiting to restart…');
	});

	it('falls back to the opener when a retry is pending but no retry choice exists', () => {
		expect(recoverButtonLabel({ retry: null, reset: true }, 'retry')).toBe('Recover');
	});
});

describe('recoveryOverrideSubmitLabel', () => {
	it('distinguishes the override submit from the plain retry choice beside it', () => {
		for (const kind of ['retry', 'resume', 'recheck', 'continue'] as const) {
			expect(recoveryOverrideSubmitLabel(kind)).not.toBe(retryButtonLabel(kind, false));
		}
	});

	it('keeps a continuation reading as a continuation', () => {
		expect(recoveryOverrideSubmitLabel('continue')).toBe('Continue with these settings');
		expect(recoveryOverrideSubmitLabel('resume')).toBe('Retry with these settings');
		expect(recoveryOverrideSubmitLabel('retry')).toBe('Retry with these settings');
	});
});
