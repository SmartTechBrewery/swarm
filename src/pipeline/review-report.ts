/**
 * Whether the review report the agent wrote itself (issue #1321) may be posted.
 *
 * The agent writes the whole report — in the language its Custom prompt asks for —
 * as the hand-off's `report`, following the structure the Review prompt builds in.
 * Nothing SWARM decides reads that text: the verdict submitted, the vote, the
 * Respond-to-review dispatch, a re-review's `carried` list and the merge all read
 * the hand-off's fields. The text is still what a human, and the next agent reading
 * the pull request, sees — so before it is posted it is checked against those
 * fields on the two points that must never drift:
 *
 *  - the verdict it states is the one SWARM submits, and
 *  - every blocking finding's id appears in it, so a blocker cannot be hidden by
 *    prose that left it out.
 *
 * A report that fails either check (or was never written) is replaced by the one
 * SWARM renders from the fields (`./review-body.ts`), which is the report every
 * review posted before this issue. Language is deliberately not checked: the
 * verdict and the ids are written verbatim in every language, which is what makes
 * both checks hold for a report SWARM cannot read.
 */

import { isBlockingSeverity, type ReviewHandoff } from '@/scm/delivery.js';

/** A verdict value as the report's header writes it: in backticks, never translated. */
const STATED_VERDICT = /`(approve|request-changes)`/;

/**
 * Whether `id` (`F3`) appears in `text` as a whole id — so `F1` is not satisfied by
 * `F10`, nor by an identifier that merely ends in it.
 */
function mentionsId(text: string, id: string): boolean {
	return new RegExp(`(?<![A-Za-z0-9_])${id}(?![0-9])`).test(text);
}

/**
 * Why the agent's report must not be posted, or `undefined` when it may be. The
 * verdict the report states is the first backticked verdict value in it, which the
 * prompt places in the header line.
 */
export function reviewReportProblem(report: string, handoff: ReviewHandoff): string | undefined {
	const stated = STATED_VERDICT.exec(report)?.[1];
	if (stated === undefined) return `it states no verdict (expected \`${handoff.verdict}\`)`;
	if (stated !== handoff.verdict)
		return `it states \`${stated}\` but the hand-off's verdict is \`${handoff.verdict}\``;
	const missing = handoff.findings
		.filter((finding) => isBlockingSeverity(finding.severity) && !mentionsId(report, finding.id))
		.map((finding) => finding.id);
	if (missing.length > 0) return `it omits blocking finding ${missing.join(', ')}`;
	return undefined;
}
