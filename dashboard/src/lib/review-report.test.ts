import { describe, expect, it } from 'vitest';
import {
	DEFAULT_REVIEW_REPORT,
	isDefaultReviewReport,
	isReviewReportDirty,
	REVIEW_REPORT_MAX_LENGTH,
	reviewReportDisplay,
	reviewReportError,
} from './review-report.js';

describe('reviewReportDisplay', () => {
	it('shows the default until the project stores its own layout', () => {
		expect(reviewReportDisplay(undefined)).toBe(DEFAULT_REVIEW_REPORT);
		expect(reviewReportDisplay('## Zakres')).toBe('## Zakres');
	});
});

describe('reviewReportError', () => {
	it('accepts the default, blank and within-bound values, and rejects one over the bound', () => {
		expect(reviewReportError(undefined)).toBeUndefined();
		expect(reviewReportError(DEFAULT_REVIEW_REPORT)).toBeUndefined();
		expect(reviewReportError('a'.repeat(REVIEW_REPORT_MAX_LENGTH))).toBeUndefined();
		expect(reviewReportError('a'.repeat(REVIEW_REPORT_MAX_LENGTH + 1))).toMatch(/at most/);
	});
});

describe('isReviewReportDirty', () => {
	it('does not treat the untouched default as an edit of an unset field', () => {
		expect(isReviewReportDirty(DEFAULT_REVIEW_REPORT, undefined)).toBe(false);
		expect(isReviewReportDirty(undefined, undefined)).toBe(false);
	});

	it('detects a changed layout and a restored default', () => {
		expect(isReviewReportDirty('## Zakres', undefined)).toBe(true);
		expect(isReviewReportDirty(undefined, '## Zakres')).toBe(true);
		expect(isReviewReportDirty('## Zakres ', '## Zakres')).toBe(false);
	});
});

describe('isDefaultReviewReport', () => {
	it('is true for unset and the default text, false for a custom layout', () => {
		expect(isDefaultReviewReport(undefined)).toBe(true);
		expect(isDefaultReviewReport(`${DEFAULT_REVIEW_REPORT}\n`)).toBe(true);
		expect(isDefaultReviewReport('## Zakres')).toBe(false);
	});

	it('is false for a cleared field, which shows an empty box rather than the default', () => {
		expect(isDefaultReviewReport('')).toBe(false);
		expect(isDefaultReviewReport('  \n')).toBe(false);
	});
});
