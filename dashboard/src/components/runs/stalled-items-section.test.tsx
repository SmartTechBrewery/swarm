// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StalledItem } from '@/types/runs.js';

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

import { StalledItemsSection } from './stalled-items-section.js';

const HOUR_MS = 60 * 60 * 1000;

/** An ISO instant `hours` in the past, so `formatRelativeTime` reads deterministically. */
function hoursAgo(hours: number): string {
	return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

function pullRequestItem(overrides: Partial<StalledItem> = {}): StalledItem {
	return {
		projectId: 'proj-a',
		repository: 'acme/widgets',
		unit: 'pull-request',
		reference: '92',
		taskId: '92-respond',
		phase: 'respond-to-review',
		runId: 'run-1',
		runStatus: 'completed',
		prNumber: '92',
		prUrl: 'https://github.com/acme/widgets/pull/92',
		prTitle: 'Add the widget',
		lastActivityAt: hoursAgo(3),
		stalledForMs: 3 * HOUR_MS,
		...overrides,
	};
}

function workItem(overrides: Partial<StalledItem> = {}): StalledItem {
	return {
		projectId: 'proj-a',
		repository: 'acme/widgets',
		unit: 'work-item',
		reference: '85',
		taskId: '85',
		phase: 'implementation',
		runId: 'run-2',
		runStatus: 'completed',
		workItemId: 'PVTI_abc',
		workItemTitle: 'Fix the widget',
		workItemUrl: 'https://github.com/acme/widgets/issues/85',
		lastActivityAt: hoursAgo(9),
		stalledForMs: 9 * HOUR_MS,
		...overrides,
	};
}

const project = { id: 'proj-a', name: 'Acme', repo: 'acme/widgets' };

// Seed the `projects.list` cache so rows resolve the project name synchronously.
// `staleTime: Infinity` keeps the mocked queryFn from clobbering the seed.
function renderSection(ui: ReactElement, projects: unknown[] = [project]) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	queryClient.setQueryData(['projects.list'], projects);
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function rows() {
	return screen.getAllByTestId('stalled-item-row');
}

describe('StalledItemsSection', () => {
	// The section must add nothing at all to a healthy installation — not a header,
	// not a count, not an empty state.
	it('renders nothing at all when nothing is stalled', () => {
		const { container } = renderSection(<StalledItemsSection items={[]} />);
		expect(container.firstChild).toBeNull();
		expect(screen.queryByTestId('stalled-items-section')).toBeNull();
		expect(screen.queryByText(/Stalled/)).toBeNull();
	});

	it('describes a stalled pull request by its PR reference, phase, and last movement', () => {
		renderSection(<StalledItemsSection items={[pullRequestItem()]} />);
		const [row] = rows();

		expect(within(row).getByText('Add the widget')).not.toBeNull();
		const link = within(row).getByRole('link', { name: /PR #92/ });
		expect(link.getAttribute('href')).toBe('https://github.com/acme/widgets/pull/92');
		expect(within(row).getByText('Respond to review')).not.toBeNull();
		expect(within(row).getByText('3h ago')).not.toBeNull();
	});

	// The link is the server's, spelled in the project's own provider's grammar
	// (`SCMProvider.pullRequestUrl`): a GitLab merge request lives at
	// `/-/merge_requests/<n>` and a Bitbucket pull request at `/pull-requests/<n>`,
	// so a client-derived `github.com/<repo>/pull/<n>` would point at a repository
	// that need not even exist.
	it.each([
		[
			'gitlab',
			'https://gitlab.com/team/app/-/merge_requests/42',
			{ repository: 'team/app', reference: '42', prNumber: '42' },
		],
		[
			'bitbucket',
			'https://bitbucket.org/team/app/pull-requests/42',
			{ repository: 'team/app', reference: '42', prNumber: '42' },
		],
	])('links a stalled %s pull request to its provider-resolved URL', (_provider, prUrl, fields) => {
		renderSection(<StalledItemsSection items={[pullRequestItem({ ...fields, prUrl })]} />);

		const link = within(rows()[0]).getByRole('link', { name: /PR #42/ });
		expect(link.getAttribute('href')).toBe(prUrl);
	});

	// The mobile card renders through the same helpers, so it must resolve the same
	// link rather than falling back to a derived one.
	it('links the mobile card to the same provider-resolved URL', () => {
		const prUrl = 'https://gitlab.com/team/app/-/merge_requests/42';
		renderSection(
			<StalledItemsSection
				items={[pullRequestItem({ repository: 'team/app', prNumber: '42', prUrl })]}
			/>,
		);

		const card = screen.getAllByTestId('stalled-item-card')[0];
		expect(
			within(card)
				.getByRole('link', { name: /PR #42/ })
				.getAttribute('href'),
		).toBe(prUrl);
	});

	// Relative on the face, absolute on hover — an operator triaging a stall needs
	// the exact instant without leaving the list.
	it('carries the absolute last-moved instant as the hover title', () => {
		const item = pullRequestItem();
		renderSection(<StalledItemsSection items={[item]} />);
		const stopped = within(rows()[0]).getByText('3h ago');
		expect(stopped.getAttribute('title')).toBe(new Date(item.lastActivityAt).toLocaleString());
	});

	it('links a stalled board card out to its work item', () => {
		renderSection(<StalledItemsSection items={[workItem()]} />);
		const [row] = rows();

		expect(within(row).getByText('Fix the widget')).not.toBeNull();
		const link = within(row).getByRole('link', { name: /Issue: #85/ });
		expect(link.getAttribute('href')).toBe('https://github.com/acme/widgets/issues/85');
		expect(within(row).getByText('Implementation')).not.toBeNull();
	});

	// A card whose URL never resolved still has to be named — as text, not as an
	// anchor pointing nowhere.
	it('renders a board card with no resolved URL as plain text rather than a dead link', () => {
		renderSection(<StalledItemsSection items={[workItem({ workItemUrl: undefined })]} />);
		const [row] = rows();

		expect(within(row).queryByRole('link')).toBeNull();
		expect(within(row).getByText('Issue: #85')).not.toBeNull();
	});

	// The server orders longest-silent first; the client must render that order
	// verbatim rather than deriving one of its own.
	it('preserves the server order even when it is not the client-visible one', () => {
		const longest = workItem({ reference: '85', stalledForMs: 9 * HOUR_MS });
		const shorter = pullRequestItem({ reference: '92', stalledForMs: 3 * HOUR_MS });
		// Deliberately handed over shortest-first: the component must not re-sort.
		renderSection(<StalledItemsSection items={[shorter, longest]} />);

		const rendered = rows().map((row) => row.textContent ?? '');
		expect(rendered[0]).toContain('Add the widget');
		expect(rendered[1]).toContain('Fix the widget');
	});

	it('shows the project and repository on the cross-project screen', () => {
		renderSection(<StalledItemsSection items={[pullRequestItem()]} />);
		const section = screen.getByTestId('stalled-items-section');

		expect(within(section).getByText('Project')).not.toBeNull();
		expect(within(rows()[0]).getByText('Acme')).not.toBeNull();
		expect(within(rows()[0]).getByText('acme/widgets')).not.toBeNull();
	});

	it('drops the project column on the project-scoped panel', () => {
		renderSection(<StalledItemsSection items={[pullRequestItem()]} showProject={false} />);
		const section = screen.getByTestId('stalled-items-section');

		expect(within(section).queryByText('Project')).toBeNull();
		expect(within(section).queryByText('Acme')).toBeNull();
	});

	// Expanded by default so a stall is noticed without being looked for, but a
	// long list can still be folded away.
	it('starts expanded and folds away on toggle', () => {
		renderSection(<StalledItemsSection items={[pullRequestItem(), workItem()]} />);
		const toggle = screen.getByRole('button', { name: /Stalled/ });
		expect(toggle.getAttribute('aria-expanded')).toBe('true');
		expect(rows()).toHaveLength(2);

		fireEvent.click(toggle);

		expect(toggle.getAttribute('aria-expanded')).toBe('false');
		expect(screen.queryAllByTestId('stalled-item-row')).toHaveLength(0);
		// The header keeps the count, so a folded section still says how much is stalled.
		expect(within(screen.getByTestId('stalled-items-section')).getByText('(2)')).not.toBeNull();
	});

	// The mobile presentation carries the same facts through the same helpers, so
	// the two cannot drift.
	it('renders a card per item below md and the table only from md', () => {
		const { container } = renderSection(<StalledItemsSection items={[pullRequestItem()]} />);

		const cards = screen.getAllByTestId('stalled-item-card');
		expect(cards).toHaveLength(1);
		expect(within(cards[0]).getByText('Respond to review')).not.toBeNull();
		expect(within(cards[0]).getByText('3h ago')).not.toBeNull();

		expect(container.querySelector('.md\\:hidden')).not.toBeNull();
		expect(container.querySelector('.hidden.md\\:block')).not.toBeNull();
	});
});
