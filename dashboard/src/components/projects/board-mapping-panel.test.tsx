// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	blankStatusOptions,
	buildGithubProjectsUpdate,
	isBoardMappingDirty,
	toBoardMappingForm,
} from '@/lib/board-mapping.js';
import type { GitHubProjectsIntegrationConfig } from '../../../../src/integrations/pm/github-projects/config-schema.js';
import { BoardMappingPanel } from './board-mapping-panel.js';

const { listProvidersFn, discoverContainersFn, discoverStatesFn } = vi.hoisted(() => ({
	listProvidersFn: vi.fn(),
	discoverContainersFn: vi.fn(),
	discoverStatesFn: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		pm: {
			listProviders: {
				queryOptions: (args: unknown) => ({
					queryKey: ['pm.listProviders', args],
					queryFn: () => listProvidersFn(args),
				}),
			},
			discoverContainers: {
				queryOptions: (args: unknown) => ({
					queryKey: ['pm.discoverContainers', args],
					queryFn: () => discoverContainersFn(args),
				}),
			},
			discoverStates: {
				queryOptions: (args: unknown) => ({
					queryKey: ['pm.discoverStates', args],
					queryFn: () => discoverStatesFn(args),
				}),
			},
		},
	},
}));

/** Route-equivalent state harness so board selection and discovery flow through real state. */
function Harness({
	initial,
	onSubmit,
}: {
	initial?: GitHubProjectsIntegrationConfig;
	onSubmit?: (patch: GitHubProjectsIntegrationConfig) => void;
}) {
	const [form, setForm] = useState(() => toBoardMappingForm(initial));
	return (
		<BoardMappingPanel
			projectId="p1"
			form={form}
			onProviderChange={(providerId) => setForm((f) => ({ ...f, providerId }))}
			onSelectContainer={(containerId) =>
				setForm((f) =>
					f.containerId === containerId
						? f
						: { ...f, containerId, statusOptions: blankStatusOptions(), providerContext: {} },
				)
			}
			onStatusOptionChange={(key, value) =>
				setForm((f) => ({ ...f, statusOptions: { ...f.statusOptions, [key]: value } }))
			}
			onStatesContext={(context) => setForm((f) => ({ ...f, providerContext: context }))}
			handleSubmit={(e) => {
				e.preventDefault();
				onSubmit?.(buildGithubProjectsUpdate(form, initial));
			}}
			handleReset={() => setForm(toBoardMappingForm(initial))}
			isDirty={isBoardMappingDirty(form, initial)}
			isPending={false}
			isSuccess={false}
			isError={false}
		/>
	);
}

function renderHarness(props: Parameters<typeof Harness>[0] = {}) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={queryClient}>
			<Harness {...props} />
		</QueryClientProvider>,
	);
}

const PROVIDERS = [
	{ id: 'github-projects', label: 'GitHub Projects', discovery: ['containers', 'states'] },
];

const CONFIG: GitHubProjectsIntegrationConfig = {
	projectId: 'PVT_saved',
	statusFieldId: 'PVTSSF_saved',
	statusOptions: { todo: 'opt_ready' },
};

