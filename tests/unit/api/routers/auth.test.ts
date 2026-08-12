import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/identity/service.js', () => ({
	renameUser: vi.fn(),
}));
vi.mock('@/identity/auth.js', () => ({
	changeOwnPassword: vi.fn(),
}));

import { authRouter } from '@/api/routers/auth.js';
import { changeOwnPassword } from '@/identity/auth.js';
import type { SwarmUser } from '@/identity/schema.js';
import { renameUser } from '@/identity/service.js';

const USER: SwarmUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'ada@example.com',
	displayName: 'Ada',
	instanceAdmin: false,
	createdAt: new Date('2020-01-01T00:00:00Z'),
	updatedAt: new Date('2020-01-01T00:00:00Z'),
};

const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';

const caller = authRouter.createCaller({ user: USER });
const anonymousCaller = authRouter.createCaller({ user: null });

beforeEach(() => {
	vi.mocked(renameUser).mockReset();
	vi.mocked(changeOwnPassword).mockReset();
});

describe('authRouter.me', () => {
	it('returns the session user', async () => {
		expect(await caller.me()).toEqual(USER);
	});

	it('rejects an unauthenticated caller', async () => {
		await expect(anonymousCaller.me()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
	});
});

describe('authRouter.updateDisplayName', () => {
	it('renames the session user and returns the updated read model', async () => {
		const updated = { ...USER, displayName: 'Ada Lovelace' };
		vi.mocked(renameUser).mockResolvedValue(updated);

		expect(await caller.updateDisplayName({ displayName: '  Ada Lovelace  ' })).toEqual(updated);
		expect(renameUser).toHaveBeenCalledWith(USER.id, 'Ada Lovelace');
	});

	it('addresses the session user even when the input names another one', async () => {
		vi.mocked(renameUser).mockResolvedValue({ ...USER, displayName: 'Ada Lovelace' });

		await caller.updateDisplayName({
			displayName: 'Ada Lovelace',
			userId: OTHER_USER_ID,
			identifier: 'someone@example.com',
		} as { displayName: string });

		expect(renameUser).toHaveBeenCalledWith(USER.id, 'Ada Lovelace');
	});

	it('rejects an empty or whitespace-only name before touching the service', async () => {
		await expect(caller.updateDisplayName({ displayName: '' })).rejects.toThrow();
		await expect(caller.updateDisplayName({ displayName: '   ' })).rejects.toThrow();
		expect(renameUser).not.toHaveBeenCalled();
	});

	it('rejects an over-long name before touching the service', async () => {
		await expect(caller.updateDisplayName({ displayName: 'a'.repeat(81) })).rejects.toThrow();
		expect(renameUser).not.toHaveBeenCalled();
	});

	it('reports a vanished account as NOT_FOUND', async () => {
		vi.mocked(renameUser).mockResolvedValue(undefined);

		await expect(caller.updateDisplayName({ displayName: 'Ada Lovelace' })).rejects.toMatchObject({
			code: 'NOT_FOUND',
		});
	});

	it('rejects an unauthenticated caller', async () => {
		await expect(
			anonymousCaller.updateDisplayName({ displayName: 'Ada Lovelace' }),
		).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
		expect(renameUser).not.toHaveBeenCalled();
	});
});

describe('authRouter.changePassword', () => {
	const INPUT = { currentPassword: 'old-secret', newPassword: 'new-secret' };

	it('changes the session user’s password and returns no password material', async () => {
		vi.mocked(changeOwnPassword).mockResolvedValue('changed');

		const result = await caller.changePassword(INPUT);

		expect(result).toEqual({ ok: true });
		// Nothing about the submitted values may travel back to the caller.
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain('old-secret');
		expect(serialized).not.toContain('new-secret');
		expect(changeOwnPassword).toHaveBeenCalledWith({ userId: USER.id, ...INPUT });
	});

	it('addresses the session user even when the input names another one', async () => {
		vi.mocked(changeOwnPassword).mockResolvedValue('changed');

		await caller.changePassword({ ...INPUT, userId: OTHER_USER_ID } as typeof INPUT);

		expect(changeOwnPassword).toHaveBeenCalledWith({ userId: USER.id, ...INPUT });
	});

	it('maps a wrong current password to FORBIDDEN', async () => {
		vi.mocked(changeOwnPassword).mockResolvedValue('invalid-current-password');

		await expect(caller.changePassword(INPUT)).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});

	it('maps an account with no password to PRECONDITION_FAILED', async () => {
		vi.mocked(changeOwnPassword).mockResolvedValue('no-password-set');

		await expect(caller.changePassword(INPUT)).rejects.toMatchObject({
			code: 'PRECONDITION_FAILED',
		});
	});

	it('maps a vanished account to NOT_FOUND', async () => {
		vi.mocked(changeOwnPassword).mockResolvedValue('unknown-user');

		await expect(caller.changePassword(INPUT)).rejects.toMatchObject({ code: 'NOT_FOUND' });
	});

	it('rejects an empty password on either side before touching the service', async () => {
		await expect(
			caller.changePassword({ currentPassword: '', newPassword: 'new-secret' }),
		).rejects.toThrow();
		await expect(
			caller.changePassword({ currentPassword: 'old-secret', newPassword: '' }),
		).rejects.toThrow();
		expect(changeOwnPassword).not.toHaveBeenCalled();
	});

	it('rejects a "change" that changes nothing before touching the service', async () => {
		await expect(
			caller.changePassword({ currentPassword: 'same-secret', newPassword: 'same-secret' }),
		).rejects.toThrow();
		expect(changeOwnPassword).not.toHaveBeenCalled();
	});

	it('rejects an unauthenticated caller', async () => {
		await expect(anonymousCaller.changePassword(INPUT)).rejects.toMatchObject({
			code: 'UNAUTHORIZED',
		});
		expect(changeOwnPassword).not.toHaveBeenCalled();
	});
});
