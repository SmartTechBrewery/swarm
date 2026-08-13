/**
 * The Tier 2 checkpoint hand-off (`docs/CHECKPOINTS.md`) — the *artifact* half.
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
 * This module owns the file's shape and the two ways it is read, which differ in
 * what a bad file means:
 *
 * - {@link validateCheckpointForContinuation} — may this preserved checkout be
 *   *continued from*? Consumed by the `'checkpoint'` branch of the recovery gate
 *   (`src/pipeline/resume.ts`), where a bad answer must block the run.
 * - {@link tryReadCheckpoint} — is there a hand-off worth *settling* a stopped run
 *   on? Consumed by the deferral path (`src/worker/consumer.ts`) and by a federated
 *   worker reporting its own disk (`src/transport/assignment-execution.ts`), where a
 *   bad file just means "not a Tier 2 case" and must never fail the settle.
 *
 * It also owns the continuation *budget* ({@link resolveMaxContinuations}), the bound
 * that keeps a phase which keeps stopping from handing itself off forever. The prompt
 * half — what makes the four implementer phases write the file, and what re-seeds a
 * continuation with its contents — is `src/pipeline/prompts/checkpoint.ts`.
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
import type { ProjectConfig } from '@/config/schema.js';
import { logger } from '@/lib/logger.js';
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
 * {@link readCheckpoint} for the *settle* path, which must never turn a bad
 * hand-off into a failed settle: an absent or malformed file simply means "there is
 * nothing to continue from", which the caller reads as "this is not a Tier 2 case"
 * and settles as an ordinary deferral/failure instead. A parse failure is logged
 * because it is the agent writing the file wrong, not an expected state.
 */
