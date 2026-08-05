import { describe, expect, it } from 'vitest';
import {
	canForceReReview,
	describeForceReReviewResult,
	type ForceReReviewReport,
	forceReReviewButtonLabel,
	forceReReviewConfirmMessage,
} from './force-re-review.js';

const CAPPED = {
	status: 'completed',
	phase: 'review',
	reviewVerdict: 'request-changes',
	reviewAutomationOutcome: 'manual-intervention-required',
};

function report(overrides: Partial<ForceReReviewReport> = {}): ForceReReviewReport {
	return {
		runId: 'run-1',
		prNumber: '508',
		headSha: 'cafebabe',
		capOverride: 'granted',
		dispatch: 'scheduled',
		dispatchId: 'dispatch-9',
		...overrides,
	};
}

describe('canForceReReview (issue #511)', () => {
	it('offers the action for a completed Review run the cap stopped', () => {
		expect(canForceReReview(CAPPED)).toBe(true);
	});

	it('withholds the action when Respond-to-review is disabled', () => {
		expect(canForceReReview(CAPPED, { respondToReview: { enabled: false } })).toBe(false);
		expect(canForceReReview(CAPPED, { respondToReview: { enabled: true } })).toBe(true);
	});

	it.each([
		['a run still in progress', { status: 'running' }],
		['a non-Review phase', { phase: 'respond-to-review' }],
		['an approval verdict', { reviewVerdict: 'approve' }],
		['an ordinary verdict the cap never stopped', { reviewAutomationOutcome: null }],
	])('withholds the action for %s', (_label, overrides) => {
		expect(canForceReReview({ ...CAPPED, ...overrides })).toBe(false);
	});
});

describe('forceReReviewButtonLabel', () => {
	it('reads as pending while the mutation is in flight', () => {
		expect(forceReReviewButtonLabel(false)).toBe('Force re-review');
		expect(forceReReviewButtonLabel(true)).toBe('Scheduling…');
	});
});

describe('forceReReviewConfirmMessage', () => {
	it('names the PR and both halves of the corrective sequence', () => {
		const message = forceReReviewConfirmMessage('508');
		expect(message).toContain('PR #508');
		expect(message).toMatch(/Respond-to-review/);
		expect(message).toMatch(/new Review/);
		expect(message).toMatch(/cap stops the cycle again/);
	});

	it('falls back to a neutral phrase when the PR number is unknown', () => {
		expect(forceReReviewConfirmMessage(null)).toContain('this PR');
	});
});

describe('describeForceReReviewResult', () => {
	it('reports the granted slot and the scheduled corrective run', () => {
		const lines = describeForceReReviewResult(report());
		expect(lines[0]).toMatch(/one extra review slot granted/i);
		expect(lines[1]).toMatch(/scheduled for PR #508 as dispatch dispatch-9/i);
		expect(lines[2]).toMatch(/runs automatically once the response pushes/i);
	});

	it('says plainly that a repeated force duplicated nothing', () => {
		const lines = describeForceReReviewResult(
			report({ capOverride: 'already-granted', dispatch: 'already-scheduled' }),
		);
		expect(lines[0]).toMatch(/already granted/i);
		expect(lines[1]).toMatch(/nothing duplicated/i);
	});

	it('does not promise a new review after a completed forced dispatch', () => {
		const lines = describeForceReReviewResult(
			report({
				capOverride: 'already-granted',
				dispatch: 'already-completed',
				dispatchOutcome: 'no-trigger',
			}),
		);
		expect(lines[1]).toMatch(/already completed.*no-trigger/i);
		expect(lines[2]).toMatch(/no new review was scheduled/i);
	});
});
