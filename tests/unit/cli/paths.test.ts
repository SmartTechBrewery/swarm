import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findInstallRoot, REPO_ROOT } from '@/cli/_shared/paths.js';
import { swarmInstallRoot } from '@/lib/build-identity.js';

/**
 * Issue #1311: the install root is the nearest `package.json` above the module, so
 * the same code resolves the checkout from `src/cli/_shared/` and
 * `dist/cli/_shared/`, and the launcher package's own root from its bundle at
 * `dist/launcher/`.
 */
describe('findInstallRoot', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function installRoot(): string {
		const root = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-install-root-')));
		dirs.push(root);
		writeFileSync(join(root, 'package.json'), '{}');
		return root;
	}

	it.each([
		['src/cli/_shared'],
		['dist/cli/_shared'],
		['dist/launcher'],
	])('finds the root from %s', (depth) => {
		const root = installRoot();
		const from = join(root, depth);
		mkdirSync(from, { recursive: true });
		expect(findInstallRoot(from)).toBe(root);
	});

	it('stops at the nearest package.json, not an outer one', () => {
		const outer = installRoot();
		const pkg = join(outer, 'node_modules', 'swarm-worker-launcher');
		mkdirSync(join(pkg, 'dist', 'launcher'), { recursive: true });
		writeFileSync(join(pkg, 'package.json'), '{}');
		expect(findInstallRoot(join(pkg, 'dist', 'launcher'))).toBe(pkg);
	});

	it('resolves this checkout from the source tree', () => {
		expect(REPO_ROOT).toBe(swarmInstallRoot());
	});
});
