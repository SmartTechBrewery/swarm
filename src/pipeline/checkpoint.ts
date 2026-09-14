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
 * The two metacharacters that make a recorded entry a *candidate* pattern.
 * Deliberately narrow, and deliberately consulted only after exact membership has
 * already failed (see {@link accountsForRecordedEntry}): `*` and `?` are legal bytes
 * in a filename, so a real `src/a*.ts` the tree still changes is reported by
 * `git status` under that name, matches literally, and never reaches this branch.
 *
 * Exported for the continuation prompt (`src/pipeline/prompts/checkpoint.ts`), which
 * has to hedge the same way over the same entries and must not invent a second,
 * drifting definition of what looks like a pattern.
 */
export const GLOB_METACHARACTERS = /[*?]/;

/** Escape every RegExp metacharacter, so a literal glob segment matches itself. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `pattern` as an anchored RegExp over repository-relative paths, with a glob's own
 * segment semantics: `**` crosses `/`, a single `*`/`?` does not. Tokenised rather
 * than chained-replaced so an escaped literal can never be re-read as a
 * metacharacter, and runs of `*` collapsed *first* so no two cross-directory tokens
 * are ever adjacent. That last step is what makes the no-catastrophic-backtracking
 * claim hold: one `(?:[^/]+/)*` group is terminated by a `/` each iteration and
 * cannot blow up on its own, but consecutive copies are mutually ambiguous and
 * degrade polynomially in their number (seven of them measured at 32 ms against a
 * 20-segment non-match, against 0.5 ms for one). Both collapses are exact
 * identities — three or more `*` describe the same set as two, and a repeated
 * cross-directory token the same set as one — so the bound costs no expressiveness.
 */
function globToRegExp(pattern: string): RegExp {
	const collapsed = pattern.replace(/\*{3,}/g, '**').replace(/(?:\*\*\/)+/g, '**/');
	const source = collapsed.replace(/\*\*\/|\*\*|\*|\?|[^*?]+/g, (token) => {
		switch (token) {
			case '**/':
				return '(?:[^/]+/)*';
			case '**':
				return '.*';
			case '*':
				return '[^/]*';
			case '?':
				return '[^/]';
			default:
				return escapeRegExp(token);
		}
	});
	return new RegExp(`^${source}$`);
}

/** Whether one recorded entry describes `path` — literally, or as a glob (issue #949). */
function recordedEntryMatchesPath(entry: string, path: string): boolean {
	if (entry === path) return true;
	if (!GLOB_METACHARACTERS.test(entry)) return false;
	return globToRegExp(entry).test(path);
}

/**
 * Whether `entry` still describes something `paths` changes.
 *
 * Exact membership first — the whole comparison for a well-written checkpoint, and
 * unchanged in cost. A checkpoint that compressed a hundreds-of-files change into
 * globs (issue #949) is then satisfied by *any* present path the pattern matches:
 * the original file list is not recoverable, so "this entry still describes work in
 * the tree" is the strongest thing the recorded form can assert. A pattern matching
 * nothing is still divergence, which is what keeps the one-sided rule intact.
 *
 * Accounted-for is therefore not the whole verdict: because one surviving match
 * satisfies an entry that stood for hundreds, the caller re-tests a tolerated entry
 * against the stash ({@link stashedToleratedWork}) before accepting the checkpoint.
 */
function accountsForRecordedEntry(entry: string, paths: ReadonlySet<string>): boolean {
	if (paths.has(entry)) return true;
	if (!GLOB_METACHARACTERS.test(entry)) return false;
	const matcher = globToRegExp(entry);
	for (const path of paths) if (matcher.test(path)) return true;
	return false;
}

/**
 * A missing entry, saying *how* it was looked for when it carries `*` or `?`
 * (issue #949).
 *
 * Deliberately does not call such an entry a pattern. Literal-first only settles
 * the path-or-glob question for an entry the tree still changes; for one it does
 * not, both readings failed and neither is disproved — a checkpoint that recorded
 * a real file named `docs/what-if-*.md` (the legal filename {@link
 * GLOB_METACHARACTERS} exists to protect) and whose tree no longer changes it
 * would otherwise be told its path is a glob. The message states what is actually
 * known, which is true either way and costs the same line.
 */
function describeMissingEntry(entry: string): string {
	return GLOB_METACHARACTERS.test(entry)
		? `${entry} (no changed path matches it, as a path or as a pattern)`
		: entry;
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
	unaccounted: readonly string[],
): string {
	const head = `${entry.ref} ("${entry.subject}", ${describeStashBranch(entry, branch)})`;
	if (!entry.paths) return `${head} — its path list could not be read`;
	const overlap = entry.paths.filter((path) =>
		unaccounted.some((recorded) => recordedEntryMatchesPath(recorded, normalizePath(path))),
	).length;
	return `${head} holds ${entry.paths.length} path(s), ${overlap} of which this checkpoint records`;
}

/**
 * The clause for a repository that has stashes, none of which is this work — said
 * plainly, so a stale unrelated stash is never presented as "your work is over
 * here", and never silently truncated: the {@link STASH_INSPECTION_LIMIT} is
 * disclosed whenever it actually bit.
 */
