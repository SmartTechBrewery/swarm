// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listFn, setMutate, deleteMutate } = vi.hoisted(() => ({
	listFn: vi.fn(),
	setMutate: vi.fn(),
	deleteMutate: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		settings: {
			credentials: {
				set: { mutate: setMutate },
				delete: { mutate: deleteMutate },
			},
		},
	},
	trpc: {
		settings: {
			credentials: {
				list: {
					queryOptions: () => ({
						queryKey: ['settings.credentials.list'],
						queryFn: () => listFn(),
					}),
				},
			},
		},
	},
}));

import { InstanceCredentialsPanel } from './instance-credentials-panel.js';

const GITHUB_REVIEWER = {
	providerId: 'github',
	providerLabel: 'GitHub',
	role: 'reviewer',
	envVarKey: 'GITHUB_TOKEN_REVIEWER',
	isConfigured: false,
};

function renderPanel(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe('InstanceCredentialsPanel (issue #769 — instance default credentials)', () => {
	beforeEach(() => {
		listFn.mockReset();
		setMutate.mockReset();
		deleteMutate.mockReset();
	});

	it("renders one field per eligible role, under the provider's own role copy", async () => {
		listFn.mockResolvedValue({ roles: [GITHUB_REVIEWER] });

		renderPanel(<InstanceCredentialsPanel />);

		await waitFor(() => expect(screen.getByText('GitHub — Reviewer PAT')).not.toBeNull());
		expect(screen.getByText('GITHUB_TOKEN_REVIEWER')).not.toBeNull();
		expect(
			screen.getByText(/personal access token the reviewer persona reviews with/),
		).not.toBeNull();
	});

	// Phase 2/2 copy states both halves: a default *is* consumed now (new projects are
	// seeded from it), and it is still only a copy made at creation, so an existing
	// project is untouched.
	it('says new projects are seeded while existing ones are unaffected', async () => {
		listFn.mockResolvedValue({ roles: [GITHUB_REVIEWER] });

		renderPanel(<InstanceCredentialsPanel />);

		await waitFor(() => expect(screen.getByText(/new projects are seeded/i)).not.toBeNull());
		expect(screen.getByText(/Existing projects are unaffected/)).not.toBeNull();
	});

	it('opens an unconfigured role straight into a password input', async () => {
		listFn.mockResolvedValue({ roles: [GITHUB_REVIEWER] });

		renderPanel(<InstanceCredentialsPanel />);

		const input = (await waitFor(() =>
			screen.getByLabelText('Reviewer PAT value'),
		)) as HTMLInputElement;
		expect(input.type).toBe('password');
	});

	it('collapses a configured role to a masked marker with no value in the DOM', async () => {
		listFn.mockResolvedValue({ roles: [{ ...GITHUB_REVIEWER, isConfigured: true }] });

		renderPanel(<InstanceCredentialsPanel />);

		await waitFor(() => expect(screen.getByText('••••')).not.toBeNull());
		expect(screen.queryByLabelText('Reviewer PAT value')).toBeNull();
		expect(screen.getByText('Edit')).not.toBeNull();
		expect(screen.getByLabelText('Remove Reviewer PAT')).not.toBeNull();
	});

	it('saves the trimmed value keyed by (provider, role) and refreshes the list', async () => {
		listFn.mockResolvedValue({ roles: [GITHUB_REVIEWER] });
		setMutate.mockResolvedValue(undefined);

		renderPanel(<InstanceCredentialsPanel />);

		fireEvent.change(await waitFor(() => screen.getByLabelText('Reviewer PAT value')), {
			target: { value: '  ghp_instance_default  ' },
		});
		fireEvent.click(screen.getByText('Save'));

		await waitFor(() =>
			expect(setMutate).toHaveBeenCalledWith({
				providerId: 'github',
				role: 'reviewer',
				value: 'ghp_instance_default',
			}),
		);
		// The list is refetched, which is what turns the field into its masked preview.
		await waitFor(() => expect(listFn).toHaveBeenCalledTimes(2));
	});

	it('clears a configured role through the confirmation modal', async () => {
		listFn
			.mockResolvedValueOnce({ roles: [{ ...GITHUB_REVIEWER, isConfigured: true }] })
			.mockResolvedValue({ roles: [GITHUB_REVIEWER] });
		deleteMutate.mockResolvedValue(undefined);

		renderPanel(<InstanceCredentialsPanel />);

		fireEvent.click(await waitFor(() => screen.getByLabelText('Remove Reviewer PAT')));
		// Nothing is cleared until the modal is confirmed.
		expect(deleteMutate).not.toHaveBeenCalled();

		fireEvent.click(await waitFor(() => screen.getByText('Remove')));

		await waitFor(() =>
			expect(deleteMutate).toHaveBeenCalledWith({ providerId: 'github', role: 'reviewer' }),
		);
		await waitFor(() => expect(screen.getByLabelText('Reviewer PAT value')).not.toBeNull());
		expect(screen.queryByText('••••')).toBeNull();
	});

	it('names a provider the dashboard cannot narrow instead of borrowing GitHub copy', async () => {
		listFn.mockResolvedValue({
			roles: [
				{
					providerId: 'gerrit',
					providerLabel: 'Gerrit',
					role: 'reviewer',
					envVarKey: 'GERRIT_TOKEN_REVIEWER',
					isConfigured: false,
				},
			],
		});

		renderPanel(<InstanceCredentialsPanel />);

		await waitFor(() => expect(screen.getByText(/not available in this dashboard/)).not.toBeNull());
		expect(screen.queryByText('Reviewer PAT')).toBeNull();
	});

	it('says so when no provider declares an eligible role', async () => {
		listFn.mockResolvedValue({ roles: [] });

		renderPanel(<InstanceCredentialsPanel />);

		await waitFor(() =>
			expect(
				screen.getByText(/declares a role eligible for an instance-level default/),
			).not.toBeNull(),
		);
	});

	it('surfaces a failed load without claiming there are no credentials', async () => {
		listFn.mockRejectedValue(new Error('boom'));

		renderPanel(<InstanceCredentialsPanel />);

		await waitFor(() =>
			expect(screen.getByText(/Failed to load instance credentials/)).not.toBeNull(),
		);
	});
});
