import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwarmUser } from '@/identity/schema.js';
import type { Worker } from '@/identity/worker.js';
import { ensureRuntime } from '@/launcher/runtime-store.js';
import type { WorkerBuild } from '@/lib/build-identity.js';
import {
	RELEASE_FAILURE_TTL_MS,
	RELEASE_MEMO_LIMIT,
	registerWorkerRuntime,
	resolveReleaseRuntime,
	type WorkerRuntimeDeps,
} from '@/router/worker-runtime.js';
import {
	isRuntimeVersion,
	parseMinisignTrustedComment,
	WorkerRuntimeManifestSchema,
} from '@/transport/runtime-manifest.js';
import {
	buildRuntimeTarball,
	makeMinisignKey,
	signMinisign,
} from '../../helpers/runtime-fixtures.js';

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>();
	return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const VERSION = '1.5.5';
const COMMIT = 'a45f6d97c0ffee00112233445566778899aabbcc';
const NAME = `swarm-worker-runtime-${VERSION}.tar.gz`;
const WORKER_CREDENTIAL = 'worker-credential-should-never-be-reflected';
const OPERATOR_TOKEN = 'operator-session-token';

function minisig(trusted: string): string {
	return [
		'untrusted comment: signature from minisign secret key',
		'RUSomeBase64Signature==',
		`trusted comment: ${trusted}`,
		'SomeGlobalSignature==',
		'',
	].join('\n');
}

let dir: string;
let tarball: Buffer;

/** Lay out the image's `/app/worker-runtime/` with a signed runtime for `VERSION`. */
function writeRuntime(
	opts: { name?: string; checksum?: string | null; signature?: string | null } = {},
): void {
	const name = opts.name ?? NAME;
	writeFileSync(join(dir, name), tarball);
	if (opts.checksum !== null)
		writeFileSync(
			join(dir, `${name}.sha256`),
			`${opts.checksum ?? createHash('sha256').update(tarball).digest('hex')}  ${name}\n`,
		);
	if (opts.signature !== null)
		writeFileSync(
			join(dir, `${name}.minisig`),
			opts.signature ?? minisig(`swarm-worker-runtime ${VERSION} ${COMMIT}`),
		);
}

function makeDeps(overrides: Partial<WorkerRuntimeDeps> = {}): WorkerRuntimeDeps {
	return {
		runtimeDir: dir,
		resolveOwnBuild: vi.fn(
			async (): Promise<WorkerBuild> => ({ commit: COMMIT, dirty: false, version: VERSION }),
		),
		resolveWorkerByCredential: vi.fn(async (credential: string) =>
			credential === WORKER_CREDENTIAL ? ({ id: 'w1' } as Worker) : undefined,
		),
		resolveSession: vi.fn(async (token: string) =>
			token === OPERATOR_TOKEN ? ({ id: 'u1' } as SwarmUser) : undefined,
		),
		...overrides,
	};
}

function buildApp(deps: WorkerRuntimeDeps = makeDeps()): Hono {
	const app = new Hono();
	registerWorkerRuntime(app, deps);
	return app;
}

async function manifest(app: Hono, query = '', bearer?: string) {
	const res = await app.request(`/worker/runtime/manifest${query}`, {
		headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
	});
	expect(res.status).toBe(200);
	expect(res.headers.get('Cache-Control')).toBe('private, no-store');
	return WorkerRuntimeManifestSchema.parse(await res.json());
}

