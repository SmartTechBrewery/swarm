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
	'SEVERITY — pick from exactly these four, by what the defect *does*, never by how confident or polite you feel:',
	'  - `blocker`: it produces wrong behavior, data loss, a security hole, or a broken contract on a path this PR makes reachable. You can name the inputs and the wrong result.',
	'  - `major`: the same kind of defect, but on a path that is currently unreachable, gated behind a non-default setting, or only reachable once planned work lands. Latent, not theoretical — you can still name the trigger.',
	'  - `minor`: no defect. A real maintainability, consistency, or missing-test problem a maintainer would want fixed, but which changes no behavior today.',
	'  - `nit`: a naming, wording, or comment-accuracy remark. If it is only your preference, do not report it at all.',
	'`blocker` and `major` block the PR; `minor` and `nit` do not. If you cannot name a concrete failure, it is not a blocker or a major — downgrade it rather than hedging the wording.',
	'When a finding could plausibly have been major and you call it `minor`/`nit`, say why in `downgradeRationale`, so a real defect cannot be quietly parked among the nits.',
];

/** What each hand-off field must contain. Shared by both passes; the renderer owns the shape. */
function handoffContract(isReReview: boolean): readonly string[] {
	return [
		`Write "${REVIEW_VERDICT_FILENAME}" as JSON with these fields. SWARM renders the review from them — do not write a review body, headings, or a prose summary of your findings anywhere; anything you format yourself is discarded.`,
		'  - `verdict`: `approve` or `request-changes`. Those are the only two. It follows mechanically from your severities — any `blocker`/`major` means `request-changes`, otherwise `approve` — and the hand-off is rejected if it disagrees, so the verdict is not a separate judgement call. There is no comment-only or no-opinion verdict: if you could not verify the change at all (a command you needed is blocked, the diff is unreadable), stop and fail rather than submitting a verdict you cannot support.',
		'  - `summary`: at most three sentences. What the change does, and what you confirmed about its shape. No praise, and do not restate your findings here.',
		'  - `verification`: every command you actually ran, as `{command, outcome}` with outcome `passed` or `failed`. Report a failing command — it is evidence, not something to hide. Do not list commands you did not run.',
		'  - `docsChecked`: one entry per doc this repo requires to stay current (`README.md`, the `ai/*.md` guides, `docs/configuration.md`, `docs/status.md`), as `{path, status, note?}` with status `accurate`, `updated`, `not-applicable`, or `stale`. Judge every one — `not-applicable` is a real answer when the PR changes nothing that doc describes. A `stale` doc is itself a defect: also report it in `findings`.',
		'  - `preExisting`: conditions you noticed that predate this PR (pre-existing lint warnings, unrelated failures), so they are not charged to it. Empty array if none.',
		'  - `findings`: see below. Empty array when there is nothing to report.',
		...(isReReview
			? [
					"  - `carried`: one entry per finding the previous review raised, as `{id, title, status, detail}` with status `resolved`, `partial`, `outstanding`, or `regressed`. Reuse the previous review's finding ids (`F1`, `F2`, …) exactly — they are how SWARM tracks an item across passes. `detail` is your evidence for that status, traced in this checkout.",
				]
			: []),
		'Each finding is `{id, title, severity, category, evidence, …}`:',
		`  - \`id\`: \`F1\`, \`F2\`, … numbered in the order you report them.${isReReview ? ' Continue past the highest id the previous review used — never reuse an id for a different problem.' : ''}`,
		'  - `category`: one of `correctness`, `security`, `contract`, `performance`, `test-coverage`, `docs`, `consistency`.',
		'  - `evidence`: the `file:line` references the claim rests on, and what is there. Required at every severity. Quote the offending code only when it is under ten lines.',
		'  - For a `blocker` or `major`, additionally: `failureScenario` (concrete inputs or sequence of events → the wrong outcome, traced through this checkout), `impact` (what it costs when it happens), `fixPlan` (an array of steps naming the files or components to change), and `tests` (the tests to add or change, named specifically; `"None — doc-only."` is a valid answer).',
		'  - For a `minor` or `nit`, instead: `suggestion` — one paragraph carrying the whole point, because at this severity the suggestion is the plan. Optionally `downgradeRationale`. Do not write `failureScenario`, `impact`, `fixPlan`, or `tests` for these; the hand-off is rejected if you do.',
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
		'5. Record what became of every previously requested change in `carried` — including the ones that are now correct, since a resolved item is the result a human most needs to see. An item still missing or incorrect also becomes a finding, so it carries a severity and a fix plan.',
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
