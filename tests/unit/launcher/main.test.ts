import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DAEMON_ENV_KEYS, type LauncherDeps, run } from '@/launcher/main.js';
import { RUNTIME_ENTRYPOINT, runtimesDir } from '@/launcher/runtime-store.js';
import {
	readWorkerState,
	updateWorkerState,
	workerProfileDir,
	writeWorkerProfile,
	writeWorkerState,
} from '@/launcher/worker-profile.js';
import type { WorkerRuntimeManifest } from '@/transport/runtime-manifest.js';
import {
	buildRuntimeTarball,
	makeMinisignKey,
	signMinisign,
} from '../../helpers/runtime-fixtures.js';

const KEY = makeMinisignKey();
const CREDENTIAL = 'super-secret-worker-credential';
const KEY_PATH = '/opt/swarm-launcher/deploy/worker-runtime/minisign.pub';
const AMBIENT = {
	PATH: '/usr/bin',
	HOME: '/home/operator',
	XPC_SERVICE_NAME: 'com.example.worker',
	SWARM_CONTROL_PLANE_URL: 'https://stale.example.com',
	SWARM_WORKER_CREDENTIAL: 'stale-credential',
	SWARM_WORKER_REPO_ROOT: '/stale/checkout',
	SWARM_LOG_FILE: '/stale/worker.log',
	SWARM_WORKER_ID: 'stale-worker',
	SWARM_RUNTIME_TRUSTED_KEY: '/stale/minisign.pub',
};

interface ControlPlane {
	url: string;
	version: string;
	commit: string;
	manifest?: WorkerRuntimeManifest | 'unreachable';
	/** Corrupts the served bytes so the checksum fails. */
	tamper?: boolean;
}

function routesFor(plane: ControlPlane): Record<string, () => Response> {
	const tarball = buildRuntimeTarball(plane.version, plane.commit);
	const name = `swarm-worker-runtime-${plane.version}.tar.gz`;
	const manifest: WorkerRuntimeManifest =
		plane.manifest && plane.manifest !== 'unreachable'
			? plane.manifest
			: {
					available: true,
					version: plane.version,
					commit: plane.commit,
					artifact: {
						name,
						url: `/worker/runtime/artifacts/${name}`,
						size: tarball.length,
						sha256: createHash('sha256').update(tarball).digest('hex'),
					},
					signature: {
						format: 'minisign',
						minisig: signMinisign(
							KEY,
							tarball,
							`swarm-worker-runtime ${plane.version} ${plane.commit}`,
						),
					},
				};
	const served = plane.tamper ? Buffer.from(tarball).fill(0, 100, 110) : tarball;
	return {
		[`${plane.url}/worker/runtime/manifest`]: () => {
			if (plane.manifest === 'unreachable') throw new Error('connect ECONNREFUSED');
			return Response.json(manifest);
		},
		[`${plane.url}/worker/runtime/artifacts/${name}`]: () => new Response(new Uint8Array(served)),
	};
}

function fakeFetch(planes: ControlPlane[]): typeof globalThis.fetch {
	const routes = Object.assign({}, ...planes.map(routesFor));
	return (async (input: URL | string) => {
		const route = routes[input.toString()];
		return route ? route() : new Response('not found', { status: 404 });
	}) as typeof globalThis.fetch;
}

interface Exec {
	file: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd: string | undefined;
}

