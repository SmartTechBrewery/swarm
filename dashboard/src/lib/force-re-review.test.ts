import { describe, expect, it } from 'vitest';
import {
	canForceReReview,
	describeForceReReviewResult,
	type ForceReReviewReport,
	forceReReviewButtonLabel,
	forceReReviewConfirmMessage,
	isCapSpentApproval,
} from './force-re-review.js';

const CAPPED = {
	status: 'completed',
	phase: 'review',
	reviewVerdict: 'request-changes',
	reviewAutomationOutcome: 'manual-intervention-required',
};

/** The other cap stop (issue #1038): an approval merge automation then refused. */
const CAP_SPENT_APPROVAL = {
	status: 'completed',
	phase: 'review',
	reviewVerdict: 'approve',
	reviewMergeOutcome: 'not-eligible',
	reviewCapSpent: true,
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

	// Criterion 3 of issue #1038: the `request-changes` cap stop's predicate answers
	// exactly as it did, for both shapes — the new one included.
	it('is unchanged by the approval cap stop it does not own (issue #1038)', () => {
		expect(canForceReReview(CAPPED)).toBe(true);
		expect(canForceReReview(CAP_SPENT_APPROVAL)).toBe(false);
	});
});

describe('isCapSpentApproval (issue #1038)', () => {
	it('recognises a spent-allowance approval merge automation refused', () => {
		expect(isCapSpentApproval(CAP_SPENT_APPROVAL)).toBe(true);
	});

	it.each([
		['a changes-requested verdict', { reviewVerdict: 'request-changes' }],
		['an approval that merged', { reviewMergeOutcome: 'merged' }],
		['an approval still waiting on its merge retry', { reviewMergeOutcome: 'not-ready' }],
		['an approval that never attempted a merge', { reviewMergeOutcome: null }],
		['a pull request that still has allowance left', { reviewCapSpent: false }],
		['a row the server resolved no ledger fact for', { reviewCapSpent: undefined }],
		['a run still in progress', { status: 'running' }],
		['a non-Review phase', { phase: 'respond-to-review' }],
	])('withholds the callout for %s', (_label, overrides) => {
		expect(isCapSpentApproval({ ...CAP_SPENT_APPROVAL, ...overrides })).toBe(false);
	});

	// Mutually exclusive by verdict: the two callouts can never render together.
	it('never fires for the request-changes cap stop', () => {
		expect(isCapSpentApproval(CAPPED)).toBe(false);
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

	it('points at the follow-up review after a genuinely completed forced dispatch', () => {
		const lines = describeForceReReviewResult(
			report({
				capOverride: 'already-granted',
				dispatch: 'already-completed',
				dispatchOutcome: 'phase-succeeded',
			}),
		);
		expect(lines[1]).toMatch(/already completed.*phase-succeeded/i);
		expect(lines[2]).toMatch(/already ran/i);
	});

	it('reports a fresh attempt when the previous forced dispatch never started one', () => {
		const lines = describeForceReReviewResult(
			report({
				capOverride: 'already-granted',
				dispatch: 'retried',
				dispatchId: 'dispatch-10',
				previousAttemptOutcome: 'no-trigger',
			}),
		);
		expect(lines[1]).toMatch(/never actually started one/i);
		expect(lines[1]).toMatch(/no-trigger/);
		expect(lines[1]).toMatch(/dispatch-10/);
		expect(lines[2]).toMatch(/runs automatically once the response pushes/i);
	});
});
