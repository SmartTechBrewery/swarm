/**
 * Renders the Review phase's posted review body from its hand-off (issue #470).
 *
 * Before this, the agent authored the whole body and SWARM posted it verbatim, so
 * every heading, section name, and severity word was whatever the harness in use
 * happened to produce — the same defect could read as a blocker on one model and
 * a passing remark on another. Here the agent fills fields
 * (`ReviewHandoffSchema`) and this module owns the layout, so the structure is
 * byte-identical across `claude` / `agy` / `codex`, and the parts SWARM already
 * knows — the pass number, the verdict cap, the head SHA, whether anything
 * downstream will answer a non-blocking finding — are stated by SWARM rather
 * than guessed by the agent.
 *
 * Two rendering tiers, keyed off severity: `blocker`/`major` get the full
 * Evidence / Failure scenario / Impact / Fix plan / Tests slots, `minor`/`nit`
 * get a one-paragraph compact form, because at that severity the suggestion *is*
 * the plan and the five-slot treatment turns a naming nit into 200 words. The
 * schema's refinement guarantees each tier's slots are present, so nothing here
 * has to defend against a missing one.
 *
 * Since issue #1288 the *arrangement* is a project's to choose: each part is
 * rendered into a named slot (`REVIEW_REPORT_SLOTS`, `src/config/review-report.ts`)
 * and the slots are placed by a layout — the project's `agents.review.reviewReport`
 * or SWARM's `DEFAULT_REVIEW_REPORT` — with SWARM's own words taken from the
 * report's vocabulary (`./review-report-vocabulary.ts`). With no layout configured
 * the report is byte-identical to the one this module rendered before. A layout that
 * leaves out a slot with content still gets that content, appended at the end, so a
 * custom layout can never hide a blocking finding.
 */

import {
	DEFAULT_REVIEW_REPORT,
	REVIEW_REPORT_SLOTS,
	type ReviewReportSlot,
} from '@/config/review-report.js';
import {
	ENGLISH_REVIEW_REPORT_VOCABULARY,
	fillLabel,
	type ReviewReportVocabulary,
	resolveReviewReportVocabulary,
} from '@/pipeline/review-report-vocabulary.js';
import {
	isBlockingSeverity,
	type ReviewCarriedFinding,
	type ReviewDocCheck,
	type ReviewFinding,
	type ReviewHandoff,
} from '@/scm/delivery.js';

export interface ReviewBodyContext {
	/** The validated hand-off the agent wrote. */
	handoff: ReviewHandoff;
	/** The reviewed head commit — pins the review to the exact diff it read. */
	headSha: string;
	/**
	 * This run's slot in the review-verdict ledger (1 = the PR's first review, 2 =
	 * its first re-review, …), or `undefined` when the ledger had no reservation to
	 * read. Never counted by the agent: an abandoned slot frees its ordinal and a
	 * same-head retry reuses it, so an agent-side count would drift where the
	 * ledger's ordinal doesn't.
	 */
	ordinal?: number;
	/** `REVIEW_VERDICT_CAP` — how many verdicts this PR is permitted in total. */
	cap: number;
	/** Whether this run verified previously requested changes rather than the whole diff. */
	isReReview: boolean;
	/**
	 * Whether a non-`changes-requested` verdict still dispatches Respond-to-review
	 * for this project — Respond-to-review enabled *and*
	 * `pipeline.respondToReview.skipOnMinors === false`. When it doesn't, an
	 * approval's minor findings are stated as notes for a human, because nothing in
	 * the pipeline will pick them up.
	 */
	minorsAnswered: boolean;
	/**
	 * The project's review report layout (`agents.review.reviewReport`, issue
	 * #1288), already normalized — `undefined` for SWARM's default. Only a custom
	 * layout reads the hand-off's `reportLabels`: the default report is English,
	 * whatever the agent wrote.
	 */
	layout?: string;
}

/** What one rendering needs besides the hand-off: the context plus the words to use. */
interface RenderContext extends ReviewBodyContext {
	words: ReviewReportVocabulary;
}

/**
 * Markdown table cells can carry neither a raw `|` (it opens a new column) nor a
 * newline (it ends the row). Agent-authored text reaches all of them — a
 * verification command, a carried finding's id and title, an absorbed task's
 * reference, URL and evidence, a translated column header — and a piped command
 * like `npx vitest run | tail -20` is ordinary enough to break the table in
 * practice.
 */
function cell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\s*\r?\n\s*/g, ' ');
}

const SEVERITY_ORDER: Record<ReviewFinding['severity'], number> = {
	blocker: 0,
	major: 1,
	minor: 2,
	nit: 3,
};

const SEVERITY_WORDS = {
	blocker: 'severityBlocker',
	major: 'severityMajor',
	minor: 'severityMinor',
	nit: 'severityNit',
} as const satisfies Record<ReviewFinding['severity'], keyof ReviewReportVocabulary>;

