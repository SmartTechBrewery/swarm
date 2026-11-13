import { describe, expect, it } from 'vitest';
import {
	describeCancellationOrigin,
	normalizeRunError,
	RUN_CANCELLED_MESSAGE,
} from './run-cancellation.js';

describe('normalizeRunError', () => {
	it('rewrites the exact legacy user-termination string to the neutral wording', () => {
		expect(normalizeRunError('Run terminated by user from the dashboard.')).toBe(
			RUN_CANCELLED_MESSAGE,
		);
	});

	it('passes an arbitrary error through untouched', () => {
		expect(normalizeRunError('Agent crashed with exit code 1')).toBe(
			'Agent crashed with exit code 1',
		);
	});

	it('does not rewrite a message that only partially matches the legacy string', () => {
		const message = 'Run terminated by user from the dashboard, then retried.';
		expect(normalizeRunError(message)).toBe(message);
	});
});

describe('describeCancellationOrigin', () => {
	it('formats a recorded dashboard origin with no actor', () => {
		expect(
			describeCancellationOrigin({ source: 'dashboard', requestedAt: '2026-07-19T00:00:00.000Z' }),
		).toBe('Cancelled via dashboard');
	});

	it('appends the actor only when one was recorded', () => {
		expect(
			describeCancellationOrigin({
				source: 'dashboard',
				requestedAt: '2026-07-19T00:00:00.000Z',
				actor: 'jkwiecien',
			}),
		).toBe('Cancelled via dashboard by jkwiecien');
	});

	it('formats a recorded api origin', () => {
		expect(
			describeCancellationOrigin({ source: 'api', requestedAt: '2026-07-19T00:00:00.000Z' }),
		).toBe('Cancelled via API');
	});

	it('formats the board move to Backlog origin (issue #1451)', () => {
		expect(
			describeCancellationOrigin({
				source: 'board-backlog',
				requestedAt: '2026-11-13T00:00:00.000Z',
			}),
		).toBe('Cancelled because its board card was moved to Backlog');
	});

	it('returns null for no origin (marker-only cancellation or legacy row)', () => {
		expect(describeCancellationOrigin(null)).toBeNull();
		expect(describeCancellationOrigin(undefined)).toBeNull();
	});
});
