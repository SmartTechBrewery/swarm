// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	OwnerWorker,
	WorkerActiveRun,
	WorkerRosterEntry,
	WorkerRow,
} from '@/types/workers.js';

const { projectsListQueryFn, listMineQueryFn, rosterQueryFn, setConsentMutate } = vi.hoisted(
	() => ({
		projectsListQueryFn: vi.fn(),
		listMineQueryFn: vi.fn(),
		rosterQueryFn: vi.fn(),
		setConsentMutate: vi.fn(),
	}),
);

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		projects: {
			list: {
				queryOptions: () => ({ queryKey: ['projects.list'], queryFn: projectsListQueryFn }),
			},
		},
		workers: {
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
	},
	trpcClient: {
		workers: { setConsent: { mutate: setConsentMutate } },
	},
}));

import { WorkersTable } from './workers-table.js';

const NOW = new Date('2026-07-01T12:00:00.000Z');

function makeWorker(overrides: Partial<WorkerRow> = {}): WorkerRow {
	return {
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
		capabilities: ['claude', 'codex'],
		supportedPhases: ['planning', 'implementation', 'review'],
		connection: 'online',
		lastSeenAt: NOW.toISOString(),
		currentRun: null,
		enrollments: [{ projectId: 'proj-a', status: 'active' }],
		...overrides,
	};
}

/** A board-driven active job, as `workers.list` reports it (issue #473). */
function makeActiveRun(overrides: Partial<WorkerActiveRun> = {}): WorkerActiveRun {
	return {
		runId: 'run-7',
		projectId: 'proj-a',
		taskId: '42',
		phase: 'implementation',
		workItemId: 'I_kwitem',
		workItemTitle: 'Teach the dispatcher to count',
		workItemUrl: 'https://github.com/acme/widgets/issues/42',
		prNumber: null,
		prTitle: null,
		...overrides,
	};
}

function makeRosterEntry(overrides: Partial<WorkerRosterEntry> = {}): WorkerRosterEntry {
	return {
		enrollmentId: 'enr-1',
		workerId: 'worker-1',
		projectId: 'proj-a',
		displayName: 'ada-laptop',
		owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
		capabilities: ['claude', 'codex'],
		status: 'active',
		allowedClis: ['claude'],
		concurrencyAllocation: 1,
		sharingConsent: true,
		isRoutable: true,
		runState: { busy: false, currentRunId: null },
		...overrides,
	};
}

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
				concurrencyAllocation: 1,
				sharingConsent: true,
				isRoutable: true,
			},
		],
		...overrides,
	};
}

