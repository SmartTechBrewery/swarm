import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `dev:api`'s watch scope (issue #1051). The launchd-served API restarts on every
 * change its `--watch` sees, and `swarm-api-agent reload`'s "an aborted reload
 * leaves the old build serving" rests on that being `./src` alone. `--env-file`
 * silently widened it to the whole checkout — Node watches the env file too, by
 * recursively watching its directory — so the watched server loads `.env` through
 * the `bin/load-env.js` preload instead, and must keep doing so.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PRELOAD = pathToFileURL(join(ROOT, 'bin/load-env.js')).href;

/** The argv of `dev:api`'s last step: the long-lived, watched server process. */
function watchedServerArgv(): string[] {
	const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
		scripts: Record<string, string>;
	};
	const steps = pkg.scripts['dev:api'].split('&&');
	return (steps.at(-1) ?? '').trim().split(/\s+/);
}

describe('dev:api watch scope (issue #1051)', () => {
	it('watches ./src only and hands the watcher no env file', () => {
		const argv = watchedServerArgv();
		expect(argv).toContain('--watch');
		expect(argv.filter((arg) => arg.startsWith('--watch-path'))).toEqual(['--watch-path=./src']);
		expect(argv.filter((arg) => arg.startsWith('--env-file'))).toEqual([]);
		expect(argv[argv.indexOf('./bin/load-env.js') - 1]).toBe('--import');
	});

	describe('bin/load-env.js', () => {
		let dir: string;

		beforeEach(() => {
			dir = mkdtempSync(join(tmpdir(), 'swarm-load-env-'));
		});

		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		function runWithPreload(env: NodeJS.ProcessEnv = {}) {
			return spawnSync(
				process.execPath,
				[
					'--import',
					PRELOAD,
					'-e',
					'process.stdout.write(JSON.stringify([process.env.FROM_FILE, process.env.PRESET]))',
				],
				{ cwd: dir, env: { ...process.env, ...env }, encoding: 'utf8' },
			);
		}

		it('loads .env from the working directory, leaving an already-set variable alone', () => {
			writeFileSync(join(dir, '.env'), 'FROM_FILE=file\nPRESET=file\n');
			const result = runWithPreload({ PRESET: 'ambient' });
			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual(['file', 'ambient']);
		});

		it('refuses to start without a .env, as --env-file=.env does', () => {
			const result = runWithPreload();
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain('ENOENT');
		});
	});
});
