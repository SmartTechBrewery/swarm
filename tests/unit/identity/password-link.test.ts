import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/userPasswordTokensRepository.js', () => ({
	createUserWithPasswordToken: vi.fn(),
	replacePasswordToken: vi.fn(),
	redeemPasswordToken: vi.fn(),
}));

vi.mock('@/db/repositories/usersRepository.js', () => ({
	getUserById: vi.fn(),
}));

import {
	createUserWithPasswordToken,
	redeemPasswordToken,
	replacePasswordToken,
} from '@/db/repositories/userPasswordTokensRepository.js';
import { getUserById } from '@/db/repositories/usersRepository.js';
import { verifyPassword } from '@/identity/auth.js';
import {
	createUserWithPasswordLink,
	issuePasswordLink,
	PASSWORD_LINK_TTL_MS,
	redeemPasswordLink,
} from '@/identity/password-link.js';
import type { SwarmUser } from '@/identity/schema.js';

const user: SwarmUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'ada@example.com',
	displayName: 'Ada',
	instanceAdmin: false,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const NOW = new Date('2026-10-01T12:00:00Z');

const sha256hex = (value: string) => createHash('sha256').update(value).digest('hex');

describe('password links (issue #1151)', () => {
	beforeEach(() => {
		vi.mocked(createUserWithPasswordToken).mockReset();
		vi.mocked(replacePasswordToken).mockReset().mockResolvedValue(undefined);
		vi.mocked(redeemPasswordToken).mockReset();
		vi.mocked(getUserById).mockReset();
	});

	describe('createUserWithPasswordLink', () => {
		const input = { identifier: 'ada@example.com', displayName: 'Ada', instanceAdmin: false };

		it('returns a 256-bit token and persists only its hash, expiring after the TTL', async () => {
			vi.mocked(createUserWithPasswordToken).mockResolvedValue(user);

			const result = await createUserWithPasswordLink(input, NOW);

			if (result.outcome !== 'created') throw new Error('expected a created link');
			const { token, expiresAt } = result.link;
			expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(Buffer.from(token, 'base64url')).toHaveLength(32);
			expect(expiresAt).toEqual(new Date(NOW.getTime() + PASSWORD_LINK_TTL_MS));
			expect(result.link.user).toBe(user);

			const [stored] = vi.mocked(createUserWithPasswordToken).mock.calls[0];
			expect(stored).toEqual({ ...input, tokenHash: sha256hex(token), expiresAt, now: NOW });
			expect(JSON.stringify(stored)).not.toContain(token);
		});

		it('mints a different token every time', async () => {
			vi.mocked(createUserWithPasswordToken).mockResolvedValue(user);

			const first = await createUserWithPasswordLink(input, NOW);
			const second = await createUserWithPasswordLink(input, NOW);

			if (first.outcome !== 'created' || second.outcome !== 'created') throw new Error('expected');
			expect(first.link.token).not.toBe(second.link.token);
		});

		it.each([
			['a raw pg unique violation', Object.assign(new Error('dup'), { code: '23505' })],
			[
				"drizzle's wrapped unique violation",
				Object.assign(new Error('Failed query'), { cause: { code: '23505' } }),
			],
		])('maps %s to identifier-taken', async (_label, error) => {
			vi.mocked(createUserWithPasswordToken).mockRejectedValue(error);

			expect(await createUserWithPasswordLink(input, NOW)).toEqual({
				outcome: 'identifier-taken',
			});
		});

		it('rethrows any other error', async () => {
			vi.mocked(createUserWithPasswordToken).mockRejectedValue(new Error('connection refused'));

			await expect(createUserWithPasswordLink(input, NOW)).rejects.toThrow('connection refused');
		});
	});

	describe('issuePasswordLink', () => {
		it("replaces the user's link with the new token's hash", async () => {
			vi.mocked(getUserById).mockResolvedValue(user);

			const link = await issuePasswordLink(user.id, NOW);

			expect(link?.user).toBe(user);
			expect(link?.expiresAt).toEqual(new Date(NOW.getTime() + PASSWORD_LINK_TTL_MS));
			expect(replacePasswordToken).toHaveBeenCalledWith({
				userId: user.id,
				tokenHash: sha256hex(link?.token ?? ''),
				expiresAt: link?.expiresAt,
				now: NOW,
			});
		});

		it('returns undefined for an unknown user without minting a link', async () => {
			vi.mocked(getUserById).mockResolvedValue(undefined);

			expect(await issuePasswordLink(user.id, NOW)).toBeUndefined();
			expect(replacePasswordToken).not.toHaveBeenCalled();
		});
	});

	describe('redeemPasswordLink', () => {
		it("claims the token's hash with a scrypt hash of the new password", async () => {
			vi.mocked(redeemPasswordToken).mockResolvedValue(user.id);
			vi.mocked(getUserById).mockResolvedValue(user);

			const result = await redeemPasswordLink({ token: 'raw-token', password: 'hunter2' }, NOW);

			expect(result).toEqual({ outcome: 'set', user });
			const [claim] = vi.mocked(redeemPasswordToken).mock.calls[0];
			expect(claim.tokenHash).toBe(sha256hex('raw-token'));
			expect(claim.now).toBe(NOW);
			expect(claim.passwordHash).not.toContain('hunter2');
			expect(await verifyPassword('hunter2', claim.passwordHash)).toBe(true);
		});

		it('reports invalid-link when no live token matched', async () => {
			vi.mocked(redeemPasswordToken).mockResolvedValue(undefined);

			expect(await redeemPasswordLink({ token: 'raw-token', password: 'hunter2' }, NOW)).toEqual({
				outcome: 'invalid-link',
			});
			expect(getUserById).not.toHaveBeenCalled();
		});
	});
});
