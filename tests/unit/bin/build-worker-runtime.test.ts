/**
 * The self-contained worker runtime (issue #1279), built for real by
 * `bin/build-worker-runtime.js` and run for real from wherever it was unpacked.
 *
 * What is under test is that the artifact needs nothing but Node: every run below
 * starts from a tarball extracted into a temp directory with no `node_modules`
 * above it, a `cwd` elsewhere, and an environment holding only what the daemon's
 * own contract names. A module that reached back into the SWARM source tree —
 * through a path baked into the bundle, a dependency left out of it, or an
 * `import.meta.url` anchor the layout no longer satisfies — fails one of them.
 *
 * The control plane is a local HTTP server that records the handshake and answers
 * 401, which the daemon treats as fatal, so the identity run ends on its own.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run as runLauncher } from '@/launcher/main.js';
import { writeWorkerProfile } from '@/launcher/worker-profile.js';
import { swarmInstallRoot } from '@/lib/build-identity.js';
import { applyUpdateTarget } from '@/worker/self-update.js';
import { makeMinisignKey, signMinisign } from '../../helpers/runtime-fixtures.js';

const REPO_ROOT = swarmInstallRoot();
const SCRIPT = join(REPO_ROOT, 'bin/build-worker-runtime.js');
const COMMIT = 'c'.repeat(40);
const { version: VERSION } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const NAME = `swarm-worker-runtime-${VERSION}`;

// `GIT_*` leaking in from the suite's own runner would point the fixtures — and the
// daemon's own git reads — at another repository.
const baseEnv = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

const dirs: string[] = [];
function tempDir(label: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `swarm-worker-runtime-${label}-`)));
	dirs.push(dir);
	return dir;
}

function buildInto(
	outDir: string,
	env: Record<string, string> = { SWARM_BUILD_COMMIT: COMMIT },
): string {
	const result = spawnSync(process.execPath, [SCRIPT, outDir], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		env: {
			...Object.fromEntries(
				Object.entries(baseEnv).filter(([key]) => key !== 'SWARM_BUILD_COMMIT'),
			),
			...env,
		},
		timeout: 120_000,
	});
	expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
	return join(outDir, `${NAME}.tar.gz`);
}

function listFiles(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(root, join(entry.parentPath, entry.name)))
		.sort();
}

/** Run the unpacked runtime the way an operator would: `node <bundle>`, nothing else. */
function runRuntime(
	env: Record<string, string>,
): Promise<{ status: number | null; output: string }> {
	const cwd = tempDir('cwd');
	const child = spawn(process.execPath, [join(runtimeRoot, 'dist/transport/connect-entry.mjs')], {
		cwd,
		env: {
			PATH: process.env.PATH ?? '',
			HOME: cwd,
			SWARM_LOG_FILE: join(cwd, 'worker.log'),
			...env,
		},
	});
	let output = '';
	child.stdout.on('data', (chunk) => {
		output += chunk;
	});
	child.stderr.on('data', (chunk) => {
		output += chunk;
	});
	return new Promise((resolvePromise, reject) => {
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`the runtime did not exit:\n${output}`));
		}, 60_000);
		child.on('exit', (status) => {
			clearTimeout(timer);
			resolvePromise({ status, output });
		});
	});
}

let artifact: string;
let runtimeRoot: string;

beforeAll(() => {
	artifact = buildInto(tempDir('out'));
	const unpacked = tempDir('unpacked');
	execFileSync('tar', ['-xzf', artifact, '-C', unpacked]);
	runtimeRoot = join(unpacked, NAME);
}, 120_000);

afterAll(() => {
	for (const dir of dirs.splice(0)) {
		// An installed runtime is read-only (`src/launcher/runtime-store.ts`).
		execFileSync('chmod', ['-R', 'u+w', dir]);
		rmSync(dir, { recursive: true, force: true });
	}
});