const CATEGORY_WORDS = {
	correctness: 'categoryCorrectness',
	security: 'categorySecurity',
	contract: 'categoryContract',
	performance: 'categoryPerformance',
	'test-coverage': 'categoryTestCoverage',
	docs: 'categoryDocs',
	consistency: 'categoryConsistency',
} as const satisfies Record<ReviewFinding['category'], keyof ReviewReportVocabulary>;

const VERDICT_WORDS = {
	approve: 'verdictApprove',
	'request-changes': 'verdictRequestChanges',
} as const satisfies Record<ReviewHandoff['verdict'], keyof ReviewReportVocabulary>;

/**
 * Ordinal → the name a human uses for that re-review pass. Only the two the
 * default `REVIEW_VERDICT_CAP` permits are named; a raised cap falls back to the
 * numbered form below.
 */
const RE_REVIEW_NAMES = ['firstReReview', 'secondReReview'] as const;

function passLabel({ ordinal, cap, isReReview, words }: RenderContext): string {
	if (ordinal === undefined) return `**${isReReview ? words.reReview : words.review}**`;
	// `isReReview` — not the ordinal — decides the *name*. A pass after an approval
	// that didn't merge (a later push re-triggers Review) is a full initial review
	// sitting at ordinal 2; calling that a re-review would claim it verified
	// earlier findings it was never shown. The ordinal still names the *slot*.
	const named = RE_REVIEW_NAMES[ordinal - 2];
	const name = isReReview
		? named
			? words[named]
			: fillLabel(words.numberedReReview, { n: ordinal - 1 })
		: words.review;
	// Naming the last permitted pass in the line a human reads first: a
	// cap-reaching `request-changes` stops the automatic cycle, and today that is
	// visible only in a log field.
	const final = ordinal >= cap ? ` — ${words.finalPermittedVerdict}` : '';
	return `**${name}** · ${fillLabel(words.passOf, { ordinal, cap })}${final}`;
}

/** `1 blocker · 1 major · 0 minor · 0 nits` — the line a human scans before any prose. */
function severityHistogram(
	findings: readonly ReviewFinding[],
	words: ReviewReportVocabulary,
): string {
	const count = (severity: ReviewFinding['severity']) =>
		findings.filter((f) => f.severity === severity).length;
	const nits = count('nit');
	return [
		fillLabel(words.countBlocker, { count: count('blocker') }),
		fillLabel(words.countMajor, { count: count('major') }),
		fillLabel(words.countMinor, { count: count('minor') }),
		fillLabel(nits === 1 ? words.countOneNit : words.countManyNits, { count: nits }),
	].join(' · ');
}

function findingsSummary({ handoff, words }: RenderContext): string {
	const { findings } = handoff;
	if (findings.length === 0) return `**${words.noFindings}**`;
	const blocking = findings.some((f) => isBlockingSeverity(f.severity));
	const total = fillLabel(findings.length === 1 ? words.oneFinding : words.manyFindings, {
		count: findings.length,
	});
	const suffix = blocking ? '' : ` · **${words.noneBlocking}**`;
	return `**${total}** — ${severityHistogram(findings, words)}${suffix}`;
}

function carriedSummary({ handoff, words }: RenderContext): string {
	const { carried, findings } = handoff;
	const resolved = carried.filter((c) => c.status === 'resolved').length;
	const outstanding = carried.length - resolved;
	// The disposition counts answer "was every point addressed", but they say
	// nothing about how hard the remaining work is — so the histogram still rides
	// along whenever this pass reported anything.
	const news =
		findings.length === 0
			? `**${words.noNewFindings}**`
			: `**${fillLabel(words.newFindings, { count: findings.length })}** (${severityHistogram(findings, words)})`;
	return `**${fillLabel(words.carriedCounts, { resolved, outstanding })}** — ${news}`;
}

const CARRIED_STATUS_LABELS = {
	resolved: ['✅', 'carriedResolved'],
	partial: ['⚠️', 'carriedPartial'],
	outstanding: ['❌', 'carriedOutstanding'],
	regressed: ['❌', 'carriedRegressed'],
} as const satisfies Record<
	ReviewCarriedFinding['status'],
	readonly [string, keyof ReviewReportVocabulary]
>;

function carriedStatus(status: ReviewCarriedFinding['status'], words: ReviewReportVocabulary) {
	const [mark, word] = CARRIED_STATUS_LABELS[status];
	return `${mark} ${words[word]}`;
}

