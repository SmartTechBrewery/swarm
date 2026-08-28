// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerDetail, WorkerRow } from '@/types/workers.js';

const {
	workersListQueryFn,
	getByIdQueryFn,
	projectsListQueryFn,
	listMineQueryFn,
	rosterQueryFn,
	enrollMutate,
	removeMutate,
	scmCredentialsListQueryFn,
} = vi.hoisted(() => ({
	workersListQueryFn: vi.fn(),
	getByIdQueryFn: vi.fn(),
	projectsListQueryFn: vi.fn(),
	listMineQueryFn: vi.fn(),
	rosterQueryFn: vi.fn(),
	enrollMutate: vi.fn(),
	removeMutate: vi.fn(),
	scmCredentialsListQueryFn: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		workers: {
			list: {
				queryOptions: () => ({ queryKey: ['workers.list'], queryFn: workersListQueryFn }),
				// The delete path invalidates the roster by path key, not by one input's
				// options (issue #789).
				queryKey: () => ['workers.list'],
			},
			getById: {
				queryOptions: (input: { workerId: string }) => ({
					queryKey: ['workers.getById', input],
					queryFn: () => getByIdQueryFn(input),
				}),
			},
			listMine: {
				queryOptions: () => ({ queryKey: ['workers.listMine'], queryFn: listMineQueryFn }),
			},
			roster: {
				queryOptions: (input: { projectId: string }) => ({
					queryKey: ['workers.roster', input],
					queryFn: () => rosterQueryFn(input),
				}),
			},
			// The operator-credential card (issue #766) mounts for an owner.
			scmCredentials: {
				list: {
					queryOptions: (input: { workerId: string }) => ({
						queryKey: ['workers.scmCredentials.list', input],
						queryFn: () => scmCredentialsListQueryFn(input),
					}),
				},
			},
		},
		projects: {
			list: { queryOptions: () => ({ queryKey: ['projects.list'], queryFn: projectsListQueryFn }) },
		},
	},
	trpcClient: {
		workers: {
			enroll: { mutate: enrollMutate },
			remove: { mutate: removeMutate },
			setConsent: { mutate: vi.fn() },
			updateConstraints: { mutate: vi.fn() },
			approveEnrollment: { mutate: vi.fn() },
			setStatus: { mutate: vi.fn() },
			scmCredentials: { set: { mutate: vi.fn() } },
		},
	},
}));

// The real root route is the authenticated app shell (sidebar + `auth.me` gate),
// which has nothing to do with the routing under test; a bare root keeps this
// suite about the /workers → /workers/$workerId navigation itself.
vi.mock('../__root.js', () => ({
	rootRoute: createRootRoute({ component: () => <Outlet /> }),
}));

// The index is behind the instance-admin gate (issue #647), which reads the
// session; sign this suite in as an administrator so the navigation it tests is
// what the assertions see. The gate itself is covered by
// `components/layout/instance-admin-only.test.tsx` and `./index.test.tsx`.
vi.mock('@/lib/use-current-user.js', () => ({
	useCurrentUser: () => ({
		data: { id: '1', identifier: 'admin', displayName: 'Admin', instanceAdmin: true },
	}),
}));

import { WORKERS_REFETCH_MS } from '@/lib/workers-refresh.js';
import { workerDetailRoute } from './$workerId.js';
import { workersRoute } from './index.js';

function makeRow(overrides: Partial<WorkerRow> = {}): WorkerRow {
	return {
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		owner: {
			userId: 'u1',
			identifier: 'ada@example.com',
			displayName: 'Ada Lovelace',
		},
		capabilities: ['claude'],
		supportedPhases: ['planning'],
		repository: 'acme/frontend',
		connection: 'online',
		lastSeenAt: '2026-07-01T12:00:00.000Z',
		currentRun: null,
		enrollments: [{ projectId: 'proj-a', status: 'active', allowedClis: ['claude'] }],
		...overrides,
	};
}

function makeDetail(overrides: Partial<WorkerDetail> = {}): WorkerDetail {
	return {
		...makeRow(),
		ownerUserId: 'u1',
		viewerIsOwner: false,
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
				projectRepo: 'acme/frontend',
				viewerCanAdminister: false,
			},
		],
		...overrides,
	};
}

function renderAt(initialEntry: string) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = workersRoute.options.getParentRoute() as ReturnType<typeof createRootRoute>;
	const router = createRouter({
		routeTree: rootRoute.addChildren([workersRoute, workerDetailRoute]),
		history: createMemoryHistory({ initialEntries: [initialEntry] }),
	});
	render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return router;
}

beforeEach(() => {
	for (const mock of [
		workersListQueryFn,
		getByIdQueryFn,
		projectsListQueryFn,
		listMineQueryFn,
		rosterQueryFn,
		scmCredentialsListQueryFn,
	]) {
		mock.mockReset();
	}
	workersListQueryFn.mockResolvedValue([makeRow()]);
	getByIdQueryFn.mockResolvedValue(makeDetail());
	projectsListQueryFn.mockResolvedValue([{ id: 'proj-a', name: 'Widgets', repo: 'acme/widgets' }]);
	listMineQueryFn.mockResolvedValue([]);
	rosterQueryFn.mockResolvedValue([]);
	scmCredentialsListQueryFn.mockResolvedValue({ providers: [] });
	enrollMutate.mockReset();
	enrollMutate.mockResolvedValue({});
	removeMutate.mockReset();
	removeMutate.mockResolvedValue({ workerId: 'worker-1' });
});

