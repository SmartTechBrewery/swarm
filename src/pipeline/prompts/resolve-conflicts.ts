/**
 * Resolve-conflicts-phase prompt construction (issue #135). Holds only the
 * phase's static instruction text; the orchestration stays in
 * `src/pipeline/resolve-conflicts.ts`, which re-exports this for its existing
 * callers. Unlike the other phases this prompt has no `GH_IDENTITY_GUARD` (the
 * agent performs no GitHub mutation — SWARM delivers the resolved merge) and
 * joins its lines with a blank line between them. That omission holds for the
 * migration-journal repair pass below too — `guardMigrationJournal` passes it no
 * `env`/token either — but since issue #865 that pass can run in a *fresh*
 * session, so it carries `pipelinePhaseGuard()` of its own rather than relying on
 * the phase prompt having said it earlier in the same session.
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
		...migrationConflictGuidance(input.baseBranch),
		...INDEX_RESOLUTION_GUIDANCE,
		DELIVERY_FLOOR,
		HANDOFF_CONTRACT,
		...VERIFICATION_OUTCOME_GUIDANCE,
		...checkpointInstructions('resolve-conflicts'),
		...(input.checkpoint ? checkpointContinuationSection(input.checkpoint) : []),
		...projectInstructionsParagraph(customPrompt),
	].join('\n\n');
}

/** The runtime context {@link buildBaseAdvancedRemergePrompt} is built from. */
export interface BaseAdvancedRemergeInput {
	prNumber: string;
	prBranch: string;
	baseBranch: string;
	/** Where `origin/<baseBranch>` has got to since the merge below was built. */
	baseSha: string;
	/** The merge SWARM already committed locally on the branch, and has not pushed. */
	deliveredSha: string;
}

/**
 * Build the prompt for a re-merge pass (issue #1001): the resolution this run
 * produced is already stale, because the base branch advanced while it was being
 * produced, so the merge has to take in what the base gained before it may be
 * pushed.
 *
 * Written for a session that has *just* done the first merge, but carries the
 * phase guard itself for the same reason
 * {@link buildMigrationJournalRepairPrompt} does: the pass resumes the merge's
 * own session where one is addressable and runs fresh where it is not
 * (`repairSessionId`, `src/pipeline/resume.ts`).
 *
 * The paragraph about the local commit is load-bearing. SWARM commits each pass's
 * merge before checking the base, so the branch this pass starts on already holds
 * work that exists nowhere else — an agent that "cleaned up" with a reset or a
 * rebase would throw away the resolution it is being asked to build on.
 */
export function buildBaseAdvancedRemergePrompt(input: BaseAdvancedRemergeInput): string {
	return [
		'You are the implementer assigned only to SWARM’s Resolve Conflicts phase.',
		...pipelinePhaseGuard(),
		`The merge you just produced for PR #${input.prNumber} is already stale: \`origin/${input.baseBranch}\` advanced to ${input.baseSha} while you were resolving, so pushing it would leave the pull request conflicted again.`,
		`SWARM has committed your resolved merge locally on "${input.prBranch}" as ${input.deliveredSha}, and has not pushed it. Keep it: never reset, rebase, amend or force-push it away — it exists nowhere else.`,
		`Fetch origin, then merge \`origin/${input.baseBranch}\` into the checked-out branch again, on top of that commit, with a normal merge (never rebase and never force-push). Resolve every conflict while preserving both changes' intent. Only what "${input.baseBranch}" gained since your last merge is new, so this is normally a much smaller job than the first pass.`,
		...migrationConflictGuidance(input.baseBranch),
		...INDEX_RESOLUTION_GUIDANCE,
		DELIVERY_FLOOR,
		HANDOFF_CONTRACT,
		...VERIFICATION_OUTCOME_GUIDANCE,
	].join('\n\n');
}

/**
 * The repository-mutation floor and the hand-off contract, shared by the merge
 * prompt and the re-merge pass so the two cannot state different contracts for
 * the same file — `ConflictHandoffSchema` validates whatever either one wrote,
 * and `assertMergeVerified` gates both.
 */
const DELIVERY_FLOOR =
	'Run the relevant lint, type-check, and tests. Do not commit, push, comment, or perform any GitHub mutation; leave the fully resolved merge staged in the working tree for SWARM.';

