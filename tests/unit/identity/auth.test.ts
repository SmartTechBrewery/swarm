import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/usersRepository.js', () => ({
	findUserCredentialByIdentifier: vi.fn(),
	findUserCredentialById: vi.fn(),
	getUserById: vi.fn(),
	ensureLocalAdminUser: vi.fn(),
	setPasswordHash: vi.fn(),
}));

vi.mock('@/db/repositories/userSessionsRepository.js', () => ({
	insertSession: vi.fn(),
	findUserIdBySessionToken: vi.fn(),
	deleteSessionByToken: vi.fn(),
	deleteExpiredSessions: vi.fn(),
}));

import {
	deleteExpiredSessions,
	deleteSessionByToken,
	findUserIdBySessionToken,
	insertSession,
} from '@/db/repositories/userSessionsRepository.js';
import {
	ensureLocalAdminUser,
	findUserCredentialById,
	findUserCredentialByIdentifier,
	getUserById,
	setPasswordHash,
} from '@/db/repositories/usersRepository.js';
import {
	changeOwnPassword,
	createSession,
	hashPassword,
	resolveSession,
	resolveSingleUser,
	revokeSession,
	verifyCredentials,
	verifyPassword,
} from '@/identity/auth.js';
import type { SwarmUser } from '@/identity/schema.js';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const user: SwarmUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'ada@example.com',
	displayName: 'Ada',
	instanceAdmin: false,
	createdAt: new Date('2020-01-01T00:00:00Z'),
	updatedAt: new Date('2020-01-01T00:00:00Z'),
};

beforeEach(() => {
	vi.mocked(findUserCredentialByIdentifier).mockReset();
	vi.mocked(getUserById).mockReset();
	vi.mocked(insertSession).mockReset().mockResolvedValue(undefined);
	vi.mocked(findUserIdBySessionToken).mockReset();
	vi.mocked(deleteSessionByToken).mockReset().mockResolvedValue(undefined);
	vi.mocked(deleteExpiredSessions).mockReset().mockResolvedValue(0);
	vi.mocked(ensureLocalAdminUser).mockReset();
	vi.mocked(findUserCredentialById).mockReset();
	vi.mocked(setPasswordHash).mockReset().mockResolvedValue(true);
});

describe('password hashing', () => {
	it('round-trips a correct password and rejects a wrong one', async () => {
		const hash = await hashPassword('correct horse battery staple');
		expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
		expect(await verifyPassword('wrong password', hash)).toBe(false);
	});

	it('uses a fresh salt so the same password hashes differently each time', async () => {
		const a = await hashPassword('same');
		const b = await hashPassword('same');
		expect(a).not.toBe(b);
		// Both still verify — the salt lives in the stored value.
		expect(await verifyPassword('same', a)).toBe(true);
		expect(await verifyPassword('same', b)).toBe(true);
	});

	it('never stores the plaintext in the hash', async () => {
		const hash = await hashPassword('supersecret');
		expect(hash).not.toContain('supersecret');
		expect(hash).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
	});

	it('returns false (never throws) for a malformed stored hash', async () => {
		expect(await verifyPassword('x', '')).toBe(false);
		expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
		expect(await verifyPassword('x', ':')).toBe(false);
	});
});

describe('verifyCredentials', () => {
	it('returns the user for a correct identifier + password', async () => {
		const passwordHash = await hashPassword('hunter2');
		vi.mocked(findUserCredentialByIdentifier).mockResolvedValue({ user, passwordHash });

		expect(await verifyCredentials('ada@example.com', 'hunter2')).toEqual(user);
	});

	it('returns undefined for a wrong password', async () => {
		const passwordHash = await hashPassword('hunter2');
		vi.mocked(findUserCredentialByIdentifier).mockResolvedValue({ user, passwordHash });

		expect(await verifyCredentials('ada@example.com', 'nope')).toBeUndefined();
	});

	it('returns undefined for an unknown user', async () => {
		vi.mocked(findUserCredentialByIdentifier).mockResolvedValue(undefined);
		expect(await verifyCredentials('ghost@example.com', 'whatever')).toBeUndefined();
	});

	it('returns undefined for a user with no password set', async () => {
		vi.mocked(findUserCredentialByIdentifier).mockResolvedValue({ user, passwordHash: null });
		expect(await verifyCredentials('ada@example.com', 'whatever')).toBeUndefined();
	});
});

