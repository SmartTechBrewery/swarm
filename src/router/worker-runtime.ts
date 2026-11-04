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
 * **Only the installation's own runtime is *served*, and only a signed one.** The
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
 * **Another signed release is only *located* (issue #1282).** A manifest request
 * naming `?version=<v>` other than the installation's own is answered from the
 * publisher's GitHub Release `v<v>` (`resolveReleaseRuntime`): an absolute artifact
 * URL on that release, its size, the SHA-256 from its `.sha256` and the whole
 * `.minisig`, with the commit read from the signature's trusted comment. Nothing of
 * that release is downloaded or served here, and the artifact route still serves
 * only the installation's own tarball. The same plausibility checks apply (a
 * checksum, a signature, a trusted comment naming the version), and trust stays
 * with the worker, which installs only bytes its own key verifies. A located
 * release is memoized per version, since a published release is immutable; a
 * failure is remembered for {@link RELEASE_FAILURE_TTL_MS} only, so a release
 * published after the first ask is found once that expires.
 *
 * **Only an authenticated caller reaches GitHub.** The lookup is anonymous, so it
 * spends the control plane's per-IP unauthenticated GitHub API budget (60 an hour).
 * A `?version=` that is not already remembered therefore needs the same bearer as
 * the artifact route (a worker credential or an operator session token) and is
 * answered `401` without one; a remembered answer, the installation's own version
 * and the no-version manifest stay open. Otherwise anyone who can reach the
 * control plane could walk unknown versions and leave every worker unable to look
 * up a real release until GitHub's window resets.
 *
 * Both routes send `Cache-Control: private, no-store`. Cloudflare caches `.gz` by
 * extension by default, and a cached copy of the authenticated download would be
 * served without the bearer check, while a cached manifest would outlive a deploy.
 *
 * Mirrors `./operator-session.ts`: the request logic is factored into pure,
 * injectable functions (`resolveOwnRuntime`, `resolveReleaseRuntime`,
 * `handleRuntimeManifest`, `handleRuntimeArtifact`) so tests drive them with fake
 * deps.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { z } from 'zod';

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
	AvailableWorkerRuntimeManifestSchema,
	isRuntimeVersion,
	PUBLISHER_RELEASES_REPOSITORY,
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
	/** Reaches the publisher's GitHub Releases for another version's manifest. */
	fetch?: typeof globalThis.fetch;
	/** The clock a remembered failed lookup expires by. */
	now?: () => number;
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

/** Another signed release, located on the publisher's GitHub Release, or why it is not. */
export type ReleaseRuntime =
	| { available: true; manifest: AvailableWorkerRuntimeManifest }
	| { available: false; reason: string };

/** Bounds every request to GitHub, so a slow one cannot hold a manifest request open. */
const RELEASE_FETCH_TIMEOUT_MS = 10_000;

/** A `.sha256` or `.minisig` is a line or four; anything bigger is not one. */
const RELEASE_SIDECAR_MAX_BYTES = 16 * 1024;

const GITHUB_API = 'https://api.github.com';

const ReleaseAssetSchema = z.object({
	name: z.string(),
	size: z.number().int().nonnegative(),
	browser_download_url: z.string().url(),
});
const ReleaseSchema = z.object({ assets: z.array(z.unknown()) });

/** A response body's text, refusing one longer than `limit` bytes. */
async function readTextCapped(response: Response, limit: number): Promise<string | undefined> {
	const declared = response.headers.get('content-length');
	if (declared !== null && Number(declared) > limit) return undefined;
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			return undefined;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString('utf8');
}

type ReleaseAsset = z.infer<typeof ReleaseAssetSchema>;
type ReleaseGet = (url: string, accept: string) => Promise<Response>;

