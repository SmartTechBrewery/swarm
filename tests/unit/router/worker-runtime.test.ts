import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwarmUser } from '@/identity/schema.js';
import type { Worker } from '@/identity/worker.js';
import type { WorkerBuild } from '@/lib/build-identity.js';
import { registerWorkerRuntime, type WorkerRuntimeDeps } from '@/router/worker-runtime.js';
import {
	parseMinisignTrustedComment,
	WorkerRuntimeManifestSchema,
} from '@/transport/runtime-manifest.js';

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

async function manifest(app: Hono) {
	const res = await app.request('/worker/runtime/manifest');
	expect(res.status).toBe(200);
	expect(res.headers.get('Cache-Control')).toBe('private, no-store');
	return WorkerRuntimeManifestSchema.parse(await res.json());
}

function download(app: Hono, name: string, bearer?: string) {
	return app.request(`/worker/runtime/artifacts/${name}`, {
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
