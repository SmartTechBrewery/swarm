/**
 * The clone-free launcher package (issue #1283), built for real by
 * `bin/build-worker-launcher.js` and run for real from wherever it was unpacked.
 *
 * What is under test is that the package needs nothing but Node: it is run from a
 * tarball extracted into a temp directory with no `node_modules` above it and a
 * `cwd` elsewhere, and its own LaunchAgent installer writes a plist that points into
 * the package rather than into the checkout it was built from.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { swarmInstallRoot } from '@/lib/build-identity.js';

const REPO_ROOT = swarmInstallRoot();
const SCRIPT = join(REPO_ROOT, 'bin/build-worker-launcher.js');
const COMMIT = 'c'.repeat(40);
const { version: VERSION } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const NAME = `swarm-worker-launcher-${VERSION}`;
const TRUSTED_KEY = 'deploy/worker-runtime/minisign.pub';
/** The publisher's key is committed by an operational step, so a checkout may lack it. */
const HAS_KEY = existsSync(join(REPO_ROOT, TRUSTED_KEY));

const dirs: string[] = [];
function tempDir(label: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `swarm-worker-launcher-${label}-`)));
	dirs.push(dir);
	return dir;
}

function buildInto(outDir: string): string {
	const result = spawnSync(process.execPath, [SCRIPT, outDir], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		env: { ...process.env, SWARM_BUILD_COMMIT: COMMIT },
		timeout: 120_000,
	});
	expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
	if (!HAS_KEY) expect(result.stderr).toContain(`${TRUSTED_KEY} is missing`);
	return join(outDir, `${NAME}.tar.gz`);
}

/** Every entry's name, type and permission bits, in the tarball's own order. */
function tarEntries(tarball: Buffer): string[] {
	const tar = gunzipSync(tarball);
	const entries: string[] = [];
	for (let offset = 0; offset + 512 <= tar.length; ) {
		const header = tar.subarray(offset, offset + 512);
		const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '');
		if (name === '') break;
		const mode = Number.parseInt(header.subarray(100, 108).toString('ascii'), 8);
		const size = Number.parseInt(header.subarray(124, 136).toString('ascii'), 8);
		entries.push(`${mode.toString(8)} ${name}`);
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	return entries;
}

/** `node <package>/bin/swarm-worker.js …` from an unrelated cwd, with only PATH and HOME. */
function swarmWorker(args: string[], home = tempDir('home')) {
	return spawnSync(process.execPath, [join(packageRoot, 'bin/swarm-worker.js'), ...args], {
		cwd: tempDir('cwd'),
		encoding: 'utf8',
		env: { PATH: process.env.PATH ?? '', HOME: home },
		timeout: 30_000,
	});
}

let artifact: string;
let packageRoot: string;

beforeAll(() => {
	artifact = buildInto(tempDir('out'));
	const unpacked = tempDir('unpacked');
	execFileSync('tar', ['-xzf', artifact, '-C', unpacked]);
	packageRoot = join(unpacked, NAME);
}, 120_000);

afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('bin/build-worker-launcher.js', () => {
	it('packs exactly the launcher layout, with the two programs executable', () => {
		expect(tarEntries(readFileSync(artifact))).toEqual([
			`755 ${NAME}/`,
			`755 ${NAME}/bin/`,
			...(HAS_KEY ? [`755 ${NAME}/deploy/`, `755 ${NAME}/deploy/worker-runtime/`] : []),
			`755 ${NAME}/dist/`,
			`755 ${NAME}/dist/launcher/`,
			`644 ${NAME}/package.json`,
			`644 ${NAME}/build-info.json`,
			`755 ${NAME}/bin/swarm-worker.js`,
			`755 ${NAME}/bin/swarm-worker-agent`,
			...(HAS_KEY ? [`644 ${NAME}/${TRUSTED_KEY}`] : []),
			`644 ${NAME}/dist/launcher/swarm-worker.js`,
		]);
	});

	it('writes the manifest and the stamp, and ships the repo’s own shim and installer', () => {
		expect(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))).toEqual({
			name: 'swarm-worker-launcher',
			version: VERSION,
			private: true,
			type: 'module',
			engines: { node: '>=22.0.0' },
		});
		expect(JSON.parse(readFileSync(join(packageRoot, 'build-info.json'), 'utf8'))).toEqual({
			version: VERSION,
			commit: COMMIT,
		});
		for (const file of ['bin/swarm-worker.js', 'bin/swarm-worker-agent'])
			expect(
				readFileSync(join(packageRoot, file)).equals(readFileSync(join(REPO_ROOT, file))),
			).toBe(true);
		if (HAS_KEY)
			expect(
				readFileSync(join(packageRoot, TRUSTED_KEY)).equals(
					readFileSync(join(REPO_ROOT, TRUSTED_KEY)),
				),
			).toBe(true);
	});

	it('bundles nothing from the daemon graph and no path into the checkout', () => {
		const bundle = readFileSync(join(packageRoot, 'dist/launcher/swarm-worker.js'), 'utf8');
		for (const marker of [
			'bullmq',
			'drizzle-orm',
			'ioredis',
			'node_modules/pg/',
			'node_modules/ws/',
		])
			expect(bundle).not.toContain(marker);
		expect(bundle).not.toContain(REPO_ROOT);
		expect(bundle).not.toContain(realpathSync(REPO_ROOT));
	});

	it('builds byte-identical artifacts from one tree and commit', () => {
		const again = buildInto(tempDir('again'));
		expect(readFileSync(again).equals(readFileSync(artifact))).toBe(true);
	}, 120_000);

	it('runs with nothing but Node', () => {
		const help = swarmWorker(['--help']);
		expect(help.status, help.stderr).toBe(0);
		expect(help.stdout).toContain('swarm-worker run <workerId>');

		const version = swarmWorker(['--version']);
		expect(version.status, version.stderr).toBe(0);
		expect(version.stdout.trim()).toBe(VERSION);

		// Reaches the launcher itself, anchored on the package's own HOME.
		const home = tempDir('runtimes-home');
		const runtimes = swarmWorker(['runtimes'], home);
		expect(runtimes.status, runtimes.stderr).toBe(0);
		expect(runtimes.stdout).toContain(
			`swarm-launcher: no runtimes installed under ${join(home, '.swarm/runtimes')}`,
		);

		const missing = swarmWorker(['run', 'no-such-worker']);
		expect(missing.status).toBe(1);
	});

	it('installs a profile agent whose plist points into the package', () => {
		const home = tempDir('agent-home');
		const checkout = join(home, 'work', 'api');
		mkdirSync(checkout, { recursive: true });
		const profileDir = join(home, '.swarm', 'workers', 'w-1');
		mkdirSync(profileDir, { recursive: true });
		writeFileSync(
			join(profileDir, 'profile.json'),
			JSON.stringify({
				workerId: 'w-1',
				controlPlaneUrl: 'https://swarm.example.com',
				credential: 'raw-credential-SECRET',
				repoRoots: [checkout],
				createdAt: new Date().toISOString(),
			}),
		);
		// launchd and plutil stubbed, as tests/unit/worker/worker-agent-install.test.ts does.
		const harness = join(home, 'harness.sh');
		writeFileSync(
			harness,
			[
				"uname() { printf 'Darwin\\n'; }",
				'launchctl() { :; }',
				'plutil() { :; }',
				'ps() { :; }',
				`source ${JSON.stringify(join(packageRoot, 'bin/swarm-worker-agent'))} install --profile w-1`,
			].join('\n'),
		);

		const result = spawnSync('bash', [harness], {
			encoding: 'utf8',
			env: { PATH: process.env.PATH ?? '', HOME: home },
		});

		expect(result.status, result.stderr).toBe(0);
		const [plist] = readdirSync(join(home, 'Library', 'LaunchAgents'));
		const text = readFileSync(join(home, 'Library', 'LaunchAgents', plist), 'utf8');
		expect(text).toMatch(
			new RegExp(
				`<string>[^<]*node</string>\\n\\t\\t<string>${join(packageRoot, 'bin', 'swarm-worker.js')}</string>\\n\\t\\t<string>run</string>\\n\\t\\t<string>w-1</string>`,
			),
		);
		expect(text).not.toContain(REPO_ROOT);
	});
});
