import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	acquireCheckoutLock,
	CHECKOUT_LOCK_TTL_MS,
	CheckoutHeldError,
	type CheckoutLockOwner,
} from '@/worktree/checkout-lock.js';

const HOST = 'ada-laptop';
const WORKER_A = '11111111-1111-4111-8111-111111111111';

describe('checkout lock (one worker per checkout)', () => {
	let home: string;
	let clock: number;
	/** Pids the fake host considers alive — the injected liveness answer. */
	let live: Set<number>;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'swarm-checkout-lock-'));
		// Starts at the real clock, because the fallback age of an unreadable lock is
		// read from the directory's own (real) mtime.
		clock = Date.now();
		live = new Set([4001, 4002]);
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	/** A checkout directory to lock — real and canonical, so its realpath resolves to itself. */
	function checkout(name: string): string {
		const path = resolve(home, 'checkouts', name);
		mkdirSync(path, { recursive: true });
		return realpathSync(path);
	}

	function acquire(repoRoot: string, pid = 4001) {
		return acquireCheckoutLock({
			repoRoot,
			homeDir: home,
			hostname: HOST,
			pid,
			now: () => clock,
			isPidLive: (candidate) => live.has(candidate),
		});
	}

	function readOwner(lockDir: string): CheckoutLockOwner {
		return JSON.parse(readFileSync(resolve(lockDir, 'owner.json'), 'utf8')) as CheckoutLockOwner;
	}

	it('records the holder under the home directory, outside the checkout', () => {
		const repoRoot = checkout('swarm');
		const lock = acquire(repoRoot);

		expect(lock.lockDir.startsWith(resolve(home, '.swarm', 'checkout-locks'))).toBe(true);
		expect(readOwner(lock.lockDir)).toMatchObject({
			repoRoot,
			pid: 4001,
			hostname: HOST,
			// Not known until the handshake answers with one.
			workerId: null,
		});
	});

	it('refuses a second worker on the same checkout, naming the worker holding it', () => {
		const repoRoot = checkout('swarm');
		const first = acquire(repoRoot, 4001);
		first.annotate(WORKER_A);

		const err = expectHeld(() => acquire(repoRoot, 4002));
		expect(err.holder?.workerId).toBe(WORKER_A);
		expect(err.message).toContain(WORKER_A);
		expect(err.message).toContain(repoRoot);
	});

	// Before its own handshake the holder has no worker id, so the refusal has to point
	// the operator at the pid instead of saying nothing.
	it('names the holding pid when the holder has not handshaken yet', () => {
		const repoRoot = checkout('swarm');
		acquire(repoRoot, 4001);

		const err = expectHeld(() => acquire(repoRoot, 4002));
		expect(err.holder?.workerId).toBeNull();
		expect(err.message).toContain('pid 4001');
		expect(err.message).toContain(HOST);
	});

	// Two checkouts of one repository are legitimate capacity — the lock is on the
	// checkout, not on the repository or the host.
	it('lets a second worker take a different checkout on the same host', () => {
		const first = acquire(checkout('swarm'), 4001);
		const second = acquire(checkout('swarm-2'), 4002);

		expect(second.lockDir).not.toBe(first.lockDir);
		expect(readOwner(second.lockDir).pid).toBe(4002);
	});

	// A symlinked (or otherwise differently spelled) path is the same checkout, so it
	// must collide rather than hand out a second lock on one working tree.
	it('keys the lock to the checkout, not to the spelling of the path', () => {
		const repoRoot = checkout('swarm');
		const alias = resolve(home, 'alias');
		symlinkSync(repoRoot, alias, 'dir');
		acquire(repoRoot, 4001);

		expect(expectHeld(() => acquire(alias, 4002)).holder?.pid).toBe(4001);
		expect(expectHeld(() => acquire(`${repoRoot}/`, 4002)).holder?.pid).toBe(4001);
	});

	it('reclaims the lock of a worker whose process is gone', () => {
		const repoRoot = checkout('swarm');
		acquire(repoRoot, 4001);

		live.delete(4001);
		const replacement = acquire(repoRoot, 4002);
		expect(readOwner(replacement.lockDir).pid).toBe(4002);
	});

	// The backstop for what liveness cannot see: a recycled pid that is live but
	// belongs to something else entirely.
	it('reclaims a live-pid lock whose refresh has lapsed', () => {
		const repoRoot = checkout('swarm');
		acquire(repoRoot, 4001);

		clock += CHECKOUT_LOCK_TTL_MS + 1;
		const replacement = acquire(repoRoot, 4002);
		expect(readOwner(replacement.lockDir).pid).toBe(4002);
	});

	it('keeps a refreshed lock held past the TTL', () => {
		const repoRoot = checkout('swarm');
		const first = acquire(repoRoot, 4001);

		for (let elapsed = 0; elapsed < CHECKOUT_LOCK_TTL_MS * 3; elapsed += CHECKOUT_LOCK_TTL_MS / 2) {
			clock += CHECKOUT_LOCK_TTL_MS / 2;
			expect(first.refresh()).toBe(true);
		}

		expect(expectHeld(() => acquire(repoRoot, 4002)).holder?.pid).toBe(4001);
		expect(readOwner(first.lockDir).refreshedAt).toBe(new Date(clock).toISOString());
		// The refresh restamps only `refreshedAt` — `createdAt` still says when this
		// daemon took the checkout.
		expect(readOwner(first.lockDir).createdAt).not.toBe(readOwner(first.lockDir).refreshedAt);
	});

	it('makes a released lock immediately re-acquirable', () => {
		const repoRoot = checkout('swarm');
		const first = acquire(repoRoot, 4001);
		first.release();

		const second = acquire(repoRoot, 4002);
		expect(readOwner(second.lockDir).pid).toBe(4002);
	});

	// A daemon that lost its lock (reclaimed after its refresh lapsed) must not stomp
	// the record of the worker that took over, nor delete its lock on the way out.
	it('does not overwrite or remove a lock another worker has taken over', () => {
		const repoRoot = checkout('swarm');
		const first = acquire(repoRoot, 4001);
		clock += CHECKOUT_LOCK_TTL_MS + 1;
		const second = acquire(repoRoot, 4002);

		expect(first.refresh()).toBe(false);
		expect(first.annotate(WORKER_A)).toBe(false);
		first.release();

		expect(readOwner(second.lockDir).pid).toBe(4002);
		expect(readOwner(second.lockDir).workerId).toBeNull();
	});

	it('adopts its own lock rather than refusing itself', () => {
		const repoRoot = checkout('swarm');
		const first = acquire(repoRoot, 4001);
		first.annotate(WORKER_A);

		const again = acquire(repoRoot, 4001);
		expect(again.holder.workerId).toBe(WORKER_A);
		expect(again.lockDir).toBe(first.lockDir);
	});

	// An owner file that cannot be read offers no owner to prove dead, so the
	// directory's own age is all that can decide — occupied until it outlives the TTL.
	it('treats an unreadable owner record as occupied until it ages past the TTL', () => {
		const repoRoot = checkout('swarm');
		const lock = acquire(repoRoot, 4001);
		writeFileSync(resolve(lock.lockDir, 'owner.json'), 'not json at all', 'utf8');

		const err = expectHeld(() => acquire(repoRoot, 4002));
		expect(err.holder).toBeUndefined();
		expect(err.message).toContain('unreadable');

		// A minute past the TTL rather than a millisecond: this fallback ages the
		// *directory*, whose mtime comes from the real clock rather than the injected one.
		clock += CHECKOUT_LOCK_TTL_MS + 60_000;
		expect(readOwner(acquire(repoRoot, 4002).lockDir).pid).toBe(4002);
	});

	// Only a crash between `mkdir` and the owner write leaves this behind, and it is
	// otherwise unrecoverable: the create keeps failing `EEXIST` with nothing to read.
	it('reclaims a lock directory that never got its owner record', () => {
		const repoRoot = checkout('swarm');
		const lock = acquire(repoRoot, 4001);
		rmSync(resolve(lock.lockDir, 'owner.json'), { force: true });

		expectHeld(() => acquire(repoRoot, 4002));
		clock += CHECKOUT_LOCK_TTL_MS + 60_000;
		expect(readOwner(acquire(repoRoot, 4002).lockDir).pid).toBe(4002);
	});

	function expectHeld(attempt: () => unknown): CheckoutHeldError {
		let thrown: unknown;
		try {
			attempt();
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(CheckoutHeldError);
		return thrown as CheckoutHeldError;
	}
});
