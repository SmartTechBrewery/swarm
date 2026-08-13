import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createHostLocalWorktreeRuntime,
	sweepStaleHostLocalState,
	UNREADABLE_LEASE_TOKEN,
} from '@/worktree/host-local-runtime.js';
import { BlockedRecoveryError } from '@/worktree/reclaim.js';

const HOUR_MS = 60 * 60 * 1000;

describe('host-local worktree runtime', () => {
	let root: string | undefined;

	afterEach(() => {
		vi.useRealTimers();
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	function repoRoot(): string {
		root ??= mkdtempSync(join(tmpdir(), 'swarm-local-worktree-'));
		return root;
	}

	/** The opaque `<sha256>` basename the runtime derives its artifact paths from. */
	function statePath(projectId: string, taskId: string, suffix: string): string {
		const key = createHash('sha256').update(`${projectId}\u0000${taskId}`).digest('hex');
		return resolve(repoRoot(), '.swarm-workspaces', '.swarm-state', `${key}${suffix}`);
	}

	/** Move the wall clock forward so an artifact's recorded `createdAt` falls outside its TTL. */
	function advance(ms: number): void {
		vi.useFakeTimers({ now: Date.now() + ms, toFake: ['Date'] });
	}

	function runtime(ownerId: string, live: Set<string>, runId = ownerId) {
		root ??= mkdtempSync(join(tmpdir(), 'swarm-local-worktree-'));
		return createHostLocalWorktreeRuntime({
			repoRoot: root,
			worktreeRoot: '.swarm-workspaces',
			ownerId,
			runId,
			isOwnerLive: (candidate) => live.has(candidate),
		});
	}

	it('allows only one live provisioner to claim a task on this host', async () => {
		const live = new Set(['dispatch-a', 'dispatch-b']);
		const first = runtime('dispatch-a', live);
		const second = runtime('dispatch-b', live);

		expect(await first.tryClaim('swarm', '535', 'token-a')).toBe(true);
		expect(await second.tryClaim('swarm', '535', 'token-b')).toBe(false);
		expect(await second.hasLiveOwner('swarm', '535')).toBe(true);

		await first.release('swarm', '535', 'token-a');
		expect(await second.tryClaim('swarm', '535', 'token-b')).toBe(true);
	});

	it('takes over an orphaned local lease with compare-and-replace serialization', async () => {
		const live = new Set(['dispatch-a', 'dispatch-b']);
		const first = runtime('dispatch-a', live);
		const second = runtime('dispatch-b', live);
		await first.claim('swarm', '535', 'token-a');

		live.delete('dispatch-a');
		expect(await second.hasLiveOwner('swarm', '535')).toBe(false);
		expect(await second.takeOver('swarm', '535', 'token-a', 'token-b')).toBe(true);
		expect(await second.read('swarm', '535')).toBe('token-b');
	});

	it('pins a preserved checkout against other runs while allowing its own retry', async () => {
		const live = new Set(['dispatch-a']);
		const first = runtime('dispatch-a', live, 'run-a');
		await first.claim('swarm', '535', 'token-a');
		await first.preserve('swarm', '535', 'run-a');

		expect(await runtime('dispatch-b', live, 'run-b').isResumablePinned('swarm', '535')).toBe(true);
		expect(await runtime('dispatch-c', live, 'run-a').isResumablePinned('swarm', '535')).toBe(
			false,
		);
		expect(await first.isLeased('swarm', '535')).toBe(false);
	});

	// Every artifact below is one a crash can strand. The Redis lease this runtime
	// replaces had a 4h TTL as its backstop; on disk that has to be explicit, or the
	// task stays wedged until an operator deletes a file by hand (issue #535 review).
	describe('stranded state recovers instead of wedging the task', () => {
		it('reaps a takeover guard left behind by a process that died mid-takeover', async () => {
			const live = new Set(['a']);
			const first = runtime('a', live);
			await first.claim('swarm', '535', 'token-a');
			live.delete('a');
			// The guard directory with no holder: the crash landed between `mkdir` and
			// the holder write, so only its age can tell it from a live race.
			mkdirSync(statePath('swarm', '535', '.takeover'));

			// While the guard stands, even the orphaned lease behind it is unreachable:
			// `takeOver` cannot re-create the guard it is blocked by.
			const second = runtime('b', new Set(['b']), 'run-b');
			await expect(second.claim('swarm', '535', 'token-b')).rejects.toThrow(BlockedRecoveryError);

			advance(10 * 60 * 1000);
			await expect(second.claim('swarm', '535', 'token-b')).resolves.toBeUndefined();
			expect(await second.read('swarm', '535')).toBe('token-b');
		});

		it('reaps a takeover guard whose holder process is gone', async () => {
			mkdirSync(statePath('swarm', '536', '.takeover'), { recursive: true });
			writeFileSync(
				join(statePath('swarm', '536', '.takeover'), 'holder.json'),
				JSON.stringify({ pid: 2, createdAt: new Date().toISOString() }),
			);
			// pid 2 is the kernel's, never this daemon's — stand in for a dead holder.
			const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
				throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
			});
			try {
				expect(await runtime('c', new Set(['c'])).tryClaim('swarm', '536', 'token-c')).toBe(true);
			} finally {
				spy.mockRestore();
			}
		});

		it('reaps a lock directory whose owner file was never written', async () => {
			mkdirSync(statePath('swarm', '537', '.lock'), { recursive: true });
			const only = runtime('d', new Set(['d']));

			expect(await only.tryClaim('swarm', '537', 'token-d')).toBe(false);
			expect(await only.read('swarm', '537')).toBeNull();

			advance(10 * 60 * 1000);
			expect(await only.tryClaim('swarm', '537', 'token-d')).toBe(true);
		});

		it('never blames a live phase for an unreadable lease, and adopts it once expired', async () => {
			const first = runtime('e', new Set(['e']));
			await first.claim('swarm', '538', 'token-e');
			writeFileSync(join(statePath('swarm', '538', '.lock'), 'owner.json'), 'not json');

			const second = runtime('f', new Set(['f']), 'run-f');
			expect(await second.read('swarm', '538')).toBe(UNREADABLE_LEASE_TOKEN);
			// Reported as "could not be verified" (contended), not as a live owner.
			expect(await second.hasLiveOwner('swarm', '538')).toBe(false);
			// Still protected against reclaim while it could plausibly be live.
			expect(await second.isLeased('swarm', '538')).toBe(true);
			expect(await second.takeOver('swarm', '538', UNREADABLE_LEASE_TOKEN, 'token-f')).toBe(false);

			advance(5 * HOUR_MS);
			expect(await second.isLeased('swarm', '538')).toBe(false);
			expect(await second.takeOver('swarm', '538', UNREADABLE_LEASE_TOKEN, 'token-f')).toBe(true);
		});

		it('stops honouring a preservation pin once it outlives its TTL', async () => {
			// The pin stands in for `hasResumableDeferredRun`, whose lifecycle lives in a
			// database this worker cannot read — so nothing here can learn the pinning run
			// was settled or reset. Without the TTL the checkout is blocked forever.
			const owner = runtime('g', new Set(['g']), 'run-g');
			await owner.claim('swarm', '539', 'token-g');
			await owner.preserve('swarm', '539', 'run-g');

			const other = runtime('h', new Set(['h']), 'run-h');
			expect(await other.isResumablePinned('swarm', '539')).toBe(true);

			advance(25 * HOUR_MS);
			expect(await other.isResumablePinned('swarm', '539')).toBe(false);
		});

		it("bounds this daemon's own in-flight liveness answer by the lease TTL (issue #717)", async () => {
			// The leak itself (#718): the entry outlives the phase, and a lease written
			// here records *this* process's pid — the daemon's, which outlives every
			// dispatch — so the same-process branch is the one this lease takes.
			const live = new Set(['dispatch-leaked']);
			await runtime('dispatch-leaked', live, 'run-leaked').claim('swarm', '702', 'token-leaked');

			const next = runtime('dispatch-next', live, 'run-next');
			// A young lease still blocks: a genuinely live phase is protected as before.
			expect(await next.hasLiveOwner('swarm', '702')).toBe(true);
			expect(await next.isLeased('swarm', '702')).toBe(true);
			expect(await next.takeOver('swarm', '702', 'token-leaked', 'token-next')).toBe(false);

			// Past the TTL the leaked entry stops answering, so the task recovers by
			// itself instead of waiting on a daemon restart.
			advance(5 * HOUR_MS);
			expect(await next.hasLiveOwner('swarm', '702')).toBe(false);
			expect(await next.isLeased('swarm', '702')).toBe(false);
			await expect(next.claim('swarm', '702', 'token-next')).resolves.toBeUndefined();
			expect(await next.read('swarm', '702')).toBe('token-next');
		});

		it('adopts a lease whose owning pid is gone but only after the lease TTL', async () => {
			const owner = runtime('i', new Set(['i']));
			await owner.claim('swarm', '540', 'token-i');
			// A different pid keeps the fast liveness path from answering for us.
			writeFileSync(
				join(statePath('swarm', '540', '.lock'), 'owner.json'),
				JSON.stringify({
					token: 'token-i',
					ownerId: 'i',
					ownerKey: 'i',
					pid: 999_999,
					createdAt: new Date().toISOString(),
				}),
			);
			const spy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
			try {
				const other = runtime('j', new Set(['j']), 'run-j');
				expect(await other.hasLiveOwner('swarm', '540')).toBe(true);

				advance(5 * HOUR_MS);
				expect(await other.hasLiveOwner('swarm', '540')).toBe(false);
			} finally {
				spy.mockRestore();
			}
		});
	});

	// Every TTL above is evaluated only by the next provisioner for the *same* task, so
	// a task never dispatched again keeps its debris forever — and a `preserve()` staging
	// file stranded between its write and its rename has no next reader at all (#721).
	describe('sweeps stale .swarm-state artifacts', () => {
		/** One of every artifact a crash can strand, plus an entry the sweep must not touch. */
		function fabricate() {
			const paths = {
				lock: statePath('swarm', '555', '.lock'),
				unreadableLock: statePath('swarm', '556', '.lock'),
				pin: statePath('swarm', '557', '.pin.json'),
				takeover: statePath('swarm', '558', '.takeover'),
				staging: `${statePath('swarm', '559', '.pin.json')}.4f1a2b3c.tmp`,
				unrecognised: statePath('swarm', '560', '.notes'),
			};
			mkdirSync(paths.lock, { recursive: true });
			writeFileSync(
				join(paths.lock, 'owner.json'),
				JSON.stringify({
					token: 'token-555',
					ownerId: 'dispatch-555',
					ownerKey: 'run-555',
					pid: 1958,
					createdAt: new Date().toISOString(),
					projectId: 'swarm',
					taskId: '555',
				}),
			);
			mkdirSync(paths.unreadableLock, { recursive: true });
			writeFileSync(join(paths.unreadableLock, 'owner.json'), 'not json');
			writeFileSync(
				paths.pin,
				JSON.stringify({ ownerKey: 'run-557', createdAt: new Date().toISOString() }),
			);
			mkdirSync(paths.takeover, { recursive: true });
			writeFileSync(
				join(paths.takeover, 'holder.json'),
				JSON.stringify({ pid: 1958, createdAt: new Date().toISOString() }),
			);
			// The `<pin>.<uuid>.tmp` `preserve()` wrote and never got to rename.
			writeFileSync(paths.staging, '{"ownerKey":"run-559"');
			writeFileSync(paths.unrecognised, 'not an artifact this module writes');
			return paths;
		}

		/** Sorted, because `readdirSync` order is not part of the contract. */
		function sweep(dryRun?: boolean): string[] {
			return sweepStaleHostLocalState({
				repoRoot: repoRoot(),
				worktreeRoot: '.swarm-workspaces',
				dryRun,
			}).sort();
		}

		it('leaves every artifact alone while it is inside its own TTL', () => {
			const paths = fabricate();

			expect(sweep()).toEqual([]);
			for (const path of Object.values(paths)) expect(existsSync(path)).toBe(true);
		});

		it('removes every expired artifact, reports its path, and skips unrecognised entries', () => {
			const paths = fabricate();
			advance(25 * HOUR_MS);

			const expired = [paths.lock, paths.unreadableLock, paths.pin, paths.takeover, paths.staging];
			expect(sweep()).toEqual([...expired].sort());
			for (const path of expired) expect(existsSync(path)).toBe(false);
			// Not ours to judge: an entry matching no artifact shape is left entirely alone.
			expect(existsSync(paths.unrecognised)).toBe(true);
		});

		it('applies each TTL to its own artifact rather than one blanket age', () => {
			const paths = fabricate();
			// Past the 5-minute takeover-guard window, well inside the 4h lease and 24h pin.
			advance(10 * 60 * 1000);

			expect(sweep()).toEqual([paths.takeover, paths.staging].sort());
			expect(existsSync(paths.lock)).toBe(true);
			expect(existsSync(paths.unreadableLock)).toBe(true);
			expect(existsSync(paths.pin)).toBe(true);
		});

		it('reports what it would remove without removing it under dryRun', () => {
			const paths = fabricate();
			advance(25 * HOUR_MS);
			const expired = [
				paths.lock,
				paths.unreadableLock,
				paths.pin,
				paths.takeover,
				paths.staging,
			].sort();

			expect(sweep(true)).toEqual(expired);
			for (const path of Object.values(paths)) expect(existsSync(path)).toBe(true);

			// The real sweep then reports exactly the same paths, and removes them.
			expect(sweep()).toEqual(expired);
			expect(existsSync(paths.pin)).toBe(false);
		});

		it('returns nothing rather than throwing when the state root does not exist', () => {
			expect(sweep()).toEqual([]);
		});
	});

	it('reports a lost race as a classified blocked-recovery error', async () => {
		// `reuse()` and the recovery gate were written against the store-backed lease,
		// which never throws; a raw Error here settles the run with no
		// `runs.recovery.blockedReason` for the dashboard to show.
		const live = new Set(['k', 'l']);
		await runtime('k', live).claim('swarm', '541', 'token-k');

		await expect(runtime('l', live, 'run-l').claim('swarm', '541', 'token-l')).rejects.toThrow(
			BlockedRecoveryError,
		);
	});
});
