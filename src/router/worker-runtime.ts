/**
 * The installation serves the **worker runtime for its own build** (issue #1280):
 * the manifest naming it and the artifact itself, so a worker host updates from
 * the control plane it is registered with and needs no GitHub access at all.
 *
 * The files are the ones the published image carries at `/app/worker-runtime/`
 * (issue #1290): `swarm-worker-runtime-<version>.tar.gz`, its `.sha256` and its
 * `.minisig`. The wire contract and the access policy are documented on
 * `../transport/runtime-manifest.ts`.
 *
 * **Only the installation's own runtime is served, and only a signed one.** The
 * runtime is available when this process declares a version and a commit, the
 * tarball for *that* version is present, its `.sha256` matches its bytes, a
 * `.minisig` is present, and that signature's trusted comment names this version
 * and this commit. Anything else (an image built before #1290, a plain
 * `docker build`, an unsigned `main` build, a dev checkout's locally built
 * tarball, a tarball for some other version) is answered with `available: false`
 * and the specific reason, never by serving something else. The signature itself
 * is checked by the worker, against the key it trusts.
 *
 * The answer is resolved on the first request and memoized for the process's life:
 * the files are part of the image, the same reasoning as `resolveOwnBuildIdentity`.
 * A restart picks up changed files.
 *
 * Both routes send `Cache-Control: private, no-store`. Cloudflare caches `.gz` by
 * extension by default, and a cached copy of the authenticated download would be
 * served without the bearer check, while a cached manifest would outlive a deploy.
 *
 * Mirrors `./operator-session.ts`: the request logic is factored into pure,
 * injectable functions (`resolveOwnRuntime`, `handleRuntimeManifest`,
 * `handleRuntimeArtifact`) so tests drive them with fake deps.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';

import { resolveSession } from '../identity/auth.js';
import type { SwarmUser } from '../identity/schema.js';
import type { Worker } from '../identity/worker.js';
import { resolveWorkerByCredential } from '../identity/worker-service.js';
import {
	resolveOwnBuildIdentity,
	swarmInstallRoot,
	type WorkerBuild,
} from '../lib/build-identity.js';
import { logger } from '../lib/logger.js';
import {
	type AvailableWorkerRuntimeManifest,
	parseMinisignTrustedComment,
	runtimeArtifactName,
	WORKER_RUNTIME_ARTIFACTS_PATH,
	WORKER_RUNTIME_MANIFEST_PATH,
} from '../transport/runtime-manifest.js';
import { resolveOperatorBearer } from './operator-session.js';

/** Collaborators, defaulted to the real ones; tests override them. */
export interface WorkerRuntimeDeps {
	/** The directory holding the runtime files (`<installRoot>/worker-runtime`). */
	runtimeDir: string;
	resolveOwnBuild: () => Promise<WorkerBuild | undefined>;
	resolveWorkerByCredential: (rawCredential: string) => Promise<Worker | undefined>;
	resolveSession: (rawToken: string) => Promise<SwarmUser | undefined>;
}

function defaultDeps(): WorkerRuntimeDeps {
	return {
		runtimeDir: join(swarmInstallRoot(), 'worker-runtime'),
		resolveOwnBuild: resolveOwnBuildIdentity,
		resolveWorkerByCredential,
		resolveSession,
	};
}

/** What this installation can serve: its own runtime, or the reason it cannot. */
export type OwnRuntime =
	| { available: true; path: string; manifest: AvailableWorkerRuntimeManifest }
	| { available: false; reason: string };

function unavailable(reason: string): OwnRuntime {
	return { available: false, reason };
}

/** A file's text, or `undefined` when it does not exist. Other errors throw. */
async function readTextIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw err;
	}
}

async function sha256File(path: string): Promise<string> {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest('hex');
}

function commitsMatch(a: string, b: string): boolean {
	const x = a.toLowerCase();
	const y = b.toLowerCase();
	return x.startsWith(y) || y.startsWith(x);
}

/**
 * Locate and check this installation's own runtime. Never throws: an I/O error is
 * an unavailable runtime with the error as its reason.
 */
