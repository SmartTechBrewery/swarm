/**
 * Moving one machine's SWARM **install root** to a requested build — or leaving it
 * exactly as it was and saying why (issue #920).
 *
 * This is the host-local half of worker self-update and nothing else: it never
 * exits the process, and it never decides *when* an update is safe for this daemon.
 * Its caller does (`../transport/worker-update.ts`, issue #933) — the opt-in, the
 * wait for an idle daemon, and the restart all live there.
 *
 * What it *does* decide is whether the update is safe for the **machine** (issue
 * #935), because that question belongs to the install root rather than to any one
 * daemon. Several daemons sharing one npm-linked checkout is the control-plane
 * host's real shape, so this module takes the machine-local exclusive lock on the
 * install root before it fetches (`../worktree/install-lock.ts`), and refuses outright
 * — just before the checkout, where code is actually replaced — while a peer daemon is
 * mid-phase.
 *
 * **A daemon that loses that lock waits for the holder** (issue #973), because holding
 * it afterwards is the only proof the holder's fetch and build are over. When the
 * install root's own record shows a *completed* apply landed the target it was asked
 * for, it answers `already-current` for that build with no fetch of its own, so one
 * machine fetches and builds exactly once however many daemons were asked. That answer
 * is a promise its caller acts on: the install root is on the target *and* this machine
 * finished putting it there — never that HEAD merely moved, and never that somebody
 * simply held the lock. A holder that landed nothing — one that refused, one whose own
 * fetch failed, one returning the machine to its last known good build — leaves the
 * follower to run the ordinary fetching update for itself rather than to report a
 * success the machine did not earn.
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
import {
	acquireInstallLock,
	describeInstallParticipant,
	findBusyInstallPeer,
	InstallHeldError,
	type InstallHostOptions,
	type InstallLock,
	installUpdateStateDir,
} from '../worktree/install-lock.js';
import { readJson } from '../worktree/local-lock.js';

// Re-exported from where the lock and the participant registry also derive it, so the
// three things that live under one install root's state directory cannot disagree
// about which directory that is (the reason `../worktree/checkout-key.ts` exists one
// scope down). Callers still ask this module for it.
export { installUpdateStateDir };

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
	/**
	 * How many *peer* daemons on this install root adopted this build and are each
	 * about to restart into it once (issue #973).
	 *
	 * It is here because the counter above is a fact about the install root while the
	 * budget it is judged against is a fact about a daemon: the state directory is keyed
	 * on the install root alone, so on a shared one every peer's ordinary restart lands
	 * on the same `failedStarts`, and three daemons coming up healthily would spend a
	 * three-start budget between them and roll the machine back off a build that was
	 * working. Each adopter records itself here as it takes its licence to restart, so
	 * it buys exactly the one start it is about to make and the budget keeps measuring
	 * what it was written to measure — one daemon failing N starts in a row.
	 *
	 * Defaulted rather than required, so a record written before issue #973 parses as
	 * "nobody adopted this", which is what a single-daemon machine always reports.
	 */
	adoptingPeers: z.number().int().min(0).default(0),
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

/**
 * How long a daemon on its way *down* waits for the install lock before it gives up.
 * Brief on purpose: a {@link returnToLastKnownGood} is a daemon abandoning a build it
 * cannot run, so a longer wait only lengthens an outage — the loser stays down, says
 * so, and by its next start the winner has cleared the record (issue #934).
 */
export const INSTALL_LOCK_WAIT_MS = 5_000;

/**
 * How long a daemon waits for the peer that is moving the install root, before it
 * gives up and refuses.
 *
 * Long, where the return path's wait above is brief, because the two want opposite
 * things: a return is a daemon on its way down, while an *apply* on a shared install
 * root wants the loser to still be here when the winner finishes — holding this lock
 * afterwards is the only proof the `npm ci` and the build are over, and that proof is
 * what lets a peer restart onto the build rather than onto a half-written tree
 * (issue #973).
 *
 * Derived from this module's own step timeouts rather than picked: one fetch, one
 * checkout and the two `npm` steps is the longest apply it can run. A holder that
 * *died* never costs this — the lock is reclaimable on liveness — and a holder still
 * going after it has left the install root on neither this daemon's target nor
 * anything else, which waiting longer cannot improve.
 */
