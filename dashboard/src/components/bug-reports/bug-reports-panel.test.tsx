// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listFn, getFn, setStatusFn, listMineFn } = vi.hoisted(() => ({
	listFn: vi.fn(),
	getFn: vi.fn(),
	setStatusFn: vi.fn(),
	listMineFn: vi.fn(),
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

// The bug-report query keys share the `bugReports` prefix `pathFilter()` names, as the
// real tRPC keys do, so a status change's invalidation refetches both views.
vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		projects: {
			listMine: {
				queryOptions: () => ({ queryKey: ['projects', 'listMine'], queryFn: () => listMineFn() }),
			},
		},
		bugReports: {
			pathFilter: () => ({ queryKey: ['bugReports'] }),
			list: {
				queryOptions: (input: unknown) => ({
					queryKey: ['bugReports', 'list', input],
					queryFn: () => listFn(input),
				}),
			},
			get: {
				queryOptions: (input: unknown) => ({
					queryKey: ['bugReports', 'get', input],
					queryFn: () => getFn(input),
				}),
			},
		},
	},
	trpcClient: { bugReports: { setStatus: { mutate: setStatusFn } } },
}));

vi.mock('@/lib/use-current-user.js', () => ({ useCurrentUser: vi.fn() }));

import { useCurrentUser } from '@/lib/use-current-user.js';
import { BugReportsPanel } from './bug-reports-panel.js';

const REPORT_ID = '00000000-0000-4000-8000-000000000001';
const ORIGINAL_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_ID = '00000000-0000-4000-8000-000000000003';
const ISSUE_URL = 'https://github.com/acme/swarm/issues/9';
const SEEN = '2026-11-01T09:00:00.000Z';

function makeReport(overrides: Record<string, unknown> = {}) {
	return {
		id: REPORT_ID,
		title: 'Worker loses its lease',
		description: 'The lease expires mid-run.',
		status: 'new',
		projectId: 'p1',
		duplicateOfId: null,
		githubIssueUrl: null,
		filedByUserId: 'u1',
		filedByUserIdentifier: 'ada@example.com',
		filedByRunId: null,
		occurrenceCount: 2,
		firstSeenAt: SEEN,
		lastSeenAt: SEEN,
		statusChangedAt: null,
		createdAt: SEEN,
		updatedAt: SEEN,
		...overrides,
	};
}

function makeOccurrence(overrides: Record<string, unknown> = {}) {
	return {
		id: 'o1',
		reportId: REPORT_ID,
		runId: 'run-42',
		dispatchId: 'dispatch-7',
		taskId: '1390',
		repository: 'acme/widgets',
		prNumber: 12,
		note: 'Seen again after a restart.',
		filedByUserId: 'u1',
		filedByUserIdentifier: 'ada@example.com',
		filedByRunId: null,
		observedAt: SEEN,
		...overrides,
	};
}

function renderPanel(props: { selectedReportId?: string; onSelectReport?: () => void } = {}) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const onSelectReport = props.onSelectReport ?? vi.fn();
	render(
		<QueryClientProvider client={queryClient}>
			<BugReportsPanel selectedReportId={props.selectedReportId} onSelectReport={onSelectReport} />
		</QueryClientProvider>,
	);
	return { onSelectReport };
}

/** Sign in as `instanceAdmin`, holding `role` on project p1 (`null`: no membership). */
function signInAs(instanceAdmin: boolean, role: string | null) {
	// biome-ignore lint/suspicious/noExplicitAny: the panel reads only `data`.
	vi.mocked(useCurrentUser).mockReturnValue({ data: { id: 'u1', instanceAdmin } } as any);
	listMineFn.mockResolvedValue([{ id: 'p1', name: 'Widgets', role }]);
}

beforeEach(() => {
	listFn.mockReset();
	getFn.mockReset();
	setStatusFn.mockReset();
	signInAs(false, 'member');
});