describe('BoardMappingPanel (issue #201)', () => {
	beforeEach(() => {
		listProvidersFn.mockReset();
		discoverContainersFn.mockReset();
		discoverStatesFn.mockReset();
		listProvidersFn.mockResolvedValue(PROVIDERS);
	});

	it('renders human-readable provider/board choices and no raw-ID text inputs', async () => {
		discoverContainersFn.mockResolvedValue({
			containers: [{ id: 'PVT_1', name: 'My Board' }],
		});

		renderHarness();

		await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
		expect((screen.getByLabelText('Provider') as HTMLSelectElement).value).toBe('github-projects');
		await screen.findByRole('option', { name: 'My Board' });
		// The whole point of #201: opaque IDs are never typed.
		expect(screen.queryByRole('textbox')).toBeNull();
	});

	it('loads a board’s states on selection, clearing stale mappings, and submits opaque IDs', async () => {
		discoverContainersFn.mockResolvedValue({ containers: [{ id: 'PVT_1', name: 'My Board' }] });
		discoverStatesFn.mockResolvedValue({
			states: [
				{ id: 'opt_ready', name: 'Ready' },
				{ id: 'opt_prog', name: 'In progress' },
			],
			providerContext: { statusFieldId: 'PVTSSF_1' },
		});
		const onSubmit = vi.fn();

		renderHarness({ onSubmit });

		// Wait for the discovered board option before selecting it (jsdom ignores a
		// value with no matching option).
		await screen.findByRole('option', { name: 'My Board' });
		fireEvent.change(screen.getByLabelText(/GitHub Projects board/i), {
			target: { value: 'PVT_1' },
		});

		// State discovery fires for the selected board and enables the status selectors.
		await waitFor(() =>
			expect(discoverStatesFn).toHaveBeenCalledWith({ projectId: 'p1', containerId: 'PVT_1' }),
		);
		const readySelect = (await screen.findByLabelText('Ready status')) as HTMLSelectElement;
		await waitFor(() => expect(readySelect.disabled).toBe(false));

		fireEvent.change(readySelect, { target: { value: 'opt_ready' } });
		fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));

		expect(onSubmit).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: 'PVT_1',
				statusFieldId: 'PVTSSF_1',
				statusOptions: { todo: 'opt_ready' },
			}),
		);
	});

	it('preserves a saved mapping discovery cannot rediscover with neutral fallback copy', async () => {
		// The saved board is not in the discovered list, and its states fail to load.
		discoverContainersFn.mockResolvedValue({
			containers: [{ id: 'PVT_other', name: 'Other Board' }],
		});
		discoverStatesFn.mockRejectedValue(new Error("board 'PVT_saved' did not resolve"));

		renderHarness({ initial: CONFIG });

		await screen.findByRole('option', { name: 'Configured board (unavailable)' });
		// The saved status option is preserved, shown as a neutral placeholder.
		const readySelect = (await screen.findByLabelText('Ready status')) as HTMLSelectElement;
		expect(readySelect.value).toBe('opt_ready');
		expect(screen.getByRole('option', { name: 'Configured value (unavailable)' })).not.toBeNull();
	});

	it('surfaces a missing-credential precondition as an actionable operator-token callout', async () => {
		discoverContainersFn.mockRejectedValue(
			new Error(
				"No implementer token is configured. Set SWARM_OPERATOR_GH_TOKEN in this host's environment, then try again.",
			),
		);

		renderHarness();

		await waitFor(() => expect(screen.getByText(/Set SWARM_OPERATOR_GH_TOKEN/)).not.toBeNull());
	});

	it('disables Save until a board and at least one status are chosen', async () => {
		discoverContainersFn.mockResolvedValue({ containers: [{ id: 'PVT_1', name: 'My Board' }] });
		discoverStatesFn.mockResolvedValue({
			states: [{ id: 'opt_ready', name: 'Ready' }],
			providerContext: { statusFieldId: 'PVTSSF_1' },
		});

		renderHarness();

		const save = () => screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement;
		expect(save().disabled).toBe(true);

		await screen.findByRole('option', { name: 'My Board' });
		fireEvent.change(screen.getByLabelText(/GitHub Projects board/i), {
			target: { value: 'PVT_1' },
		});
		const readySelect = (await screen.findByLabelText('Ready status')) as HTMLSelectElement;
		await waitFor(() => expect(readySelect.disabled).toBe(false));
		// A board with no status mapped yet is still not saveable.
		expect(save().disabled).toBe(true);

		fireEvent.change(readySelect, { target: { value: 'opt_ready' } });
		await waitFor(() => expect(save().disabled).toBe(false));
	});
});
