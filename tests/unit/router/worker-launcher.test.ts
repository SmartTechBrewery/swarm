import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerBuild } from '@/lib/build-identity.js';
import {
	handleLauncherArtifact,
	registerWorkerLauncher,
	resolveOwnLauncher,
	type WorkerLauncherDeps,
} from '@/router/worker-launcher.js';
import { WorkerLauncherManifestSchema } from '@/transport/runtime-manifest.js';

const VERSION = '1.5.5';
const COMMIT = 'a45f6d97c0ffee00112233445566778899aabbcc';
const FILE = `swarm-worker-launcher-${VERSION}.tar.gz`;

let dir: string;
let tarball: Buffer;

function sha256(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** Lay out the image's `/app/worker-runtime/` with the launcher for `VERSION`. */
function writeLauncher(opts: { file?: string; checksum?: string | null } = {}): void {
	const file = opts.file ?? FILE;
	writeFileSync(join(dir, file), tarball);
	if (opts.checksum !== null)
		writeFileSync(join(dir, `${file}.sha256`), `${opts.checksum ?? sha256(tarball)}  ${file}\n`);
}

function makeDeps(overrides: Partial<WorkerLauncherDeps> = {}): WorkerLauncherDeps {
	return {
		launcherDir: dir,
		resolveOwnBuild: vi.fn(
			async (): Promise<WorkerBuild> => ({ commit: COMMIT, dirty: false, version: VERSION }),
		),
		...overrides,
	};
}

function appWith(deps: WorkerLauncherDeps): Hono {
	const app = new Hono();
	registerWorkerLauncher(app, deps);
	return app;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'swarm-worker-launcher-route-'));
	tarball = randomBytes(4096);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('resolveOwnLauncher', () => {
	it("is available for the installation's own package with a matching checksum", async () => {
		writeLauncher();
		const launcher = await resolveOwnLauncher(makeDeps());
		expect(launcher).toEqual({
			available: true,
			path: join(dir, FILE),
			manifest: {
				available: true,
				version: VERSION,
				file: FILE,
				size: tarball.length,
				sha256: sha256(tarball),
			},
		});
		if (launcher.available)
			expect(WorkerLauncherManifestSchema.parse(launcher.manifest)).toEqual(launcher.manifest);
	});

	it('is unavailable when the package is missing', async () => {
		const launcher = await resolveOwnLauncher(makeDeps());
		expect(launcher).toEqual({
			available: false,
			reason: expect.stringContaining(`carries no worker launcher for v${VERSION}`),
		});
	});

	it('is unavailable when the checksum file is missing', async () => {
		writeLauncher({ checksum: null });
		expect(await resolveOwnLauncher(makeDeps())).toEqual({
			available: false,
			reason: `the worker launcher ${FILE} has no checksum file`,
		});
	});

	it('is unavailable when the checksum does not match', async () => {
		writeLauncher({ checksum: 'f'.repeat(64) });
		expect(await resolveOwnLauncher(makeDeps())).toEqual({
			available: false,
			reason: `the worker launcher ${FILE} does not match its checksum`,
		});
	});

	it('never serves a package for another version', async () => {
		writeLauncher({ file: 'swarm-worker-launcher-1.4.0.tar.gz' });
		expect(await resolveOwnLauncher(makeDeps())).toMatchObject({
			available: false,
			reason: expect.stringContaining(`no worker launcher for v${VERSION}`),
		});
	});

	it('is unavailable when the installation declares no version', async () => {
		writeLauncher();
		const launcher = await resolveOwnLauncher(
			makeDeps({ resolveOwnBuild: async () => ({ commit: COMMIT, dirty: false }) }),
		);
		expect(launcher).toMatchObject({
			available: false,
			reason: expect.stringContaining('declares no build version'),
		});
	});
});

describe('handleLauncherArtifact', () => {
	it('refuses any name other than the exact package, path traversal included', async () => {
		writeLauncher();
		const launcher = await resolveOwnLauncher(makeDeps());
		const get = async () => launcher;
		for (const name of [
			'swarm-worker-launcher-1.4.0.tar.gz',
			`${FILE}.sha256`,
			`../${FILE}`,
			`..%2F${FILE}`,
			'../../etc/passwd',
		])
			expect(await handleLauncherArtifact(get, name)).toEqual({
				status: 404,
				json: { reason: `this installation serves only ${FILE} (v${VERSION})` },
			});
		expect(await handleLauncherArtifact(get, FILE)).toEqual({
			status: 200,
			path: join(dir, FILE),
			size: tarball.length,
			file: FILE,
		});
	});
});

describe('registerWorkerLauncher', () => {
	it('serves the manifest and the package, publicly and never cached', async () => {
		writeLauncher();
		const app = appWith(makeDeps());

		const manifest = await app.request('/worker/launcher/manifest');
		expect(manifest.status).toBe(200);
		expect(manifest.headers.get('cache-control')).toBe('private, no-store');
		expect(await manifest.json()).toEqual({
			available: true,
			version: VERSION,
			file: FILE,
			size: tarball.length,
			sha256: sha256(tarball),
		});

		const artifact = await app.request(`/worker/launcher/artifacts/${FILE}`);
		expect(artifact.status).toBe(200);
		expect(artifact.headers.get('cache-control')).toBe('private, no-store');
		expect(artifact.headers.get('content-type')).toBe('application/gzip');
		expect(artifact.headers.get('content-length')).toBe(String(tarball.length));
		expect(Buffer.from(await artifact.arrayBuffer()).equals(tarball)).toBe(true);
	});

	it('answers an unavailable manifest with 200 and the reason, and 404s the download', async () => {
		const app = appWith(makeDeps());
		const manifest = await app.request('/worker/launcher/manifest');
		expect(manifest.status).toBe(200);
		expect(manifest.headers.get('cache-control')).toBe('private, no-store');
		const body = WorkerLauncherManifestSchema.parse(await manifest.json());
		expect(body.available).toBe(false);

		const artifact = await app.request(`/worker/launcher/artifacts/${FILE}`);
		expect(artifact.status).toBe(404);
		expect(artifact.headers.get('cache-control')).toBe('private, no-store');
	});

	it('refuses another file and a traversal on the route', async () => {
		writeLauncher();
		writeFileSync(join(dir, 'secret.txt'), 'nope');
		const app = appWith(makeDeps());
		for (const path of [
			'/worker/launcher/artifacts/secret.txt',
			`/worker/launcher/artifacts/${FILE}.sha256`,
			'/worker/launcher/artifacts/..%2Fsecret.txt',
		]) {
			const res = await app.request(path);
			expect(res.status, path).toBe(404);
			expect(res.headers.get('cache-control')).toBe('private, no-store');
		}
	});

	it('resolves the package once per process', async () => {
		writeLauncher();
		const deps = makeDeps();
		const app = appWith(deps);
		await app.request('/worker/launcher/manifest');
		await app.request('/worker/launcher/manifest');
		await app.request(`/worker/launcher/artifacts/${FILE}`, { method: 'HEAD' });
		expect(deps.resolveOwnBuild).toHaveBeenCalledTimes(1);
	});
});