function download(app: Hono, name: string, bearer?: string, method = 'GET') {
	return app.request(`/worker/runtime/artifacts/${name}`, {
		method,
		headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'swarm-worker-runtime-'));
	tarball = randomBytes(4096);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('GET /worker/runtime/manifest (issue #1280)', () => {
	it('names the installation’s own signed runtime, unauthenticated', async () => {
		writeRuntime();

		const body = await manifest(buildApp());

		expect(body).toEqual({
			available: true,
			version: VERSION,
			commit: COMMIT,
			artifact: {
				name: NAME,
				url: `/worker/runtime/artifacts/${NAME}`,
				size: tarball.length,
				sha256: createHash('sha256').update(tarball).digest('hex'),
			},
			signature: {
				format: 'minisign',
				minisig: minisig(`swarm-worker-runtime ${VERSION} ${COMMIT}`),
			},
		});
	});

	it('accepts an abbreviated commit on either side', async () => {
		writeRuntime({ signature: minisig(`swarm-worker-runtime ${VERSION} ${COMMIT.slice(0, 12)}`) });
		expect((await manifest(buildApp())).available).toBe(true);

		const shortBuild = makeDeps({
			resolveOwnBuild: async () => ({ commit: COMMIT.slice(0, 7), dirty: false, version: VERSION }),
		});
		writeRuntime();
		expect((await manifest(buildApp(shortBuild))).available).toBe(true);
	});

	it.each([
		[
			'an installation with no build version',
			() => {},
			{ noVersion: true },
			/declares no build version/,
		],
		['an image with no runtime', () => {}, {}, /carries no worker runtime for v1\.5\.5/],
		[
			'a runtime for another version only',
			() => writeRuntime({ name: 'swarm-worker-runtime-1.5.4.tar.gz' }),
			{},
			/carries no worker runtime for v1\.5\.5/,
		],
		['a missing checksum', () => writeRuntime({ checksum: null }), {}, /has no checksum file/],
		[
			'a checksum mismatch',
			() => writeRuntime({ checksum: '0'.repeat(64) }),
			{},
			/does not match its checksum/,
		],
		['an unsigned runtime', () => writeRuntime({ signature: null }), {}, /is unsigned/],
		[
			'a signature with no trusted comment',
			() => writeRuntime({ signature: 'untrusted comment: x\nabc\n' }),
			{},
			/names no version and commit/,
		],
		[
			'a runtime built from another commit',
			() =>
				writeRuntime({ signature: minisig(`swarm-worker-runtime ${VERSION} ${'b'.repeat(40)}`) }),
			{},
			/was built from v1\.5\.5 b{40}, not this installation's/,
		],
		[
			'a runtime signed for another version',
			() => writeRuntime({ signature: minisig(`swarm-worker-runtime 1.5.4 ${COMMIT}`) }),
			{},
			/was built from v1\.5\.4/,
		],
	])('says so for %s, and the download 404s with the same reason', async (_label, arrange, opts, reason) => {
		arrange();
		const deps = makeDeps(
			'noVersion' in opts
				? { resolveOwnBuild: async () => ({ commit: COMMIT, dirty: false }) }
				: {},
		);
		const app = buildApp(deps);

		const body = await manifest(app);
		expect(body.available).toBe(false);
		if (body.available) return;
		expect(body.reason).toMatch(reason);

		const res = await download(app, NAME, WORKER_CREDENTIAL);
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ reason: body.reason });
	});

	it('resolves the runtime once per process', async () => {
		writeRuntime();
		const deps = makeDeps();
		const app = buildApp(deps);

		await manifest(app);
		await manifest(app);
		await download(app, NAME, WORKER_CREDENTIAL);

		expect(deps.resolveOwnBuild).toHaveBeenCalledTimes(1);
	});
});

describe('GET /worker/runtime/artifacts/:name (issue #1280)', () => {
	beforeEach(() => writeRuntime());

	it.each([
		['a worker credential', WORKER_CREDENTIAL],
		['an operator session token', OPERATOR_TOKEN],
	])('streams the exact bytes to %s', async (_label, bearer) => {
		const res = await download(buildApp(), NAME, bearer);

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/gzip');
		expect(res.headers.get('Content-Length')).toBe(String(tarball.length));
		expect(res.headers.get('Content-Disposition')).toBe(`attachment; filename="${NAME}"`);
		expect(res.headers.get('Cache-Control')).toBe('private, no-store');
		expect(Buffer.from(await res.arrayBuffer()).equals(tarball)).toBe(true);
	});

	it('answers an authenticated HEAD with the download headers and no body, without opening the file', async () => {
		const app = buildApp();
		// Resolving the runtime hashes the tarball once; only the download is counted.
		await manifest(app);
		vi.mocked(createReadStream).mockClear();

		const res = await download(app, NAME, WORKER_CREDENTIAL, 'HEAD');

		expect(res.status).toBe(200);
		expect(res.headers.get('Content-Type')).toBe('application/gzip');
		expect(res.headers.get('Content-Length')).toBe(String(tarball.length));
		expect(res.headers.get('Cache-Control')).toBe('private, no-store');
		expect(res.body).toBeNull();
		expect(createReadStream).not.toHaveBeenCalled();
	});

	it('refuses an unauthenticated HEAD with 401', async () => {
		vi.mocked(createReadStream).mockClear();

		const res = await download(buildApp(), NAME, undefined, 'HEAD');

		expect(res.status).toBe(401);
		expect(createReadStream).not.toHaveBeenCalled();
	});

	it('refuses a request with no bearer', async () => {
		const res = await download(buildApp(), NAME);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ authenticated: false });
		expect(res.headers.get('Cache-Control')).toBe('private, no-store');
	});

	it('refuses an unknown bearer without reflecting it', async () => {
		const res = await download(buildApp(), NAME, 'not-a-real-credential');

		expect(res.status).toBe(401);
		expect(await res.text()).not.toContain('not-a-real-credential');
	});

	it('authenticates before saying anything about availability', async () => {
		rmSync(join(dir, `${NAME}.minisig`));

		const res = await download(buildApp(), NAME);

		expect(res.status).toBe(401);
	});

	it.each([
		'swarm-worker-runtime-1.5.4.tar.gz',
		`${NAME}.sha256`,
		'..%2Fpackage.json',
		'%2E%2E%2F%2E%2E%2Fpackage.json',
	])('404s any name other than the runtime it serves (%s)', async (name) => {
		const res = await download(buildApp(), name, WORKER_CREDENTIAL);

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			reason: `this installation serves only ${NAME} (v${VERSION})`,
		});
	});
});

