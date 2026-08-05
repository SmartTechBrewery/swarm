/**
 * The shared instruction block that makes an implementer phase's agent keep a
 * Tier 2 checkpoint current (`docs/CHECKPOINTS.md`; the file's schema and reader
 * are `src/pipeline/checkpoint.ts`).
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
 * Every returned element is a self-contained paragraph with no internal
 * newlines, so a call site can spread it into a `'\n'`-joined line array
 * (implementation, respond-to-review, respond-to-ci) or a `'\n\n'`-joined
 * paragraph array (resolve-conflicts) unchanged.
 */

import { CHECKPOINT_FILENAME } from '@/pipeline/checkpoint.js';
import type { TriggerPhase } from '@/triggers/types.js';

/**
 * The checkpoint paragraphs for `phase`, which is named verbatim so the file the
 * agent writes carries the phase that wrote it (the field a continuation checks
 * before adopting a checkpoint left in a reused checkout).
 */
export function checkpointInstructions(phase: TriggerPhase): readonly string[] {
	return [
		`Throughout the work above, keep a rolling progress checkpoint in "${CHECKPOINT_FILENAME}" at the worktree root. Rewrite the whole file (never append) after each completed step and before starting any long operation, so it always describes where you actually are.`,
		`Write it as JSON with: phase (exactly "${phase}"), completed (an array of the steps already done), remaining (an array of what is still left, in order), decisions (an array of choices or caveats worth not re-deriving; may be empty), and workingTree ({"modified":[…],"added":[…],"deleted":[…]} — the repository paths you have changed so far, naming at least one path).`,
		'It exists so that if this run is stopped involuntarily — a usage limit, a wall-clock timeout, an interruption — SWARM can continue from the recorded remainder instead of re-doing your work. Update it only at a safe boundary: never mid-edit and never mid-command.',
		`Keep it short and factual. It is not a design document, and it is not this phase's hand-off — the hand-off file named above is still what reports the outcome. Do NOT \`git add\` or commit "${CHECKPOINT_FILENAME}".`,
	];
}
