/**
 * Several daemons on one SWARM install root (issue #935).
 *
 * Every case runs against a `mkdtemp` home, an install root that is only a path, an
 * injected clock and an injected liveness answer — so no real `~/.swarm` is touched
 * and a "second daemon" is a record on disk rather than a process.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	acquireInstallLock,
	describeInstallParticipant,
	findBusyInstallPeer,
	INSTALL_LOCK_TTL_MS,
	INSTALL_PARTICIPANT_TTL_MS,
	InstallHeldError,
	type InstallLock,
	type InstallLockOwner,
	installUpdateStateDir,
	type LiveInstallParticipant,
	listLiveParticipants,
	registerInstallParticipant,
} from '@/worktree/install-lock.js';

const INSTALL_ROOT = '/opt/swarm';
const HOST = 'ada-laptop';
const WORKER_A = '11111111-1111-4111-8111-111111111111';
const WORKER_B = '22222222-2222-4222-8222-222222222222';

describe('install lock and participants (several daemons, one install root)', () => {
	let home: string;
	let clock: number;
	/** Pids the fake host considers alive — the injected liveness answer. */
	let live: Set<number>;
	/** Locks to drop after each case, so no refresh interval outlives its test. */
	let held: InstallLock[];

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'swarm-install-lock-'));
		// Starts at the real clock, because the fallback age of an unreadable record is
		// read from the file's own (real) mtime.
		clock = Date.now();
		live = new Set([5001, 5002, 5003]);
		held = [];
	});

	afterEach(() => {
		for (const lock of held.splice(0)) lock.release();
		rmSync(home, { recursive: true, force: true });
	});

	function hostOptions(pid = 5001, hostname = HOST) {
		return {
			homeDir: home,
			hostname,
			pid,
			now: () => clock,
			isPidLive: (candidate: number) => live.has(candidate),
		};
	}

	function lock(pid = 5001, hostname = HOST): InstallLock {
		const acquired = acquireInstallLock(INSTALL_ROOT, hostOptions(pid, hostname));
		held.push(acquired);
		return acquired;
	}

	function participate(pid = 5001, hostname = HOST) {
		return registerInstallParticipant(INSTALL_ROOT, hostOptions(pid, hostname));
	}

	function stateDir(): string {
		return installUpdateStateDir(INSTALL_ROOT, home);
	}

	function lockDir(): string {
		return resolve(stateDir(), 'update-lock');
	}

	/** Where a reclaim in progress leaves its guard — a sibling of the lock it replaces. */
	function guardDir(): string {
		return resolve(stateDir(), 'update-lock.takeover');
	}

	function participantPath(pid: number): string {
		return resolve(stateDir(), 'participants', `${pid}.json`);
	}

	/** Write a peer daemon's record by hand — the "another process did this" seam. */
	function writePeerParticipant(pid: number, overrides: Record<string, unknown> = {}): void {
		mkdirSync(resolve(stateDir(), 'participants'), { recursive: true });
		writeFileSync(
			participantPath(pid),
			JSON.stringify({
				installRoot: INSTALL_ROOT,
				pid,
				hostname: HOST,
				workerId: WORKER_B,
				busy: false,
				startedAt: new Date(clock).toISOString(),
				refreshedAt: new Date(clock).toISOString(),
				...overrides,
			}),
		);
	}

	/** The busy peer a case is about, or a failure naming what it expected. */
	function requireBusyPeer(pid = 5001): LiveInstallParticipant {
		const busy = findBusyInstallPeer(INSTALL_ROOT, hostOptions(pid));
		if (!busy) throw new Error('expected a busy peer of this install root');
		return busy;
	}

	function readOwner(): InstallLockOwner {
		return JSON.parse(readFileSync(resolve(lockDir(), 'owner.json'), 'utf8')) as InstallLockOwner;
	}

	describe('the exclusive update lock', () => {
		it('records the holder under the home directory, outside the install root', () => {
			const taken = lock();

			expect(taken.lockDir.startsWith(resolve(home, '.swarm', 'install-updates'))).toBe(true);
			expect(readOwner()).toMatchObject({
				installRoot: INSTALL_ROOT,
				pid: 5001,
				hostname: HOST,
				// No participant record to take one from — this process has not handshaked.
				workerId: null,
			});
		});

		it('names its holder by the worker id that daemon already recorded as a participant', () => {
			const participation = participate(5001);
			participation.annotate(WORKER_A);
			lock(5001);

			expect(readOwner().workerId).toBe(WORKER_A);
			participation.release();
		});

		it('refuses a second daemon, naming the worker holding it and the remedy', () => {
			const participation = participate(5001);
			participation.annotate(WORKER_A);
			lock(5001);

			expect(() => lock(5002)).toThrow(InstallHeldError);
			try {
				lock(5002);
			} catch (error) {
				expect((error as InstallHeldError).message).toContain(WORKER_A);
				expect((error as InstallHeldError).message).toContain('Re-issue this update');
				expect((error as InstallHeldError).holder?.pid).toBe(5001);
			}
			participation.release();
		});

		it('adopts its own lock rather than refusing itself', () => {
			const first = lock(5001);
			const again = lock(5001);

			expect(again.lockDir).toBe(first.lockDir);
			expect(again.holder.createdAt).toBe(first.holder.createdAt);
		});

		it('reclaims a lock whose holder is gone', () => {
			lock(5002);
			live.delete(5002);

			const taken = lock(5001);

			expect(taken.holder.pid).toBe(5001);
		});

		it('reclaims a lock whose refresh has lapsed, even with the pid alive', () => {
			lock(5002);
			clock += INSTALL_LOCK_TTL_MS + 1;

			const taken = lock(5001);

			expect(taken.holder.pid).toBe(5001);
		});

		it('keeps a live, freshly refreshed lock across the TTL', () => {
			const holder = lock(5002);
			clock += INSTALL_LOCK_TTL_MS - 1;
			expect(holder.refresh()).toBe(true);
			clock += INSTALL_LOCK_TTL_MS - 1;

			expect(() => lock(5001)).toThrow(InstallHeldError);
		});

		it('makes the install root immediately re-lockable on release', () => {
			lock(5002).release();

			expect(existsSync(lockDir())).toBe(false);
			expect(lock(5001).holder.pid).toBe(5001);
		});

		it('reports the loss when another daemon reclaimed the lock underneath it', () => {
			const holder = lock(5002);
			live.delete(5002);
			lock(5001);

			expect(holder.refresh()).toBe(false);
		});

		it('lets only one of two daemons reclaim the same lapsed lock', () => {
			// The lock a departed daemon left behind — the one record both contenders read.
			lock(5003);
			live.delete(5003);

			// The interleaving, made deterministic. The liveness answer is the last thing a
			// reclaim reads before it commits, so the peer runs its *whole* reclaim from
			// inside this daemon's: this one then arrives at the removal holding an
			// observation that is already obsolete, which is the state a bare
			// read-remove-create would delete a live claim from.
			let peer: InstallLock | undefined;
			expect(() =>
				acquireInstallLock(INSTALL_ROOT, {
					...hostOptions(5002),
					isPidLive: (candidate: number) => {
						if (candidate === 5003 && !peer) peer = lock(5001);
						return live.has(candidate);
					},
				}),
			).toThrow(InstallHeldError);

			// The daemon that won still holds it, rather than having had it deleted out from
			// under it — and it can still prove that by refreshing.
			expect(peer?.holder.pid).toBe(5001);
			expect(readOwner().pid).toBe(5001);
			expect(peer?.refresh()).toBe(true);
		});

		it('recovers a takeover guard left behind by a daemon that died reclaiming', () => {
			lock(5002);
			live.delete(5002);
			mkdirSync(guardDir(), { recursive: true });
			writeFileSync(
				resolve(guardDir(), 'holder.json'),
				JSON.stringify({ pid: 5003, hostname: HOST, createdAt: new Date(clock).toISOString() }),
			);
			live.delete(5003);

			// The guard's holder is gone, so it protects nothing and must not wedge the
			// install root against every future update.
			expect(lock(5001).holder.pid).toBe(5001);
			expect(existsSync(guardDir())).toBe(false);
		});

		it('refuses a daemon while another is inside a takeover, rather than racing it', () => {
			lock(5002);
			live.delete(5002);
			mkdirSync(guardDir(), { recursive: true });
			writeFileSync(
				resolve(guardDir(), 'holder.json'),
				JSON.stringify({ pid: 5003, hostname: HOST, createdAt: new Date(clock).toISOString() }),
			);

			expect(() => lock(5001)).toThrow(InstallHeldError);
		});
	});

	describe('the participants of an install root', () => {
		it('records this daemon as idle, then follows its in-flight phases', () => {
			const participation = participate(5001);
			expect(listLiveParticipants(INSTALL_ROOT, hostOptions())).toMatchObject([
				{ pid: 5001, busy: false },
			]);

			participation.setBusy(true);
			expect(listLiveParticipants(INSTALL_ROOT, hostOptions())[0]?.busy).toBe(true);

			participation.setBusy(false);
			expect(listLiveParticipants(INSTALL_ROOT, hostOptions())[0]?.busy).toBe(false);
			participation.release();
		});

		it('drops its record on release, so it blocks nothing the moment the daemon leaves', () => {
			const participation = participate(5001);
			participation.setBusy(true);
			participation.release();

			expect(existsSync(participantPath(5001))).toBe(false);
			expect(listLiveParticipants(INSTALL_ROOT, hostOptions())).toEqual([]);
		});

		it('forgets a busy record whose daemon died, and removes it', () => {
			writePeerParticipant(5002, { busy: true });
			live.delete(5002);

			expect(listLiveParticipants(INSTALL_ROOT, hostOptions())).toEqual([]);
			expect(existsSync(participantPath(5002))).toBe(false);
		});

		it('forgets a busy record whose refresh has lapsed, even with the pid alive', () => {
			writePeerParticipant(5002, { busy: true });
			clock += INSTALL_PARTICIPANT_TTL_MS + 1;

			expect(listLiveParticipants(INSTALL_ROOT, hostOptions())).toEqual([]);
		});

		it('treats a fresh but unreadable record as a daemon that may be mid-phase', () => {
			mkdirSync(resolve(stateDir(), 'participants'), { recursive: true });
			writeFileSync(participantPath(5002), 'not json');

			const busy = requireBusyPeer();

			expect(busy.pid).toBe(5002);
			expect(describeInstallParticipant(busy)).toContain('unreadable');
		});
	});

	describe('findBusyInstallPeer', () => {
		it('ignores this process, however busy it is', () => {
			const participation = participate(5001);
			participation.setBusy(true);

			expect(findBusyInstallPeer(INSTALL_ROOT, hostOptions(5001))).toBeUndefined();
			participation.release();
		});

		it('ignores an idle peer', () => {
			writePeerParticipant(5002, { busy: false });

			expect(findBusyInstallPeer(INSTALL_ROOT, hostOptions(5001))).toBeUndefined();
		});

		it('names a busy peer by the worker an operator would drain', () => {
			writePeerParticipant(5002, { busy: true });

			const busy = requireBusyPeer();

			expect(busy.pid).toBe(5002);
			expect(describeInstallParticipant(busy)).toContain(WORKER_B);
		});

		it('names a peer that has not handshaked by its pid', () => {
			writePeerParticipant(5002, { busy: true, workerId: null });

			expect(describeInstallParticipant(requireBusyPeer())).toContain('pid 5002');
		});
	});
});
