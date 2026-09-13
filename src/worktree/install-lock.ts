/**
 * Several daemons, one SWARM install root (issue #935).
 *
 * `../worker/self-update.ts` moves an install root to a requested build. That is
 * safe on a machine where one daemon owns its own checkout, and it is not safe on
 * the shape the control-plane host actually has: four daemons serving four *project*
 * repositories, all loading SWARM from one npm-linked checkout
 * (`ai/LOCAL_CONFIG.md`). There, two daemons asked to update at the same moment
 * would interleave a `git checkout` with an `npm ci`, and one daemon updating at all
 * would swap the code under another that is still mid-phase.
 *
 * Two records under the install root's own state directory answer those two
 * questions, and both are **host-local by construction** — the directory is keyed on
 * a local realpath, exactly as the checkout lock's is, so nothing here coordinates
 * across machines and nothing here is visible to the control plane:
 *
 * - **`update-lock/owner.json`** — the exclusive claim a daemon takes before it
 *   fetches, so only one of them moves the install root at a time. The loser does not
 *   queue behind it: it re-reads the commit and either finds the winner has already
 *   landed the build it was asked for, or reports a refusal naming the holder.
 * - **`participants/<pid>.json`** — one record per daemon running *from* this install
 *   root, carrying a `busy` flag while it holds an in-flight phase. An update reads
 *   them to refuse before anything is checked out when a peer is mid-phase.
 *
 * **Why these are separate.** The lock is about two daemons *updating*; the
 * participants are about one daemon updating while another is *working*. A lock
 * cannot answer the second question, because a peer running a phase holds nothing —
 * it is not trying to update at all.
 *
 * **Modelled on `./checkout-lock.ts`, deliberately.** Same atomic `mkdirSync` claim,
 * same pid-liveness-first / refreshed-timestamp-backstop reclaim rule, same typed
 * `…HeldError` naming the holder and the remedy, and the same predicates out of
 * `./local-lock.ts` rather than a second copy of any of them. What differs is the
 * lifetime: this lock is held across a multi-minute `npm ci` by a caller that has no
 * loop of its own, so it refreshes itself on an unref'd interval instead of asking
 * the daemon to. The participant record has no such problem — the daemon already
 * runs a refresh timer for its checkout lock — so it shares that lock's TTL and is
 * kept alive from there.
 *
 * **Reclaiming a lapsed lock is guarded**, which is the one place the shape above is
 * not enough. "Read the stale record, remove it, create our own" is three steps, and
 * two daemons that both read the *same* stale record both pass the reclaim test: the
 * second one's remove deletes the first one's freshly created claim, and both come
 * away believing they hold the install root — the precise moment two `git checkout`s
 * and two `npm ci`s would interleave. So the replacement runs inside the atomic
 * takeover guard `./host-local-runtime.ts` uses one scope down, and re-reads the owner
 * under it: the observation that sent a daemon there predates the guard, and only what
 * it sees while holding it may be removed.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { checkoutStateDir } from './checkout-key.js';
import { CHECKOUT_LOCK_TTL_MS } from './checkout-lock.js';
import { isExpired, pathOlderThan, pidIsLive, readJson } from './local-lock.js';

/**
 * How long the update lock survives without a refresh. Short for the reason the
 * checkout lock's TTL is short: it bounds how long a dead daemon's install root stays
 * blocked when its pid has been recycled, which is the only case liveness gets wrong.
 */
export const INSTALL_LOCK_TTL_MS = 15 * 60 * 1000;

/** Refresh cadence — a third of the TTL, so two refreshes may be lost before it lapses. */
export const INSTALL_LOCK_REFRESH_MS = Math.floor(INSTALL_LOCK_TTL_MS / 3);

/**
 * How long a takeover guard may stand before it is debris rather than a contender.
 * Reclaiming is a handful of syscalls, so anything older is a daemon that died inside
 * one — the same bound, for the same reason, as the guard in `./host-local-runtime.ts`.
 * Without it the guard would be the one artifact with no recovery: every later
 * acquirer refuses on sight of it and none may re-create it.
 */
export const INSTALL_TAKEOVER_GUARD_TTL_MS = 5 * 60 * 1000;