export const INSTALL_LOCK_FOLLOW_WAIT_MS =
	GIT_FETCH_TIMEOUT_MS + GIT_CHECKOUT_TIMEOUT_MS + 2 * NPM_TIMEOUT_MS;

/** How often that wait re-tries the lock. */
const INSTALL_LOCK_POLL_MS = 500;

/** What this process is, on the machine whose install root it is about to move. */
export interface InstallHostIdentity {
	hostname?: string;
	pid?: number;
	isPidLive?: (pid: number) => boolean;
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
	/** Injectable so a test can stand in for a second daemon sharing this install root. */
	host?: InstallHostIdentity;
	/** Defaults to {@link INSTALL_LOCK_FOLLOW_WAIT_MS}; `0` refuses to a holder immediately. */
	lockWaitMs?: number;
}

/** One install root, and the injectable things every step here needs. */
interface InstallContext {
	installRoot: string;
	stateDir: string;
	run: CommandRunner;
	/** Everything the lock and the participant registry are addressed with. */
	host: InstallHostOptions;
	lockWaitMs: number;
}

interface UpdateContext extends InstallContext {
	target: string;
	now: () => Date;
}

/** The one options bag both the lock and the participant registry take. */
function hostOptionsFor(options: {
	homeDir?: string;
	host?: InstallHostIdentity;
	now: () => Date;
}): InstallHostOptions {
	return { ...options.host, homeDir: options.homeDir, now: () => options.now().getTime() };
}

/**
 * Move `installRoot` to `target`, or leave it exactly as it is.
 *
 * See the module header for the sequence and why each step is there. Never throws.
 */
