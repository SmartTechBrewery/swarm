// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerRow } from '@/types/workers.js';

const {
	workersListQueryFn,
	projectsListQueryFn,
	listMineQueryFn,
	rosterQueryFn,
	workersQueryOptions,
	fleetUpdateStatusQueryFn,
} = vi.hoisted(() => ({
	workersListQueryFn: vi.fn(),
	projectsListQueryFn: vi.fn(),
	listMineQueryFn: vi.fn(),
	rosterQueryFn: vi.fn(),
	workersQueryOptions: vi.fn(),
	// The installation rollout readout this screen mounts above the roster (issue #1025).
	fleetUpdateStatusQueryFn: vi.fn(),
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
			// The roster toolbar's installation-wide update action reads the control
			// plane's own build (issue #1009); left unresolved here, since what this
			// suite is about is the screen around it.
			controlPlaneBuild: {
				queryOptions: () => ({
					queryKey: ['workers.controlPlaneBuild'],
					queryFn: () => new Promise(() => {}),
				}),
			},
			fleetUpdateStatusForInstallation: {
				queryOptions: () => ({
					queryKey: ['workers.fleetUpdateStatusForInstallation'],
					queryFn: fleetUpdateStatusQueryFn,
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

vi.mock('@/lib/use-current-user.js', () => ({ useCurrentUser: vi.fn() }));

import { useCurrentUser } from '@/lib/use-current-user.js';
import { WORKERS_REFETCH_MS } from '@/lib/workers-refresh.js';
import { WorkersRouteComponent, WorkersScreen, workersRoute } from './index.js';

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
		repository: 'acme/frontend',
		// The daemon's declared SWARM build and the server's verdict on it (issue #925).
		build: { commit: 'abc1234def5678', dirty: false },
		buildIsCurrent: true,
		supervision: 'unknown',
		connection: 'online',
		lastSeenAt: '2026-07-01T12:00:00.000Z',
		drainingSince: null,
		// No live CLI cool-down (issue #988) — the marked exception is a machine whose
		// own CLI reported a spent usage allowance.
		rateLimits: [],
		// Never asked to update (issue #978) — the `Updating` mark's absent case.
		update: null,
		currentRun: null,
		enrollments: [{ projectId: 'proj-a', status: 'active', allowedClis: ['claude'] }],
		...overrides,
	};
}

function renderScreen(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	workersListQueryFn.mockReset();
	projectsListQueryFn.mockReset();
	workersQueryOptions.mockReset();
	listMineQueryFn.mockReset();
	rosterQueryFn.mockReset();
	fleetUpdateStatusQueryFn.mockReset();
	// No rollout has ever run, which is the ordinary case and renders nothing at all.
	fleetUpdateStatusQueryFn.mockResolvedValue({ rollout: null });
	workersQueryOptions.mockReturnValue({
		queryKey: ['workers.list'],
		queryFn: workersListQueryFn,
	});
	projectsListQueryFn.mockReturnValue(new Promise(() => {}));
	// The screen also composes the owner/roster queries; default them to empty so
	// no consent control renders unless a test opts in.
	listMineQueryFn.mockResolvedValue([]);
	rosterQueryFn.mockResolvedValue([]);
	// The gate on the route (issue #647) reads the session; default to an admin so
	// the roster tests below exercise the screen itself.
	vi.mocked(useCurrentUser).mockReturnValue({
		data: { id: '1', identifier: 'admin', displayName: 'Admin', instanceAdmin: true },
		// biome-ignore lint/suspicious/noExplicitAny: a partial query result is all the gate reads.
	} as any);
});

describe('/workers route registration', () => {
	it('is mounted at /workers', () => {
		// `path` is only populated on the route object once a router initializes it,
		// so read the configured value straight off the options.
		expect((workersRoute.options as { path?: string }).path).toBe('/workers');
	});

	it('polls well inside the 60s default heartbeat TTL, so offline surfaces promptly', () => {
		expect(WORKERS_REFETCH_MS).toBeGreaterThan(0);
		expect(WORKERS_REFETCH_MS).toBeLessThan(60_000);
	});
});

describe('/workers is restricted to instance admins (issue #647)', () => {
	it('denies a non-admin without ever issuing the installation-wide roster read', async () => {
		vi.mocked(useCurrentUser).mockReturnValue({
			data: { id: '2', identifier: 'ada', displayName: 'Ada', instanceAdmin: false },
			// biome-ignore lint/suspicious/noExplicitAny: a partial query result is all the gate reads.
		} as any);
		workersListQueryFn.mockResolvedValue([makeWorker()]);

		renderScreen(<WorkersScreen />);

		expect(
			await screen.findByText('This page is available to instance administrators only.'),
		).toBeDefined();
		expect(screen.queryByText('ada-laptop')).toBeNull();
		expect(workersListQueryFn).not.toHaveBeenCalled();
	});

	it('renders the roster for an instance admin', async () => {
		workersListQueryFn.mockResolvedValue([makeWorker()]);

		renderScreen(<WorkersScreen />);

		expect(await screen.findByText('ada-laptop')).toBeDefined();
	});
});

describe('Workers screen states', () => {
	it('shows a loading state while the roster is in flight', () => {
		workersListQueryFn.mockReturnValue(new Promise(() => {}));
		renderScreen(<WorkersRouteComponent />);

		expect(screen.getByText('Loading workers…')).toBeDefined();
	});

	it('surfaces the API error instead of an empty roster', async () => {
		workersListQueryFn.mockRejectedValue(new Error('Not authenticated'));
		renderScreen(<WorkersRouteComponent />);

		expect(await screen.findByText('Not authenticated')).toBeDefined();
	});

	it('shows an empty state that reads for both an empty installation and a viewer with no visible worker', async () => {
		workersListQueryFn.mockResolvedValue([]);
		renderScreen(<WorkersRouteComponent />);

		expect(await screen.findByText('No workers to show.')).toBeDefined();
		expect(screen.getByText(/enrolled in a project you can access/)).toBeDefined();
	});

	it('renders the roster once loaded, polling on the fixed short interval', async () => {
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderScreen(<WorkersRouteComponent />);

		expect(await screen.findByText('ada-laptop')).toBeDefined();
		expect(screen.getByText('Online')).toBeDefined();
	});

	it('renders the base roster and gives an owned enrollment its sharing control', async () => {
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		listMineQueryFn.mockResolvedValue([
			{
				workerId: 'worker-1',
				displayName: 'ada-laptop',
				capabilities: ['claude'],
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
			},
		]);
		rosterQueryFn.mockResolvedValue([
			{
				enrollmentId: 'enr-1',
				workerId: 'worker-1',
				projectId: 'proj-a',
				displayName: 'ada-laptop',
				owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
				capabilities: ['claude'],
				status: 'active',
				allowedClis: ['claude'],
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
				isRoutable: true,
				runState: { busy: false, currentRunId: null },
			},
		]);
		renderScreen(<WorkersRouteComponent />);

		// Base connectivity roster still renders…
		expect(await screen.findByText('ada-laptop')).toBeDefined();
		// …and the owner gets an actionable switch for their enrollment.
		expect(
			await screen.findByRole('switch', { name: 'Share ada-laptop with proj-a' }),
		).toBeDefined();
	});
});

describe('/workers carries the installation rollout readout (issue #1025)', () => {
	it('renders nothing above the roster when no rollout has ever run', async () => {
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderScreen(<WorkersRouteComponent />);

		await screen.findByText('ada-laptop');
		expect(screen.queryByText('Installation fleet update')).toBeNull();
	});

	it('renders the rollout on a plain page load, with no modal involved', async () => {
		// The point of the readout: a rollout advances itself, so an operator who
		// reloads mid-move — or comes back later — still reads where the fleet got to.
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		fleetUpdateStatusQueryFn.mockResolvedValue({
			rollout: {
				id: 'rollout-1',
				target: 'abc1234def5678901234567890123456789abcde',
				waveSize: 2,
				status: 'in_progress',
				haltReason: null,
				createdAt: '2026-07-01T12:00:00.000Z',
				updatedAt: '2026-07-01T12:01:00.000Z',
				members: [
					{
						workerId: 'worker-1',
						displayName: 'ada-laptop',
						owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
						position: 0,
						state: 'verifying',
						outcome: 'applied',
						message: null,
						signalledAt: '2026-07-01T12:00:30.000Z',
						settledAt: null,
					},
				],
			},
		});
		renderScreen(<WorkersRouteComponent />);

		expect(await screen.findByText('Installation fleet update')).toBeDefined();
		expect(screen.getByText('Verifying')).toBeDefined();
	});
});
