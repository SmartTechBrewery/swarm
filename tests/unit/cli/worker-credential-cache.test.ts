import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	readWorkerCredentialCache,
	workerCredentialCachePath,
	writeWorkerCredentialCache,
} from '@/cli/_shared/worker-credential-cache.js';
import { acquireCheckoutLock } from '@/worktree/checkout-lock.js';

const WORKER_A = '11111111-1111-4111-8111-111111111111';
const WORKER_B = '22222222-2222-4222-8222-222222222222';

describe('worker credential cache (per checkout)', () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'swarm-worker-credential-'));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	/** A checkout to key on — real and canonical, so its realpath resolves to itself. */
	function checkout(name: string): string {
		const path = resolve(home, 'checkouts', name);
		mkdirSync(path, { recursive: true });
		return realpathSync(path);
	}

	function write(repoRoot: string, workerId = WORKER_A, credential = 'raw-credential-token') {
		return writeWorkerCredentialCache({ repoRoot, workerId, credential, homeDir: home });
	}

	function mode(path: string): number {
		return statSync(path).mode & 0o777;
	}

	it('writes the entry under ~/.swarm/worker-credentials/<sha256 of the realpath>/', () => {
		const repoRoot = checkout('swarm');
		const path = write(repoRoot);

		const hash = createHash('sha256').update(repoRoot).digest('hex');
		expect(path).toBe(resolve(home, '.swarm', 'worker-credentials', hash, 'credential.json'));
		expect(path).toBe(workerCredentialCachePath(repoRoot, home));
	});

	it('round-trips the worker id, credential, checkout and registration time', () => {
		const repoRoot = checkout('swarm');
		write(repoRoot);

		expect(readWorkerCredentialCache(repoRoot, home)).toMatchObject({
			workerId: WORKER_A,
			credential: 'raw-credential-token',
			repoRoot,
		});
		const registeredAt = readWorkerCredentialCache(repoRoot, home)?.registeredAt ?? '';
		expect(Number.isNaN(Date.parse(registeredAt))).toBe(false);
	});

	it('keeps the directory and file owner-only', () => {
		const repoRoot = checkout('swarm');
		const path = write(repoRoot);

		expect(mode(path)).toBe(0o600);
		expect(mode(dirname(path))).toBe(0o700);
		expect(mode(dirname(dirname(path)))).toBe(0o700);
	});

	it('keys on the realpath, so a symlinked spelling finds the same entry', () => {
		const repoRoot = checkout('swarm');
		const link = resolve(home, 'link-to-swarm');
		symlinkSync(repoRoot, link);

		write(link, WORKER_A, 'via-the-symlink');

		expect(readWorkerCredentialCache(repoRoot, home)).toMatchObject({
			credential: 'via-the-symlink',
			repoRoot,
		});
		// Also from a trailing-slash / relative spelling of the same checkout.
		expect(readWorkerCredentialCache(`${repoRoot}/`, home)?.credential).toBe('via-the-symlink');
	});

	it('replaces the entry on a second registration, keeping it owner-only', () => {
		const repoRoot = checkout('swarm');
		write(repoRoot, WORKER_A, 'first-credential');
		const path = write(repoRoot, WORKER_B, 'second-credential');

		expect(readWorkerCredentialCache(repoRoot, home)).toMatchObject({
			workerId: WORKER_B,
			credential: 'second-credential',
		});
		expect(mode(path)).toBe(0o600);
		// One entry per checkout, not an accumulating pile — and no temp file left behind.
		expect(readdirSync(dirname(path))).toEqual(['credential.json']);
	});

	it('distinguishes "no entry" from "unreadable entry"', () => {
		const repoRoot = checkout('swarm');
		expect(readWorkerCredentialCache(repoRoot, home)).toBeNull();

		const path = write(repoRoot);
		writeFileSync(path, '{ not json', 'utf8');
		expect(readWorkerCredentialCache(repoRoot, home)).toBeUndefined();

		// A well-formed file of the wrong shape is unreadable too, not absent.
		writeFileSync(path, JSON.stringify({ workerId: WORKER_A }), 'utf8');
		expect(readWorkerCredentialCache(repoRoot, home)).toBeUndefined();
	});

	it('answers per checkout — a second checkout has its own entry', () => {
		const first = checkout('swarm');
		const second = checkout('swarm-two');
		write(first, WORKER_A, 'first-credential');
		write(second, WORKER_B, 'second-credential');

		expect(readWorkerCredentialCache(first, home)?.credential).toBe('first-credential');
		expect(readWorkerCredentialCache(second, home)?.credential).toBe('second-credential');
	});

	// The acceptance criterion behind "no project ever needs a .gitignore entry".
	it('writes nothing inside the checkout itself', () => {
		const repoRoot = checkout('swarm');
		const path = write(repoRoot);

		expect(path.startsWith(resolve(home, '.swarm'))).toBe(true);
		expect(path.startsWith(repoRoot)).toBe(false);
		expect(readdirSync(repoRoot)).toEqual([]);
		expect(existsSync(resolve(repoRoot, '.swarm-state'))).toBe(false);
	});

	// "Mirrors the checkout-lock convention exactly", in executable form.
	it('shares the checkout lock’s <sha256> leaf name under ~/.swarm', () => {
		const repoRoot = checkout('swarm');
		const path = write(repoRoot);
		const lock = acquireCheckoutLock({ repoRoot, homeDir: home });

		try {
			expect(dirname(path).split('/').pop()).toBe(lock.lockDir.split('/').pop());
			expect(dirname(dirname(path))).toBe(resolve(home, '.swarm', 'worker-credentials'));
			expect(dirname(lock.lockDir)).toBe(resolve(home, '.swarm', 'checkout-locks'));
		} finally {
			lock.release();
		}
	});
});
