// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	listFn,
	createMutate,
	issueMutate,
	grantMutate,
	revokeMutate,
	listIdentitiesFn,
	linkMutate,
	unlinkMutate,
} = vi.hoisted(() => ({
	listFn: vi.fn(),
	listIdentitiesFn: vi.fn(),
	linkMutate: vi.fn(),
	unlinkMutate: vi.fn(),
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
			identities: {
				link: { mutate: linkMutate },
				unlink: { mutate: unlinkMutate },
			},
		},
	},
	trpc: {
		users: {
			list: {
				queryOptions: () => ({ queryKey: ['users.list'], queryFn: () => listFn() }),
			},
			identities: {
				list: {
					queryOptions: () => ({
						queryKey: ['users.identities.list'],
						queryFn: () => listIdentitiesFn(),
					}),
				},
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
		listIdentitiesFn.mockReset().mockResolvedValue([]);
		linkMutate.mockReset();
		unlinkMutate.mockReset();
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

	describe('linked identities (issue #1167)', () => {
		const ADA_JIRA = {
			id: '00000000-0000-4000-8000-0000000000a1',
			userId: ADA.id,
			provider: 'jira',
			handle: '557058:ada',
			createdAt: '2026-10-01T00:00:00.000Z',
		};
		const ADA_GITHUB = { ...ADA_JIRA, id: 'a2', provider: 'github-projects', handle: 'ada' };
		const ADA_LEGACY = { ...ADA_JIRA, id: 'a3', provider: 'legacy-pm', handle: 'old-ada' };

		it("shows each user's links with the provider's own label", async () => {
			listIdentitiesFn.mockResolvedValue([ADA_GITHUB, ADA_JIRA, ADA_LEGACY]);
			renderPanel();

			expect(await screen.findByText('557058:ada')).not.toBeNull();
			expect(screen.getByText('Jira')).not.toBeNull();
			expect(screen.getByText('GitHub Projects')).not.toBeNull();
			// An unknown stored key is shown as itself, not dressed up as GitHub.
			expect(screen.getByText('legacy-pm')).not.toBeNull();
			expect(screen.getAllByText('GitHub Projects')).toHaveLength(1);
			// Grace has none.
			expect(screen.getByText('None')).not.toBeNull();
		});

		it('links a trimmed handle on the chosen provider, then refreshes', async () => {
			linkMutate.mockResolvedValue({ ...ADA_JIRA, userId: GRACE.id });
			renderPanel();

			const buttons = await screen.findAllByRole('button', { name: 'Link identity' });
			fireEvent.click(buttons[1]);
			expect(screen.getByText('grace@example.com', { selector: 'span' })).not.toBeNull();

			fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'jira' } });
			expect(screen.getByText(/Not their e-mail or display name/)).not.toBeNull();
			const handleInput = screen.getByLabelText(/Atlassian accountId/);
			fireEvent.change(handleInput, { target: { value: '  557058:abc  ' } });
			fireEvent.click(screen.getByRole('button', { name: 'Link' }));

			await waitFor(() =>
				expect(linkMutate).toHaveBeenCalledWith({
					userId: GRACE.id,
					provider: 'jira',
					handle: '557058:abc',
				}),
			);
			await waitFor(() => expect(listIdentitiesFn).toHaveBeenCalledTimes(2));
			expect(screen.queryByLabelText('Provider')).toBeNull();
		});

		it('shows a handle owned by someone else verbatim, and keeps the modal open', async () => {
			const message =
				'Handle "ada" on github-projects is already linked to Ada Lovelace (ada@example.com). Unlink it from that user first.';
			linkMutate.mockRejectedValue(new Error(message));
			renderPanel();

			fireEvent.click((await screen.findAllByRole('button', { name: 'Link identity' }))[1]);
			fireEvent.change(screen.getByLabelText(/GitHub login/), { target: { value: 'ada' } });
			fireEvent.click(screen.getByRole('button', { name: 'Link' }));

			expect(await screen.findByText(message)).not.toBeNull();
			expect(screen.getByLabelText('Provider')).not.toBeNull();
		});

		it('confirms before unlinking, then refreshes', async () => {
			listIdentitiesFn.mockResolvedValue([ADA_JIRA]);
			unlinkMutate.mockResolvedValue(undefined);
			renderPanel();

			const unlink = await screen.findByRole('button', {
				name: 'Unlink 557058:ada on Jira from ada@example.com',
			});

			// Cancel unlinks nothing.
			fireEvent.click(unlink);
			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
			expect(unlinkMutate).not.toHaveBeenCalled();

			fireEvent.click(unlink);
			expect(screen.getByText(/stop routing to their workers/)).not.toBeNull();
			fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));

			await waitFor(() =>
				expect(unlinkMutate).toHaveBeenCalledWith({ provider: 'jira', handle: '557058:ada' }),
			);
			await waitFor(() => expect(listIdentitiesFn).toHaveBeenCalledTimes(2));
		});

		it('still lists users when the links fail to load', async () => {
			listIdentitiesFn.mockRejectedValue(new Error('boom'));
			renderPanel();

			expect(await screen.findByText('Failed to load linked identities: boom')).not.toBeNull();
			expect(screen.getByText('ada@example.com')).not.toBeNull();
			expect(screen.queryByText('None')).toBeNull();
		});
	});
});
