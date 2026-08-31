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
import type { Checkpoint } from '@/pipeline/checkpoint.js';
import {
	checkpointContinuationSection,
	checkpointInstructions,
} from '@/pipeline/prompts/checkpoint.js';
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
	/** The validated checkpoint a Tier 2 continuation adopted this worktree on; unset on an ordinary run. */
	checkpoint?: Checkpoint;
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
		...MIGRATION_CONFLICT_GUIDANCE,
		...INDEX_RESOLUTION_GUIDANCE,
		'Run the relevant lint, type-check, and tests. Do not commit, push, comment, or perform any GitHub mutation; leave the fully resolved merge staged in the working tree for SWARM.',
		`Write ${RESOLVE_CONFLICTS_OUTCOME_FILENAME} as JSON with status:"resolved", body (the concise result comment), and verification [{command,outcome:"passed"}].`,
		...checkpointInstructions('resolve-conflicts'),
		...(input.checkpoint ? checkpointContinuationSection(input.checkpoint) : []),
		...projectInstructionsParagraph(customPrompt),
	].join('\n\n');
}

/**
 * Standing guidance for the one conflict shape a generic "preserve both
 * sides' intent" merge reliably gets wrong: `src/db/migrations/`. Drizzle's
 * numbered `.sql` files and `meta/_journal.json` are generated artifacts with
 * invariants a normal 3-way text merge does not know to preserve — every
 * journal entry must name a file that exists, and `when` must strictly
 * increase across entries, or a database already migrated past that point
 * silently skips the entry instead of erroring (confirmed live, issue #503/#508:
 * three merges into one long-lived branch left the journal naming a `.sql`
 * file that was never committed, and gave the branch's own migration a `when`
 * earlier than the one main had already moved ahead to). SWARM still runs
 * `validateMigrationJournal` (`src/db/migration-journal.ts`) as a
 * deterministic backstop after this — this paragraph is to get it right on
 * the first pass instead of spending that one repair chance.
 */
const MIGRATION_CONFLICT_GUIDANCE = [
	"If the merge conflicts inside `src/db/migrations/` (a numbered `.sql` file, or `src/db/migrations/meta/_journal.json`/its snapshot files), do not hand-resolve the conflict markers in those generated files. Instead: finish resolving every *other* conflict first and commit nothing yet; keep `main`'s migrations exactly as `main` has them (do not renumber or edit any migration `main` already has); then run `npx drizzle-kit generate` from the repo root, which reads the merged `src/db/schema/*.ts` and this branch's already-merged schema changes to generate one fresh, correctly-numbered migration (and its matching journal entry and snapshot) for whatever this branch's schema changes still need beyond what `main` already has. If this branch's own migration file(s) are now superseded by the freshly generated one, remove them (and their now-orphaned snapshot/journal entry) rather than keeping both. Verify afterward that `src/db/migrations/meta/_journal.json` has exactly one entry per `.sql` file in that folder and that every entry's `when` is strictly greater than the previous one's.",
];

/**
 * Standing guidance for the gap between the two definitions of "resolved"
 * (issue #844). The agent verifies its merge by scanning the files for conflict
 * markers; SWARM's delivery gate asks the *index*
 * (`validatePreparedTree`, `src/scm/delivery.ts`). On PR #98 both files were
 * resolved correctly and neither was staged, so delivery refused a tree that
 * was, by content, perfectly deliverable. `settleMergeResolution`
 * (`src/pipeline/merge-resolution.ts`) is the deterministic backstop that now
 * guarantees this; this paragraph is the first-pass hint, so a genuinely
 * ambiguous conflict is the only thing that ever reaches the refusal.
 */
const INDEX_RESOLUTION_GUIDANCE = [
	'Git considers a conflict resolved when the path leaves the unmerged index, not when its conflict markers are gone: mark every path you resolved with `git add -- <path>` (`git rm -- <path>` when the resolution is to delete it). Staging is not committing — SWARM still makes the commit and the push, so the "do not commit, push, or comment" floor is unchanged.',
	'Verify with `git diff --name-only --diff-filter=U`, which must print nothing. That is the exact command SWARM’s delivery gate runs, and it will refuse the whole merge on anything it still lists; grepping the files for `<<<<<<<` markers answers a different question and is not enough.',
];

/**
 * Build the one repair pass `runResolveConflictsPhase`
 * (`src/pipeline/resolve-conflicts.ts`) runs when its post-merge
 * `validateMigrationJournal` gate finds the merge it just produced leaves the
 * migration journal inconsistent — the deterministic backstop for the
 * guidance above, for whichever CLI/model ignored or mishandled it. Mirrors
 * `buildReviewHandoffRepairPrompt`'s shape (`src/pipeline/prompts/review.ts`):
 * one paragraph naming the validator's own complaint, one naming the fix, and
 * the same repository-mutation floor as the original prompt.
 */
export function buildMigrationJournalRepairPrompt(issues: readonly string[]): string {
	return [
		"The merge you just produced is NOT resolved: `src/db/migrations/` failed SWARM's deterministic post-merge check.",
		'',
		'The validator reported:',
		issues.map((issue) => `- ${issue}`).join('\n'),
		'',
		"Fix only `src/db/migrations/` (the numbered `.sql` files and `meta/_journal.json`/its snapshot files) so every reported problem is gone. Do not touch any other file — every other conflict is already correctly resolved. Prefer `npx drizzle-kit generate` over hand-editing the journal or a snapshot: keep `main`'s existing migrations exactly as `main` has them, and let `drizzle-kit generate` produce one fresh, correctly-numbered migration (with its own journal entry and snapshot) for whatever schema change this branch still needs beyond `main`. Remove this branch's now-superseded migration file(s) and their orphaned journal entries if `drizzle-kit generate` replaces them.",
		'',
		'Still do not commit, push, comment, or perform any GitHub mutation — leave the corrected tree in the working directory for SWARM, and rewrite the hand-off file only if the fix changes its `body` or `verification`.',
	].join('\n');
}
