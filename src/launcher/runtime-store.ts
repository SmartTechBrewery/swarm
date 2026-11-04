/**
 * The **host-side worker runtime store** (issue #1281, phase 1): the
 * version-isolation half of the worker launcher. It fetches an installation's
 * runtime manifest (`../transport/runtime-manifest.ts`), downloads the runtime it
 * names, proves it is the publisher's, and installs it side by side with every
 * other version under `~/.swarm/runtimes/<version>/`. Nothing here starts a
 * runtime; the launcher (phase 2) is the first caller.
 *
 * The invariants, each load-bearing:
 *
 *   - **`<version>/` exists only as the result of one `rename`** of a staging
 *     directory that was fully verified and fully extracted. A rename within one
 *     filesystem is atomic, so a download or an extraction interrupted at any
 *     point leaves at most a `.staging/` entry, which nothing ever starts and the
 *     next install sweeps once it is an hour old.
 *   - **An installed version is never modified.** Its files are `0444` and its
 *     directories `0555`; a second install of the same version returns the first
 *     one, and one whose recorded commit disagrees with the manifest is refused
 *     rather than replaced.
 *   - **Nothing is written before everything is verified**: the size and SHA-256
 *     the manifest names, the minisign signature against the trusted public key,
 *     and that signature's trusted comment naming the manifest's version and
 *     commit. With no trusted key the store refuses to download at all (it fails
 *     closed); only an already-installed version is served without one.
 *   - **The bearer goes only to the control-plane origin.** `artifact.url` may be
 *     absolute (a runtime served elsewhere), and the credential must not follow it
 *     there; a request that carries it also refuses to follow a redirect.
 *   - **One download per version per host** (issue #1302): download, verify and
 *     install run under `.locks/<version>.lock`, created exclusively (`'wx'`). A
 *     second caller for the same version waits for the holder, then finds the
 *     version installed and returns it. The lock is an economy, not the
 *     correctness guarantee — that stays the single atomic `rename` above — so a
 *     holder that died (its pid is gone) or a lock older than
 *     {@link STALE_STAGING_MS} is simply reclaimed, and the rare race two
 *     reclaimers can lose costs one duplicate download, never a corrupt install.
 *   - **Nothing from the daemon graph is imported**: the launcher bundles this
 *     module, and the manifest contract it reads is `node:`-free for that reason.
 */

import { createHash } from 'node:crypto';
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
	type AvailableWorkerRuntimeManifest,
	isRuntimeVersion,
	parseMinisignTrustedComment,
	runtimeArtifactName,
	WORKER_RUNTIME_MANIFEST_PATH,
	type WorkerRuntimeManifest,
	WorkerRuntimeManifestSchema,
} from '../transport/runtime-manifest.js';
import { isExpired, pathOlderThan, pidIsLive, readJson } from '../worktree/local-lock.js';
import { verifyMinisign } from './minisign.js';
import { extractRuntimeTarball } from './runtime-tar.js';

/** The bundle inside a runtime, at the depth `swarmInstallRoot()` is anchored on. */
export const RUNTIME_ENTRYPOINT = 'dist/transport/connect-entry.mjs';

/** In-flight installs. Never read, never started; swept once stale. */
const STAGING_DIR = '.staging';

/** Per-version install locks. Never versions either. */
const LOCKS_DIR = '.locks';

/** A staging entry older than this was left by a killed install. A constant, not a setting. */
export const STALE_STAGING_MS = 60 * 60 * 1000;

/** How often a caller waiting on another install of the same version looks again. */
export const INSTALL_LOCK_POLL_MS = 500;

const InstallLockSchema = z.object({
	pid: z.number().int(),
	hostname: z.string(),
	createdAt: z.string(),
});
type InstallLock = z.infer<typeof InstallLockSchema>;

const BuildInfoSchema = z.object({ commit: z.string().min(1).optional() }).passthrough();

type Fetch = typeof globalThis.fetch;

export type StoreError = { error: string };

export interface InstalledRuntime {
	version: string;
	dir: string;
	entrypoint: string;
	/** The commit the runtime's `build-info.json` records, when it has one. */
	commit?: string;
}

