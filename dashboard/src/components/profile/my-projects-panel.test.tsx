// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listMineQueryFn, listMineQueryOptions, listQueryOptions, meQueryFn } = vi.hoisted(() => ({
	listMineQueryFn: vi.fn(),
	listMineQueryOptions: vi.fn(),
	listQueryOptions: vi.fn(),
	meQueryFn: vi.fn(),
}));

// A `Link` renders as a plain anchor with its route params substituted in, so the
// destination is assertable without standing up a real router.
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		params,
		children,
		...rest
	}: {
		to: string;
		params?: Record<string, string>;
		children: ReactNode;
	} & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a
			href={Object.entries(params ?? {}).reduce(
				(path, [key, value]) => path.replace(`$${key}`, value),
				to,
			)}
			{...rest}
		>
			{children}
		</a>
	),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		auth: {
			me: { queryOptions: () => ({ queryKey: ['auth.me'], queryFn: meQueryFn }) },
		},
		projects: {
			listMine: {
				queryOptions: (...args: unknown[]) => {
					listMineQueryOptions(...args);
					return { queryKey: ['projects.listMine'], queryFn: listMineQueryFn };
				},
			},
			// Present but never wired up: the panel reaching for the config list instead
			// of the viewer-scoped read model must fail loudly.
			list: {
				queryOptions: (...args: unknown[]) => {
					listQueryOptions(...args);
					return { queryKey: ['projects.list'], queryFn: vi.fn() };
				},
			},
		},
	},
}));

import { MyProjectsPanel } from './my-projects-panel.js';

function renderPanel(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	listMineQueryFn.mockReset();
	listMineQueryOptions.mockReset();
	listQueryOptions.mockReset();
	meQueryFn.mockReset();
	listMineQueryFn.mockResolvedValue([]);
	meQueryFn.mockResolvedValue({ instanceAdmin: false });
});

describe('MyProjectsPanel visibility (issue #661)', () => {
	it('asks the viewer-scoped read model for the projects, supplying no user claim', async () => {
		listMineQueryFn.mockResolvedValue([{ id: 'proj-a', name: 'Alpha', role: 'member' }]);

		renderPanel(<MyProjectsPanel />);
		await screen.findByText('Alpha');

		// `projects.listMine` resolves the viewer from the session, so passing an
		// argument would be the browser naming whose projects to return.
		expect(listMineQueryOptions).toHaveBeenCalled();
		for (const call of listMineQueryOptions.mock.calls) {
			expect(call).toEqual([]);
		}
		// And the configuration list — which carries repo paths and credential
		// references — is never read for this overview.
		expect(listQueryOptions).not.toHaveBeenCalled();
	});

	it('offers no control, so it duplicates no membership authorization', async () => {
		listMineQueryFn.mockResolvedValue([{ id: 'proj-a', name: 'Alpha', role: 'projectAdmin' }]);

		const { container } = renderPanel(<MyProjectsPanel />);
		await screen.findByText('Alpha');

		expect(screen.queryAllByRole('button')).toHaveLength(0);
		expect(screen.queryAllByRole('switch')).toHaveLength(0);
		expect(screen.queryAllByRole('textbox')).toHaveLength(0);
		expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
	});
});