describe('/workers/$workerId route registration', () => {
	it('is mounted as a child path of the workers index', () => {
		expect((workerDetailRoute.options as { path?: string }).path).toBe('/workers/$workerId');
	});
});

describe('worker detail navigation (issue #477)', () => {
	it('opens the detail view from a row click and returns to the index on Back', async () => {
		const router = renderAt('/workers');
		expect(await screen.findByText('ada-laptop')).toBeDefined();

		fireEvent.click(screen.getByRole('button', { name: 'Open ada-laptop details' }));

		expect(await screen.findByRole('heading', { name: 'Identity' })).toBeDefined();
		expect(router.state.location.pathname).toBe('/workers/worker-1');
		expect(getByIdQueryFn).toHaveBeenCalledWith({ workerId: 'worker-1' });

		// Browser Back returns to the index — the selection was a URL, not table state.
		act(() => router.history.back());
		expect(await screen.findByRole('columnheader', { name: 'Machine' })).toBeDefined();
		expect(router.state.location.pathname).toBe('/workers');
	});

	it('renders the detail view from a direct deep link', async () => {
		renderAt('/workers/worker-1');

		expect(await screen.findByRole('heading', { name: 'Project enrollments' })).toBeDefined();
		const identity = screen.getByRole('heading', { name: 'Identity' }).parentElement as HTMLElement;
		expect(within(identity).getByText('worker-1')).toBeDefined();
	});

	it('lets an owner enroll their un-enrolled worker from its detail route', async () => {
		getByIdQueryFn.mockResolvedValue(makeDetail({ viewerIsOwner: true, enrollments: [] }));
		projectsListQueryFn.mockResolvedValue([
			{ id: 'proj-a', name: 'Widgets', repositories: [{ repo: 'acme/widgets' }] },
		]);
		enrollMutate.mockReturnValueOnce(new Promise(() => {}));

		renderAt('/workers/worker-1');
		fireEvent.click(await screen.findByRole('button', { name: 'Enroll in a project' }));
		fireEvent.change(screen.getByLabelText(/^Project/), { target: { value: 'proj-a' } });
		fireEvent.click(screen.getByRole('button', { name: 'Enroll worker' }));

		await vi.waitFor(() =>
			expect(enrollMutate).toHaveBeenCalledWith({
				workerId: 'worker-1',
				projectId: 'proj-a',
				allowedClis: ['claude'],
			}),
		);
	});

	it('returns to the workers index once the machine is deleted (issue #789)', async () => {
		getByIdQueryFn.mockResolvedValue(makeDetail({ viewerIsOwner: true }));

		const router = renderAt('/workers/worker-1');
		const deleteSection = (await screen.findByRole('heading', { name: 'Delete worker' }))
			.parentElement as HTMLElement;
		fireEvent.click(within(deleteSection).getByRole('button', { name: 'Delete worker' }));
		const confirms = screen.getAllByRole('button', { name: 'Delete worker' });
		fireEvent.click(confirms[confirms.length - 1]);

		await waitFor(() => expect(removeMutate).toHaveBeenCalledWith({ workerId: 'worker-1' }));
		await waitFor(() => expect(router.state.location.pathname).toBe('/workers'));
	});

	it('links back to the index from the breadcrumb', async () => {
		renderAt('/workers/worker-1');

		const crumb = await screen.findByRole('link', { name: 'workers' });
		expect(crumb.getAttribute('href')).toBe('/workers');
	});

	it('polls while open, so connectivity and the active job stay current', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		try {
			renderAt('/workers/worker-1');
			// `vi.waitFor` here, not the RTL one: only vitest's own advances its fake timers.
			await vi.waitFor(() => expect(getByIdQueryFn).toHaveBeenCalledTimes(1));

			await act(async () => {
				await vi.advanceTimersByTimeAsync(WORKERS_REFETCH_MS + 100);
			});

			expect(getByIdQueryFn.mock.calls.length).toBeGreaterThanOrEqual(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('surfaces the API error rather than an empty machine', async () => {
		getByIdQueryFn.mockRejectedValue(new Error('Worker with ID "worker-1" not found'));
		renderAt('/workers/worker-1');

		expect(await screen.findByText('Worker with ID "worker-1" not found')).toBeDefined();
		expect(screen.queryByRole('heading', { name: 'Identity' })).toBeNull();
	});

	it('keeps the loaded machine visible when a later poll fails, adding the error beside it', async () => {
		getByIdQueryFn
			.mockResolvedValueOnce(makeDetail())
			.mockRejectedValue(new Error('Not authenticated'));
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		try {
			renderAt('/workers/worker-1');
			await vi.waitFor(() =>
				expect(screen.getByRole('heading', { name: 'Identity' })).toBeDefined(),
			);

			await act(async () => {
				await vi.advanceTimersByTimeAsync(WORKERS_REFETCH_MS + 100);
			});

			// The error is reported, but a half-typed edit isn't thrown away with the view.
			await vi.waitFor(() => expect(screen.getByText('Not authenticated')).toBeDefined());
			expect(screen.getByRole('heading', { name: 'Identity' })).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