/**
 * How long a participant record survives without a refresh. Stated as the checkout
 * lock's TTL rather than as a second fifteen minutes, because the daemon keeps both
 * records fresh on **one** timer (`../transport/worker-main.ts`) — two numbers that
 * have to stay equal by hand is exactly how a cadence and a TTL drift apart.
 */
export const INSTALL_PARTICIPANT_TTL_MS = CHECKOUT_LOCK_TTL_MS;

/** Where one install root's update state lives — the `checkoutStateDir` convention, reused. */
export function installUpdateStateDir(installRoot: string, homeDir?: string): string {
	return checkoutStateDir('install-updates', installRoot, homeDir);
}

/**
 * Who this process is on its own machine, and where its state lives. Every field is
 * injectable so a test can stand in for a second daemon without touching the real
 * home directory, the real clock, or real pids.
 */
export interface InstallHostOptions {
	homeDir?: string;
	hostname?: string;
	pid?: number;
	now?: () => number;
	isPidLive?: (pid: number) => boolean;
}

/** The three things every record here is written and judged with. */
interface ResolvedHost {
	pid: number;
	host: string;
	now: () => number;
	isLive: (pid: number) => boolean;
}

function resolveHost(options: InstallHostOptions): ResolvedHost {
	return {
		pid: options.pid ?? process.pid,
		host: options.hostname ?? hostname(),
		now: options.now ?? Date.now,
		isLive: options.isPidLive ?? pidIsLive,
	};
}

/** Temp file + rename, so a concurrent reader never sees a half-written record. */
function writeRecord(path: string, record: unknown, pid: number): void {
	const temp = `${path}.${pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(record)}\n`, 'utf8');
	renameSync(temp, path);
}

// --- The exclusive update lock ---------------------------------------------

const InstallLockOwnerSchema = z.object({
	/** The install root itself, recorded for the operator reading an opaque `<sha256>` directory. */
	installRoot: z.string().min(1),
	pid: z.number().int().positive(),
	hostname: z.string().min(1),
	/**
	 * The registered worker the holder authenticates as, copied from that daemon's own
	 * participant record — `null` when it has none yet, which is every start before the
	 * first handshake.
	 */
	workerId: z.string().min(1).nullable(),
	createdAt: z.string().datetime(),
	refreshedAt: z.string().datetime(),
});
export type InstallLockOwner = z.infer<typeof InstallLockOwnerSchema>;

/**
 * Written inside the takeover guard directory, so a guard left by a daemon that died
 * mid-reclaim is told apart from one a live daemon is inside right now.
 */
const TakeoverGuardHolderSchema = z.object({
	pid: z.number().int().positive(),
	hostname: z.string().min(1),
	createdAt: z.string().datetime(),
});

/**
 * Another daemon on this machine is already moving the install root. A distinct class
 * so the update can answer with a refusal that names the holder, rather than with a
 * stack trace.
 */
export class InstallHeldError extends Error {
	/** The holder's record — absent when its `owner.json` could not be read. */
	readonly holder: InstallLockOwner | undefined;
	readonly installRoot: string;
	readonly lockDir: string;

	constructor(input: { holder?: InstallLockOwner; installRoot: string; lockDir: string }) {
		super(
			`${describeLockHolder(input.holder)} is already updating the SWARM install root ` +
				`'${input.installRoot}', which this daemon shares with it, so nothing was changed ` +
				'here. Only one daemon may move an install root at a time, because two would ' +
				'interleave a checkout with a build. Re-issue this update once that one has ' +
				`reported (lock: ${input.lockDir}).`,
		);
		this.name = 'InstallHeldError';
		this.holder = input.holder;
		this.installRoot = input.installRoot;
		this.lockDir = input.lockDir;
	}
}

/** Name the holder — by its worker id when known, since that is what an operator can act on. */
function describeLockHolder(holder: InstallLockOwner | undefined): string {
	if (!holder) return 'A daemon whose lock record is unreadable';
	const who = holder.workerId
		? `Worker '${holder.workerId}'`
		: 'A daemon that has not completed its handshake yet';
	return `${who} (pid ${holder.pid} on ${holder.hostname}, last refreshed ${holder.refreshedAt})`;
}

