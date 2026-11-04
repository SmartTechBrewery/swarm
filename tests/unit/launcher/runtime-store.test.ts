import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	ensureRuntime,
	fetchRuntimeManifest,
	installedRuntime,
	listInstalledRuntimes,
	RUNTIME_ENTRYPOINT,
	runtimesDir,
	STALE_STAGING_MS,
} from '@/launcher/runtime-store.js';
import type { AvailableWorkerRuntimeManifest } from '@/transport/runtime-manifest.js';
import {
	buildRuntimeTarball,
	buildTar,
	makeMinisignKey,
	runtimeEntries,
	signMinisign,
	TEST_ENTRYPOINT_SOURCE,
} from '../../helpers/runtime-fixtures.js';

const CONTROL_PLANE = 'https://swarm.example.com';
const VERSION = '1.2.3';
const COMMIT = 'abcdef0123456789abcdef0123456789abcdef01';
const BEARER = 'worker-credential';
const KEY = makeMinisignKey();

interface Served {
	status?: number;
	body?: Buffer | string;
	throws?: Error;
}

interface FakeFetch {
	fetch: typeof globalThis.fetch;
	calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }>;
}

function fakeFetch(routes: Record<string, Served>): FakeFetch {
	const calls: FakeFetch['calls'] = [];
	const fetch = (async (input: URL | string, init?: RequestInit) => {
		const url = input.toString();
		calls.push({
			url,
			headers: { ...(init?.headers as Record<string, string> | undefined) },
			redirect: init?.redirect,
		});
		// Yield, so two concurrent installs genuinely interleave.
		await new Promise((resolve) => setTimeout(resolve, 1));
		const route = routes[url];
		if (!route) return new Response('not found', { status: 404 });
		if (route.throws) throw route.throws;
		const body = typeof route.body === 'string' ? route.body : new Uint8Array(route.body ?? []);
		return new Response(body, { status: route.status ?? 200 });
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

function manifestFor(
	data: Buffer,
	options: {
		version?: string;
		commit?: string;
		url?: string;
		size?: number;
		sha256?: string;
		minisig?: string;
	} = {},
): AvailableWorkerRuntimeManifest {
	const version = options.version ?? VERSION;
	const commit = options.commit ?? COMMIT;
	const name = `swarm-worker-runtime-${version}.tar.gz`;
	return {
		available: true,
		version,
		commit,
		artifact: {
			name,
			url: options.url ?? `/worker/runtime/artifacts/${name}`,
			size: options.size ?? data.length,
			sha256: options.sha256 ?? createHash('sha256').update(data).digest('hex'),
		},
		signature: {
			format: 'minisign',
			minisig:
				options.minisig ?? signMinisign(KEY, data, `swarm-worker-runtime ${version} ${commit}`),
		},
	};
}

const ARTIFACT_URL = `${CONTROL_PLANE}/worker/runtime/artifacts/swarm-worker-runtime-${VERSION}.tar.gz`;

describe('ensureRuntime', () => {
	let home: string;
	let tarball: Buffer;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'runtime-store-'));
		tarball = buildRuntimeTarball(VERSION, COMMIT);
	});
	afterEach(() => {
		execFileSync('chmod', ['-R', 'u+w', home]);
		rmSync(home, { recursive: true, force: true });
	});

	const versionDir = () => join(runtimesDir(home), VERSION);
	const stagingEntries = () => {
		const staging = join(runtimesDir(home), '.staging');
		return existsSync(staging) ? readdirSync(staging) : [];
	};
	const ensure = (
		manifest: AvailableWorkerRuntimeManifest,
		fetch: FakeFetch,
		overrides: { trustedPublicKey?: string; now?: () => number } = {},
	) =>
		ensureRuntime({
			controlPlaneUrl: CONTROL_PLANE,
			manifest,
			bearer: BEARER,
			trustedPublicKey:
				'trustedPublicKey' in overrides ? overrides.trustedPublicKey : KEY.publicKey,
			homeDir: home,
			fetch: fetch.fetch,
			now: overrides.now,
		});

	it('installs a verified runtime read-only under ~/.swarm/runtimes/<version>/', async () => {
		const fetch = fakeFetch({ [ARTIFACT_URL]: { body: tarball } });
		const result = await ensure(manifestFor(tarball), fetch);

		const dir = versionDir();
		expect(result).toEqual({
			version: VERSION,
			dir,
			entrypoint: join(dir, RUNTIME_ENTRYPOINT),
			installed: true,
		});
		expect(readFileSync(join(dir, RUNTIME_ENTRYPOINT), 'utf8')).toBe(TEST_ENTRYPOINT_SOURCE);
		for (const path of ['', 'dist', 'dist/transport'])
			expect(statSync(join(dir, path)).mode & 0o777).toBe(0o555);
		for (const path of ['package.json', 'build-info.json', RUNTIME_ENTRYPOINT])
			expect(statSync(join(dir, path)).mode & 0o777).toBe(0o444);
		expect(stagingEntries()).toEqual([]);
		expect(installedRuntime(VERSION, home)).toMatchObject({ dir, commit: COMMIT });
		expect(listInstalledRuntimes(home).map((runtime) => runtime.version)).toEqual([VERSION]);
	});

	it('sends the bearer to the control-plane origin and refuses redirects with it', async () => {
		const fetch = fakeFetch({ [ARTIFACT_URL]: { body: tarball } });
		await ensure(manifestFor(tarball), fetch);
		expect(fetch.calls).toEqual([
			{ url: ARTIFACT_URL, headers: { authorization: `Bearer ${BEARER}` }, redirect: 'error' },
		]);
	});

	it('never sends the bearer to an artifact URL on another origin', async () => {
		const elsewhere = 'https://cdn.example.net/swarm-worker-runtime-1.2.3.tar.gz';
		const fetch = fakeFetch({ [elsewhere]: { body: tarball } });
		const result = await ensure(manifestFor(tarball, { url: elsewhere }), fetch);
		expect(result).toMatchObject({ installed: true });
		expect(fetch.calls).toEqual([{ url: elsewhere, headers: {}, redirect: 'follow' }]);
	});

	it.each<[string, (data: Buffer) => AvailableWorkerRuntimeManifest, RegExp]>([
		['a checksum mismatch', (data) => manifestFor(data, { sha256: 'f'.repeat(64) }), /SHA-256/],
		[
			'a tampered signature',
			(data) =>
				manifestFor(data, {
					minisig: signMinisign(
						KEY,
						Buffer.from('other'),
						`swarm-worker-runtime ${VERSION} ${COMMIT}`,
					),
				}),
			/signature does not verify/,
		],
		[
			'a signature from an untrusted key',
			(data) =>
				manifestFor(data, {
					minisig: signMinisign(
						makeMinisignKey(),
						data,
						`swarm-worker-runtime ${VERSION} ${COMMIT}`,
					),
				}),
			/signed by a different key/,
		],
		[
			'a trusted comment naming another version',
			(data) =>
				manifestFor(data, {
					minisig: signMinisign(KEY, data, `swarm-worker-runtime 9.9.9 ${COMMIT}`),
				}),
			/signed as v9\.9\.9/,
		],
		[
			'a trusted comment naming another commit',
			(data) =>
				manifestFor(data, {
					minisig: signMinisign(KEY, data, `swarm-worker-runtime ${VERSION} ${'0'.repeat(40)}`),
				}),
			/signed for commit 0{40}/,
		],
		[
			'a trusted comment naming nothing',
			(data) => manifestFor(data, { minisig: signMinisign(KEY, data, 'timestamp:1 file:x') }),
			/names no version and commit/,
		],
		[
			'a body larger than the manifest says',
			(data) => manifestFor(data, { size: data.length - 1 }),
			/larger than/,
		],
		[
			'a body shorter than the manifest says',
			(data) => manifestFor(data, { size: data.length + 1 }),
			/bytes, the manifest names/,
		],
	])('refuses %s and writes nothing', async (_label, makeManifest, message) => {
		const fetch = fakeFetch({ [ARTIFACT_URL]: { body: tarball } });
		const result = await ensure(makeManifest(tarball), fetch);
		expect(result).toEqual({ error: expect.stringMatching(message) });
		expect(existsSync(versionDir())).toBe(false);
		expect(stagingEntries()).toEqual([]);
	});

	it('refuses an HTTP error from the artifact route', async () => {
		const fetch = fakeFetch({ [ARTIFACT_URL]: { status: 401, body: 'no' } });
		expect(await ensure(manifestFor(tarball), fetch)).toEqual({
			error: expect.stringMatching(/HTTP 401 \(the credential was refused\)/),
		});
	});

	it('refuses to download without a trusted key, but still serves an installed version', async () => {
		const fetch = fakeFetch({ [ARTIFACT_URL]: { body: tarball } });
		const manifest = manifestFor(tarball);
		for (const trustedPublicKey of [undefined, '  ']) {
			expect(await ensure(manifest, fetch, { trustedPublicKey })).toEqual({
				error: expect.stringMatching(/no trusted runtime signing key/),
			});
		}
		expect(fetch.calls).toEqual([]);

		await ensure(manifest, fetch);
		expect(await ensure(manifest, fetch, { trustedPublicKey: undefined })).toMatchObject({
			installed: false,
			dir: versionDir(),
		});
	});

	it('leaves no version behind when a verified archive fails to extract', async () => {
		const top = `swarm-worker-runtime-${VERSION}`;
		const corrupt = gzipSync(
			buildTar([...runtimeEntries(VERSION, COMMIT), { name: `${top}/../escape`, data: 'x' }]),
		);
		const fetch = fakeFetch({ [ARTIFACT_URL]: { body: corrupt } });
		const result = await ensure(manifestFor(corrupt), fetch);
		expect(result).toEqual({
			error: expect.stringMatching(/installing v1\.2\.3 failed: .*relative path/),
		});
		expect(existsSync(versionDir())).toBe(false);
		expect(stagingEntries()).toEqual([]);
	});

	it('leaves no version behind when the archive carries no entrypoint', async () => {
		const partial = gzipSync(buildTar(runtimeEntries(VERSION).slice(0, 4)));
		const fetch = fakeFetch({ [ARTIFACT_URL]: { body: partial } });
		expect(await ensure(manifestFor(partial), fetch)).toEqual({
			error: expect.stringMatching(/carries no dist\/transport\/connect-entry\.mjs/),
		});
		expect(existsSync(versionDir())).toBe(false);
		expect(stagingEntries()).toEqual([]);
	});

	describe('a version already on disk', () => {
		const plant = (commit: string) => {
			const dir = versionDir();
			mkdirSync(join(dir, 'dist/transport'), { recursive: true });
			writeFileSync(join(dir, RUNTIME_ENTRYPOINT), 'planted');
			writeFileSync(join(dir, 'build-info.json'), JSON.stringify({ version: VERSION, commit }));
		};

		it('is returned without any fetch when its commit matches', async () => {
			plant(COMMIT.slice(0, 12));
			const fetch = fakeFetch({});
			expect(await ensure(manifestFor(tarball), fetch)).toEqual({
				version: VERSION,
				dir: versionDir(),
				entrypoint: join(versionDir(), RUNTIME_ENTRYPOINT),
				installed: false,
			});
			expect(fetch.calls).toEqual([]);
		});

		it('is refused and left untouched when its commit differs', async () => {
			plant('0'.repeat(40));
			const fetch = fakeFetch({ [ARTIFACT_URL]: { body: tarball } });
			expect(await ensure(manifestFor(tarball), fetch)).toEqual({
				error: expect.stringMatching(/installed from 0{40}, but the installation names/),
			});
			expect(fetch.calls).toEqual([]);
			expect(readFileSync(join(versionDir(), RUNTIME_ENTRYPOINT), 'utf8')).toBe('planted');
		});
	});

	it('lets two concurrent installs of one version agree on one directory', async () => {
		const fetch = fakeFetch({ [ARTIFACT_URL]: { body: tarball } });
		const manifest = manifestFor(tarball);
		const results = await Promise.all([ensure(manifest, fetch), ensure(manifest, fetch)]);
		expect(results.map((result) => 'dir' in result && result.dir)).toEqual([
			versionDir(),
			versionDir(),
		]);
		expect(results.map((result) => 'installed' in result && result.installed).sort()).toEqual([
			false,
			true,
		]);
		expect(readdirSync(runtimesDir(home)).sort()).toEqual(['.staging', VERSION]);
		expect(stagingEntries()).toEqual([]);
	});

	it('sweeps staging directories older than an hour and keeps fresh ones', async () => {
		const staging = join(runtimesDir(home), '.staging');
		const stale = join(staging, '1.0.0.111.stale');
		const fresh = join(staging, '1.0.0.222.fresh');
		mkdirSync(join(stale, 'dist'), { recursive: true });
		mkdirSync(fresh, { recursive: true });
		const now = Date.now();
		const old = new Date(now - STALE_STAGING_MS - 60_000);
		utimesSync(stale, old, old);

		const fetch = fakeFetch({ [ARTIFACT_URL]: { body: tarball } });
		await ensure(manifestFor(tarball), fetch, { now: () => now });
		expect(stagingEntries()).toEqual(['1.0.0.222.fresh']);
	});

	it.each([
		'../evil',
		'a/b',
		'..',
		'.hidden',
		'',
	])('refuses the version %j before any I/O', async (version) => {
		const fetch = fakeFetch({});
		const manifest = { ...manifestFor(tarball), version };
		expect(await ensure(manifest, fetch)).toEqual({
			error: expect.stringMatching(/is not a valid version/),
		});
		expect(fetch.calls).toEqual([]);
		expect(existsSync(runtimesDir(home))).toBe(false);
	});

	it('refuses an artifact name that is not the version’s', async () => {
		const manifest = manifestFor(tarball);
		manifest.artifact.name = 'swarm-worker-runtime-9.9.9.tar.gz';
		expect(await ensure(manifest, fakeFetch({}))).toEqual({
			error: expect.stringMatching(/is not the runtime for v1\.2\.3/),
		});
	});
});

