/**
 * The installation serves the **clone-free worker launcher for its own build**
 * (issue #1312): the manifest naming it and the package itself, so `install.sh`
 * (`./install-script.ts`) sets a new host up from the control plane it is about to
 * register with, and nothing is downloaded from GitHub.
 *
 * The files are the ones the published image carries at `/app/worker-runtime/`
 * (issue #1283): `swarm-worker-launcher-<version>.tar.gz` and its `.sha256`. The
 * wire contract is documented on `../transport/runtime-manifest.ts`.
 *
 * **Only the installation's own launcher is served.** It is available when this
 * process declares a version, the package for *that* version is present and its
 * `.sha256` matches its bytes. Anything else (an image built before #1283, a plain
 * `docker build`, a package for some other version) is answered with
 * `available: false` and the specific reason, never by serving something else.
 *
 * **Both routes are public**, unlike the runtime's artifact route: the installer
 * holds no credential yet, and the package holds nothing secret (the launcher and
 * the publisher's public key). Both still send `Cache-Control: private, no-store`,
 * for the reason `./worker-runtime.ts` gives: Cloudflare caches `.gz` by extension,
 * and a cached copy would outlive a deploy.
 *
 * The answer is resolved on the first request and memoized for the process's
 * life, as the runtime's is: the files are part of the image. A restart picks up
 * changed files.
 *
 * Mirrors `./worker-runtime.ts`: the request logic is factored into pure,
 * injectable functions (`resolveOwnLauncher`, `handleLauncherManifest`,
 * `handleLauncherArtifact`) so tests drive them with fake deps.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';

import {
	resolveOwnBuildIdentity,
	swarmInstallRoot,
	type WorkerBuild,
} from '../lib/build-identity.js';
import { logger } from '../lib/logger.js';
import {
	type AvailableWorkerLauncherManifest,
	isRuntimeVersion,
	launcherArtifactName,
	WORKER_LAUNCHER_ARTIFACTS_PATH,
	WORKER_LAUNCHER_MANIFEST_PATH,
} from '../transport/runtime-manifest.js';

/** Collaborators, defaulted to the real ones; tests override them. */
export interface WorkerLauncherDeps {
	/** The directory holding the launcher files (`<installRoot>/worker-runtime`). */
	launcherDir: string;
	resolveOwnBuild: () => Promise<WorkerBuild | undefined>;
}

function defaultDeps(): WorkerLauncherDeps {
	return {
		launcherDir: join(swarmInstallRoot(), 'worker-runtime'),
		resolveOwnBuild: resolveOwnBuildIdentity,
	};
}

/** What this installation can serve: its own launcher, or the reason it cannot. */
export type OwnLauncher =
	| { available: true; path: string; manifest: AvailableWorkerLauncherManifest }
	| { available: false; reason: string };

function unavailable(reason: string): OwnLauncher {
	return { available: false, reason };
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest('hex');
}

/**
 * Locate and check this installation's own launcher package. Never throws: an I/O
 * error is an unavailable launcher with the error as its reason.
 */
export async function resolveOwnLauncher(deps: WorkerLauncherDeps): Promise<OwnLauncher> {
	const build = await deps.resolveOwnBuild();
	if (!build?.version)
		return unavailable(
			'this installation declares no build version, so it cannot name its own worker launcher',
		);
	const { version } = build;
	// The version becomes the file name the installer downloads.
	if (!isRuntimeVersion(version))
		return unavailable(`this installation's version ${JSON.stringify(version)} cannot name a file`);
	const file = launcherArtifactName(version);
	const path = join(deps.launcherDir, file);

	try {
		const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
			if (err.code === 'ENOENT') return undefined;
			throw err;
		});
		if (!info?.isFile())
			return unavailable(
				`this installation's image carries no worker launcher for v${version} ` +
					'(an image built before the launcher was published, a plain `docker build`, or a dev checkout)',
			);

		const checksumFile = await readFile(`${path}.sha256`, 'utf8').catch(
			(err: NodeJS.ErrnoException) => {
				if (err.code === 'ENOENT') return undefined;
				throw err;
			},
		);
		const expected = checksumFile?.trim().split(/\s+/)[0]?.toLowerCase();
		if (!expected) return unavailable(`the worker launcher ${file} has no checksum file`);
		const sha256 = await sha256File(path);
		if (sha256 !== expected)
			return unavailable(`the worker launcher ${file} does not match its checksum`);

		return {
			available: true,
			path,
			manifest: { available: true, version, file, size: info.size, sha256 },
		};
	} catch (err) {
		return unavailable(
			`the worker launcher ${file} could not be read: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** The manifest body for a resolved launcher. Always 200: a 404 means "no such route". */
export function handleLauncherManifest(launcher: OwnLauncher): {
	status: 200;
	json: Record<string, unknown>;
} {
	return {
		status: 200,
		json: launcher.available ? launcher.manifest : { available: false, reason: launcher.reason },
	};
}

/** An artifact request's outcome: not served, or the file to stream. */
export type LauncherArtifactResult =
	| { status: 404; json: Record<string, unknown> }
	| { status: 200; path: string; size: number; file: string };

/**
 * Serve `file` when it is exactly this installation's launcher package. The name is
 * compared, never joined into a path, so nothing else can be reached.
 */
export async function handleLauncherArtifact(
	getLauncher: () => Promise<OwnLauncher>,
	file: string,
): Promise<LauncherArtifactResult> {
	const launcher = await getLauncher();
	if (!launcher.available) return { status: 404, json: { reason: launcher.reason } };
	const { manifest } = launcher;
	if (file !== manifest.file)
		return {
			status: 404,
			json: { reason: `this installation serves only ${manifest.file} (v${manifest.version})` },
		};
	return { status: 200, path: launcher.path, size: manifest.size, file: manifest.file };
}

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * Mount the launcher's manifest and artifact routes on the router's `app`. Pass
 * `overrides` to substitute collaborators in tests; omit for production wiring.
 */
export function registerWorkerLauncher(
	app: Hono,
	overrides: Partial<WorkerLauncherDeps> = {},
): void {
	const deps = { ...defaultDeps(), ...overrides };

	let launcher: Promise<OwnLauncher> | undefined;
	const getLauncher = (): Promise<OwnLauncher> => {
		launcher ??= resolveOwnLauncher(deps).then((resolved) => {
			if (resolved.available)
				logger.info('Serving the worker launcher for this installation', {
					version: resolved.manifest.version,
					file: resolved.manifest.file,
				});
			else logger.warn('Not serving a worker launcher', { reason: resolved.reason });
			return resolved;
		});
		return launcher;
	};

	app.get(WORKER_LAUNCHER_MANIFEST_PATH, async (c) => {
		const result = handleLauncherManifest(await getLauncher());
		return c.json(result.json, result.status, NO_STORE);
	});

	app.get(`${WORKER_LAUNCHER_ARTIFACTS_PATH}/:file`, async (c) => {
		const result = await handleLauncherArtifact(getLauncher, c.req.param('file'));
		if (result.status !== 200) return c.json(result.json, result.status, NO_STORE);
		const headers = {
			...NO_STORE,
			'Content-Type': 'application/gzip',
			'Content-Length': String(result.size),
			'Content-Disposition': `attachment; filename="${result.file}"`,
		};
		// As on the runtime route: HEAD must not open a stream nobody reads.
		if (c.req.method === 'HEAD') return c.body(null, 200, headers);
		const stream = createReadStream(result.path);
		c.req.raw.signal.addEventListener('abort', () => stream.destroy(), { once: true });
		return c.body(Readable.toWeb(stream) as ReadableStream, 200, headers);
	});
}