/** One row per finding an earlier pass raised — "was every point addressed" at a glance. */
function disposition({ handoff, words }: RenderContext): string[] {
	const { carried } = handoff;
	if (carried.length === 0) return [];
	return [
		`## ${words.dispositionHeading}`,
		'',
		`| ${cell(words.columnId)} | ${cell(words.columnFinding)} | ${cell(words.columnStatus)} |`,
		'| --- | --- | --- |',
		...carried.map(
			(c) => `| ${cell(c.id)} | ${cell(c.title)} | ${carriedStatus(c.status, words)} |`,
		),
		'',
		...carried.flatMap((c) => [
			`### ${c.id} · ${carriedStatus(c.status, words)}`,
			'',
			c.detail,
			'',
		]),
	];
}

const DOC_STATUS_LABELS = {
	accurate: ['✅', 'docAccurate'],
	updated: ['✅', 'docUpdated'],
	'not-applicable': ['✅', 'docNotApplicable'],
	stale: ['❌', 'docStale'],
} as const satisfies Record<
	ReviewDocCheck['status'],
	readonly [string, keyof ReviewReportVocabulary]
>;

function verificationTable({ handoff, words }: RenderContext): string[] {
	return [
		`| ${cell(words.columnCommand)} | ${cell(words.columnResult)} |`,
		'| --- | --- |',
		...handoff.verification.map(
			(v) =>
				`| \`${cell(v.command)}\` | ${v.outcome === 'passed' ? words.outcomePassed : `**${words.outcomeFailed}**`} |`,
		),
	];
}

function docsChecked({ handoff, words }: RenderContext): string {
	return handoff.docsChecked
		.map((d) => {
			const [mark, word] = DOC_STATUS_LABELS[d.status];
			return `\`${d.path}\` ${mark} ${words[word]}${d.note ? ` (${d.note})` : ''}`;
		})
		.join(' · ');
}

function preExisting({ handoff, words }: RenderContext): string[] {
	if (handoff.preExisting.length === 0) return [];
	return [`**${words.preExisting}** — ${handoff.preExisting.join(' · ')}`];
}

/**
 * The reviewer's fold-in declaration (issue #953), rendered so a human can audit
 * the decision on the pull request at the moment it is taken — next to the
 * verdict that accompanied it, rather than only in a database column. Empty on
 * essentially every review, in which case the body is byte-identical to what it
 * was before this section existed.
 */
function absorbedSection({ handoff, words }: RenderContext): string[] {
	if (handoff.absorbed.length === 0) return [];
	return [
		`## ${words.absorbedHeading}`,
		'',
		words.absorbedIntro,
		'',
		`| ${cell(words.columnTask)} | ${cell(words.columnDelivers)} |`,
		'| --- | --- |',
		// Both cells are agent-authored, and `evidence` in particular is prose that
		// may carry a `|` or a newline.
		...handoff.absorbed.map(
			(a) => `| [${cell(a.reference)}](${cell(a.url)}) | ${cell(a.evidence)} |`,
		),
		'',
	];
}

function findingLabels(finding: ReviewFinding, words: ReviewReportVocabulary) {
	return {
		severity: words[SEVERITY_WORDS[finding.severity]],
		category: words[CATEGORY_WORDS[finding.category]],
	};
}

/** The blocking tier: full slots, because a blocker has to be demonstrable to act on. */
function blockingFinding(finding: ReviewFinding, words: ReviewReportVocabulary): string[] {
	const { severity, category } = findingLabels(finding, words);
	return [
		`## ${finding.id} · ${severity} · ${category} — ${finding.title}`,
		'',
		`**${words.evidence}.** ${finding.evidence}`,
		'',
		`**${words.failureScenario}.** ${finding.failureScenario}`,
		'',
		`**${words.impact}.** ${finding.impact}`,
		'',
		`**${words.fixPlan}.**`,
		'',
		// The refinement guarantees all four blocking slots are present; the `??`
		// is only for the type checker, which cannot see a `superRefine`. The three
		// string slots above need no equivalent — they interpolate as-is.
		...(finding.fixPlan ?? []).map((step, index) => `${index + 1}. ${step}`),
		'',
		`**${words.tests}.**`,
		'',
		// Bulleted rather than numbered, unlike the fix plan above: tests to add are
		// a set, not ordered steps. Same `??` for the same reason.
		...(finding.tests ?? []).map((test) => `- ${test}`),
		'',
	];
}

/** The compact tier: one paragraph, with the optional justification for the downgrade. */
function compactFinding(finding: ReviewFinding, words: ReviewReportVocabulary): string[] {
	const { severity, category } = findingLabels(finding, words);
	const head = `**${finding.id}** · ${severity} · ${category} · ${finding.evidence} — ${finding.suggestion}`;
	if (!finding.downgradeRationale) return [head, ''];
	return [
		head,
		`*${fillLabel(words.downgradeRationale, { severity })}* ${finding.downgradeRationale}`,
		'',
	];
}

