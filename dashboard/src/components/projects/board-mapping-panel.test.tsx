// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildPmUpdate,
	isBoardMappingDirty,
	toBoardMappingForm,
	withSelectedContainer,
	withSelectedProvider,
} from '@/lib/board-mapping.js';
import type { ProjectPm } from '../../../../src/config/schema.js';
import { BoardMappingPanel } from './board-mapping-panel.js';

const { listProvidersFn, discoverContainersFn, discoverStatesFn, listPmFn } = vi.hoisted(() => ({
	listProvidersFn: vi.fn(),
	discoverContainersFn: vi.fn(),
	discoverStatesFn: vi.fn(),
	listPmFn: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		projects: {
			credentials: {
				// The panel reads the selected provider's declared roles so it can state the
				// credential step before attempting discovery (issue #642).
				listPm: {
					queryOptions: (args: unknown) => ({
						queryKey: ['projects.credentials.listPm', args],
						queryFn: () => listPmFn(args),
					}),
				},
			},
		},
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
	draftProviderId,
	onSubmit,
}: {
	initial?: ProjectPm;
	/** Start the form on a provider the project is not persisted on (issue #642). */
	draftProviderId?: string;
	onSubmit?: (patch: ProjectPm) => void;
}) {
	const [form, setForm] = useState(() => {
		const projected = toBoardMappingForm(initial);
		return draftProviderId ? withSelectedProvider(projected, draftProviderId) : projected;
	});
	return (
		<BoardMappingPanel
			projectId="p1"
			form={form}
			onSelectContainer={(containerId) => setForm((f) => withSelectedContainer(f, containerId))}
			onStatusOptionChange={(key, value) =>
				setForm((f) => ({ ...f, statusOptions: { ...f.statusOptions, [key]: value } }))
			}
			onProviderContextChange={(key, value) =>
				setForm((f) => ({ ...f, providerContext: { ...f.providerContext, [key]: value } }))
			}
			onStatesContext={(context) => setForm((f) => ({ ...f, providerContext: context }))}
			handleSubmit={(e) => {
				e.preventDefault();
				onSubmit?.(buildPmUpdate(form, initial));
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
	{ id: 'linear', label: 'Linear', discovery: ['containers', 'states'] },
	{
		id: 'jira',
		label: 'Jira',
		discovery: ['containers', 'states'],
		discoveryDraft: [
			{
				key: 'baseUrl',
				label: 'Jira site URL',
				inputType: 'url',
				description: 'The Jira Cloud site URL.',
			},
		],
	},
	{ id: 'trello', label: 'Trello', discovery: ['containers', 'states'] },
];

const CONFIG: ProjectPm = {
	type: 'github-projects',
	projectId: 'PVT_saved',
	statusFieldId: 'PVTSSF_saved',
	statusOptions: { todo: 'opt_ready' },
};

/**
 * A `projects.credentials.listPm` view for the selected provider. Configured by default
 * — every test here is about the mapping, and only the credential-gate test below cares
 * that discovery waits.
 */
function credentialsView({ isConfigured = true }: { isConfigured?: boolean } = {}) {
	return {
		providerId: 'github-projects',
		providerLabel: 'GitHub Projects',
		providerRegistered: true,
		roles: [
			{
				role: 'apiToken',
				label: 'GitHub Projects API Token',
				envVarKey: 'PM_GITHUB_PROJECTS_TOKEN',
				referenceKey: 'PM_GITHUB_PROJECTS_TOKEN',
				optional: false,
				isConfigured,
				maskedValue: isConfigured ? '****' : 'not set',
			},
		],
	};
}

describe('BoardMappingPanel (issue #201)', () => {
	beforeEach(() => {
		listProvidersFn.mockReset();
		discoverContainersFn.mockReset();
		discoverStatesFn.mockReset();
		listPmFn.mockReset();
		listProvidersFn.mockResolvedValue(PROVIDERS);
		listPmFn.mockResolvedValue(credentialsView());
	});

	it('renders human-readable provider/board choices and no raw-ID text inputs', async () => {
		discoverContainersFn.mockResolvedValue({
			containers: [{ id: 'PVT_1', name: 'My Board' }],
		});

		renderHarness();

		await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
		await screen.findByRole('option', { name: 'My Board' });
		// The provider selector moved to the tab's own Provider card (issue #630); this
		// panel keeps only the settings that provider scopes.
		expect(screen.queryByLabelText('Provider')).toBeNull();
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
			expect(discoverStatesFn).toHaveBeenCalledWith({
				projectId: 'p1',
				providerId: 'github-projects',
				containerId: 'PVT_1',
			}),
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

	// Issue #537: the recognized precondition is an unconfigured *PM* credential, and it
	// is recognized by the tRPC error code rather than by matching a token name in the
	// message. It renders as an actionable callout, not as a "failed to load" error.
	it('surfaces a missing-PM-credential precondition as an actionable callout', async () => {
		const error = Object.assign(
			new Error(
				'No GitHub Projects API Token is configured for this project. Add it under Project Management → Credentials',
			),
			{ data: { code: 'PRECONDITION_FAILED' } },
		);
		discoverContainersFn.mockRejectedValue(error);

		renderHarness();

		await waitFor(() =>
			expect(screen.getByText(/No GitHub Projects API Token is configured/)).not.toBeNull(),
		);
		expect(screen.queryByText(/Failed to load boards/)).toBeNull();
	});

	// Issue #642: the switch flow's explicit order, stated where the picker is rather than
	// left to a discovery call that could only fail. Discovery is not even attempted.
	it('waits for the provider’s required credential before discovering anything', async () => {
		listPmFn.mockResolvedValue(credentialsView({ isConfigured: false }));

		renderHarness();

		await waitFor(() =>
			expect(
				screen.getByText(/Set GitHub Projects API Token under Credentials above/),
			).not.toBeNull(),
		);
		expect(screen.getByText(/before picking a board/)).not.toBeNull();
		expect(discoverContainersFn).not.toHaveBeenCalled();
		expect(discoverStatesFn).not.toHaveBeenCalled();
	});

	// A caller whose credential list errors keeps the pre-#642 behaviour: attempt
	// discovery and report whatever the provider says, rather than blocking on a gap this
	// screen cannot confirm.
	it('still attempts discovery when the credential list itself fails', async () => {
		listPmFn.mockRejectedValue(new Error('FORBIDDEN'));
		discoverContainersFn.mockResolvedValue({ containers: [{ id: 'PVT_1', name: 'My Board' }] });

		renderHarness();

		await screen.findByRole('option', { name: 'My Board' });
		expect(discoverContainersFn).toHaveBeenCalledWith({
			projectId: 'p1',
			providerId: 'github-projects',
		});
	});

	// Discovery is addressed to the *form's* provider, which mid-switch is the incoming
	// one — that is what lets the new board be picked before the switch is written.
	it('discovers against the draft provider, not the persisted one', async () => {
		discoverContainersFn.mockResolvedValue({ containers: [{ id: 'team-uuid', name: 'Core' }] });
		listPmFn.mockResolvedValue({
			providerId: 'linear',
			providerLabel: 'Linear',
			providerRegistered: true,
			roles: [],
		});

		// The persisted mapping is GitHub Projects'; the form has already moved to Linear.
		renderHarness({ initial: CONFIG, draftProviderId: 'linear' });

		await waitFor(() =>
			expect(discoverContainersFn).toHaveBeenCalledWith({
				projectId: 'p1',
				providerId: 'linear',
			}),
		);
		expect(listPmFn).toHaveBeenCalledWith({ projectId: 'p1', providerId: 'linear' });
		expect(discoverContainersFn).not.toHaveBeenCalledWith({
			projectId: 'p1',
			providerId: 'github-projects',
		});
		await screen.findByLabelText(/Linear team/i);
	});

	it('still reports an ordinary discovery failure as a load error', async () => {
		discoverContainersFn.mockRejectedValue(
			Object.assign(new Error('GitHub is unavailable'), { data: { code: 'BAD_REQUEST' } }),
		);

		renderHarness();

		await waitFor(() => expect(screen.getByText(/Failed to load boards/)).not.toBeNull());
	});

	// Issue #531: the same panel, for a Linear project — provider vocabulary comes
	// from the catalogue, and Save needs no Status field context (Linear returns none).
	describe('with a Linear project', () => {
		const LINEAR_CONFIG: ProjectPm = {
			type: 'linear',
			teamId: 'team-uuid',
			statusOptions: { todo: 'state-todo' },
		};

		beforeEach(() => {
			discoverContainersFn.mockResolvedValue({ containers: [{ id: 'team-uuid', name: 'Core' }] });
			discoverStatesFn.mockResolvedValue({
				states: [
					{ id: 'state-todo', name: 'Todo' },
					{ id: 'state-done', name: 'Done' },
				],
			});
		});

		it('uses Linear’s nouns and renders its discovered teams and workflow states', async () => {
			renderHarness({ initial: LINEAR_CONFIG });

			await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
			await screen.findByLabelText(/Linear team/i);
			await screen.findByRole('option', { name: 'Core' });
			expect(
				screen.getByText(/Map each SWARM pipeline status to one of the team's/),
			).not.toBeNull();
			// The state selectors are labelled with the provider's own noun, not "status".
			const readySelect = (await screen.findByLabelText(
				'Ready workflow state',
			)) as HTMLSelectElement;
			await waitFor(() => expect(readySelect.disabled).toBe(false));
			expect(within(readySelect).getByRole('option', { name: 'Todo' })).not.toBeNull();
		});

		it('enables Save on an edited mapping and submits the Linear member', async () => {
			const onSubmit = vi.fn();
			renderHarness({ initial: LINEAR_CONFIG, onSubmit });

			const save = () => screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement;
			// Unchanged from the stored mapping — saveable, but nothing to save yet.
			expect(save().disabled).toBe(true);

			const reviewSelect = (await screen.findByLabelText(
				'In review workflow state',
			)) as HTMLSelectElement;
			await waitFor(() => expect(reviewSelect.disabled).toBe(false));
			fireEvent.change(reviewSelect, { target: { value: 'state-done' } });

			// State discovery returned no `providerContext` for Linear, and Save enables anyway.
			await waitFor(() => expect(save().disabled).toBe(false));
			fireEvent.click(save());

			expect(onSubmit).toHaveBeenCalledWith({
				type: 'linear',
				teamId: 'team-uuid',
				statusOptions: { todo: 'state-todo', inReview: 'state-done' },
			});
		});

		it('keeps the mapping scoped to its persisted provider', async () => {
			renderHarness({ initial: LINEAR_CONFIG });

			const teamSelect = (await screen.findByLabelText(/Linear team/i)) as HTMLSelectElement;
			expect(teamSelect.value).toBe('team-uuid');
			// The provider's own copy — the selector and its "change it in
			// swarm.config.json" note — belongs to the Provider card above this one.
			expect(screen.queryByText(/swarm\.config\.json/)).toBeNull();
		});
	});

	// Issue #581: the third provider through the same panel — Jira's nouns come from the
	// catalogue, and its site base URL rides through untouched because this screen does
	// not edit it.
	describe('with a Jira project', () => {
		const JIRA_CONFIG: ProjectPm = {
			type: 'jira',
			baseUrl: 'https://acme.atlassian.net',
			projectKey: 'SWARM',
			statusOptions: { todo: '10001' },
		};

		beforeEach(() => {
			discoverContainersFn.mockResolvedValue({
				containers: [
					{ id: 'SWARM', name: 'Swarm' },
					{ id: 'OPS', name: 'Operations' },
				],
			});
			// Jira's state discovery returns no `providerContext` — a status id is the
			// whole mapping.
			discoverStatesFn.mockResolvedValue({
				states: [
					{ id: '10001', name: 'To Do' },
					{ id: '10002', name: 'Done' },
				],
			});
		});

		it('uses Jira’s nouns and renders its discovered projects and statuses', async () => {
			renderHarness({ initial: JIRA_CONFIG });

			await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
			const projectSelect = (await screen.findByLabelText(/Jira project/i)) as HTMLSelectElement;
			// jsdom ignores a value with no matching option, so wait for the discovered one.
			await screen.findByRole('option', { name: 'Swarm' });
			expect(projectSelect.value).toBe('SWARM');
			expect(
				screen.getByText(/Map each SWARM pipeline status to one of the project's statuses/),
			).not.toBeNull();
			await waitFor(() =>
				expect(discoverStatesFn).toHaveBeenCalledWith({
					projectId: 'p1',
					providerId: 'jira',
					containerId: 'SWARM',
					discoveryDraft: { baseUrl: 'https://acme.atlassian.net' },
				}),
			);
			const readySelect = (await screen.findByLabelText('Ready status')) as HTMLSelectElement;
			await waitFor(() => expect(readySelect.disabled).toBe(false));
			expect(within(readySelect).getByRole('option', { name: 'To Do' })).not.toBeNull();
		});

		it('submits the Jira member with the stored base URL preserved', async () => {
			const onSubmit = vi.fn();
			renderHarness({ initial: JIRA_CONFIG, onSubmit });

			const doneSelect = (await screen.findByLabelText('Done status')) as HTMLSelectElement;
			await waitFor(() => expect(doneSelect.disabled).toBe(false));
			fireEvent.change(doneSelect, { target: { value: '10002' } });

			const save = screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement;
			await waitFor(() => expect(save.disabled).toBe(false));
			fireEvent.click(save);

			expect(onSubmit).toHaveBeenCalledWith({
				type: 'jira',
				baseUrl: 'https://acme.atlassian.net',
				projectKey: 'SWARM',
				statusOptions: { todo: '10001', done: '10002' },
			});
		});

		it('keeps the base URL when another Jira project is selected', async () => {
			const onSubmit = vi.fn();
			renderHarness({ initial: JIRA_CONFIG, onSubmit });

			await screen.findByRole('option', { name: 'Operations' });
			fireEvent.change(screen.getByLabelText(/Jira project/i), { target: { value: 'OPS' } });

			// Switching projects clears the previous project's status mapping, so one has
			// to be picked again before Save.
			const readySelect = (await screen.findByLabelText('Ready status')) as HTMLSelectElement;
			await waitFor(() => expect(readySelect.disabled).toBe(false));
			fireEvent.change(readySelect, { target: { value: '10001' } });

			const save = screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement;
			await waitFor(() => expect(save.disabled).toBe(false));
			fireEvent.click(save);

			expect(onSubmit).toHaveBeenCalledWith({
				type: 'jira',
				baseUrl: 'https://acme.atlassian.net',
				projectKey: 'OPS',
				statusOptions: { todo: '10001' },
			});
		});

		it('waits for a missing Jira site URL before discovery or Save', async () => {
			renderHarness({
				initial: { ...JIRA_CONFIG, baseUrl: '' } as ProjectPm,
			});

			const save = screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement;
			await screen.findByLabelText('Jira site URL');
			expect(discoverContainersFn).not.toHaveBeenCalledWith(
				expect.objectContaining({ providerId: 'jira' }),
			);
			expect(screen.getByText(/site URL before discovery/)).not.toBeNull();
			expect(save.disabled).toBe(true);
		});

		it('switches to Jira with a draft site URL, discovers its mapping, and saves one member', async () => {
			const onSubmit = vi.fn();
			renderHarness({
				initial: {
					type: 'linear',
					teamId: 'team-uuid',
					statusOptions: { todo: 'state-todo' },
				} as ProjectPm,
				draftProviderId: 'jira',
				onSubmit,
			});

			expect(discoverContainersFn).not.toHaveBeenCalledWith(
				expect.objectContaining({ providerId: 'jira' }),
			);
			fireEvent.change(await screen.findByLabelText('Jira site URL'), {
				target: { value: 'https://acme.atlassian.net' },
			});
			await screen.findByRole('option', { name: 'Swarm' });
			await waitFor(() =>
				expect(discoverContainersFn).toHaveBeenCalledWith({
					projectId: 'p1',
					providerId: 'jira',
					discoveryDraft: { baseUrl: 'https://acme.atlassian.net' },
				}),
			);
			fireEvent.change(screen.getByLabelText(/Jira project/i), { target: { value: 'SWARM' } });

			const doneSelect = (await screen.findByLabelText('Done status')) as HTMLSelectElement;
			await waitFor(() => expect(doneSelect.disabled).toBe(false));
			fireEvent.change(doneSelect, { target: { value: '10002' } });

			const save = screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement;
			await waitFor(() => expect(save.disabled).toBe(false));
			fireEvent.click(save);
			expect(onSubmit).toHaveBeenCalledWith({
				type: 'jira',
				baseUrl: 'https://acme.atlassian.net',
				projectKey: 'SWARM',
				statusOptions: { done: '10002' },
			});
		});
	});

	// Issue #588: the fourth provider through the same panel. Trello's nouns come from
	// the catalogue too — a card's status is the *list* it sits in — and, like Linear,
	// it carries no provider context, so Save needs nothing beyond a board and a list.
	describe('with a Trello project', () => {
		const TRELLO_CONFIG: ProjectPm = {
			type: 'trello',
			boardId: '5f2b1c8e9d4a3b2c1e0f9a8b',
			statusOptions: { todo: '6a1b2c3d4e5f60718293a4b5' },
		};

		beforeEach(() => {
			discoverContainersFn.mockResolvedValue({
				containers: [{ id: '5f2b1c8e9d4a3b2c1e0f9a8b', name: 'SWARM Board' }],
			});
			// Trello's state discovery returns no `providerContext` — a list id is the
			// whole mapping.
			discoverStatesFn.mockResolvedValue({
				states: [
					{ id: '6a1b2c3d4e5f60718293a4b5', name: 'Ready' },
					{ id: '7b2c3d4e5f60718293a4b5c6', name: 'Done' },
				],
			});
		});

		it('uses Trello’s nouns and renders its discovered boards and lists', async () => {
			renderHarness({ initial: TRELLO_CONFIG });

			await waitFor(() => expect(listProvidersFn).toHaveBeenCalledWith({ projectId: 'p1' }));
			const boardSelect = (await screen.findByLabelText(/Trello board/i)) as HTMLSelectElement;
			// jsdom ignores a value with no matching option, so wait for the discovered one.
			await screen.findByRole('option', { name: 'SWARM Board' });
			expect(boardSelect.value).toBe('5f2b1c8e9d4a3b2c1e0f9a8b');
			expect(
				screen.getByText(/Map each SWARM pipeline status to one of the board's lists/),
			).not.toBeNull();
			await waitFor(() =>
				expect(discoverStatesFn).toHaveBeenCalledWith({
					projectId: 'p1',
					providerId: 'trello',
					containerId: '5f2b1c8e9d4a3b2c1e0f9a8b',
				}),
			);
			// The state selectors are labelled with the provider's own noun, not "status".
			const readySelect = (await screen.findByLabelText('Ready list')) as HTMLSelectElement;
			await waitFor(() => expect(readySelect.disabled).toBe(false));
			expect(within(readySelect).getByRole('option', { name: 'Ready' })).not.toBeNull();
		});

		it('enables Save on an edited mapping and submits the Trello member', async () => {
			const onSubmit = vi.fn();
			renderHarness({ initial: TRELLO_CONFIG, onSubmit });

			const save = () => screen.getByRole('button', { name: 'Save Changes' }) as HTMLButtonElement;
			// Unchanged from the stored mapping — saveable, but nothing to save yet.
			expect(save().disabled).toBe(true);

			const doneSelect = (await screen.findByLabelText('Done list')) as HTMLSelectElement;
			await waitFor(() => expect(doneSelect.disabled).toBe(false));
			fireEvent.change(doneSelect, { target: { value: '7b2c3d4e5f60718293a4b5c6' } });

			// List discovery returned no `providerContext`, and Save enables anyway.
			await waitFor(() => expect(save().disabled).toBe(false));
			fireEvent.click(save());

			expect(onSubmit).toHaveBeenCalledWith({
				type: 'trello',
				boardId: '5f2b1c8e9d4a3b2c1e0f9a8b',
				statusOptions: {
					todo: '6a1b2c3d4e5f60718293a4b5',
					done: '7b2c3d4e5f60718293a4b5c6',
				},
			});
		});
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
