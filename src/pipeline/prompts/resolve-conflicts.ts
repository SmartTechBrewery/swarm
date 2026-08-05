/**
 * Resolve-conflicts-phase prompt construction (issue #135). Holds only the
 * phase's static instruction text; the orchestration stays in
 * `src/pipeline/resolve-conflicts.ts`, which re-exports this for its existing
 * callers. Unlike the other phases this prompt has no `GH_IDENTITY_GUARD` (the
 * agent performs no GitHub mutation — SWARM delivers the resolved merge) and
 * joins its lines with a blank line between them.
 */

import type { ProjectConfig } from '@/config/schema.js';
import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';
import { checkpointInstructions } from '@/pipeline/prompts/checkpoint.js';
import { projectInstructionsParagraph } from '@/pipeline/prompts/custom-prompt.js';
import { HANDOFF_FILENAMES } from '@/scm/delivery.js';

/** The hand-off file the agent writes with its outcome (the phase's delivery contract). */
const RESOLVE_CONFLICTS_OUTCOME_FILENAME = HANDOFF_FILENAMES.resolveConflicts;

/** The runtime context the resolve-conflicts prompt is built from. */
export interface ResolveConflictsPromptInput {
	project: Pick<ProjectConfig, 'repo'>;
	prNumber: string;
	prBranch: string;
	headSha: string;
	baseBranch: string;
	baseSha: string;
}

/**
 * Build the prompt handed to the resolve-conflicts agent. It merges the base
 * branch into the conflicted PR branch, resolves every conflict preserving both
 * sides' intent, verifies, and hands the resolved tree back for SWARM to deliver.
 *
 * `customPrompt` is the project's optional per-phase instructions (issue #135),
 * appended after the SWARM instructions as a clearly delimited, supplement-only
 * section (empty when unset).
 */
export function buildResolveConflictsPrompt(
	input: ResolveConflictsPromptInput,
	customPrompt?: string,
): string {
	return [
		'You are the implementer assigned only to SWARM’s Resolve Conflicts phase.',
		...pipelinePhaseGuard(),
		`PR #${input.prNumber} in ${input.project.repo} has confirmed merge conflicts.`,
		`Its branch is "${input.prBranch}" and the observed head was ${input.headSha}. The current base is "${input.baseBranch}" at ${input.baseSha}.`,
		'Fetch origin. Before changing anything, verify origin/' +
			input.prBranch +
			' is still exactly ' +
			input.headSha +
			'; if not, stop and fail without pushing.',
		`Merge origin/${input.baseBranch} into the checked-out PR branch with a normal merge (never rebase and never force-push). Resolve every conflict while preserving both changes' intent.`,
		'Run the relevant lint, type-check, and tests. Do not commit, push, comment, or perform any GitHub mutation; leave the fully resolved merge in the working tree for SWARM.',
		`Write ${RESOLVE_CONFLICTS_OUTCOME_FILENAME} as JSON with status:"resolved", body (the concise result comment), and verification [{command,outcome:"passed"}].`,
		...checkpointInstructions('resolve-conflicts'),
		...projectInstructionsParagraph(customPrompt),
	].join('\n\n');
}
