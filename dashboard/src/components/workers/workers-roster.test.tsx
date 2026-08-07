// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRow } from '@/types/workers.js';

const {
	workersListQueryFn,
	projectsListQueryFn,
	listMineQueryFn,
	rosterQueryFn,
	workersQueryOptions,
	navigate,
} = vi.hoisted(() => ({
	workersListQueryFn: vi.fn(),
	projectsListQueryFn: vi.fn(),
	listMineQueryFn: vi.fn(),
	rosterQueryFn: vi.fn(),
	workersQueryOptions: vi.fn(),
	navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigate,
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		workers: {
			list: { queryOptions: workersQueryOptions },
			listMine: {
				queryOptions: () => ({ queryKey: ['workers.listMine'], queryFn: listMineQueryFn }),
			},
			roster: {
				queryOptions: (input: { projectId: string }) => ({
					queryKey: ['workers.roster', input],
					queryFn: () => rosterQueryFn(input),
				}),
			},
		},
		projects: {
			list: {
				queryOptions: () => ({ queryKey: ['projects.list'], queryFn: projectsListQueryFn }),
			},
		},
	},
	trpcClient: {
		workers: { setConsent: { mutate: vi.fn() } },
	},
}));

import { WorkersRoster } from './workers-roster.js';

function makeWorker(overrides: Partial<WorkerRow> = {}): WorkerRow {
	return {
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		owner: {
			userId: 'u1',
			identifier: 'ada@example.com',
			displayName: 'Ada Lovelace',
		},
		capabilities: ['claude'],
		supportedPhases: ['planning', 'implementation'],
		connection: 'online',
		lastSeenAt: '2026-07-01T12:00:00.000Z',
		currentRun: null,
		enrollments: [{ projectId: 'proj-a', status: 'active', allowedClis: ['claude'] }],
		...overrides,
	};
}

function renderRoster(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	for (const m of [
		workersListQueryFn,
		projectsListQueryFn,
		workersQueryOptions,
		listMineQueryFn,
		rosterQueryFn,
		navigate,
	]) {
		m.mockReset();
	}
	workersQueryOptions.mockReturnValue({
		queryKey: ['workers.list'],
		queryFn: workersListQueryFn,
	});
	projectsListQueryFn.mockReturnValue(new Promise(() => {}));
	// The table also composes the owner/roster queries; default them to empty so no
	// consent control renders unless a test opts in.
	listMineQueryFn.mockResolvedValue([]);
	rosterQueryFn.mockResolvedValue([]);
});

describe('WorkersRoster scoping (issue #574)', () => {
	it('asks the server for one project’s roster when scoped', async () => {
		workersListQueryFn.mockResolvedValue([]);
		renderRoster(<WorkersRoster projectId="proj-a" />);

		await screen.findByText('No workers to show.');
		// Scoping is the server's, so no cross-project roster reaches the browser.
		expect(workersQueryOptions).toHaveBeenCalledWith({ projectId: 'proj-a' });
	});

	it('asks for the installation-wide roster when unscoped', async () => {
		workersListQueryFn.mockResolvedValue([]);
		renderRoster(<WorkersRoster />);

		await screen.findByText('No workers to show.');
		// `undefined` rather than no argument, so the two variants keep distinct
		// query keys and a project tab never reads the global roster from the cache.
		expect(workersQueryOptions).toHaveBeenCalledWith(undefined);
	});
});

describe('WorkersRoster states', () => {
	it('shows a loading state while the roster is in flight', () => {
		workersListQueryFn.mockReturnValue(new Promise(() => {}));
		renderRoster(<WorkersRoster projectId="proj-a" />);

		expect(screen.getByText('Loading workers…')).toBeDefined();
	});

	it('surfaces the API error instead of an empty roster', async () => {
		workersListQueryFn.mockRejectedValue(new Error('Project with ID "proj-a" not found'));
		renderRoster(<WorkersRoster projectId="proj-a" />);

		expect(await screen.findByText('Project with ID "proj-a" not found')).toBeDefined();
	});

	it('explains the scoped empty state in terms of this project', async () => {
		workersListQueryFn.mockResolvedValue([]);
		renderRoster(<WorkersRoster projectId="proj-a" />);

		expect(await screen.findByText('No workers to show.')).toBeDefined();
		expect(screen.getByText(/enrolled in this project/)).toBeDefined();
	});

	it('keeps the cross-project wording for the unscoped empty state', async () => {
		workersListQueryFn.mockResolvedValue([]);
		renderRoster(<WorkersRoster />);

		expect(await screen.findByText('No workers to show.')).toBeDefined();
		expect(screen.getByText(/enrolled in a project you can access/)).toBeDefined();
	});

	it('renders the roster once loaded', async () => {
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster projectId="proj-a" />);

		expect(await screen.findByText('ada-laptop')).toBeDefined();
		expect(screen.getByText('Online')).toBeDefined();
	});

	it('opens the machine’s detail view on a row click', async () => {
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster projectId="proj-a" />);

		fireEvent.click(await screen.findByText('ada-laptop'));

		expect(navigate).toHaveBeenCalledWith({
			to: '/workers/$workerId',
			params: { workerId: 'worker-1' },
		});
	});
});