/** The lock this process holds, for as long as it keeps refreshing it. */
export interface InstallLock {
	/** Where the lock lives — reported so an operator can find (and, if truly stale, remove) it. */
	readonly lockDir: string;
	/** The record this process last wrote. */
	readonly holder: InstallLockOwner;
	/**
	 * Restamp `refreshedAt`. Returns `false` when this process no longer holds the lock
	 * — another daemon reclaimed it after the refresh lapsed — so a caller can say so
	 * rather than silently stomping the new holder's record. Called on this lock's own
	 * timer; exposed because a test drives the clock itself.
	 */
	refresh(): boolean;
	/** Drop the lock and stop refreshing it. A no-op if it is not ours. */
	release(): void;
}

/**
 * Take the machine-local exclusive lock on `installRoot`, or throw
 * {@link InstallHeldError}.
 *
 * `mkdirSync` on the lock directory is the atomic `SET NX` equivalent, exactly as in
 * `./checkout-lock.ts`: on `EEXIST` the existing owner decides — our own record is
 * adopted, a reclaimable one is removed and the create retried **once**, and a live
 * one is refused.
 *
 * The returned lock keeps itself fresh on an unref'd interval, because it is held
 * across a `git fetch`, an `npm ci` and an `npm run build` by a caller that is simply
 * awaiting subprocesses. Without that, a build slower than the TTL would let a second
 * daemon judge this one departed and start its own checkout underneath it — the very
 * collision the lock exists to prevent. `release()` stops it.
 */
