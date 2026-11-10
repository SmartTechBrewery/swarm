// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listFn, getFn } = vi.hoisted(() => ({ listFn: vi.fn(), getFn: vi.fn() }));

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
				queryOptions: () => ({
					queryKey: ['projects.list'],
					queryFn: () => Promise.resolve([{ id: 'p1', name: 'Widgets' }]),
				}),
			},
		},
		bugReports: {
			list: {
				queryOptions: (input: unknown) => ({
					queryKey: ['bugReports.list', input],
					queryFn: () => listFn(input),
				}),
			},
			get: {
				queryOptions: (input: unknown) => ({
					queryKey: ['bugReports.get', input],
					queryFn: () => getFn(input),
				}),
			},
		},
	},
}));

import { BugReportsPanel } from './bug-reports-panel.js';

const REPORT_ID = '00000000-0000-4000-8000-000000000001';
const ORIGINAL_ID = '00000000-0000-4000-8000-000000000002';
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

beforeEach(() => {
	listFn.mockReset();
	getFn.mockReset();
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
		fireEvent.click(screen.getByRole('button', { name: 'All issues' }));
		expect(onSelectReport).toHaveBeenCalledWith(undefined);
	});
});
