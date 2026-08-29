/**
 * Plan-verification prompt construction (issue #818) — the opt-in
 * `pipeline.planning.verifyPlan` fact-check pass.
 *
 * A second, independent agent is launched in the same still-read-only planning
 * worktree once the planning agent has written its plan, and before anything is
 * posted as a comment or applied to the board. It has no memory of how the plan
 * was authored (a fresh process, no session reuse), so it reads the plan as an
 * auditor rather than as its author: every concrete, falsifiable claim is checked
 * against the repository as it actually is, and only real inaccuracies are
 * corrected — in place, each carrying a short inline marker.
 *
 * Like `src/pipeline/prompts/planning.ts` this is a pure builder with no I/O; the
 * run itself, and the best-effort contract around it, live in
 * `src/pipeline/planning.ts`. The two marks the pass leaves on a plan a human
 * reads — the inline {@link PLAN_CORRECTION_MARKER} the prompt asks for, and the
 * {@link PLAN_VERIFIED_NOTE} the phase appends once the pass has completed — are
 * defined here too, so the pass's whole visible vocabulary is in one place.
 */

import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';
import { PROPOSED_PLAN_FILENAME, PROPOSED_SPLIT_FILENAME } from '@/pipeline/prompts/planning.js';

/**
 * Prefix every in-place correction the verification pass leaves behind, so a
 * corrected claim is auditable in the posted plan rather than a silent edit.
 */
export const PLAN_CORRECTION_MARKER = '[plan-verify]';

/**
 * Lead sentence of the note appended to every plan a *completed* verification
 * pass checked (issue #831).
 *
 * A pass that finds nothing wrong leaves no {@link PLAN_CORRECTION_MARKER}
 * anywhere — the prompt's hard rule is to change nothing at all when every claim
 * checks out — so without this note a posted plan reads identically whether it
 * was verified and found accurate, was never verified (`verifyPlan` off), or was
 * verified by a pass that failed and fell back to the unverified plan. The note
 * is written only on the first of those three, which is what keeps the other two
 * distinguishable from the comment alone.
 *
 * Exported as the lead alone so {@link appendPlanVerifiedNote} can recognise a
 * note it has already written.
 */
export const PLAN_VERIFIED_NOTE =
	'Fact-checked against the repository by an independent verification pass';

/**
 * Append {@link PLAN_VERIFIED_NOTE} to one plan — the main task's own, or a
 * split child's `subTasks[].plan`, which is posted as that child's Preplan
 * comment and replayed verbatim as its plan. `corrected` is the pass's own
 * whole-run outcome, so the corrected wording claims only that corrections are
 * marked *where they were made*: one artifact of a corrected run may itself have
 * needed nothing.
 *
 * Idempotent — a resumed planning run can re-verify a plan this already
 * annotated, and a second note would say nothing the first did not.
 */
export function appendPlanVerifiedNote(plan: string, corrected: boolean): string {
	const trimmed = plan.trim();
	if (trimmed.includes(PLAN_VERIFIED_NOTE)) return trimmed;
	const detail = corrected
		? `; any corrections are marked inline with \`${PLAN_CORRECTION_MARKER}\``
		: ' — no inaccuracies found';
	return `${trimmed}\n\n_${PLAN_VERIFIED_NOTE}${detail}._`;
}

/**
 * Build the prompt handed to the verification agent. `hasSplit` is whether the
 * planning run wrote a {@link PROPOSED_SPLIT_FILENAME}: only then is the split
 * file named at all, since a plan that proposes no split has no sibling plans to
 * fact-check.
 *
 * Deliberately **not** included: the work item's title/description, and the
 * project's per-phase custom prompt. The plan on disk is self-contained, and both
 * of those are inputs to *authoring* a plan — handing them to an auditor invites
 * exactly the design/scope relitigation this pass forbids.
 */
export function buildPlanVerificationPrompt(hasSplit: boolean): string {
	const lines = [
		'You are a meticulous fact-checker auditing an implementation plan.',
		'',
		...pipelinePhaseGuard(),
		'',
		'Another agent has just written an implementation plan in this worktree. Your',
		'ONLY job is to fact-check its concrete, falsifiable claims against this',
		'repository as it actually is, and to correct any that are wrong.',
		'',
		'FILES YOU MAY READ AND EDIT — these, and nothing else:',
		`  - "${PROPOSED_PLAN_FILENAME}" at the root of this worktree: the plan itself.`,
	];

	if (hasSplit) {
		lines.push(
			`  - "${PROPOSED_SPLIT_FILENAME}" at the root of this worktree: ONLY the`,
			'    "plan" string of each entry in its "subTasks" array. Leave every other',
			'    field untouched, and keep the file valid JSON of exactly the same shape.',
			'    This matters: each of those plans is replayed verbatim onto a split child',
			'    that never gets a Planning run of its own, so this is the only fact-check',
			'    those plans will ever get.',
		);
	}

	lines.push(
		'',
		'WHAT COUNTS AS A CHECKABLE CLAIM — read the repository and confirm each one:',
		'  - file and directory paths (do they exist, at that path?);',
		'  - function, type, class, constant, and config-key names (do they exist, spelled',
		'    that way, exported from there?);',
		'  - line numbers cited alongside a file;',
		'  - dependency claims — "already merged", "already shipped", "phase N gives us X";',
		'  - descriptions of existing behavior, conventions, or patterns the plan says to',
		'    mirror (does the named code actually do or look like that?).',
		'Check the claims that look obviously true as well — those are the ones that drift.',
		'',
		'HARD RULES — this is a fact-check, not a re-plan:',
		"  - Do NOT relitigate the plan's design, approach, ordering, or scope. A plan",
		'    decision you disagree with is NOT an inaccuracy; leave it exactly as written.',
		'  - Do NOT edit any other file: no source file, no test, no documentation, no',
		'    "proposed_scope.json", and no new file of any kind.',
		'  - Do NOT run `git commit`, `git push`, the source-control CLI, or any command',
		'    that writes to the repository, the project board, or the network.',
		'  - Do NOT rewrite the plan wholesale, restructure it, or "improve" prose that is',
		'    factually correct. If every claim checks out, change NOTHING at all and say so.',
		'',
		'HOW TO CORRECT — the smallest precise replacement of the wrong text, followed',
		'inline by one short marker naming what was wrong and the evidence, e.g.',
		`  _(${PLAN_CORRECTION_MARKER} "renamed to \`foo()\`" → the function is \`bar()\`, src/x.ts:41)_`,
		'so every correction is auditable and scannable, and none is silent.',
		'',
		'When you have finished checking every claim, stop.',
	);

	return lines.join('\n');
}