/**
 * States that nothing downstream will act on an approval's non-blocking findings,
 * when that is true. Without it a minor finding reads as a queued work item when
 * no agent will ever pick it up. A `request-changes` needs no such note: it
 * dispatches Respond-to-review, whose prompt addresses every point including
 * minors.
 */
function unansweredNote(context: RenderContext): string[] {
	if (context.minorsAnswered || context.handoff.verdict !== 'approve') return [];
	return [context.words.unansweredNote, ''];
}

/** The compact-tier region, under its own heading depending on whether blockers precede it. */
function nonBlockingSection(context: RenderContext, findings: ReviewFinding[]): string[] {
	const { words } = context;
	const minors = findings.filter((f) => f.severity === 'minor');
	const nits = findings.filter((f) => f.severity === 'nit');
	const heading =
		context.handoff.findings.length === findings.length
			? [`## ${words.findingsHeading}`, '', words.nothingBlocking, '', ...unansweredNote(context)]
			: [`## ${words.minorAndNitsHeading}`, '', ...unansweredNote(context)];
	const compact = (list: ReviewFinding[]) => list.flatMap((f) => compactFinding(f, words));
	return [
		...heading,
		...(minors.length > 0 ? [`### ${words.minorHeading}`, '', ...compact(minors)] : []),
		...(nits.length > 0 ? [`### ${words.nitsHeading}`, '', ...compact(nits)] : []),
	];
}

/**
 * The blocking findings in full and the minors and nits compact. Findings are
 * ordered blocker → major → minor → nit so the reader meets the blocking work
 * first; within one severity the agent's own order is kept. An approval with
 * nothing to report still carries the findings section ("None."), in the
 * non-blocking slot, so every verdict reads as one format.
 */
function findingSlots(context: RenderContext): { blocking: string[]; other: string[] } {
	const { handoff, words } = context;
	const ordered = [...handoff.findings].sort(
		(a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
	);
	const blocking = ordered.filter((f) => isBlockingSeverity(f.severity));
	const nonBlocking = ordered.filter((f) => !isBlockingSeverity(f.severity));
	return {
		blocking:
			blocking.length > 0 ? ['---', '', ...blocking.flatMap((f) => blockingFinding(f, words))] : [],
		other:
			handoff.findings.length === 0
				? [`## ${words.findingsHeading}`, '', words.noFindingsAtAll]
				: nonBlocking.length > 0
					? nonBlockingSection(context, nonBlocking)
					: [],
	};
}

/** A slot's lines as one block, without the trailing blank lines the layout supplies itself. */
function block(lines: readonly string[]): string {
	return lines.join('\n').replace(/\n+$/, '');
}

/** Every slot's content for this review; an empty string is a slot with nothing to say. */
function renderSlots(context: RenderContext): Record<ReviewReportSlot, string> {
	const { handoff, headSha, words } = context;
	const findings = findingSlots(context);
	return {
		pass: passLabel(context),
		verdict: words[VERDICT_WORDS[handoff.verdict]],
		head: headSha,
		findings_summary:
			handoff.carried.length > 0 ? carriedSummary(context) : findingsSummary(context),
		summary: handoff.summary,
		disposition: block(disposition(context)),
		verification: block(verificationTable(context)),
		docs_checked: docsChecked(context),
		pre_existing: block(preExisting(context)),
		absorbed: block(absorbedSection(context)),
		blocking_findings: block(findings.blocking),
		other_findings: block(findings.other),
	};
}

/**
 * Place the slots into the layout in one pass — so a `{slot}` written inside
 * agent text is never itself substituted — then append, in slot order, every slot
 * with content the layout does not place.
 */
function fillLayout(layout: string, slots: Record<ReviewReportSlot, string>): string {
	const isSlot = (name: string): name is ReviewReportSlot => Object.hasOwn(slots, name);
	const placed = new Set<string>();
	const filled = layout.replace(/\{(\w+)\}/g, (match, name: string) => {
		if (!isSlot(name)) return match;
		placed.add(name);
		return slots[name];
	});
	const missing = REVIEW_REPORT_SLOTS.filter((slot) => !placed.has(slot) && slots[slot] !== '');
	return [filled, ...missing.map((slot) => slots[slot])].join('\n\n');
}

/**
 * Render the review body: the project's layout (or SWARM's default) with every slot
 * filled, in the project's wording when the layout is its own.
 */
export function renderReviewBody(context: ReviewBodyContext): string {
	const words =
		context.layout === undefined
			? ENGLISH_REVIEW_REPORT_VOCABULARY
			: resolveReviewReportVocabulary(context.handoff.reportLabels);
	const slots = renderSlots({ ...context, words });
	return fillLayout(context.layout ?? DEFAULT_REVIEW_REPORT, slots)
		.replace(/\n{3,}/g, '\n\n')
		.trimEnd();
}
