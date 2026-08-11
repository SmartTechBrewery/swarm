// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PmProviderPanel } from './pm-provider-panel.js';

const { listProvidersFn } = vi.hoisted(() => ({ listProvidersFn: vi.fn() }));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		pm: {
			listProviders: {
				queryOptions: (args: unknown) => ({
					queryKey: ['pm.listProviders', args],
					queryFn: () => listProvidersFn(args),
				}),
			},
		},
	},
}));

const PROVIDERS = [
	{ id: 'github-projects', label: 'GitHub Projects', discovery: ['containers', 'states'] },
	{ id: 'linear', label: 'Linear', discovery: ['containers', 'states'] },
	{ id: 'jira', label: 'Jira', discovery: ['containers', 'states'] },
];

function renderPanel(providerId: string) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<PmProviderPanel
				projectId="p1"
				providerId={providerId}
				onProviderChange={vi.fn()}
				isPending={false}
			/>
		</QueryClientProvider>,
	);
}

const providerSelect = () => screen.getByLabelText('Provider') as HTMLSelectElement;

const optionNamed = (name: string) =>
	within(providerSelect()).getByRole('option', { name }) as HTMLOptionElement;

describe('PmProviderPanel (issue #630)', () => {
	beforeEach(() => {
		listProvidersFn.mockReset();
		listProvidersFn.mockResolvedValue(PROVIDERS);
	});

	it('shows the persisted provider and disables every other registered option', async () => {
		renderPanel('github-projects');

		await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
		expect(providerSelect().value).toBe('github-projects');
		await waitFor(() => expect(optionNamed('GitHub Projects').disabled).toBe(false));
		expect(optionNamed('Linear').disabled).toBe(true);
		expect(optionNamed('Jira').disabled).toBe(true);
	});

	// The panel names no provider of its own: the selection and the copy both come
	// from the catalogue, so another project's provider renders without a change.
	it('renders another project’s persisted provider from the same catalogue', async () => {
		renderPanel('linear');

		await waitFor(() => expect(optionNamed('Linear').disabled).toBe(false));
		expect(providerSelect().value).toBe('linear');
		expect(optionNamed('GitHub Projects').disabled).toBe(true);
		expect(screen.getByText(/work items live on Linear/)).not.toBeNull();
	});

	// The registry check survives the move: Trello is in the mapping catalogue but
	// absent from this project's `pm.listProviders` result, so it stays disabled even
	// when it is the option the persisted provider would otherwise leave selectable.
	it('disables a catalogue option no registered provider serves', async () => {
		renderPanel('trello');

		await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
		await waitFor(() => expect(optionNamed('Trello').disabled).toBe(true));
	});

	it('explains the disabled state where the control is, in actionable copy', async () => {
		renderPanel('github-projects');

		await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
		expect(screen.getByText(/swarm\.config\.json/)).not.toBeNull();
		expect(screen.getByText(/swarm config apply/)).not.toBeNull();
		expect(screen.getByText(/The other options are disabled/)).not.toBeNull();
	});

	// A contributor's `listProviders` query is rejected by `projectAdmin`; the panel
	// must still state which provider the project is on rather than empty its control.
	it('still shows the persisted provider when the registry query fails', async () => {
		listProvidersFn.mockRejectedValue(new Error('FORBIDDEN'));

		renderPanel('jira');

		await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
		expect(providerSelect().value).toBe('jira');
		expect(optionNamed('Jira').disabled).toBe(false);
		expect(screen.getByText(/work items live on Jira/)).not.toBeNull();
	});
});