describe('swarm-launcher', () => {
	let home: string;
	let checkout: string;
	let extra: string;
	let execs: Exec[];
	let output: string[];
	let cwd: string | undefined;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'launcher-'));
		checkout = realpathSync(mkdtempSync(join(tmpdir(), 'launcher-checkout-')));
		extra = realpathSync(mkdtempSync(join(tmpdir(), 'launcher-extra-')));
		execs = [];
		output = [];
		cwd = undefined;
	});
	afterEach(() => {
		if (existsSync(home)) execFileSync('chmod', ['-R', 'u+w', home]);
		for (const dir of [home, checkout, extra]) rmSync(dir, { recursive: true, force: true });
	});

	const profile = (workerId: string, controlPlaneUrl: string) =>
		writeWorkerProfile({
			workerId,
			controlPlaneUrl,
			credential: CREDENTIAL,
			repoRoots: [checkout, extra],
			homeDir: home,
		});

	/** A state written before selections existed. */
	const clearSelection = (workerId: string) => {
		const state = readWorkerState(workerId, home);
		if (!state) throw new Error('no state');
		writeWorkerState(
			workerId,
			{ lastRuntimeVersion: state.lastRuntimeVersion, startedAt: state.startedAt },
			home,
		);
	};

	const deps = (planes: ControlPlane[], overrides: Partial<LauncherDeps> = {}): LauncherDeps => ({
		homeDir: home,
		fetch: fakeFetch(planes),
		env: AMBIENT,
		execPath: '/usr/local/bin/node',
		trustedPublicKey: KEY.publicKey,
		trustedKeyPath: KEY_PATH,
		chdir: (dir) => {
			cwd = dir;
		},
		execve: (file, args, env) => {
			execs.push({ file, args, env, cwd });
		},
		spawnDaemon: async () => {
			throw new Error('spawn must not be reached');
		},
		now: () => Date.parse('2026-11-04T12:00:00.000Z'),
		stdout: (line) => output.push(line),
		stderr: (line) => output.push(line),
		...overrides,
	});

	const V1: ControlPlane = {
		url: 'https://one.example.com',
		version: '1.0.0',
		commit: 'a'.repeat(40),
	};
	const V2: ControlPlane = {
		url: 'https://two.example.com',
		version: '2.0.0',
		commit: 'b'.repeat(40),
	};

	it('installs the named runtime and execs it with exactly the daemon vars from the profile', async () => {
		profile('worker-one', V1.url);
		expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);

		const profileDir = workerProfileDir('worker-one', home);
		const entrypoint = join(runtimesDir(home), '1.0.0', RUNTIME_ENTRYPOINT);
		expect(execs).toHaveLength(1);
		const [exec] = execs;
		expect(exec.file).toBe('/usr/local/bin/node');
		expect(exec.args).toEqual(['/usr/local/bin/node', entrypoint]);
		expect(exec.cwd).toBe(profileDir);
		expect(exec.env).toEqual({
			...AMBIENT,
			SWARM_CONTROL_PLANE_URL: V1.url,
			SWARM_WORKER_CREDENTIAL: CREDENTIAL,
			SWARM_WORKER_REPO_ROOT: [checkout, extra].join(delimiter),
			SWARM_LOG_FILE: join(profileDir, 'logs', 'worker.log'),
			SWARM_WORKER_ID: 'worker-one',
			SWARM_RUNTIME_TRUSTED_KEY: KEY_PATH,
		});
		// The path of the launcher's key, never its contents.
		expect(Object.values(exec.env).join('\n')).not.toContain(KEY.publicKey.split('\n')[1]);
		// The launcher adds nothing beyond the daemon's own contract.
		const added = Object.keys(exec.env).filter((key) => !(key in AMBIENT));
		expect(added.every((key) => (DAEMON_ENV_KEYS as readonly string[]).includes(key))).toBe(true);
		expect(statSync(join(profileDir, 'logs')).isDirectory()).toBe(true);
		// With no selection yet, the manifest's version becomes it.
		expect(readWorkerState('worker-one', home)).toEqual({
			lastRuntimeVersion: '1.0.0',
			startedAt: '2026-11-04T12:00:00.000Z',
			selectedVersion: '1.0.0',
		});
	});

	it('hands the daemon no trusted key path when the launcher has no key', async () => {
		profile('worker-one', V1.url);
		await run(['run', 'worker-one'], deps([V1], { trustedKeyPath: null }));
		expect(execs[0].env.SWARM_WORKER_ID).toBe('worker-one');
		expect('SWARM_RUNTIME_TRUSTED_KEY' in execs[0].env).toBe(false);
	});

	it('starts the selected version even when the manifest names another', async () => {
		profile('worker-one', V1.url);
		// Installs 1.0.0 and selects it.
		await run(['run', 'worker-one'], deps([V1]));
		execs = [];
		// The installation now serves 2.0.0, which does not move a worker off its selection.
		const moved = { ...V2, url: V1.url };
		expect(await run(['run', 'worker-one'], deps([moved]))).toBe(0);
		expect(execs[0].args[1]).toBe(join(runtimesDir(home), '1.0.0', RUNTIME_ENTRYPOINT));
		expect(existsSync(join(runtimesDir(home), '2.0.0'))).toBe(false);

		// A selection the daemon recorded (`swarm workers update`) is what starts next.
		profile('worker-two', V2.url);
		await run(['run', 'worker-two'], deps([V2]));
		updateWorkerState('worker-one', { selectedVersion: '2.0.0' }, home);
		execs = [];
		expect(await run(['run', 'worker-one'], deps([{ ...V1, manifest: 'unreachable' }]))).toBe(0);
		expect(execs[0].args[1]).toBe(join(runtimesDir(home), '2.0.0', RUNTIME_ENTRYPOINT));
		expect(readWorkerState('worker-one', home)).toMatchObject({
			lastRuntimeVersion: '2.0.0',
			selectedVersion: '2.0.0',
		});
	});

	it('asks the control plane when the selected version is not installed, and selects its answer', async () => {
		profile('worker-one', V1.url);
		writeWorkerState(
			'worker-one',
			{
				lastRuntimeVersion: '0.9.0',
				startedAt: '2026-11-01T00:00:00.000Z',
				selectedVersion: '0.9.0',
			},
			home,
		);
		expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
		expect(execs[0].args[1]).toBe(join(runtimesDir(home), '1.0.0', RUNTIME_ENTRYPOINT));
		expect(readWorkerState('worker-one', home)?.selectedVersion).toBe('1.0.0');
	});

	it('never puts the credential in argv or in its output', async () => {
		profile('worker-one', V1.url);
		await run(['run', 'worker-one'], deps([V1]));
		await run(['run', 'worker-one'], deps([V1], { execve: null, spawnDaemon: async () => 0 }));
		expect(execs[0].args.join(' ')).not.toContain(CREDENTIAL);
		expect(output.join('\n')).not.toContain(CREDENTIAL);
		expect(output.join('\n')).toContain("starting worker 'worker-one' on v1.0.0");
	});

	it('execs two profiles on two control planes into two different runtimes', async () => {
		profile('worker-one', V1.url);
		profile('worker-two', V2.url);
		const both = deps([V1, V2]);
		expect(await run(['run', 'worker-one'], both)).toBe(0);
		expect(await run(['run', 'worker-two'], both)).toBe(0);

		expect(execs.map((exec) => exec.args[1])).toEqual([
			join(runtimesDir(home), '1.0.0', RUNTIME_ENTRYPOINT),
			join(runtimesDir(home), '2.0.0', RUNTIME_ENTRYPOINT),
		]);
		expect(execs.map((exec) => exec.env.SWARM_CONTROL_PLANE_URL)).toEqual([V1.url, V2.url]);
		expect(execs[0].cwd).not.toBe(execs[1].cwd);
	});

	it('starts nothing and exits 1 naming the check when the runtime fails verification', async () => {
		profile('worker-one', V1.url);
		expect(await run(['run', 'worker-one'], deps([{ ...V1, tamper: true }]))).toBe(1);
		expect(execs).toEqual([]);
		expect(output.join('\n')).toContain('SHA-256');
		expect(existsSync(join(runtimesDir(home), '1.0.0'))).toBe(false);
		expect(readWorkerState('worker-one', home)).toBeNull();
	});

	it('does not fall back to the last version when the named one fails verification', async () => {
		profile('worker-one', V1.url);
		await run(['run', 'worker-one'], deps([V1]));
		clearSelection('worker-one');
		execs = [];
		expect(await run(['run', 'worker-one'], deps([{ ...V2, url: V1.url, tamper: true }]))).toBe(1);
		expect(execs).toEqual([]);
	});

	it('refuses to install with no trusted key, but still starts an installed version', async () => {
		profile('worker-one', V1.url);
		expect(await run(['run', 'worker-one'], deps([V1], { trustedPublicKey: null }))).toBe(1);
		expect(output.join('\n')).toContain('no trusted runtime signing key');
		expect(execs).toEqual([]);

		await run(['run', 'worker-one'], deps([V1]));
		expect(await run(['run', 'worker-one'], deps([V1], { trustedPublicKey: null }))).toBe(0);
		expect(execs).toHaveLength(2);
	});

	it('falls back to the last installed version when the control plane is unreachable', async () => {
		profile('worker-one', V1.url);
		await run(['run', 'worker-one'], deps([V1]));
		clearSelection('worker-one');
		execs = [];
		output = [];

		expect(await run(['run', 'worker-one'], deps([{ ...V1, manifest: 'unreachable' }]))).toBe(0);
		expect(execs[0].args[1]).toBe(join(runtimesDir(home), '1.0.0', RUNTIME_ENTRYPOINT));
		expect(output.join('\n')).toContain('ECONNREFUSED');

		expect(
			await run(
				['run', 'worker-one'],
				deps([{ ...V1, manifest: { available: false, reason: 'no runtime packed' } }]),
			),
		).toBe(0);
		expect(execs).toHaveLength(2);
		// Nothing the control plane named, so nothing newly selected.
		expect(readWorkerState('worker-one', home)?.selectedVersion).toBeUndefined();
	});

	it('fails when the control plane is unreachable and no last version is installed', async () => {
		profile('worker-one', V1.url);
		expect(await run(['run', 'worker-one'], deps([{ ...V1, manifest: 'unreachable' }]))).toBe(1);
		expect(output.join('\n')).toContain('no runtime this worker last started on is installed');

		writeWorkerState(
			'worker-one',
			{ lastRuntimeVersion: '0.9.0', startedAt: '2026-11-01T00:00:00.000Z' },
			home,
		);
		expect(await run(['run', 'worker-one'], deps([{ ...V1, manifest: 'unreachable' }]))).toBe(1);
		expect(execs).toEqual([]);
	});

	it('spawns the daemon when execve is unavailable or refused', async () => {
		profile('worker-one', V1.url);
		const spawned: Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }> = [];
		const spawnDaemon = async (
			_file: string,
			args: string[],
			dir: string,
			env: NodeJS.ProcessEnv,
		) => {
			spawned.push({ args, cwd: dir, env });
			return 7;
		};
		expect(await run(['run', 'worker-one'], deps([V1], { execve: null, spawnDaemon }))).toBe(7);
		expect(
			await run(
				['run', 'worker-one'],
				deps([V1], {
					execve: () => {
						throw new Error('EPERM');
					},
					spawnDaemon,
				}),
			),
		).toBe(7);
		expect(spawned).toHaveLength(2);
		expect(spawned[0].cwd).toBe(workerProfileDir('worker-one', home));
		expect(spawned[0].env.SWARM_WORKER_CREDENTIAL).toBe(CREDENTIAL);
		expect(output.join('\n')).toContain('EPERM');
	});

	it('refuses a missing profile, an unreadable one, and an unsafe worker id', async () => {
		expect(await run(['run', 'nobody'], deps([V1]))).toBe(1);
		expect(output.join('\n')).toContain("no profile for worker 'nobody'");
		expect(await run(['run', '../escape'], deps([V1]))).toBe(1);
		expect(output.join('\n')).toContain('not a valid worker id');
		expect(execs).toEqual([]);
	});

	describe('a version awaiting verification (issue #1303)', () => {
		const pendingAt = '2026-11-04T11:00:00.000Z';

		/** worker-one installed on 1.0.0, moved to 2.0.0, which has not connected yet. */
		const movedTo2 = async (failedStarts = 0, previousVersion = '1.0.0') => {
			profile('worker-one', V1.url);
			await run(['run', 'worker-one'], deps([V1]));
			profile('worker-two', V2.url);
			await run(['run', 'worker-two'], deps([V2]));
			updateWorkerState(
				'worker-one',
				{
					selectedVersion: '2.0.0',
					lastKnownGoodVersion: '1.0.0',
					pendingVerification: {
						version: '2.0.0',
						previousVersion,
						failedStarts,
						startedAt: pendingAt,
					},
				},
				home,
			);
			execs = [];
			output = [];
		};
		const entrypointOf = (version: string) => join(runtimesDir(home), version, RUNTIME_ENTRYPOINT);
		const pending = () => readWorkerState('worker-one', home)?.pendingVerification;

		it('counts the first and second starts and starts the new version', async () => {
			await movedTo2();
			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
			expect(execs[0].args[1]).toBe(entrypointOf('2.0.0'));
			expect(pending()).toMatchObject({ version: '2.0.0', failedStarts: 1 });
			expect(output.join('\n')).toContain('newly selected');

			execs = [];
			output = [];
			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
			expect(execs[0].args[1]).toBe(entrypointOf('2.0.0'));
			expect(pending()).toMatchObject({ version: '2.0.0', failedStarts: 2 });
			expect(output.join('\n')).toContain('has still not connected once');
			// The rest of the state survives the launcher's own write.
			expect(readWorkerState('worker-one', home)).toMatchObject({
				lastRuntimeVersion: '2.0.0',
				selectedVersion: '2.0.0',
				lastKnownGoodVersion: '1.0.0',
			});
		});

		it('writes the count before it hands its process to the daemon', async () => {
			await movedTo2();
			const seen: Array<number | undefined> = [];
			await run(
				['run', 'worker-one'],
				deps([V1], {
					execve: () => {
						seen.push(pending()?.failedStarts);
					},
				}),
			);
			expect(seen).toEqual([1]);
		});

		it('starts the version it was moved from on the third start, and clears the record', async () => {
			await movedTo2(2);
			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
			expect(execs[0].args[1]).toBe(entrypointOf('1.0.0'));
			expect(readWorkerState('worker-one', home)).toMatchObject({
				lastRuntimeVersion: '1.0.0',
				selectedVersion: '1.0.0',
				lastKnownGoodVersion: '1.0.0',
				pendingVerification: null,
			});
			expect(output.join('\n')).toContain('giving up on v2.0.0');

			// And it stays there: the next start is an ordinary one.
			execs = [];
			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
			expect(execs[0].args[1]).toBe(entrypointOf('1.0.0'));
		});

		it('starts nothing, exits 1 and keeps the record when the previous version is not installed', async () => {
			await movedTo2(2, '0.5.0');
			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(1);
			expect(execs).toEqual([]);
			expect(readWorkerState('worker-one', home)).toMatchObject({
				selectedVersion: '2.0.0',
				pendingVerification: { version: '2.0.0', previousVersion: '0.5.0', failedStarts: 3 },
			});
			expect(output.join('\n')).toContain(
				'v0.5.0, the version this worker was moved from, is not installed',
			);
		});

		it('does not count a record naming another version than the selected one', async () => {
			await movedTo2();
			updateWorkerState('worker-one', { selectedVersion: '1.0.0' }, home);
			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
			expect(execs[0].args[1]).toBe(entrypointOf('1.0.0'));
			expect(pending()).toMatchObject({ failedStarts: 0 });
		});
	});

	describe('removing runtime versions no worker uses', () => {
		const OLD = new Date('2026-11-01T00:00:00.000Z');
		const versionDir = (version: string) => join(runtimesDir(home), version);
		/** A third version nobody names, installed long ago. */
		const plantStale = (version: string) => {
			const dir = versionDir(version);
			mkdirSync(join(dir, 'dist/transport'), { recursive: true });
			writeFileSync(join(dir, RUNTIME_ENTRYPOINT), 'stale');
			execFileSync('chmod', ['-R', 'a-w', dir]);
		};
		const age = (...versions: string[]) => {
			for (const version of versions) utimesSync(versionDir(version), OLD, OLD);
		};

		it('removes only the version no profile uses', async () => {
			profile('worker-one', V1.url);
			profile('worker-two', V2.url);
			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
			expect(await run(['run', 'worker-two'], deps([V2]))).toBe(0);
			plantStale('0.9.0');
			age('0.9.0', '1.0.0', '2.0.0');
			output = [];
			execs = [];

			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
			expect(execs).toHaveLength(1);
			expect(existsSync(versionDir('0.9.0'))).toBe(false);
			expect(existsSync(versionDir('1.0.0'))).toBe(true);
			expect(existsSync(versionDir('2.0.0'))).toBe(true);
			expect(output).toContain(
				'swarm-launcher: removed v0.9.0, which no worker on this host uses any more',
			);
		});

		it('removes nothing while another worker state is unreadable, and still starts', async () => {
			profile('worker-one', V1.url);
			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
			plantStale('0.9.0');
			age('0.9.0', '1.0.0');
			mkdirSync(join(home, '.swarm', 'workers', 'worker-two'), { recursive: true });
			writeFileSync(join(home, '.swarm', 'workers', 'worker-two', 'state.json'), '{ broken');
			execs = [];

			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
			expect(execs).toHaveLength(1);
			expect(existsSync(versionDir('0.9.0'))).toBe(true);
		});

		it('still starts when the prune cannot run at all', async () => {
			profile('worker-one', V1.url);
			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
			plantStale('0.9.0');
			age('0.9.0', '1.0.0');
			// No lock can be taken under a `.locks` that is not a directory.
			rmSync(join(runtimesDir(home), '.locks'), { recursive: true, force: true });
			writeFileSync(join(runtimesDir(home), '.locks'), 'not a directory');
			output = [];
			execs = [];

			expect(await run(['run', 'worker-one'], deps([V1]))).toBe(0);
			expect(execs).toHaveLength(1);
			expect(existsSync(versionDir('0.9.0'))).toBe(true);
			expect(output.join('\n')).toMatch(/could not remove unused runtime versions/);
			expect(readWorkerState('worker-one', home)?.lastRuntimeVersion).toBe('1.0.0');
		});
	});

	it('lists the installed runtimes', async () => {
		expect(await run(['runtimes'], deps([]))).toBe(0);
		expect(output.join('\n')).toContain('no runtimes installed');

		profile('worker-one', V1.url);
		profile('worker-two', V2.url);
		await run(['run', 'worker-one'], deps([V1, V2]));
		await run(['run', 'worker-two'], deps([V1, V2]));
		output = [];
		expect(await run(['runtimes'], deps([]))).toBe(0);
		expect(output).toEqual([
			`swarm-launcher: v1.0.0  ${V1.commit}  ${join(runtimesDir(home), '1.0.0')}`,
			`swarm-launcher: v2.0.0  ${V2.commit}  ${join(runtimesDir(home), '2.0.0')}`,
		]);
	});

	it('prints usage for --help and refuses an unknown command', async () => {
		expect(await run(['--help'], deps([]))).toBe(0);
		expect(output.join('\n')).toContain('swarm-launcher run <workerId>');
		expect(await run(['nope'], deps([]))).toBe(1);
		expect(await run([], deps([]))).toBe(1);
		expect(await run(['run'], deps([]))).toBe(1);
	});
});
