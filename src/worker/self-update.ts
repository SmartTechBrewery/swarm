/**
 * Moving one machine's SWARM **install root** to a requested build — or leaving it
 * exactly as it was and saying why (issue #920).
 *
 * This is the host-local half of worker self-update and nothing else: it never
 * exits the process, and it never decides *when* an update is safe. Its caller does
 * (`../transport/worker-update.ts`, issue #933) — the opt-in, the wait for an idle
 * daemon, and the restart all live there. A machine where several daemons share one
 * install root can still have its code swapped underneath a running phase; the lock
 * that makes that impossible is a later phase's job, which is why such a machine
 * must not set `SWARM_WORKER_SELF_UPDATE` until it lands.
 *
 * **What it operates on.** `swarmInstallRoot()` (`../lib/build-identity.ts`) —
 * never `process.cwd()` and never `SWARM_WORKER_REPO_ROOT`. On the control-plane
 * host four daemons serve four *project* repositories out of one npm-linked SWARM
 * checkout, so `cwd` names a project and the env var names a project's checkout;
 * only the module's own `import.meta.url` names the install being updated. It is a
 * parameter with that function as its default purely so tests can point it
 * somewhere else.
 *
 * **Why this is a narrow, unglamorous mechanism.** It is a code-distribution
 * channel, so every step is a guard rather than a feature:
 *
 * - The target is **data with a grammar** ({@link WorkerUpdateTargetSchema}), not a
 *   command, a script, a URL or a git option — and it is validated before a single
 *   subprocess runs.
 * - The fetch is `git fetch <remote>` with **no refspec and no URL**, so the only
 *   code that can ever arrive is what the install root's own already-configured
 *   remote already says it fetches. Nothing on the wire can redirect it.
 * - The target must be **reachable from the branch the install tracks**
 *   (`merge-base --is-ancestor`). That is the authorization that matters here: a
 *   machine can only be moved to code that is already on the branch it follows,
 *   never onto a side branch somebody pushed.
 * - A **dirty** install root is an operator's working copy and is never overwritten.
 * - `npm ci` and `npm run build` must both succeed, and a failure returns the
 *   install root to the commit it was on and rebuilds it there.
 *
 * **The running process is unaffected either way.** Its modules were loaded at
 * startup, so swapping the files under it changes nothing until something exits —
 * which this module never does.
 *
 * **It never throws.** Every outcome is a value ({@link UpdateOutcome}), on the same
 * contract `resolveBuildIdentity` keeps next door: an install root that is not a git
 * checkout, a git that will not run, and a rejected subprocess are all answers, not
 * exceptions.
 *
 * **An applied build is not trusted until it has handshaked (issue #934).** Once the
 * daemon on a new build cannot reach the control plane there is no channel left to
 * tell it to go back, so the machine has to decide by itself — and it can only do
 * that from something written down before the build it is judging started. That
 * record is {@link PendingVerificationSchema}, and this module owns the three
 * transitions on it: {@link recordFailedStart} at process start,
 * {@link recordSuccessfulHandshake} on the first session, and
 * {@link returnToLastKnownGood} once the machine has given up. *When* each of those
 * happens stays the daemon's business (`../transport/build-verification.ts`) — the
 * same split of mechanism from policy the apply above already keeps.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { swarmInstallRoot, WorkerUpdateTargetSchema } from '../lib/build-identity.js';
import { logger } from '../lib/logger.js';
import { checkoutStateDir } from '../worktree/checkout-key.js';
import { readJson } from '../worktree/local-lock.js';

const execFileAsync = promisify(execFile);

/** Reads (`rev-parse`, `status`, `merge-base`) answer immediately or not at all. */
const GIT_READ_TIMEOUT_MS = 30_000;
/** A fetch crosses the network; a checkout rewrites a working tree. */
const GIT_FETCH_TIMEOUT_MS = 10 * 60_000;
const GIT_CHECKOUT_TIMEOUT_MS = 5 * 60_000;
/** A cold `npm ci` on a slow machine is the longest step here by a wide margin. */
const NPM_TIMEOUT_MS = 30 * 60_000;

