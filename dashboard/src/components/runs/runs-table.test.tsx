// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunRow } from '@/types/runs.js';

const navigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigate,
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		projects: {
			list: {
				queryOptions: () => ({
					queryKey: ['projects.list'],
					queryFn: () => Promise.resolve([]),
				}),
			},
		},
	},
}));

import { RunsTable } from './runs-table.js';

const baseRun: RunRow = {
	id: 'run-1',
	projectId: 'proj-a',
	taskId: '42',
	workItemId: 'issue-42',
	workItemTitle: 'Fix the widget',
	workItemUrl: 'https://github.com/acme/widgets/issues/42',
	prNumber: null,
	prTitle: null,
	producedPrUrl: null,
	phase: 'implementation',
	workerId: null,
	workerUserId: null,
	engine: 'claude',
	model: 'claude-opus-4-8',
	reasoning: null,
	status: 'completed',
	reviewVerdict: null,
	reviewOrdinal: null,
	reviewAutomationOutcome: null,
	reviewMergeOutcome: null,
	reviewMergeMessage: null,
	exitCode: 0,
	timedOut: false,
	error: null,
	startedAt: '2026-07-17T10:00:00.000Z',
	completedAt: '2026-07-17T10:05:00.000Z',
	nextRetryAt: null,
	durationMs: 300000,
	usage: { inputTokens: 1000, outputTokens: 500 },
	jobPayload: null,
	agentSessionId: null,
	failureDiagnosis: null,
};

const project = { id: 'proj-a', name: 'Acme', repositories: [{ repo: 'acme/widgets' }] };

// Seed the `projects.list` cache so run cards/rows can resolve the repo (needed
// for the Task work-item link) synchronously. `staleTime: Infinity` keeps
// the mocked queryFn from refetching and clobbering the seeded value mid-test.
function renderTable(ui: ReactElement, projects: unknown[] = [project]) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	queryClient.setQueryData(['projects.list'], projects);
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	navigate.mockClear();
});