export async function applyUpdateTarget(options: ApplyUpdateTargetOptions): Promise<UpdateOutcome> {
	const installRoot = options.installRoot ?? swarmInstallRoot();
	const now = options.now ?? (() => new Date());
	const ctx: UpdateContext = {
		target: options.target,
		installRoot,
		stateDir: installUpdateStateDir(installRoot, options.homeDir),
		run: options.run ?? runCommand,
		now,
		host: hostOptionsFor({ homeDir: options.homeDir, host: options.host, now }),
		lockWaitMs: options.lockWaitMs ?? INSTALL_LOCK_FOLLOW_WAIT_MS,
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

	// Read while HEAD is still attached, which is the only window git can answer it in
	// — a peer's apply leaves HEAD detached, so re-reading this under the lock below
	// would fall back to the recorded state and learn strictly less. That is the one
	// deliberate exemption from "re-read everything under the lock": the tracked branch
	// is not something a peer's apply can change, since the only writer of the record
	// is `recordTracking`, which writes back what it read from this same checkout.
	const tracking = await resolveTracking(ctx, stored);
	if (!tracking) {
		return refuse(
			`The SWARM install root '${ctx.installRoot}' has a detached HEAD and no recorded ` +
				'tracked branch, so there is no branch to authorize a target against. Check out the ' +
				'branch this install should follow, then retry.',
		);
	}

	// From here on this daemon is about to touch the install root itself, which on a
	// shared install is the machine's rather than its own (issue #935). Everything
	// above was a read.
	let acquired: { lock: InstallLock; followedPeer: boolean };
	try {
		acquired = await takeInstallLock(ctx);
	} catch (error) {
		if (!(error instanceof InstallHeldError)) throw error;
		return refuseToHolder(ctx, target, error);
	}
	try {
		return await updateLocked(ctx, tracking, target, acquired.followedPeer);
	} finally {
		acquired.lock.release();
	}
}

/**
 * Take the machine-local lock, re-trying for {@link InstallContext.lockWaitMs} before
 * giving up, and say whether the wait was actually spent behind somebody.
 *
 * The wait is not a tie-break between two operators asking at the same second: it is
 * how a daemon lets the peer that is moving *its own* install root finish, so that it
 * can then see what that peer landed (issue #973). `followedPeer` is that fact and
 * only that fact — the tree this daemon now owns *may* have moved under it while it
 * queued. What actually moved is a question for the install root's own record, which
 * is why {@link adoptPeerBuild} asks that rather than this flag.
 */
async function takeInstallLock(
	ctx: InstallContext,
): Promise<{ lock: InstallLock; followedPeer: boolean }> {
	// Wall clock, not the injected one: this is a real pause, not a judgement about a
	// record's age.
	const deadline = Date.now() + ctx.lockWaitMs;
	let followedPeer = false;
	for (;;) {
		try {
			return { lock: acquireInstallLock(ctx.installRoot, ctx.host), followedPeer };
		} catch (error) {
			if (!(error instanceof InstallHeldError) || Date.now() >= deadline) throw error;
			followedPeer = true;
			await sleep(INSTALL_LOCK_POLL_MS);
		}
	}
}

/**
 * What a daemon that waited out {@link ApplyUpdateTargetOptions.lockWaitMs} and still
 * could not get in answers: the holder's own refusal, naming that daemon.
 *
 * It does **not** re-read the commit and call that `already-current`, which is what it
 * used to do. That reading proved nothing: `buildAt` checks out *first*, so HEAD reaches
 * the target while `node_modules` and `dist` are still half-written, and a peer restarting
 * on the strength of it would restart onto a tree nobody has finished building. Since
 * `already-current` is now a peer's licence to restart (issue #973), the only honest answer
 * from outside the lock is "this machine could not bring me over — here is who has it".
 */
function refuseToHolder(ctx: UpdateContext, target: string, held: InstallHeldError): UpdateOutcome {
	logger.warn('refusing a SWARM install update to the daemon holding the install root', {
		installRoot: ctx.installRoot,
		target,
		lockDir: held.lockDir,
		holderPid: held.holder?.pid ?? null,
		holderWorkerId: held.holder?.workerId ?? null,
	});
	return refuse(held.message);
}

/** The half of an update that runs with the machine-local lock held. */
async function updateLocked(
	ctx: UpdateContext,
	tracking: { remote: string; branch: string },
	target: string,
	followedPeer: boolean,
): Promise<UpdateOutcome> {
	// Everything this half acts on is read *now*, with the install root ours: the
	// pre-lock reading describes a tree a peer may have moved through a whole apply
	// while this daemon waited, and acting on it would fetch and build a second time
	// what the machine already has (issue #973). It is the rule
	// `returnToLastKnownGood` already states for itself, for the same reason.
	const head = await gitRead(ctx, ['rev-parse', 'HEAD'], GIT_READ_TIMEOUT_MS);
	if (!head) {
		return refuse(
			`The SWARM install root '${ctx.installRoot}' stopped answering as a git checkout while ` +
				'this daemon held the machine-local update lock, so nothing was changed. Inspect the ' +
				'checkout by hand.',
		);
	}
	const state = readState(ctx.stateDir);
	if (state === undefined) {
		return refuse(
			`The update state for the SWARM install root '${ctx.installRoot}' became unreadable ` +
				`(${join(ctx.stateDir, STATE_FILE)}), so the last known good commit cannot be ` +
				'established. Inspect or remove that file before updating.',
		);
	}
	// Written here rather than before the lock, because it *is* a write to the record
	// the holder mutates across its whole apply: a daemon that recorded the tracked
	// branch on its way to a lock it then waited minutes for would be writing over
	// whatever the holder had reached.
	recordTracking(ctx, state, tracking, head);

	if (followedPeer) {
		// `null` is "the daemon I queued behind landed nothing here" — it refused, it was
		// returning the install root to its last known good build, or it found the machine
		// already where it was asked to put it. None of those moved the tree, and none of
		// them fetched anything this daemon may rely on, so the only honest thing left is
		// to do the ordinary update below for itself (issue #973).
		const adopted = await adoptPeerBuild(ctx, state, tracking, target, head);
		if (adopted) return adopted;
	}

	// --- nothing landed a build on this install root while this daemon waited ---

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

	if (commit === head) return { status: 'already-current', commit };

	// Only now, and for the first time, is this daemon about to replace code a peer may
	// be executing: a peer loaded from this same install root and running a phase would
	// have it swapped underneath it. The remedy is an operator act by design (`swarm
	// workers drain`), so the refusal names the worker to drain rather than waiting.
	//
	// The guard sits *here* rather than in front of the fetch (issue #973) because a
	// fetch writes remote-tracking refs and swaps nothing, while refusing above the
	// short-circuit would refuse a daemon that needed only to notice the machine is
	// already on the target — which is the whole of a peer's update.
	const busy = findBusyInstallPeer(ctx.installRoot, ctx.host);
	if (busy) {
		return refuse(
			`${describeInstallParticipant(busy)} is running a phase from the SWARM install root ` +
				`'${ctx.installRoot}', which this daemon shares with it, so nothing was changed. ` +
				'Updating it now would swap the code under that run. Drain that worker, wait for it ' +
				'to go idle, and re-issue this update.',
		);
	}

	// Written before the checkout on purpose: a process killed mid-apply must still
	// leave behind the commit to go back to.
	const applying: InstallUpdateState = {
		installRoot: ctx.installRoot,
		remote: tracking.remote,
		trackedBranch: tracking.branch,
		lastKnownGood: head,
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
		previousCommit: head,
	});
	const outcome = await applyCommit(ctx, head, commit);
	if (outcome.status === 'applied') {
		// The build is on disk but unproved: the daemon that will run it has not started
		// yet, let alone handshaked. Recorded now so the *next* process finds the question
		// already asked (issue #934).
		writeState(ctx.stateDir, {
			...applying,
			pendingVerification: {
				commit,
				previousCommit: head,
				failedStarts: 0,
				adoptingPeers: 0,
				startedAt: ctx.now().toISOString(),
			},
		});
	}
	return outcome;
}

