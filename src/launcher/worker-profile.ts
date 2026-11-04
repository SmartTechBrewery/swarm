/**
 * **Worker profiles** (issue #1281, phase 2): what the launcher needs to start one
 * worker with no SWARM clone and no `.env`. A profile is
 * `~/.swarm/workers/<workerId>/profile.json` and records the installation the
 * worker serves (its control-plane URL), the worker's credential, and its
 * checkouts — primary first, the order `SWARM_WORKER_REPO_ROOT` declares them in.
 *
 * Keyed on the **worker id** rather than on a checkout (as the clone worker's
 * credential cache, `../cli/_shared/worker-credential-cache.ts`, is) because the
 * question the launcher answers is "start worker X", and two workers on one
 * machine may serve two installations on two runtime versions. The id becomes a
 * directory name, so it is checked against a path-safe grammar before any path is
 * built from it.
 *
 * **The credential is at rest on disk**, at the credential cache's owner-only
 * expectation: `700` on the directory and `600` on the file, both set explicitly
 * rather than left to the umask, written through a temporary file and a `rename`
 * so a concurrent reader never sees half a record. Nothing here prints it.
 *
 * **The launcher's own bookkeeping lives beside it in `state.json`**
 * (`{ lastRuntimeVersion, startedAt }`), so starting a worker never rewrites the
 * file holding the credential. It is what lets a worker start on the version it
 * last ran when its control plane is briefly unreachable.
 *
 * Bundle-safe like the rest of `src/launcher/`: nothing from the daemon graph.
 */

import { chmodSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { normalizeControlPlaneUrl } from '../cli/_shared/operator-session-cache.js';
import { canonicalCheckoutPath } from '../worktree/checkout-key.js';
import { readJson } from '../worktree/local-lock.js';

const PROFILE_FILE = 'profile.json';
const STATE_FILE = 'state.json';

/** A worker id becomes a path segment: no separators, no dots, so never `.` or `..`. */
const WORKER_ID_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export const WorkerProfileSchema = z.object({
	workerId: z.string().regex(WORKER_ID_GRAMMAR),
	/** Normalised by {@link normalizeControlPlaneUrl}. */
	controlPlaneUrl: z.string().url(),
	credential: z.string().min(1),
	/** Canonical checkout paths, primary first. */
	repoRoots: z.array(z.string().min(1)).min(1),
	createdAt: z.string().datetime(),
});
export type WorkerProfile = z.infer<typeof WorkerProfileSchema>;

export const WorkerStateSchema = z.object({
	lastRuntimeVersion: z.string().min(1),
	startedAt: z.string().datetime(),
});
export type WorkerState = z.infer<typeof WorkerStateSchema>;

export function isValidWorkerId(workerId: string): boolean {
	return WORKER_ID_GRAMMAR.test(workerId);
}

function assertWorkerId(workerId: string): void {
	if (!isValidWorkerId(workerId))
		throw new Error(
			`${JSON.stringify(workerId)} is not a valid worker id (letters, digits, '-' and '_' only)`,
		);
}

/** `<homeDir>/.swarm/workers`. */
export function workerProfilesDir(homeDir?: string): string {
	return resolve(homeDir ?? homedir(), '.swarm', 'workers');
}

/** `<homeDir>/.swarm/workers/<workerId>`. Throws on a worker id that is not path-safe. */
export function workerProfileDir(workerId: string, homeDir?: string): string {
	assertWorkerId(workerId);
	return resolve(workerProfilesDir(homeDir), workerId);
}

/** `<homeDir>/.swarm/workers/<workerId>/profile.json`. */
export function workerProfilePath(workerId: string, homeDir?: string): string {
	return resolve(workerProfileDir(workerId, homeDir), PROFILE_FILE);
}

function workerStatePath(workerId: string, homeDir?: string): string {
	return resolve(workerProfileDir(workerId, homeDir), STATE_FILE);
}

export interface WriteWorkerProfileInput {
	workerId: string;
	controlPlaneUrl: string;
	credential: string;
	/** Primary first; at least one. */
	repoRoots: string[];
	/** Injectable so tests never touch the real home directory or clock. */
	homeDir?: string;
	now?: () => number;
}

/** Write (or replace) a worker's profile and return the path written. */
export function writeWorkerProfile(input: WriteWorkerProfileInput): string {
	assertWorkerId(input.workerId);
	const now = input.now ?? Date.now;
	const record = WorkerProfileSchema.parse({
		workerId: input.workerId,
		controlPlaneUrl: normalizeControlPlaneUrl(input.controlPlaneUrl),
		credential: input.credential,
		repoRoots: input.repoRoots.map(canonicalCheckoutPath),
		createdAt: new Date(now()).toISOString(),
	});
	return writeRecord(workerProfilePath(record.workerId, input.homeDir), record);
}

/**
 * `null` — no profile for this worker. `undefined` — one exists but could not be
 * read, does not match the schema, or names another worker than its directory.
 * Throws on a worker id that is not path-safe.
 */
export function readWorkerProfile(
	workerId: string,
	homeDir?: string,
): WorkerProfile | null | undefined {
	const profile = readJson(workerProfilePath(workerId, homeDir), WorkerProfileSchema);
	if (profile && profile.workerId !== workerId) return undefined;
	return profile;
}

export interface ListedWorkerProfile {
	workerId: string;
	path: string;
	/** `undefined` when the profile is present but unreadable. */
	profile: WorkerProfile | undefined;
}

/** Every profile directory holding a `profile.json`, sorted by worker id. */
export function listWorkerProfiles(homeDir?: string): ListedWorkerProfile[] {
	let names: string[];
	try {
		names = readdirSync(workerProfilesDir(homeDir));
	} catch {
		return [];
	}
	return names
		.filter(isValidWorkerId)
		.sort()
		.flatMap((workerId) => {
			const profile = readWorkerProfile(workerId, homeDir);
			if (profile === null) return [];
			return [{ workerId, path: workerProfilePath(workerId, homeDir), profile }];
		});
}

/**
 * Replace a worker's checkouts (primary first), leaving everything else as it was.
 * Answers like {@link readWorkerProfile} when there is nothing to update, and
 * writes nothing in that case.
 */
export function updateWorkerProfileRepoRoots(
	workerId: string,
	repoRoots: string[],
	homeDir?: string,
): WorkerProfile | null | undefined {
	const profile = readWorkerProfile(workerId, homeDir);
	if (!profile) return profile;
	const record = WorkerProfileSchema.parse({
		...profile,
		repoRoots: repoRoots.map(canonicalCheckoutPath),
	});
	writeRecord(workerProfilePath(workerId, homeDir), record);
	return record;
}

/** `null` — never started by the launcher; `undefined` — unreadable. */
export function readWorkerState(
	workerId: string,
	homeDir?: string,
): WorkerState | null | undefined {
	return readJson(workerStatePath(workerId, homeDir), WorkerStateSchema);
}

export function writeWorkerState(workerId: string, state: WorkerState, homeDir?: string): string {
	return writeRecord(workerStatePath(workerId, homeDir), WorkerStateSchema.parse(state));
}

/** Write one record owner-only, atomically, and return the path written. */
function writeRecord(path: string, record: unknown): string {
	const dir = dirname(path);
	// `~/.swarm/workers/` and the worker's own directory are both chmod'ed
	// explicitly, so the result depends on neither the umask nor a pre-existing
	// directory's mode. An existing `~/.swarm` is never chmod'ed.
	mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
	chmodSync(dirname(dir), 0o700);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);

	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
	renameSync(temp, path);
	// After the rename, in case the file it replaced had a laxer mode.
	chmodSync(path, 0o600);
	return path;
}