export interface EnsuredRuntime {
	version: string;
	dir: string;
	entrypoint: string;
	/** `true` when this call installed it; `false` when it was already there. */
	installed: boolean;
}

/** `<homeDir>/.swarm/runtimes`. */
export function runtimesDir(homeDir?: string): string {
	return resolve(homeDir ?? homedir(), '.swarm', 'runtimes');
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function commitsMatch(a: string, b: string): boolean {
	const x = a.toLowerCase();
	const y = b.toLowerCase();
	return x.startsWith(y) || y.startsWith(x);
}

/**
 * Fetch and parse an installation's runtime manifest: for the installation's own
 * version, or, with `version`, for that signed release (issue #1282). A release the
 * control plane has not located yet is looked up only for a caller that sends
 * `bearer` (a worker credential or an operator token); the request carrying it
 * refuses redirects, as the artifact download does. An `available: false` manifest
 * is returned as it is, with its reason; every failure to get a manifest at all is
 * an `{ error }` saying which one.
 */
export async function fetchRuntimeManifest(
	controlPlaneUrl: string,
	options: { fetch?: Fetch; version?: string; bearer?: string } = {},
): Promise<WorkerRuntimeManifest | StoreError> {
	const fetchImpl = options.fetch ?? globalThis.fetch;
	let url: URL;
	try {
		url = new URL(WORKER_RUNTIME_MANIFEST_PATH, controlPlaneUrl);
	} catch {
		return { error: `the control-plane URL ${controlPlaneUrl} is not a valid URL` };
	}
	if (options.version !== undefined) url.searchParams.set('version', options.version);
	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: {
				accept: 'application/json',
				...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
			},
			...(options.bearer ? { redirect: 'error' as const } : {}),
		});
	} catch (err) {
		return { error: `could not reach the control plane at ${url.origin}: ${errorMessage(err)}` };
	}
	if (response.status === 404)
		return {
			error: `the control plane at ${url.origin} predates the worker runtime route (${WORKER_RUNTIME_MANIFEST_PATH} answered 404)`,
		};
	if (response.status === 401)
		return {
			error: `the control plane at ${url.origin} looks up a release it has not located yet only for an authenticated caller (${WORKER_RUNTIME_MANIFEST_PATH} answered 401)`,
		};
	if (!response.ok)
		return { error: `${WORKER_RUNTIME_MANIFEST_PATH} answered HTTP ${response.status}` };
	let body: unknown;
	try {
		body = await response.json();
	} catch (err) {
		return { error: `${WORKER_RUNTIME_MANIFEST_PATH} did not answer JSON: ${errorMessage(err)}` };
	}
	const parsed = WorkerRuntimeManifestSchema.safeParse(body);
	if (!parsed.success)
		return {
			error: `${WORKER_RUNTIME_MANIFEST_PATH} did not answer a worker runtime manifest: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
				.join('; ')}`,
		};
	return parsed.data;
}

/** An installed version, or `undefined` when `<version>/` holds no runtime entrypoint. */
export function installedRuntime(version: string, homeDir?: string): InstalledRuntime | undefined {
	if (!isRuntimeVersion(version)) return undefined;
	const dir = join(runtimesDir(homeDir), version);
	const entrypoint = join(dir, RUNTIME_ENTRYPOINT);
	if (!existsSync(entrypoint)) return undefined;
	const commit = readJson(join(dir, 'build-info.json'), BuildInfoSchema)?.commit;
	return { version, dir, entrypoint, ...(commit ? { commit } : {}) };
}

/** Every installed version, sorted. In-flight staging directories are not versions. */
export function listInstalledRuntimes(homeDir?: string): InstalledRuntime[] {
	let names: string[];
	try {
		names = readdirSync(runtimesDir(homeDir));
	} catch {
		return [];
	}
	return names
		.filter((name) => name !== STAGING_DIR && name !== LOCKS_DIR)
		.sort()
		.flatMap((name) => installedRuntime(name, homeDir) ?? []);
}