/** Hard cap on what a subprocess may buffer, so a runaway build cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** How much of a failed step's output rides the outcome — a tail, never the whole log. */
const OUTPUT_TAIL_CHARS = 4_000;

const STATE_FILE = 'state.json';

/**
 * How many starts in a row may fail on a build being verified before the machine
 * gives up on it and returns to the last known good one.
 *
 * Coded rather than configurable, like `IDLE_POLL_INTERVAL_MS` next door: the only
 * thing a larger number buys is a longer outage on a machine nobody can reach, and
 * the only thing a smaller one costs is a rollback on a build that would have
 * connected on its third try. Three leaves room for a control plane that is itself
 * restarting while still bounding the outage at a few supervisor restarts.
 */
export const MAX_FAILED_STARTS = 3;

/** One subprocess this module wants run, fully described — never a shell string. */
export interface UpdateCommand {
	command: 'git' | 'npm';
	args: string[];
	cwd: string;
	timeoutMs: number;
}

/** How a finished-or-failed {@link UpdateCommand} came back. */
export interface UpdateCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/**
 * The subprocess seam. Injected by tests; in production it is {@link runCommand},
 * which never rejects — a spawn failure is a non-zero exit like any other, so a
 * missing `npm` reads as a failed install rather than as an exception.
 */
export type CommandRunner = (command: UpdateCommand) => Promise<UpdateCommandResult>;

/** Which step of the apply failed — the three that can, in the order they run. */
export type UpdateFailureStage = 'checkout' | 'install' | 'build';

/**
 * What became of the install root. Deliberately a plain discriminated union rather
 * than a Zod schema: nothing sends it anywhere in this phase, and the frame that
 * later reports it will map onto it rather than being it.
 */
export type UpdateOutcome =
	| { status: 'already-current'; commit: string }
	| { status: 'applied'; commit: string; previousCommit: string }
	/** Nothing was changed, and `reason` says why in operator-facing prose. */
	| { status: 'refused'; reason: string }
	| {
			status: 'failed';
			stage: UpdateFailureStage;
			reason: string;
			/**
			 * Whether the install root is back on `previousCommit` with its dependencies
			 * and build matching. `false` is the one outcome an operator must be told
			 * about: the machine is on neither build.
			 */
			rolledBack: boolean;
			previousCommit: string;
			/** A bounded tail of the failed step's output — never folded into `reason`. */
			outputTail: string;
	  };

/**
 * An applied update this machine has not proved yet: the build it moved to, the
 * build it moved from, and how many starts in a row have failed since.
 *
 * It exists because the proof can only come from the *next* process — the one
 * running the new code — and that process may not survive long enough to say
 * anything. So the question "is this build any good?" is left on disk, phrased so
 * that a machine which never gets a word in still answers it.
 */
export const PendingVerificationSchema = z.object({
	/** The build that was applied and is being judged. */
	commit: z.string().min(1),
	/** The build it replaced — the same commit `lastKnownGood` still names until this one is proved. */
	previousCommit: z.string().min(1),
	/**
	 * Counted at process start rather than on a failure, because the failure this
	 * guards against can be a build that never reaches any code of its own.
	 */
	failedStarts: z.number().int().min(0),
	startedAt: z.string().datetime(),
});
export type PendingVerification = z.infer<typeof PendingVerificationSchema>;

/**
 * What this machine remembers about its own install root, at
 * `~/.swarm/install-updates/<sha256(realpath(installRoot))>/state.json`.
 *
 * The tracked branch and its remote are here because an applied update leaves HEAD
 * **detached**, so git has no upstream to answer with on the second run; they are
 * recorded the first time an attached HEAD lets them be read. `lastKnownGood` is
 * written *before* a checkout, so a process killed mid-apply still leaves a readable
 * record of what to go back to, and it stays on the build that was running until a
 * daemon on the new one has handshaked (issue #934).
 */
