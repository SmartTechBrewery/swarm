// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnerWorker } from '@/types/workers.js';

const { projectsListQueryFn, listMineQueryFn, listMineQueryOptions, listQueryOptions } = vi.hoisted(
	() => ({
		projectsListQueryFn: vi.fn(),
		listMineQueryFn: vi.fn(),
		listMineQueryOptions: vi.fn(),
		listQueryOptions: vi.fn(),
	}),
);

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
		projects: {
			list: {
				queryOptions: () => ({ queryKey: ['projects.list'], queryFn: projectsListQueryFn }),
			},
		},
		workers: {
			listMine: {
				queryOptions: (...args: unknown[]) => {
					listMineQueryOptions(...args);
					return { queryKey: ['workers.listMine'], queryFn: listMineQueryFn };
				},
			},
			// Present but never wired up: the panel reaching for the installation-wide
			// roster instead of the owner-scoped read model must fail loudly.
			list: {
				queryOptions: (...args: unknown[]) => {
					listQueryOptions(...args);
					return { queryKey: ['workers.list'], queryFn: vi.fn() };
				},
			},
		},
	},
}));

import { MyWorkersPanel } from './my-workers-panel.js';

function makeOwnerWorker(overrides: Partial<OwnerWorker> = {}): OwnerWorker {
	return {
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		capabilities: ['claude', 'codex'],
		runState: { busy: false, currentRunId: null },
		enrollments: [
			{
				enrollmentId: 'enr-1',
				projectId: 'proj-a',
				status: 'active',
				allowedClis: ['claude'],
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
				isRoutable: true,
			},
		],
		...overrides,
	};
}

/**
 * The panel resolves its machines via `workers.listMine` and project names via
 * `projects.list`. By default the name lookup stays pending, so tests that don't
 * exercise it see the raw-id fallback.
 */
function renderPanel(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	projectsListQueryFn.mockReset();
	listMineQueryFn.mockReset();
	listMineQueryOptions.mockReset();
	listQueryOptions.mockReset();
	projectsListQueryFn.mockReturnValue(new Promise(() => {}));
	listMineQueryFn.mockResolvedValue([]);
});

describe('MyWorkersPanel ownership (issue #660)', () => {
	it('asks the owner-scoped read model for the machines, supplying no owner claim', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);

		renderPanel(<MyWorkersPanel />);
		await screen.findByText('ada-laptop');

		// `workers.listMine` resolves the owner from the session, so passing an
		// argument would be the browser naming whose workers to return.
		expect(listMineQueryOptions).toHaveBeenCalled();
		for (const call of listMineQueryOptions.mock.calls) {
			expect(call).toEqual([]);
		}
		// And the installation-wide roster — which is not owner-scoped — is never read.
		expect(listQueryOptions).not.toHaveBeenCalled();
	});

	it('offers no control, so it duplicates no worker-management authorization', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);

		const { container } = renderPanel(<MyWorkersPanel />);
		await screen.findByText('ada-laptop');

		expect(screen.queryAllByRole('button')).toHaveLength(0);
		expect(screen.queryAllByRole('switch')).toHaveLength(0);
		expect(screen.queryAllByRole('textbox')).toHaveLength(0);
		expect(container.querySelectorAll('input, select, textarea')).toHaveLength(0);
	});
});

describe('MyWorkersPanel entries', () => {
	it('links each machine to its existing detail screen', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);

		renderPanel(<MyWorkersPanel />);

		const link = await screen.findByRole('link', { name: 'ada-laptop' });
		expect(link.getAttribute('href')).toBe('/workers/worker-1');
	});

	it('lists every machine the owner operates, in the order the server returned them', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker(),
			makeOwnerWorker({ workerId: 'worker-2', displayName: 'grace-desktop', enrollments: [] }),
		]);

		renderPanel(<MyWorkersPanel />);
		await screen.findByText('ada-laptop');

		expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual([
			'ada-laptop',
			'grace-desktop',
		]);
	});

	it('reports a machine that is executing a job', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({ runState: { busy: true, currentRunId: 'run-7' } }),
		]);

		renderPanel(<MyWorkersPanel />);

		expect(await screen.findByText('Running a job')).toBeDefined();
		expect(screen.queryByText('Idle')).toBeNull();
	});

	it('reports an idle machine without claiming it is connected', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);

		renderPanel(<MyWorkersPanel />);

		// This read model carries no lease state, so "Idle" is about work only.
		const idle = await screen.findByText('Idle');
		expect(idle.getAttribute('title')).toContain('detail screen');
	});

	it('stamps the agent CLIs the machine declares', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);

		renderPanel(<MyWorkersPanel />);
		await screen.findByText('ada-laptop');

		expect(screen.getByText('Agent CLIs')).toBeDefined();
		expect(screen.getByText('claude')).toBeDefined();
		expect(screen.getByText('codex')).toBeDefined();
	});

	it('renders a muted dash for a machine that declares no CLI', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker({ capabilities: [] })]);

		renderPanel(<MyWorkersPanel />);
		await screen.findByText('ada-laptop');

		expect(screen.getByText('—')).toBeDefined();
	});
});

