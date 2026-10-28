import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/usersRepository.js', () => ({
	listUsers: vi.fn(),
	setInstanceAdmin: vi.fn(),
	revokeInstanceAdminUnlessLast: vi.fn(),
}));

vi.mock('@/identity/password-link.js', () => ({
	createUserWithPasswordLink: vi.fn(),
	issuePasswordLink: vi.fn(),
}));

import { usersRouter } from '@/api/routers/users.js';
import {
	listUsers,
	revokeInstanceAdminUnlessLast,
	setInstanceAdmin,
} from '@/db/repositories/usersRepository.js';
import { createUserWithPasswordLink, issuePasswordLink } from '@/identity/password-link.js';
import type { SwarmUser } from '@/identity/schema.js';

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
		])('refuses %s to a non-admin without touching any store', async (_label, call) => {
			await expectCode(call(), 'FORBIDDEN');

			expect(listUsers).not.toHaveBeenCalled();
			expect(setInstanceAdmin).not.toHaveBeenCalled();
			expect(revokeInstanceAdminUnlessLast).not.toHaveBeenCalled();
			expect(createUserWithPasswordLink).not.toHaveBeenCalled();
			expect(issuePasswordLink).not.toHaveBeenCalled();
		});

		it('refuses an unauthenticated caller', async () => {
			await expectCode(usersRouter.createCaller({ user: null }).list(), 'UNAUTHORIZED');
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
});