/**
 * What a daemon answers once the peer that was moving this install root has finished
 * (issue #973) — or `null` when that peer landed nothing here, in which case the
 * caller does the ordinary fetching update for itself.
 *
 * **The question is what the install root's own record says, never that somebody held
 * the lock.** Waiting proves only that a peer was *in* here; it says nothing about
 * what that peer did, and the three things it most often did — refuse, return the
 * machine to its last known good build, or find it already where it was asked to put
 * it — leave the tree exactly as this daemon found it and leave the remote-tracking
 * refs exactly as stale as they were. Adopting on the wait alone would report success
 * for a machine that never moved: a holder whose `git fetch` failed refuses without
 * refreshing a ref, and a follower resolving `refs/remotes/<remote>/<target>` off
 * disk would then find HEAD, call it the target, and settle a rollout member as done
 * on a build the machine is not running.
 *
 * So the evidence is `pendingVerification` naming HEAD: the holder writes `applying`
 * with `pendingVerification: null` *before* it checks anything out and only a
 * successful `applyCommit` fills it in, so a record naming the commit HEAD is on is
 * the one thing that says "a completed apply put this here". It is also necessarily
 * *recent* — an update request arrives over a socket this daemon handshaked on, and a
 * handshake is what clears the record — so it cannot be an old apply's leftovers.
 *
 * On that evidence, and only then, this does **not** fetch: the holder's own `git
 * fetch` ran in this very checkout, so its remote-tracking refs are this daemon's
 * too, which is what makes "an update fetches and builds exactly once on a machine"
 * literally true for the daemons asked together.
 *
 * The two answers that are not an adoption:
 *
 * - **Refused**, when a completed apply landed something *else* — a peer asked for a
 *   different ref. Re-running the same fetch and build behind it would fight it.
 * - **Refused**, when HEAD is on neither the build awaiting proof nor the one last
 *   proved. That is the half-written tree — a holder that died between its `git
 *   checkout` and its `npm ci` — and it is exactly what nothing may restart onto.
 *
 * Everything else falls through to the ordinary update. That is deliberately the
 * safe direction for the case this cannot tell apart: a peer whose apply *failed* has
 * rolled the tree back to the commit it was on, which is indistinguishable on disk
 * from a peer that returned the machine to its last known good build, and refusing
 * both would refuse a daemon that could have applied. One wasted rebuild behind a
 * broken build is cheaper than a machine left behind, and the lock serializes them.
 *
 * No ancestry check on the adopting path: nothing is being moved. The code is already
 * on disk and this daemon's supervisor will load it whenever it next restarts, so
 * re-asking `merge-base` here could refuse nothing it has not already lost.
 */
