import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { settleMergeResolution } from '@/pipeline/merge-resolution.js';
import { UnretryableDeliveryError, validatePreparedTree } from '@/scm/delivery.js';

/**
 * Real git fixtures, deliberately (issue #844): the whole subject is what git
 * reports about an *index*, so a stub would only assert that the stub agrees
 * with itself. Scaffolding copied from `tests/unit/scm/delivery.test.ts`, whose
 * refusal suite is the other half of this pair.
 */

const roots: string[] = [];
const fixtureGitEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function fixtureGit(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: fixtureGitEnvironment });
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function initRepo(): string {
	const root = mkdtempSync(join(tmpdir(), 'swarm-merge-resolution-'));
	roots.push(root);
	fixtureGit(root, ['init', '-b', 'main']);
	fixtureGit(root, ['config', 'user.email', 't@e.com']);
	fixtureGit(root, ['config', 'user.name', 'T']);
	return root;
}

function mergeMain(root: string): void {
	try {
		fixtureGit(root, ['merge', 'main']);
	} catch {
		// Expected: the merge conflicts, which is the state under test.
	}
}

/** A repository stopped mid-merge, with `write` supplying each side's version of the conflicting files. */
function repoMidMerge(write: (root: string, side: 'base' | 'feature' | 'main') => void): string {
	const root = initRepo();
	write(root, 'base');
	fixtureGit(root, ['add', '.']);
	fixtureGit(root, ['commit', '-m', 'base']);
	fixtureGit(root, ['checkout', '-q', '-b', 'feature']);
	write(root, 'feature');
	fixtureGit(root, ['commit', '-am', 'feature']);
	fixtureGit(root, ['checkout', '-q', 'main']);
	write(root, 'main');
	fixtureGit(root, ['commit', '-am', 'main']);
	fixtureGit(root, ['checkout', '-q', 'feature']);
	mergeMain(root);
	return root;
}

/** Both text files conflict on the same line — the incident's shape. */
function textConflict(): string {
	return repoMidMerge((root, side) => {
		writeFileSync(join(root, 'a.txt'), `${side}\n`);
		writeFileSync(join(root, 'b.txt'), `${side}\n`);
	});
}

/** An absolute location built from raw bytes — `join` takes strings, so it would decode the name. */
function at(root: string, name: Buffer): Buffer {
	return Buffer.concat([Buffer.from(`${root}${sep}`), name]);
}

/** A valid git pathname that is not valid UTF-8: git stores bytes, not text. */
const NON_UTF8_NAME = Buffer.concat([
	Buffer.from('bad-'),
	Buffer.from([0xff]),
	Buffer.from('.txt'),
]);

/**
 * Whether this filesystem will hold {@link NON_UTF8_NAME} at all.
 *
 * APFS/HFS+ reject a pathname that is not valid UTF-8 outright (`EILSEQ`), so
 * the fixture below cannot be built on macOS however correct the code is. CI is
 * Linux, where it runs; probing beats hard-coding a platform.
 */
