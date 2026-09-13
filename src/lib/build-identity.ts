/**
 * The **build identity of the SWARM install this module is part of** — the commit
 * its checkout is on, plus a flag saying the running code is not exactly that
 * commit (issue #918).
 *
 * It exists because `package.json`'s `version` cannot answer "is this worker
 * running the fix?". That version is `0.1.0` and never moves, so `daemonVersion`
 * (`../transport/connect-entry.ts`) — the only build fact the handshake carried —
 * is the same string on every daemon in the fleet, whatever code it is running. A
 * commit id moves with the code, which is the whole point.
 *
 * **The install root is not the worker's repo root.** On a control-plane host
 * several daemons serve several different project repositories and all load SWARM
 * from one checkout through an npm link, with `cwd` set to the *project* repo. So
 * neither `process.cwd()` nor `SWARM_WORKER_REPO_ROOT` names the SWARM checkout,
 * and `process.env.npm_package_version` is the *project's* version when the daemon
 * was launched from a project's npm script. The only correct anchor is
 * `import.meta.url` resolved two levels up — exactly how `resolveDaemonVersion()`
 * already finds `package.json` — since Node resolves a linked module to its
 * realpath, landing inside the SWARM checkout rather than a project's
 * `node_modules`.
 *
 * **Never throws**, on the same contract as `resolveOriginRepoSlug`
 * (`../scm/repo-slug.ts`): an install root that is not a git checkout (the Compose
 * router image has no `.git` at all) declares nothing and keeps starting.
 *
 * Deliberately *not* guarded: an install root nested inside another git repository
 * would report the outer repository's HEAD. That is operator error of the same
 * class `repo-slug.ts` already declines to defend against, and checking it would
 * buy a third subprocess for a case nobody has.
 */

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

/**
 * A build identity on the wire (`HandshakeRequestSchema.build`) and in the read
 * model (`Worker.build`). The commit is normalised to lower-case hex so one
 * canonical form is recorded whatever casing a sender used, and accepts an
 * abbreviated id as well as a full one — a shorter SHA is still coordinates.
 *
 * `dirty` is one flag covering both ways the running code can differ from the
 * commit it names: uncommitted changes in the checkout, and a `dist/` build older
 * than HEAD (`bin/swarm.js` runs the compiled output, so those two can diverge).
 * The pair travels together so a consumer cannot read a commit without its flag.
 */
export const WorkerBuildSchema = z.object({
	commit: z
		.string()
		.trim()
		.toLowerCase()
		.pipe(z.string().regex(/^[0-9a-f]{7,64}$/, 'must be a hex commit id')),
	dirty: z.boolean(),
});
export type WorkerBuild = z.infer<typeof WorkerBuildSchema>;

/**
 * A build a machine can be asked to move its install root to (`../worker/self-update.ts`,
 * issue #920). It lives beside {@link WorkerBuildSchema} because it is the other
 * half of the same vocabulary — one names the build a daemon *is* on, the other
 * the build it is *asked for* — and because the control frame that will carry it
 * must import this definition rather than re-declare its own, the way
 * `HandshakeRequestSchema.build` imports the one above.
 *
 * **The grammar is the security boundary.** This is the only thing a request to
 * change a machine's code is ever allowed to carry: a branch, a tag, or a commit
 * id, and nothing that could be read as anything else. A ref starts with an
 * alphanumeric — so it can never be taken for a git option — and the character
 * class admits no colon, whitespace, scheme, `~`, `^`, `@`, `?`, `*`, `\`, or
 * quote, which is what excludes a URL, a refspec, a revision expression, and a
 * shell fragment by construction rather than by a reviewer noticing. The four
 * remaining exclusions are git's own ref rules (`git check-ref-format`) for
 * sequences the character class does permit.
 */
export const WorkerUpdateTargetSchema = z
	.string()
	.trim()
	.max(200, 'must be at most 200 characters')
	.pipe(
		z
			.string()
			.regex(/^[0-9A-Za-z][0-9A-Za-z._/-]*$/, 'must be a branch name, tag, or commit id')
			.refine(
				(ref) =>
					!ref.includes('..') &&
					!ref.includes('//') &&
					!ref.endsWith('/') &&
					!ref.endsWith('.lock'),
				'must be a well-formed ref: no "..", no "//", no trailing "/" or ".lock"',
			),
	);
export type WorkerUpdateTarget = z.infer<typeof WorkerUpdateTargetSchema>;