describe('BugReportsPanel list', () => {
	it('requests the open statuses by default', async () => {
		listFn.mockResolvedValue({ data: [makeReport()], total: 1 });
		renderPanel();

		await screen.findByText('Worker loses its lease');
		expect(listFn).toHaveBeenCalledWith({
			status: ['new', 'confirmed', 'environmental', 'ticketed'],
			limit: 25,
			offset: 0,
		});
		expect(screen.getByRole('button', { name: 'Open' }).getAttribute('aria-pressed')).toBe('true');
	});

	it('re-queries with the status filter chosen', async () => {
		listFn.mockResolvedValue({ data: [makeReport()], total: 1 });
		renderPanel();
		await screen.findByText('Worker loses its lease');

		fireEvent.click(screen.getByRole('button', { name: 'Dismissed' }));
		await waitFor(() =>
			expect(listFn).toHaveBeenLastCalledWith({ status: ['dismissed'], limit: 25, offset: 0 }),
		);

		fireEvent.click(screen.getByRole('button', { name: 'All' }));
		await waitFor(() =>
			expect(listFn).toHaveBeenLastCalledWith({
				status: [
					'new',
					'confirmed',
					'environmental',
					'duplicate',
					'ticketed',
					'resolved',
					'dismissed',
				],
				limit: 25,
				offset: 0,
			}),
		);
	});

	it('renders the empty state', async () => {
		listFn.mockResolvedValue({ data: [], total: 0 });
		renderPanel();

		expect(await screen.findByText('No bug reports match this filter.')).not.toBeNull();
	});

	it('shows each row with its project, "Installation" when it has none, and its issue link', async () => {
		listFn.mockResolvedValue({
			data: [
				makeReport({
					status: 'ticketed',
					githubIssueUrl: 'https://github.com/acme/swarm/issues/9',
				}),
				makeReport({ id: ORIGINAL_ID, title: 'Docker is down', projectId: null }),
			],
			total: 2,
		});
		renderPanel();

		const rows = await screen.findAllByTestId('bug-report-row');
		await within(rows[0] as HTMLElement).findByText('Widgets');
		expect(
			within(rows[0] as HTMLElement)
				.getByRole('link', { name: /GitHub issue/ })
				.getAttribute('href'),
		).toBe('https://github.com/acme/swarm/issues/9');
		expect(within(rows[1] as HTMLElement).getByText('Installation')).not.toBeNull();
	});

	it('pages with an offset', async () => {
		listFn.mockResolvedValue({ data: [makeReport()], total: 30 });
		renderPanel();
		await screen.findByText('Worker loses its lease');

		fireEvent.click(screen.getByRole('button', { name: 'Next' }));
		await waitFor(() =>
			expect(listFn).toHaveBeenLastCalledWith({
				status: ['new', 'confirmed', 'environmental', 'ticketed'],
				limit: 25,
				offset: 25,
			}),
		);
	});

	it('opens a report when its row is selected', async () => {
		listFn.mockResolvedValue({ data: [makeReport()], total: 1 });
		const { onSelectReport } = renderPanel();

		fireEvent.click(await screen.findByRole('button', { name: 'Worker loses its lease' }));

		expect(onSelectReport).toHaveBeenCalledWith(REPORT_ID);
		expect(onSelectReport).toHaveBeenCalledTimes(1);
	});
});

describe('BugReportsPanel detail', () => {
	it('lists the occurrences with a link to each run', async () => {
		getFn.mockResolvedValue({
			report: makeReport({ filedByRunId: 'run-1' }),
			occurrences: [makeOccurrence(), makeOccurrence({ id: 'o2', runId: null, note: null })],
			duplicateOf: null,
		});
		renderPanel({ selectedReportId: REPORT_ID });

		const occurrences = await screen.findAllByTestId('bug-report-occurrence');
		expect(getFn).toHaveBeenCalledWith({ reportId: REPORT_ID });
		expect(occurrences).toHaveLength(2);
		const first = within(occurrences[0] as HTMLElement);
		expect(first.getByRole('link', { name: 'run-42' }).getAttribute('href')).toBe('/runs/run-42');
		expect(first.getByText('dispatch-7')).not.toBeNull();
		expect(first.getByText('#12')).not.toBeNull();
		expect(first.getByText('Seen again after a restart.')).not.toBeNull();
		expect(within(occurrences[1] as HTMLElement).queryByRole('link')).toBeNull();
		// The agent run that filed the report links too.
		expect(screen.getByRole('link', { name: 'run-1' }).getAttribute('href')).toBe('/runs/run-1');
		expect(screen.getByText('The lease expires mid-run.')).not.toBeNull();
	});

	it('shows a ticketed report’s GitHub link', async () => {
		getFn.mockResolvedValue({
			report: makeReport({
				status: 'ticketed',
				githubIssueUrl: 'https://github.com/acme/swarm/issues/9',
			}),
			occurrences: [makeOccurrence()],
			duplicateOf: null,
		});
		renderPanel({ selectedReportId: REPORT_ID });

		const link = await screen.findByRole('link', { name: /GitHub issue/ });
		expect(link.getAttribute('href')).toBe('https://github.com/acme/swarm/issues/9');
	});

	it('shows a duplicate’s target and opens it', async () => {
		getFn.mockResolvedValue({
			report: makeReport({ status: 'duplicate', duplicateOfId: ORIGINAL_ID }),
			occurrences: [makeOccurrence()],
			duplicateOf: { id: ORIGINAL_ID, title: 'Leases expire early', status: 'confirmed' },
		});
		const { onSelectReport } = renderPanel({ selectedReportId: REPORT_ID });

		fireEvent.click(await screen.findByRole('button', { name: 'Leases expire early' }));

		expect(onSelectReport).toHaveBeenCalledWith(ORIGINAL_ID);
	});

	it('says so when the duplicate target is not the viewer’s to read', async () => {
		getFn.mockResolvedValue({
			report: makeReport({ status: 'duplicate', duplicateOfId: ORIGINAL_ID }),
			occurrences: [makeOccurrence()],
			duplicateOf: null,
		});
		renderPanel({ selectedReportId: REPORT_ID });

		expect(await screen.findByText('A report you cannot see')).not.toBeNull();
	});

	it('renders the server’s refusal and returns to the list', async () => {
		getFn.mockRejectedValue(new Error(`Bug report "${REPORT_ID}" not found.`));
		const { onSelectReport } = renderPanel({ selectedReportId: REPORT_ID });

		expect(await screen.findByText(/not found/)).not.toBeNull();
		fireEvent.click(screen.getByRole('button', { name: 'All bug reports' }));
		expect(onSelectReport).toHaveBeenCalledWith(undefined);
	});
});

