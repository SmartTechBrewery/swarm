/**
 * The layout of the report the Review phase posts on a pull request (issue #1288):
 * SWARM's English default, the named slots SWARM fills from the review hand-off, the
 * layout's length bound and its normalizer. A dependency-free leaf for the same
 * reason as `./pull-request-description.ts` — the config schema (server) and the web
 * dashboard both import it, and the dashboard bundle must not reach it through
 * `./schema.ts`.
 *
 * The layout is the *editable* part of the report only. The hidden delivery marker
 * and the generated-by footer (loop prevention, #443) are added by the SCM provider
 * when it submits the review, outside it; the finding ids (`F1`, `F2`, …), the
 * verdict and the vote cast are SWARM's and are never taken from the layout.
 */

/**
 * The slots SWARM fills, in the order a layout that omits one gets its content
 * appended (`src/pipeline/review-body.ts`). Each is written `{name}` in a layout.
 */
export const REVIEW_REPORT_SLOTS = [
	'pass',
	'verdict',
	'head',
	'findings_summary',
	'summary',
	'disposition',
	'verification',
	'docs_checked',
	'pre_existing',
	'absorbed',
	'blocking_findings',
	'other_findings',
] as const;

export type ReviewReportSlot = (typeof REVIEW_REPORT_SLOTS)[number];

/**
 * SWARM's default review report layout. Rendered with SWARM's English wording it
 * produces exactly the report SWARM posted before the layout was editable — the
 * renderer's tests hold it byte-identical. Empty slots collapse with the blank lines
 * around them.
 */
export const DEFAULT_REVIEW_REPORT = [
	'> {pass} · `{verdict}` · head `{head}`',
	'> {findings_summary}',
	'',
	'## Scope',
	'',
	'{summary}',
	'',
	'{disposition}',
	'',
	'## Verification',
	'',
	'{verification}',
	'',
	'**Docs checked** — {docs_checked}',
	'',
	'{pre_existing}',
	'',
	'{absorbed}',
	'',
	'{blocking_findings}',
	'',
	'{other_findings}',
].join('\n');

/**
 * Upper bound on a project's review report layout (`agents.review.reviewReport`), in
 * characters — the same bound as a pull request description structure. Checked
 * against the normalized value.
 */
export const REVIEW_REPORT_MAX_LENGTH = 10_000;

function canonical(value: string): string {
	return value.replace(/\r\n?/g, '\n').trim();
}

/**
 * Normalize a stored review report layout: trim it, and treat a blank value **or one
 * equal to the default** as unset. Saving the untouched default therefore stores
 * nothing, so a project that never edited the field keeps getting SWARM's default
 * report — including a later revision of it.
 */
export function normalizeReviewReport(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = canonical(value);
	if (normalized.length === 0) return undefined;
	return normalized === DEFAULT_REVIEW_REPORT ? undefined : normalized;
}
