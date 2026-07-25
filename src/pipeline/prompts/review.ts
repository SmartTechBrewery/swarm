/**
 * Review-phase prompt construction (issue #135). Holds only the phase's static
 * instruction text; the orchestration (worktree, agent run, verdict delivery)
 * stays in `src/pipeline/review.ts`, which re-exports this for its existing
 * callers.
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
 * The numbered instruction block for a PR's **first** review — a full pass over
 * the whole diff, reporting every notable issue with a proposed fix plan. This
 * is the original SWARM review behaviour, unchanged.
 */
function initialReviewInstructions({ repo, prNumber }: ReviewPromptContext): string[] {
	return [
		'Do all of the following, in order:',
		`1. Read the PR and its discussion: \`gh pr view ${prNumber} --repo ${repo} --comments\`. If the PR body references an issue, read that too (\`gh issue view <n> --repo ${repo} --comments\`) — the issue and any plan posted on it are the ground truth for what was agreed.`,
		`2. Read the full diff: \`gh pr diff ${prNumber} --repo ${repo}\`. Review ALL changed files, not just the first few.`,
		'3. Confirm README.md remains accurate for the changes in this PR. If a configuration, architecture, workflow, or user-facing behavior change makes it stale, report the missing README update as a review finding.',
		'4. Verify before claiming: for each candidate finding, trace the exact failing scenario in the surrounding code of this checkout. Only report issues you can demonstrate — do not invent problems, pad the review with praise, or restate personal preferences as defects.',
		'Use the checked-out code and existing tests for that verification. Do not create disposable repositories or alter Git configuration to reproduce a concern, and never run destructive cleanup commands such as `rm -rf`.',
		'If an optional command is unavailable or blocked, continue the review with the evidence already available and still write the required hand-off file.',
		'5. For every notable issue, provide an actionable proposed fix plan. The plan must explain the intended change, identify the relevant files or components, and name tests or verification that should be added or updated. Do not merely say to fix the issue, and do not implement the plan yourself.',
		'6. Do not submit a review or perform any GitHub mutation. SWARM submits the decision after you exit.',
		`In particular, do not run \`gh pr review ${prNumber} --repo ${repo}\`, \`--approve\`, \`--request-changes\`, or \`--comment\`. GH_TOKEN is read-only context authentication; do not run gh auth switch.`,
		`7. Write "${REVIEW_VERDICT_FILENAME}" as JSON containing verdict (approve, request-changes, or comment), body (the final review body), and optional findings [{title,body,fixPlan}]. Include every notable issue in findings, and make each finding's fixPlan specific and actionable. The final review body must also include each finding's evidence, impact, and proposed fix plan so the submitted GitHub review is self-contained. If there are no notable issues, use an empty findings array and approve or comment as appropriate.`,
		'Do NOT `git add`/commit the hand-off.',
	];
}

/**
 * The numbered instruction block for a **re-review** (issue #328) — the PR has
 * already received a `request-changes` review, and the implementer has pushed
 * new commits in response. A re-review has exactly one job: verify that the
 * previously requested changes were implemented correctly. It must NOT widen the
 * review by surfacing pre-existing issues an earlier review missed — doing so
 * burns one of the PR's few permitted verdicts on unrelated work and restarts
 * the change cycle instead of confirming (or correcting) the fix. Approve when every
 * requested change is correctly addressed; otherwise request changes with a
 * strong, specific instruction on how to fix each outstanding item.
 */
function reReviewInstructions({ repo, prNumber }: ReviewPromptContext): string[] {
	return [
		'This PR was already reviewed and the most recent review REQUESTED CHANGES; the',
		'implementer has since pushed new commits in response. This is a RE-REVIEW, and',
		'it has exactly one job: verify that the previously requested changes were',
		'implemented correctly. Do NOT broaden the review.',
		'',
		'Do all of the following, in order:',
		`1. Read the PR and its earlier review: \`gh pr view ${prNumber} --repo ${repo} --comments\`. Find the most recent SWARM review that requested changes and list the specific changes it required — its findings and proposed fix plans are recorded in that review body. If the PR references an issue, read it too (\`gh issue view <n> --repo ${repo} --comments\`) for the agreed ground truth.`,
		`2. Read the diff: \`gh pr diff ${prNumber} --repo ${repo}\`. For each change the previous review required, trace it in this checkout and decide whether it is now correctly and completely implemented. Use the checked-out code and existing tests as evidence.`,
		'3. STAY IN SCOPE. Do NOT raise new findings for pre-existing issues an earlier review did not flag, even if you notice them now — a re-review must not restart the cycle over problems that were missed earlier. The ONLY issues you may report are: (a) a previously requested change that is still missing or was implemented incorrectly, or (b) a defect the new commits themselves introduced — a regression in the fix, including a README the new changes made stale. Everything else is out of scope; leave it for a human.',
		'4. Verify before claiming: demonstrate each conclusion against the checked-out code and its tests. Do not invent problems or restate personal preferences as defects. Do not create disposable repositories or alter Git configuration to reproduce a concern, and never run destructive cleanup commands such as `rm -rf`. If an optional command is unavailable or blocked, continue with the evidence already available and still write the required hand-off file.',
		'5. Decide the verdict:',
		'   - If every previously requested change is now correctly implemented and the new commits introduced no defect, use verdict approve.',
		'   - Otherwise use verdict request-changes. For each item still missing or incorrect, give a strong, specific, actionable instruction on exactly how to fix it: the intended change, the files or components to touch, and the tests or verification to add or update. Do not merely say to fix it, and do not implement the fix yourself.',
		'6. Do not submit a review or perform any GitHub mutation. SWARM submits the decision after you exit.',
		`In particular, do not run \`gh pr review ${prNumber} --repo ${repo}\`, \`--approve\`, \`--request-changes\`, or \`--comment\`. GH_TOKEN is read-only context authentication; do not run gh auth switch.`,
		`7. Write "${REVIEW_VERDICT_FILENAME}" as JSON containing verdict (approve, request-changes, or comment), body (the final review body), and optional findings [{title,body,fixPlan}]. Restrict findings to the in-scope items from step 3 only, and make each finding's fixPlan specific and actionable. The final review body must include each finding's evidence, impact, and proposed fix plan so the submitted GitHub review is self-contained. If every requested change is correctly implemented, use an empty findings array and approve.`,
		'Do NOT `git add`/commit the hand-off.',
	];
}

/**
 * Build the prompt handed to the review agent. It's told this is review-only
 * (findings, never fixes — mirroring Cascade's review agent, which is
 * hard-blocked from editing), to read the PR / linked issue / full diff, to
 * verify findings against the checkout before reporting them, and to record its
 * verdict to the hand-off file so this phase can validate the hand-off.
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