describe('changeOwnPassword', () => {
	it('re-credentials the user against a verified current password', async () => {
		const oldHash = await hashPassword('hunter2');
		vi.mocked(findUserCredentialById).mockResolvedValue({ user, passwordHash: oldHash });

		expect(
			await changeOwnPassword({
				userId: user.id,
				currentPassword: 'hunter2',
				newPassword: 'correct horse battery staple',
			}),
		).toBe('changed');

		expect(findUserCredentialById).toHaveBeenCalledWith(user.id);
		expect(setPasswordHash).toHaveBeenCalledTimes(1);
		const [storedId, storedHash] = vi.mocked(setPasswordHash).mock.calls[0];
		expect(storedId).toBe(user.id);
		expect(storedHash).not.toBe(oldHash);
		// The stored value is a hash of the *new* password, and the old one no
		// longer verifies against it.
		expect(await verifyPassword('correct horse battery staple', storedHash)).toBe(true);
		expect(await verifyPassword('hunter2', storedHash)).toBe(false);
		expect(storedHash).not.toContain('correct horse battery staple');
	});

	it('rejects a wrong current password without writing anything', async () => {
		vi.mocked(findUserCredentialById).mockResolvedValue({
			user,
			passwordHash: await hashPassword('hunter2'),
		});

		expect(
			await changeOwnPassword({
				userId: user.id,
				currentPassword: 'nope',
				newPassword: 'whatever-else',
			}),
		).toBe('invalid-current-password');
		expect(setPasswordHash).not.toHaveBeenCalled();
	});

	it('fails closed for an account with no password set', async () => {
		// The bootstrapped single-user admin is passwordless: a null hash must
		// never be treated as "any current password matches".
		vi.mocked(findUserCredentialById).mockResolvedValue({ user, passwordHash: null });

		expect(
			await changeOwnPassword({
				userId: user.id,
				currentPassword: 'anything',
				newPassword: 'whatever-else',
			}),
		).toBe('no-password-set');
		expect(setPasswordHash).not.toHaveBeenCalled();
	});

	it('reports an unknown user without writing anything', async () => {
		vi.mocked(findUserCredentialById).mockResolvedValue(undefined);

		expect(
			await changeOwnPassword({
				userId: user.id,
				currentPassword: 'hunter2',
				newPassword: 'whatever-else',
			}),
		).toBe('unknown-user');
		expect(setPasswordHash).not.toHaveBeenCalled();
	});
});

describe('session lifecycle', () => {
	it('mints a session storing only the token hash, never the raw token', async () => {
		const { token, expiresAt } = await createSession(user.id);

		expect(token).toBeTruthy();
		expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
		expect(insertSession).toHaveBeenCalledTimes(1);
		const stored = vi.mocked(insertSession).mock.calls[0][0];
		expect(stored.userId).toBe(user.id);
		expect(stored.tokenHash).toBe(sha256(token));
		expect(stored.tokenHash).not.toBe(token);
	});

	it('uses SWARM_SESSION_TTL_HOURS for the session expiry', async () => {
		const original = process.env.SWARM_SESSION_TTL_HOURS;
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-08-28T12:00:00.000Z'));
		process.env.SWARM_SESSION_TTL_HOURS = '1';

		try {
			const { expiresAt } = await createSession(user.id);
			expect(expiresAt.toISOString()).toBe('2026-08-28T13:00:00.000Z');
		} finally {
			vi.useRealTimers();
			if (original === undefined) delete process.env.SWARM_SESSION_TTL_HOURS;
			else process.env.SWARM_SESSION_TTL_HOURS = original;
		}
	});

	it('resolves a live session token to its user (looked up by hash)', async () => {
		vi.mocked(findUserIdBySessionToken).mockResolvedValue(user.id);
		vi.mocked(getUserById).mockResolvedValue(user);

		expect(await resolveSession('raw-token')).toEqual(user);
		expect(findUserIdBySessionToken).toHaveBeenCalledWith(sha256('raw-token'));
	});

	it('returns undefined for an unknown/expired token and for an empty token', async () => {
		vi.mocked(findUserIdBySessionToken).mockResolvedValue(undefined);
		expect(await resolveSession('stale')).toBeUndefined();
		expect(await resolveSession('')).toBeUndefined();
		expect(findUserIdBySessionToken).toHaveBeenCalledTimes(1); // not called for the empty token
	});

	it('revokes a session by its hashed token', async () => {
		await revokeSession('raw-token');
		expect(deleteSessionByToken).toHaveBeenCalledWith(sha256('raw-token'));
	});
});

describe('resolveSingleUser', () => {
	it('returns the ensured local admin without touching any session state', async () => {
		const admin: SwarmUser = { ...user, displayName: 'Local Admin', instanceAdmin: true };
		vi.mocked(ensureLocalAdminUser).mockResolvedValue(admin);

		expect(await resolveSingleUser()).toEqual(admin);
		expect(ensureLocalAdminUser).toHaveBeenCalledTimes(1);
		// The single-user path is deliberately session-free.
		expect(findUserIdBySessionToken).not.toHaveBeenCalled();
		expect(insertSession).not.toHaveBeenCalled();
	});
});