describe('fetchRuntimeManifest', () => {
	const MANIFEST_URL = `${CONTROL_PLANE}/worker/runtime/manifest`;

	it('returns an available manifest', async () => {
		const manifest = manifestFor(buildRuntimeTarball(VERSION));
		const fetch = fakeFetch({ [MANIFEST_URL]: { body: JSON.stringify(manifest) } });
		expect(await fetchRuntimeManifest(CONTROL_PLANE, { fetch: fetch.fetch })).toEqual(manifest);
	});

	it('asks for a named release with ?version=, and for its own runtime without one', async () => {
		const manifest = manifestFor(buildRuntimeTarball(VERSION));
		const fetch = fakeFetch({
			[MANIFEST_URL]: { body: JSON.stringify(manifest) },
			[`${MANIFEST_URL}?version=${VERSION}`]: { body: JSON.stringify(manifest) },
		});

		expect(
			await fetchRuntimeManifest(CONTROL_PLANE, { fetch: fetch.fetch, version: VERSION }),
		).toEqual(manifest);
		await fetchRuntimeManifest(CONTROL_PLANE, { fetch: fetch.fetch });

		expect(fetch.calls.map((call) => call.url)).toEqual([
			`${MANIFEST_URL}?version=${VERSION}`,
			MANIFEST_URL,
		]);
	});

	it('sends a bearer only when given one, refusing redirects with it', async () => {
		const manifest = manifestFor(buildRuntimeTarball(VERSION));
		const fetch = fakeFetch({
			[MANIFEST_URL]: { body: JSON.stringify(manifest) },
			[`${MANIFEST_URL}?version=${VERSION}`]: { body: JSON.stringify(manifest) },
		});

		await fetchRuntimeManifest(CONTROL_PLANE, {
			fetch: fetch.fetch,
			version: VERSION,
			bearer: 'cred',
		});
		await fetchRuntimeManifest(CONTROL_PLANE, { fetch: fetch.fetch });

		expect(fetch.calls[0]).toMatchObject({
			headers: { authorization: 'Bearer cred' },
			redirect: 'error',
		});
		expect(fetch.calls[1].headers).not.toHaveProperty('authorization');
		expect(fetch.calls[1].redirect).toBeUndefined();
	});

	it('says a release lookup needs a credential when the control plane answers 401', async () => {
		const fetch = fakeFetch({ [`${MANIFEST_URL}?version=9.9.9`]: { status: 401, body: '{}' } });
		expect(
			await fetchRuntimeManifest(CONTROL_PLANE, { fetch: fetch.fetch, version: '9.9.9' }),
		).toEqual({ error: expect.stringMatching(/only for an authenticated caller/) });
	});

	it('passes an unavailable manifest through with its reason', async () => {
		const body = { available: false, reason: 'unsigned' };
		const fetch = fakeFetch({ [MANIFEST_URL]: { body: JSON.stringify(body) } });
		expect(await fetchRuntimeManifest(CONTROL_PLANE, { fetch: fetch.fetch })).toEqual(body);
	});

	it.each<[string, Served | undefined, RegExp]>([
		['a 404', undefined, /predates the worker runtime route/],
		['a network error', { throws: new Error('ECONNREFUSED') }, /could not reach .*ECONNREFUSED/],
		['a server error', { status: 500 }, /answered HTTP 500/],
		['a non-JSON body', { body: '<html>' }, /did not answer JSON/],
		[
			'a schema error',
			{ body: JSON.stringify({ available: true }) },
			/did not answer a worker runtime manifest/,
		],
	])('maps %s to its own error', async (_label, served, message) => {
		const fetch = fakeFetch(served ? { [MANIFEST_URL]: served } : {});
		expect(await fetchRuntimeManifest(CONTROL_PLANE, { fetch: fetch.fetch })).toEqual({
			error: expect.stringMatching(message),
		});
	});

	it('refuses a control-plane URL that is not a URL', async () => {
		expect(await fetchRuntimeManifest('not a url', { fetch: fakeFetch({}).fetch })).toEqual({
			error: expect.stringMatching(/not a valid URL/),
		});
	});
});