const FILESYSTEM_HOLDS_NON_UTF8_NAMES = (() => {
	const probe = mkdtempSync(join(tmpdir(), 'swarm-merge-resolution-probe-'));
	try {
		writeFileSync(at(probe, NON_UTF8_NAME), 'probe');
		return true;
	} catch {
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();

describe('settleMergeResolution (issue #844)', () => {
	// The incident: the agent wrote clean resolved text over both conflicted
	// files, verified there were no markers left, and never staged them.
	it('stages a resolution the agent left unmerged, and the tree then delivers', async () => {
		const root = textConflict();
		writeFileSync(join(root, 'a.txt'), 'resolved by hand\n');
		writeFileSync(join(root, 'b.txt'), 'resolved by hand\n');

		const settlement = await settleMergeResolution(root);

		expect(settlement).toEqual({ staged: ['a.txt', 'b.txt'], unresolved: [] });
		// The question delivery asks, asked again: it now prints nothing.
		expect(fixtureGit(root, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
		await expect(validatePreparedTree(root)).resolves.toBeUndefined();
	});

	it('leaves a path still carrying conflict markers for the terminal refusal', async () => {
		const root = textConflict();
		// `b.txt` keeps the merge's own markers — genuinely unresolved.
		writeFileSync(join(root, 'a.txt'), 'resolved by hand\n');

		const settlement = await settleMergeResolution(root);

		expect(settlement).toEqual({ staged: ['a.txt'], unresolved: ['b.txt'] });
		const error = await validatePreparedTree(root).catch((e) => e);
		expect(error).toBeInstanceOf(UnretryableDeliveryError);
		// Only the path that is really still conflicted is named.
		expect(error.message).toContain('unresolved conflicts in b.txt');
		expect(error.message).not.toContain('a.txt');
	});

	// The regression that protects the two files from the original incident:
	// `PROJECT.md` and `ai/ARCHITECTURE.md` are Markdown, where `=======` is an
	// ordinary heading underline, so keying on it would refuse a fine delivery.
	it('does not misread a Markdown heading underline as a conflict marker', async () => {
		const root = textConflict();
		const resolved = 'Heading\n=======\n\nBoth sides, merged.\n';
		writeFileSync(join(root, 'a.txt'), resolved);
		writeFileSync(join(root, 'b.txt'), resolved);

		const settlement = await settleMergeResolution(root);

		expect(settlement).toEqual({ staged: ['a.txt', 'b.txt'], unresolved: [] });
	});

	// diff3-style markers, which a `merge.conflictStyle` setting produces.
	it('treats a diff3 base marker as unresolved', async () => {
		const root = textConflict();
		writeFileSync(join(root, 'a.txt'), 'resolved by hand\n');
		writeFileSync(join(root, 'b.txt'), '||||||| merged common ancestors\nbase\n');

		expect(await settleMergeResolution(root)).toEqual({
			staged: ['a.txt'],
			unresolved: ['b.txt'],
		});
	});

	// A delete-side resolution is a real decision, not a staging slip: the agent
	// is told to `git rm` it, and an unstaged deletion reaches a human instead.
	it('leaves an unmerged path with no working-tree file alone', async () => {
		const root = repoMidMerge((repo, side) => {
			if (side === 'main') fixtureGit(repo, ['rm', '-q', 'gone.txt']);
			else writeFileSync(join(repo, 'gone.txt'), `${side}\n`);
		});
		rmSync(join(root, 'gone.txt'));

		const settlement = await settleMergeResolution(root);

		expect(settlement).toEqual({ staged: [], unresolved: ['gone.txt'] });
		const error = await validatePreparedTree(root).catch((e) => e);
		expect(error).toBeInstanceOf(UnretryableDeliveryError);
		expect(error.message).toContain('unresolved conflicts in gone.txt');
	});

	// A binary conflict leaves one side's bytes in the working tree, so staging it
	// would silently pick that side.
	it('leaves a binary conflict unmerged', async () => {
		const root = repoMidMerge((repo, side) => {
			const byte = { base: 0x10, feature: 0x20, main: 0x30 }[side];
			writeFileSync(join(repo, 'logo.bin'), Buffer.from([0x00, 0x01, byte, 0x00]));
		});

		expect(await settleMergeResolution(root)).toEqual({ staged: [], unresolved: ['logo.bin'] });
	});

	// The normal path: an agent that staged its own resolution costs one git read
	// and leaves the tree exactly as it found it.
	it('leaves an already-staged resolution alone', async () => {
		const root = textConflict();
		writeFileSync(join(root, 'a.txt'), 'resolved by hand\n');
		writeFileSync(join(root, 'b.txt'), 'resolved by hand\n');
		fixtureGit(root, ['add', '--', 'a.txt', 'b.txt']);
		const before = fixtureGit(root, ['status', '--porcelain']);

		expect(await settleMergeResolution(root)).toEqual({ staged: [], unresolved: [] });
		expect(fixtureGit(root, ['status', '--porcelain'])).toBe(before);
	});

	// git pathnames are bytes; a Node string is not. Decoding the enumeration
	// would replace the 0xff with U+FFFD, and the mangled name would then match
	// neither the file on disk nor the index entry, so a merge already resolved
	// in content would be refused as unmergeable.
	it.skipIf(!FILESYSTEM_HOLDS_NON_UTF8_NAMES)(
		'stages a resolved path whose name is not valid UTF-8',
		async () => {
			const root = repoMidMerge((repo, side) => {
				writeFileSync(at(repo, NON_UTF8_NAME), `${side}\n`);
			});
			writeFileSync(at(root, NON_UTF8_NAME), 'resolved by hand\n');

			const settlement = await settleMergeResolution(root);

			// Reported lossily — the result is read by humans, never fed back to git.
			expect(settlement).toEqual({ staged: [NON_UTF8_NAME.toString('utf8')], unresolved: [] });
			expect(fixtureGit(root, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
			await expect(validatePreparedTree(root)).resolves.toBeUndefined();
		},
	);

	// A git argument is pathspec syntax, not a filename: a leading `:` reads as
	// pathspec magic and aborts the whole `git add`, and `[1]` reads as a glob.
	it('stages a resolved path whose name reads as a pathspec pattern', async () => {
		const name = Buffer.from(':weird[1]*.txt');
		const root = repoMidMerge((repo, side) => {
			writeFileSync(at(repo, name), `${side}\n`);
		});
		writeFileSync(at(root, name), 'resolved by hand\n');

		const settlement = await settleMergeResolution(root);

		expect(settlement).toEqual({ staged: [':weird[1]*.txt'], unresolved: [] });
		expect(fixtureGit(root, ['diff', '--name-only', '--diff-filter=U'])).toBe('');
		await expect(validatePreparedTree(root)).resolves.toBeUndefined();
	});

	// A repository with no merge in progress at all — every other phase's tree.
	it('does nothing to a repository holding no unmerged paths', async () => {
		const root = initRepo();
		writeFileSync(join(root, 'a.txt'), 'only\n');
		fixtureGit(root, ['add', '.']);
		fixtureGit(root, ['commit', '-m', 'base']);
		writeFileSync(join(root, 'a.txt'), 'edited\n');

		expect(await settleMergeResolution(root)).toEqual({ staged: [], unresolved: [] });
		expect(fixtureGit(root, ['status', '--porcelain'])).toBe(' M a.txt\n');
	});
});