describe('MyWorkersPanel availability', () => {
	it('marks a routable enrollment available under its project name', async () => {
		projectsListQueryFn.mockResolvedValue([
			{ id: 'proj-a', name: 'Project A', repo: 'acme/widgets' },
		]);
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);

		renderPanel(<MyWorkersPanel />);

		expect(await screen.findByText('Project A')).toBeDefined();
		expect(screen.getByText('Available')).toBeDefined();
	});

	it('explains an unapproved enrollment in the worker detail view’s own words', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({
				enrollments: [
					{
						enrollmentId: 'enr-1',
						projectId: 'proj-a',
						status: 'pending',
						allowedClis: ['claude'],
						allowedPhases: ['implementation'],
						concurrencyAllocation: 1,
						sharingConsent: true,
						isRoutable: false,
					},
				],
			}),
		]);

		renderPanel(<MyWorkersPanel />);

		expect(await screen.findByText('Unavailable')).toBeDefined();
		// From the shared `routabilityBlockers`, so the profile never explains
		// unavailability differently from the detail screen.
		expect(screen.getByText(/project administrator’s approval/)).toBeDefined();
	});

	it('names the owner’s own withheld consent as the blocker', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({
				enrollments: [
					{
						enrollmentId: 'enr-1',
						projectId: 'proj-a',
						status: 'active',
						allowedClis: ['claude'],
						allowedPhases: ['implementation'],
						concurrencyAllocation: 1,
						sharingConsent: false,
						isRoutable: false,
					},
				],
			}),
		]);

		renderPanel(<MyWorkersPanel />);

		expect(await screen.findByText('Unavailable')).toBeDefined();
		expect(screen.getByText(/owner has not shared this machine/)).toBeDefined();
	});

	it('falls back to the raw project id when the name lookup is unavailable', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);

		renderPanel(<MyWorkersPanel />);

		// `projects.list` stays pending by default — the line still names its project.
		expect(await screen.findByText('proj-a')).toBeDefined();
	});

	it('states that a machine is enrolled nowhere rather than leaving the section blank', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker({ enrollments: [] })]);

		renderPanel(<MyWorkersPanel />);

		expect(await screen.findByText('Not enrolled in any project yet.')).toBeDefined();
		expect(screen.queryByText('Available')).toBeNull();
		expect(screen.queryByText('Unavailable')).toBeNull();
		expect(screen.getByText('swarm workers enroll')).toBeDefined();
	});
});

describe('MyWorkersPanel query states', () => {
	it('shows an empty state to an owner with no machines', async () => {
		listMineQueryFn.mockResolvedValue([]);

		renderPanel(<MyWorkersPanel />);

		expect(await screen.findByText("You don't operate any workers yet.")).toBeDefined();
		expect(screen.getByText('swarm workers register')).toBeDefined();
		expect(screen.queryAllByRole('link')).toHaveLength(0);
	});

	it('reports loading rather than an empty fleet while the query is in flight', () => {
		listMineQueryFn.mockReturnValue(new Promise(() => {}));

		renderPanel(<MyWorkersPanel />);

		expect(screen.getByText('Loading workers…')).toBeDefined();
		expect(screen.queryByText("You don't operate any workers yet.")).toBeNull();
	});

	it('surfaces a failure verbatim rather than degrading to the empty state', async () => {
		listMineQueryFn.mockRejectedValue(new Error('worker read model unavailable'));

		renderPanel(<MyWorkersPanel />);

		expect(await screen.findByText('worker read model unavailable')).toBeDefined();
		expect(screen.queryByText("You don't operate any workers yet.")).toBeNull();
	});
});
