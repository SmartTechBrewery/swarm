// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

function renderPanel(
	providerId: string,
	{
		persistedProviderId = providerId,
		onProviderChange = vi.fn(),
	}: { persistedProviderId?: string; onProviderChange?: (id: string) => void } = {},
) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={queryClient}>
			<PmProviderPanel
				projectId="p1"
				providerId={providerId}
				persistedProviderId={persistedProviderId}
				onProviderChange={onProviderChange}
				isPending={false}
			/>
		</QueryClientProvider>,
	);
	return { onProviderChange };
}

const providerSelect = () => screen.getByLabelText('Provider') as HTMLSelectElement;

const optionNamed = (name: string) =>
	within(providerSelect()).getByRole('option', { name }) as HTMLOptionElement;

describe('PmProviderPanel (issues #630, #642)', () => {
	beforeEach(() => {
		listProvidersFn.mockReset();
		listProvidersFn.mockResolvedValue(PROVIDERS);
	});

	// Issue #642 made the selector live: every provider the registry serves is a real
	// choice, not just the one the project is persisted on.
	it('offers every registered provider, not only the persisted one', async () => {
		renderPanel('github-projects');

		await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
		expect(providerSelect().value).toBe('github-projects');
		await waitFor(() => expect(optionNamed('Linear').disabled).toBe(false));
		expect(optionNamed('GitHub Projects').disabled).toBe(false);
		expect(optionNamed('Jira').disabled).toBe(false);
	});

	// The registry check survives the selector going live: Trello is in the mapping
	// catalogue but absent from this project's `pm.listProviders` result, so offering it
	// would offer a switch nothing could discover a board for.
	it('disables a catalogue option no registered provider serves', async () => {
		renderPanel('github-projects');

		await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
		await waitFor(() => expect(optionNamed('Trello').disabled).toBe(true));
	});

	// The panel names no provider of its own: the selection and the copy both come
	// from the catalogue, so another project's provider renders without a change.
	it('renders another project’s persisted provider from the same catalogue', async () => {
		renderPanel('linear');

		await waitFor(() => expect(optionNamed('Linear').disabled).toBe(false));
		expect(providerSelect().value).toBe('linear');
		expect(screen.getByText(/work items live on Linear/)).not.toBeNull();
	});

	it('states the order the switch flow walks instead of sending the operator to a file', async () => {
		renderPanel('github-projects');

		await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
		expect(screen.getByText(/Selecting another provider starts a switch here/)).not.toBeNull();
		expect(screen.queryByText(/swarm\.config\.json/)).toBeNull();
		expect(screen.queryByText(/swarm config apply/)).toBeNull();
	});

	it('raises the draft to the route when another provider is picked', async () => {
		const { onProviderChange } = renderPanel('github-projects');

		await waitFor(() => expect(optionNamed('Linear').disabled).toBe(false));
		fireEvent.change(providerSelect(), { target: { value: 'linear' } });

		expect(onProviderChange).toHaveBeenCalledWith('linear');
	});

	// Mid-switch the persisted provider is still the one running the project, so the copy
	// says what has and has not happened yet — and how to back out.
	it('explains an open switch, including that nothing is written until Save', async () => {
		renderPanel('linear', { persistedProviderId: 'github-projects' });

		await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
		expect(providerSelect().value).toBe('linear');
		expect(
			screen.getByText(/Switching this project from GitHub Projects to Linear/),
		).not.toBeNull();
		expect(screen.getByText(/Nothing about this project changes until you save/)).not.toBeNull();
		expect(screen.getByText(/credentials are retained/)).not.toBeNull();
		expect(screen.getByText(/Select GitHub Projects again to cancel/)).not.toBeNull();
	});

	// A contributor's `listProviders` query is rejected by `projectAdmin`; the panel must
	// still state which provider the project is on, and must not offer a switch it cannot
	// confirm the backend serves.
	it('degrades to the current provider alone when the registry query fails', async () => {
		listProvidersFn.mockRejectedValue(new Error('FORBIDDEN'));

		renderPanel('jira');

		await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
		expect(providerSelect().value).toBe('jira');
		expect(optionNamed('Jira').disabled).toBe(false);
		expect(optionNamed('Linear').disabled).toBe(true);
		expect(optionNamed('GitHub Projects').disabled).toBe(true);
		expect(screen.getByText(/work items live on Jira/)).not.toBeNull();
	});
});