const OTHER_VERSION = '1.6.0';
const OTHER_COMMIT = 'c0ffee00112233445566778899aabbccddeeff00';
const OTHER_NAME = `swarm-worker-runtime-${OTHER_VERSION}.tar.gz`;
const RELEASE_API = `https://api.github.com/repos/SmartTechBrewery/swarm/releases/tags/v${OTHER_VERSION}`;
const DOWNLOAD = `https://github.com/SmartTechBrewery/swarm/releases/download/v${OTHER_VERSION}`;

interface Served {
	status?: number;
	body?: Buffer | string;
	throws?: Error;
}

/** A fake `fetch` answering exact URLs, recording each request. */
function fakeFetch(routes: Record<string, Served>) {
	const calls: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetch = vi.fn(async (input: URL | string, init?: RequestInit) => {
		const url = input.toString();
		calls.push({ url, headers: { ...(init?.headers as Record<string, string> | undefined) } });
		const route = routes[url];
		if (!route) return new Response('not found', { status: 404 });
		if (route.throws) throw route.throws;
		const body = typeof route.body === 'string' ? route.body : new Uint8Array(route.body ?? []);
		return new Response(body, { status: route.status ?? 200 });
	}) as unknown as typeof globalThis.fetch;
	return { fetch, calls };
}

/** The GitHub API release and its assets for `OTHER_VERSION`, as the publish workflow attaches them. */
function releaseRoutes(
	opts: {
		data?: Buffer;
		signature?: string | null;
		checksum?: string | null;
		tarball?: boolean;
	} = {},
): Record<string, Served> {
	const data = opts.data ?? tarball;
	const assets = [
		...(opts.tarball === false
			? []
			: [
					{
						name: OTHER_NAME,
						size: data.length,
						browser_download_url: `${DOWNLOAD}/${OTHER_NAME}`,
					},
				]),
		...(opts.checksum === null
			? []
			: [
					{
						name: `${OTHER_NAME}.sha256`,
						size: 100,
						browser_download_url: `${DOWNLOAD}/${OTHER_NAME}.sha256`,
					},
				]),
		...(opts.signature === null
			? []
			: [
					{
						name: `${OTHER_NAME}.minisig`,
						size: 300,
						browser_download_url: `${DOWNLOAD}/${OTHER_NAME}.minisig`,
					},
				]),
		{ name: 'unrelated.txt', size: 1, browser_download_url: `${DOWNLOAD}/unrelated.txt` },
	];
	return {
		[RELEASE_API]: { body: JSON.stringify({ tag_name: `v${OTHER_VERSION}`, assets }) },
		[`${DOWNLOAD}/${OTHER_NAME}`]: { body: data },
		[`${DOWNLOAD}/${OTHER_NAME}.sha256`]: {
			body: `${opts.checksum ?? createHash('sha256').update(data).digest('hex')}  ${OTHER_NAME}\n`,
		},
		[`${DOWNLOAD}/${OTHER_NAME}.minisig`]: {
			body: opts.signature ?? minisig(`swarm-worker-runtime ${OTHER_VERSION} ${OTHER_COMMIT}`),
		},
	};
}