export function acquireInstallLock(
	installRoot: string,
	options: InstallHostOptions = {},
): InstallLock {
	const { pid, host, now, isLive } = resolveHost(options);
	const stateDir = installUpdateStateDir(installRoot, options.homeDir);
	const lockDir = resolve(stateDir, 'update-lock');
	const ownerPath = resolve(lockDir, 'owner.json');
	// A sibling of the lock rather than a child of it, because the whole point is to
	// outlive the `rmSync` of `lockDir` that it is serializing.
	const guardDir = resolve(stateDir, 'update-lock.takeover');
	const guardHolderPath = resolve(guardDir, 'holder.json');

	/** Whether a record left in `lockDir` belongs to this very process. */
	function isOurs(current: InstallLockOwner | null | undefined): boolean {
		return current?.pid === pid && current?.hostname === host;
	}

	function reclaimable(current: InstallLockOwner | null | undefined): boolean {
		// No readable owner at all — a corrupt write, or a crash in the microseconds
		// between `mkdir` and the write. Neither offers an owner to prove dead, so the
		// directory's own age is the only thing that can decide.
		if (!current) return pathOlderThan(lockDir, INSTALL_LOCK_TTL_MS, now());
		if (!isLive(current.pid)) return true;
		return isExpired(current.refreshedAt, INSTALL_LOCK_TTL_MS, now());
	}

	function record(createdAt: string | undefined): InstallLockOwner {
		const at = new Date(now()).toISOString();
		return {
			installRoot,
			pid,
			hostname: host,
			// Read from this process's own participant record rather than plumbed in: the
			// daemon already learned its worker id at handshake and wrote it there, and the
			// update handler that calls this has no reason to carry it a second time.
			workerId: readOwnWorkerId(stateDir, pid, host),
			createdAt: createdAt ?? at,
			refreshedAt: at,
		};
	}

	/** Create the lock directory and its owner file, or report nothing on `EEXIST`. */
	function tryCreate(): InstallLockOwner | undefined {
		try {
			mkdirSync(lockDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
			throw error;
		}
		const created = record(undefined);
		try {
			writeFileSync(ownerPath, `${JSON.stringify(created)}\n`, { encoding: 'utf8', flag: 'wx' });
		} catch (error) {
			rmSync(lockDir, { recursive: true, force: true });
			throw error;
		}
		return created;
	}

	/** Whoever the lock says owns it now, for a refusal that names someone. */
	function held(): InstallHeldError {
		return new InstallHeldError({
			holder: readJson(ownerPath, InstallLockOwnerSchema) ?? undefined,
			installRoot,
			lockDir,
		});
	}

	/**
	 * Drop a takeover guard whose holder is provably gone, so a daemon that died inside
	 * a reclaim wedges nothing: the next acquirer performs the recovery, with no sweeper
	 * and no operator.
	 */
	function reapStaleGuard(): void {
		if (!existsSync(guardDir)) return;
		const holder = readJson(guardHolderPath, TakeoverGuardHolderSchema);
		if (holder) {
			// A guard bearing *our* pid is always debris: `reclaim()` is synchronous and
			// removes its own before returning, so this process cannot be inside one.
			const ours = holder.pid === pid && holder.hostname === host;
			if (
				!ours &&
				isLive(holder.pid) &&
				!isExpired(holder.createdAt, INSTALL_TAKEOVER_GUARD_TTL_MS, now())
			)
				return;
		} else if (!pathOlderThan(guardDir, INSTALL_TAKEOVER_GUARD_TTL_MS, now())) {
			// No readable holder yet: either a guard mid-creation — a live race we must not
			// disturb — or a crash between the `mkdir` and the write. Only age tells them
			// apart, so wait the window out before deciding.
			return;
		}
		rmSync(guardDir, { recursive: true, force: true });
	}

	/**
	 * Replace a lock whose owner is gone, holding the takeover guard across the whole
	 * read-remove-create so no second reclaimer can delete the claim this one just made.
	 * A daemon that cannot take the guard has lost to one that can, and is refused like
	 * any other loser rather than proceeding on an observation that is already stale.
	 */
	function reclaim(): InstallLockOwner {
		reapStaleGuard();
		try {
			mkdirSync(guardDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			throw held();
		}
		try {
			writeFileSync(
				guardHolderPath,
				`${JSON.stringify({ pid, hostname: host, createdAt: new Date(now()).toISOString() })}\n`,
				{ encoding: 'utf8', flag: 'wx' },
			);
			// The re-read is the whole fix: the record judged reclaimable above was read
			// before the guard existed, and the daemon that held the guard in between may
			// have left a live claim of its own in its place.
			const current = readJson(ownerPath, InstallLockOwnerSchema);
			if (current && isOurs(current)) return current;
			if (!reclaimable(current)) throw held();
			rmSync(lockDir, { recursive: true, force: true });
			const reclaimed = tryCreate();
			if (reclaimed) return reclaimed;
			// A daemon that found no lock at all slipped in between the two calls above and
			// created one outright — it never needed the guard. It legitimately owns the
			// install root now, so report it as the holder rather than as a race.
			throw held();
		} finally {
			rmSync(guardDir, { recursive: true, force: true });
		}
	}

	function acquire(): InstallLockOwner {
		mkdirSync(stateDir, { recursive: true });
		const created = tryCreate();
		if (created) return created;

		const current = readJson(ownerPath, InstallLockOwnerSchema);
		// Our own lock: adopting it keeps acquisition idempotent within a process instead
		// of having this daemon refuse itself.
		if (current && isOurs(current)) return current;
		if (!reclaimable(current)) {
			throw new InstallHeldError({ holder: current ?? undefined, installRoot, lockDir });
		}
		return reclaim();
	}

	let owner = acquire();

	function rewrite(): boolean {
		const current = readJson(ownerPath, InstallLockOwnerSchema);
		if (!current || !isOurs(current)) return false;
		const next = record(current.createdAt);
		try {
			writeRecord(ownerPath, next, pid);
		} catch {
			// Reclaimed between the read and the write. Report the loss rather than throwing:
			// this runs on a timer, where an exception would take the daemon down over a lock
			// it no longer holds.
			return false;
		}
		owner = next;
		return true;
	}

	// Never the reason this process stays alive; cleared by `release()`.
	const timer = setInterval(rewrite, INSTALL_LOCK_REFRESH_MS);
	timer.unref?.();

	return {
		lockDir,
		get holder(): InstallLockOwner {
			return owner;
		},
		refresh: rewrite,
		release(): void {
			clearInterval(timer);
			const current = readJson(ownerPath, InstallLockOwnerSchema);
			if (!isOurs(current)) return;
			rmSync(lockDir, { recursive: true, force: true });
		},
	};
}

// --- The participants of an install root -----------------------------------

const InstallParticipantSchema = z.object({
	/** The install root itself, recorded for the operator reading an opaque `<sha256>` directory. */
	installRoot: z.string().min(1),
	pid: z.number().int().positive(),
	hostname: z.string().min(1),
	/** The registered worker this daemon authenticates as — `null` until its handshake answers. */
	workerId: z.string().min(1).nullable(),
	/** Whether this daemon currently holds an in-flight phase. */
	busy: z.boolean(),
	startedAt: z.string().datetime(),
	refreshedAt: z.string().datetime(),
});
export type InstallParticipant = z.infer<typeof InstallParticipantSchema>;

/** One daemon still judged to be running from an install root. */
export interface LiveInstallParticipant {
	pid: number;
	/** Its record, or `undefined` when the file is present but unreadable. */
	record: InstallParticipant | undefined;
	/**
	 * Whether it must be treated as holding an in-flight phase. An unreadable record
	 * counts as busy, on `./local-lock.ts`'s own rule that an artifact this process
	 * cannot identify is occupied rather than free — it ages out on the TTL, where
	 * assuming it idle would swap code under whatever wrote it.
	 */
	busy: boolean;
}

/** This process's participation in an install root, for as long as it keeps refreshing it. */
export interface InstallParticipation {
	/** The file this process writes — reported so an operator can find it. */
	readonly recordPath: string;
	/** The record this process last wrote. */
	readonly record: InstallParticipant;
	/** Say whether this daemon now holds an in-flight phase. */
	setBusy(busy: boolean): void;
	/** Record the worker id the handshake answered with. */
	annotate(workerId: string): void;
	/** Restamp `refreshedAt`, so a reader can tell this daemon from a departed one. */
	refresh(): void;
	/** Drop the record, so it stops blocking anything the moment this daemon leaves. */
	release(): void;
}

function participantsDir(stateDir: string): string {
	return resolve(stateDir, 'participants');
}

/**
 * Register this process as a participant of `installRoot`, and keep the record
 * writable for as long as it runs.
 *
 * Every write is best-effort and silent: a daemon must not fail to start, nor a phase
 * to be dispatched, because a record under `~/.swarm` could not be written. The cost
 * of a lost write is bounded and in the safe direction — a record that is not there
 * blocks no update, and one that is stale ages out on the TTL.
 */
export function registerInstallParticipant(
	installRoot: string,
	options: InstallHostOptions = {},
): InstallParticipation {
	const { pid, host, now } = resolveHost(options);
	const dir = participantsDir(installUpdateStateDir(installRoot, options.homeDir));
	const recordPath = resolve(dir, `${pid}.json`);
	const startedAt = new Date(now()).toISOString();
	let current: InstallParticipant = {
		installRoot,
		pid,
		hostname: host,
		workerId: null,
		busy: false,
		startedAt,
		refreshedAt: startedAt,
	};

	function persist(next: InstallParticipant): void {
		current = next;
		try {
			mkdirSync(dir, { recursive: true });
			writeRecord(recordPath, next, pid);
		} catch {
			// See the doc comment: a record that cannot be written is not worth a daemon.
		}
	}

	persist(current);

	return {
		recordPath,
		get record(): InstallParticipant {
			return current;
		},
		setBusy(busy: boolean): void {
			persist({ ...current, busy, refreshedAt: new Date(now()).toISOString() });
		},
		annotate(workerId: string): void {
			persist({ ...current, workerId, refreshedAt: new Date(now()).toISOString() });
		},
		refresh(): void {
			persist({ ...current, refreshedAt: new Date(now()).toISOString() });
		},
		release(): void {
			try {
				const stored = readJson(recordPath, InstallParticipantSchema);
				// Only ours: a recycled pid means the file may already describe another daemon.
				if (stored && (stored.pid !== pid || stored.hostname !== host)) return;
				unlinkSync(recordPath);
			} catch {
				// Already gone, or unremovable. Either way it is reclaimed on liveness grounds.
			}
		},
	};
}

/**
 * The daemons still judged to be running from `installRoot`, this process included.
 *
 * Liveness is the fast path and the refreshed timestamp is the backstop, exactly as
 * for the locks. A record that answers neither is **removed** as it is read: nothing
 * else sweeps this directory, and a machine that has restarted its daemons a hundred
 * times should not accumulate a hundred records that block nothing.
 */
export function listLiveParticipants(
	installRoot: string,
	options: InstallHostOptions = {},
): LiveInstallParticipant[] {
	const { now, isLive } = resolveHost(options);
	const dir = participantsDir(installUpdateStateDir(installRoot, options.homeDir));
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		// No directory means no participant has ever registered here, which is every
		// machine that has not run a daemon since this landed.
		return [];
	}
	const live: LiveInstallParticipant[] = [];
	for (const entry of entries) {
		const pid = participantPid(entry);
		if (pid === null) continue;
		const found = readParticipant(resolve(dir, entry), pid, now(), isLive);
		if (found) live.push(found);
	}
	return live;
}

/** The pid a `participants/` entry names, or `null` when the entry is not one of ours. */
function participantPid(entry: string): number | null {
	if (!entry.endsWith('.json')) return null;
	const pid = Number.parseInt(entry.slice(0, -'.json'.length), 10);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * One participant, or `undefined` when the record describes a daemon that has
 * departed — which is also when it is removed, since nothing else sweeps them.
 */
function readParticipant(
	path: string,
	pid: number,
	now: number,
	isLive: (pid: number) => boolean,
): LiveInstallParticipant | undefined {
	const record = readJson(path, InstallParticipantSchema);
	// Vanished between the listing and the read — a daemon releasing its own record.
	if (record === null) return undefined;
	if (!participantIsLive(record, path, now, isLive)) {
		try {
			unlinkSync(path);
		} catch {
			// Removed by its own daemon in the meantime, or unremovable. Neither matters:
			// it was already judged departed.
		}
		return undefined;
	}
	return { pid, record: record ?? undefined, busy: record?.busy ?? true };
}

function participantIsLive(
	record: InstallParticipant | undefined,
	path: string,
	now: number,
	isLive: (pid: number) => boolean,
): boolean {
	// Unreadable: no owner to prove dead, so the file's own age decides — the same
	// fallback an unreadable lock record gets.
	if (!record) return !pathOlderThan(path, INSTALL_PARTICIPANT_TTL_MS, now);
	if (!isLive(record.pid)) return false;
	return !isExpired(record.refreshedAt, INSTALL_PARTICIPANT_TTL_MS, now);
}

/**
 * The first live daemon *other than this process* that holds an in-flight phase, or
 * `undefined` when none does — what an update reads before it touches anything.
 *
 * It is a **snapshot**, not a reservation: nothing stops a peer starting a phase a
 * moment later, because a peer is not asking this process for permission. Draining
 * the peers is what makes the answer stable, which is why the refusal names the
 * worker to drain (`docs/onboarding-worker.md`).
 */
export function findBusyInstallPeer(
	installRoot: string,
	options: InstallHostOptions = {},
): LiveInstallParticipant | undefined {
	const { pid, host } = resolveHost(options);
	return listLiveParticipants(installRoot, options).find(
		(participant) =>
			participant.busy &&
			!(participant.pid === pid && (participant.record?.hostname ?? host) === host),
	);
}

/** Name a participant — by its worker id when known, since that is what an operator can drain. */
export function describeInstallParticipant(participant: LiveInstallParticipant): string {
	const record = participant.record;
	if (!record) return `A daemon whose participant record is unreadable (pid ${participant.pid})`;
	const who = record.workerId
		? `Worker '${record.workerId}'`
		: 'A daemon that has not completed its handshake yet';
	return `${who} (pid ${record.pid} on ${record.hostname})`;
}

/**
 * The worker id this process already recorded on its own participant record, for the
 * lock to name its holder with. `null` when this process registered none — a daemon
 * before its first handshake, or a caller that is not a daemon at all.
 */
function readOwnWorkerId(stateDir: string, pid: number, host: string): string | null {
	const own = readJson(resolve(participantsDir(stateDir), `${pid}.json`), InstallParticipantSchema);
	return own && own.hostname === host ? own.workerId : null;
}
