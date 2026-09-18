import { describe, expect, it } from 'vitest';
import {
	canForceReReview,
	canForceReviewOfSupersededHead,
	describeForceReReviewResult,
	type ForceReReviewReport,
	forceReReviewButtonLabel,
	forceReReviewConfirmMessage,
	forceReviewOfSupersededHeadConfirmMessage,
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
		continuation: 'respond-to-review',
		headSha: 'cafebabe',
		capOverride: 'granted',
		dispatch: 'scheduled',
		dispatchId: 'dispatch-9',
		...overrides,
	};
}

/** The issue #1040 continuation's report: a Review of the head that superseded `headSha`. */
function reviewReport(overrides: Partial<ForceReReviewReport> = {}): ForceReReviewReport {
	return report({ continuation: 'review', reviewHeadSha: 'deadbeef', ...overrides });
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

describe('canForceReviewOfSupersededHead (issue #1040)', () => {
	it('offers the action for the cap stop the approval left behind', () => {
		expect(canForceReviewOfSupersededHead(CAP_SPENT_APPROVAL)).toBe(true);
	});

	it('withholds the action when Review is disabled for the project', () => {
		expect(canForceReviewOfSupersededHead(CAP_SPENT_APPROVAL, { review: { enabled: false } })).toBe(
			false,
		);
		expect(canForceReviewOfSupersededHead(CAP_SPENT_APPROVAL, { review: { enabled: true } })).toBe(
			true,
		);
	});

	// Respond-to-review gates the *other* continuation; this one dispatches a Review.
	it('is unaffected by the Respond-to-review switch', () => {
		expect(
			canForceReviewOfSupersededHead(CAP_SPENT_APPROVAL, { respondToReview: { enabled: false } }),
		).toBe(true);
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
	])('withholds the action for %s', (_label, overrides) => {
		expect(canForceReviewOfSupersededHead({ ...CAP_SPENT_APPROVAL, ...overrides })).toBe(false);
	});

	// The two levers are mutually exclusive by verdict, exactly as their callouts are.
	it('never fires for the request-changes cap stop', () => {
		expect(canForceReviewOfSupersededHead(CAPPED)).toBe(false);
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

describe('forceReviewOfSupersededHeadConfirmMessage (issue #1040)', () => {
	it('names the PR and the current-head review, and promises no response', () => {
		const message = forceReviewOfSupersededHeadConfirmMessage('508');
		expect(message).toContain('PR #508');
		expect(message).toMatch(/current head/i);
		expect(message).toMatch(/cap stops the cycle again/);
		expect(message).not.toMatch(/Respond-to-review/);
	});

	it('falls back to a neutral phrase when the PR number is unknown', () => {
		expect(forceReviewOfSupersededHeadConfirmMessage(null)).toContain('this PR');
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

	// The issue #1040 continuation: one review of a named commit, with nothing queued
	// behind it — so the report names the head and drops the response's follow-up line.
	it('names the reviewed head and no response for the review continuation', () => {
		const lines = describeForceReReviewResult(reviewReport());
		expect(lines).toHaveLength(2);
		expect(lines[0]).toMatch(/one extra review slot granted/i);
		expect(lines[1]).toMatch(/Review: scheduled for PR #508 at `deadbeef` as dispatch dispatch-9/);
		expect(lines.join(' ')).not.toMatch(/Respond-to-review/);
		expect(lines.join(' ')).not.toMatch(/response pushes/);
	});

	it('says plainly that a repeated forced review duplicated nothing', () => {
		const lines = describeForceReReviewResult(
			reviewReport({ capOverride: 'already-granted', dispatch: 'already-scheduled' }),
		);
		expect(lines[0]).toMatch(/already granted/i);
		expect(lines[1]).toMatch(/Review: already scheduled for PR #508 at `deadbeef`/);
		expect(lines[1]).toMatch(/nothing duplicated/i);
	});

	it('points at the review a genuinely completed forced dispatch already produced', () => {
		const lines = describeForceReReviewResult(
			reviewReport({ dispatch: 'already-completed', dispatchOutcome: 'phase-succeeded' }),
		);
		expect(lines[1]).toMatch(/already completed.*phase-succeeded/i);
		expect(lines[1]).toMatch(/check the PR for its review/i);
	});

	it('reports a chained forced review past a dead prior attempt', () => {
		const lines = describeForceReReviewResult(
			reviewReport({
				dispatch: 'retried',
				dispatchId: 'dispatch-10',
				previousAttemptOutcome: 'no-trigger',
			}),
		);
		expect(lines[1]).toMatch(/never actually started one/i);
		expect(lines[1]).toMatch(/no-trigger/);
		expect(lines[1]).toMatch(/dispatch-10/);
	});

	it('omits the head clause when the server reported none', () => {
		const lines = describeForceReReviewResult(reviewReport({ reviewHeadSha: undefined }));
		expect(lines[1]).toBe('Review: scheduled for PR #508 as dispatch dispatch-9.');
	});
});
