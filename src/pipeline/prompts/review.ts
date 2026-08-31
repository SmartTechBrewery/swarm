/**
 * Review-phase prompt construction (issue #135). Holds only the phase's static
 * instruction text; the orchestration (worktree, agent run, verdict delivery)
 * stays in `src/pipeline/review.ts`, which re-exports this for its existing
 * callers.
 *
 * Since issue #470 this prompt specifies **content, not layout**. The posted
 * review body is rendered by `src/pipeline/review-body.ts` from the hand-off's
 * fields, so the agent is told what each field must contain and never how the
 * review should look — that is what makes a review from `claude`, `agy`, and
 * `codex` structurally identical. Two consequences worth keeping in mind when
 * editing:
 *
 *  - **Don't reintroduce layout instructions.** Headings, section order, and the
 *    severity histogram belong to the renderer. An instruction here that also
 *    describes shape is a second source of truth that will drift.
 *  - **Don't restate what the schema enforces.** `ReviewHandoffSchema`'s
 *    refinement already rejects a nit carrying a fix plan, a blocker missing its
 *    failure scenario, and a verdict that disagrees with the severities. Prose
 *    duplicating those rules is noise; prose *contradicting* them is a bug.
 *  - **State every slot's JSON type.** Issue #861: `tests`'s only cardinality
 *    signal was an incidental string in an example, sitting beside a `fixPlan`
 *    that said "an array" — so a model continued the array pattern and a complete
 *    review was discarded over the shape of one free-text field. Naming a *type*
 *    is not restating a refinement, so rule 2 does not forbid it; nor is it the
 *    layout second-source-of-truth rule 1 warns about, which is about headings and
 *    section order the renderer owns. The drift rule 1 fears is instead caught by
 *    the audit in `tests/unit/pipeline/review.test.ts`, which fails when a schema
 *    slot's bullet here names no type.
 */

import { GH_IDENTITY_GUARD } from '@/pipeline/agent-auth.js';
import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';
import { projectInstructionsSection } from '@/pipeline/prompts/custom-prompt.js';
import { HANDOFF_FILENAMES } from '@/scm/delivery.js';

/** The hand-off file the reviewer writes with its verdict (the phase's delivery contract). */
const REVIEW_VERDICT_FILENAME = HANDOFF_FILENAMES.review;

interface ReviewPromptContext {
	repo: string;
	prNumber: string;
	headSha: string;
}

/**
 * The severity rubric, stated once and shared by both passes. Severity is the
 * prompt's most consequential output: it decides the verdict mechanically (the
 * schema rejects a mismatch), which slots the finding must fill, and whether
 * anything downstream acts on it. Left to taste, the same defect lands as a
 * blocker on one model and a nit on another — which is the drift this exists to
 * remove.
 */
const SEVERITY_RUBRIC: readonly string[] = [
	'SEVERITY — `severity` is a string, exactly one of these four. Pick it by what the defect *does*, never by how confident or polite you feel:',
	'  - `blocker`: it produces wrong behavior, data loss, a security hole, or a broken contract on a path this PR makes reachable. You can name the inputs and the wrong result.',
	'  - `major`: the same kind of defect, but on a path that is currently unreachable, gated behind a non-default setting, or only reachable once planned work lands. Latent, not theoretical — you can still name the trigger.',
	'  - `minor`: no defect. A real maintainability, consistency, or missing-test problem a maintainer would want fixed, but which changes no behavior today.',
	'  - `nit`: a naming, wording, or comment-accuracy remark. If it is only your preference, do not report it at all.',
	'`blocker` and `major` block the PR; `minor` and `nit` do not. If you cannot name a concrete failure, it is not a blocker or a major — downgrade it rather than hedging the wording.',
	'When a finding could plausibly have been major and you call it `minor`/`nit`, say why in `downgradeRationale` — a single string — so a real defect cannot be quietly parked among the nits.',
];

