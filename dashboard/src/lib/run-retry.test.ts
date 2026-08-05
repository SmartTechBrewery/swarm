import { describe, expect, it } from 'vitest';
import { canRetryRun, retryActionKind, retryButtonLabel } from './run-retry.js';

describe('canRetryRun', () => {
	it('allows retry for a deferred or failed run', () => {
		expect(canRetryRun('deferred')).toBe(true);
		expect(canRetryRun('failed')).toBe(true);
	});

	it('allows a checkpointed run to be continued now (issue #503)', () => {
		expect(canRetryRun('checkpointed')).toBe(true);
	});

	it('disallows retry for running and completed runs', () => {
		expect(canRetryRun('running')).toBe(false);
		expect(canRetryRun('completed')).toBe(false);
	});

	it('disallows retry for an unknown status', () => {
		expect(canRetryRun('whatever')).toBe(false);
	});
});

describe('retryActionKind', () => {
	it('resumes a deferred run that kept a captured agent session', () => {
		expect(retryActionKind('deferred', 'a1b2c3d4-0000-0000-0000-000000000000')).toBe('resume');
	});

	it('is a fresh retry for a deferred run with no captured session', () => {
		expect(retryActionKind('deferred', null)).toBe('retry');
	});

	it('is a fresh retry for a failed run even if a session id lingers', () => {
		expect(retryActionKind('failed', null)).toBe('retry');
		expect(retryActionKind('failed', 'a1b2c3d4-0000-0000-0000-000000000000')).toBe('retry');
	});

	it('resumes a failed run whose worktree was preserved for its session', () => {
		expect(retryActionKind('failed', null, { state: 'preserved' })).toBe('resume');
	});

	it('rechecks a failed run whose worktree stayed blocked (issue #368)', () => {
		expect(retryActionKind('failed', null, { state: 'blocked' })).toBe('recheck');
		// A lingering session id never turns a blocked run into a resume.
		expect(
			retryActionKind('failed', 'a1b2c3d4-0000-0000-0000-000000000000', { state: 'blocked' }),
		).toBe('recheck');
	});

	it('is a fresh retry for a failed recovered run', () => {
		expect(retryActionKind('failed', null, { state: 'recovered' })).toBe('retry');
	});

	it('does not recheck a non-failed status that carries a blocked recovery', () => {
		expect(retryActionKind('deferred', null, { state: 'blocked' })).toBe('retry');
	});

	it('never resumes a non-retryable status that still holds a session', () => {
		expect(retryActionKind('running', 'a1b2c3d4-0000-0000-0000-000000000000')).toBe('retry');
		expect(retryActionKind('completed', 'a1b2c3d4-0000-0000-0000-000000000000')).toBe('retry');
	});

	it('continues a checkpointed run rather than resuming it (issue #503)', () => {
		expect(retryActionKind('checkpointed', null)).toBe('continue');
		// The server sends a checkpointed row through `recoveryMode: 'checkpoint'`
		// unconditionally, so a lingering session id must not read as a resume.
		expect(retryActionKind('checkpointed', 'a1b2c3d4-0000-0000-0000-000000000000')).toBe(
			'continue',
		);
		// Nor may a preserved/blocked recovery record on the same row override it.
		expect(retryActionKind('checkpointed', null, { state: 'preserved' })).toBe('continue');
		expect(retryActionKind('checkpointed', null, { state: 'blocked' })).toBe('continue');
	});
});

describe('retryButtonLabel', () => {
	it('labels a resume action', () => {
		expect(retryButtonLabel('resume', false)).toBe('Resume');
		expect(retryButtonLabel('resume', true)).toBe('Resuming…');
	});

	it('labels a recheck action (issue #368)', () => {
		expect(retryButtonLabel('recheck', false)).toBe('Recheck and retry');
		expect(retryButtonLabel('recheck', true)).toBe('Rechecking…');
	});

	it('labels a checkpoint continuation (issue #503)', () => {
		expect(retryButtonLabel('continue', false)).toBe('Continue now');
		expect(retryButtonLabel('continue', true)).toBe('Continuing…');
	});

	it('labels a fresh retry action', () => {
		expect(retryButtonLabel('retry', false)).toBe('Retry now');
		expect(retryButtonLabel('retry', true)).toBe('Retrying…');
	});
});