describe('RunsTable', () => {
	describe('desktop table (md and up)', () => {
		it('keeps the full eight-column header set in order inside a hidden md:block wrapper', () => {
			const { container } = renderTable(
				<RunsTable
					runs={[baseRun]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);

			const table = container.querySelector('table');
			const headers = within(table as HTMLElement)
				.getAllByRole('columnheader')
				.map((th) => th.textContent);
			expect(headers).toEqual([
				'Phase',
				'Project',
				'Task',
				'Status',
				'Started',
				'Duration',
				'Model',
				'Tokens',
			]);

			// The table is desktop-only; its wrapper hides it below md and clips
			// rather than scrolls (the pre-#371 recipe), so there is no mobile
			// horizontal-scroll crutch on the table anymore.
			const wrapper = table?.parentElement;
			expect(wrapper?.className).toContain('hidden');
			expect(wrapper?.className).toContain('md:block');
			expect(wrapper?.className).toContain('overflow-hidden');
			expect(wrapper?.className).not.toContain('overflow-x-auto');
			expect(table?.className).not.toContain('min-w-[48rem]');
			expect(table?.className).not.toContain('md:min-w-full');
		});

		it('keeps whole-row navigation on desktop rows', () => {
			const { container } = renderTable(
				<RunsTable
					runs={[baseRun]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);
			const table = container.querySelector('table') as HTMLElement;
			const bodyRow = within(table).getAllByRole('row')[1];
			fireEvent.click(bodyRow);
			expect(navigate).toHaveBeenCalledWith({ to: '/runs/run-1' });
		});
	});

	describe('mobile cards (below md)', () => {
		it('renders one card per run with no horizontal-scroll table at mobile width', () => {
			const { container } = renderTable(
				<RunsTable
					runs={[baseRun, { ...baseRun, id: 'run-2' }]}
					totalCount={2}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);

			expect(screen.getAllByTestId('run-card')).toHaveLength(2);

			// The card list is the below-md presentation, and nothing in the
			// component re-introduces a horizontally scrolling wide table.
			const cardList = screen.getAllByTestId('run-card')[0].parentElement;
			expect(cardList?.className).toContain('md:hidden');
			expect(container.querySelector('.overflow-x-auto')).toBeNull();
			expect(container.querySelector('.min-w-\\[48rem\\]')).toBeNull();
		});

		it('gives each card a title+status primary line and a subordinate metadata footer', () => {
			renderTable(
				<RunsTable
					runs={[baseRun]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);

			const card = screen.getByTestId('run-card');
			const primary = within(card).getByTestId('run-card-primary');
			const footer = within(card).getByTestId('run-card-footer');

			// Primary scan line: the run's title + its status badge.
			expect(within(primary).getByText('Fix the widget')).not.toBeNull();
			expect(within(primary).getByText('Completed')).not.toBeNull();

			// The title reads as the dominant text and wraps rather than truncating.
			const title = within(primary).getByText('Fix the widget');
			expect(title.className).toContain('break-words');
			expect(title.className).not.toContain('truncate');

			// Reference details (Duration, Model, Tokens) sit in the footer, not the
			// primary line — no field is dropped, just de-emphasized.
			expect(within(footer).getByText(/claude-opus-4-8/)).not.toBeNull();
			expect(within(footer).getByText('5m 0s')).not.toBeNull(); // 300000ms
			expect(within(footer).getByText('1k / 500')).not.toBeNull(); // tokens
		});

		it('surfaces Phase, Started and Project as secondary metadata', () => {
			renderTable(
				<RunsTable
					runs={[baseRun]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);
			const card = screen.getByTestId('run-card');
			// `formatPhase` lower-cases; the card only capitalizes it via CSS.
			expect(within(card).getByText('implementation')).not.toBeNull();
			expect(within(card).getByText('Acme')).not.toBeNull();
		});

		it('omits Project from the card when showProject is false', () => {
			renderTable(
				<RunsTable
					runs={[baseRun]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
					showProject={false}
				/>,
			);
			const card = screen.getByTestId('run-card');
			expect(within(card).queryByText('Acme')).toBeNull();
			// The priority fields still read.
			expect(within(card).getByText('Fix the widget')).not.toBeNull();
			expect(within(card).getByText('Completed')).not.toBeNull();
			expect(within(card).getByText('implementation')).not.toBeNull();
		});

		it('navigates to the run detail when the whole card is tapped or activated by keyboard', () => {
			renderTable(
				<RunsTable
					runs={[baseRun]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);
			const card = screen.getByTestId('run-card');
			fireEvent.click(card);
			expect(navigate).toHaveBeenCalledWith({ to: '/runs/run-1' });

			navigate.mockClear();
			fireEvent.keyDown(card, { key: 'Enter' });
			expect(navigate).toHaveBeenCalledWith({ to: '/runs/run-1' });
		});

		it('does not navigate when an in-card work-item link is clicked', () => {
			renderTable(
				<RunsTable
					runs={[baseRun]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);
			const card = screen.getByTestId('run-card');
			const link = within(card).getByRole('link');
			expect(link.getAttribute('href')).toBe(baseRun.workItemUrl);
			fireEvent.click(link);
			expect(navigate).not.toHaveBeenCalled();
		});

		it('does not navigate and does not prevent default when Enter is pressed on an in-card work-item link', () => {
			renderTable(
				<RunsTable
					runs={[baseRun]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);
			const card = screen.getByTestId('run-card');
			const link = within(card).getByRole('link');
			expect(link.getAttribute('href')).toBe(baseRun.workItemUrl);

			const event = createEvent.keyDown(link, { key: 'Enter' });
			fireEvent(link, event);

			expect(navigate).not.toHaveBeenCalled();
			expect(event.defaultPrevented).toBe(false);
		});

		it('does not navigate and does not prevent default when Enter is pressed on an in-card PR link', () => {
			const prRun = {
				...baseRun,
				phase: 'review',
				prNumber: '42',
				prTitle: 'PR Title',
			};
			renderTable(
				<RunsTable
					runs={[prRun]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);
			const card = screen.getByTestId('run-card');
			const link = within(card).getByRole('link');
			expect(link.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/42');

			const event = createEvent.keyDown(link, { key: 'Enter' });
			fireEvent(link, event);

			expect(navigate).not.toHaveBeenCalled();
			expect(event.defaultPrevented).toBe(false);
		});
	});

	// issue #600 — a wall-clock kill is resumable, so it settles `deferred`; the
	// list still has to answer "which runs hit the timeout".
	describe('timed-out deferred runs', () => {
		const timedOutRun: RunRow = {
			...baseRun,
			status: 'deferred',
			timedOut: true,
			exitCode: 124,
			completedAt: null,
		};

		it('surfaces the timeout in both the desktop row and the mobile card', () => {
			const { container } = renderTable(
				<RunsTable
					runs={[timedOutRun]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);

			const table = container.querySelector('table') as HTMLElement;
			expect(within(table).getByText('Timed out · retrying')).not.toBeNull();

			const card = screen.getByTestId('run-card');
			expect(within(card).getByText('Timed out · retrying')).not.toBeNull();
			expect(within(card).queryByText('Deferred')).toBeNull();
		});

		it('leaves a run deferred for any other reason reading as plain "Deferred"', () => {
			renderTable(
				<RunsTable
					runs={[{ ...timedOutRun, timedOut: false }]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);

			const card = screen.getByTestId('run-card');
			expect(within(card).getByText('Deferred')).not.toBeNull();
			expect(within(card).queryByText(/Timed out/)).toBeNull();
		});
	});

	// issue #523 — the machine a run is executing on, alongside its phase.
	describe('worker machine', () => {
		const onWorker: RunRow = { ...baseRun, workerId: 'worker-a', workerName: 'studio-mac' };

		it('adds the machine name as a second, subordinate line in the desktop Phase cell', () => {
			const { container } = renderTable(
				<RunsTable
					runs={[onWorker]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);

			const table = container.querySelector('table') as HTMLElement;
			const phaseCell = within(table).getAllByRole('row')[1].querySelectorAll('td')[0];
			// The phase still leads the cell; the machine reads below it.
			expect(phaseCell.textContent).toBe('implementationstudio-mac');

			const machine = within(phaseCell as HTMLElement).getByTestId('run-worker-name');
			expect(machine.className).toContain('block');
			// Visually less prominent than the phase: smaller, muted, not bolded.
			expect(machine.className).toContain('text-xs');
			expect(machine.className).toContain('text-zinc-500');
			expect(machine.className).toContain('font-normal');
			// A long machine name must not stretch the fixed-width Phase column.
			expect(machine.className).toContain('truncate');
			expect(machine.getAttribute('title')).toBe('studio-mac');
		});

		it('leaves the desktop Phase cell as the phase alone when no worker is recorded', () => {
			const { container } = renderTable(
				<RunsTable
					runs={[baseRun]}
					totalCount={1}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);

			const table = container.querySelector('table') as HTMLElement;
			const phaseCell = within(table).getAllByRole('row')[1].querySelectorAll('td')[0];
			expect(phaseCell.textContent).toBe('implementation');
			expect(within(phaseCell as HTMLElement).queryByTestId('run-worker-name')).toBeNull();
		});

		it('names the machine in the card metadata line only for a run that recorded one', () => {
			renderTable(
				<RunsTable
					runs={[onWorker, { ...baseRun, id: 'run-2' }]}
					totalCount={2}
					currentPage={1}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);

			const [withWorker, withoutWorker] = screen.getAllByTestId('run-card');
			expect(within(withWorker).getByTestId('run-worker-name').textContent).toBe('studio-mac');
			expect(within(withoutWorker).queryByTestId('run-worker-name')).toBeNull();
			// The existing phase metadata is untouched either way.
			expect(within(withWorker).getByText('implementation')).not.toBeNull();
			expect(within(withoutWorker).getByText('implementation')).not.toBeNull();
		});
	});

	describe('pagination footer', () => {
		it('stacks on mobile and returns to a row on desktop', () => {
			renderTable(
				<RunsTable
					runs={[baseRun]}
					totalCount={100}
					currentPage={2}
					pageSize={25}
					onPageChange={vi.fn()}
				/>,
			);

			const footer = screen.getByText(/Showing/).closest('div')?.parentElement;
			expect(footer?.className).toContain('flex-col');
			expect(footer?.className).toContain('sm:flex-row');
			expect(footer?.className).toContain('sm:justify-between');
		});

		it('still drives pagination via onPageChange', () => {
			const onPageChange = vi.fn();
			renderTable(
				<RunsTable
					runs={[baseRun]}
					totalCount={100}
					currentPage={2}
					pageSize={25}
					onPageChange={onPageChange}
				/>,
			);

			fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
			expect(onPageChange).toHaveBeenCalledWith(1);

			fireEvent.click(screen.getByRole('button', { name: 'Next' }));
			expect(onPageChange).toHaveBeenCalledWith(3);
		});
	});
});
