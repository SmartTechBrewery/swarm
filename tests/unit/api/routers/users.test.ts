import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/usersRepository.js', () => ({
	getUserById: vi.fn(),
	listUsers: vi.fn(),
	setInstanceAdmin: vi.fn(),
	revokeInstanceAdminUnlessLast: vi.fn(),
}));

vi.mock('@/db/repositories/userIdentitiesRepository.js', () => ({
	listIdentities: vi.fn(),
	linkIdentity: vi.fn(),
	unlinkIdentity: vi.fn(),
}));

vi.mock('@/identity/password-link.js', () => ({
	createUserWithPasswordLink: vi.fn(),
	issuePasswordLink: vi.fn(),
}));

import { usersRouter } from '@/api/routers/users.js';
import {
	linkIdentity,
	listIdentities,
	unlinkIdentity,
} from '@/db/repositories/userIdentitiesRepository.js';
import {
	getUserById,
	listUsers,
	revokeInstanceAdminUnlessLast,
	setInstanceAdmin,
} from '@/db/repositories/usersRepository.js';
import { createUserWithPasswordLink, issuePasswordLink } from '@/identity/password-link.js';
import type { SwarmUser } from '@/identity/schema.js';
import { IdentityLinkConflictError, type UserIdentity } from '@/identity/user-identity.js';