export const InstallUpdateStateSchema = z.object({
	/** The install root itself, recorded for whoever is reading an opaque `<sha256>` directory. */
	installRoot: z.string().min(1),
	remote: z.string().min(1),
	trackedBranch: z.string().min(1),
	lastKnownGood: z.string().min(1),
	/** The last target requested, and what it resolved to — `null` until one is applied. */
	target: z.string().min(1).nullable(),
	targetCommit: z.string().min(1).nullable(),
	appliedAt: z.string().datetime().nullable(),
	/**
	 * The applied update this machine is still proving, or `null` when there is
	 * nothing outstanding. Defaulted rather than required so a state file written
	 * before issue #934 parses as "nothing to verify": a state file this schema
	 * refuses is a refused update (see `update` below), and every machine that has
	 * ever been updated already has one.
	 */
	pendingVerification: PendingVerificationSchema.nullable().default(null),
});
export type InstallUpdateState = z.infer<typeof InstallUpdateStateSchema>;

/** Where one install root's update state lives — the `checkoutStateDir` convention, reused. */
export function installUpdateStateDir(installRoot: string, homeDir?: string): string {
	return checkoutStateDir('install-updates', installRoot, homeDir);
}

export interface ApplyUpdateTargetOptions {
	/** The branch, tag, or commit to move to. Validated before anything runs. */
	target: string;
	/** Defaults to {@link swarmInstallRoot} — see the module header for why that anchor. */
	installRoot?: string;
	/** Injectable so tests never touch the real home directory. */
	homeDir?: string;
	run?: CommandRunner;
	now?: () => Date;
}

/** One install root, and the two injectable things every step here needs. */
interface InstallContext {
	installRoot: string;
	stateDir: string;
	run: CommandRunner;
}

interface UpdateContext extends InstallContext {
	target: string;
	now: () => Date;
}

/**
 * Move `installRoot` to `target`, or leave it exactly as it is.
 *
 * See the module header for the sequence and why each step is there. Never throws.
 */
export async function applyUpdateTarget(options: ApplyUpdateTargetOptions): Promise<UpdateOutcome> {
	const installRoot = options.installRoot ?? swarmInstallRoot();
	const ctx: UpdateContext = {
		target: options.target,
		installRoot,
		stateDir: installUpdateStateDir(installRoot, options.homeDir),
		run: options.run ?? runCommand,
		now: options.now ?? (() => new Date()),
	};
	try {
		return await update(ctx);
	} catch (error) {
		// Only the filesystem writes and a caller-supplied runner can land here; both
		// happen before or around a checkout, so nothing has been half-applied that the
		// caller could act on. Say so as a refusal rather than as a stack trace.
		return refuse(
			`The SWARM install root '${installRoot}' was left unchanged: ${describeError(error)}. ` +
				'Check that the directory is a readable git checkout and that ~/.swarm is writable.',
		);
	}
}