/** The release `tag`'s assets by name, or why it has none to offer. */
async function fetchReleaseAssets(
	tag: string,
	get: ReleaseGet,
): Promise<Map<string, ReleaseAsset> | ReleaseRuntime> {
	const response = await get(
		`${GITHUB_API}/repos/${PUBLISHER_RELEASES_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`,
		'application/vnd.github+json',
	);
	if (response.status === 404)
		return unavailable(`${PUBLISHER_RELEASES_REPOSITORY} has no published release ${tag}`);
	if (response.status === 403 || response.status === 429)
		return unavailable(
			`GitHub refused the lookup of release ${tag} (HTTP ${response.status}); the control plane's anonymous GitHub API rate limit is probably exhausted, so try again later`,
		);
	if (!response.ok)
		return unavailable(`looking up release ${tag} on GitHub answered HTTP ${response.status}`);
	const release = ReleaseSchema.safeParse(await response.json());
	if (!release.success)
		return unavailable(`GitHub answered release ${tag} with an unexpected shape`);

	const assets = new Map<string, ReleaseAsset>();
	for (const raw of release.data.assets) {
		const asset = ReleaseAssetSchema.safeParse(raw);
		if (asset.success) assets.set(asset.data.name, asset.data);
	}
	return assets;
}

/** A small release asset's text (a `.sha256` or a `.minisig`), or why it could not be read. */
async function readReleaseSidecar(
	asset: ReleaseAsset,
	get: ReleaseGet,
): Promise<{ text: string } | { error: string }> {
	const response = await get(asset.browser_download_url, 'application/octet-stream');
	if (!response.ok) return { error: `downloading ${asset.name} answered HTTP ${response.status}` };
	const text = await readTextCapped(response, RELEASE_SIDECAR_MAX_BYTES);
	return text === undefined
		? { error: `${asset.name} is larger than ${RELEASE_SIDECAR_MAX_BYTES} bytes` }
		: { text };
}

/**
 * Locate the signed runtime for `version` on the publisher's GitHub Release
 * `v<version>`. Never throws: a missing release, a release without a runtime, an
 * unsigned one, a signature for another version, GitHub's anonymous rate limit
 * and any network error are each an unavailable runtime naming the reason.
 */