/** Make a tree writable again and remove it. Never throws. */
function removeTree(path: string): void {
	const makeWritable = (p: string) => {
		try {
			const info = lstatSync(p);
			if (!info.isDirectory()) return;
			chmodSync(p, 0o700);
			for (const child of readdirSync(p)) makeWritable(join(p, child));
		} catch {
			// Already gone, or not ours to fix; `rmSync` reports nothing either way.
		}
	};
	makeWritable(path);
	rmSync(path, { recursive: true, force: true });
}

/** `0444` files and `0555` directories, bottom-up; the root itself is left writable. */
function makeReadOnlyBelow(dir: string): void {
	for (const child of readdirSync(dir)) {
		const path = join(dir, child);
		if (lstatSync(path).isDirectory()) {
			makeReadOnlyBelow(path);
			chmodSync(path, 0o555);
		} else {
			chmodSync(path, 0o444);
		}
	}
}

function sweepStaleStaging(stagingRoot: string, now: number): void {
	let entries: string[];
	try {
		entries = readdirSync(stagingRoot);
	} catch {
		return;
	}
	for (const entry of entries) {
		const path = join(stagingRoot, entry);
		try {
			if (now - statSync(path).mtimeMs > STALE_STAGING_MS) removeTree(path);
		} catch {
			// Vanished underneath us: another install swept or published it.
		}
	}
}

/** Whether a lock on disk was left by a process that can no longer release it. */
function lockIsStale(path: string, now: number): boolean {
	const holder = readJson(path, InstallLockSchema);
	if (holder === null) return false;
	// Unreadable: possibly a holder between creating the file and writing it, so it is
	// judged by the file's own age rather than reclaimed on sight.
	if (holder === undefined) return pathOlderThan(path, STALE_STAGING_MS, now);
	if (isExpired(holder.createdAt, STALE_STAGING_MS, now)) return true;
	// A pid means something only on the host that recorded it.
	return holder.hostname === hostname() && !pidIsLive(holder.pid);
}

/** `true` when this call created the lock, `false` when another caller holds it. Throws on anything else. */
function tryCreateLock(path: string, record: InstallLock): boolean {
	let fd: number;
	try {
		fd = openSync(path, 'wx', 0o600);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw err;
	}
	try {
		writeSync(fd, `${JSON.stringify(record)}\n`);
	} finally {
		closeSync(fd);
	}
	return true;
}

/**
 * Take `<runtimes>/.locks/<version>.lock`, waiting while a live holder has it and
 * reclaiming it from a dead or expired one. Resolves to the release function.
 */
async function acquireInstallLock(
	version: string,
	homeDir: string | undefined,
	now: () => number,
	pollMs: number,
): Promise<() => void> {
	const dir = join(runtimesDir(homeDir), LOCKS_DIR);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, `${version}.lock`);
	while (true) {
		const record: InstallLock = {
			pid: process.pid,
			hostname: hostname(),
			createdAt: new Date(now()).toISOString(),
		};
		if (tryCreateLock(path, record)) {
			return () => {
				// Only our own record is removed: a lock reclaimed from us after an hour now
				// belongs to somebody else.
				const current = readJson(path, InstallLockSchema);
				if (current && current.pid === record.pid && current.createdAt === record.createdAt)
					rmSync(path, { force: true });
			};
		}
		if (lockIsStale(path, now())) {
			try {
				unlinkSync(path);
			} catch {
				// Another waiter reclaimed it first.
			}
			continue;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
	}
}

/** An already-installed version, checked against the manifest's commit. */
function existingInstall(
	manifest: AvailableWorkerRuntimeManifest,
	homeDir: string | undefined,
): EnsuredRuntime | StoreError | undefined {
	const existing = installedRuntime(manifest.version, homeDir);
	if (!existing) return undefined;
	if (existing.commit && !commitsMatch(existing.commit, manifest.commit))
		return {
			error: `v${manifest.version} is installed from ${existing.commit}, but the installation names ${manifest.commit}; the installed runtime is not replaced`,
		};
	return {
		version: existing.version,
		dir: existing.dir,
		entrypoint: existing.entrypoint,
		installed: false,
	};
}