/** What each hand-off field must contain. Shared by both passes; the renderer owns the shape. */
function handoffContract(isReReview: boolean): readonly string[] {
	return [
		`Write "${REVIEW_VERDICT_FILENAME}" as JSON with these fields. SWARM renders the review from them — do not write a review body, headings, or a prose summary of your findings anywhere; anything you format yourself is discarded.`,
		'Every field below states its JSON type. Write exactly that type: a string slot is ONE string even when you have several things to say, and an array slot is an array even when you have one entry.',
		'  - `verdict`: a string, `approve` or `request-changes`. Those are the only two. It follows mechanically from your severities — any `blocker`/`major` means `request-changes`, otherwise `approve` — and the hand-off is rejected if it disagrees, so the verdict is not a separate judgement call. There is no comment-only or no-opinion verdict: if you could not verify the change at all (a command you needed is blocked, the diff is unreadable), stop and fail rather than submitting a verdict you cannot support.',
		'  - `summary`: a single string, at most three sentences. What the change does, and what you confirmed about its shape. No praise, and do not restate your findings here.',
		'  - `verification`: an array of `{command, outcome}` objects, one per command you actually ran; `command` is one command line as a string and `outcome` is `passed` or `failed`. At least one entry is required — the commands you read the PR with count. Report a failing command, and report one that was blocked or unavailable the same way with outcome `failed`: both are evidence, not something to hide. Do not list commands you did not run.',
		"  - `docsChecked`: an array of `{path, status, note?}` objects, one per document THIS repository requires to stay current — its README, plus whatever its own contributor/agent guide (`CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, or equivalent) says must not go stale. Read that guide to find out; do not assume another project's layout. `path` and the optional `note` are strings; `status` is `accurate`, `updated`, `not-applicable`, or `stale`. Judge every one you identify — `not-applicable` is a real answer when the PR changes nothing that document describes. A `stale` document is itself a defect: also report it in `findings`.",
		'  - `preExisting`: an array of strings, one per condition you noticed that predates this PR (pre-existing lint warnings, unrelated failures), so they are not charged to it. Empty array if none.',
		'  - `findings`: an array of finding objects — see below. Empty array when there is nothing to report.',
		...(isReReview
			? [
					"  - `carried`: an array of `{id, title, status, detail}` objects, one per finding the previous review raised; `id`, `title` and `detail` are strings and `status` is `resolved`, `partial`, `outstanding`, or `regressed`. Reuse the previous review's finding ids (`F1`, `F2`, …) exactly — they are how SWARM tracks an item across passes. `detail` is your evidence for that status, traced in this checkout. Every entry that is NOT `resolved` must also appear in `findings` under that same id, so it carries a severity and a fix plan; the hand-off is rejected if one does not.",
				]
			: []),
		'Each finding is `{id, title, severity, category, evidence, …}`:',
		`  - \`id\`: a string, \`F1\`, \`F2\`, … numbered in the order you report them.${isReReview ? " Re-reporting an item from `carried` KEEPS that item's original id — that is what lets SWARM follow one problem across passes. Mint a new id only for a problem no earlier pass raised, continuing past the highest id the previous review used; never reuse an id for a different problem." : ''}`,
		'  - `title`: a single string — one short line naming the defect, not a sentence about it.',
		'  - `category`: a string, exactly one of `correctness`, `security`, `contract`, `performance`, `test-coverage`, `docs`, `consistency`.',
		'  - `evidence`: a single string — the `file:line` references the claim rests on, and what is there; keep several references inside that one string. Required at every severity. Quote the offending code only when it is under ten lines.',
		'  - For a `blocker` or `major`, additionally: `failureScenario` (a single string: concrete inputs or sequence of events → the wrong outcome, traced through this checkout), `impact` (a single string: what it costs when it happens), `fixPlan` (an array of strings, one per step, naming the files or components to change), and `tests` (an array of strings, one per test to add or change, named specifically; `["None — doc-only."]` is a valid answer).',
		'  - For a `minor` or `nit`, instead: `suggestion` — a single string, one paragraph carrying the whole point, because at this severity the suggestion is the plan. Optionally `downgradeRationale`, also a single string. Do not write `failureScenario`, `impact`, `fixPlan`, or `tests` for these; the hand-off is rejected if you do.',
		'Do not implement any fix yourself. Do NOT `git add`/commit the hand-off.',
	];
}

