/**
 * Server-side prompt + target-branch composition for control-plane dispatch
 * (issue #407, ADR-003 §2 — the phase's main new work). To push a
 * `TaskAssignment` the control plane must produce the phase's `systemPrompt` and
 * `targetBranch` **without a worktree**, so a future DB-less remote worker can
 * execute the frame verbatim. It reuses the existing *pure* prompt builders
 * (`src/pipeline/prompts/*`), resolving their inputs from the resolved project
 * config + trigger — every builder is already a pure function of `repo`, the
 * task/PR identifiers, the branch names, and the optional per-phase custom
 * prompt, none of which need a checkout.
 *
 * The same-host MVP worker still recomposes these locally inside each phase (it
 * has `DATABASE_URL` and provisions its own worktree — `src/worker/transport-
 * client.ts`), so today the frame's `systemPrompt`/`targetBranch` are the wire
 * contract for the future remote path rather than what the worker executes; both
 * paths derive them from the same inputs, so they agree. One builder input a
 * checkout would supply — the review re-review flag — is resolved conservatively
 * here (see {@link composeSystemPrompt}); the same-host worker computes the exact
 * value, so behavior is unchanged.
 */

import type { ProjectConfig } from '../config/schema.js';
import { buildImplementationPrompt } from '../pipeline/prompts/implementation.js';
import { buildPlanningPrompt } from '../pipeline/prompts/planning.js';
import { buildResolveConflictsPrompt } from '../pipeline/prompts/resolve-conflicts.js';
import { buildRespondToCiPrompt } from '../pipeline/prompts/respond-to-ci.js';
import { buildRespondToReviewPrompt } from '../pipeline/prompts/respond-to-review.js';
import { buildReviewPrompt } from '../pipeline/prompts/review.js';
import type { TriggerResult } from '../triggers/types.js';

/** The task branch a phase provisions/opens its PR from — `<branchPrefix><taskId>`. */
function taskBranch(project: ProjectConfig, taskId: string): string {
	return `${project.branchPrefix}${taskId}`;
}

/**
 * Resolve the target branch the assignment carries, from config + trigger alone
 * (no checkout). The board phases and Review pin to the task branch
 * (`<branchPrefix><taskId>` — the branch Implementation opens the PR from and
 * Review's detached checkout sits on); the SCM continuation phases carry the PR
 * head branch the trigger already resolved.
 */
export function resolveTargetBranch(project: ProjectConfig, trigger: TriggerResult): string {
	switch (trigger.phase) {
		case 'planning':
		case 'implementation':
		case 'review':
			return taskBranch(project, trigger.taskId);
		case 'respond-to-review':
		case 'respond-to-ci':
		case 'resolve-conflicts':
			return trigger.prBranch;
	}
}

/**
 * Compose the phase's system prompt server-side by reusing the pure builder for
 * its phase. `customPrompt` is the project's optional per-phase supplement
 * (`agents.<phase>.prompt`), resolved by the caller exactly as the in-process
 * path does.
 *
 * Review's `isReReview` flag depends on whether the PR already had a
 * `request-changes` review — data the phase gathers from the SCM provider after
 * checkout. It is left at its default (`false`) here: the same-host worker
 * recomposes the exact prompt, and the composed value is a faithful-enough wire
 * carrier for the (not-yet-built) DB-less remote path. Resolving it server-side
 * via an SCM call is a targeted follow-up if a remote worker ever consumes the
 * pushed prompt verbatim.
 */
export function composeSystemPrompt(
	project: ProjectConfig,
	trigger: TriggerResult,
	customPrompt?: string,
): string {
	switch (trigger.phase) {
		case 'planning':
			return buildPlanningPrompt(
				trigger.workItem,
				project.pipeline?.planning?.autoSplit ?? false,
				customPrompt,
				project.pipeline?.planning?.maxConcerns,
			);
		case 'implementation':
			return buildImplementationPrompt(
				trigger.workItem,
				{
					repo: project.repo,
					taskId: trigger.taskId,
					branch: taskBranch(project, trigger.taskId),
					baseBranch: project.baseBranch,
				},
				customPrompt,
			);
		case 'review':
			return buildReviewPrompt(
				{ repo: project.repo, prNumber: trigger.prNumber, headSha: trigger.headSha },
				customPrompt,
			);
		case 'respond-to-review':
			return buildRespondToReviewPrompt(
				{
					repo: project.repo,
					prNumber: trigger.prNumber,
					prBranch: trigger.prBranch,
					reviewId: trigger.reviewId,
				},
				customPrompt,
			);
		case 'respond-to-ci':
			return buildRespondToCiPrompt(
				{
					repo: project.repo,
					prNumber: trigger.prNumber,
					prBranch: trigger.prBranch,
					headSha: trigger.headSha,
				},
				customPrompt,
			);
		case 'resolve-conflicts':
			return buildResolveConflictsPrompt(
				{
					project,
					prNumber: trigger.prNumber,
					prBranch: trigger.prBranch,
					headSha: trigger.headSha,
					baseBranch: trigger.baseBranch,
					baseSha: trigger.baseSha,
				},
				customPrompt,
			);
	}
}