/**
 * What became of a requested update, in the one vocabulary the daemon reports in,
 * the `workers` row records, and the operator surfaces read (issue #933).
 *
 * The first four map onto `UpdateOutcome`'s members (`../worker/self-update.ts`),
 * which is a plain union rather than a schema because nothing sent it anywhere; it
 * cannot be the source of truth *here* either, since that module reaches for
 * `node:fs` and `node:child_process` and this vocabulary has to be readable by the
 * control plane, the wire, and the database. `declined` is the fifth and is the
 * daemon's alone: the machine never opted in (`SWARM_WORKER_SELF_UPDATE`), so
 * nothing was attempted and nothing could have been.
 *
 * It lives beside {@link WorkerUpdateTargetSchema} for the same reason that one
 * lives beside {@link WorkerBuildSchema}: one names the build a machine is asked
 * for, one what came of asking, and every consumer must import the definition
 * rather than re-declare its own.
 */
export const WORKER_UPDATE_STATUSES = [
	'applied',
	'already-current',
	'refused',
	'failed',
	'declined',
] as const;
export const WorkerUpdateStatusSchema = z.enum(WORKER_UPDATE_STATUSES);
export type WorkerUpdateStatus = z.infer<typeof WorkerUpdateStatusSchema>;

/**
 * The root of the SWARM install this module belongs to — `import.meta.url` two
 * levels up (`src/lib/` → the checkout, `dist/lib/` → the same checkout), never
 * `cwd` and never an env var. See the module header for why that distinction is
 * load-bearing.
 */
export function swarmInstallRoot(): string {
	return resolve(fileURLToPath(import.meta.url), '../../..');
}

async function git(cwd: string, args: string[]): Promise<string | null> {
	try {
		return (await execFileAsync('git', args, { cwd })).stdout.trim();
	} catch {
		return null;
	}
}

/**
 * Resolve a build identity for `root`, given the path of the module actually
 * executing — the testable form of {@link resolveOwnBuildIdentity}, which supplies
 * this module's own coordinates.
 *
 * `modulePath` decides whether the *unbuilt* half of `dirty` is checked at all: it
 * is meaningful only when the running code is compiled output under `root/dist`,
 * because then the checkout's HEAD and the code executing can differ. Running from
 * source (`tsx`) the running code *is* the checkout, so the check is skipped.
 */
export async function resolveBuildIdentity(
	root: string,
	modulePath: string,
): Promise<WorkerBuild | undefined> {
	const commit = await git(root, ['rev-parse', 'HEAD']);
	if (!commit) return undefined;

	const status = await git(root, ['status', '--porcelain']);
	// A failed `status` (but a readable HEAD) leaves the honest answer unknown, so
	// say dirty rather than claim clean: the flag exists to stop a build being
	// trusted, and a false "clean" is the one wrong answer that matters.
	const dirty = status === null || status !== '' || (await isStaleBuild(root, modulePath, commit));

	const parsed = WorkerBuildSchema.safeParse({ commit, dirty });
	// Same reason `resolveDeclarableOriginRepoSlug` filters: the daemon parses its
	// own handshake body at startup, so a value the wire schema would reject must
	// never reach it — an odd `rev-parse` output leaves it undeclared instead of
	// killing the daemon.
	return parsed.success ? parsed.data : undefined;
}

/**
 * Whether the compiled output being executed predates the commit it claims — the
 * "unbuilt checkout" half of `dirty`. Only asked of a module running out of
 * `root/dist`; `tsc` rewrites every output on each build, so one file's mtime is a
 * sound proxy for when the build ran.
 */
async function isStaleBuild(root: string, modulePath: string, commit: string): Promise<boolean> {
	if (!modulePath.startsWith(join(root, 'dist') + sep)) return false;
	const committedAt = await git(root, ['log', '-1', '--format=%ct', commit]);
	if (!committedAt) return false;
	const committedAtMs = Number(committedAt) * 1000;
	if (!Number.isFinite(committedAtMs)) return false;
	try {
		const { mtimeMs } = await stat(modulePath);
		return mtimeMs < committedAtMs;
	} catch {
		return false;
	}
}

let ownBuildIdentity: Promise<WorkerBuild | undefined> | undefined;

/**
 * This process's own build identity, or `undefined` when it cannot be read.
 *
 * Memoized in a module-level promise: the identity of a running process is fixed
 * for its life, so re-resolving it could only invite two answers to differ — and it
 * costs two `git` subprocesses, which a caller on a per-request path must not pay
 * repeatedly.
 */
export function resolveOwnBuildIdentity(): Promise<WorkerBuild | undefined> {
	ownBuildIdentity ??= resolveBuildIdentity(swarmInstallRoot(), fileURLToPath(import.meta.url));
	return ownBuildIdentity;
}
