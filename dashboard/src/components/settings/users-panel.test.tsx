// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listFn, createMutate, issueMutate, grantMutate, revokeMutate } = vi.hoisted(() => ({
	listFn: vi.fn(),
	createMutate: vi.fn(),
	issueMutate: vi.fn(),
	grantMutate: vi.fn(),
	revokeMutate: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		users: {
			create: { mutate: createMutate },
			issuePasswordLink: { mutate: issueMutate },
			grantAdmin: { mutate: grantMutate },
			revokeAdmin: { mutate: revokeMutate },
		},
	},
	trpc: {
		users: {
			list: {
				queryOptions: () => ({ queryKey: ['users.list'], queryFn: () => listFn() }),
			},
		},
	},
}));

import { UsersPanel } from './users-panel.js';

const ADA = {
	id: '00000000-0000-4000-8000-000000000001',
	identifier: 'ada@example.com',
	displayName: 'Ada Lovelace',
	instanceAdmin: true,
};
const GRACE = {
	id: '00000000-0000-4000-8000-000000000002',
	identifier: 'grace@example.com',
	displayName: 'Grace Hopper',
	instanceAdmin: false,
};
const EXPIRES_AT = '2026-10-31T09:00:00.000Z';
const LINK_PREFIX = `${window.location.origin}/set-password?token=`;

function renderPanel() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<UsersPanel />
		</QueryClientProvider>,
	);
}

function linkInput() {
	return screen.getByLabelText('Password link') as HTMLInputElement;
}