const ADMIN_USER: SwarmUser = {
	id: '00000000-0000-4000-8000-000000000000',
	identifier: 'admin@example.com',
	displayName: 'Admin',
	instanceAdmin: true,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const ORDINARY_USER: SwarmUser = {
	...ADMIN_USER,
	id: '00000000-0000-4000-8000-0000000000ff',
	identifier: 'member@example.com',
	displayName: 'Member',
	instanceAdmin: false,
};

const TARGET_ID = ORDINARY_USER.id;
const EXPIRES_AT = new Date('2026-10-04T12:00:00Z');

async function expectCode(promise: Promise<unknown>, code: TRPCError['code']): Promise<void> {
	await expect(promise).rejects.toBeInstanceOf(TRPCError);
	await expect(promise).rejects.toMatchObject({ code });
}

describe('usersRouter (issue #1151)', () => {
	const caller = usersRouter.createCaller({ user: ADMIN_USER });
	const ordinaryCaller = usersRouter.createCaller({ user: ORDINARY_USER });

	beforeEach(() => {
		vi.mocked(listUsers).mockReset();
		vi.mocked(setInstanceAdmin).mockReset();
		vi.mocked(revokeInstanceAdminUnlessLast).mockReset();
		vi.mocked(createUserWithPasswordLink).mockReset();
		vi.mocked(issuePasswordLink).mockReset();
		vi.mocked(getUserById).mockReset();
		vi.mocked(listIdentities).mockReset();
		vi.mocked(linkIdentity).mockReset();
		vi.mocked(unlinkIdentity).mockReset();
	});

	describe('authorization', () => {
		it.each([
			['list', () => ordinaryCaller.list()],
			['create', () => ordinaryCaller.create({ identifier: 'new@example.com' })],
			['issuePasswordLink', () => ordinaryCaller.issuePasswordLink({ userId: TARGET_ID })],
			['grantAdmin', () => ordinaryCaller.grantAdmin({ userId: ORDINARY_USER.id })],
			['revokeAdmin', () => ordinaryCaller.revokeAdmin({ userId: ADMIN_USER.id })],
			// Refused before input validation, so a malformed request learns nothing more.
			['create with a blank identifier', () => ordinaryCaller.create({ identifier: ' ' })],
			['identities.list', () => ordinaryCaller.identities.list()],
			[
				'identities.link',
				() =>
					ordinaryCaller.identities.link({ userId: TARGET_ID, provider: 'jira', handle: 'abc' }),
			],
			[
				'identities.unlink',
				() => ordinaryCaller.identities.unlink({ provider: 'jira', handle: 'abc' }),
			],
			[
				'identities.link with a bogus provider and a blank handle',
				// @ts-expect-error -- deliberately malformed: refused before validation.
				() => ordinaryCaller.identities.link({ userId: 'x', provider: 'nope', handle: ' ' }),
			],
		])('refuses %s to a non-admin without touching any store', async (_label, call) => {
			await expectCode(call(), 'FORBIDDEN');

			expect(listUsers).not.toHaveBeenCalled();
			expect(setInstanceAdmin).not.toHaveBeenCalled();
			expect(revokeInstanceAdminUnlessLast).not.toHaveBeenCalled();
			expect(createUserWithPasswordLink).not.toHaveBeenCalled();
			expect(issuePasswordLink).not.toHaveBeenCalled();
			expect(getUserById).not.toHaveBeenCalled();
			expect(listIdentities).not.toHaveBeenCalled();
			expect(linkIdentity).not.toHaveBeenCalled();
			expect(unlinkIdentity).not.toHaveBeenCalled();
		});

		it('refuses an unauthenticated caller', async () => {
			await expectCode(usersRouter.createCaller({ user: null }).list(), 'UNAUTHORIZED');
			await expectCode(usersRouter.createCaller({ user: null }).identities.list(), 'UNAUTHORIZED');
		});
	});

	it('list returns every user', async () => {
		vi.mocked(listUsers).mockResolvedValue([ADMIN_USER, ORDINARY_USER]);

		expect(await caller.list()).toEqual([ADMIN_USER, ORDINARY_USER]);
	});

	describe('create', () => {
		it('defaults the display name to the identifier and the user to non-admin', async () => {
			const link = { user: ORDINARY_USER, token: 'raw-token', expiresAt: EXPIRES_AT };
			vi.mocked(createUserWithPasswordLink).mockResolvedValue({ outcome: 'created', link });

			expect(await caller.create({ identifier: ' member@example.com ' })).toEqual(link);
			expect(createUserWithPasswordLink).toHaveBeenCalledWith({
				identifier: 'member@example.com',
				displayName: 'member@example.com',
				instanceAdmin: false,
			});
		});

		it('passes an explicit display name and admin flag through', async () => {
			vi.mocked(createUserWithPasswordLink).mockResolvedValue({
				outcome: 'created',
				link: { user: ADMIN_USER, token: 'raw-token', expiresAt: EXPIRES_AT },
			});

			await caller.create({
				identifier: 'boss@example.com',
				displayName: 'Boss',
				instanceAdmin: true,
			});

			expect(createUserWithPasswordLink).toHaveBeenCalledWith({
				identifier: 'boss@example.com',
				displayName: 'Boss',
				instanceAdmin: true,
			});
		});

		it('maps a taken identifier to CONFLICT', async () => {
			vi.mocked(createUserWithPasswordLink).mockResolvedValue({ outcome: 'identifier-taken' });

			await expectCode(caller.create({ identifier: 'member@example.com' }), 'CONFLICT');
		});

		it('rejects a blank identifier before creating anything', async () => {
			await expectCode(caller.create({ identifier: '   ' }), 'BAD_REQUEST');
			expect(createUserWithPasswordLink).not.toHaveBeenCalled();
		});
	});

	describe('issuePasswordLink', () => {
		it("returns the new link for the user's id", async () => {
			const link = { user: ORDINARY_USER, token: 'raw-token', expiresAt: EXPIRES_AT };
			vi.mocked(issuePasswordLink).mockResolvedValue(link);

			expect(await caller.issuePasswordLink({ userId: TARGET_ID })).toEqual(link);
			expect(issuePasswordLink).toHaveBeenCalledWith(TARGET_ID);
		});

		it('maps an unknown id to NOT_FOUND', async () => {
			vi.mocked(issuePasswordLink).mockResolvedValue(undefined);

			await expectCode(caller.issuePasswordLink({ userId: TARGET_ID }), 'NOT_FOUND');
		});

		it('rejects a non-uuid id', async () => {
			await expectCode(caller.issuePasswordLink({ userId: 'ada@example.com' }), 'BAD_REQUEST');
			expect(issuePasswordLink).not.toHaveBeenCalled();
		});
	});

	describe('grantAdmin', () => {
		it('sets the flag and returns the user', async () => {
			const promoted = { ...ORDINARY_USER, instanceAdmin: true };
			vi.mocked(setInstanceAdmin).mockResolvedValue(promoted);

			expect(await caller.grantAdmin({ userId: TARGET_ID })).toEqual(promoted);
			expect(setInstanceAdmin).toHaveBeenCalledWith(TARGET_ID, true);
		});

		it('maps an unknown id to NOT_FOUND', async () => {
			vi.mocked(setInstanceAdmin).mockResolvedValue(undefined);

			await expectCode(caller.grantAdmin({ userId: TARGET_ID }), 'NOT_FOUND');
		});
	});

	describe('revokeAdmin', () => {
		it('returns the demoted user', async () => {
			vi.mocked(revokeInstanceAdminUnlessLast).mockResolvedValue({
				outcome: 'revoked',
				user: ORDINARY_USER,
			});

			expect(await caller.revokeAdmin({ userId: TARGET_ID })).toEqual(ORDINARY_USER);
			expect(revokeInstanceAdminUnlessLast).toHaveBeenCalledWith(TARGET_ID);
		});

		it('refuses to revoke the last admin with PRECONDITION_FAILED', async () => {
			vi.mocked(revokeInstanceAdminUnlessLast).mockResolvedValue({ outcome: 'last-admin' });

			await expectCode(caller.revokeAdmin({ userId: ADMIN_USER.id }), 'PRECONDITION_FAILED');
		});

		it('maps an unknown id to NOT_FOUND', async () => {
			vi.mocked(revokeInstanceAdminUnlessLast).mockResolvedValue({ outcome: 'not-found' });

			await expectCode(caller.revokeAdmin({ userId: TARGET_ID }), 'NOT_FOUND');
		});
	});

	describe('identities (issue #1167)', () => {
		const IDENTITY: UserIdentity = {
			id: '00000000-0000-4000-8000-0000000000aa',
			userId: TARGET_ID,
			provider: 'jira',
			handle: 'abc123',
			createdAt: new Date(0),
		};

		it('list returns every link', async () => {
			vi.mocked(listIdentities).mockResolvedValue([IDENTITY]);

			expect(await caller.identities.list()).toEqual([IDENTITY]);
		});

		describe('link', () => {
			it('checks the user exists, then links the trimmed handle', async () => {
				vi.mocked(getUserById).mockResolvedValue(ORDINARY_USER);
				vi.mocked(linkIdentity).mockResolvedValue(IDENTITY);

				expect(
					await caller.identities.link({
						userId: TARGET_ID,
						provider: 'jira',
						handle: '  abc123 ',
					}),
				).toEqual(IDENTITY);
				expect(getUserById).toHaveBeenCalledWith(TARGET_ID);
				expect(linkIdentity).toHaveBeenCalledWith({
					userId: TARGET_ID,
					provider: 'jira',
					handle: 'abc123',
				});
			});

			it('maps an unknown user to NOT_FOUND without linking', async () => {
				vi.mocked(getUserById).mockResolvedValue(undefined);

				await expectCode(
					caller.identities.link({ userId: TARGET_ID, provider: 'jira', handle: 'abc123' }),
					'NOT_FOUND',
				);
				expect(linkIdentity).not.toHaveBeenCalled();
			});

			it('maps a handle owned by another user to CONFLICT naming that user', async () => {
				vi.mocked(getUserById).mockImplementation(async (id) =>
					id === ADMIN_USER.id ? ADMIN_USER : ORDINARY_USER,
				);
				vi.mocked(linkIdentity).mockRejectedValue(
					new IdentityLinkConflictError('jira', 'abc123', ADMIN_USER.id),
				);

				const promise = caller.identities.link({
					userId: TARGET_ID,
					provider: 'jira',
					handle: 'abc123',
				});
				await expectCode(promise, 'CONFLICT');
				await expect(promise).rejects.toThrow(
					'Handle "abc123" on jira is already linked to Admin (admin@example.com)',
				);
			});

			it('names the owner by id when they no longer exist', async () => {
				vi.mocked(getUserById).mockImplementation(async (id) =>
					id === TARGET_ID ? ORDINARY_USER : undefined,
				);
				const ghostId = '00000000-0000-4000-8000-0000000000ee';
				vi.mocked(linkIdentity).mockRejectedValue(
					new IdentityLinkConflictError('jira', 'abc123', ghostId),
				);

				const promise = caller.identities.link({
					userId: TARGET_ID,
					provider: 'jira',
					handle: 'abc123',
				});
				await expectCode(promise, 'CONFLICT');
				await expect(promise).rejects.toThrow(ghostId);
			});

			it('does not map any other failure to CONFLICT', async () => {
				vi.mocked(getUserById).mockResolvedValue(ORDINARY_USER);
				vi.mocked(linkIdentity).mockRejectedValue(new Error('connection reset'));

				await expectCode(
					caller.identities.link({ userId: TARGET_ID, provider: 'jira', handle: 'abc123' }),
					'INTERNAL_SERVER_ERROR',
				);
			});

			it.each([
				['a non-PM provider', { userId: TARGET_ID, provider: 'github', handle: 'ada' }],
				['a blank handle', { userId: TARGET_ID, provider: 'jira', handle: '   ' }],
				['a non-uuid user id', { userId: 'ada@example.com', provider: 'jira', handle: 'ada' }],
			])('rejects %s with BAD_REQUEST', async (_label, input) => {
				// @ts-expect-error -- `provider` is deliberately widened to test validation.
				await expectCode(caller.identities.link(input), 'BAD_REQUEST');
				expect(linkIdentity).not.toHaveBeenCalled();
			});
		});

		describe('unlink', () => {
			it('removes the trimmed pair', async () => {
				vi.mocked(unlinkIdentity).mockResolvedValue(true);

				await caller.identities.unlink({ provider: ' jira ', handle: ' abc123 ' });
				expect(unlinkIdentity).toHaveBeenCalledWith('jira', 'abc123');
			});

			it('maps a pair that was not linked to NOT_FOUND', async () => {
				vi.mocked(unlinkIdentity).mockResolvedValue(false);

				await expectCode(caller.identities.unlink({ provider: 'jira', handle: 'x' }), 'NOT_FOUND');
			});

			it('accepts a provider key outside the PM ids, so a legacy row can be removed', async () => {
				vi.mocked(unlinkIdentity).mockResolvedValue(true);

				await caller.identities.unlink({ provider: 'github', handle: 'ada' });
				expect(unlinkIdentity).toHaveBeenCalledWith('github', 'ada');
			});
		});
	});
});
