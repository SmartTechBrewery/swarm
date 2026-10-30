// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { WipTicket, WipUsageEntry } from '@/types/runs.js';

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
	},
}));

import { WipUsageSection } from './wip-usage-section.js';

function renderSection(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function makeTicket(overrides: Partial<WipTicket> = {}): WipTicket {
	return {
		taskId: '103',
		workItemId: 'item-103',
		workItemTitle: 'Add widgets',
		workItemUrl: 'https://github.com/acme/widgets/issues/103',
		openedPhase: 'planning',
		openedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
		state: 'running',
		phase: 'planning',
		...overrides,
	};
}

function makeEntry(overrides: Partial<WipUsageEntry> = {}): WipUsageEntry {
	return {
		projectId: 'p1',
		repository: 'acme/widgets',
		limit: 2,
		inFlight: 1,
		waiting: 0,
		tickets: [makeTicket()],
		...overrides,
	};
}

describe('WipUsageSection', () => {
	it('renders nothing when no repository holds a slot or a waiter', () => {
		const { container } = renderSection(<WipUsageSection entries={[]} />);
		expect(container.innerHTML).toBe('');
	});

	// Issue #1204: headed like Queued — a plain title with a muted count of the tickets
	// holding a slot — and no panel around the per-repository cards.
	it('is headed "Tickets in progress" with the count of slot holders, outside any panel', () => {
		renderSection(
			<WipUsageSection
				entries={[
					makeEntry({ inFlight: 2, tickets: [makeTicket(), makeTicket({ taskId: '104' })] }),
					makeEntry({ repository: 'acme/other' }),
				]}
			/>,
		);

		const heading = screen.getByRole('heading', { level: 2 });
		expect(heading.textContent).toBe('Tickets in progress (3)');
		expect(heading.querySelector('svg')).not.toBeNull();
		expect(screen.getByTestId('wip-usage-section').className).not.toMatch(/\bborder\b/);
		for (const repository of screen.getAllByTestId('wip-repository')) {
			expect(repository.className).toMatch(/\bborder\b/);
		}
	});

	it('names each repository with its in flight / limit and its waiting count', () => {
		renderSection(
			<WipUsageSection
				entries={[
					makeEntry({
						inFlight: 2,
						waiting: 3,
						tickets: [makeTicket(), makeTicket({ taskId: '104' })],
					}),
					makeEntry({ repository: 'acme/other', inFlight: 1, limit: 1 }),
				]}
			/>,
		);

		const [first, second] = screen.getAllByTestId('wip-repository');
		if (!first || !second) throw new Error('expected two repositories');
		expect(within(first).getByText('acme/widgets')).toBeDefined();
		expect(within(first).getByText('2 / 2 in flight')).toBeDefined();
		expect(within(first).getByText('3 waiting')).toBeDefined();
		expect(within(first).getAllByTestId('wip-ticket')).toHaveLength(2);
		expect(within(second).getByText('1 / 1 in flight')).toBeDefined();
		// No waiters, no count.
		expect(within(second).queryByText(/waiting$/)).toBeNull();
	});

	it("shows a holder waiting on the operator with a 'waiting on you' badge and its reason", () => {
		renderSection(
			<WipUsageSection
				entries={[
					makeEntry({
						tickets: [
							makeTicket({
								state: 'waiting-on-operator',
								operatorReason: 'approved-awaiting-merge',
								phase: 'review',
								prNumber: '120',
								prUrl: 'https://gitlab.com/acme/widgets/-/merge_requests/120',
							}),
						],
					}),
				]}
			/>,
		);

		const ticket = screen.getByTestId('wip-ticket');
		expect(within(ticket).getByText('Waiting on you')).toBeDefined();
		expect(within(ticket).getByText('approved — waiting for you to merge')).toBeDefined();
		expect(within(ticket).getByText('Add widgets')).toBeDefined();
		expect(
			within(ticket)
				.getByRole('link', { name: /PR #120/ })
				.getAttribute('href'),
		).toBe('https://gitlab.com/acme/widgets/-/merge_requests/120');
		expect(screen.getByText('(1 waiting on you)')).toBeDefined();
	});

	it('gives a running holder or one waiting on the pipeline no badge', () => {
		renderSection(
			<WipUsageSection
				entries={[
					makeEntry({
						tickets: [makeTicket(), makeTicket({ taskId: '104', state: 'waiting-on-pipeline' })],
					}),
				]}
			/>,
		);

		expect(screen.queryByText('Waiting on you')).toBeNull();
		expect(screen.getByText('Planning running')).toBeDefined();
		expect(screen.getByText('Waiting on the pipeline after Planning')).toBeDefined();
	});

	it('names a Review waiting for CI as the pipeline’s wait, not the operator’s (issue #1203)', () => {
		renderSection(
			<WipUsageSection
				entries={[
					makeEntry({
						tickets: [
							makeTicket({
								state: 'waiting-on-pipeline',
								pipelineReason: 'waiting-for-checks',
								phase: 'review',
								prNumber: '120',
							}),
						],
					}),
				]}
			/>,
		);

		const ticket = screen.getByTestId('wip-ticket');
		expect(within(ticket).getByText('Waiting on the pipeline after Review')).toBeDefined();
		expect(
			within(ticket).getByText('Waiting for CI — Review starts when the checks finish'),
		).toBeDefined();
		expect(screen.queryByText('Waiting on you')).toBeNull();
	});

	it('explains a repository with waiters but no holders', () => {
		renderSection(
			<WipUsageSection entries={[makeEntry({ inFlight: 0, waiting: 1, tickets: [] })]} />,
		);

		expect(screen.getByText('0 / 2 in flight')).toBeDefined();
		expect(screen.getByText(/No ticket holds a slot/)).toBeDefined();
	});

	it('folds away', () => {
		renderSection(<WipUsageSection entries={[makeEntry()]} />);

		fireEvent.click(screen.getByRole('button', { name: /Tickets in progress/ }));

		expect(screen.queryByTestId('wip-repository')).toBeNull();
	});
});