/**
 * The numbered instruction block for a PR's **first** review — a full pass over
 * the whole diff, reporting every notable issue with a proposed fix plan.
 */
function initialReviewInstructions({ repo, prNumber }: ReviewPromptContext): string[] {
	return [
		'Do all of the following, in order:',
		`1. Read the PR and its discussion: \`gh pr view ${prNumber} --repo ${repo} --comments\`. If the PR body references an issue, read that too (\`gh issue view <n> --repo ${repo} --comments\`) — the issue and any plan posted on it are the ground truth for what was agreed.`,
		`2. Read the full diff: \`gh pr diff ${prNumber} --repo ${repo}\`. Review ALL changed files, not just the first few.`,
		'3. Verify before claiming: for each candidate finding, trace the exact failing scenario in the surrounding code of this checkout. Only report issues you can demonstrate — do not invent problems, pad the review with praise, or restate personal preferences as defects.',
		'Use the checked-out code and existing tests for that verification. Do not create disposable repositories or alter Git configuration to reproduce a concern, and never run destructive cleanup commands such as `rm -rf`.',
		'If an optional command is unavailable or blocked, continue the review with the evidence already available and still write the required hand-off file.',
		'4. Judge every documentation file this repo requires to stay current, and report a stale one as a finding in its own right.',
		'5. Assign each finding a severity from the rubric below, then record everything in the hand-off.',
		'6. Do not submit a review or perform any GitHub mutation. SWARM submits the decision after you exit.',
		`In particular, do not run \`gh pr review ${prNumber} --repo ${repo}\`, \`--approve\`, \`--request-changes\`, or \`--comment\`. GH_TOKEN is read-only context authentication; do not run gh auth switch.`,
		'',
		...SEVERITY_RUBRIC,
		'',
		...handoffContract(false),
	];
}

/**
 * The numbered instruction block for a **re-review** (issue #328) — the PR has
 * already received a `request-changes` review, and the implementer has pushed
 * new commits in response. A re-review has exactly one job: verify that the
 * previously requested changes were implemented correctly. It must NOT widen the
 * review by surfacing pre-existing issues an earlier review missed — doing so
 * burns one of the PR's few permitted verdicts on unrelated work and restarts
 * the change cycle instead of confirming (or correcting) the fix.
 */
function reReviewInstructions({ repo, prNumber }: ReviewPromptContext): string[] {
	return [
		'This PR was already reviewed and the most recent review REQUESTED CHANGES; the',
		'implementer has since pushed new commits in response. This is a RE-REVIEW, and',
		'it has exactly one job: verify that the previously requested changes were',
		'implemented correctly. Do NOT broaden the review.',
		'',
		'Do all of the following, in order:',
		`1. Read the PR and its earlier review: \`gh pr view ${prNumber} --repo ${repo} --comments\`. Find the most recent SWARM review that requested changes and list the specific changes it required, with the finding id (\`F1\`, \`F2\`, …) each one carried. If the PR references an issue, read it too (\`gh issue view <n> --repo ${repo} --comments\`) for the agreed ground truth.`,
		`2. Read the diff: \`gh pr diff ${prNumber} --repo ${repo}\`. For each change the previous review required, trace it in this checkout and decide whether it is now correctly and completely implemented. Use the checked-out code and existing tests as evidence.`,
		'3. STAY IN SCOPE. Do NOT raise new findings for pre-existing issues an earlier review did not flag, even if you notice them now — a re-review must not restart the cycle over problems that were missed earlier. The ONLY issues you may report as new findings are: (a) a previously requested change that is still missing or was implemented incorrectly, or (b) a defect the new commits themselves introduced — a regression in the fix, including a doc the new changes made stale. Everything else is out of scope; leave it for a human.',
		'4. Verify before claiming: demonstrate each conclusion against the checked-out code and its tests. Do not invent problems or restate personal preferences as defects. Do not create disposable repositories or alter Git configuration to reproduce a concern, and never run destructive cleanup commands such as `rm -rf`. If an optional command is unavailable or blocked, continue with the evidence already available and still write the required hand-off file.',
		'5. Record what became of every previously requested change in `carried` — including the ones that are now correct, since a resolved item is the result a human most needs to see. Anything you did not mark `resolved` also becomes a finding under its original id, so it carries a severity and a fix plan; that is what keeps the verdict honest about work still outstanding.',
		'6. Do not submit a review or perform any GitHub mutation. SWARM submits the decision after you exit.',
		`In particular, do not run \`gh pr review ${prNumber} --repo ${repo}\`, \`--approve\`, \`--request-changes\`, or \`--comment\`. GH_TOKEN is read-only context authentication; do not run gh auth switch.`,
		'',
		...SEVERITY_RUBRIC,
		'',
		...handoffContract(true),
	];
}

