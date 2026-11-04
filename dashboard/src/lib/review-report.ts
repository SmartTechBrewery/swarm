/**
 * Pure helpers for the Review phase's **Review report** field (issue #1288):
 * validation and dirty-checking over the same normalizer the config schema persists
 * through, kept out of the route component so they can be unit-tested — the twin of
 * `./pull-request-description.ts`, whose field this one mirrors.
 */

import {
	DEFAULT_REVIEW_REPORT,
	normalizeReviewReport,
	REVIEW_REPORT_MAX_LENGTH,
} from '../../../src/config/review-report.js';

export { DEFAULT_REVIEW_REPORT, normalizeReviewReport, REVIEW_REPORT_MAX_LENGTH };

/** The text the field shows: the stored layout, or SWARM's default while unset. */
export function reviewReportDisplay(value: string | undefined): string {
	return value ?? DEFAULT_REVIEW_REPORT;
}

/**
 * A validation message for a raw field value, or `undefined` when it is acceptable.
 * Only the persisted (normalized) length is bounded, matching the schema.
 */
export function reviewReportError(value: string | undefined): string | undefined {
	const normalized = normalizeReviewReport(value);
	if (normalized && normalized.length > REVIEW_REPORT_MAX_LENGTH) {
		return `Review report must be at most ${REVIEW_REPORT_MAX_LENGTH.toLocaleString()} characters (currently ${normalized.length.toLocaleString()}).`;
	}
	return undefined;
}

/**
 * Whether the edited layout differs from the stored one, comparing normalized forms —
 * so the untouched default and "unset" never read as dirty.
 */
export function isReviewReportDirty(
	local: string | undefined,
	stored: string | undefined,
): boolean {
	return (normalizeReviewReport(local) ?? '') !== (normalizeReviewReport(stored) ?? '');
}

/**
 * Whether the field already shows SWARM's default, so Restore default has nothing to
 * do. A cleared field normalizes to "unset" too, but the box is then empty rather
 * than showing the default, so it is not one: Restore default must stay available.
 */
export function isDefaultReviewReport(value: string | undefined): boolean {
	return normalizeReviewReport(value) === undefined && value?.trim() !== '';
}