async function update(ctx: UpdateContext): Promise<UpdateOutcome> {
	const parsed = WorkerUpdateTargetSchema.safeParse(ctx.target);
	if (!parsed.success) {
		return refuse(
			`Update target ${describeTarget(ctx.target)} was refused: it ` +
				`${parsed.error.issues[0]?.message ?? 'is not a valid ref'}. A target names a branch, ` +
				'a tag, or a commit — never a command, a script, a URL, or a git option.',
		);
	}
	const target = parsed.data;

	const currentCommit = await gitRead(ctx, ['rev-parse', 'HEAD'], GIT_READ_TIMEOUT_MS);
	if (!currentCommit) {
		return refuse(
			`The SWARM install root '${ctx.installRoot}' is not a readable git checkout, so there is ` +
				'no commit to update from. Updates only apply to an install run from a git clone.',
		);
	}

	const status = await ctx.run(git(ctx, ['status', '--porcelain'], GIT_READ_TIMEOUT_MS));
	if (status.exitCode !== 0) {
		return refuse(
			`git could not report the state of the SWARM install root '${ctx.installRoot}', so it ` +
				'cannot be shown to be safe to update. Check the checkout by hand.',
		);
	}
	if (status.stdout.trim() !== '') {
		return refuse(
			`The SWARM install root '${ctx.installRoot}' has uncommitted changes. That is an ` +
				'operator working copy, and an update must never overwrite one — commit, stash, or ' +
				'discard the changes first.',
		);
	}

	const stored = readState(ctx.stateDir);
	if (stored === undefined) {
		return refuse(
			`The update state for the SWARM install root '${ctx.installRoot}' is unreadable ` +
				`(${join(ctx.stateDir, STATE_FILE)}), so the last known good commit cannot be ` +
				'established. Inspect or remove that file before updating.',
		);
	}

	const tracking = await resolveTracking(ctx, stored);
	if (!tracking) {
		return refuse(
			`The SWARM install root '${ctx.installRoot}' has a detached HEAD and no recorded ` +
				'tracked branch, so there is no branch to authorize a target against. Check out the ' +
				'branch this install should follow, then retry.',
		);
	}
	recordTracking(ctx, stored, tracking, currentCommit);

	// No refspec and no URL: what is fetched is whatever this remote's own config
	// already says, which is the literal form of "only its own configured remote".
	const fetched = await ctx.run(git(ctx, ['fetch', tracking.remote], GIT_FETCH_TIMEOUT_MS));
	if (fetched.exitCode !== 0) {
		return refuse(
			`Fetching remote '${tracking.remote}' for the SWARM install root '${ctx.installRoot}' ` +
				'failed, so the requested build may not be on this machine. Check the network and the ' +
				"remote's credentials, then retry.",
		);
	}

	const commit = await resolveTargetCommit(ctx, tracking.remote, target);
	if (!commit) {
		return refuse(
			`Update target '${target}' does not name a branch, tag, or commit known to the SWARM ` +
				`install root '${ctx.installRoot}' after fetching '${tracking.remote}'. Push it, or ` +
				'name one that exists.',
		);
	}

	const trackedRef = `refs/remotes/${tracking.remote}/${tracking.branch}`;
	const reachable = await ctx.run(
		git(ctx, ['merge-base', '--is-ancestor', commit, trackedRef], GIT_READ_TIMEOUT_MS),
	);
	if (reachable.exitCode !== 0) {
		return refuse(
			`Update target '${target}' (${commit}) is not reachable from '${trackedRef}', the branch ` +
				`the SWARM install root '${ctx.installRoot}' follows. A machine is only ever moved to ` +
				'code already on the branch it tracks. Merge it there first.',
		);
	}

	if (commit === currentCommit) return { status: 'already-current', commit };

	// Written before the checkout on purpose: a process killed mid-apply must still
	// leave behind the commit to go back to.
	const applying: InstallUpdateState = {
		installRoot: ctx.installRoot,
		remote: tracking.remote,
		trackedBranch: tracking.branch,
		lastKnownGood: currentCommit,
		target,
		targetCommit: commit,
		appliedAt: ctx.now().toISOString(),
		// Nothing is being verified while an apply is in flight: this process was asked
		// for an update over a socket it had handshaked on, which is precisely what
		// promotes whatever was outstanding. A record surviving that is stale.
		pendingVerification: null,
	};
	writeState(ctx.stateDir, applying);

	logger.info('Applying SWARM install update', {
		installRoot: ctx.installRoot,
		target,
		commit,
		previousCommit: currentCommit,
	});
	const outcome = await applyCommit(ctx, currentCommit, commit);
	if (outcome.status === 'applied') {
		// The build is on disk but unproved: the daemon that will run it has not started
		// yet, let alone handshaked. Recorded now so the *next* process finds the question
		// already asked (issue #934).
		writeState(ctx.stateDir, {
			...applying,
			pendingVerification: {
				commit,
				previousCommit: currentCommit,
				failedStarts: 0,
				startedAt: ctx.now().toISOString(),
			},
		});
	}
	return outcome;
}

/**
 * The branch this install follows: read from git while HEAD is attached, and from
 * the recorded state once an applied update has detached it. Git wins when both
 * answer, so re-attaching HEAD to a different branch is picked up rather than
 * shadowed by a stale record.
 */
async function resolveTracking(
	ctx: UpdateContext,
	stored: InstallUpdateState | null,
): Promise<{ remote: string; branch: string } | null> {
	return (
		(await readUpstream(ctx)) ??
		(stored ? { remote: stored.remote, branch: stored.trackedBranch } : null)
	);
}

/**
 * The upstream's two parts, one per line — git's own name for the remote, then the
 * ref on it. `%0a` is git's newline escape, and neither field can contain one.
 */
