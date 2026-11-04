/**
 * The words SWARM itself writes into a review report (issue #1288) — verdict,
 * severity, category and status names, check results, table headers and the fixed
 * sentences — in English, and how a project's own language replaces them.
 *
 * A project whose review report layout (`agents.review.reviewReport`) is written in
 * another language gets the whole report in that language: the agent writes the
 * hand-off's free text in it, and also hands back `reportLabels`, this vocabulary
 * translated. SWARM uses a translated entry only when it is a non-blank string whose
 * `{placeholders}` are exactly the English entry's, so a label can never drop a count
 * or the severity it names; anything else stays English. With SWARM's default layout
 * the agent is never asked for labels and the English below is used as-is, which is
 * what keeps the default report byte-identical.
 *
 * Only *wording* is translatable. Finding ids, the verdict SWARM submits and the
 * vote it casts are never read from here.
 */

export const ENGLISH_REVIEW_REPORT_VOCABULARY = {
	// The pass label.
	review: 'Review',
	reReview: 'Re-review',
	firstReReview: 'First re-review',
	secondReReview: 'Second re-review',
	numberedReReview: 'Re-review {n}',
	passOf: 'pass {ordinal} of {cap}',
	finalPermittedVerdict: 'final permitted verdict',
	// The verdict as shown — the verdict submitted is always SWARM's own value.
	verdictApprove: 'approve',
	verdictRequestChanges: 'request-changes',
	// The findings summary.
	noFindings: 'No findings',
	oneFinding: '{count} finding',
	manyFindings: '{count} findings',
	noneBlocking: 'none blocking',
	countBlocker: '{count} blocker',
	countMajor: '{count} major',
	countMinor: '{count} minor',
	countOneNit: '{count} nit',
	countManyNits: '{count} nits',
	carriedCounts: 'Carried: {resolved} resolved · {outstanding} outstanding',
	noNewFindings: '0 new findings',
	newFindings: '{count} new',
	// Severity and category names, as shown on a finding.
	severityBlocker: 'blocker',
	severityMajor: 'major',
	severityMinor: 'minor',
	severityNit: 'nit',
	categoryCorrectness: 'correctness',
	categorySecurity: 'security',
	categoryContract: 'contract',
	categoryPerformance: 'performance',
	categoryTestCoverage: 'test-coverage',
	categoryDocs: 'docs',
	categoryConsistency: 'consistency',
	// The re-review disposition.
	dispositionHeading: 'Disposition',
	columnId: 'ID',
	columnFinding: 'Finding',
	columnStatus: 'Status',
	carriedResolved: 'resolved',
	carriedPartial: 'partially addressed',
	carriedOutstanding: 'not addressed',
	carriedRegressed: 'regressed',
	// Verification and documents.
	columnCommand: 'Command',
	columnResult: 'Result',
	outcomePassed: 'passed',
	outcomeFailed: 'failed',
	docAccurate: 'accurate',
	docUpdated: 'updated',
	docNotApplicable: 'correctly untouched',
	docStale: 'stale',
	preExisting: 'Pre-existing, not from this PR',
	// Scope absorbed from another task.
	absorbedHeading: 'Scope absorbed from another task',
	absorbedIntro: [
		'The reviewer traced the whole scope of the task(s) below through this diff, so this pull',
		'request delivers them too. Nothing is closed by this review: the declaration is recorded',
		'here and on the run, for the merge that settles them.',
	].join('\n'),
	columnTask: 'Task',
	columnDelivers: 'What this PR delivers for it',
	// A finding.
	evidence: 'Evidence',
	failureScenario: 'Failure scenario',
	impact: 'Impact',
	fixPlan: 'Fix plan',
	tests: 'Tests',
	downgradeRationale: 'Why it is {severity}, not major:',
	// The findings sections.
	findingsHeading: 'Findings',
	nothingBlocking: 'Nothing blocking.',
	minorAndNitsHeading: 'Minor & nits',
	minorHeading: 'Minor',
	nitsHeading: 'Nits',
	noFindingsAtAll: 'None.',
	unansweredNote: [
		'These are not blocking and **no agent will act on them**: an `approve` review is skipped by',
		"the Respond-to-review trigger under this project's `pipeline.respondToReview.skipOnMinors`,",
		'so they are notes for a human.',
	].join('\n'),
} as const;

export type ReviewReportVocabularyKey = keyof typeof ENGLISH_REVIEW_REPORT_VOCABULARY;
export type ReviewReportVocabulary = Record<ReviewReportVocabularyKey, string>;

/** Longest translated label SWARM accepts; anything longer stays English. */
const MAX_LABEL_LENGTH = 500;

function placeholders(text: string): string {
	return [...text.matchAll(/\{(\w+)\}/g)]
		.map((match) => match[1])
		.sort()
		.join(',');
}

/**
 * The vocabulary a report is rendered with: English, with every acceptable
 * translated entry in `labels` laid over it. A translated entry is collapsed to one
 * line, because most labels land in a heading or a table cell that a newline breaks.
 */
export function resolveReviewReportVocabulary(
	labels: Readonly<Record<string, unknown>> | undefined,
): ReviewReportVocabulary {
	const vocabulary: ReviewReportVocabulary = { ...ENGLISH_REVIEW_REPORT_VOCABULARY };
	if (!labels) return vocabulary;
	for (const key of Object.keys(vocabulary) as ReviewReportVocabularyKey[]) {
		const value = labels[key];
		if (typeof value !== 'string') continue;
		const label = value.replace(/\s+/g, ' ').trim();
		if (label.length === 0 || label.length > MAX_LABEL_LENGTH) continue;
		if (placeholders(label) !== placeholders(vocabulary[key])) continue;
		vocabulary[key] = label;
	}
	return vocabulary;
}

/** Fill a label's `{placeholders}`. A placeholder with no value is left as written. */
export function fillLabel(
	label: string,
	values: Readonly<Record<string, string | number>>,
): string {
	return label.replace(/\{(\w+)\}/g, (match, name: string) =>
		name in values ? String(values[name]) : match,
	);
}