export async function resolveReleaseRuntime(
	version: string,
	deps: Pick<WorkerRuntimeDeps, 'fetch'>,
): Promise<ReleaseRuntime> {
	const fetchImpl = deps.fetch ?? globalThis.fetch;
	const tag = `v${version}`;
	const name = runtimeArtifactName(version);
	const get: ReleaseGet = (url, accept) =>
		fetchImpl(url, {
			headers: { accept, 'user-agent': 'swarm-control-plane' },
			signal: AbortSignal.timeout(RELEASE_FETCH_TIMEOUT_MS),
		});

	try {
		const assets = await fetchReleaseAssets(tag, get);
		if (!(assets instanceof Map)) return assets;
		const tarball = assets.get(name);
		if (!tarball)
			return unavailable(
				`release ${tag} carries no worker runtime ${name} (it predates the published runtime)`,
			);
		const checksumAsset = assets.get(`${name}.sha256`);
		if (!checksumAsset) return unavailable(`release ${tag}'s worker runtime has no checksum file`);
		const signatureAsset = assets.get(`${name}.minisig`);
		if (!signatureAsset)
			return unavailable(`release ${tag}'s worker runtime is unsigned and is not offered`);

		const checksum = await readReleaseSidecar(checksumAsset, get);
		if ('error' in checksum) return unavailable(`release ${tag}: ${checksum.error}`);
		const sha256 = checksum.text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';

		const signature = await readReleaseSidecar(signatureAsset, get);
		if ('error' in signature) return unavailable(`release ${tag}: ${signature.error}`);
		const minisig = signature.text;
		const signed = parseMinisignTrustedComment(minisig);
		if (!signed)
			return unavailable(
				`release ${tag}'s worker runtime signature names no version and commit in its trusted comment`,
			);
		if (signed.version !== version)
			return unavailable(
				`release ${tag}'s worker runtime is signed as v${signed.version}, not v${version}`,
			);

		const manifest = AvailableWorkerRuntimeManifestSchema.safeParse({
			available: true,
			version,
			commit: signed.commit,
			artifact: { name, url: tarball.browser_download_url, size: tarball.size, sha256 },
			signature: { format: 'minisign', minisig },
		});
		if (!manifest.success)
			return unavailable(
				`release ${tag}'s worker runtime does not form a valid manifest: ${manifest.error.issues
					.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
					.join('; ')}`,
			);
		return { available: true, manifest: manifest.data };
	} catch (err) {
		return unavailable(
			`release ${tag} could not be looked up on GitHub: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** The manifest body for a resolved runtime. Always 200: a 404 means "no such route". */
export function handleRuntimeManifest(runtime: OwnRuntime | ReleaseRuntime): {
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

/** Whether `bearer` is a worker credential or an operator session token. */
async function isAuthenticated(
	deps: WorkerRuntimeDeps,
	bearer: string | undefined,
): Promise<boolean> {
	return (
		bearer !== undefined &&
		((await deps.resolveWorkerByCredential(bearer)) !== undefined ||
			(await deps.resolveSession(bearer)) !== undefined)
	);
}

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
	if (!(await isAuthenticated(deps, bearer)))
		return { status: 401, json: { authenticated: false } };

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

/** How many located releases one process remembers, so walking versions cannot grow it. */
export const RELEASE_MEMO_LIMIT = 32;

/**
 * How long a failed release lookup is remembered, so asking again for a missing
 * version costs one GitHub call per window rather than one per request.
 */
export const RELEASE_FAILURE_TTL_MS = 5 * 60 * 1000;

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

	const now = deps.now ?? Date.now;
	/** A lookup in flight or settled; `expiresAt` is set once it has failed. */
	const releases = new Map<string, { pending: Promise<ReleaseRuntime>; expiresAt?: number }>();
	/** A remembered answer for `version`, which costs no GitHub call. */
	const knownRelease = (version: string): Promise<ReleaseRuntime> | undefined => {
		const known = releases.get(version);
		if (!known) return undefined;
		if (known.expiresAt !== undefined && known.expiresAt <= now()) {
			releases.delete(version);
			return undefined;
		}
		return known.pending;
	};
	const lookUpRelease = (version: string): Promise<ReleaseRuntime> => {
		const entry: { pending: Promise<ReleaseRuntime>; expiresAt?: number } = {
			pending: resolveReleaseRuntime(version, deps).then((resolved) => {
				// A failure is remembered briefly: the release may be published after this ask.
				if (!resolved.available) entry.expiresAt = now() + RELEASE_FAILURE_TTL_MS;
				return resolved;
			}),
		};
		if (releases.size >= RELEASE_MEMO_LIMIT) {
			const oldest = releases.keys().next().value;
			if (oldest !== undefined) releases.delete(oldest);
		}
		releases.set(version, entry);
		return entry.pending;
	};

	/**
	 * The runtime a manifest request names: the installation's own, or another
	 * release. `undefined` when answering would reach GitHub for a caller who has
	 * not authenticated.
	 */
	const runtimeFor = async (
		requested: string | undefined,
		bearer: string | undefined,
	): Promise<OwnRuntime | ReleaseRuntime | undefined> => {
		if (requested === undefined) return getRuntime();
		// An operator often types the tag, so one leading `v` is accepted.
		const version = requested.startsWith('v') ? requested.slice(1) : requested;
		if (!isRuntimeVersion(version))
			return unavailable(`${JSON.stringify(requested)} is not a valid runtime version`);
		if ((await deps.resolveOwnBuild())?.version === version) return getRuntime();
		const known = knownRelease(version);
		if (known) return known;
		if (!(await isAuthenticated(deps, bearer))) return undefined;
		return knownRelease(version) ?? lookUpRelease(version);
	};

	app.get(WORKER_RUNTIME_MANIFEST_PATH, async (c) => {
		const runtime = await runtimeFor(c.req.query('version'), resolveOperatorBearer(c));
		if (runtime === undefined)
			return c.json(
				{
					authenticated: false,
					reason:
						'looking up another release on GitHub needs a worker credential or an operator token from `swarm login`',
				},
				401,
				NO_STORE,
			);
		const result = handleRuntimeManifest(runtime);
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