/**
 * Build the prompt handed to the review agent. It's told this is review-only
 * (findings, never fixes — mirroring Cascade's review agent, which is
 * hard-blocked from editing), to read the PR / linked issue / full diff, to
 * verify findings against the checkout before reporting them, and to record its
 * verdict and findings as hand-off *fields* that SWARM renders into the posted
 * review (issue #470).
 *
 * When `isReReview` is set (issue #328) the PR has already had at least one
 * `request-changes` review, so the agent gets the re-review variant of the
 * instructions: verify only whether the previously requested changes were
 * implemented correctly, never surface newly-noticed pre-existing issues.
 *
 * `customPrompt` is the project's optional per-phase instructions (issue #135),
 * appended after the SWARM instructions as a clearly delimited, supplement-only
 * section (empty when unset).
 */
export function buildReviewPrompt(
	context: ReviewPromptContext,
	customPrompt?: string,
	isReReview = false,
): string {
	const { repo, prNumber, headSha } = context;
	return [
		'You are a senior code reviewer reviewing a pull request.',
		'',
		...pipelinePhaseGuard(),
		...GH_IDENTITY_GUARD,
		'',
		'REVIEW ONLY. Do NOT edit files, fix code, commit, push, or change the repository',
		'in any way. When you find a problem, report it as a review finding — never fix it',
		'yourself.',
		'',
		`This worktree is checked out (detached) at ${headSha}, the head commit of PR`,
		`#${prNumber} in ${repo} on GitHub.`,
		'',
		...(isReReview ? reReviewInstructions(context) : initialReviewInstructions(context)),
		'',
		'Do not merge the PR.',
		...projectInstructionsSection(customPrompt),
	].join('\n');
}

/**
 * The prompt for the single repair pass a malformed hand-off gets
 * (`src/pipeline/review.ts`). The agent never sees `ReviewHandoffSchema`'s
 * complaint otherwise — the run just fails and the queue re-runs the *whole*
 * review, so a model that mis-shapes the JSON burns every attempt without ever
 * being told why. Handing it the validation error is far cheaper than a second
 * full pass, and it is the only feedback path the schema's enforcement has.
 *
 * Deliberately narrow: the review itself already happened and its conclusions
 * stand. This asks for the hand-off file to be rewritten, not re-judged — a
 * repair that quietly changes the verdict to satisfy a slot rule would be worse
 * than the failure it replaces.
 */
export function buildReviewHandoffRepairPrompt(
	validationError: string,
	isReReview = false,
): string {
	return [
		`The review you just completed is NOT submitted: the hand-off you wrote to "${REVIEW_VERDICT_FILENAME}" failed SWARM's validation.`,
		'',
		'The validator reported:',
		validationError,
		'',
		`Rewrite "${REVIEW_VERDICT_FILENAME}" so it satisfies every rule below. Keep your findings, your severities, and your verdict as they are — this is a formatting repair, not a re-review. Change a severity or the verdict only where the validator says they contradict each other, and where a required slot is missing, fill it from the evidence you already gathered (re-read the checkout if you must; never invent one).`,
		'',
		'REVIEW ONLY, as before: do not edit any other file, do not commit, do not push, do not submit a review or perform any GitHub mutation. SWARM submits the decision after you exit.',
		'',
		...SEVERITY_RUBRIC,
		'',
		...handoffContract(isReReview),
	].join('\n');
}