/** The detail view of `report`, refetched as `after` once a status change lands. */
async function renderDetail(report: Record<string, unknown>, after?: Record<string, unknown>) {
	getFn.mockResolvedValue({ report, occurrences: [makeOccurrence()], duplicateOf: null });
	if (after) {
		setStatusFn.mockImplementation(async () => {
			getFn.mockResolvedValue({
				report: after,
				occurrences: [makeOccurrence()],
				duplicateOf: null,
			});
			return after;
		});
	}
	renderPanel({ selectedReportId: REPORT_ID });
	return (await screen.findByRole('form', { name: 'Change status' })) as HTMLFormElement;
}

function chooseStatus(status: string) {
	fireEvent.change(screen.getByLabelText('New status'), { target: { value: status } });
}

function submitButton(form: HTMLElement) {
	return within(form).getByRole('button', { name: 'Change status' }) as HTMLButtonElement;
}

describe('BugReportsPanel detail status change (issue #1443)', () => {
	it('changes the status and shows the new one without a reload', async () => {
		const form = await renderDetail(makeReport(), makeReport({ status: 'confirmed' }));
		// Re-setting the current status changes nothing, so it is not offered.
		expect(submitButton(form).disabled).toBe(true);

		chooseStatus('confirmed');
		fireEvent.click(submitButton(form));

		await waitFor(() =>
			expect(setStatusFn).toHaveBeenCalledWith({ reportId: REPORT_ID, status: 'confirmed' }),
		);
		await waitFor(() => expect(getFn).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect((screen.getByLabelText('New status') as HTMLSelectElement).value).toBe('confirmed'),
		);
		expect(submitButton(screen.getByRole('form', { name: 'Change status' })).disabled).toBe(true);
	});

	it('asks for the report a duplicate duplicates', async () => {
		const form = await renderDetail(makeReport());

		chooseStatus('duplicate');
		expect(submitButton(form).disabled).toBe(true);
		expect(screen.getByText('Name the report this one duplicates.')).not.toBeNull();

		const target = screen.getByLabelText('Duplicate of (report ID)');
		fireEvent.change(target, { target: { value: 'not-an-id' } });
		expect(submitButton(form).disabled).toBe(true);
		expect(
			screen.getByText('The duplicated report must be named by its report ID.'),
		).not.toBeNull();

		fireEvent.change(target, { target: { value: ORIGINAL_ID } });
		fireEvent.click(submitButton(form));

		await waitFor(() =>
			expect(setStatusFn).toHaveBeenCalledWith({
				reportId: REPORT_ID,
				status: 'duplicate',
				duplicateOfId: ORIGINAL_ID,
			}),
		);
	});

	it('asks a ticketed report for its GitHub issue', async () => {
		const form = await renderDetail(makeReport());

		chooseStatus('ticketed');
		expect(submitButton(form).disabled).toBe(true);
		expect(screen.getByText('Enter the GitHub issue this report became.')).not.toBeNull();

		fireEvent.change(screen.getByLabelText('GitHub issue URL'), { target: { value: ISSUE_URL } });
		fireEvent.click(submitButton(form));

		await waitFor(() =>
			expect(setStatusFn).toHaveBeenCalledWith({
				reportId: REPORT_ID,
				status: 'ticketed',
				githubIssueUrl: ISSUE_URL,
			}),
		);
	});

	it('does not ask again for a link the report already has', async () => {
		const form = await renderDetail(makeReport({ status: 'confirmed', githubIssueUrl: ISSUE_URL }));

		chooseStatus('ticketed');
		fireEvent.click(submitButton(form));

		await waitFor(() =>
			expect(setStatusFn).toHaveBeenCalledWith({ reportId: REPORT_ID, status: 'ticketed' }),
		);
	});

	it('shows the server’s message when the change is refused', async () => {
		setStatusFn.mockRejectedValue(new Error(`Bug report "${ORIGINAL_ID}" not found.`));
		const form = await renderDetail(makeReport());

		chooseStatus('duplicate');
		fireEvent.change(screen.getByLabelText('Duplicate of (report ID)'), {
			target: { value: ORIGINAL_ID },
		});
		fireEvent.click(submitButton(form));

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain(`Bug report "${ORIGINAL_ID}" not found.`);
		expect(getFn).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ who: 'a contributor', instanceAdmin: false, role: 'contributor', projectId: 'p1' },
		{ who: 'a non-member', instanceAdmin: false, role: null, projectId: 'p1' },
		{
			who: 'a non-administrator, installation-wide',
			instanceAdmin: false,
			role: 'member',
			projectId: null,
		},
	])('draws no status controls for $who', async ({ instanceAdmin, role, projectId }) => {
		signInAs(instanceAdmin, role);
		getFn.mockResolvedValue({
			report: makeReport({ projectId }),
			occurrences: [makeOccurrence()],
			duplicateOf: null,
		});
		renderPanel({ selectedReportId: REPORT_ID });

		await screen.findAllByTestId('bug-report-occurrence');
		expect(screen.queryByRole('form', { name: 'Change status' })).toBeNull();
	});

	it('draws them for an instance administrator on an installation-wide report', async () => {
		signInAs(true, null);
		await renderDetail(makeReport({ projectId: null }));
	});
});