const UPSTREAM_FORMAT = '%(upstream:remotename)%0a%(upstream:remoteref)';
const BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * The remote and branch an attached HEAD follows, asked of git **by field** rather
 * than split out of its abbreviated `<remote>/<branch>` form. That form is ambiguous
 * and splitting it at the first slash was wrong: git accepts a remote whose own name
 * contains a slash, so a `team/origin` remote read back as remote `team` tracking
 * branch `origin/main`, and the fetch then named a remote that does not exist.
 * `%(upstream:remotename)` is git answering the same question unambiguously.
 */
async function readUpstream(
	ctx: UpdateContext,
): Promise<{ remote: string; branch: string } | null> {
	// Detached — which is what an applied update leaves behind. The caller falls back
	// to the recorded branch rather than guessing one.
	const headRef = await gitRead(ctx, ['symbolic-ref', '--quiet', 'HEAD'], GIT_READ_TIMEOUT_MS);
	if (!headRef) return null;
	const fields = await gitRead(
		ctx,
		['for-each-ref', `--format=${UPSTREAM_FORMAT}`, headRef],
		GIT_READ_TIMEOUT_MS,
	);
	const [remote, remoteRef] = (fields ?? '').split('\n');
	// `.` is git's name for this repository as an upstream: a branch tracking a sibling
	// local branch has no remote to fetch, so it is no more an answer than none at all.
	if (!remote || remote === '.') return null;
	if (!remoteRef?.startsWith(BRANCH_REF_PREFIX)) return null;
	return { remote, branch: remoteRef.slice(BRANCH_REF_PREFIX.length) };
}

/** Persist a newly learned (or changed) tracked branch, so the next detached run has one. */
function recordTracking(
	ctx: UpdateContext,
	stored: InstallUpdateState | null,
	tracking: { remote: string; branch: string },
	currentCommit: string,
): void {
	if (
		stored &&
		stored.remote === tracking.remote &&
		stored.trackedBranch === tracking.branch &&
		stored.installRoot === ctx.installRoot
	) {
		return;
	}
	writeState(ctx.stateDir, {
		installRoot: ctx.installRoot,
		remote: tracking.remote,
		trackedBranch: tracking.branch,
		// With no record yet, the commit an attached, clean HEAD is on *is* the build
		// this machine is running, so it is the one to fall back to.
		lastKnownGood: stored?.lastKnownGood ?? currentCommit,
		target: stored?.target ?? null,
		targetCommit: stored?.targetCommit ?? null,
		appliedAt: stored?.appliedAt ?? null,
		pendingVerification: stored?.pendingVerification ?? null,
	});
}

/**
 * The commit a target names. The remote namespace is tried first so a branch name
 * means the branch just fetched rather than a stale local ref of the same name; the
 * plain form is what resolves a tag or a raw commit id.
 *
 * Neither invocation can be read as an option: the schema guarantees the target
 * starts with an alphanumeric.
 */
async function resolveTargetCommit(
	ctx: UpdateContext,
	remote: string,
	target: string,
): Promise<string | null> {
	const args = (ref: string) => ['rev-parse', '--verify', `${ref}^{commit}`];
	return (
		(await gitRead(ctx, args(`refs/remotes/${remote}/${target}`), GIT_READ_TIMEOUT_MS)) ??
		(await gitRead(ctx, args(target), GIT_READ_TIMEOUT_MS))
	);
}

/**
 * Put the install root on `commit` and make it runnable there — the three steps an
 * apply, a rollback and a return to the last known good build all share, in the one
 * order they may run in. Answers the first step that failed, or `null` when all
 * three succeeded.
 */
async function buildAt(
	ctx: InstallContext,
	commit: string,
): Promise<{ stage: UpdateFailureStage; result: UpdateCommandResult } | null> {
	const checkout = await ctx.run(
		git(ctx, ['checkout', '--detach', commit], GIT_CHECKOUT_TIMEOUT_MS),
	);
	if (checkout.exitCode !== 0) return { stage: 'checkout', result: checkout };
	const install = await ctx.run(npm(ctx, ['ci']));
	if (install.exitCode !== 0) return { stage: 'install', result: install };
	const build = await ctx.run(npm(ctx, ['run', 'build']));
	if (build.exitCode !== 0) return { stage: 'build', result: build };
	return null;
}

