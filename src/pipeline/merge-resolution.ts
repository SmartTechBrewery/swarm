/**
 * Index-settling backstop for the Resolve-conflicts phase (issue #844).
 *
 * The agent and SWARM disagreed on what "resolved" means. The agent edits the
 * conflicted files and verifies by scanning for conflict markers;
 * `validatePreparedTree` (`src/scm/delivery.ts`) asks the *index*
 * (`git diff --name-only --diff-filter=U`). On PR #98 the agent resolved both
 * files correctly — zero markers left — but never `git add`-ed them, so the
 * stage 1/2/3 entries survived and delivery refused a tree that was, by
 * content, perfectly deliverable; staging the two files by hand made the very
 * next attempt deliver.
 *
 * So this asks git the **same question delivery asks** and settles the index
 * for whatever the agent already resolved in the working tree. Anything
 * genuinely still conflicted — markers left, the file deleted, a binary
 * conflict — is deliberately left unmerged, so a real ambiguity reaches the
 * terminal refusal (issue #839) with the paths named rather than being silently
 * decided here.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gitEnvironmentForCwd } from '@/scm/delivery.js';

const execFileAsync = promisify(execFile);

/** What {@link settleMergeResolution} staged, and what it deliberately left unmerged. */
export interface MergeResolutionSettlement {
	/** Unmerged paths whose working-tree content is conflict-free, now staged. */
	staged: string[];
	/** Unmerged paths left alone — still marked up, deleted, binary, or unreadable. */
	unresolved: string[];
}

/**
 * A git conflict marker: seven `<`, `>` or `|` starting a line, followed by the
 * label git writes after it (or nothing).
 *
 * **Deliberately not `=======`.** A bare `=======` line is ordinary Markdown/RST
 * heading underlining — `PROJECT.md` and `ai/ARCHITECTURE.md`, the two files in
 * the incident above, are Markdown — and a false positive here refuses a
 * delivery that is fine. The other three markers never occur in prose.
 */
const CONFLICT_MARKER = /^(?:<{7}|>{7}|\|{7})(?: |\r?$)/m;

/** git's own binary test: a NUL byte in the first 8000 bytes. */
const BINARY_SNIFF_BYTES = 8000;

/** `git`, scoped to `cwd` alone — see {@link gitEnvironmentForCwd}. Output is returned raw (the NUL-delimited read must not be trimmed). */
async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnvironmentForCwd() });
	return stdout;
}

/**
 * Whether the working-tree file at `path` is resolved text this may stage.
 *
 * Every "no" is a resolution only a human or the agent can make, not a staging
 * slip: a missing file is a delete-side decision (the agent was told to
 * `git rm` it), an unreadable one (a submodule, a permission error) is not ours
 * to interpret, and a binary conflict leaves one side's bytes in the working
 * tree, so staging it would silently pick that side.
 */
async function isResolvedInWorkingTree(cwd: string, path: string): Promise<boolean> {
	let contents: Buffer;
	try {
		contents = await readFile(join(cwd, path));
	} catch {
		return false;
	}
	if (contents.subarray(0, BINARY_SNIFF_BYTES).includes(0)) return false;
	return !CONFLICT_MARKER.test(contents.toString('utf8'));
}

/**
 * Stage every unmerged path the agent already resolved in the working tree, and
 * report both halves.
 *
 * Enumerates with the identical command `validatePreparedTree` validates on
 * (`-z` only, so a path needing quoting still compares byte-for-byte) — asking
 * the same question is the point, since it is what makes the two definitions of
 * "resolved" impossible to drift rather than merely unlikely to. A tree the
 * agent staged correctly costs exactly one git call.
 *
 * Never throws for a still-conflicted path: `unresolved` is reported and the
 * index left unmerged so `validatePreparedTree` raises the one refusal, with
 * the one classification. A failing `git add` does propagate — the tree then
 * fails validation terminally, which is correct.
 */
export async function settleMergeResolution(cwd: string): Promise<MergeResolutionSettlement> {
	const raw = await git(cwd, ['diff', '--name-only', '-z', '--diff-filter=U']);
	const unmerged = raw.split('\0').filter((path) => path.length > 0);
	if (unmerged.length === 0) return { staged: [], unresolved: [] };

	const staged: string[] = [];
	const unresolved: string[] = [];
	for (const path of unmerged) {
		if (await isResolvedInWorkingTree(cwd, path)) staged.push(path);
		else unresolved.push(path);
	}
	if (staged.length > 0) await git(cwd, ['add', '--', ...staged]);
	return { staged, unresolved };
}