describe('UsersPanel (issue #1151 — dashboard user management)', () => {
	beforeEach(() => {
		listFn.mockReset().mockResolvedValue([ADA, GRACE]);
		createMutate.mockReset();
		issueMutate.mockReset();
		grantMutate.mockReset();
		revokeMutate.mockReset();
	});

	it('lists users with their identifier, display name and admin switch', async () => {
		renderPanel();

		await waitFor(() => expect(screen.getByText('ada@example.com')).not.toBeNull());
		expect(screen.getByText('Grace Hopper')).not.toBeNull();
		const adaSwitch = screen.getByRole('switch', {
			name: 'Installation admin for ada@example.com',
		});
		expect(adaSwitch.getAttribute('aria-checked')).toBe('true');
		expect(
			screen
				.getByRole('switch', { name: 'Installation admin for grace@example.com' })
				.getAttribute('aria-checked'),
		).toBe('false');
	});

	it('creates a user with trimmed values and shows the full link once', async () => {
		createMutate.mockResolvedValue({
			user: { ...GRACE, identifier: 'new@example.com' },
			token: 'tok+en/1',
			expiresAt: EXPIRES_AT,
		});
		renderPanel();

		fireEvent.click(await screen.findByRole('button', { name: /add user/i }));
		fireEvent.change(screen.getByLabelText(/^identifier/i), {
			target: { value: '  new@example.com  ' },
		});
		fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: '  New  ' } });
		fireEvent.click(screen.getByRole('switch', { name: 'Installation admin' }));
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		await waitFor(() =>
			expect(createMutate).toHaveBeenCalledWith({
				identifier: 'new@example.com',
				displayName: 'New',
				instanceAdmin: true,
			}),
		);
		await waitFor(() => expect(linkInput().value).toBe(`${LINK_PREFIX}tok%2Ben%2F1`));
		expect(screen.getByText(/Single use · expires/)).not.toBeNull();
		expect(screen.getByText(/only time the link is shown/)).not.toBeNull();
		// The list is refreshed so the new user appears behind the modal.
		await waitFor(() => expect(listFn).toHaveBeenCalledTimes(2));
	});

	it('omits an empty display name so the server defaults it', async () => {
		createMutate.mockResolvedValue({ user: GRACE, token: 't', expiresAt: EXPIRES_AT });
		renderPanel();

		fireEvent.click(await screen.findByRole('button', { name: /add user/i }));
		fireEvent.change(screen.getByLabelText(/^identifier/i), {
			target: { value: 'grace@example.com' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		await waitFor(() =>
			expect(createMutate).toHaveBeenCalledWith({
				identifier: 'grace@example.com',
				displayName: undefined,
				instanceAdmin: false,
			}),
		);
	});

	it('shows a CONFLICT verbatim inside the modal, which stays open', async () => {
		const message =
			'A user with identifier "ada@example.com" already exists — issue them a password link instead.';
		createMutate.mockRejectedValue(new Error(message));
		renderPanel();

		fireEvent.click(await screen.findByRole('button', { name: /add user/i }));
		fireEvent.change(screen.getByLabelText(/^identifier/i), {
			target: { value: 'ada@example.com' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));

		expect(await screen.findByText(message)).not.toBeNull();
		expect(screen.getByLabelText(/^identifier/i)).not.toBeNull();
		expect(screen.queryByLabelText('Password link')).toBeNull();
	});

	it('confirms before issuing a password link for the row, then shows it', async () => {
		issueMutate.mockResolvedValue({ user: GRACE, token: 'reset-token', expiresAt: EXPIRES_AT });
		renderPanel();

		const rows = await screen.findAllByRole('button', { name: 'Password link' });
		fireEvent.click(rows[1]);

		// Nothing is issued until the modal is confirmed, and it says what issuing does.
		expect(issueMutate).not.toHaveBeenCalled();
		expect(screen.getByText(/replaces any earlier link/)).not.toBeNull();
		expect(screen.getByText(/current password keeps working/)).not.toBeNull();
		expect(screen.getByText(/signs them out of every session/)).not.toBeNull();

		fireEvent.click(screen.getByRole('button', { name: 'Issue link' }));

		await waitFor(() => expect(issueMutate).toHaveBeenCalledWith({ userId: GRACE.id }));
		await waitFor(() => expect(linkInput().value).toBe(`${LINK_PREFIX}reset-token`));
	});

	it('drops the link when the modal is closed', async () => {
		issueMutate.mockResolvedValue({ user: GRACE, token: 'reset-token', expiresAt: EXPIRES_AT });
		renderPanel();

		fireEvent.click((await screen.findAllByRole('button', { name: 'Password link' }))[1]);
		fireEvent.click(screen.getByRole('button', { name: 'Issue link' }));
		await waitFor(() => expect(linkInput()).not.toBeNull());

		fireEvent.click(screen.getByRole('button', { name: 'Done' }));
		expect(screen.queryByLabelText('Password link')).toBeNull();

		// Reopening asks again rather than showing the earlier link.
		fireEvent.click(screen.getAllByRole('button', { name: 'Password link' })[1]);
		expect(screen.queryByLabelText('Password link')).toBeNull();
		expect(screen.getByRole('button', { name: 'Issue link' })).not.toBeNull();
	});

	it('grants and revokes installation admin from the row switch', async () => {
		grantMutate.mockResolvedValue({ ...GRACE, instanceAdmin: true });
		revokeMutate.mockResolvedValue({ ...ADA, instanceAdmin: false });
		renderPanel();

		fireEvent.click(
			await screen.findByRole('switch', { name: 'Installation admin for grace@example.com' }),
		);
		await waitFor(() => expect(grantMutate).toHaveBeenCalledWith({ userId: GRACE.id }));

		fireEvent.click(screen.getByRole('switch', { name: 'Installation admin for ada@example.com' }));
		await waitFor(() => expect(revokeMutate).toHaveBeenCalledWith({ userId: ADA.id }));
	});

	it('shows the last-admin refusal verbatim and leaves the switch on', async () => {
		const message =
			'This is the last installation administrator. Grant admin to another user before revoking it here.';
		revokeMutate.mockRejectedValue(new Error(message));
		renderPanel();

		const adaSwitch = await screen.findByRole('switch', {
			name: 'Installation admin for ada@example.com',
		});
		fireEvent.click(adaSwitch);

		expect(await screen.findByText(message)).not.toBeNull();
		expect(
			screen
				.getByRole('switch', { name: 'Installation admin for ada@example.com' })
				.getAttribute('aria-checked'),
		).toBe('true');
	});
});
