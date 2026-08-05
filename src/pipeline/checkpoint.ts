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
 * This module owns the file's shape, how to read it, and whether it may be
 * *continued from* ({@link validateCheckpointForContinuation}, consumed by the
 * `'checkpoint'` branch of the recovery gate in `src/pipeline/resume.ts`).
 * Nothing in production selects a checkpoint continuation yet: the policy that
 * does, the `checkpointed` run status, and the operator surface land in the
 * follow-up phases of issue #299. The prompt half — what makes the four
 * implementer phases write it, and what re-seeds a continuation with its
 * contents — is `src/pipeline/prompts/checkpoint.ts`.
 *
 * It lives under `src/pipeline/` rather than in `src/scm/delivery.ts` because
 * its semantics are pipeline/resume, not SCM delivery; only the *filename* has
 * to sit in `HANDOFF_FILENAMES`, which is what makes the file a scratch artifact
 * that can never reach a commit (`SCRATCH_PATHSPECS`).
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { gitEnvironmentForCwd, HANDOFF_FILENAMES, readHandoff } from '@/scm/delivery.js';
import { type TriggerPhase, TriggerPhaseSchema } from '@/triggers/types.js';
import type { BlockedRecoveryReason } from '@/worktree/reclaim.js';

const execFileAsync = promisify(execFile);

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

/**
 * The two {@link BlockedRecoveryReason}s a failed continuation check can produce.
 * Typed off that union so the reason the gate throws with is the same vocabulary
 * the dashboard renders.
 */
type CheckpointBlockedReason = Extract<
	BlockedRecoveryReason,
	'missing-validation' | 'checkpoint-divergent'
>;

/** Whether a preserved checkout may be continued from its checkpoint, and if not, why. */
export type CheckpointValidation =
	| { valid: true; checkpoint: Checkpoint }
	| { valid: false; reason: CheckpointBlockedReason; detail: string };

/** `git`, scoped to `cwd` alone — see {@link gitEnvironmentForCwd}. Output is returned raw (NUL-delimited reads must not be trimmed). */
async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnvironmentForCwd() });
	return stdout;
}

/**
 * Every repository path `git status` reports as changed in `cwd`.
 *
 * Read with `-z` so a path needing quoting (a space, a non-ASCII byte) is still
 * compared byte-for-byte against what the checkpoint recorded, and with
 * `--untracked-files=all` because the default `normal` mode collapses a new
 * untracked directory into `dir/` — which would make every file the agent added
 * inside it look absent. A rename/copy entry contributes **both** its new and its
 * original path, since a checkpoint records that move as an add plus a delete.
 */
async function changedPaths(cwd: string): Promise<Set<string>> {
	const raw = await git(cwd, ['status', '--porcelain', '-z', '--untracked-files=all']);
	// `XY <path>` per entry; a rename/copy's original path is the next field.
	const fields = raw.split('\0').filter((field) => field.length > 0);
	const paths = new Set<string>();
	for (let i = 0; i < fields.length; i++) {
		const entry = fields[i] as string;
		const status = entry.slice(0, 2);
		const path = entry.slice(3);
		if (path) paths.add(normalizePath(path));
		if (status.includes('R') || status.includes('C')) {
			const original = fields[++i];
			if (original) paths.add(normalizePath(original));
		}
	}
	return paths;
}

/** Repository-relative, as `git status` reports it — an agent may still write `./src/x.ts`. */
function normalizePath(path: string): string {
	return path.startsWith('./') ? path.slice(2) : path;
}

/**
 * Decide whether the preserved checkout at `cwd` may be continued from its
 * checkpoint by `phase`. Three things must hold, in this order:
 *
 * 1. The checkpoint exists (`missing-validation` — there is nothing to continue
 *    from) and parses against {@link CheckpointSchema}.
 * 2. It names `phase`. A task's checkout is reused across phases, so a stale
 *    Implementation checkpoint must never be adopted by a later Respond-to-CI run
 *    in the same path.
 * 3. Every path it records is still reported changed by `git status --porcelain`.
 *
 * **The divergence rule for (3) is deliberately one-sided.** A recorded path that
 * is *absent* from `git status` is divergence, and so is a clean tree (the schema
 * guarantees a checkpoint records at least one path, so a clean tree contradicts
 * it outright). Extra *unrecorded* paths are **not** divergence on their own: the
 * scratch and hand-off files are untracked, and an agent enumerating its own edits
 * does not do so perfectly. That fails in the safe direction — a continuation
 * never runs against a tree the checkpoint does not describe — without blocking on
 * an honest under-report. Failures (2) and (3) both report
 * `checkpoint-divergent`, whose message names the specific mismatch.
 */
export async function validateCheckpointForContinuation(
	cwd: string,
	phase: TriggerPhase,
): Promise<CheckpointValidation> {
	if (!hasCheckpoint(cwd))
		return {
			valid: false,
			reason: 'missing-validation',
			detail: `no ${CHECKPOINT_FILENAME} in ${cwd}`,
		};

	let checkpoint: Checkpoint;
	try {
		checkpoint = readCheckpoint(cwd);
	} catch (error) {
		return {
			valid: false,
			reason: 'checkpoint-divergent',
			detail: error instanceof Error ? error.message : String(error),
		};
	}

	if (checkpoint.phase !== phase)
		return {
			valid: false,
			reason: 'checkpoint-divergent',
			detail: `${CHECKPOINT_FILENAME} was written by the '${checkpoint.phase}' phase, not '${phase}'`,
		};

	const { modified, added, deleted } = checkpoint.workingTree;
	const recorded = [...modified, ...added, ...deleted].map(normalizePath);
	let present: Set<string>;
	try {
		present = await changedPaths(cwd);
	} catch (error) {
		// Fail closed: an unreadable status is not evidence the tree matches.
		return {
			valid: false,
			reason: 'checkpoint-divergent',
			detail: `could not read the working tree in ${cwd}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}

	if (present.size === 0)
		return {
			valid: false,
			reason: 'checkpoint-divergent',
			detail: `the working tree in ${cwd} is clean, but ${CHECKPOINT_FILENAME} records ${recorded.length} changed path(s)`,
		};

	const missing = recorded.filter((path) => !present.has(path));
	if (missing.length > 0)
		return {
			valid: false,
			reason: 'checkpoint-divergent',
			detail: `${CHECKPOINT_FILENAME} records path(s) the working tree no longer changes: ${missing.join(', ')}`,
		};

	return { valid: true, checkpoint };
}