// The table resolves project names/repos via `projects.list`, its own enrollments
// via `workers.listMine`, and per-project consent via `workers.roster`. Wrap in a
// QueryClient (retry off). By default `projects.list` stays pending (raw id
// fallback) and the owner/roster queries are empty so no control renders — each
// test overrides only what it exercises.
function renderTable(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	projectsListQueryFn.mockReset();
	listMineQueryFn.mockReset();
	rosterQueryFn.mockReset();
	setConsentMutate.mockReset();
	projectsListQueryFn.mockReturnValue(new Promise(() => {}));
	listMineQueryFn.mockResolvedValue([]);
	rosterQueryFn.mockResolvedValue([]);
	// Fake only `Date` (fixes `formatRelativeTime`'s "now") so setTimeout stays
	// real and Testing Library's async `findBy*`/`waitFor` resolve normally.
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('WorkersTable connectivity (issue #133)', () => {
	it('shows a connected worker as Online', () => {
		renderTable(<WorkersTable workers={[makeWorker()]} />);
		expect(screen.getByText('Online')).toBeDefined();
	});

	it('shows an offline worker with a relative last-seen time and the exact timestamp as a title', () => {
		const lastSeenAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();
		renderTable(<WorkersTable workers={[makeWorker({ connection: 'offline', lastSeenAt })]} />);

		expect(screen.getByText('Offline')).toBeDefined();
		const relative = screen.getByText('· 5m ago');
		expect(relative.getAttribute('title')).toBe(new Date(lastSeenAt).toLocaleString());
	});

	it('says a worker that never connected has no last-seen value', () => {
		renderTable(
			<WorkersTable workers={[makeWorker({ connection: 'offline', lastSeenAt: null })]} />,
		);

		const never = screen.getByText('· Never connected');
		expect(never.getAttribute('title')).toBeNull();
	});
});

describe('WorkersTable row content', () => {
	it('renders the machine name, owner, and declared CLI capabilities', () => {
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		expect(screen.getByText('ada-laptop')).toBeDefined();
		expect(screen.getByText('Ada Lovelace').getAttribute('title')).toBe('ada@example.com');
		expect(screen.getByText('claude')).toBeDefined();
		expect(screen.getByText('codex')).toBeDefined();
	});

	it('leads Capabilities with a planning badge when the daemon declared that phase', () => {
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		const badges = screen.getByText('claude').parentElement;
		// Planning first, then the CLIs — it is the capability an operator cannot
		// infer from the machine's tooling (issue #467).
		expect([...(badges?.children ?? [])].map((node) => node.textContent)).toEqual([
			'planning',
			'claude',
			'codex',
		]);
		expect(screen.getByText('planning').getAttribute('title')).toContain('Planning phase');
	});

	it('omits the planning badge for a machine whose daemon refuses that phase', () => {
		// What a DB-free remote daemon declares: every CLI, no planning.
		renderTable(
			<WorkersTable
				workers={[
					makeWorker({
						supportedPhases: ['implementation', 'review', 'respond-to-review'],
					}),
				]}
			/>,
		);

		expect(screen.queryByText('planning')).toBeNull();
		expect(screen.getByText('claude')).toBeDefined();
	});

	it('renders one row per worker', () => {
		renderTable(
			<WorkersTable
				workers={[makeWorker(), makeWorker({ workerId: 'worker-2', displayName: 'grace-box' })]}
			/>,
		);

		const bodyRows = screen.getAllByRole('row').slice(1); // drop the header row
		expect(bodyRows).toHaveLength(2);
	});
});

describe('WorkersTable active job (issue #473)', () => {
	it('describes a board-driven job by its work-item title and reference, never by the run id', async () => {
		projectsListQueryFn.mockResolvedValue([
			{ id: 'proj-a', name: 'Widgets', repo: 'acme/widgets' },
		]);
		renderTable(<WorkersTable workers={[makeWorker({ currentRun: makeActiveRun() })]} />);

		// The title is the primary line and links to the run — the run's UUID never
		// appears as the cell's text.
		const title = await screen.findByRole('link', { name: 'Teach the dispatcher to count' });
		expect(title.getAttribute('href')).toBe('/runs/run-7');
		expect(screen.queryByText('run-7')).toBeNull();
		// The work item itself stays one click away, exactly as in the Runs table —
		// the reference line needs the project's repo, so it lands with that query.
		const issue = await screen.findByRole('link', { name: /Issue: #42/ });
		expect(issue.getAttribute('href')).toBe('https://github.com/acme/widgets/issues/42');
	});

	it('names the executing phase on a leading line of its own, above title and reference', async () => {
		projectsListQueryFn.mockResolvedValue([
			{ id: 'proj-a', name: 'Widgets', repo: 'acme/widgets' },
		]);
		renderTable(
			<WorkersTable
				workers={[
					makeWorker({
						currentRun: makeActiveRun({
							phase: 'respond-to-review',
							prNumber: '19',
							prTitle: 'Count dispatches correctly',
						}),
					}),
				]}
			/>,
		);

		// Three lines in order: phase (this table has no Phase column, and it is
		// spelled the way /runs spells it), then the title as the run link, then the
		// provider reference.
		const phase = await screen.findByText('respond to review');
		await screen.findByRole('link', { name: /PR #19/ });
		expect([...(phase.parentElement?.children ?? [])].map((node) => node.textContent)).toEqual([
			'respond to review',
			'Count dispatches correctly',
			'PR #19',
		]);
		expect(
			screen.getByRole('link', { name: 'Count dispatches correctly' }).getAttribute('href'),
		).toBe('/runs/run-7');
	});

	it('leads a PR-driven job with the PR title and PR reference', async () => {
		projectsListQueryFn.mockResolvedValue([
			{ id: 'proj-a', name: 'Widgets', repo: 'acme/widgets' },
		]);
		renderTable(
			<WorkersTable
				workers={[
					makeWorker({
						currentRun: makeActiveRun({
							phase: 'review',
							prNumber: '19',
							prTitle: 'Count dispatches correctly',
						}),
					}),
				]}
			/>,
		);

		expect(await screen.findByRole('link', { name: 'Count dispatches correctly' })).toBeDefined();
		const pr = await screen.findByRole('link', { name: /PR #19/ });
		expect(pr.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/19');
	});

	it('still links a job whose title has not resolved, so a busy worker never reads as idle', async () => {
		projectsListQueryFn.mockResolvedValue([
			{ id: 'proj-a', name: 'Widgets', repo: 'acme/widgets' },
		]);
		renderTable(
			<WorkersTable
				workers={[makeWorker({ currentRun: makeActiveRun({ workItemTitle: null }) })]}
			/>,
		);

		const link = await screen.findByRole('link', { name: 'View run' });
		expect(link.getAttribute('href')).toBe('/runs/run-7');
	});

	it('renders an em dash when the worker has no visible active job', () => {
		renderTable(<WorkersTable workers={[makeWorker({ currentRun: null })]} />);

		expect(screen.queryByRole('link')).toBeNull();
		expect(screen.getAllByText('—').length).toBeGreaterThan(0);
	});
});

describe('WorkersTable Available column (issue #473)', () => {
	it('carries the consent switch alone — no approval badge, project label, allowed CLIs, or busy text', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);
		rosterQueryFn.mockResolvedValue([
			makeRosterEntry({ runState: { busy: true, currentRunId: 'run-9' } }),
		]);
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		const toggle = await screen.findByRole('switch', { name: 'Share ada-laptop with proj-a' });
		const cell = toggle.closest('td');
		expect(cell?.textContent).toBe('');
		// The facts the old Enrollment cell crowded in are gone from the screen.
		expect(screen.queryByText('Active')).toBeNull();
		expect(screen.queryByText('Busy')).toBeNull();
		expect(screen.queryByText('Idle')).toBeNull();
		expect(screen.queryByText('Available to this project')).toBeNull();
		expect(screen.queryByTitle('Effective allowed CLIs for this project')).toBeNull();
	});

	it('shows an em dash for a registered-but-un-enrolled machine', () => {
		renderTable(<WorkersTable workers={[makeWorker({ enrollments: [] })]} />);

		expect(screen.queryByRole('switch')).toBeNull();
		expect(screen.getAllByText('—').length).toBeGreaterThan(0);
	});

	it('renders one switch per visible enrollment, each naming its project', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({
				enrollments: [
					...makeOwnerWorker().enrollments,
					{
						enrollmentId: 'enr-2',
						projectId: 'proj-b',
						status: 'active',
						allowedClis: ['codex'],
						concurrencyAllocation: 1,
						sharingConsent: false,
						isRoutable: false,
					},
				],
			}),
		]);
		rosterQueryFn.mockImplementation(async ({ projectId }: { projectId: string }) =>
			projectId === 'proj-a'
				? [makeRosterEntry()]
				: [
						makeRosterEntry({
							enrollmentId: 'enr-2',
							projectId: 'proj-b',
							sharingConsent: false,
							isRoutable: false,
						}),
					],
		);
		renderTable(
			<WorkersTable
				workers={[
					makeWorker({
						enrollments: [
							{ projectId: 'proj-a', status: 'active' },
							{ projectId: 'proj-b', status: 'active' },
						],
					}),
				]}
			/>,
		);

		expect(
			(await screen.findByRole('switch', { name: 'Share ada-laptop with proj-a' })).getAttribute(
				'aria-checked',
			),
		).toBe('true');
		expect(
			(await screen.findByRole('switch', { name: 'Share ada-laptop with proj-b' })).getAttribute(
				'aria-checked',
			),
		).toBe('false');
	});
});

describe('WorkersTable sharing consent (issue #282)', () => {
	it('shows an owner an actionable switch reflecting the server-derived consent state', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);
		rosterQueryFn.mockResolvedValue([makeRosterEntry()]);
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		const toggle = await screen.findByRole('switch', {
			name: 'Share ada-laptop with proj-a',
		});
		expect(toggle.getAttribute('aria-checked')).toBe('true');
		expect((toggle as HTMLButtonElement).disabled).toBe(false);
	});

	it('enables sharing directly, with the exact payload and the resulting state', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({
				enrollments: [
					{
						enrollmentId: 'enr-1',
						projectId: 'proj-a',
						status: 'active',
						allowedClis: ['claude'],
						concurrencyAllocation: 1,
						sharingConsent: false,
						isRoutable: false,
					},
				],
			}),
		]);
		// Initial roster shows consent off; the post-mutation reconcile refetch is
		// left pending so the assertion targets the immediately-effective optimistic
		// cache update rather than a re-resolved mock.
		rosterQueryFn
			.mockResolvedValueOnce([makeRosterEntry({ sharingConsent: false, isRoutable: false })])
			.mockReturnValue(new Promise(() => {}));
		setConsentMutate.mockResolvedValue({
			id: 'enr-1',
			workerId: 'worker-1',
			projectId: 'proj-a',
			status: 'active',
			allowedClis: ['claude'],
			concurrencyAllocation: 1,
			sharingConsent: true,
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
		});
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		const toggle = await screen.findByRole('switch', {
			name: 'Share ada-laptop with proj-a',
		});
		expect(toggle.getAttribute('aria-checked')).toBe('false');

		fireEvent.click(toggle);

		// No confirmation for enabling — the mutation fires directly.
		expect(screen.queryByText('Stop sharing this worker?')).toBeNull();
		expect(
			(await screen.findByRole('switch', { name: 'Share ada-laptop with proj-a' })).getAttribute(
				'aria-checked',
			),
		).toBe('true');
		expect(setConsentMutate).toHaveBeenCalledWith({
			enrollmentId: 'enr-1',
			sharingConsent: true,
		});
	});

	it('confirms before disabling and never mutates until confirmed', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);
		rosterQueryFn.mockResolvedValueOnce([makeRosterEntry()]).mockReturnValue(new Promise(() => {}));
		setConsentMutate.mockResolvedValue({
			id: 'enr-1',
			workerId: 'worker-1',
			projectId: 'proj-a',
			status: 'active',
			allowedClis: ['claude'],
			concurrencyAllocation: 1,
			sharingConsent: false,
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
		});
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		const toggle = await screen.findByRole('switch', {
			name: 'Share ada-laptop with proj-a',
		});
		fireEvent.click(toggle);

		// A confirmation opens explaining the consequence; no mutation yet.
		const dialogCopy = await screen.findByText(/future automatic dispatch/i);
		expect(dialogCopy).toBeDefined();
		expect(screen.getByText(/does not stop a run already in progress/i)).toBeDefined();
		expect(setConsentMutate).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

		// Immediately effective: the switch flips before reconciliation.
		expect(
			(await screen.findByRole('switch', { name: 'Share ada-laptop with proj-a' })).getAttribute(
				'aria-checked',
			),
		).toBe('false');
		expect(setConsentMutate).toHaveBeenCalledWith({
			enrollmentId: 'enr-1',
			sharingConsent: false,
		});
	});

	it('keeps the active job visible after sharing is disabled (routing state effective immediately, run untouched)', async () => {
		projectsListQueryFn.mockResolvedValue([
			{ id: 'proj-a', name: 'Widgets', repo: 'acme/widgets' },
		]);
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({ runState: { busy: true, currentRunId: 'run-9' } }),
		]);
		rosterQueryFn
			.mockResolvedValueOnce([makeRosterEntry({ runState: { busy: true, currentRunId: 'run-9' } })])
			.mockReturnValue(new Promise(() => {}));
		setConsentMutate.mockResolvedValue({
			id: 'enr-1',
			workerId: 'worker-1',
			projectId: 'proj-a',
			status: 'active',
			allowedClis: ['claude'],
			concurrencyAllocation: 1,
			sharingConsent: false,
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
		});
		renderTable(
			<WorkersTable workers={[makeWorker({ currentRun: makeActiveRun({ runId: 'run-9' }) })]} />,
		);

		fireEvent.click(await screen.findByRole('switch', { name: /Share ada-laptop with/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Stop sharing' }));

		expect(
			(await screen.findByRole('switch', { name: /Share ada-laptop with/ })).getAttribute(
				'aria-checked',
			),
		).toBe('false');
		// The in-flight job is still described — disabling sharing never kills it.
		const job = screen.getByRole('link', { name: 'Teach the dispatcher to count' });
		expect(job.getAttribute('href')).toBe('/runs/run-9');
	});

	it('shows a project admin another owner’s revoked-sharing state as a disabled switch', async () => {
		// The viewer owns nothing (listMine empty) but can read the project roster,
		// where the worker's owner has consent off.
		listMineQueryFn.mockResolvedValue([]);
		rosterQueryFn.mockResolvedValue([
			makeRosterEntry({
				owner: { userId: 'u2', identifier: 'grace@example.com', displayName: 'Grace Hopper' },
				sharingConsent: false,
				isRoutable: false,
			}),
		]);
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		const readOnly = await screen.findByRole('switch', {
			name: 'Sharing of ada-laptop with proj-a',
		});
		expect(readOnly.getAttribute('aria-checked')).toBe('false');
		// Visible, but not a control: it cannot be operated and says whose it is.
		expect((readOnly as HTMLButtonElement).disabled).toBe(true);
		expect(readOnly.getAttribute('title')).toContain('Ada Lovelace');
		fireEvent.click(readOnly);
		expect(setConsentMutate).not.toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: 'Stop sharing' })).toBeNull();
	});

	it('leaves consent unchanged and surfaces the error inline when an enable is rejected', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({
				enrollments: [
					{
						enrollmentId: 'enr-1',
						projectId: 'proj-a',
						status: 'active',
						allowedClis: ['claude'],
						concurrencyAllocation: 1,
						sharingConsent: false,
						isRoutable: false,
					},
				],
			}),
		]);
		rosterQueryFn.mockResolvedValue([
			makeRosterEntry({ sharingConsent: false, isRoutable: false }),
		]);
		setConsentMutate.mockRejectedValue(new Error('Enrollment with ID "enr-1" not found'));
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		const toggle = await screen.findByRole('switch', {
			name: 'Share ada-laptop with proj-a',
		});
		fireEvent.click(toggle);

		expect(await screen.findByText('Enrollment with ID "enr-1" not found')).toBeDefined();
		// The displayed state never falsely flipped to available.
		expect(
			(await screen.findByRole('switch', { name: 'Share ada-laptop with proj-a' })).getAttribute(
				'aria-checked',
			),
		).toBe('false');
	});
});

