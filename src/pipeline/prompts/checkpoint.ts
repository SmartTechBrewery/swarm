/**
 * The two shared Tier 2 checkpoint prompt blocks (`docs/CHECKPOINTS.md`; the
 * file's schema, reader, and continuation validation are
 * `src/pipeline/checkpoint.ts`): {@link checkpointInstructions}, which makes an
 * implementer phase's agent keep a checkpoint current, and
 * {@link checkpointContinuationSection}, which hands a validated one back to the
 * fresh session that continues from it.
 *
 * Spliced into the four phases that edit a worktree — implementation,
 * respond-to-review, respond-to-ci, resolve-conflicts. Planning and Review are
 * deliberately left out: Planning has no partial-edit state to hand over, and
 * Review makes no worktree edits.
 *
 * The instruction is a *rolling* one on purpose. Having the agent judge its own
 * remaining budget and decide to wind down is the speculative self-checkpoint
 * trigger (`docs/CHECKPOINTS.md` §"Soft budget, completion reserve,
 * self-checkpoint trigger") — deliberately not built. An involuntary stop
 * arrives without warning, so the file has to be current *before* it does; don't
 * "improve" this into a wind-down decision the agent has to make.
 *
 * {@link checkpointInstructions} also carries the *worktree-state* directive
 * (issue #705): don't leave the worktree's changes stashed. It lives here rather
 * than beside `GH_IDENTITY_GUARD` (`src/pipeline/agent-auth.ts`) because its
 * reason *is* the checkpoint — a stash that outlives the run turns the next
 * continuation into a `checkpoint-divergent` block — and because this block is
 * spliced by exactly the four phases that write a checkpoint, including
 * `resolve-conflicts`, which deliberately carries no identity guard.
 *
 * Every returned element is a self-contained paragraph with no internal
 * newlines, so a call site can spread it into a `'\n'`-joined line array
 * (implementation, respond-to-review, respond-to-ci) or a `'\n\n'`-joined
 * paragraph array (resolve-conflicts) unchanged.
 */

import { CHECKPOINT_FILENAME, type Checkpoint } from '@/pipeline/checkpoint.js';
import type { TriggerPhase } from '@/triggers/types.js';

/**
 * The checkpoint paragraphs for `phase`, which is named verbatim so the file the
 * agent writes carries the phase that wrote it (the field a continuation checks
 * before adopting a checkpoint left in a reused checkout).
 */
export function checkpointInstructions(phase: TriggerPhase): readonly string[] {
	return [
		`Throughout the work above, keep a rolling progress checkpoint in "${CHECKPOINT_FILENAME}" at the worktree root. After each completed step — and, once at least one repository path has changed, before starting any long operation — rewrite the whole file (never append) so it always describes where you actually are. Do not create one before a completed step.`,
		`Write it as JSON with: phase (exactly "${phase}"), completed (a non-empty array of the steps already done), remaining (a non-empty array of what is still left, in order), decisions (an array of choices or caveats worth not re-deriving; may be empty), and workingTree ({"modified":[…],"added":[…],"deleted":[…]} — the repository paths you have changed so far, naming at least one path).`,
		'It exists so that if this run is stopped involuntarily — a usage limit, a wall-clock timeout, an interruption — SWARM can continue from the recorded remainder instead of re-doing your work. Update it only at a safe boundary: never mid-edit and never mid-command.',
		"Because that stop arrives without warning and the continuation is a fresh session in this same worktree, never leave this worktree's changes stashed. Do not `git stash` your work aside — not even briefly, and not to check whether a failure predates your change — unless you restore it before the same step ends. A continuation that finds a clean tree while the checkpoint records changed paths is refused outright, and your work then sits in a stash nobody is looking for.",
		'To check whether something also fails without your changes, compare against a separate checkout (or the base branch in a scratch clone) rather than mutating this worktree.',
		`Keep it short and factual. It is not a design document, and it is not this phase's hand-off — the hand-off file named above is still what reports the outcome. Do NOT \`git add\` or commit "${CHECKPOINT_FILENAME}".`,
	];
}

/** Render a checkpoint's array as one newline-free, ordered sentence fragment. */
function inlineList(items: readonly string[]): string {
	return items.map((item, index) => `(${index + 1}) ${item}`).join(' ');
}

/** `git status`-style summary of what the stopped run left behind, or `none` per empty kind. */
function workingTreeSummary(workingTree: Checkpoint['workingTree']): string {
	const describe = (paths: readonly string[]): string => (paths.length ? paths.join(', ') : 'none');
	return [
		`modified: ${describe(workingTree.modified)}`,
		`added: ${describe(workingTree.added)}`,
		`deleted: ${describe(workingTree.deleted)}`,
	].join('; ');
}

/**
 * The hand-off block for a Tier 2 continuation: the checkpoint an involuntarily
 * stopped run of *this* phase left in *this* worktree, plus the instruction that
 * gives it force — finish only the recorded remainder.
 *
 * Only reached once `validateCheckpointForContinuation`
 * (`src/pipeline/checkpoint.ts`) has confirmed the checkpoint names this phase and
 * matches the tree on disk, so the prompt can state the completed work and the
 * working tree as fact rather than hedging. The continuation runs on a **fresh**
 * session — possibly a different CLI — so this text is the only context it has;
 * everything the remainder depends on has to be in it.
 *
 * Every returned element is a self-contained paragraph with no internal newlines,
 * matching {@link checkpointInstructions}, so both the `'\n'`-joined prompts and
 * the `'\n\n'`-joined one can splice it unchanged.
 */
export function checkpointContinuationSection(checkpoint: Checkpoint): readonly string[] {
	return [
		'--- CONTINUING FROM A CHECKPOINT ---',
		`An earlier run of this same phase was stopped involuntarily before it finished — a usage limit, a timeout, or an interruption. Its worktree is the one you are working in now, and the changes it had already made are still there. It left the progress checkpoint below in "${CHECKPOINT_FILENAME}". You are a new session with none of that run's context, so treat the checkpoint as the authoritative account of where the work stands.`,
		`Already completed — do not redo, re-explore, or redesign this: ${inlineList(checkpoint.completed)}`,
		`Remaining, in this order — this is your work: ${inlineList(checkpoint.remaining)}`,
		...(checkpoint.decisions.length > 0
			? [
					`Decisions and caveats already settled — carry them rather than re-deciding: ${inlineList(checkpoint.decisions)}`,
				]
			: []),
		`Changes already in this worktree, as the checkpoint recorded them — ${workingTreeSummary(checkpoint.workingTree)}. Read those files before changing them; they are the earlier run's work, not yours to start over.`,
		"Complete only the remainder. Do not re-explore settled work unless verification requires it — for example a listed step fails, or a completed change is provably wrong or missing. Then finish the phase normally: run the verification the steps above call for, and write this phase's hand-off file exactly as instructed. Keep the checkpoint current as you go, so a further stop can continue from where you get to.",
	];
}