export async function resolveOwnRuntime(deps: WorkerRuntimeDeps): Promise<OwnRuntime> {
	const build = await deps.resolveOwnBuild();
	if (!build?.version)
		return unavailable(
			'this installation declares no build version, so it cannot name its own worker runtime',
		);
	const { version, commit } = build;
	const name = runtimeArtifactName(version);
	const path = join(deps.runtimeDir, name);

	try {
		const info = await stat(path).catch((err: NodeJS.ErrnoException) => {
			if (err.code === 'ENOENT') return undefined;
			throw err;
		});
		if (!info?.isFile())
			return unavailable(
				`this installation's image carries no worker runtime for v${version} ` +
					'(an image built before the runtime was published, a plain `docker build`, or a dev checkout)',
			);

		const checksumFile = await readTextIfPresent(`${path}.sha256`);
		const expected = checksumFile?.trim().split(/\s+/)[0]?.toLowerCase();
		if (!expected) return unavailable(`the worker runtime ${name} has no checksum file`);
		const sha256 = await sha256File(path);
		if (sha256 !== expected)
			return unavailable(`the worker runtime ${name} does not match its checksum`);

		const minisig = await readTextIfPresent(`${path}.minisig`);
		if (!minisig?.trim())
			return unavailable(
				`the worker runtime ${name} is unsigned (built without the signing key) and is not served`,
			);
		const signed = parseMinisignTrustedComment(minisig);
		if (!signed)
			return unavailable(
				`the worker runtime ${name}'s signature names no version and commit in its trusted comment`,
			);
		if (signed.version !== version || !commitsMatch(signed.commit, commit))
			return unavailable(
				`the worker runtime ${name} was built from v${signed.version} ${signed.commit}, ` +
					`not this installation's v${version} ${commit}`,
			);

		return {
			available: true,
			path,
			manifest: {
				available: true,
				version,
				commit,
				artifact: {
					name,
					url: `${WORKER_RUNTIME_ARTIFACTS_PATH}/${name}`,
					size: info.size,
					sha256,
				},
				signature: { format: 'minisign', minisig },
			},
		};
	} catch (err) {
		return unavailable(
			`the worker runtime ${name} could not be read: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** The manifest body for a resolved runtime. Always 200: a 404 means "no such route". */
export function handleRuntimeManifest(runtime: OwnRuntime): {
	status: 200;
	json: Record<string, unknown>;
} {
	return {
		status: 200,
		json: runtime.available ? runtime.manifest : { available: false, reason: runtime.reason },
	};
}

/** An artifact request's outcome: refused, not served, or the file to stream. */
export type RuntimeArtifactResult =
	| { status: 401 | 404; json: Record<string, unknown> }
	| { status: 200; path: string; size: number; name: string };

/**
 * Authenticate, then serve `name` when it is exactly this installation's runtime.
 *
 * Authentication runs first, so an anonymous caller learns nothing here beyond what
 * the manifest already says. A worker credential or an operator session token is
 * accepted; a rejected one is never reflected. The name is compared, never joined
 * into a path, so nothing outside the resolved runtime can be reached.
 */
export async function handleRuntimeArtifact(
	deps: WorkerRuntimeDeps,
	getRuntime: () => Promise<OwnRuntime>,
	bearer: string | undefined,
	name: string,
): Promise<RuntimeArtifactResult> {
	const authenticated =
		bearer !== undefined &&
		((await deps.resolveWorkerByCredential(bearer)) !== undefined ||
			(await deps.resolveSession(bearer)) !== undefined);
	if (!authenticated) return { status: 401, json: { authenticated: false } };

	const runtime = await getRuntime();
	if (!runtime.available) return { status: 404, json: { reason: runtime.reason } };
	const { artifact } = runtime.manifest;
	if (name !== artifact.name)
		return {
			status: 404,
			json: {
				reason: `this installation serves only ${artifact.name} (v${runtime.manifest.version})`,
			},
		};
	return { status: 200, path: runtime.path, size: artifact.size, name: artifact.name };
}

const NO_STORE = { 'Cache-Control': 'private, no-store' } as const;

/**
 * Mount the manifest and artifact routes on the router's `app`. Pass `overrides` to
 * substitute collaborators in tests; omit for production wiring.
 */
export function registerWorkerRuntime(app: Hono, overrides: Partial<WorkerRuntimeDeps> = {}): void {
	const deps = { ...defaultDeps(), ...overrides };

	let runtime: Promise<OwnRuntime> | undefined;
	const getRuntime = (): Promise<OwnRuntime> => {
		runtime ??= resolveOwnRuntime(deps).then((resolved) => {
			if (resolved.available)
				logger.info('Serving the worker runtime for this installation', {
					version: resolved.manifest.version,
					artifact: resolved.manifest.artifact.name,
				});
			else logger.warn('Not serving a worker runtime', { reason: resolved.reason });
			return resolved;
		});
		return runtime;
	};

	app.get(WORKER_RUNTIME_MANIFEST_PATH, async (c) => {
		const result = handleRuntimeManifest(await getRuntime());
		return c.json(result.json, result.status, NO_STORE);
	});

	app.get(`${WORKER_RUNTIME_ARTIFACTS_PATH}/:name`, async (c) => {
		const result = await handleRuntimeArtifact(
			deps,
			getRuntime,
			resolveOperatorBearer(c),
			c.req.param('name'),
		);
		if (result.status !== 200) return c.json(result.json, result.status, NO_STORE);
		const headers = {
			...NO_STORE,
			'Content-Type': 'application/gzip',
			'Content-Length': String(result.size),
			'Content-Disposition': `attachment; filename="${result.name}"`,
		};
		// Hono answers HEAD by running this GET handler and discarding the body
		// without cancelling it, so a stream opened here would hold its fd forever.
		if (c.req.method === 'HEAD') return c.body(null, 200, headers);
		const file = createReadStream(result.path);
		// A client that disconnects mid-download must not leave the fd open either.
		c.req.raw.signal.addEventListener('abort', () => file.destroy(), { once: true });
		return c.body(Readable.toWeb(file) as ReadableStream, 200, headers);
	});
}