async function adoptPeerBuild(
	ctx: UpdateContext,
	state: InstallUpdateState | null,
	tracking: { remote: string; branch: string },
	target: string,
	head: string,
): Promise<UpdateOutcome | null> {
	if (state?.pendingVerification && state.pendingVerification.commit === head) {
		const awaiting = state.pendingVerification;
		const landed = await resolveTargetCommit(ctx, tracking.remote, target);
		if (landed !== head) {
			return refuse(
				`The SWARM install root '${ctx.installRoot}' is on ${head}, not on a finished build ` +
					`of the target this daemon was asked for ('${target}'), after the daemon that was ` +
					"moving it finished. Nothing was changed here. Read that daemon's own outcome, " +
					'then re-issue this update.',
			);
		}
		logger.info('adopting the build a peer daemon landed in this SWARM install root', {
			installRoot: ctx.installRoot,
			target,
			commit: head,
		});
		// Taken here, under the lock, because this *is* the licence to restart: the start
		// this daemon is about to make lands on the same install-root-keyed record the
		// applier's own restart does, and counting it against the applier's budget is what
		// would roll a healthy machine back (see `adoptingPeers`). Best-effort, like every
		// other write to this record — a machine that cannot write its state should not
		// fail an update over it.
		tryWriteState(ctx.stateDir, {
			...state,
			pendingVerification: { ...awaiting, adoptingPeers: awaiting.adoptingPeers + 1 },
		});
		return { status: 'already-current', commit: head };
	}
	// Nothing on this machine is awaiting proof, so no apply completed here while this
	// daemon queued. The install root is then either on the build this machine last
	// proved — nothing moved, decide for ourselves below — or on something no daemon
	// here ever finished putting there, which is the half-written tree.
	if ((state?.lastKnownGood ?? head) === head) return null;
	return refuse(
		`The SWARM install root '${ctx.installRoot}' is on ${head}, which is neither the build ` +
			'this machine last proved nor one a daemon here finished applying, after the daemon ' +
			'that was moving it finished — so it may be a tree that was checked out and never ' +
			'built. Nothing was changed here. Inspect the install root, then re-issue this update.',
	);
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
	now?: () => Date;
	/** Injectable so a test can stand in for a second daemon sharing this install root. */
	host?: InstallHostIdentity;
	/** Defaults to {@link INSTALL_LOCK_WAIT_MS}; `0` gives up on the lock immediately. */
	lockWaitMs?: number;
}

/**
 * Which step of a return failed — an apply's three, plus clearing the record
 * afterwards, plus the machine-local lock a shared install root is moved under.
 */
