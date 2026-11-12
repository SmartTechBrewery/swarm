// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { WipTicket, WipUsageEntry } from '@/types/runs.js';

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

	// Issue #1379: a review-cap stop records no run, so the ticket links to the capped
	// Review run that hosts Force re-review, whatever ran since.
	it('links a review-cap stop to the Review run that carries Force re-review', () => {
		renderSection(
			<WipUsageSection
				entries={[
					makeEntry({
						inFlight: 2,
						tickets: [
							makeTicket({
								state: 'waiting-on-operator',
								operatorReason: 'review-cap-reached',
								actionRunId: 'run-review',
								phase: 'resolve-conflicts',
								prNumber: '120',
							}),
							makeTicket({
								taskId: '104',
								state: 'waiting-on-operator',
								operatorReason: 'stalled',
							}),
						],
					}),
				]}
			/>,
		);

		const [capped, stalled] = screen.getAllByTestId('wip-ticket');
		if (!capped || !stalled) throw new Error('unreachable');
		expect(within(capped).getByText('Waiting on you')).toBeDefined();
		expect(within(capped).getByText('review cap reached — needs a person')).toBeDefined();
		expect(within(capped).getByText('Stopped after Review')).toBeDefined();
		expect(
			within(capped)
				.getByRole('link', { name: 'Open review run to Force re-review' })
				.getAttribute('href'),
		).toBe('/runs/run-review');
		expect(within(stalled).queryByRole('link', { name: /Force re-review/ })).toBeNull();
	});

	// Issue #1428: a waiting holder says what Resolve problem's attempt on its current
	// situation concluded, and links the attempt run.
	it('shows the Resolve problem attempt on a waiting holder, per state', () => {
		const message =
			'Resolve problem could not resolve the stuck ticket: the branch is gone. Tried: no recovery action.';
		renderSection(
			<WipUsageSection
				entries={[
					makeEntry({
						inFlight: 4,
						limit: 4,
						tickets: [
							makeTicket({
								taskId: '101',
								state: 'waiting-on-operator',
								operatorReason: 'stalled',
								resolveProblem: { state: 'queued', at: '2026-11-12T08:00:00Z' },
							}),
							makeTicket({
								taskId: '102',
								state: 'waiting-on-operator',
								operatorReason: 'stalled',
								resolveProblem: {
									runId: 'attempt-running',
									state: 'running',
									at: '2026-11-12T08:00:00Z',
								},
							}),
							makeTicket({
								taskId: '103',
								state: 'waiting-on-operator',
								operatorReason: 'failed',
								resolveProblem: {
									runId: 'attempt-resolved',
									state: 'resolved',
									at: '2026-11-12T08:00:00Z',
								},
							}),
							makeTicket({
								taskId: '104',
								state: 'waiting-on-operator',
								operatorReason: 'failed',
								resolveProblem: {
									runId: 'attempt-unresolved',
									state: 'unresolved',
									message,
									at: '2026-11-12T08:00:00Z',
								},
							}),
						],
					}),
				]}
			/>,
		);

		const [queued, running, resolved, unresolved] = screen.getAllByTestId('wip-resolve-problem');
		if (!queued || !running || !resolved || !unresolved) throw new Error('unreachable');
		expect(within(queued).getByText('Resolve problem: attempt queued')).toBeDefined();
		expect(within(queued).queryByRole('link')).toBeNull();
		expect(within(running).getByText('Resolve problem: attempt running')).toBeDefined();
		expect(
			within(running).getByRole('link', { name: 'Open attempt run' }).getAttribute('href'),
		).toBe('/runs/attempt-running');
		expect(within(resolved).getByText('Resolve problem: resolved it')).toBeDefined();
		expect(within(unresolved).getByText('Resolve problem: could not resolve it')).toBeDefined();
		expect(within(unresolved).getByText(message).getAttribute('title')).toBe(message);
		expect(
			within(unresolved).getByRole('link', { name: 'Open attempt run' }).getAttribute('href'),
		).toBe('/runs/attempt-unresolved');
	});

	it('shows no Resolve problem line without an attempt', () => {
		renderSection(
			<WipUsageSection
				entries={[
					makeEntry({
						tickets: [makeTicket({ state: 'waiting-on-operator', operatorReason: 'stalled' })],
					}),
				]}
			/>,
		);
		expect(screen.queryByTestId('wip-resolve-problem')).toBeNull();
	});

	it('names the board move that restarts a terminated run (issue #1361)', () => {
		renderSection(
			<WipUsageSection
				entries={[
					makeEntry({
						tickets: [
							makeTicket({
								state: 'waiting-on-operator',
								operatorReason: 'terminated',
								phase: 'implementation',
							}),
						],
					}),
				]}
			/>,
		);

		const ticket = screen.getByTestId('wip-ticket');
		expect(within(ticket).getByText('Waiting on you')).toBeDefined();
		expect(
			within(ticket).getByText(
				'run terminated — move the card out of its start column and back to start a new run',
			),
		).toBeDefined();
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