/** What failed, in the words the operator-facing `reason` is built from. */
function describeStage(stage: UpdateFailureStage, commit: string): string {
	switch (stage) {
		case 'checkout':
			return `git could not check out ${commit}`;
		case 'install':
			return "'npm ci' failed";
		case 'build':
			return "'npm run build' failed";
	}
}

async function applyCommit(
	ctx: UpdateContext,
	previousCommit: string,
	commit: string,
): Promise<UpdateOutcome> {
	const failed = await buildAt(ctx, commit);
	if (failed) {
		return failure(
			ctx,
			failed.stage,
			previousCommit,
			failed.result,
			describeStage(failed.stage, commit),
		);
	}
	return { status: 'applied', commit, previousCommit };
}

async function failure(
	ctx: UpdateContext,
	stage: UpdateFailureStage,
	previousCommit: string,
	result: UpdateCommandResult,
	what: string,
): Promise<UpdateOutcome> {
	const rolledBack = await rollBack(ctx, stage, previousCommit);
	if (!rolledBack) {
		logger.error('SWARM install update failed and could not be rolled back', {
			installRoot: ctx.installRoot,
			stage,
			previousCommit,
		});
	}
	return {
		status: 'failed',
		stage,
		reason:
			`${what} in the SWARM install root '${ctx.installRoot}'. ` +
			(rolledBack
				? `The install root is back on ${previousCommit} and rebuilt there.`
				: `The install root could NOT be returned to ${previousCommit} — it is on neither ` +
					'build and needs an operator: check it out by hand and re-run `npm ci && npm run build`.'),
		rolledBack,
		previousCommit,
		outputTail: tailOf(result),
	};
}

/** Put the install root back on `previousCommit` and rebuild it there. */
async function rollBack(
	ctx: UpdateContext,
	stage: UpdateFailureStage,
	previousCommit: string,
): Promise<boolean> {
	// A checkout that failed usually never moved HEAD, and nothing under `dist/` was
	// touched — so reinstalling and rebuilding would cost minutes to reach the state
	// the tree is already in. Ask git where HEAD actually is rather than assume it.
	if (stage === 'checkout') {
		const head = await gitRead(ctx, ['rev-parse', 'HEAD'], GIT_READ_TIMEOUT_MS);
		if (head === previousCommit) return true;
	}
	return (await buildAt(ctx, previousCommit)) === null;
}

// --- Verifying an applied build (issue #934) -------------------------------

/** Which install root a state transition is about. Both default the way an apply does. */
export interface InstallStateOptions {
	/** Defaults to {@link swarmInstallRoot} — see the module header for why that anchor. */
	installRoot?: string;
	/** Injectable so tests never touch the real home directory. */
	homeDir?: string;
}

export interface ReturnToLastKnownGoodOptions extends InstallStateOptions {
	run?: CommandRunner;
}

/** Which step of a return failed — an apply's three, plus clearing the record afterwards. */
export type ReturnFailureStage = UpdateFailureStage | 'record';

/** What became of a return to the last known good build. Never thrown, like {@link UpdateOutcome}. */
export type ReturnOutcome =
	| { status: 'returned'; commit: string; abandonedCommit: string }
	/** There was no applied build awaiting proof, so there was nothing to return from. */
	| { status: 'nothing-pending' }
	| { status: 'failed'; stage: ReturnFailureStage; reason: string; outputTail: string };

/**
 * The applied build this machine is still proving, or `null` — including when the
 * state file is missing or unreadable, since neither says anything about a build.
 */
export function readPendingVerification(
	options: InstallStateOptions = {},
): PendingVerification | null {
	return readState(stateDirFor(options))?.pendingVerification ?? null;
}