describe('BugReportsPanel batch status change (issue #1443)', () => {
	const FIRST = makeReport();
	const SECOND = makeReport({ id: ORIGINAL_ID, title: 'Leases expire early', status: 'resolved' });
	const INSTALLATION = makeReport({ id: OTHER_ID, title: 'Docker is down', projectId: null });

	it('changes every selected report and names the ones refused, which stay selected', async () => {
		listFn.mockResolvedValue({ data: [FIRST, SECOND, INSTALLATION], total: 3 });
		setStatusFn.mockImplementation(async ({ reportId }: { reportId: string }) => {
			if (reportId === ORIGINAL_ID) throw new Error('The bug report is already "resolved".');
			listFn.mockResolvedValue({ data: [SECOND, INSTALLATION], total: 2 });
			return { ...FIRST, status: 'resolved' };
		});
		renderPanel();
		await screen.findByText('Worker loses its lease');

		// The installation-wide report is not this member's to change, so it has no box.
		expect(screen.queryByRole('checkbox', { name: 'Select "Docker is down"' })).toBeNull();
		fireEvent.click(screen.getByRole('checkbox', { name: 'Select all on this page' }));
		expect(screen.getByText('2 selected')).not.toBeNull();

		const form = screen.getByRole('form', { name: 'Change status of the selected reports' });
		const submit = within(form).getByRole('button', { name: 'Change status of 2 reports' });
		expect((submit as HTMLButtonElement).disabled).toBe(true);
		chooseStatus('resolved');
		fireEvent.click(submit);

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('Leases expire early');
		expect(alert.textContent).toContain('The bug report is already "resolved".');
		expect(screen.getByRole('status').textContent).toContain('Changed the status of 1 report.');
		expect(setStatusFn).toHaveBeenCalledWith({ reportId: REPORT_ID, status: 'resolved' });
		expect(setStatusFn).toHaveBeenCalledWith({ reportId: ORIGINAL_ID, status: 'resolved' });

		// The changed report left the Open list; the refused one is still selected.
		await waitFor(() => expect(screen.queryByText('Worker loses its lease')).toBeNull());
		const refused = screen.getByRole('checkbox', {
			name: 'Select "Leases expire early"',
		}) as HTMLInputElement;
		expect(refused.checked).toBe(true);
		expect(screen.getByText('1 selected')).not.toBeNull();
	});

	it('offers no selection to a viewer who may change none of the reports', async () => {
		signInAs(false, 'contributor');
		listFn.mockResolvedValue({ data: [FIRST, INSTALLATION], total: 2 });
		renderPanel();
		await screen.findByText('Worker loses its lease');

		expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
	});
});
