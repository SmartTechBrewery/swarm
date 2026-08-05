/**
 * Respond-to-CI-phase prompt construction (issue #135). Holds only the phase's
 * static instruction text; the orchestration stays in
 * `src/pipeline/respond-to-ci.ts`, which re-exports this for its existing
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

/** The hand-off file the CI-fix agent writes with its outcome (the phase's delivery contract). */
const RESPOND_CI_OUTCOME_FILENAME = HANDOFF_FILENAMES.respondToCi;

/**
 * Build the prompt handed to the CI-fix agent. It's told it authored the PR and
 * its CI is failing: sync the branch first, inspect the failing checks (the
 * Actions logs for the pinned head SHA, not a guess), fix the build surgically
 * or report that no code change is warranted, verify locally, and record which
 * outcome applied to the hand-off file so this phase can validate the hand-off.
 *
 * `customPrompt` is the project's optional per-phase instructions (issue #135),
 * appended after the SWARM instructions as a clearly delimited, supplement-only
 * section (empty when unset).
 */
export function buildRespondToCiPrompt(
	context: {
		repo: string;
		prNumber: string;
		prBranch: string;
		headSha: string;
		/** The validated checkpoint a Tier 2 continuation adopted this worktree on; unset on an ordinary run. */
		checkpoint?: Checkpoint;
	},
	customPrompt?: string,
): string {
	const { repo, prNumber, prBranch, headSha, checkpoint } = context;
	return [
		'You are a senior software engineer whose pull request has failing CI checks.',
		'',
		...pipelinePhaseGuard(),
		...GH_IDENTITY_GUARD,
		'',
		`This worktree has branch "${prBranch}" checked out — the head branch of PR`,
		`#${prNumber} in ${repo} on GitHub. Its check suite completed with at least one`,
		`failing check on commit ${headSha}.`,
		'',
		'Do all of the following, in order:',
		`1. Sync the branch with what CI ran: \`git pull --ff-only origin ${prBranch}\`. If this fails for any reason (diverged branch, deleted remote branch, network error), stop and exit non-zero rather than fixing stale code.`,
		`2. Find out what failed: \`gh pr checks ${prNumber} --repo ${repo}\` for the check summary, then read the failing run's logs — \`gh run view <run-id> --repo ${repo} --log-failed\` (list runs for the commit with \`gh run list --repo ${repo} --commit ${headSha}\`). Read the PR discussion for context too: \`gh pr view ${prNumber} --repo ${repo} --comments\`.`,
		'3. Diagnose the failure and fix it. Keep the fix surgical — change only what the failing checks require; do not refactor unrelated code. If the failure is not something a code change should address (a flaky test, transient infra, or a check unrelated to this PR), make NO code change.',
		'4. If you changed code, run lint, type-check, and relevant tests. Do not commit, push, comment, or perform any GitHub mutation.',
		`Do not run \`git push origin ${prBranch}\` or \`gh pr comment ${prNumber} --repo ${repo}\`; GH_TOKEN is read-only context authentication and you must not run gh auth switch. Do NOT \`git add\`/commit the hand-off.`,
		`5. Write "${RESPOND_CI_OUTCOME_FILENAME}" as JSON containing outcome (fixed or no-fix), body (the PR explanation), optional commitSubject when fixed, and verification [{command,outcome:"passed"}].`,
		'The outcome strings are exactly `fixed` and `no-fix`.',
		'',
		...checkpointInstructions('respond-to-ci'),
		'',
		...(checkpoint ? [...checkpointContinuationSection(checkpoint), ''] : []),
		'Do not merge the PR, and do not review it — you are the author.',
		...projectInstructionsSection(customPrompt),
	].join('\n');
}
