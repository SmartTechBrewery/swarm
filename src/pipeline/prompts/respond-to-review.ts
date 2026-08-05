/**
 * Respond-to-review-phase prompt construction (issue #135). Holds only the
 * phase's static instruction text; the orchestration stays in
 * `src/pipeline/respond-to-review.ts`, which re-exports this for its existing
 * callers.
 */

import { GH_IDENTITY_GUARD } from '@/pipeline/agent-auth.js';
import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';
import type { Checkpoint } from '@/pipeline/checkpoint.js';
import {
	checkpointContinuationSection,
	checkpointInstructions,
} from '@/pipeline/prompts/checkpoint.js';
import { projectInstructionsSection } from '@/pipeline/prompts/custom-prompt.js';
import { HANDOFF_FILENAMES } from '@/scm/delivery.js';

/** The hand-off file the respond agent writes with its outcome (the phase's delivery contract). */
const RESPOND_OUTCOME_FILENAME = HANDOFF_FILENAMES.respondToReview;

/**
 * Build the prompt handed to the respond agent. It's told it authored the PR
 * and is answering its reviewer: sync the branch first, read the pinned review
 * (summary body plus its batched line comments — the review API, not the issue
 * comment stream), address every point — including minor/nit suggestions, not
 * just blocking ones — as either a fix or a reasoned push-back, verify fixes
 * before pushing, ALWAYS reply on the PR, and record which outcome applied to
 * the hand-off file so this phase can validate the hand-off.
 *
 * `customPrompt` is the project's optional per-phase instructions (issue #135),
 * appended after the SWARM instructions as a clearly delimited, supplement-only
 * section (empty when unset).
 */
export function buildRespondToReviewPrompt(
	context: {
		repo: string;
		prNumber: string;
		prBranch: string;
		reviewId: string;
		/** The validated checkpoint a Tier 2 continuation adopted this worktree on; unset on an ordinary run. */
		checkpoint?: Checkpoint;
	},
	customPrompt?: string,
): string {
	const { repo, prNumber, prBranch, reviewId, checkpoint } = context;
	return [
		'You are a senior software engineer responding to a code review on a pull request',
		'you authored.',
		'',
		...pipelinePhaseGuard(),
		...GH_IDENTITY_GUARD,
		'',
		`This worktree has branch "${prBranch}" checked out — the head branch of PR`,
		`#${prNumber} in ${repo} on GitHub. A reviewer has submitted a review — it may`,
		'request changes, just comment, or approve with suggestions attached. Respond to it',
		'regardless of verdict: an approval is not a reason to stay silent.',
		'',
		'Do all of the following, in order:',
		`1. Sync the branch with what the reviewer saw: \`git pull --ff-only origin ${prBranch}\`. If this fails for any reason (diverged branch, deleted remote branch, network error), stop and exit non-zero rather than responding against stale code.`,
		`2. Read the submitted review you are responding to: \`gh api repos/${repo}/pulls/${prNumber}/reviews/${reviewId}\` for its summary body, and \`gh api repos/${repo}/pulls/${prNumber}/reviews/${reviewId}/comments\` for its line comments. Read the PR discussion for context too: \`gh pr view ${prNumber} --repo ${repo} --comments\`.`,
		'3. Address EVERY point the review raises — including minor/nit suggestions, not',
		'   just blocking "changes requested" items; a valid nit is worth fixing even on an',
		'   approval. For each point, either:',
		'   - fix the code (keep the fix surgical — only go broader when the reviewer clearly asks for it), or',
		'   - if the point is mistaken, push back: no code change, but a clear rationale in your reply below.',
		'   If the review raised no specific points at all (e.g. a plain approval with',
		'   nothing to fix or question), skip straight to step 5.',
		'4. If you changed code, run lint, type-check, and relevant tests. Do not commit, push, comment, or perform any GitHub mutation.',
		`Do not run \`git push origin ${prBranch}\` or \`gh pr comment ${prNumber} --repo ${repo}\`; GH_TOKEN is read-only context authentication and you must not run gh auth switch. Do NOT \`git add\`/commit the hand-off.`,
		`5. Write "${RESPOND_OUTCOME_FILENAME}" as JSON with outcome (fixed, pushed-back, or no-findings), body (the point-by-point PR reply), optional commitSubject when fixed, and verification [{command,outcome:"passed"}].`,
		'The outcome strings are exactly `fixed`, `pushed-back`, and `no-findings`. The body must ALWAYS reply on the PR point by point; with no findings, post a short comment thanking the reviewer — never skip this step, even when there is nothing to fix.',
		'',
		...checkpointInstructions('respond-to-review'),
		'',
		...(checkpoint ? [...checkpointContinuationSection(checkpoint), ''] : []),
		'Do not merge the PR, and do not submit a review of your own — you are the author.',
		...projectInstructionsSection(customPrompt),
	].join('\n');
}