export function tryReadCheckpoint(cwd: string): Checkpoint | undefined {
	if (!hasCheckpoint(cwd)) return undefined;
	try {
		return readCheckpoint(cwd);
	} catch (error) {
		logger.warn(`Ignoring an unreadable ${CHECKPOINT_FILENAME} — no checkpoint continuation`, {
			cwd,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * How many checkpoint continuations one run gets by default. Two is deliberately
 * small: each continuation pays for a fresh session seeded from a degraded
 * hand-off, so a phase that keeps stopping involuntarily is better surfaced to a
 * human than handed off indefinitely.
 */
export const DEFAULT_MAX_CONTINUATIONS = 2;

/** The project's checkpoint-continuation budget — `pipeline.maxContinuations`, or the coded default. */
export function resolveMaxContinuations(project: ProjectConfig): number {
	return project.pipeline?.maxContinuations ?? DEFAULT_MAX_CONTINUATIONS;
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
 * How many `refs/stash` entries the divergence diagnosis reads a path list for.
 * Bounded because each one costs its own `git stash show`; branch attribution
 * comes from the single `git stash list` and is never capped.
 */
const STASH_INSPECTION_LIMIT = 10;

/** How many matching entries the message names before summarising the rest. */
const STASH_NAMED_LIMIT = 3;

/** One `refs/stash` entry, as the divergence diagnosis reads it. */
interface StashEntry {
	/** The selector `git stash apply` takes — `stash@{0}`. */
	ref: string;
	/** The reflog subject: `On <branch>: <message>` or `WIP on <branch>: <sha> <subject>`. */
	subject: string;
	/** The branch the subject names; undefined for `(no branch)` (a detached checkout) or an unparseable subject. */
	branch?: string;
	/** Repository paths the entry holds; undefined when git would not list them. */
	paths?: readonly string[];
}

/** `On <branch>: …` / `WIP on <branch>: …` — git's own two reflog subject shapes. */
const STASH_SUBJECT_BRANCH = /^(?:WIP on|On) (.+?): /;

/**
 * Every `refs/stash` entry, newest first, with a path list read for the newest
 * {@link STASH_INSPECTION_LIMIT}.
 *
 * `refs/stash` is a *shared* ref — it lives in the main repository's `.git`, not
 * in a linked worktree — so an agent that stashed inside the task worktree is
 * still listed from that worktree, and its entry's reflog subject names the branch
 * the worktree was on. A repository with no stash prints nothing and exits 0.
 */
async function readStashEntries(cwd: string): Promise<StashEntry[]> {
	const raw = await git(cwd, ['stash', 'list', '--format=%gd%x1f%gs']);
	const entries: StashEntry[] = [];
	for (const line of raw.split('\n')) {
		// Neither field can contain a newline or a unit separator, so this splits cleanly.
		const [ref, subject] = line.split('\x1f');
		if (!ref || subject === undefined) continue;
		const named = STASH_SUBJECT_BRANCH.exec(subject)?.[1];
		entries.push({
			ref,
			subject,
			branch: named === undefined || named === '(no branch)' ? undefined : named,
		});
	}
	for (const entry of entries.slice(0, STASH_INSPECTION_LIMIT)) {
		try {
			// `--include-untracked` needs git >= 2.32; an older git leaves `paths`
			// undefined and the entry is still attributable by its branch.
			const paths = await git(cwd, [
				'stash',
				'show',
				'--include-untracked',
				'--name-only',
				'-z',
				'--format=',
				entry.ref,
			]);
			entry.paths = paths.split('\0').filter((path) => path.length > 0);
		} catch {
			// One unreadable entry must not cost the diagnosis the others.
		}
	}
	return entries;
}

/** How an entry is attributed to (or away from) the task's branch, for the message. */
function describeStashBranch(entry: StashEntry, branch: string): string {
	if (entry.branch === branch) return `on this task's branch '${branch}'`;
	if (entry.branch) return `on branch '${entry.branch}', not '${branch}'`;
	return 'on no branch (a detached checkout)';
}

/** `stash@{0} ("On issue-699: wip", on this task's branch 'issue-699') holds 28 path(s), 28 of which this checkpoint records`. */
function describeStashEntry(
	entry: StashEntry,
	branch: string,
	unaccounted: ReadonlySet<string>,
): string {
	const head = `${entry.ref} ("${entry.subject}", ${describeStashBranch(entry, branch)})`;
	if (!entry.paths) return `${head} — its path list could not be read`;
	const overlap = entry.paths.filter((path) => unaccounted.has(normalizePath(path))).length;
	return `${head} holds ${entry.paths.length} path(s), ${overlap} of which this checkpoint records`;
}

/**
 * The self-diagnosing half of a divergence (issue #705): say whether the recorded
 * work that is no longer in the tree is sitting in a git stash, and if so how to
 * get it back.
 *
 * An agent that runs `git stash` inside its task worktree — to check whether a
 * failure predates its change, say — and is stopped before restoring it leaves
 * exactly the state the guard refuses: a checkpoint recording paths, over a tree
 * that no longer changes them. The stash survives (`refs/stash` is shared, not
 * per-worktree) but nothing pointed at it, so every retry failed identically and
 * recovery meant reading the reflog by hand.
 *
 * An entry **matches** when its subject names `branch` *or* its paths overlap
 * `unaccounted`. Both, because each covers the other's blind spot: a checkout
 * detached at `origin/<branch>` (issue #558) stashes as `(no branch)`, so only the
 * paths identify it, while a stash taken without `-u` holds none of the untracked
 * `added` paths, so only the branch does.
 *
 * Deliberately **reports** rather than acts: nothing here can know the stash is
 * this checkpoint's work rather than something older, so applying it could bury a
 * tree under an unrelated diff. And it is **fail-soft** — every git call is
 * wrapped, a failure yields a clause saying the check could not run, and no path
 * through it changes the verdict or throws.
 */
async function describeUnaccountedWork(
	cwd: string,
	branch: string,
	unaccounted: readonly string[],
): Promise<string> {
	let entries: StashEntry[];
	try {
		entries = await readStashEntries(cwd);
	} catch (error) {
		return `Could not check whether that work is in a git stash: ${error instanceof Error ? error.message : String(error)}`;
	}

	if (entries.length === 0)
		return 'No git stash exists in this repository, so the missing work is not stashed';

	const recorded = new Set(unaccounted.map(normalizePath));
	const matches = entries.filter(
		(entry) =>
			entry.branch === branch ||
			(entry.paths ?? []).some((path) => recorded.has(normalizePath(path))),
	);

	if (matches.length === 0) {
		const inspected = Math.min(entries.length, STASH_INSPECTION_LIMIT);
		// No silent truncation: say so whenever the cap actually bit.
		const capped =
			entries.length > inspected
				? ` (paths compared for the newest ${inspected} of ${entries.length} entries)`
				: '';
		const count =
			entries.length === 1
				? '1 git stash entry exists'
				: `${entries.length} git stash entries exist`;
		return `${count} in this repository, but none is on branch '${branch}' or holds a path this checkpoint records, so the missing work is not stashed${capped}`;
	}

	const named = matches
		.slice(0, STASH_NAMED_LIMIT)
		.map((entry) => describeStashEntry(entry, branch, recorded))
		.join('; ');
	const beyond = matches.length - STASH_NAMED_LIMIT;
	const rest =
		beyond > 0
			? `, and ${beyond} further entr${beyond === 1 ? 'y also matches' : 'ies also match'}`
			: '';
	const recovery = `git -C ${cwd} stash apply '${(matches[0] as StashEntry).ref}'`;
	logger.warn('The work a checkpoint records is missing from the tree but appears to be stashed', {
		cwd,
		branch,
		stashRef: (matches[0] as StashEntry).ref,
		stashSubject: (matches[0] as StashEntry).subject,
		matchedEntries: matches.length,
		unaccountedPaths: unaccounted.length,
		recovery,
	});
	return `The missing work appears to be in a git stash: ${named}${rest}. Restore it in the worktree with \`${recovery}\` and retry this phase; SWARM never applies a stash for you. If it is not this phase's work, start the phase over instead`;
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
 *
 * **A divergence also says where the missing work went** (issue #705). The two
 * failures that mean "the recorded work is not in the tree" — a clean tree, and
 * recorded paths the tree no longer changes — append
 * {@link describeUnaccountedWork}'s diagnosis, which reports whether a git stash
 * holds that work and names the command that restores it. The other failures do
 * not: a parse failure and a wrong-phase checkpoint say nothing about missing
 * work, and an unreadable `git status` means git is already broken, so that branch
 * returns before the probe. The probe never applies, pops, or drops a stash, and
 * is fail-soft — it cannot change the verdict, which stays byte-for-byte the
 * refusal it has always been.
 *
 * `branch` is the branch the checkout *targets*, supplied by the caller for the
 * same reason `resolveReuseHandle` (`src/pipeline/resume.ts`) takes it rather than
 * asking git: since issue #558 a checkout can be detached while still targeting a
 * branch, so a git-derived label would be a head SHA for exactly those checkouts
 * and the diagnosis would report "no stash for branch `abc1234`".
 */
export async function validateCheckpointForContinuation(
	cwd: string,
	phase: TriggerPhase,
	branch: string,
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
			detail: `the working tree in ${cwd} is clean, but ${CHECKPOINT_FILENAME} records ${recorded.length} changed path(s). ${await describeUnaccountedWork(cwd, branch, recorded)}`,
		};

	const missing = recorded.filter((path) => !present.has(path));
	if (missing.length > 0)
		return {
			valid: false,
			reason: 'checkpoint-divergent',
			detail: `${CHECKPOINT_FILENAME} records path(s) the working tree no longer changes: ${missing.join(', ')}. ${await describeUnaccountedWork(cwd, branch, missing)}`,
		};

	return { valid: true, checkpoint };
}