/** Read a response body into memory, refusing one longer than `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<Buffer | StoreError> {
	const tooLarge = { error: `the runtime download is larger than the manifest's ${limit} bytes` };
	const declared = response.headers.get('content-length');
	if (declared !== null && Number(declared) > limit) return tooLarge;
	if (!response.body) return Buffer.from(await response.arrayBuffer());
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			return tooLarge;
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks);
}

async function download(
	manifest: AvailableWorkerRuntimeManifest,
	controlPlaneUrl: string,
	bearer: string | undefined,
	fetchImpl: Fetch,
): Promise<Buffer | StoreError> {
	let controlPlane: URL;
	let artifactUrl: URL;
	try {
		controlPlane = new URL(controlPlaneUrl);
		artifactUrl = new URL(manifest.artifact.url, controlPlane);
	} catch {
		return { error: `the runtime artifact URL ${manifest.artifact.url} is not a valid URL` };
	}
	if (artifactUrl.protocol !== 'https:' && artifactUrl.protocol !== 'http:')
		return { error: `the runtime artifact URL ${artifactUrl.href} is not http(s)` };
	const sendBearer = Boolean(bearer) && artifactUrl.origin === controlPlane.origin;

	let response: Response;
	try {
		response = await fetchImpl(artifactUrl, {
			headers: sendBearer ? { authorization: `Bearer ${bearer}` } : {},
			// A redirect could carry the credential to a host it was never meant for.
			redirect: sendBearer ? 'error' : 'follow',
		});
	} catch (err) {
		return { error: `could not download ${artifactUrl.href}: ${errorMessage(err)}` };
	}
	if (!response.ok) {
		const hint =
			response.status === 401 || response.status === 403 ? ' (the credential was refused)' : '';
		return { error: `downloading ${artifactUrl.href} answered HTTP ${response.status}${hint}` };
	}
	try {
		return await readCapped(response, manifest.artifact.size);
	} catch (err) {
		return { error: `downloading ${artifactUrl.href} failed: ${errorMessage(err)}` };
	}
}

/** Every check that stands between downloaded bytes and the store. */
function verifyArtifact(
	manifest: AvailableWorkerRuntimeManifest,
	data: Buffer,
	trustedPublicKey: string,
): StoreError | undefined {
	const { artifact } = manifest;
	if (data.length !== artifact.size)
		return {
			error: `the runtime download is ${data.length} bytes, the manifest names ${artifact.size}`,
		};
	const sha256 = createHash('sha256').update(data).digest('hex');
	if (sha256 !== artifact.sha256)
		return {
			error: `the runtime download's SHA-256 ${sha256} does not match the manifest's ${artifact.sha256}`,
		};

	const verified = verifyMinisign({
		data,
		minisig: manifest.signature.minisig,
		publicKey: trustedPublicKey,
	});
	if (!verified.ok) return { error: `the runtime signature is refused: ${verified.reason}` };

	// Only the verified comment is read, never another line of the same file.
	const signed = parseMinisignTrustedComment(`trusted comment: ${verified.trustedComment}`);
	if (!signed)
		return {
			error: `the runtime signature's trusted comment names no version and commit: ${verified.trustedComment}`,
		};
	if (signed.version !== manifest.version)
		return {
			error: `the runtime is signed as v${signed.version}, the manifest names v${manifest.version}`,
		};
	if (!commitsMatch(signed.commit, manifest.commit))
		return {
			error: `the runtime is signed for commit ${signed.commit}, the manifest names ${manifest.commit}`,
		};
	return undefined;
}

export interface EnsureRuntimeInput {
	controlPlaneUrl: string;
	manifest: AvailableWorkerRuntimeManifest;
	/** A worker credential or an operator session token; sent to the control-plane origin only. */
	bearer?: string;
	/** The minisign public key (the whole `minisign.pub`, or its base64 line). Required to install. */
	trustedPublicKey?: string;
	/** Injectable so tests never touch the real home directory, network or clock. */
	homeDir?: string;
	fetch?: Fetch;
	now?: () => number;
	/** How often to look again while another caller installs this version. */
	lockPollMs?: number;
}

