import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/usersRepository.js', () => ({
	hasAnyUser: vi.fn(),
	createFirstInstanceAdmin: vi.fn(),
}));

import { createFirstInstanceAdmin, hasAnyUser } from '@/db/repositories/usersRepository.js';
import { verifyPassword } from '@/identity/auth.js';
import {
	_resetFirstRunSetupForTesting,
	announceFirstRunSetup,
	completeFirstRunSetup,
	SETUP_TOKEN_TTL_MS,
} from '@/identity/first-run-setup.js';
import type { SwarmUser } from '@/identity/schema.js';
import { logger } from '@/lib/logger.js';

const admin: SwarmUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'ada@example.com',
	displayName: 'ada@example.com',
	instanceAdmin: true,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const LOG_METHODS = ['debug', 'info', 'warn', 'error'] as const;

/** Every message + context any logger method received, rendered as text. */
function allLoggedText(): string[] {
	return LOG_METHODS.flatMap((method) =>
		vi.mocked(logger[method]).mock.calls.map((args) => JSON.stringify(args)),
	);
}

/** The token from the one logged setup link, or `undefined` when none was logged. */
function loggedToken(): string | undefined {
	for (const [message] of vi.mocked(logger.warn).mock.calls) {
		const match = /\/setup\?token=([A-Za-z0-9_-]+)/.exec(message);
		if (match) return match[1];
	}
	return undefined;
}

const input = (token: string) => ({ token, identifier: 'ada@example.com', password: 'hunter2' });

describe('first-run setup', () => {
	beforeEach(() => {
		_resetFirstRunSetupForTesting();
		for (const method of LOG_METHODS) vi.spyOn(logger, method).mockImplementation(() => {});
		vi.mocked(hasAnyUser).mockReset().mockResolvedValue(false);
		vi.mocked(createFirstInstanceAdmin).mockReset().mockResolvedValue(admin);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('announceFirstRunSetup', () => {
		it('logs one setup link with an empty users table, and the token nowhere else', async () => {
			await announceFirstRunSetup({ singleUserMode: false });

			const token = loggedToken();
			expect(token).toBeDefined();
			expect(token?.length).toBeGreaterThanOrEqual(40);
			const mentions = allLoggedText().filter((text) => text.includes(token as string));
			expect(mentions).toHaveLength(1);
			expect(vi.mocked(logger.warn).mock.calls[0][0]).toMatch(
				/^No users exist yet\. Open \/setup\?token=/,
			);
		});

		it('prefixes the link with the given base URL without doubling the slash', async () => {
			await announceFirstRunSetup({ singleUserMode: false, baseUrl: 'https://swarm.example.com/' });

			expect(vi.mocked(logger.warn).mock.calls[0][0]).toContain(
				'Open https://swarm.example.com/setup?token=',
			);
		});

		it('issues nothing when a user already exists', async () => {
			vi.mocked(hasAnyUser).mockResolvedValue(true);

			await announceFirstRunSetup({ singleUserMode: false });

			expect(allLoggedText().some((text) => text.includes('token='))).toBe(false);
			expect(await completeFirstRunSetup(input('anything'))).toEqual({ outcome: 'invalid-link' });
		});

		it('drops a held link once a user exists (e.g. one created via the CLI)', async () => {
			await announceFirstRunSetup({ singleUserMode: false });
			const token = loggedToken() as string;
			vi.mocked(hasAnyUser).mockResolvedValue(true);

			await announceFirstRunSetup({ singleUserMode: false });

			expect(await completeFirstRunSetup(input(token))).toEqual({ outcome: 'invalid-link' });
		});

		it('issues nothing in single-user mode and never reads the database', async () => {
			await announceFirstRunSetup({ singleUserMode: true });

			expect(hasAnyUser).not.toHaveBeenCalled();
			expect(loggedToken()).toBeUndefined();
		});

		it('logs an error and issues nothing when the user check fails, without throwing', async () => {
			vi.mocked(hasAnyUser).mockRejectedValue(new Error('relation "users" does not exist'));

			await expect(announceFirstRunSetup({ singleUserMode: false })).resolves.toBeUndefined();

			expect(logger.error).toHaveBeenCalledTimes(1);
			expect(loggedToken()).toBeUndefined();
		});
	});

	describe('completeFirstRunSetup', () => {
		it('creates the admin once with a hashed password, then refuses the same link', async () => {
			await announceFirstRunSetup({ singleUserMode: false });
			const token = loggedToken() as string;

			expect(await completeFirstRunSetup(input(token))).toEqual({
				outcome: 'created',
				user: admin,
			});
			expect(createFirstInstanceAdmin).toHaveBeenCalledTimes(1);
			const [args] = vi.mocked(createFirstInstanceAdmin).mock.calls[0];
			expect(args.identifier).toBe('ada@example.com');
			expect(args.displayName).toBe('ada@example.com');
			expect(args.passwordHash).not.toContain('hunter2');
			expect(await verifyPassword('hunter2', args.passwordHash)).toBe(true);

			expect(await completeFirstRunSetup(input(token))).toEqual({ outcome: 'invalid-link' });
			expect(createFirstInstanceAdmin).toHaveBeenCalledTimes(1);
		});

		it('refuses a wrong token without touching the database or burning the real link', async () => {
			await announceFirstRunSetup({ singleUserMode: false });
			const token = loggedToken() as string;

			expect(await completeFirstRunSetup(input('not-the-token'))).toEqual({
				outcome: 'invalid-link',
			});
			expect(createFirstInstanceAdmin).not.toHaveBeenCalled();
			expect((await completeFirstRunSetup(input(token))).outcome).toBe('created');
		});

		it('refuses an expired link', async () => {
			const issuedAt = new Date('2026-10-28T10:00:00Z');
			await announceFirstRunSetup({ singleUserMode: false, now: issuedAt });
			const token = loggedToken() as string;

			const expired = new Date(issuedAt.getTime() + SETUP_TOKEN_TTL_MS);
			expect(await completeFirstRunSetup(input(token), expired)).toEqual({
				outcome: 'invalid-link',
			});
			expect(createFirstInstanceAdmin).not.toHaveBeenCalled();
		});

		it('invalidates the previous link when a new one is announced', async () => {
			await announceFirstRunSetup({ singleUserMode: false });
			const first = loggedToken() as string;
			vi.mocked(logger.warn).mockClear();
			await announceFirstRunSetup({ singleUserMode: false });
			const second = loggedToken() as string;

			expect(second).not.toBe(first);
			expect(await completeFirstRunSetup(input(first))).toEqual({ outcome: 'invalid-link' });
			expect((await completeFirstRunSetup(input(second))).outcome).toBe('created');
		});

		it('lets only one of two concurrent submissions of the same link through', async () => {
			await announceFirstRunSetup({ singleUserMode: false });
			const token = loggedToken() as string;

			const results = await Promise.all([
				completeFirstRunSetup(input(token)),
				completeFirstRunSetup(input(token)),
			]);

			expect(results.map((r) => r.outcome).sort()).toEqual(['created', 'invalid-link']);
			expect(createFirstInstanceAdmin).toHaveBeenCalledTimes(1);
		});

		it('reports already-set-up when the database already has a user', async () => {
			vi.mocked(createFirstInstanceAdmin).mockResolvedValue(undefined);
			await announceFirstRunSetup({ singleUserMode: false });

			expect(await completeFirstRunSetup(input(loggedToken() as string))).toEqual({
				outcome: 'already-set-up',
			});
		});
	});
});