describe('GET /worker/runtime/manifest?version= (issue #1282)', () => {
	beforeEach(() => writeRuntime());

	it.each([
		['its own version', `?version=${VERSION}`],
		['its own tag', `?version=v${VERSION}`],
	])('answers the installation’s own runtime for %s, with no GitHub lookup', async (_label, query) => {
		const github = fakeFetch(releaseRoutes());

		const body = await manifest(buildApp(makeDeps({ fetch: github.fetch })), query);

		expect(body).toMatchObject({
			available: true,
			version: VERSION,
			artifact: { url: `/worker/runtime/artifacts/${NAME}` },
		});
		expect(github.calls).toEqual([]);
	});

	it.each([
		'',
		'../x',
		'v',
		'1.0/../../etc',
		'-1.0',
	])('refuses the invalid version %j without any lookup', async (version) => {
		const github = fakeFetch(releaseRoutes());

		const body = await manifest(
			buildApp(makeDeps({ fetch: github.fetch })),
			`?version=${encodeURIComponent(version)}`,
		);

		expect(body).toEqual({
			available: false,
			reason: `${JSON.stringify(version)} is not a valid runtime version`,
		});
		expect(github.calls).toEqual([]);
	});

	it('locates another signed release on the publisher’s GitHub Release', async () => {
		const github = fakeFetch(releaseRoutes());

		const body = await manifest(
			buildApp(makeDeps({ fetch: github.fetch })),
			`?version=v${OTHER_VERSION}`,
			WORKER_CREDENTIAL,
		);

		expect(body).toEqual({
			available: true,
			version: OTHER_VERSION,
			commit: OTHER_COMMIT,
			artifact: {
				name: OTHER_NAME,
				url: `${DOWNLOAD}/${OTHER_NAME}`,
				size: tarball.length,
				sha256: createHash('sha256').update(tarball).digest('hex'),
			},
			signature: {
				format: 'minisign',
				minisig: minisig(`swarm-worker-runtime ${OTHER_VERSION} ${OTHER_COMMIT}`),
			},
		});
		// The tarball itself is located, never downloaded by the control plane.
		expect(github.calls.map((call) => call.url)).toEqual([
			RELEASE_API,
			`${DOWNLOAD}/${OTHER_NAME}.sha256`,
			`${DOWNLOAD}/${OTHER_NAME}.minisig`,
		]);
		expect(github.calls[0].headers.accept).toBe('application/vnd.github+json');
		expect(github.calls[0].headers).not.toHaveProperty('authorization');
	});

	it.each<[string, () => Record<string, Served>, RegExp]>([
		['no such release', () => ({}), /has no published release v1\.6\.0/],
		[
			'the anonymous rate limit',
			() => ({ [RELEASE_API]: { status: 403 } }),
			/HTTP 403.*anonymous GitHub API rate limit/,
		],
		['a GitHub server error', () => ({ [RELEASE_API]: { status: 502 } }), /answered HTTP 502/],
		[
			'a network error',
			() => ({ [RELEASE_API]: { throws: new Error('ETIMEDOUT') } }),
			/could not be looked up on GitHub: ETIMEDOUT/,
		],
		[
			'a release with no runtime',
			() => releaseRoutes({ tarball: false }),
			/carries no worker runtime swarm-worker-runtime-1\.6\.0\.tar\.gz/,
		],
		['a release with no checksum', () => releaseRoutes({ checksum: null }), /has no checksum file/],
		['an unsigned release', () => releaseRoutes({ signature: null }), /is unsigned/],
		[
			'a checksum that names no SHA-256',
			() => releaseRoutes({ checksum: 'not-a-sha' }),
			/does not form a valid manifest: artifact\.sha256/,
		],
		[
			'a signature with no trusted comment',
			() => releaseRoutes({ signature: 'untrusted comment: x\nabc\n' }),
			/names no version and commit/,
		],
		[
			'a signature for another version',
			() => releaseRoutes({ signature: minisig(`swarm-worker-runtime 1.5.9 ${OTHER_COMMIT}`) }),
			/is signed as v1\.5\.9, not v1\.6\.0/,
		],
		[
			'an oversized signature',
			() => releaseRoutes({ signature: 'x'.repeat(64 * 1024) }),
			/is larger than/,
		],
	])('says so for %s', async (_label, routes, reason) => {
		const body = await manifest(
			buildApp(makeDeps({ fetch: fakeFetch(routes()).fetch })),
			`?version=${OTHER_VERSION}`,
			WORKER_CREDENTIAL,
		);

		expect(body.available).toBe(false);
		if (body.available) return;
		expect(body.reason).toMatch(reason);
	});

	it('still serves only its own artifact', async () => {
		const app = buildApp(makeDeps({ fetch: fakeFetch(releaseRoutes()).fetch }));
		await manifest(app, `?version=${OTHER_VERSION}`, WORKER_CREDENTIAL);

		const res = await download(app, OTHER_NAME, WORKER_CREDENTIAL);

		expect(res.status).toBe(404);
	});

	it('remembers a located release, and one that was not found only for a while', async () => {
		let clock = 1_000_000;
		const routes: Record<string, Served> = {};
		const github = fakeFetch(routes);
		const app = buildApp(makeDeps({ fetch: github.fetch, now: () => clock }));
		const ask = (query: string, bearer?: string) => manifest(app, query, bearer);

		expect((await ask(`?version=${OTHER_VERSION}`, WORKER_CREDENTIAL)).available).toBe(false);
		Object.assign(routes, releaseRoutes());
		// Within the window the failure is answered again, to anyone, without GitHub.
		clock += RELEASE_FAILURE_TTL_MS - 1;
		expect((await ask(`?version=${OTHER_VERSION}`, WORKER_CREDENTIAL)).available).toBe(false);
		expect((await ask(`?version=${OTHER_VERSION}`)).available).toBe(false);
		expect(github.calls.map((call) => call.url)).toEqual([RELEASE_API]);

		clock += 1;
		expect((await ask(`?version=${OTHER_VERSION}`, WORKER_CREDENTIAL)).available).toBe(true);
		const lookups = github.calls.length;
		clock += 10 * RELEASE_FAILURE_TTL_MS;
		// A located release is remembered for good, and answered open.
		expect((await ask(`?version=v${OTHER_VERSION}`)).available).toBe(true);

		expect(github.calls.length).toBe(lookups);
	});

	it('answers an unauthenticated lookup it has not made with 401, without GitHub', async () => {
		const github = fakeFetch(releaseRoutes());
		const app = buildApp(makeDeps({ fetch: github.fetch }));

		for (const headers of [{}, { Authorization: 'Bearer not-a-credential' }] as Array<
			Record<string, string>
		>) {
			const res = await app.request(`/worker/runtime/manifest?version=${OTHER_VERSION}`, {
				headers,
			});
			expect(res.status).toBe(401);
			expect(res.headers.get('Cache-Control')).toBe('private, no-store');
			expect(await res.json()).toMatchObject({ authenticated: false });
		}
		expect(github.calls).toEqual([]);
		// The no-version and own-version manifests stay open.
		expect((await manifest(app)).available).toBe(true);
		expect((await manifest(app, `?version=${VERSION}`)).available).toBe(true);
	});

	it('looks up a release for an operator session token too', async () => {
		const body = await manifest(
			buildApp(makeDeps({ fetch: fakeFetch(releaseRoutes()).fetch })),
			`?version=${OTHER_VERSION}`,
			OPERATOR_TOKEN,
		);

		expect(body.available).toBe(true);
	});

	it(`remembers at most ${RELEASE_MEMO_LIMIT} releases, forgetting the oldest`, async () => {
		// Every `9.0.<n>` is a signed release, so each lookup is remembered.
		const looked: string[] = [];
		const github = vi.fn(async (input: URL | string) => {
			const url = input.toString();
			const version = /\/v?(9\.0\.\d+)/.exec(url)?.[1] ?? '';
			const name = `swarm-worker-runtime-${version}.tar.gz`;
			const base = `https://example.test/v${version}/${name}`;
			if (url.startsWith('https://api.github.com/')) {
				looked.push(version);
				return Response.json({
					assets: [
						{ name, size: 1, browser_download_url: base },
						{ name: `${name}.sha256`, size: 1, browser_download_url: `${base}.sha256` },
						{ name: `${name}.minisig`, size: 1, browser_download_url: `${base}.minisig` },
					],
				});
			}
			if (url.endsWith('.sha256')) return new Response('a'.repeat(64));
			return new Response(minisig(`swarm-worker-runtime ${version} ${OTHER_COMMIT}`));
		}) as unknown as typeof globalThis.fetch;
		const app = buildApp(makeDeps({ fetch: github }));

		for (let i = 0; i <= RELEASE_MEMO_LIMIT; i++)
			expect((await manifest(app, `?version=9.0.${i}`, WORKER_CREDENTIAL)).available).toBe(true);
		await manifest(app, `?version=9.0.${RELEASE_MEMO_LIMIT}`, WORKER_CREDENTIAL);
		await manifest(app, '?version=9.0.0', WORKER_CREDENTIAL);

		expect(looked).toEqual([
			...Array.from({ length: RELEASE_MEMO_LIMIT + 1 }, (_, i) => `9.0.${i}`),
			'9.0.0',
		]);
	});
});

