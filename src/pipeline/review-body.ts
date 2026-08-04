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
 */

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
	 * for this project (`pipeline.respondToReview.skipOnMinors === false`). When it
	 * doesn't, an approval's minor findings are stated as notes for a human,
	 * because nothing in the pipeline will pick them up.
	 */
	minorsAnswered: boolean;
}

const SEVERITY_ORDER: Record<ReviewFinding['severity'], number> = {
	blocker: 0,
	major: 1,
	minor: 2,
	nit: 3,
};

/** Ordinal → the name a human uses for that pass. Bounded by `REVIEW_VERDICT_CAP`. */
const RE_REVIEW_NAMES = ['First re-review', 'Second re-review', 'Third re-review'] as const;

function passLabel({ ordinal, cap, isReReview }: ReviewBodyContext): string {
	if (ordinal === undefined) return isReReview ? '**Re-review**' : '**Review**';
	const name =
		ordinal === 1 ? 'Review' : (RE_REVIEW_NAMES[ordinal - 2] ?? `Re-review ${ordinal - 1}`);
	// Naming the last permitted pass in the line a human reads first: a
	// cap-reaching `request-changes` stops the automatic cycle, and today that is
	// visible only in a log field.
	const final = ordinal >= cap ? ' — final permitted verdict' : '';
	return `**${name}** · pass ${ordinal} of ${cap}${final}`;
}

/** `1 blocker · 1 major · 0 minor · 0 nits` — the line a human scans before any prose. */
function severityHistogram(findings: readonly ReviewFinding[]): string {
	const count = (severity: ReviewFinding['severity']) =>
		findings.filter((f) => f.severity === severity).length;
	const nits = count('nit');
	return [
		`${count('blocker')} blocker`,
		`${count('major')} major`,
		`${count('minor')} minor`,
		`${nits} ${nits === 1 ? 'nit' : 'nits'}`,
	].join(' · ');
}

function findingsSummary(handoff: ReviewHandoff): string {
	const { findings } = handoff;
	if (findings.length === 0) return '**No findings**';
	const blocking = findings.some((f) => isBlockingSeverity(f.severity));
	const noun = findings.length === 1 ? 'finding' : 'findings';
	const suffix = blocking ? '' : ' · **none blocking**';
	return `**${findings.length} ${noun}** — ${severityHistogram(findings)}${suffix}`;
}

function carriedSummary(carried: readonly ReviewCarriedFinding[], newCount: number): string {
	const resolved = carried.filter((c) => c.status === 'resolved').length;
	const outstanding = carried.length - resolved;
	const news = newCount === 0 ? '**0 new findings**' : `**${newCount} new**`;
	return `**Carried: ${resolved} resolved · ${outstanding} outstanding** — ${news}`;
}

/** The blockquote header: pass, verdict, head, and the counts. */
function header(context: ReviewBodyContext): string[] {
	const { handoff, headSha } = context;
	const counts =
		handoff.carried.length > 0
			? carriedSummary(handoff.carried, handoff.findings.length)
			: findingsSummary(handoff);
	return [
		`> ${passLabel(context)} · \`${handoff.verdict}\` · head \`${headSha}\``,
		`> ${counts}`,
		'',
	];
}

const CARRIED_STATUS_LABELS: Record<ReviewCarriedFinding['status'], string> = {
	resolved: '✅ resolved',
	partial: '⚠️ partially addressed',
	outstanding: '❌ not addressed',
	regressed: '❌ regressed',
};

/** One row per finding an earlier pass raised — "was every point addressed" at a glance. */
function disposition(carried: readonly ReviewCarriedFinding[]): string[] {
	if (carried.length === 0) return [];
	return [
		'## Disposition',
		'',
		'| ID | Finding | Status |',
		'| --- | --- | --- |',
		...carried.map((c) => `| ${c.id} | ${c.title} | ${CARRIED_STATUS_LABELS[c.status]} |`),
		'',
		...carried.flatMap((c) => [
			`### ${c.id} · ${CARRIED_STATUS_LABELS[c.status]}`,
			'',
			c.detail,
			'',
		]),
	];
}

const DOC_STATUS_LABELS: Record<ReviewDocCheck['status'], string> = {
	accurate: '✅ accurate',
	updated: '✅ updated',
	'not-applicable': '✅ correctly untouched',
	stale: '❌ stale',
};

