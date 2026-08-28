// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listFn, addMutate, setRoleMutate, removeMutate } = vi.hoisted(() => ({
	listFn: vi.fn(),
	addMutate: vi.fn(),
	setRoleMutate: vi.fn(),
	removeMutate: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		members: {
			add: { mutate: addMutate },
			setRole: { mutate: setRoleMutate },
			remove: { mutate: removeMutate },
		},
	},
	trpc: {
		members: {
			list: {
				queryOptions: (args: { projectId: string }) => ({
					queryKey: ['members.list', args],
					queryFn: () => listFn(args),
				}),
			},
		},
	},
}));

import { MembersPanel } from './members-panel.js';

const ADA = { userId: 'u-1', identifier: 'ada', displayName: 'Ada Lovelace', role: 'projectAdmin' };
const GRACE = { userId: 'u-2', identifier: 'grace', displayName: 'Grace Hopper', role: 'member' };

function renderPanel(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('MembersPanel (issue #806 — the project Members tab)', () => {
	beforeEach(() => {
		listFn.mockReset();
		addMutate.mockReset();
		setRoleMutate.mockReset();
		removeMutate.mockReset();
	});

	it('renders each member with their identifier and current role', async () => {
		listFn.mockResolvedValue([ADA, GRACE]);

		renderPanel(<MembersPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText('Ada Lovelace')).not.toBeNull());
		expect(screen.getByText('ada')).not.toBeNull();
		expect(screen.getByText('Grace Hopper')).not.toBeNull();
		expect(listFn).toHaveBeenCalledWith({ projectId: 'proj-a' });

		// Each row's select shows that row's own role, worded by the shared role copy.
		const adaRole = screen.getByLabelText('Role for ada') as HTMLSelectElement;
		const graceRole = screen.getByLabelText('Role for grace') as HTMLSelectElement;
		expect(adaRole.value).toBe('projectAdmin');
		expect(graceRole.value).toBe('member');
		expect([...adaRole.options].map((option) => option.textContent)).toEqual([
			'Project administrator',
			'Member',
			'Contributor',
		]);
	});

	it('adds a member by the typed identifier in the chosen role, and clears the field', async () => {
		listFn.mockResolvedValue([ADA]);
		addMutate.mockResolvedValue({ userId: 'u-3' });

		renderPanel(<MembersPanel projectId="proj-a" />);

		const input = (await waitFor(() =>
			screen.getByLabelText('Login identifier'),
		)) as HTMLInputElement;
		// Surrounding whitespace is trimmed — an identifier is pasted as often as typed.
		fireEvent.change(input, { target: { value: '  grace  ' } });
		fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'contributor' } });
		fireEvent.click(screen.getByText('Add member'));

		await waitFor(() =>
			expect(addMutate).toHaveBeenCalledWith({
				projectId: 'proj-a',
				identifier: 'grace',
				role: 'contributor',
			}),
		);
		await waitFor(() => expect(input.value).toBe(''));
	});

	it('shows a rejected add verbatim and keeps the typed identifier', async () => {
		listFn.mockResolvedValue([ADA]);
		addMutate.mockRejectedValue(
			new Error('"ada" is already a member of this project — use setRole to change their role.'),
		);

		renderPanel(<MembersPanel projectId="proj-a" />);

		const input = (await waitFor(() =>
			screen.getByLabelText('Login identifier'),
		)) as HTMLInputElement;
		fireEvent.change(input, { target: { value: 'ada' } });
		fireEvent.click(screen.getByText('Add member'));

		// The server's own words: it already names the fix, so the panel must not
		// paraphrase it.
		await waitFor(() =>
			expect(
				screen.getByText(
					'"ada" is already a member of this project — use setRole to change their role.',
				),
			).not.toBeNull(),
		);
		// A typo is corrected rather than retyped.
		expect(input.value).toBe('ada');
	});

	it("changes a row's role, keyed on that row's userId", async () => {
		listFn.mockResolvedValue([ADA, GRACE]);
		setRoleMutate.mockResolvedValue({ userId: 'u-2', role: 'projectAdmin' });

		renderPanel(<MembersPanel projectId="proj-a" />);

		fireEvent.change(await waitFor(() => screen.getByLabelText('Role for grace')), {
			target: { value: 'projectAdmin' },
		});

		await waitFor(() =>
			expect(setRoleMutate).toHaveBeenCalledWith({
				projectId: 'proj-a',
				userId: 'u-2',
				role: 'projectAdmin',
			}),
		);
	});

	it('keeps each role row disabled until its own write settles', async () => {
		listFn.mockResolvedValue([ADA, GRACE]);
		let resolveAda: () => void = () => {};
		let resolveGrace: () => void = () => {};
		setRoleMutate.mockImplementation(
			({ userId }: { userId: string }) =>
				new Promise<void>((resolve) => {
					if (userId === ADA.userId) {
						resolveAda = resolve;
					} else {
						resolveGrace = resolve;
					}
				}),
		);

		renderPanel(<MembersPanel projectId="proj-a" />);

		const adaRole = (await waitFor(() =>
			screen.getByLabelText('Role for ada'),
		)) as HTMLSelectElement;
		const graceRole = screen.getByLabelText('Role for grace') as HTMLSelectElement;
		fireEvent.change(adaRole, { target: { value: 'member' } });
		await waitFor(() => expect(setRoleMutate).toHaveBeenCalledTimes(1));
		expect(adaRole.disabled).toBe(true);

		fireEvent.change(graceRole, { target: { value: 'contributor' } });
		await waitFor(() => expect(setRoleMutate).toHaveBeenCalledTimes(2));
		// A second row's mutation must not replace Ada's pending state.
		expect(adaRole.disabled).toBe(true);

		// This is the request that previously could overtake Ada's first write. The
		// ref guard also protects the handler if an event is dispatched programmatically.
		fireEvent.change(adaRole, { target: { value: 'contributor' } });
		expect(setRoleMutate).toHaveBeenCalledTimes(2);

		resolveGrace();
		await waitFor(() => expect(graceRole.disabled).toBe(false));
		expect(adaRole.disabled).toBe(true);

		resolveAda();
		await waitFor(() => expect(adaRole.disabled).toBe(false));
	});

	it('attaches a failed role change to the row that caused it', async () => {
		listFn.mockResolvedValue([ADA, GRACE]);
		setRoleMutate.mockRejectedValue(new Error('User "u-2" is not a member of this project'));

		renderPanel(<MembersPanel projectId="proj-a" />);

		fireEvent.change(await waitFor(() => screen.getByLabelText('Role for grace')), {
			target: { value: 'contributor' },
		});

		const message = await waitFor(() =>
			screen.getByText('User "u-2" is not a member of this project'),
		);
		// In Grace's row, not above the table: `<td>` → `<tr>` is the row it belongs to.
		expect(message.closest('tr')?.textContent).toContain('grace');
		// The failed write left the roster alone, so the select snaps back to the server's value.
		expect((screen.getByLabelText('Role for grace') as HTMLSelectElement).value).toBe('member');
	});

	it('removes a member only after the confirmation step', async () => {
		listFn.mockResolvedValue([ADA, GRACE]);
		removeMutate.mockResolvedValue({ userId: 'u-2' });

		renderPanel(<MembersPanel projectId="proj-a" />);

		fireEvent.click(await waitFor(() => screen.getByLabelText('Remove grace')));
		// Opening the dialog fires nothing — removal is not recoverable from this screen.
		expect(removeMutate).not.toHaveBeenCalled();
		// The dialog names the member it is about, so the confirmation is not blind.
		expect(screen.getByText('Remove member')).not.toBeNull();
		expect(screen.getAllByText('Grace Hopper').length).toBe(2);

		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

		await waitFor(() =>
			expect(removeMutate).toHaveBeenCalledWith({ projectId: 'proj-a', userId: 'u-2' }),
		);
	});

	it('cancels a removal without calling the server', async () => {
		listFn.mockResolvedValue([ADA, GRACE]);

		renderPanel(<MembersPanel projectId="proj-a" />);

		fireEvent.click(await waitFor(() => screen.getByLabelText('Remove grace')));
		fireEvent.click(screen.getByText('Cancel'));

		expect(removeMutate).not.toHaveBeenCalled();
		expect(screen.queryByText('Remove member')).toBeNull();
	});

	it('reports a failed removal in the dialog rather than closing it', async () => {
		listFn.mockResolvedValue([ADA, GRACE]);
		removeMutate.mockRejectedValue(new Error('User "u-2" is not a member of this project'));

		renderPanel(<MembersPanel projectId="proj-a" />);

		fireEvent.click(await waitFor(() => screen.getByLabelText('Remove grace')));
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

		await waitFor(() =>
			expect(screen.getByText('User "u-2" is not a member of this project')).not.toBeNull(),
		);
		expect(screen.getByText('Remove member')).not.toBeNull();
	});

	it('renders a loading state, then an empty one that points at the add form', async () => {
		let resolveList: (rows: unknown[]) => void = () => {};
		listFn.mockReturnValue(
			new Promise((resolve) => {
				resolveList = resolve;
			}),
		);

		renderPanel(<MembersPanel projectId="proj-a" />);

		expect(screen.getByText('Loading members…')).not.toBeNull();

		resolveList([]);

		await waitFor(() =>
			expect(screen.getByText('This project has no members yet.')).not.toBeNull(),
		);
		// The add form is available whatever the roster's state.
		expect(screen.getByLabelText('Login identifier')).not.toBeNull();
	});

	it('surfaces a failed load without claiming the project has no members', async () => {
		listFn.mockRejectedValue(new Error('boom'));

		renderPanel(<MembersPanel projectId="proj-a" />);

		await waitFor(() => expect(screen.getByText(/Failed to load members: boom/)).not.toBeNull());
		expect(screen.queryByText('This project has no members yet.')).toBeNull();
	});
});
