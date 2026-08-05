/**
 * The Tier 2 checkpoint hand-off (`docs/CHECKPOINTS.md`) — the *artifact*, not
 * yet its continuation path.
 *
 * Tier 1 (native CLI session resume, `src/pipeline/resume.ts`) covers the common
 * involuntary stop by re-entering the agent's own session. It cannot cover every
 * one: the session can expire or be pruned, the worktree can survive when the
 * session does not, and a continuation may have to run on a different CLI. For
 * those, an implementer phase's agent keeps a short, factual checkpoint current
 * in its worktree describing what it finished, what is left, and what the
 * working tree looks like — enough to re-seed a *fresh* session with a hand-off
 * instead of re-doing the work.
 *
 * This module owns the file's shape and how to read it. Nothing reads it in the
 * pipeline yet: the continuation mechanism that validates and consumes it, the
 * `checkpointed` run status, and the operator surface land in the follow-up
 * phases of issue #299. The prompt half — what makes the four implementer
 * phases write it — is `src/pipeline/prompts/checkpoint.ts`.
 *
 * It lives under `src/pipeline/` rather than in `src/scm/delivery.ts` because
 * its semantics are pipeline/resume, not SCM delivery; only the *filename* has
 * to sit in `HANDOFF_FILENAMES`, which is what makes the file a scratch artifact
 * that can never reach a commit (`SCRATCH_PATHSPECS`).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HANDOFF_FILENAMES, readHandoff } from '@/scm/delivery.js';
import { TriggerPhaseSchema } from '@/triggers/types.js';

/** The checkpoint's filename at the worktree root, named in the phase prompts. */
export const CHECKPOINT_FILENAME = HANDOFF_FILENAMES.checkpoint;

/** The working-tree paths the checkpoint claims it left behind, by change kind. */
const CheckpointWorkingTreeSchema = z.object({
	modified: z.array(z.string().min(1)).default([]),
	added: z.array(z.string().min(1)).default([]),
	deleted: z.array(z.string().min(1)).default([]),
});

/**
 * The checkpoint file's validated shape, mirroring `docs/CHECKPOINTS.md`
 * §"Checkpoint contents". Three of its constraints are deliberate:
 *
 * - **`phase` is required.** A task's checkout is reused across phases, so a
 *   stale Implementation checkpoint must not be adopted by a later run in the
 *   same path. The field exists from the start so the continuation gate can
 *   enforce the match without a schema change.
 * - **`workingTree` must name at least one path.** It is the anchor a
 *   continuation compares against `git status --porcelain`; a checkpoint
 *   describing an empty tree describes nothing worth continuing.
 * - **`remaining` is non-empty.** A checkpoint with nothing left is not a
 *   hand-off — the phase either finished (and wrote its real hand-off) or must
 *   not claim a continuation.
 */
export const CheckpointSchema = z
	.object({
		/** The phase that wrote it — a continuation must never adopt another phase's checkpoint. */
		phase: TriggerPhaseSchema,
		/** What is done and must not be re-derived. */
		completed: z.array(z.string().min(1)).min(1),
		/** What a continuation still has to do, in order. */
		remaining: z.array(z.string().min(1)).min(1),
		/** Decisions/caveats worth carrying over rather than re-deciding. */
		decisions: z.array(z.string().min(1)).default([]),
		workingTree: CheckpointWorkingTreeSchema,
	})
	.superRefine((checkpoint, ctx) => {
		const { modified, added, deleted } = checkpoint.workingTree;
		if (modified.length + added.length + deleted.length === 0)
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ['workingTree'],
				message: 'workingTree must name at least one modified, added, or deleted path',
			});
	});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

/** Whether the worktree at `cwd` carries a checkpoint file at all. */
export function hasCheckpoint(cwd: string): boolean {
	return existsSync(join(cwd, CHECKPOINT_FILENAME));
}

/**
 * Read and validate the checkpoint in `cwd`. Built on `readHandoff` so a
 * malformed or schema-violating file fails with the same actionable,
 * filename-naming error every other hand-off produces. Absence is distinct from
 * a failed required hand-off: callers can use {@link hasCheckpoint} to select a
 * fallback continuation path before reading it.
 */
export function readCheckpoint(cwd: string): Checkpoint {
	if (!hasCheckpoint(cwd)) throw new Error(`No checkpoint ${CHECKPOINT_FILENAME} in ${cwd}`);
	return readHandoff(cwd, CHECKPOINT_FILENAME, CheckpointSchema);
}