/**
 * Count one start of a build that has not handshaked yet, and answer with the record
 * as it now stands — or `null` when nothing is being verified, which is the ordinary
 * case on every machine that has not just been updated.
 *
 * Counting at *start* rather than on an observed failure is what makes this work at
 * all: the failure being guarded against can be a build that dies before reaching
 * any code that could report it. The count is therefore optimistic — it is undone by
 * {@link recordSuccessfulHandshake} the moment the build proves itself — and it is
 * on disk before the caller does anything else, so a process killed a millisecond
 * later has still advanced it.
 *
 * Never throws: a state directory that cannot be written leaves the machine counting
 * nothing rather than crash-looping on the write, which is the safe direction for a
 * mechanism whose whole job is to end a crash loop.
 */
export function recordFailedStart(options: InstallStateOptions = {}): PendingVerification | null {
	const stateDir = stateDirFor(options);
	const state = readState(stateDir);
	if (!state?.pendingVerification) return null;
	const pendingVerification: PendingVerification = {
		...state.pendingVerification,
		failedStarts: state.pendingVerification.failedStarts + 1,
	};
	if (!tryWriteState(stateDir, { ...state, pendingVerification })) return null;
	return pendingVerification;
}

/**
 * Promote the build being verified: it handshaked, so it is this machine's last
 * known good one and there is nothing left outstanding. Answers the commit promoted,
 * or `null` when nothing was pending.
 *
 * Idempotent by construction — the record it consumes is gone afterwards — because
 * the caller fires on every session a daemon establishes, not only the first.
 */
export function recordSuccessfulHandshake(options: InstallStateOptions = {}): string | null {
	const stateDir = stateDirFor(options);
	const state = readState(stateDir);
	if (!state?.pendingVerification) return null;
	const promoted = state.pendingVerification.commit;
	if (!tryWriteState(stateDir, { ...state, lastKnownGood: promoted, pendingVerification: null }))
		return null;
	logger.info('SWARM install update verified — promoting it to last known good', {
		installRoot: state.installRoot,
		commit: promoted,
		previousCommit: state.pendingVerification.previousCommit,
	});
	return promoted;
}

/**
 * Put the install root back on the build it was updated from, and forget the one it
 * was updated to.
 *
 * The same three steps an apply runs, aimed at `lastKnownGood` — which is still the
 * commit the machine was last *proved* on, because promotion is what moves it. The
 * record is cleared only once the build succeeds: a return that failed halfway must
 * not leave the next start believing the abandoned build is worth promoting.
 */
export async function returnToLastKnownGood(
	options: ReturnToLastKnownGoodOptions = {},
): Promise<ReturnOutcome> {
	const installRoot = options.installRoot ?? swarmInstallRoot();
	const stateDir = installUpdateStateDir(installRoot, options.homeDir);
	const ctx: InstallContext = { installRoot, stateDir, run: options.run ?? runCommand };
	try {
		const state = readState(stateDir);
		if (!state?.pendingVerification) return { status: 'nothing-pending' };
		const { lastKnownGood, pendingVerification } = state;
		logger.warn('returning the SWARM install root to its last known good build', {
			installRoot,
			commit: lastKnownGood,
			abandonedCommit: pendingVerification.commit,
			failedStarts: pendingVerification.failedStarts,
		});
		const failed = await buildAt(ctx, lastKnownGood);
		if (failed) {
			return {
				status: 'failed',
				stage: failed.stage,
				reason:
					`${describeStage(failed.stage, lastKnownGood)} while returning the SWARM install ` +
					`root '${installRoot}' to ${lastKnownGood}. It is on neither build and needs an ` +
					'operator: check it out by hand and re-run `npm ci && npm run build`.',
				outputTail: tailOf(failed.result),
			};
		}
		writeState(stateDir, { ...state, pendingVerification: null });
		return {
			status: 'returned',
			commit: lastKnownGood,
			abandonedCommit: pendingVerification.commit,
		};
	} catch (error) {
		// In production only the filesystem write can land here — every subprocess answers
		// with an exit code rather than a rejection — so the likeliest reading is that the
		// build is in place and the record that would send the next start back here again
		// is what could not be cleared. The message says neither more than that nor less.
		return {
			status: 'failed',
			stage: 'record',
			reason:
				`Returning the SWARM install root '${installRoot}' to its last known good build ` +
				`(${describeError(error)}) did not complete, so the build it was abandoning is ` +
				'still recorded as pending. Check that ~/.swarm is writable, then inspect the ' +
				'install root by hand.',
			outputTail: '',
		};
	}
}