const HANDOFF_CONTRACT = `Write ${RESOLVE_CONFLICTS_OUTCOME_FILENAME} as JSON with status:"resolved", \`body\` (a single string — the concise result comment), and \`verification\`: an array of one \`{command, outcome, detail}\` object per command you actually ran, at least one. \`command\` is a single string, one command line; \`outcome\` is a single string, exactly one of \`passed\`, \`pre-existing-failure\` or \`failed\`; \`detail\` is a single string and is required for anything that is not \`passed\`.`;

/**
 * What the three verification outcomes mean, stated where the agent chooses one
 * (issue #924). The schema used to accept only `passed`, so an agent that ran the
 * suite, found failures and *proved* on a pristine unmerged head that they
 * pre-existed could either claim a pass or lose its finished merge to a hand-off
 * validation error — twice in one day it wrote the truth into `outcome` as prose
 * and the whole run was discarded. The explanation now has a slot of its own, and
 * this paragraph is what stops it going back into `outcome`.
 */
const VERIFICATION_OUTCOME_GUIDANCE = [
	'Never put an explanation in `outcome` — it is one of those three words and nothing else; the explanation goes in `detail`. Use `pre-existing-failure` only for a failure you reproduced **without** this merge (re-run the same command on the unmerged branch head in a separate checkout) and say in `detail` how you established that: reporting one honestly does not fail the phase, and it must never be relabelled `passed`. Use `failed` for a failure this merge caused, or one you could not show pre-exists — SWARM then refuses the merge and delivers nothing.',
];

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
 * earlier than the one the base branch had already moved ahead to). SWARM still
 * runs `validateMigrationJournal` (`src/db/migration-journal.ts`) as a
 * deterministic backstop after this — this paragraph is to get it right on
 * the first pass instead of spending that one repair chance.
 */
function migrationConflictGuidance(baseBranch: string): string[] {
	return [
		`If the merge conflicts inside \`src/db/migrations/\` (a numbered \`.sql\` file, or \`src/db/migrations/meta/_journal.json\`/its snapshot files), do not hand-resolve the conflict markers in those generated files. Instead: finish resolving every *other* conflict first and commit nothing yet; keep \`${baseBranch}\`'s migrations exactly as \`${baseBranch}\` has them (do not renumber or edit any migration \`${baseBranch}\` already has); then run \`npx drizzle-kit generate\` from the repo root, which reads the merged \`src/db/schema/*.ts\` and this branch's already-merged schema changes to generate one fresh, correctly-numbered migration (and its matching journal entry and snapshot) for whatever this branch's schema changes still need beyond what \`${baseBranch}\` already has. If this branch's own migration file(s) are now superseded by the freshly generated one, remove them (and their now-orphaned snapshot/journal entry) rather than keeping both. Verify afterward that \`src/db/migrations/meta/_journal.json\` has exactly one entry per \`.sql\` file in that folder and that every entry's \`when\` is strictly greater than the previous one's.`,
	];
}

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
 *
 * Written for **either** session (issue #865): the pass resumes the merge's own
 * session where one is addressable, but on a self-minting CLI that reported no id
 * it runs fresh (`repairSessionId` in `src/pipeline/resume.ts`). So it carries the
 * phase guard itself, and names the hand-off file rather than saying "the hand-off
 * file" to an agent that may never have written one.
 */
export function buildMigrationJournalRepairPrompt(
	issues: readonly string[],
	baseBranch: string,
): string {
	return [
		...pipelinePhaseGuard(),
		'',
		"A merge produced in this worktree is NOT resolved: `src/db/migrations/` failed SWARM's deterministic post-merge check.",
		'',
		'The validator reported:',
		issues.map((issue) => `- ${issue}`).join('\n'),
		'',
		`Fix only \`src/db/migrations/\` (the numbered \`.sql\` files and \`meta/_journal.json\`/its snapshot files) so every reported problem is gone. Do not touch any other file — every other conflict in the merge is already correctly resolved. Prefer \`npx drizzle-kit generate\` over hand-editing the journal or a snapshot: keep \`${baseBranch}\`'s existing migrations exactly as \`${baseBranch}\` has them, and let \`drizzle-kit generate\` produce one fresh, correctly-numbered migration (with its own journal entry and snapshot) for whatever schema change this branch still needs beyond \`${baseBranch}\`. Remove this branch's now-superseded migration file(s) and their orphaned journal entries if \`drizzle-kit generate\` replaces them.`,
		'',
		`Do not commit, push, comment, or perform any GitHub mutation — leave the corrected tree in the working directory for SWARM, and rewrite the hand-off "${RESOLVE_CONFLICTS_OUTCOME_FILENAME}" (already in this worktree) only if the fix changes its \`body\` or \`verification\`.`,
	].join('\n');
}
