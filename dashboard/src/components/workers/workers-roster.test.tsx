// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WORKERS_REFETCH_MS } from '@/lib/workers-refresh.js';
import type { WorkerRow } from '@/types/workers.js';

const {
	workersListQueryFn,
	projectsListQueryFn,
	listMineQueryFn,
	rosterQueryFn,
	workersQueryOptions,
	meQueryFn,
	controlPlaneBuildQueryFn,
	fleetUpdateStatusQueryFn,
	requestUpdateForInstallationMutate,
	startFleetUpdateForInstallationMutate,
	requestUpdateForProjectMutate,
	reorderMutate,
	navigate,
} = vi.hoisted(() => ({
	workersListQueryFn: vi.fn(),
	projectsListQueryFn: vi.fn(),
	listMineQueryFn: vi.fn(),
	rosterQueryFn: vi.fn(),
	workersQueryOptions: vi.fn(),
	meQueryFn: vi.fn(),
	// Issue #1009 — the build the toolbar's installation-wide action asks every
	// machine for, read from the server rather than invented in the browser.
	controlPlaneBuildQueryFn: vi.fn(),
	// Issue #1025 — the staged rollout the installation-wide action now starts, and
	// the readout it invalidates so `/workers` shows it at once.
	fleetUpdateStatusQueryFn: vi.fn(),
	requestUpdateForInstallationMutate: vi.fn(),
	startFleetUpdateForInstallationMutate: vi.fn(),
	// Issue #1010 — the project-scoped selection over that same fan-out.
	requestUpdateForProjectMutate: vi.fn(),
	reorderMutate: vi.fn(),
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
			controlPlaneBuild: {
				queryOptions: () => ({
					queryKey: ['workers.controlPlaneBuild'],
					queryFn: controlPlaneBuildQueryFn,
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
			// The table's **Enrolled** column asks this per visible project (issue #1035)
			// to decide whether the status switch is actionable. Left pending here, which
			// is the fail-closed reading — this suite is about the roster around the
			// table, not about that column.
			viewerAccess: {
				queryOptions: (input: { projectId: string }) => ({
					queryKey: ['projects.viewerAccess', input],
					queryFn: () => new Promise(() => {}),
				}),
			},
		},
		auth: {
			me: { queryOptions: () => ({ queryKey: ['auth.me'], queryFn: meQueryFn }) },
		},
	},
	trpcClient: {
		workers: {
			setConsent: { mutate: vi.fn() },
			setStatus: { mutate: vi.fn() },
			reorderProjectWorker: { mutate: reorderMutate },
			requestUpdateForInstallation: { mutate: requestUpdateForInstallationMutate },
			startFleetUpdateForInstallation: { mutate: startFleetUpdateForInstallationMutate },
			requestUpdateForProject: { mutate: requestUpdateForProjectMutate },
		},
	},
}));

import { WorkersRoster } from './workers-roster.js';

/**
 * The build this control plane is running (issue #1009) — the commit the toolbar's
 * installation-wide action asks every machine for, and never a ref the browser
 * invents.
 */
const CONTROL_PLANE_COMMIT = 'abc1234def5678901234567890123456789abcde';

/** What that same control plane answers with after it is redeployed. */
const REDEPLOYED_COMMIT = 'f00ba12345678901234567890123456789abcdef';

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
		hostname: null,
		// The daemon's declared SWARM build and the server's verdict on it (issue #925).
		build: { commit: 'abc1234def5678', dirty: false },
		version: null,
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
		meQueryFn,
		controlPlaneBuildQueryFn,
		fleetUpdateStatusQueryFn,
		requestUpdateForInstallationMutate,
		startFleetUpdateForInstallationMutate,
		requestUpdateForProjectMutate,
		reorderMutate,
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
	// Most of this file predates the toolbar's viewer read, so leave the viewer
	// unresolved by default: no test gets the fleet action unless it asks for one,
	// and the tests that never mention a viewer settle no extra query behind them.
	meQueryFn.mockReturnValue(new Promise(() => {}));
	// A control plane that knows its own build, which is the ordinary case; the
	// unreadable one is a case of its own.
	controlPlaneBuildQueryFn.mockResolvedValue({
		build: { commit: CONTROL_PLANE_COMMIT, dirty: false },
	});
	// The roster itself never renders the readout — that is the route's (issue #1025)
	// — but the toolbar reads this query's key to invalidate it after a start.
	fleetUpdateStatusQueryFn.mockResolvedValue({ rollout: null });
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

describe('WorkersRoster reorder controls (issue #750 phase 2)', () => {
	const PAIR = [makeWorker(), makeWorker({ workerId: 'worker-2', displayName: 'grace-box' })];

	it('offers no control to a viewer who may not administer the project', async () => {
		workersListQueryFn.mockResolvedValue(PAIR);
		renderRoster(<WorkersRoster projectId="proj-a" />);

		await screen.findByText('ada-laptop');
		expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
	});

	it('offers none on the global screen either, whatever the caller asks for', async () => {
		workersListQueryFn.mockResolvedValue(PAIR);
		renderRoster(<WorkersRoster canAdminister />);

		await screen.findByText('ada-laptop');
		expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
	});

	it('moves a worker with the project, worker, and direction, then renders the returned order', async () => {
		// The reconcile refetch is left pending so the assertion targets the order the
		// mutation's own response put in the cache.
		workersListQueryFn.mockResolvedValueOnce(PAIR).mockReturnValue(new Promise(() => {}));
		reorderMutate.mockResolvedValue({
			projectId: 'proj-a',
			workerIds: ['worker-2', 'worker-1'],
		});
		renderRoster(<WorkersRoster projectId="proj-a" canAdminister />);

		fireEvent.click(await screen.findByRole('button', { name: 'Move grace-box up' }));

		await vi.waitFor(() => {
			expect(
				screen
					.getAllByRole('row')
					.slice(1)
					.map((row) => row.querySelector('td')?.textContent),
			).toEqual(['grace-box', 'ada-laptop']);
		});
		expect(reorderMutate).toHaveBeenCalledWith({
			projectId: 'proj-a',
			workerId: 'worker-2',
			direction: 'up',
		});
	});

	it('surfaces a rejected move and leaves the order alone', async () => {
		workersListQueryFn.mockResolvedValueOnce(PAIR).mockReturnValue(new Promise(() => {}));
		reorderMutate.mockRejectedValue(new Error('Worker with ID "worker-2" not found'));
		renderRoster(<WorkersRoster projectId="proj-a" canAdminister />);

		fireEvent.click(await screen.findByRole('button', { name: 'Move grace-box up' }));

		expect(await screen.findByText('Worker with ID "worker-2" not found')).toBeDefined();
		expect(
			screen
				.getAllByRole('row')
				.slice(1)
				.map((row) => row.querySelector('td')?.textContent),
		).toEqual(['ada-laptop', 'grace-box']);
	});
});

describe('WorkersRoster search (issue #897)', () => {
	const ADA = makeWorker();
	const GRACE = makeWorker({
		workerId: 'worker-2',
		displayName: 'grace-box',
		owner: { userId: 'u2', identifier: 'grace@example.com', displayName: 'Grace Hopper' },
		repository: 'acme/backend',
	});

	const searchBox = () => screen.getByRole('searchbox', { name: 'Search workers' });
	const machineNames = () =>
		screen
			.getAllByRole('row')
			.slice(1)
			.map((row) => row.querySelector('td')?.textContent);

	it('offers the search box on the global screen and the project tab alike', async () => {
		workersListQueryFn.mockResolvedValue([ADA, GRACE]);
		const { unmount } = renderRoster(<WorkersRoster />);
		await screen.findByText('ada-laptop');
		expect(searchBox()).toBeDefined();
		unmount();

		renderRoster(<WorkersRoster projectId="proj-a" />);
		await screen.findByText('ada-laptop');
		expect(searchBox()).toBeDefined();
	});

	it('narrows the rows to the machines matching what was typed', async () => {
		workersListQueryFn.mockResolvedValue([ADA, GRACE]);
		renderRoster(<WorkersRoster projectId="proj-a" />);
		await screen.findByText('ada-laptop');

		fireEvent.change(searchBox(), { target: { value: 'grace-b' } });

		expect(machineNames()).toEqual(['grace-box']);
	});

	it('matches the owner and the declared repository too', async () => {
		workersListQueryFn.mockResolvedValue([ADA, GRACE]);
		renderRoster(<WorkersRoster projectId="proj-a" />);
		await screen.findByText('ada-laptop');

		fireEvent.change(searchBox(), { target: { value: 'Lovelace' } });
		expect(machineNames()).toEqual(['ada-laptop']);

		fireEvent.change(searchBox(), { target: { value: 'acme/backend' } });
		expect(machineNames()).toEqual(['grace-box']);
	});

	it('restores the full list when the input is cleared', async () => {
		workersListQueryFn.mockResolvedValue([ADA, GRACE]);
		renderRoster(<WorkersRoster projectId="proj-a" />);
		await screen.findByText('ada-laptop');

		fireEvent.change(searchBox(), { target: { value: 'grace' } });
		expect(machineNames()).toEqual(['grace-box']);

		fireEvent.change(searchBox(), { target: { value: '' } });
		expect(machineNames()).toEqual(['ada-laptop', 'grace-box']);
	});

	it('distinguishes a search with no matches from an empty roster', async () => {
		workersListQueryFn.mockResolvedValue([ADA, GRACE]);
		renderRoster(<WorkersRoster projectId="proj-a" />);
		await screen.findByText('ada-laptop');

		fireEvent.change(searchBox(), { target: { value: 'turing' } });

		expect(screen.getByText(/No workers match/)).toBeDefined();
		// The roster itself is not empty, so its "nothing is enrolled" copy must not appear.
		expect(screen.queryByText('No workers to show.')).toBeNull();
		expect(screen.queryByRole('row')).toBeNull();

		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(machineNames()).toEqual(['ada-laptop', 'grace-box']);
	});

	it('offers nothing to type into when the roster is empty', async () => {
		workersListQueryFn.mockResolvedValue([]);
		renderRoster(<WorkersRoster projectId="proj-a" />);

		await screen.findByText('No workers to show.');
		expect(screen.queryByRole('searchbox')).toBeNull();
	});

	it('withholds the reorder controls while a search narrows the list', async () => {
		workersListQueryFn.mockResolvedValue([ADA, GRACE]);
		renderRoster(<WorkersRoster projectId="proj-a" canAdminister />);
		await screen.findByText('ada-laptop');
		expect(screen.getAllByRole('button', { name: /^Move / }).length).toBeGreaterThan(0);

		// A move is relative to the project's whole order, which a filtered list
		// no longer shows.
		fireEvent.change(searchBox(), { target: { value: 'acme' } });
		expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();

		fireEvent.change(searchBox(), { target: { value: '' } });
		expect(screen.getAllByRole('button', { name: /^Move / }).length).toBeGreaterThan(0);
	});
});

/**
 * The toolbar's update action, which is two actions: installation-wide on the
 * unscoped roster, for an instance administrator, and project-wide on a project's
 * Workers tab, for that project's administrator. Both directions are asserted —
 * that each is offered where it belongs, and that neither ever stands in for the
 * other — because a viewer holding one of those roles must not be handed the
 * button belonging to the other.
 */
describe('WorkersRoster update actions', () => {
	const FLEET_BUTTON = { name: 'Update all workers' } as const;
	const PROJECT_BUTTON = { name: 'Update project workers' } as const;

	function asInstanceAdmin() {
		meQueryFn.mockResolvedValue({
			id: 'u1',
			identifier: 'ada@example.com',
			displayName: 'Ada Lovelace',
			instanceAdmin: true,
		});
	}

	it('offers it on the installation-wide roster to an instance administrator', async () => {
		asInstanceAdmin();
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster />);

		expect(await screen.findByRole('button', FLEET_BUTTON)).toBeDefined();
	});

	it('withholds it from a viewer without the installation role', async () => {
		meQueryFn.mockResolvedValue({
			id: 'u1',
			identifier: 'ada@example.com',
			displayName: 'Ada Lovelace',
			instanceAdmin: false,
		});
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster />);

		await screen.findByText('ada-laptop');
		expect(screen.queryByRole('button', FLEET_BUTTON)).toBeNull();
	});

	it('withholds it on a project tab even from an administrator', async () => {
		// "All workers" there would read as that project's, which is not what it does.
		asInstanceAdmin();
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster projectId="proj-a" />);

		await screen.findByText('ada-laptop');
		expect(screen.queryByRole('button', FLEET_BUTTON)).toBeNull();
	});

	it('withholds it while the viewer is still unresolved', async () => {
		// `canViewInstanceWide`'s own contract: absent or unresolved denies, so the
		// button never flashes in before the role is known.
		meQueryFn.mockReturnValue(new Promise(() => {}));
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster />);

		await screen.findByText('ada-laptop');
		expect(screen.queryByRole('button', FLEET_BUTTON)).toBeNull();
	});

	/** The rollout `startFleetUpdateForInstallation` answers with — one machine, draining. */
	function startedRollout() {
		return {
			action: 'started',
			target: CONTROL_PLANE_COMMIT,
			rollout: {
				id: 'rollout-1',
				target: CONTROL_PLANE_COMMIT,
				waveSize: 1,
				status: 'in_progress',
				haltReason: null,
				createdAt: '2026-07-01T12:00:00.000Z',
				updatedAt: '2026-07-01T12:00:00.000Z',
				members: [
					{
						workerId: 'worker-1',
						displayName: 'ada-laptop',
						owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
						position: 0,
						state: 'draining',
						outcome: null,
						message: null,
						signalledAt: null,
						settledAt: null,
					},
				],
			},
		};
	}

	/** Open the roster as an administrator and wait for its fleet action to be live. */
	async function openFleetAction(): Promise<HTMLButtonElement> {
		asInstanceAdmin();
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster />);
		const button = (await screen.findByRole('button', FLEET_BUTTON)) as HTMLButtonElement;
		await vi.waitFor(() => expect(button.disabled).toBe(false));
		return button;
	}

	it('opens the confirmation rather than mutating on the click (issue #1009)', async () => {
		const button = await openFleetAction();

		fireEvent.click(button);

		expect(await screen.findByText(/Update every worker on this installation/)).toBeDefined();
		// It never fires on a single click — the modal is the whole point of the action.
		expect(startFleetUpdateForInstallationMutate).not.toHaveBeenCalled();
	});

	it('names the build, the set, and what a rollout actually does to it (issue #1025)', async () => {
		fireEvent.click(await openFleetAction());

		await screen.findByText(/Update every worker on this installation/);
		expect(
			screen.getByText(
				/every registered machine on this installation, including machines you do not own/,
			),
		).toBeDefined();
		// The control plane's own commit, abbreviated the way every Workers surface does.
		expect(screen.getByText(CONTROL_PLANE_COMMIT.slice(0, 7))).toBeDefined();
		// The rollout drains the machines itself, so the copy says so — a bounded wave
		// at a time, never mid-phase, verified, halting on a bad build, and every
		// machine it drained given back.
		expect(
			screen.getByText(/drains the machines itself, a bounded number at a time/),
		).toBeDefined();
		expect(screen.getByText(/never interrupts a phase/)).toBeDefined();
		expect(screen.getByText(/comes? back on the new build/)).toBeDefined();
		expect(screen.getByText(/goes back in the dispatch pool/)).toBeDefined();
		// The fan-out's sentence is the one thing that must not be here: this path
		// drains machines nobody drained by hand, so "this cannot take capacity down"
		// would be a promise it does not keep. It stays on the project action's dialog.
		expect(screen.queryByText(/already drained/)).toBeNull();
	});

	it('stages the rollout once, for the commit `controlPlaneBuild` answered with', async () => {
		startFleetUpdateForInstallationMutate.mockResolvedValue(startedRollout());
		fireEvent.click(await openFleetAction());

		fireEvent.click(await screen.findByRole('button', { name: 'Start the rollout' }));

		await vi.waitFor(() =>
			expect(startFleetUpdateForInstallationMutate).toHaveBeenCalledWith({
				target: CONTROL_PLANE_COMMIT,
			}),
		);
		expect(startFleetUpdateForInstallationMutate).toHaveBeenCalledTimes(1);
		// Never the one-shot fan-out, which only asked machines somebody had already
		// drained by hand and moved nothing in practice (issue #1025).
		expect(requestUpdateForInstallationMutate).not.toHaveBeenCalled();
	});

	it('promises a staged rollout in the button’s own title, not an ask', async () => {
		const button = await openFleetAction();

		expect(button.title).toContain('Stages a rollout');
		expect(button.title).toContain('every registered machine on this installation');
		expect(button.title).toContain(CONTROL_PLANE_COMMIT.slice(0, 7));
		// The project action's wording is untouched, so this one must not borrow it.
		expect(button.title).not.toContain('Asks ');
	});

	it('asks for the build the control plane is running now, not the one it was running at mount', async () => {
		// The control plane resolves this from its own process, so a redeploy moves it
		// under an open page; rolling the installation onto the commit that page read at
		// mount would put every machine on a build the live server has left behind.
		controlPlaneBuildQueryFn
			.mockResolvedValueOnce({ build: { commit: CONTROL_PLANE_COMMIT, dirty: false } })
			.mockResolvedValue({ build: { commit: REDEPLOYED_COMMIT, dirty: false } });
		startFleetUpdateForInstallationMutate.mockResolvedValue({
			...startedRollout(),
			target: REDEPLOYED_COMMIT,
		});
		asInstanceAdmin();
		workersListQueryFn.mockResolvedValue([makeWorker()]);

		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
		try {
			renderRoster(<WorkersRoster />);
			// `vi.waitFor` throughout: only vitest's own advances its fake timers.
			await vi.waitFor(() => {
				const button = screen.getByRole('button', FLEET_BUTTON) as HTMLButtonElement;
				expect(button.disabled).toBe(false);
				expect(button.title).toContain(CONTROL_PLANE_COMMIT.slice(0, 7));
			});

			await act(async () => {
				await vi.advanceTimersByTimeAsync(WORKERS_REFETCH_MS + 100);
			});

			// The title — the promise the operator reads before clicking — moved with it.
			await vi.waitFor(() =>
				expect((screen.getByRole('button', FLEET_BUTTON) as HTMLButtonElement).title).toContain(
					REDEPLOYED_COMMIT.slice(0, 7),
				),
			);
			fireEvent.click(screen.getByRole('button', FLEET_BUTTON));
			await vi.waitFor(() => expect(screen.getByText(REDEPLOYED_COMMIT.slice(0, 7))).toBeDefined());
			fireEvent.click(screen.getByRole('button', { name: 'Start the rollout' }));

			await vi.waitFor(() =>
				expect(startFleetUpdateForInstallationMutate).toHaveBeenCalledWith({
					target: REDEPLOYED_COMMIT,
				}),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	it('renders the rollout it started, through the readout’s own member list', async () => {
		startFleetUpdateForInstallationMutate.mockResolvedValue(startedRollout());
		fireEvent.click(await openFleetAction());

		fireEvent.click(await screen.findByRole('button', { name: 'Start the rollout' }));

		expect(await screen.findByText('Draining')).toBeDefined();
		expect(screen.getByText('ada@example.com')).toBeDefined();
		// The first wave is not the end of it, so the modal points at the surface that
		// outlives it rather than pretending to be the whole report.
		expect(screen.getByText(/survives a reload/)).toBeDefined();
	});

	it('renders the FORBIDDEN a non-administrator gets verbatim', async () => {
		// The client gate is a decision about what to *offer*; the server re-checks,
		// and its refusal names the command that stages this over the caller's own
		// machines instead.
		const forbidden =
			'Staging a fleet update across the installation is available to instance administrators only. Run `swarm workers update --all abc1234` for the machines you own.';
		startFleetUpdateForInstallationMutate.mockRejectedValue(new Error(forbidden));
		fireEvent.click(await openFleetAction());

		fireEvent.click(await screen.findByRole('button', { name: 'Start the rollout' }));

		expect(await screen.findByText(forbidden)).toBeDefined();
	});

	it('leaves the action disabled, explaining why, when the control plane cannot read its own build', async () => {
		// Falling back to a ref would move every machine on a guess, so there is
		// nothing to offer — the same stance the one-machine button takes.
		controlPlaneBuildQueryFn.mockResolvedValue({ build: null });
		asInstanceAdmin();
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster />);

		const button = (await screen.findByRole('button', FLEET_BUTTON)) as HTMLButtonElement;
		await vi.waitFor(() => expect(button.title).toContain('cannot read its own build'));
		expect(button.disabled).toBe(true);

		fireEvent.click(button);
		expect(screen.queryByText(/Update every worker on this installation\?/)).toBeNull();
	});

	it('withholds the action while that build is still being read', async () => {
		controlPlaneBuildQueryFn.mockReturnValue(new Promise(() => {}));
		asInstanceAdmin();
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster />);

		const button = (await screen.findByRole('button', FLEET_BUTTON)) as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.title).toContain('Reading the build');
	});

	/**
	 * The report `requestUpdateForProject` answers with — the fan-out's own per-machine
	 * shape, which the project action still makes and which is nothing like the
	 * installation-wide rollout above.
	 */
	function projectReport() {
		return {
			projectId: 'proj-a',
			target: CONTROL_PLANE_COMMIT,
			requestedBy: 'ada@example.com',
			workers: [
				{
					workerId: 'worker-1',
					displayName: 'ada-laptop',
					disposition: 'requested',
					owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
					update: null,
				},
			],
		};
	}

	/** Open a project's Workers tab as its administrator and wait for the action to be live. */
	async function openProjectAction(): Promise<HTMLButtonElement> {
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster projectId="proj-a" canAdminister />);
		const button = (await screen.findByRole('button', PROJECT_BUTTON)) as HTMLButtonElement;
		await vi.waitFor(() => expect(button.disabled).toBe(false));
		return button;
	}

	it('offers the scoped action to a project administrator, naming its own set', async () => {
		const button = await openProjectAction();

		// The set it names is this project's machines, never the installation's.
		expect(button.title).toContain('every machine enrolled in this project');
		expect(button.title).not.toContain('on this installation');
		// The same build the installation-wide action asks for, named before the click.
		expect(button.title).toContain(CONTROL_PLANE_COMMIT.slice(0, 7));
	});

	it('opens the confirmation rather than mutating on the click (issue #1010)', async () => {
		fireEvent.click(await openProjectAction());

		expect(await screen.findByText(/Update every worker enrolled in this project/)).toBeDefined();
		expect(requestUpdateForProjectMutate).not.toHaveBeenCalled();
	});

	it('names the project’s machines, the build, and what a shared machine means', async () => {
		fireEvent.click(await openProjectAction());

		await screen.findByText(/Update every worker enrolled in this project/);
		expect(
			screen.getByText(/every machine enrolled in this project, including machines you do not own/),
		).toBeDefined();
		expect(screen.getByText(CONTROL_PLANE_COMMIT.slice(0, 7))).toBeDefined();
		// An update moves a machine's install root, not one enrollment — said out loud
		// rather than left for an operator to discover on a shared machine.
		expect(screen.getByText(/moved for all of them/)).toBeDefined();
		expect(screen.getByText(/already drained/)).toBeDefined();
	});

	it('asks this project once, for the commit `controlPlaneBuild` answered with', async () => {
		requestUpdateForProjectMutate.mockResolvedValue(projectReport());
		fireEvent.click(await openProjectAction());

		fireEvent.click(await screen.findByRole('button', { name: 'Ask them to update' }));

		await vi.waitFor(() =>
			expect(requestUpdateForProjectMutate).toHaveBeenCalledWith({
				projectId: 'proj-a',
				target: CONTROL_PLANE_COMMIT,
			}),
		);
		expect(requestUpdateForProjectMutate).toHaveBeenCalledTimes(1);
		// Never the installation-wide procedure, whatever the viewer's installation role.
		expect(requestUpdateForInstallationMutate).not.toHaveBeenCalled();
	});

	it('renders the per-machine report this request answers with', async () => {
		requestUpdateForProjectMutate.mockResolvedValue(projectReport());
		fireEvent.click(await openProjectAction());

		fireEvent.click(await screen.findByRole('button', { name: 'Ask them to update' }));

		// The same report component the installation-wide action renders.
		expect(await screen.findByText('Requested')).toBeDefined();
		expect(screen.getByText('ada@example.com')).toBeDefined();
	});

	it('renders the refusal a caller who may not administer the project gets verbatim', async () => {
		// `canAdminister` is a decision about what to offer; `projectAdmin` is re-checked
		// server-side, and a member below it is refused there.
		const forbidden = 'You do not have permission to perform this action on project "proj-a".';
		requestUpdateForProjectMutate.mockRejectedValue(new Error(forbidden));
		fireEvent.click(await openProjectAction());

		fireEvent.click(await screen.findByRole('button', { name: 'Ask them to update' }));

		expect(await screen.findByText(forbidden)).toBeDefined();
	});

	it('leaves the scoped action disabled when the control plane cannot read its own build', async () => {
		controlPlaneBuildQueryFn.mockResolvedValue({ build: null });
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster projectId="proj-a" canAdminister />);

		const button = (await screen.findByRole('button', PROJECT_BUTTON)) as HTMLButtonElement;
		await vi.waitFor(() => expect(button.title).toContain('cannot read its own build'));
		expect(button.disabled).toBe(true);

		fireEvent.click(button);
		expect(screen.queryByText(/Update every worker enrolled in this project\?/)).toBeNull();
	});

	it('withholds the scoped action from a member who does not administer the project', async () => {
		// `canAdminister` also fails closed while `projects.viewerAccess` is loading,
		// which is the same absent value.
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster projectId="proj-a" />);

		await screen.findByText('ada-laptop');
		expect(screen.queryByRole('button', PROJECT_BUTTON)).toBeNull();
	});

	it('does not let a project administrator reach the installation-wide action', async () => {
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster projectId="proj-a" canAdminister />);

		await screen.findByRole('button', PROJECT_BUTTON);
		expect(screen.queryByRole('button', FLEET_BUTTON)).toBeNull();
	});

	it('does not offer the scoped action on the installation-wide roster', async () => {
		// "This project" names nothing there, and an instance administrator already
		// has the wider action.
		asInstanceAdmin();
		workersListQueryFn.mockResolvedValue([makeWorker()]);
		renderRoster(<WorkersRoster />);

		await screen.findByRole('button', FLEET_BUTTON);
		expect(screen.queryByRole('button', PROJECT_BUTTON)).toBeNull();
	});
});