/** A git checkout whose origin names `acme/widgets`, for the daemon to declare. */
function gitCheckout(): string {
	const checkout = join(tempDir('checkout'), 'repo');
	mkdirSync(checkout);
	const git = (args: string[]) =>
		execFileSync('git', args, { cwd: checkout, env: baseEnv, stdio: 'pipe' });
	const identity = ['-c', 'user.email=t@e.com', '-c', 'user.name=T'];
	git(['init', '-q', '-b', 'main']);
	git([...identity, 'commit', '-q', '--allow-empty', '-m', 'seed']);
	git(['remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
	return checkout;
}

describe('bin/build-worker-runtime.js', () => {
	it('packs exactly the manifest, the stamp and the bundle, at the depth the anchors need', () => {
		expect(listFiles(runtimeRoot)).toEqual([
			'build-info.json',
			'dist/transport/connect-entry.mjs',
			'package.json',
		]);
		expect(JSON.parse(readFileSync(join(runtimeRoot, 'package.json'), 'utf8'))).toEqual({
			name: 'swarm-worker-runtime',
			version: VERSION,
			private: true,
			type: 'module',
			engines: { node: '>=22.0.0' },
		});
		expect(JSON.parse(readFileSync(join(runtimeRoot, 'build-info.json'), 'utf8'))).toEqual({
			version: VERSION,
			commit: COMMIT,
		});
	});

	it('bakes no path into the SWARM checkout it was built from', () => {
		const bundle = readFileSync(join(runtimeRoot, 'dist/transport/connect-entry.mjs'), 'utf8');
		expect(bundle).not.toContain(REPO_ROOT);
		expect(bundle).not.toContain(realpathSync(REPO_ROOT));
	});

	it('packs no stamp when no commit is given, and still succeeds', () => {
		const unstamped = buildInto(tempDir('unstamped'), {});
		const unpacked = tempDir('unstamped-unpacked');
		execFileSync('tar', ['-xzf', unstamped, '-C', unpacked]);
		expect(listFiles(join(unpacked, NAME))).toEqual([
			'dist/transport/connect-entry.mjs',
			'package.json',
		]);
	}, 120_000);

	it('refuses a control-plane update when unpacked inside another git work tree', async () => {
		// The build script's own default: staged under a gitignored directory of a clone,
		// where `rev-parse HEAD` and a clean `status` both answer for that clone.
		const clone = join(tempDir('enclosing'), 'swarm');
		mkdirSync(clone);
		const git = (args: string[]) =>
			execFileSync('git', args, { cwd: clone, env: baseEnv, stdio: 'pipe' }).toString().trim();
		git(['init', '-q', '-b', 'main']);
		writeFileSync(join(clone, '.gitignore'), 'worker-runtime/\n');
		git(['add', '.gitignore']);
		git(['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'seed']);
		const before = git(['rev-parse', 'HEAD']);
		const nested = join(clone, 'worker-runtime', NAME);
		cpSync(runtimeRoot, nested, { recursive: true });

		const outcome = await applyUpdateTarget({
			target: 'main',
			installRoot: nested,
			homeDir: tempDir('home'),
		});

		expect(outcome.status).toBe('refused');
		if (outcome.status !== 'refused') return;
		expect(outcome.reason).toContain('not the top level');
		expect(git(['rev-parse', 'HEAD'])).toBe(before);
		expect(git(['symbolic-ref', '--quiet', 'HEAD'])).toBe('refs/heads/main');
	}, 60_000);

	it('builds byte-identical artifacts from one tree and commit', () => {
		const again = buildInto(tempDir('again'));
		expect(readFileSync(again).equals(readFileSync(artifact))).toBe(true);
	}, 120_000);

	it('loads the whole daemon with nothing but Node, and keeps its env contract', async () => {
		const { status, output } = await runRuntime({});
		// Reached only once `worker-main` and its whole import graph evaluated.
		expect(output).toContain('Missing required environment variable: SWARM_WORKER_CREDENTIAL');
		expect(status).toBe(1);
	}, 60_000);

	it('reports the stamped build identity at handshake', async () => {
		const checkout = gitCheckout();

		const handshakes: unknown[] = [];
		const server = createServer((req, res) => {
			let body = '';
			req.on('data', (chunk) => {
				body += chunk;
			});
			req.on('end', () => {
				if (req.url === '/worker/session') handshakes.push(JSON.parse(body));
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end('{"reason":"test control plane"}');
			});
		});
		await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
		try {
			const { port } = server.address() as AddressInfo;
			const { status, output } = await runRuntime({
				SWARM_WORKER_CREDENTIAL: 'test-credential',
				SWARM_CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
				SWARM_WORKER_REPO_ROOT: checkout,
				SWARM_WORKER_TRANSPORT_CLIS: 'claude',
			});
			expect(status, output).toBe(1);
			expect(handshakes).toHaveLength(1);
			expect(handshakes[0]).toMatchObject({
				daemonVersion: VERSION,
				repository: 'acme/widgets',
				build: { commit: COMMIT, dirty: false, version: VERSION },
			});
		} finally {
			await new Promise((closed) => server.close(closed));
		}
	}, 60_000);
	it('is installed, verified and started by swarm-launcher from a profile', async () => {
		const checkout = gitCheckout();
		const home = tempDir('launcher-home');
		const key = makeMinisignKey();
		const tarball = readFileSync(artifact);
		const name = `${NAME}.tar.gz`;
		const manifest = {
			available: true,
			version: VERSION,
			commit: COMMIT,
			artifact: {
				name,
				url: `/worker/runtime/artifacts/${name}`,
				size: tarball.length,
				sha256: createHash('sha256').update(tarball).digest('hex'),
			},
			signature: {
				format: 'minisign',
				minisig: signMinisign(key, tarball, `swarm-worker-runtime ${VERSION} ${COMMIT}`),
			},
		};

		const handshakes: unknown[] = [];
		const downloads: Array<string | undefined> = [];
		const server = createServer((req, res) => {
			let body = '';
			req.on('data', (chunk) => {
				body += chunk;
			});
			req.on('end', () => {
				if (req.url === '/worker/runtime/manifest') {
					res.writeHead(200, { 'content-type': 'application/json' });
					res.end(JSON.stringify(manifest));
					return;
				}
				if (req.url === manifest.artifact.url) {
					downloads.push(req.headers.authorization);
					res.writeHead(200, { 'content-type': 'application/gzip' });
					res.end(tarball);
					return;
				}
				if (req.url === '/worker/session') handshakes.push(JSON.parse(body));
				res.writeHead(401, { 'content-type': 'application/json' });
				res.end('{"reason":"test control plane"}');
			});
		});
		await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
		try {
			const { port } = server.address() as AddressInfo;
			writeWorkerProfile({
				workerId: 'launcher-worker',
				controlPlaneUrl: `http://127.0.0.1:${port}`,
				credential: 'test-credential',
				repoRoots: [checkout],
				homeDir: home,
			});
			const output: string[] = [];
			// No `execve` here, so the launcher takes its spawn fallback and the daemon
			// runs as a child this test can wait on.
			const status = await runLauncher(['run', 'launcher-worker'], {
				homeDir: home,
				trustedPublicKey: key.publicKey,
				execve: null,
				env: { PATH: process.env.PATH ?? '', HOME: home, SWARM_WORKER_TRANSPORT_CLIS: 'claude' },
				stdout: (line) => output.push(line),
				stderr: (line) => output.push(line),
			});
			expect(status, output.join('\n')).toBe(1);
			expect(downloads).toEqual(['Bearer test-credential']);
			expect(handshakes).toHaveLength(1);
			expect(handshakes[0]).toMatchObject({
				daemonVersion: VERSION,
				repository: 'acme/widgets',
				build: { commit: COMMIT, dirty: false, version: VERSION },
			});
			expect(
				readFileSync(join(home, '.swarm/workers/launcher-worker/logs/worker.log'), 'utf8'),
			).not.toBe('');
		} finally {
			await new Promise((closed) => server.close(closed));
		}
	}, 60_000);
});