describe('WorkersTable read-only surface for non-owners', () => {
	it('offers no operable control when the viewer owns no worker', async () => {
		projectsListQueryFn.mockResolvedValue([
			{ id: 'proj-a', name: 'Widgets', repo: 'acme/widgets' },
		]);
		listMineQueryFn.mockResolvedValue([]);
		rosterQueryFn.mockResolvedValue([makeRosterEntry()]);
		renderTable(<WorkersTable workers={[makeWorker({ currentRun: makeActiveRun() })]} />);

		const readOnly = await screen.findByRole('switch', {
			name: /Sharing of ada-laptop with/,
		});
		expect((readOnly as HTMLButtonElement).disabled).toBe(true);
		expect(screen.queryAllByRole('textbox')).toHaveLength(0);
		expect(screen.queryAllByRole('combobox')).toHaveLength(0);
		// Only the job's own links navigate: the run detail page and the work item.
		const row = screen.getAllByRole('row')[1];
		expect(
			within(row)
				.getAllByRole('link')
				.map((link) => link.getAttribute('href')),
		).toEqual(['/runs/run-7', 'https://github.com/acme/widgets/issues/42']);
	});
});

describe('WorkersTable row navigation (issue #477)', () => {
	it('opens the worker detail view on a row click', () => {
		const onSelectWorker = vi.fn();
		renderTable(<WorkersTable workers={[makeWorker()]} onSelectWorker={onSelectWorker} />);

		fireEvent.click(screen.getByText('ada-laptop'));

		expect(onSelectWorker).toHaveBeenCalledWith('worker-1');
	});

	it('gives keyboard/AT users an explicitly named control in the trailing cell', () => {
		const onSelectWorker = vi.fn();
		renderTable(<WorkersTable workers={[makeWorker()]} onSelectWorker={onSelectWorker} />);

		fireEvent.click(screen.getByRole('button', { name: 'Open ada-laptop details' }));

		expect(onSelectWorker).toHaveBeenCalledTimes(1);
		expect(onSelectWorker).toHaveBeenCalledWith('worker-1');
	});

	it('keeps the Available toggle working without navigating', async () => {
		const onSelectWorker = vi.fn();
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);
		rosterQueryFn.mockResolvedValue([makeRosterEntry()]);
		renderTable(<WorkersTable workers={[makeWorker()]} onSelectWorker={onSelectWorker} />);

		fireEvent.click(await screen.findByRole('switch', { name: 'Share ada-laptop with proj-a' }));

		// The confirmation opened (the switch did its own job) and the row did not
		// navigate out from under it.
		expect(screen.getByText('Stop sharing this worker?')).toBeDefined();
		expect(onSelectWorker).not.toHaveBeenCalled();
	});

	it('keeps the Active job links working without navigating', async () => {
		const onSelectWorker = vi.fn();
		projectsListQueryFn.mockResolvedValue([
			{ id: 'proj-a', name: 'Widgets', repo: 'acme/widgets' },
		]);
		renderTable(
			<WorkersTable
				workers={[makeWorker({ currentRun: makeActiveRun() })]}
				onSelectWorker={onSelectWorker}
			/>,
		);

		fireEvent.click(await screen.findByRole('link', { name: 'Teach the dispatcher to count' }));
		fireEvent.click(await screen.findByRole('link', { name: /Issue: #42/ }));

		expect(onSelectWorker).not.toHaveBeenCalled();
	});

	it('renders no row-open control when the caller offers no detail view', () => {
		renderTable(<WorkersTable workers={[makeWorker()]} />);

		expect(screen.queryByRole('button', { name: /Open ada-laptop/ })).toBeNull();
	});
});

describe('WorkersTable polling and delayed/error roster query behavior', () => {
	it('polls supplemental queries and updates availability on cadence', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);
		// The next roster response revokes consent server-side; the switch must
		// follow on the polled cadence without the row remounting.
		rosterQueryFn
			.mockResolvedValueOnce([makeRosterEntry({ sharingConsent: true, isRoutable: true })])
			.mockResolvedValueOnce([makeRosterEntry({ sharingConsent: false, isRoutable: false })]);

		renderTable(<WorkersTable workers={[makeWorker()]} refetchInterval={100} />);

		const initialRow = (await screen.findByText('ada-laptop')).closest('tr');
		expect(
			(await screen.findByRole('switch', { name: 'Share ada-laptop with proj-a' })).getAttribute(
				'aria-checked',
			),
		).toBe('true');

		// After the poll interval, the second roster response flips the switch.
		await vi.waitFor(() => {
			expect(
				screen
					.getByRole('switch', { name: 'Share ada-laptop with proj-a' })
					.getAttribute('aria-checked'),
			).toBe('false');
		});

		// Same row element throughout — the update was a refetch, not a remount.
		expect((await screen.findByText('ada-laptop')).closest('tr')).toBe(initialRow);
		// The owner query (workers.listMine) refetches on the same cadence too.
		expect(listMineQueryFn.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it('withholds the switch while the roster query is delayed rather than implying a state', async () => {
		listMineQueryFn.mockResolvedValue([
			makeOwnerWorker({
				enrollments: [
					{
						enrollmentId: 'enr-1',
						projectId: 'proj-a',
						status: 'active',
						allowedClis: ['claude'],
						concurrencyAllocation: 1,
						sharingConsent: true,
						isRoutable: true,
					},
				],
			}),
		]);
		// Definite-assignment assertion: the Promise executor runs synchronously,
		// so `resolveRoster` is assigned before any code below invokes it — but
		// TypeScript can't prove that through the closure, so assert it.
		let resolveRoster!: (value: WorkerRosterEntry[]) => void;
		const rosterPromise = new Promise<WorkerRosterEntry[]>((resolve) => {
			resolveRoster = resolve;
		});
		rosterQueryFn.mockReturnValue(rosterPromise);

		renderTable(<WorkersTable workers={[makeWorker()]} />);

		// listMine resolved, so the row shows — but consent is unknown until the
		// roster lands, so no switch is drawn, just an explained em dash.
		expect(await screen.findByTitle('Sharing state unavailable')).toBeDefined();
		expect(screen.queryByRole('switch')).toBeNull();

		resolveRoster([makeRosterEntry({ sharingConsent: true, isRoutable: true })]);

		const toggle = await screen.findByRole('switch', {
			name: 'Share ada-laptop with proj-a',
		});
		expect(toggle.getAttribute('aria-checked')).toBe('true');
		expect(screen.queryByTitle('Sharing state unavailable')).toBeNull();
	});

	it('withholds the switch when the roster query fails', async () => {
		listMineQueryFn.mockResolvedValue([makeOwnerWorker()]);
		rosterQueryFn.mockRejectedValue(new Error('Roster query failed'));

		renderTable(<WorkersTable workers={[makeWorker()]} />);

		expect(await screen.findByTitle('Sharing state unavailable')).toBeDefined();
		expect(screen.queryByRole('switch')).toBeNull();
	});
});