/**
 * Make `manifest`'s runtime available on this host: return it when it is already
 * installed, otherwise download, verify and install it atomically, under the
 * version's install lock so a second caller reuses the first one's result rather
 * than downloading it again. Never throws; every refusal is an `{ error }` naming
 * the check that failed, with nothing left under `<version>/`.
 */
export async function ensureRuntime(
	input: EnsureRuntimeInput,
): Promise<EnsuredRuntime | StoreError> {
	const { manifest, homeDir } = input;
	const { version } = manifest;
	if (!isRuntimeVersion(version))
		return {
			error: `the manifest's runtime version ${JSON.stringify(version)} is not a valid version`,
		};
	if (manifest.artifact.name !== runtimeArtifactName(version))
		return {
			error: `the manifest's artifact ${manifest.artifact.name} is not the runtime for v${version} (${runtimeArtifactName(version)})`,
		};

	const existing = existingInstall(manifest, homeDir);
	if (existing) return existing;

	const trustedPublicKey = input.trustedPublicKey?.trim();
	if (!trustedPublicKey)
		return {
			error: `no trusted runtime signing key is configured, so v${version} cannot be verified and is not installed`,
		};

	const now = input.now ?? Date.now;
	let release: () => void;
	try {
		release = await acquireInstallLock(
			version,
			homeDir,
			now,
			input.lockPollMs ?? INSTALL_LOCK_POLL_MS,
		);
	} catch (err) {
		return { error: `could not take the install lock for v${version}: ${errorMessage(err)}` };
	}
	try {
		// The holder this call waited for may have installed it.
		const installed = existingInstall(manifest, homeDir);
		if (installed) return installed;

		const data = await download(
			manifest,
			input.controlPlaneUrl,
			input.bearer,
			input.fetch ?? globalThis.fetch,
		);
		if (!Buffer.isBuffer(data)) return data;
		const refused = verifyArtifact(manifest, data, trustedPublicKey);
		if (refused) return refused;

		return installVerified(manifest, data, homeDir, now());
	} finally {
		try {
			release();
		} catch {
			// A lock left behind is reclaimed once its holder is gone.
		}
	}
}

/**
 * Stage verified bytes, make them read-only, and publish them with one rename.
 * Whatever goes wrong, the staging directory is removed and no `<version>/` is
 * left behind by this call.
 */
function installVerified(
	manifest: AvailableWorkerRuntimeManifest,
	data: Buffer,
	homeDir: string | undefined,
	now: number,
): EnsuredRuntime | StoreError {
	const { version } = manifest;
	const root = runtimesDir(homeDir);
	const stagingRoot = join(root, STAGING_DIR);
	let staging: string | undefined;
	try {
		mkdirSync(root, { recursive: true, mode: 0o755 });
		mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
		sweepStaleStaging(stagingRoot, now);
		staging = mkdtempSync(join(stagingRoot, `${version}.${process.pid}.`));
		chmodSync(staging, 0o755);

		extractRuntimeTarball(data, `swarm-worker-runtime-${version}`, staging);
		if (!existsSync(join(staging, RUNTIME_ENTRYPOINT)))
			throw new Error(`the runtime archive carries no ${RUNTIME_ENTRYPOINT}`);
		makeReadOnlyBelow(staging);

		const target = join(root, version);
		try {
			renameSync(staging, target);
		} catch (err) {
			// Another install published this version first; its result is the answer.
			// Keyed on the target existing rather than on the errno, which differs by
			// platform (`ENOTEMPTY`, `EEXIST`, or `EACCES` once the winner is read-only).
			if (!existsSync(target)) throw err;
			removeTree(staging);
			staging = undefined;
			return (
				existingInstall(manifest, homeDir) ?? {
					error: `${target} already exists but holds no runtime entrypoint; remove it to reinstall v${version}`,
				}
			);
		}
		staging = undefined;
		// The top directory is made read-only only once it is in place: on Linux,
		// moving a directory to a new parent needs write access to it (for `..`).
		chmodSync(target, 0o555);
		return { version, dir: target, entrypoint: join(target, RUNTIME_ENTRYPOINT), installed: true };
	} catch (err) {
		return { error: `installing v${version} failed: ${errorMessage(err)}` };
	} finally {
		if (staging) removeTree(staging);
	}
}
