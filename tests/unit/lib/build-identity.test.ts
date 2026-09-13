/**
 * The daemon's declared build identity (issue #918), driven against **real**
 * temporary git repositories rather than a mocked `child_process`: the module's
 * whole value is that it reads git correctly, and a mock would only assert that
 * the argv we wrote is the argv we wrote. Same approach as
 * `tests/unit/pipeline/implementation-delivery.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	resolveBuildIdentity,
	resolveOwnBuildIdentity,
	swarmInstallRoot,
} from '@/lib/build-identity.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A daemon inherits the operator's environment, but `GIT_*` leaking in from the
// suite's own runner would point these fixtures at another repository.
const gitEnv = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = gitEnv): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: 'pipe' });
}

/** A checkout with one commit, a `.gitignore` for `dist/`, and a clean tree. */
function makeCheckout(committedAt = '2026-01-01T00:00:00Z'): string {
	const root = mkdtempSync(join(tmpdir(), 'swarm-build-identity-'));
	roots.push(root);
	execFileSync('git', ['init', '-q', '-b', 'main', root], { env: gitEnv });
	writeFileSync(join(root, '.gitignore'), 'dist/\nlogs/\n');
	writeFileSync(join(root, 'package.json'), '{}\n');
	git(root, ['add', '.']);
	git(root, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'seed'], {
		...gitEnv,
		GIT_AUTHOR_DATE: committedAt,
		GIT_COMMITTER_DATE: committedAt,
	});
	return root;
}

/** The path a compiled copy of this module would run from, with a chosen mtime. */
function makeDistModule(root: string, mtime: Date): string {
	const path = join(root, 'dist', 'lib', 'build-identity.js');
	mkdirSync(join(root, 'dist', 'lib'), { recursive: true });
	writeFileSync(path, '// compiled\n');
	utimesSync(path, mtime, mtime);
	return path;
}

/** The path this module runs from when the daemon is started from source (`tsx`). */
function sourceModule(root: string): string {
	return join(root, 'src', 'lib', 'build-identity.ts');
}

describe('resolveBuildIdentity', () => {
	it('reports the checkout HEAD and a clean tree', async () => {
		const root = makeCheckout();
		const build = await resolveBuildIdentity(root, sourceModule(root));
		expect(build).toEqual({
			commit: git(root, ['rev-parse', 'HEAD']).trim(),
			dirty: false,
		});
		expect(build?.commit).toMatch(/^[0-9a-f]{40}$/);
	});

	it('reports the same commit with dirty set when the tree has an uncommitted change', async () => {
		const root = makeCheckout();
		writeFileSync(join(root, 'package.json'), '{"changed":true}\n');
		const build = await resolveBuildIdentity(root, sourceModule(root));
		expect(build).toEqual({ commit: git(root, ['rev-parse', 'HEAD']).trim(), dirty: true });
	});

	// The case that would otherwise make every real host report dirty: `dist/`,
	// `logs/` and `.swarm-workspaces/` are all gitignored on a working install.
	it('stays clean for an untracked file the checkout ignores', async () => {
		const root = makeCheckout();
		mkdirSync(join(root, 'logs'), { recursive: true });
		writeFileSync(join(root, 'logs', 'worker.log'), 'noise\n');
		const build = await resolveBuildIdentity(root, sourceModule(root));
		expect(build?.dirty).toBe(false);
	});

	it('declares nothing — and does not throw — for a directory that is not a git checkout', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-build-identity-bare-'));
		roots.push(root);
		await expect(resolveBuildIdentity(root, sourceModule(root))).resolves.toBeUndefined();
	});

	it('declares nothing — and does not throw — when git cannot run at all', async () => {
		const root = join(tmpdir(), 'swarm-build-identity-absent');
		expect(existsSync(root)).toBe(false);
		await expect(resolveBuildIdentity(root, sourceModule(root))).resolves.toBeUndefined();
	});

	// `bin/swarm.js` runs the compiled `dist/`, so there the checkout's HEAD and the
	// code actually executing can differ — the second half of what `dirty` covers.
	it('reports dirty for a dist build older than the commit it claims', async () => {
		const root = makeCheckout('2026-01-02T00:00:00Z');
		const modulePath = makeDistModule(root, new Date('2026-01-01T00:00:00Z'));
		const build = await resolveBuildIdentity(root, modulePath);
		expect(build?.dirty).toBe(true);
	});

	it('stays clean for a dist build newer than HEAD', async () => {
		const root = makeCheckout('2026-01-02T00:00:00Z');
		const modulePath = makeDistModule(root, new Date('2026-01-03T00:00:00Z'));
		const build = await resolveBuildIdentity(root, modulePath);
		expect(build?.dirty).toBe(false);
	});

	// Running from source (`npm run dev:worker`) the running code *is* the checkout,
	// so an old file mtime says nothing and the staleness check is skipped entirely.
	it('ignores the module mtime when running from source rather than dist', async () => {
		const root = makeCheckout('2026-01-02T00:00:00Z');
		const path = sourceModule(root);
		mkdirSync(join(root, 'src', 'lib'), { recursive: true });
		writeFileSync(path, '// source\n');
		utimesSync(path, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
		// Written into the checkout, so keep the tree clean about it.
		writeFileSync(join(root, '.gitignore'), 'dist/\nlogs/\nsrc/\n');
		git(root, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-am', 'ignore']);
		const build = await resolveBuildIdentity(root, path);
		expect(build?.dirty).toBe(false);
	});
});

describe('resolveOwnBuildIdentity', () => {
	it('is memoized, so a running process reports one identity for its whole life', async () => {
		const first = await resolveOwnBuildIdentity();
		const second = await resolveOwnBuildIdentity();
		// Identity, not equality: a second resolution could differ from the first, which
		// is exactly what a per-request caller in phase 2 must not be able to observe.
		expect(second).toBe(first);
	});

	it('anchors the install root on this module, not on the working directory', () => {
		// The SWARM checkout itself, wherever the suite was launched from.
		expect(existsSync(join(swarmInstallRoot(), 'package.json'))).toBe(true);
	});
});