function stateDirFor(options: InstallStateOptions): string {
	return installUpdateStateDir(options.installRoot ?? swarmInstallRoot(), options.homeDir);
}

/**
 * `null` when there is no record yet, `undefined` when there is one and it is
 * unreadable — {@link readJson}'s two answers.
 *
 * The `pendingVerification` fallback restates the schema's own default for the type
 * system rather than for the data: `readJson` takes its shape from the schema's
 * *input* side, where a defaulted field is still optional, while the `parse` it just
 * ran has already filled it in.
 */
function readState(stateDir: string): InstallUpdateState | null | undefined {
	const stored = readJson(join(stateDir, STATE_FILE), InstallUpdateStateSchema);
	return stored ? { ...stored, pendingVerification: stored.pendingVerification ?? null } : stored;
}

/** {@link writeState}, for the callers that answer a failed write rather than raise it. */
function tryWriteState(stateDir: string, state: InstallUpdateState): boolean {
	try {
		writeState(stateDir, state);
		return true;
	} catch (error) {
		logger.warn('recording the state of the SWARM install root failed', {
			installRoot: state.installRoot,
			error: describeError(error),
		});
		return false;
	}
}

function git(ctx: InstallContext, args: string[], timeoutMs: number): UpdateCommand {
	return { command: 'git', args, cwd: ctx.installRoot, timeoutMs };
}

function npm(ctx: InstallContext, args: string[]): UpdateCommand {
	return { command: 'npm', args, cwd: ctx.installRoot, timeoutMs: NPM_TIMEOUT_MS };
}

/** A git read's trimmed stdout, or `null` when it did not answer. */
async function gitRead(
	ctx: InstallContext,
	args: string[],
	timeoutMs: number,
): Promise<string | null> {
	const result = await ctx.run(git(ctx, args, timeoutMs));
	if (result.exitCode !== 0) return null;
	const value = result.stdout.trim();
	return value === '' ? null : value;
}

function refuse(reason: string): UpdateOutcome {
	return { status: 'refused', reason };
}

/**
 * A rejected target, quoted safely: bounded and stripped of control characters, so
 * echoing what was asked for cannot itself smuggle escape sequences into a log line
 * or a report.
 */
function describeTarget(target: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
	const printable = target.replace(/[\u0000-\u001f\u007f]/g, '?');
	return `'${printable.length > 60 ? `${printable.slice(0, 60)}…` : printable}'`;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function tailOf(result: UpdateCommandResult): string {
	const combined = `${result.stdout}${result.stderr}`.trim();
	return combined.length > OUTPUT_TAIL_CHARS ? combined.slice(-OUTPUT_TAIL_CHARS) : combined;
}

function writeState(stateDir: string, state: InstallUpdateState): void {
	mkdirSync(stateDir, { recursive: true });
	const path = join(stateDir, STATE_FILE);
	const temp = `${path}.${process.pid}.tmp`;
	// Temp file + rename, the way `../worktree/checkout-lock.ts` writes `owner.json`:
	// a reader never sees a half-written record, however the writer dies.
	writeFileSync(temp, `${JSON.stringify(state)}\n`, 'utf8');
	renameSync(temp, path);
}

/**
 * The production runner: `execFile` with an argv array — never a shell and never
 * string interpolation — and never a rejection, so every failure reaches the
 * sequence above as an exit code it can attribute to a stage.
 */
const runCommand: CommandRunner = async (command) => {
	try {
		const { stdout, stderr } = await execFileAsync(command.command, command.args, {
			cwd: command.cwd,
			timeout: command.timeoutMs,
			maxBuffer: MAX_OUTPUT_BYTES,
			// A fetch that wants credentials must fail rather than block on a prompt no
			// operator is watching — this runs unattended by construction.
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
		});
		return { exitCode: 0, stdout, stderr };
	} catch (error) {
		const failed = error as { code?: number | string; stdout?: string; stderr?: string };
		return {
			exitCode: typeof failed.code === 'number' ? failed.code : 1,
			stdout: failed.stdout ?? '',
			stderr: failed.stderr || describeError(error),
		};
	}
};
