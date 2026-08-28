// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listFn, setMutate } = vi.hoisted(() => ({
	listFn: vi.fn(),
	setMutate: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		workers: { scmCredentials: { set: { mutate: setMutate } } },
	},
	trpc: {
		workers: {
			scmCredentials: {
				list: {
					queryOptions: ({ workerId }: { workerId: string }) => ({
						queryKey: ['workers.scmCredentials.list', workerId],
						queryFn: () => listFn(workerId),
					}),
				},
			},
		},
	},
}));

import { WorkerOperatorCredentialsCard } from './worker-operator-credentials-card.js';

const WORKER_ID = 'worker-1';

const GITHUB_SLOT = {
	providerId: 'github',
	providerLabel: 'GitHub',
	isConfigured: false,
	updatedAt: null,
};

function renderCard() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<WorkerOperatorCredentialsCard workerId={WORKER_ID} />
		</QueryClientProvider>,
	);
}

describe('WorkerOperatorCredentialsCard (issue #766)', () => {
	beforeEach(() => {
		listFn.mockReset();
		setMutate.mockReset();
	});

	it('renders one field per provider, under that provider’s own operator copy', async () => {
		listFn.mockResolvedValue({
			providers: [
				GITHUB_SLOT,
				{
					providerId: 'bitbucket',
					providerLabel: 'Bitbucket',
					isConfigured: false,
					updatedAt: null,
				},
			],
		});

		renderCard();

		await waitFor(() => expect(screen.getByText('GitHub — Operator PAT')).not.toBeNull());
		expect(screen.getByText('Bitbucket — Operator App Password')).not.toBeNull();
		// Bitbucket's own credential form, not GitHub's word for it. Twice over: once in
		// the operator description, once in the provider's static hint under the input.
		expect(screen.getAllByText(/username:app_password/).length).toBeGreaterThan(0);
	});

	it('opens an unconfigured slot straight into the input', async () => {
		listFn.mockResolvedValue({ providers: [GITHUB_SLOT] });

		renderCard();

		const input = (await screen.findByLabelText('GitHub Operator PAT value')) as HTMLInputElement;
		expect(input.type).toBe('password');
		expect(input.placeholder).toBe('Paste the secret');
	});

	it('collapses a configured slot to the masked marker, a last-updated line and Replace', async () => {
		listFn.mockResolvedValue({
			providers: [
				{
					...GITHUB_SLOT,
					isConfigured: true,
					updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
				},
			],
		});

		renderCard();

		await waitFor(() => expect(screen.getByText('••••')).not.toBeNull());
		expect(screen.getByText(/^Set 1h ago$/)).not.toBeNull();
		expect(screen.getByRole('button', { name: 'Replace' })).not.toBeNull();
		expect(screen.queryByLabelText('GitHub Operator PAT value')).toBeNull();
	});

	// The secret-hygiene assertion: there is no reveal affordance, and the marker the
	// DOM carries is this component's own — the response holds no value to render.
	it('offers no reveal affordance and renders no server-sent value', async () => {
		listFn.mockResolvedValue({
			providers: [{ ...GITHUB_SLOT, isConfigured: true, updatedAt: new Date().toISOString() }],
		});

		const { container } = renderCard();

		await waitFor(() => expect(screen.getByText('••••')).not.toBeNull());
		expect(screen.queryByRole('button', { name: /reveal|show/i })).toBeNull();
		expect(container.textContent).not.toMatch(/ghp_/);
	});

	it('sends the trimmed value for the slot’s own provider', async () => {
		listFn.mockResolvedValue({ providers: [GITHUB_SLOT] });
		setMutate.mockResolvedValue({ login: 'ada-ops' });

		renderCard();

		fireEvent.change(await screen.findByLabelText('GitHub Operator PAT value'), {
			target: { value: '  ghp_real\n' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		await waitFor(() =>
			expect(setMutate).toHaveBeenCalledWith({
				workerId: WORKER_ID,
				providerId: 'github',
				value: 'ghp_real',
			}),
		);
	});

	it('confirms the verified account and collapses the field on success', async () => {
		listFn.mockResolvedValue({ providers: [GITHUB_SLOT] });
		setMutate.mockResolvedValue({ login: 'ada-ops' });

		renderCard();

		fireEvent.change(await screen.findByLabelText('GitHub Operator PAT value'), {
			target: { value: 'ghp_real' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(await screen.findByText('✓ Saved — verified as @ada-ops')).not.toBeNull();
		expect(screen.queryByLabelText('GitHub Operator PAT value')).toBeNull();
	});

	// The rejection has to be legible and non-destructive: the server's own message,
	// and the pasted value still there to correct.
	it('renders a rejected save verbatim and leaves the input populated', async () => {
		listFn.mockResolvedValue({ providers: [GITHUB_SLOT] });
		setMutate.mockRejectedValue(
			new Error('That credential did not resolve to a GitHub account, so nothing was stored.'),
		);

		renderCard();

		const input = (await screen.findByLabelText('GitHub Operator PAT value')) as HTMLInputElement;
		fireEvent.change(input, { target: { value: 'ghp_wrong' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save' }));

		expect(
			await screen.findByText(
				/Failed to save: That credential did not resolve to a GitHub account/,
			),
		).not.toBeNull();
		expect(input.value).toBe('ghp_wrong');
	});

	it('explains the empty state when the machine is enrolled nowhere', async () => {
		listFn.mockResolvedValue({ providers: [] });

		renderCard();

		await waitFor(() => expect(screen.getByText(/not enrolled in any project yet/)).not.toBeNull());
	});

	// The two facts an operator needs from this surface.
	it('states the identity it sets and that it applies on the next dispatch', async () => {
		listFn.mockResolvedValue({ providers: [GITHUB_SLOT] });

		renderCard();

		await waitFor(() =>
			expect(
				screen.getByText(/every commit, push, pull request and implementer-side comment/),
			).not.toBeNull(),
		);
		expect(screen.getByText(/next dispatch/)).not.toBeNull();
	});
});