export type ReturnFailureStage = UpdateFailureStage | 'record' | 'lock';

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
 *
 * It moves the install root, so it takes the same machine-local lock an apply does
 * (issue #935): on a shared install root every daemon meets the same unproved build,
 * so without it four of them would run four checkouts and four `npm ci`s over each
 * other. It does **not** check for a busy peer — a machine that cannot connect has to
 * recover, and blocking that on a peer's phase would leave it down for good. The
 * daemon that loses the lock stays down and says so; by its next start the winner has
 * cleared the record, so it simply starts on the good build.
 *
 * Everything it acts on is read *after* the lock is held, for the same reason: a peer
 * that lands a newer build while this daemon queues leaves the pre-lock reading
 * describing an install root that no longer exists. When the build awaiting proof is no
 * longer the one this daemon set out to abandon, that is `nothing-pending` — someone
 * else's newer build is not this one's to roll back.
 */
export async function returnToLastKnownGood(
	options: ReturnToLastKnownGoodOptions = {},
): Promise<ReturnOutcome> {
	const installRoot = options.installRoot ?? swarmInstallRoot();
	const stateDir = installUpdateStateDir(installRoot, options.homeDir);
	const now = options.now ?? (() => new Date());
	const ctx: InstallContext = {
		installRoot,
		stateDir,
		run: options.run ?? runCommand,
		host: hostOptionsFor({ homeDir: options.homeDir, host: options.host, now }),
		lockWaitMs: options.lockWaitMs ?? INSTALL_LOCK_WAIT_MS,
	};
	let lock: InstallLock | undefined;
	try {
		// A cheap look before the lock, so the ordinary start — nothing pending, which is
		// every start on a machine that has not just been updated — costs no lock at all.
		// It decides nothing: what it saw is re-read below, under the lock.
		const observed = readState(stateDir)?.pendingVerification;
		if (!observed) return { status: 'nothing-pending' };
		try {
			// The flag is an apply's business: a return is not following anybody, it is
			// declining to rebuild under them.
			lock = (await takeInstallLock(ctx)).lock;
		} catch (error) {
			if (!(error instanceof InstallHeldError)) throw error;
			return {
				status: 'failed',
				stage: 'lock',
				reason:
					`${error.message} This daemon is going down rather than returning the install root ` +
					'underneath it; start it again once that update has finished.',
				outputTail: '',
			};
		}
		// Re-read now that the install root is ours (issue #935). On a shared one the wait
		// above may have been spent behind a peer that applied a *newer* build and released
		// inside the window: acting on the pre-lock read would then check out a
		// `lastKnownGood` that build already superseded and overwrite its pending record,
		// rolling a good build back and erasing the note that it still needs proving.
		const state = readState(stateDir);
		const pendingVerification = state?.pendingVerification;
		if (!state || pendingVerification?.commit !== observed.commit) {
			// The build this daemon set out to abandon is no longer the one being proved, so
			// there is nothing here that this daemon is entitled to undo.
			logger.warn(
				'the build awaiting proof changed while this daemon waited for the install lock',
				{
					installRoot,
					expectedCommit: observed.commit,
					pendingCommit: pendingVerification?.commit ?? null,
				},
			);
			return { status: 'nothing-pending' };
		}
		const { lastKnownGood } = state;
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
	} finally {
		lock?.release();
	}
}

function stateDirFor(options: InstallStateOptions): string {
	return installUpdateStateDir(options.installRoot ?? swarmInstallRoot(), options.homeDir);
}

/**
 * `null` when there is no record yet, `undefined` when there is one and it is
 * unreadable — {@link readJson}'s two answers.
 *
 * The two fallbacks restate the schema's own defaults for the type system rather than
 * for the data: `readJson` takes its shape from the schema's *input* side, where a
 * defaulted field is still optional, while the `parse` it just ran has already filled
 * both in.
 */
function readState(stateDir: string): InstallUpdateState | null | undefined {
	const stored = readJson(join(stateDir, STATE_FILE), InstallUpdateStateSchema);
	if (!stored) return stored;
	const pending = stored.pendingVerification;
	return {
		...stored,
		pendingVerification: pending ? { ...pending, adoptingPeers: pending.adoptingPeers ?? 0 } : null,
	};
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

/** A pause between two attempts at the install lock — never the reason a process stays alive. */
function sleep(ms: number): Promise<void> {
	return new Promise((done) => {
		const timer = setTimeout(done, ms);
		timer.unref?.();
	});
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