function describeNoMatchingStash(entries: readonly StashEntry[], branch: string): string {
	const inspected = Math.min(entries.length, STASH_INSPECTION_LIMIT);
	const capped =
		entries.length > inspected
			? ` (paths compared for the newest ${inspected} of ${entries.length} entries)`
			: '';
	const count =
		entries.length === 1 ? '1 git stash entry exists' : `${entries.length} git stash entries exist`;
	return `${count} in this repository, but none is on branch '${branch}' or holds a path this checkpoint records, so the missing work is not stashed${capped}`;
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
	known?: readonly StashEntry[],
): Promise<string> {
	// `known` is the list a caller has already read — {@link stashedToleratedWork}'s
	// path check — so the refusal it decided on does not pay for a second probe.
	let entries: readonly StashEntry[] = known ?? [];
	if (!known) {
		try {
			entries = await readStashEntries(cwd);
		} catch (error) {
			return `Could not check whether that work is in a git stash: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	if (entries.length === 0)
		return 'No git stash exists in this repository, so the missing work is not stashed';

	const recorded = unaccounted.map(normalizePath);
	const matches = entries.filter(
		(entry) =>
			entry.branch === branch ||
			(entry.paths ?? []).some((path) =>
				recorded.some((recordedEntry) =>
					recordedEntryMatchesPath(recordedEntry, normalizePath(path)),
				),
			),
	);

	if (matches.length === 0) return describeNoMatchingStash(entries, branch);

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
 * Whether a stash holds work one of the *tolerated* patterns describes — the one
 * thing {@link accountsForRecordedEntry}'s ≥1-match rule cannot see (issue #949).
 *
 * A glob cannot say how many files it stood for, so one surviving match satisfies an
 * entry that stood for hundreds. An agent that stashed its tracked edits and left a
 * single untracked file behind — `git stash` without `-u` takes no untracked file —
 * would otherwise be accepted on a tree that has lost nearly all of the recorded
 * work, with the #705 diagnosis never running because `missing` was empty. A stash
 * *holding* paths the pattern also describes is positive evidence the work left the
 * tree, so it is the only signal consulted here:
 *
 * - **Not branch attribution**, which {@link describeUnaccountedWork} matches on as
 *   well. There it is a report over an already-decided divergence; here it would
 *   *make* one, and an unrelated stash taken on the task's branch would turn a good
 *   continuation into a terminal refusal. The blind spot branch attribution covers
 *   there — a stash holding none of the recorded `added` paths — cannot arise here
 *   either, because a stash that took no tracked path holds nothing at all.
 * - **Not an unreadable path list.** Absence of evidence is not evidence, and the
 *   probe stays fail-soft in the same direction as everything else on this path: a
 *   git failure must never turn an acceptance into a refusal.
 */
function stashedToleratedWork(
	entries: readonly StashEntry[],
	tolerated: readonly string[],
): boolean {
	return entries.some((entry) =>
		(entry.paths ?? []).some((path) =>
			tolerated.some((pattern) => recordedEntryMatchesPath(pattern, normalizePath(path))),
		),
	);
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
 * 3. Every entry it records still describes something `git status --porcelain`
 *    reports as changed. Exact set membership first; an entry that fails it *and*
 *    carries a glob metacharacter is matched as a pattern instead (issue #949), so a
 *    checkpoint that compressed a hundreds-of-files change into globs is not read as
 *    work that vanished. A pattern matching *nothing* the tree changes is still
 *    divergence — and so is one that still matches a changed path while a git stash
 *    holds work it also describes, because a single surviving match cannot tell a
 *    whole recorded change from what is left of one ({@link stashedToleratedWork}).
 *    Where the tolerance does carry a checkpoint, the guard logs a `warn` naming the
 *    entries it accepted.
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
 * **A divergence also says where the missing work went** (issue #705). The three
 * failures that mean "the recorded work is not in the tree" — a clean tree,
 * recorded paths the tree no longer changes, and a tolerated pattern the stash
 * holds work for — append
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

	const missing = recorded.filter((entry) => !accountsForRecordedEntry(entry, present));
	if (missing.length > 0)
		return {
			valid: false,
			reason: 'checkpoint-divergent',
			detail: `${CHECKPOINT_FILENAME} records path(s) the working tree no longer changes: ${missing.map(describeMissingEntry).join(', ')}. ${await describeUnaccountedWork(cwd, branch, missing)}`,
		};

	// `missing` is empty here, so these are exactly the entries the glob fallback
	// accepted — a continuation that only worked because of the tolerance is visible.
	const tolerated = recorded.filter(
		(entry) => !present.has(entry) && GLOB_METACHARACTERS.test(entry),
	);
	if (tolerated.length > 0) {
		let stashed: readonly StashEntry[] = [];
		try {
			stashed = await readStashEntries(cwd);
		} catch {
			// Fail-soft: an unreadable stash is not evidence the work went anywhere.
		}
		if (stashedToleratedWork(stashed, tolerated))
			return {
				valid: false,
				reason: 'checkpoint-divergent',
				detail: `${CHECKPOINT_FILENAME} records pattern(s) the working tree still matches, but a git stash holds work they also describe: ${tolerated.join(', ')}. ${await describeUnaccountedWork(cwd, branch, tolerated, stashed)}`,
			};
		logger.warn(
			`${CHECKPOINT_FILENAME} describes the working tree with pattern(s) rather than literal paths`,
			{ cwd, phase, patterns: tolerated },
		);
	}

	return { valid: true, checkpoint };
}