function verification(handoff: ReviewHandoff): string[] {
	const docs = handoff.docsChecked
		.map((d) => `\`${d.path}\` ${DOC_STATUS_LABELS[d.status]}${d.note ? ` (${d.note})` : ''}`)
		.join(' · ');
	return [
		'## Verification',
		'',
		'| Command | Result |',
		'| --- | --- |',
		...handoff.verification.map(
			(v) => `| \`${v.command}\` | ${v.outcome === 'passed' ? 'passed' : '**failed**'} |`,
		),
		'',
		`**Docs checked** — ${docs}`,
		...(handoff.preExisting.length === 0
			? []
			: ['', `**Pre-existing, not from this PR** — ${handoff.preExisting.join(' · ')}`]),
		'',
	];
}

/** The blocking tier: full slots, because a blocker has to be demonstrable to act on. */
function blockingFinding(finding: ReviewFinding): string[] {
	return [
		`## ${finding.id} · ${finding.severity} · ${finding.category} — ${finding.title}`,
		'',
		`**Evidence.** ${finding.evidence}`,
		'',
		`**Failure scenario.** ${finding.failureScenario}`,
		'',
		`**Impact.** ${finding.impact}`,
		'',
		'**Fix plan.**',
		'',
		...(finding.fixPlan ?? []).map((step, index) => `${index + 1}. ${step}`),
		'',
		`**Tests.** ${finding.tests}`,
		'',
	];
}

/** The compact tier: one paragraph, with the optional justification for the downgrade. */
function compactFinding(finding: ReviewFinding): string[] {
	const head = `**${finding.id}** · ${finding.severity} · ${finding.category} · ${finding.evidence} — ${finding.suggestion}`;
	if (!finding.downgradeRationale) return [head, ''];
	return [head, `*Why it is ${finding.severity}, not major:* ${finding.downgradeRationale}`, ''];
}

/**
 * States that nothing downstream will act on an approval's non-blocking findings,
 * when that is true. Without it a minor finding reads as a queued work item when
 * no agent will ever pick it up. A `request-changes` needs no such note: it
 * dispatches Respond-to-review, whose prompt addresses every point including
 * minors.
 */
function unansweredNote(context: ReviewBodyContext): string[] {
	if (context.minorsAnswered || context.handoff.verdict !== 'approve') return [];
	return [
		'These are not blocking and **no agent will act on them**: an `approve` review is skipped by',
		"the Respond-to-review trigger under this project's `pipeline.respondToReview.skipOnMinors`,",
		'so they are notes for a human.',
		'',
	];
}

/** The compact-tier region, under its own heading depending on whether blockers precede it. */
function nonBlockingSection(context: ReviewBodyContext, findings: ReviewFinding[]): string[] {
	const minors = findings.filter((f) => f.severity === 'minor');
	const nits = findings.filter((f) => f.severity === 'nit');
	const heading =
		context.handoff.findings.length === findings.length
			? ['## Findings', '', 'Nothing blocking.', '', ...unansweredNote(context)]
			: ['## Minor & nits', '', ...unansweredNote(context)];
	return [
		...heading,
		...(minors.length > 0 ? ['### Minor', '', ...minors.flatMap(compactFinding)] : []),
		...(nits.length > 0 ? ['### Nits', '', ...nits.flatMap(compactFinding)] : []),
	];
}

/**
 * Render the review body. Findings are ordered blocker → major → minor → nit so
 * the reader meets the blocking work first; within one severity the agent's own
 * order is kept.
 */
export function renderReviewBody(context: ReviewBodyContext): string {
	const { handoff } = context;
	const ordered = [...handoff.findings].sort(
		(a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
	);
	const blocking = ordered.filter((f) => isBlockingSeverity(f.severity));
	const nonBlocking = ordered.filter((f) => !isBlockingSeverity(f.severity));

	return [
		...header(context),
		'## Scope',
		'',
		handoff.summary,
		'',
		...disposition(handoff.carried),
		...verification(handoff),
		...(blocking.length > 0 ? ['---', '', ...blocking.flatMap(blockingFinding)] : []),
		...(nonBlocking.length > 0 ? nonBlockingSection(context, nonBlocking) : []),
		// An approval with nothing to report still carries the section, so every
		// verdict reads as one format.
		...(handoff.findings.length === 0 ? ['## Findings', '', 'None.'] : []),
	]
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trimEnd();
}
