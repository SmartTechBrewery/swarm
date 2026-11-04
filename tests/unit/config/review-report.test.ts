import { describe, expect, it } from 'vitest';
import {
	DEFAULT_REVIEW_REPORT,
	normalizeReviewReport,
	REVIEW_REPORT_SLOTS,
} from '@/config/review-report.js';

describe('DEFAULT_REVIEW_REPORT (issue #1288)', () => {
	it('places every slot SWARM fills, each exactly once', () => {
		for (const slot of REVIEW_REPORT_SLOTS)
			expect(DEFAULT_REVIEW_REPORT.split(`{${slot}}`)).toHaveLength(2);
	});
});

describe('normalizeReviewReport', () => {
	it('treats blank as unset and trims a custom layout', () => {
		expect(normalizeReviewReport(undefined)).toBeUndefined();
		expect(normalizeReviewReport(' \n ')).toBeUndefined();
		expect(normalizeReviewReport('  ## Zakres\n\n{summary}  ')).toBe('## Zakres\n\n{summary}');
	});

	it('treats the default — padded or with CRLF line endings — as unset', () => {
		expect(normalizeReviewReport(DEFAULT_REVIEW_REPORT)).toBeUndefined();
		expect(
			normalizeReviewReport(`\n${DEFAULT_REVIEW_REPORT.replace(/\n/g, '\r\n')}\n`),
		).toBeUndefined();
	});
});
