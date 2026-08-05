/**
 * Implementation-phase prompt construction (issue #135). Holds only the phase's
 * static instruction text; the orchestration (worktree, agent run, delivery, PM
 * moves) stays in `src/pipeline/implementation.ts`, which re-exports these for
 * its existing callers.
 */

import { GH_IDENTITY_GUARD } from '@/pipeline/agent-auth.js';
import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';
import { CHECKPOINT_FILENAME, type Checkpoint } from '@/pipeline/checkpoint.js';
import {
	checkpointContinuationSection,
	checkpointInstructions,
} from '@/pipeline/prompts/checkpoint.js';
import { projectInstructionsSection } from '@/pipeline/prompts/custom-prompt.js';
import type { WorkItem } from '@/pm/types.js';
import { HANDOFF_FILENAMES } from '@/scm/delivery.js';

/** The hand-off file the implementer writes with the opened-PR details (the phase's delivery contract). */
const OPENED_PR_FILENAME = HANDOFF_FILENAMES.implementation;

/**
 * The file the implementer writes instead of a PR when a genuine external
 * prerequisite blocks the work. Read back by `readBlockedReason`
 * (`src/pipeline/implementation.ts`); lives here because the prompt names it.
 */
export const BLOCKED_REASON_FILENAME = 'blocked_reason.md';

/**
 * Build the prompt handed to the implementation agent. It's told to implement the
 * work item (following the plan the Planning phase posted on the linked Issue),
 * verify with lint/typecheck/tests, and record the prepared change for SWARM to
 * deliver.
 *
 * `customPrompt` is the project's optional per-phase instructions (issue #135):
 * appended after the SWARM instructions and before the work-item context as a
 * clearly delimited, supplement-only section (empty when unset).
 */
export function buildImplementationPrompt(
	workItem: WorkItem,
	context: {
		repo: string;
		taskId: string;
		branch: string;
		baseBranch: string;
		/**
		 * Absolute path of the provisioned worktree, named explicitly in the prompt
		 * when the agent's process does not run *from* it. Set only for Antigravity
		 * (issue #226): `agy --print` runs from its own scratch dir rather than the
		 * `cwd` SWARM spawns it with, so "your current working directory" would be a
		 * lie there. Claude/Codex do inherit `cwd`, so it stays unset for them and
		 * their prompt is unchanged.
		 */
		worktreePath?: string;
		/**
		 * The validated checkpoint a Tier 2 continuation adopted this worktree on
		 * (`recoveryMode: 'checkpoint'`). Set only then: it seeds this fresh session
		 * with the stopped run's remainder so it completes that instead of the whole
		 * work item. Unset on every ordinary run, leaving the prompt unchanged.
		 */
		checkpoint?: Checkpoint;
	},
	customPrompt?: string,
): string {
	const { repo, branch, baseBranch, worktreePath, checkpoint } = context;
	// When the worktree path is named, the agent must not trust its own working
	// directory: point every edit, command, and hand-off file at that absolute
	// path, so SWARM's delivery validation finds the hand-off where it looks.
	const worktreeLocation = worktreePath
		? [
				`You are on branch "${branch}", a fresh branch cut from "${baseBranch}" in a git`,
				`worktree at the absolute path ${worktreePath}. The repository is ${repo} on GitHub.`,
				`Your process's working directory may be a different, unrelated directory — do not`,
				`rely on it. Make every repository edit, run every command, and write every hand-off`,
				`file (including "${OPENED_PR_FILENAME}", "${BLOCKED_REASON_FILENAME}", and`,
				`"${CHECKPOINT_FILENAME}") inside`,
				`${worktreePath}. SWARM only reads files from there.`,
			]
		: [
				`You are on branch "${branch}", a fresh branch cut from "${baseBranch}" in a git`,
				'worktree whose root is your current working directory. The repository is',
				`${repo} on GitHub.`,
			];
	return [
		'You are a senior software engineer implementing a work item end to end.',
		'',
		...pipelinePhaseGuard(),
		...GH_IDENTITY_GUARD,
		'',
		...worktreeLocation,
		'',
		'Do all of the following, in order:',
		`1. Read the linked issue and plan with \`gh issue view ${context.taskId} --repo ${repo} --comments\`, then explore the repository and implement it.`,
		"3. Definition of enough: meet the work item's agreed acceptance criteria with the smallest durable change. Do not add speculative features, broad refactors, or exhaustive test coverage merely because adjacent code is untested. Add or update focused tests for changed stable behavior, regressions, public/critical paths, and bug fixes; leave volatile or explicitly out-of-scope coverage alone unless the issue/plan requires it.",
		'4. Run the project lint, type-check, and the relevant tests; fix whatever they surface before continuing.',
		'5. Do not commit, push, open a pull request, or run any GitHub mutation. SWARM delivers the prepared tree after you exit.',
		`Specifically, do not run \`git push -u origin ${branch}\` or \`gh pr create --base ${baseBranch} --head ${branch}\`; SWARM constructs the PR with \`Closes #${context.taskId}\`. GH_TOKEN is read-only context authentication; do not run gh auth switch.`,
		`6. Write "${OPENED_PR_FILENAME}" as JSON with: summary (PR-ready text), verification (an array of {command,outcome:"passed"}), commitSubject (a conventional-commit subject), limitations (an array), and readyForDelivery:true. Do not track this file.`,
		'Do NOT `git add`/commit the hand-off file.',
		`If a genuine external prerequisite blocks implementation (for example, a required PR has not merged), do not open a placeholder PR. Instead, write a concise, human-readable explanation and the actionable next step to "${BLOCKED_REASON_FILENAME}" at the worktree root, then stop. Do NOT commit that file.`,
		'',
		'After step 7, STOP immediately and exit. Do not wait for a review, review the PR,',
		'respond to a review, post any additional PR comment, or invoke another agent.',
		'SWARM runs Review and Respond-to-review as separate phases after you exit.',
		'',
		...checkpointInstructions('implementation'),
		'',
		...(checkpoint ? [...checkpointContinuationSection(checkpoint), ''] : []),
		'Do not merge the PR. Keep the change scoped to the work item.',
		...projectInstructionsSection(customPrompt),
		'',
		'--- WORK ITEM ---',
		`Title: ${workItem.title}`,
		`URL: ${workItem.url}`,
		'',
		'Description:',
		workItem.description || '(no description provided)',
	].join('\n');
}