describe('resolveReleaseRuntime → ensureRuntime (issue #1282)', () => {
	it('installs another signed release from its absolute URL, sending no credential', async () => {
		const key = makeMinisignKey();
		const data = buildRuntimeTarball(OTHER_VERSION, OTHER_COMMIT);
		const github = fakeFetch(
			releaseRoutes({
				data,
				signature: signMinisign(key, data, `swarm-worker-runtime ${OTHER_VERSION} ${OTHER_COMMIT}`),
			}),
		);
		const located = await resolveReleaseRuntime(OTHER_VERSION, { fetch: github.fetch });
		expect(located.available).toBe(true);
		if (!located.available) return;
		const home = mkdtempSync(join(tmpdir(), 'swarm-release-install-'));
		try {
			const installed = await ensureRuntime({
				controlPlaneUrl: 'https://swarm.example.com',
				manifest: located.manifest,
				bearer: WORKER_CREDENTIAL,
				trustedPublicKey: key.publicKey,
				homeDir: home,
				fetch: github.fetch,
			});

			expect(installed).toMatchObject({ version: OTHER_VERSION, installed: true });
			const tarballRequest = github.calls.find((call) => call.url === `${DOWNLOAD}/${OTHER_NAME}`);
			expect(tarballRequest?.headers).toEqual({});
		} finally {
			execFileSync('chmod', ['-R', 'u+w', home]);
			rmSync(home, { recursive: true, force: true });
		}
	});

	it('is refused by a worker that trusts another key', async () => {
		const data = buildRuntimeTarball(OTHER_VERSION, OTHER_COMMIT);
		const github = fakeFetch(
			releaseRoutes({
				data,
				signature: signMinisign(
					makeMinisignKey(),
					data,
					`swarm-worker-runtime ${OTHER_VERSION} ${OTHER_COMMIT}`,
				),
			}),
		);
		const located = await resolveReleaseRuntime(OTHER_VERSION, { fetch: github.fetch });
		if (!located.available) throw new Error(located.reason);
		const home = mkdtempSync(join(tmpdir(), 'swarm-release-install-'));
		try {
			expect(
				await ensureRuntime({
					controlPlaneUrl: 'https://swarm.example.com',
					manifest: located.manifest,
					trustedPublicKey: makeMinisignKey().publicKey,
					homeDir: home,
					fetch: github.fetch,
				}),
			).toEqual({ error: expect.stringMatching(/signature is refused/) });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe('isRuntimeVersion', () => {
	it.each(['1.2.3', '1.2.3-rc.1', '1.2.3+build.5'])('accepts %s', (version) => {
		expect(isRuntimeVersion(version)).toBe(true);
	});

	it.each(['', '../1', '1/2', '.1', '-1', 'a'.repeat(101)])('refuses %j', (version) => {
		expect(isRuntimeVersion(version)).toBe(false);
	});
});

describe('parseMinisignTrustedComment', () => {
	it('reads the version and commit', () => {
		expect(
			parseMinisignTrustedComment(minisig(`swarm-worker-runtime ${VERSION} ${COMMIT}`)),
		).toEqual({ version: VERSION, commit: COMMIT });
	});

	it.each([
		['no trusted comment', 'untrusted comment: x\nabc\n'],
		['another prefix', minisig(`something-else ${VERSION} ${COMMIT}`)],
		['a non-hex commit', minisig(`swarm-worker-runtime ${VERSION} not-a-commit`)],
	])('answers undefined for %s', (_label, text) => {
		expect(parseMinisignTrustedComment(text)).toBeUndefined();
	});
});