describe('MyProjectsPanel entries', () => {
	it('names the role the viewer holds on each project', async () => {
		listMineQueryFn.mockResolvedValue([
			{ id: 'proj-a', name: 'Alpha', role: 'projectAdmin' },
			{ id: 'proj-b', name: 'Beta', role: 'member' },
			{ id: 'proj-c', name: 'Gamma', role: 'contributor' },
		]);

		renderPanel(<MyProjectsPanel />);

		expect(await screen.findByText('Project administrator')).toBeDefined();
		expect(screen.getByText('Member')).toBeDefined();
		expect(screen.getByText('Contributor')).toBeDefined();
	});

	it('links each entry to the existing project screen', async () => {
		listMineQueryFn.mockResolvedValue([{ id: 'proj-a', name: 'Alpha', role: 'member' }]);

		renderPanel(<MyProjectsPanel />);

		const link = await screen.findByRole('link', { name: 'Alpha' });
		expect(link.getAttribute('href')).toBe('/projects/proj-a');
	});

	it('lists the projects in the order the server returned them', async () => {
		listMineQueryFn.mockResolvedValue([
			{ id: 'proj-b', name: 'Beta', role: 'member' },
			{ id: 'proj-a', name: 'Alpha', role: 'member' },
		]);

		renderPanel(<MyProjectsPanel />);
		await screen.findByText('Beta');

		expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['Beta', 'Alpha']);
	});

	it('stamps the project id beneath the name', async () => {
		listMineQueryFn.mockResolvedValue([{ id: 'proj-a', name: 'Alpha', role: 'member' }]);

		renderPanel(<MyProjectsPanel />);

		expect((await screen.findByText('proj-a')).className).toContain('font-mono');
	});
});

describe('MyProjectsPanel installation-wide access', () => {
	it('reports an absent membership as installation-wide, claiming no project role', async () => {
		listMineQueryFn.mockResolvedValue([{ id: 'proj-a', name: 'Alpha', role: null }]);
		meQueryFn.mockResolvedValue({ instanceAdmin: true });

		renderPanel(<MyProjectsPanel />);

		// The row's badge, plus the note above the table naming it.
		expect(await screen.findAllByText('Installation-wide')).toHaveLength(2);
		expect(screen.getByText(/hold no membership on it/)).toBeDefined();
		// No membership is invented for it — least of all the most privileged one.
		expect(screen.queryByText('Project administrator')).toBeNull();
		expect(screen.queryByText('Member')).toBeNull();
		expect(screen.queryByText('Contributor')).toBeNull();
	});

	it('still reports the real role of a project an instance administrator is a member of', async () => {
		listMineQueryFn.mockResolvedValue([
			{ id: 'proj-a', name: 'Alpha', role: null },
			{ id: 'proj-b', name: 'Beta', role: 'contributor' },
		]);
		meQueryFn.mockResolvedValue({ instanceAdmin: true });

		renderPanel(<MyProjectsPanel />);

		expect(await screen.findAllByText('Installation-wide')).toHaveLength(2);
		expect(screen.getByText('Contributor')).toBeDefined();
		// …and says that the installation role, not that membership, is what grants
		// administration — a `contributor` row would otherwise understate the access.
		expect(screen.getByText(/administer each one whatever role is shown/)).toBeDefined();
	});

	it('says nothing about installation-wide access to an ordinary member', async () => {
		listMineQueryFn.mockResolvedValue([{ id: 'proj-a', name: 'Alpha', role: 'member' }]);

		renderPanel(<MyProjectsPanel />);
		await screen.findByText('Alpha');

		expect(screen.queryByText(/instance administrator/)).toBeNull();
		expect(screen.queryAllByText('Installation-wide')).toHaveLength(0);
	});
});

describe('MyProjectsPanel query states', () => {
	it('shows an empty state to a user who is a member of nothing', async () => {
		listMineQueryFn.mockResolvedValue([]);

		renderPanel(<MyProjectsPanel />);

		expect(await screen.findByText('You are not a member of any project yet.')).toBeDefined();
		expect(screen.queryAllByRole('link')).toHaveLength(0);
	});

	it('reports loading rather than an empty list while the query is in flight', () => {
		listMineQueryFn.mockReturnValue(new Promise(() => {}));

		renderPanel(<MyProjectsPanel />);

		expect(screen.getByText('Loading projects…')).toBeDefined();
		expect(screen.queryByText('You are not a member of any project yet.')).toBeNull();
	});

	it('surfaces a failure verbatim rather than degrading to the empty state', async () => {
		listMineQueryFn.mockRejectedValue(new Error('project read model unavailable'));

		renderPanel(<MyProjectsPanel />);

		expect(await screen.findByText('project read model unavailable')).toBeDefined();
		expect(screen.queryByText('You are not a member of any project yet.')).toBeNull();
	});
});
