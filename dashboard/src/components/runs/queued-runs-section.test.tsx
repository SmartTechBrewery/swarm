// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { QueuedRun } from '@/types/runs.js';

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		runs: {
			putBack: {
				mutate: vi.fn(),
			},
		},
	},
	trpc: {
		projects: {
			list: {
				queryOptions: () => ({
					queryKey: ['projects.list'],
					queryFn: () => Promise.resolve([]),
				}),
			},
		},
		runs: {
			queued: {
				queryKey: () => ['runs.queued'],
			},
			list: {
				queryOptions: () => ({
					queryKey: ['runs.list'],
					queryFn: () => Promise.resolve({ data: [], total: 0 }),
				}),
			},
		},
	},
}));

import { trpcClient } from '@/lib/trpc.js';
import { QueuedRunsSection } from './queued-runs-section.js';
import { RunStatusBadge } from './run-status-badge.js';

const githubItem: QueuedRun = {
	jobId: 'job-1',
	projectId: 'proj-a',
	type: 'scm',
	providerId: 'github',
	state: 'waiting',
	phaseHint: 'review',
	repo: 'acme/widgets',
	prNumber: '42',
	priority: 0,
	enqueuedAt: '2026-07-17T10:00:00.000Z',
	availableAt: '2026-07-17T10:00:00.000Z',
};

const boardItem: QueuedRun = {
	jobId: 'job-2',
	projectId: 'proj-a',
	type: 'pm',
	state: 'delayed',
	phaseHint: 'board',
	workItemNodeId: 'PVTI_lADODb1Ycc4Bcnwuzabc123',
	contentType: 'Issue',
	workItemTitle: 'Fix the widget',
	workItemUrl: 'https://github.com/acme/widgets/issues/42',
	priority: 5,
	// Enqueued *earlier* than the github item on purpose (see the ordering test).
	enqueuedAt: '2026-07-17T09:00:00.000Z',
	availableAt: '2026-07-17T09:00:00.000Z',
	runsAt: '2026-07-17T12:00:00.000Z',
};

const project = { id: 'proj-a', name: 'Acme', repo: 'acme/widgets' };

// Seed the `projects.list` cache so queued cards/rows can resolve the project
// name synchronously. `staleTime: Infinity` keeps the mocked queryFn from
// refetching and clobbering the seeded value mid-test.
function renderSection(
	ui: ReactElement,
	projects: unknown[] = [project],
	runningRuns: unknown[] = [],
) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	queryClient.setQueryData(['projects.list'], projects);
	// Seed the dedicated running-run lookup (issue #421) the component reads to
	// hide board rows that duplicate an in-progress run. `staleTime: Infinity`
	// plus the sub-second test lifetime keep the fixed refetchInterval from
	// clobbering this seed.
	queryClient.setQueryData(['runs.list'], { data: runningRuns, total: runningRuns.length });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

/** The mobile card list — the presentation this issue introduces (issue #381). */
function cards() {
	return screen.getAllByTestId('queued-run-card');
}

describe('QueuedRunsSection', () => {
	it('renders no section when there are no queued items', () => {
		const { container } = renderSection(<QueuedRunsSection items={[]} />);
		expect(container.firstChild).toBeNull();
		expect(screen.queryByTestId('queued-runs-section')).toBeNull();
	});

	// Issue #1204: the heading carries an icon, like every other Runs section heading.
	it('heads the section with an icon, the title and the muted count', () => {
		renderSection(<QueuedRunsSection items={[githubItem, boardItem]} />);

		const heading = screen.getByRole('heading', { level: 2 });
		expect(heading.textContent).toBe('Queued (2)');
		expect(heading.querySelector('svg')).not.toBeNull();
	});

	// Issue #1207: the heading folds the queue away, exactly like Tickets in progress.
	describe('folds from its heading (issue #1207)', () => {
		const toggle = () => screen.getByRole('button', { name: /^Queued/ });

		it('starts expanded, with the chevron pointing down', () => {
			const { container } = renderSection(<QueuedRunsSection items={[githubItem, boardItem]} />);

			expect(toggle().getAttribute('aria-expanded')).toBe('true');
			expect(toggle().querySelector('.lucide-chevron-down')).not.toBeNull();
			expect(cards()).toHaveLength(2);
			expect(container.querySelector('table')).not.toBeNull();
		});

		it('hides the cards and the table when collapsed, keeping the heading and its count', () => {
			const { container } = renderSection(<QueuedRunsSection items={[githubItem, boardItem]} />);

			fireEvent.click(toggle());

			expect(toggle().getAttribute('aria-expanded')).toBe('false');
			expect(toggle().querySelector('.lucide-chevron-right')).not.toBeNull();
			expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Queued (2)');
			expect(screen.queryByTestId('queued-run-card')).toBeNull();
			expect(container.querySelector('table')).toBeNull();
			expect(screen.queryByRole('button', { name: /Put back/i })).toBeNull();
		});

		it('brings the rows back, Put back included, when expanded again', () => {
			renderSection(<QueuedRunsSection items={[boardItem]} />);

			fireEvent.click(toggle());
			fireEvent.click(toggle());

			expect(toggle().getAttribute('aria-expanded')).toBe('true');
			fireEvent.click(within(cards()[0]).getByRole('button', { name: /Put back/i }));
			expect(screen.getByText('Put Back Work Item')).not.toBeNull();
		});

		// Deliberate: no-trigger dispatches are not queued work and must stay observable
		// (issue #570), so folding the queue leaves their own collapsed line reachable.
		it('leaves the no-trigger group reachable while the queue is collapsed', () => {
			renderSection(
				<QueuedRunsSection
					items={[githubItem]}
					noTriggerItems={[{ ...boardItem, jobId: 'job-no-trigger', boardOutcome: 'no-trigger' }]}
				/>,
			);

			fireEvent.click(toggle());
			expect(screen.queryByTestId('queued-run-card')).toBeNull();

			fireEvent.click(screen.getByRole('button', { name: /starts no phase/ }));
			expect(screen.getAllByTestId('queued-no-trigger-row')).toHaveLength(1);
		});
	});

	it('renders a card per item with the right phase label and Task reference', () => {
		renderSection(<QueuedRunsSection items={[githubItem, boardItem]} />);
		const [reviewCard, boardCard] = cards();

		expect(within(reviewCard).getByText('Review')).not.toBeNull();
		expect(within(reviewCard).getByText(/PR #42/)).not.toBeNull();

		expect(within(boardCard).getByText('Board (Planning/Impl)')).not.toBeNull();
		expect(within(boardCard).getByText('Fix the widget')).not.toBeNull();
		expect(within(boardCard).getByText('Issue: #42')).not.toBeNull();

		// The desktop table stays present (its Task header included).
		expect(within(screen.getByTestId('queued-runs-section')).getByText('Task')).not.toBeNull();
	});

	it('renders cards below md and the table only from md, without a horizontal-scroll crutch', () => {
		const { container } = renderSection(<QueuedRunsSection items={[githubItem]} />);

		const cardList = cards()[0].parentElement;
		expect(cardList?.className).toContain('md:hidden');

		const table = container.querySelector('table');
		const wrapper = table?.parentElement;
		expect(wrapper?.className).toContain('hidden');
		expect(wrapper?.className).toContain('md:block');
		expect(wrapper?.className).toContain('overflow-hidden');
		expect(wrapper?.className).not.toContain('overflow-x-auto');
		expect(table?.className).not.toContain('min-w-[48rem]');
		expect(table?.className).not.toContain('md:min-w-full');
	});

	it('preserves the server-provided order (no client-side re-sort)', () => {
		// Passed github-first even though the board item was enqueued earlier; a
		// client re-sort by enqueue time would swap them. Ordering is the server's.
		renderSection(<QueuedRunsSection items={[githubItem, boardItem]} />);
		const [first, second] = cards();

		expect(cards()).toHaveLength(2);
		expect(within(first).getByText(/PR #42/)).not.toBeNull();
		expect(within(second).getByText('Issue: #42')).not.toBeNull();
	});

	it('shows when a delayed item will run', () => {
		renderSection(<QueuedRunsSection items={[boardItem]} />);
		expect(within(cards()[0]).getByText(/runs/)).not.toBeNull();
	});

	it('links a queued retry to its existing run detail', () => {
		const deferredItem: QueuedRun = { ...githubItem, runId: 'run-deferred' };
		renderSection(<QueuedRunsSection items={[deferredItem]} />);

		expect(within(cards()[0]).getByRole('link', { name: 'View run' }).getAttribute('href')).toBe(
			'/runs/run-deferred',
		);
	});

	it('does not offer View run for fresh queued work without a run ID', () => {
		renderSection(<QueuedRunsSection items={[githubItem]} />);
		expect(within(cards()[0]).queryByRole('link', { name: 'View run' })).toBeNull();
	});

	it('shows a Queued badge that is visually distinct from a running badge (no pulse)', () => {
		renderSection(
			<>
				<QueuedRunsSection items={[githubItem]} />
				<RunStatusBadge status="running" />
			</>,
		);

		// Both presentations render a Queued badge; none of them may pulse.
		const queuedBadges = screen
			.getAllByText('Queued')
			.filter((el) => el.className.includes('rounded'));
		expect(queuedBadges.length).toBeGreaterThanOrEqual(1);
		for (const badge of queuedBadges) {
			expect(badge.querySelector('span')?.className).not.toContain('animate-pulse');
		}

		const runningDot = screen.getByText('Running').querySelector('span');
		expect(runningDot?.className).toContain('animate-pulse');
	});

	it('hides the Put back action for unlinked items (no workItemNodeId)', () => {
		const unlinkedItem: QueuedRun = {
			...boardItem,
			workItemNodeId: undefined,
		};
		renderSection(<QueuedRunsSection items={[unlinkedItem]} />);
		expect(screen.queryByRole('button', { name: /Put back/i })).toBeNull();
	});

	it('hides the Put back action for unsupported phases (e.g. respond-to-review)', () => {
		const unsupportedItem: QueuedRun = {
			...boardItem,
			phaseHint: 'respond-to-review',
		};
		renderSection(<QueuedRunsSection items={[unsupportedItem]} />);
		expect(screen.queryByRole('button', { name: /Put back/i })).toBeNull();
	});

	it('shows Put back action in the card and opens confirmation modal on click', () => {
		renderSection(<QueuedRunsSection items={[boardItem]} />);

		const putBackBtn = within(cards()[0]).getByRole('button', { name: /Put back/i });
		expect(putBackBtn).not.toBeNull();

		fireEvent.click(putBackBtn);

		expect(screen.getByText('Put Back Work Item')).not.toBeNull();
		expect(
			screen.getByText(/Are you sure you want to put this queued work item back\?/),
		).not.toBeNull();
	});

	// Issue #1087: a row blocked on an unfinished prerequisite says so, and links the
	// blocker — a bare `#11` may belong to another repository than the row's.
	it('names and links the blocker of a dependency wait instead of claiming to wait on checks', () => {
		const blocked: QueuedRun = {
			...boardItem,
			jobId: 'job-dependency',
			waitReason: 'dependency',
			blockers: [{ reference: '#11', url: 'https://github.com/acme/mobile/issues/11' }],
		};
		renderSection(<QueuedRunsSection items={[blocked]} />);

		const card = cards()[0];
		expect(card.textContent).toContain('waiting for #11 to be done');
		expect(card.textContent).not.toMatch(/checks to settle/);
		expect(within(card).getByRole('link', { name: '#11' }).getAttribute('href')).toBe(
			'https://github.com/acme/mobile/issues/11',
		);
	});

	it('names a blocker the server gave no linkable url as text, not a link', () => {
		const blocked: QueuedRun = {
			...boardItem,
			jobId: 'job-dependency-no-url',
			waitReason: 'dependency',
			blockers: [
				{ reference: '#11' },
				{ reference: '#12', url: 'https://github.com/acme/mobile/issues/12' },
			],
		};
		renderSection(<QueuedRunsSection items={[blocked]} />);

		const card = cards()[0];
		expect(card.textContent).toContain('waiting for #11 and #12 to be done');
		expect(within(card).queryByRole('link', { name: '#11' })).toBeNull();
		expect(within(card).getByRole('link', { name: '#12' }).getAttribute('href')).toBe(
			'https://github.com/acme/mobile/issues/12',
		);
	});

	describe('review-gate grouping (issue #275)', () => {
		// A fixed Respond-to-review push enqueues both SWARM's synthetic
		// `checks` follow-up and the provider's real pull-request-update
		// webhook for the same PR/SHA — the exact duplicate the grouping folds
		// into one row instead of two apparent "Review" rows.
		const followUpItem: QueuedRun = {
			...githubItem,
			jobId: 'job-followup',
			reviewGate: { sourceEvent: 'checks', sourceAction: 'completed', headSha: 'sha-fix' },
		};
		const prUpdatedItem: QueuedRun = {
			...githubItem,
			jobId: 'job-pr-updated',
			enqueuedAt: '2026-07-17T10:00:05.000Z',
			reviewGate: { sourceEvent: 'pull-request', sourceAction: 'updated', headSha: 'sha-fix' },
		};

		it('renders duplicate review-gate jobs for the same PR/SHA as one card with gate wording and diagnostics', () => {
			renderSection(<QueuedRunsSection items={[followUpItem, prUpdatedItem]} />);
			const section = screen.getByTestId('queued-runs-section');

			expect(cards()).toHaveLength(1);
			const card = cards()[0];
			expect(within(section).queryByText('Review')).toBeNull();
			expect(within(card).getByText('Awaiting review decision/checks')).not.toBeNull();
			expect(within(card).getByText('2 source events')).not.toBeNull();
			expect(within(card).getByText('Checks · completed')).not.toBeNull();
			expect(within(card).getByText('Pull request · updated')).not.toBeNull();
		});

		it('does not group review-gate jobs for a different PR or head SHA', () => {
			const otherSha: QueuedRun = {
				...githubItem,
				jobId: 'job-other-sha',
				reviewGate: { sourceEvent: 'pull-request', sourceAction: 'opened', headSha: 'sha-other' },
			};
			renderSection(<QueuedRunsSection items={[followUpItem, otherSha]} />);
			const section = screen.getByTestId('queued-runs-section');

			expect(cards()).toHaveLength(2);
			expect(within(section).queryByText('Awaiting review decision/checks')).toBeNull();
		});

		it('still renders an ordinary (non-review-gate) queued job one-to-one alongside a grouped card', () => {
			renderSection(<QueuedRunsSection items={[followUpItem, prUpdatedItem, boardItem]} />);

			expect(cards()).toHaveLength(2);
			expect(within(cards()[1]).getByText('Board (Planning/Impl)')).not.toBeNull();
		});

		it('ties Put back to the retained representative job (the first source event)', async () => {
			const groupedBoardFollowUp: QueuedRun = {
				...boardItem,
				jobId: 'job-board-followup',
				type: 'scm',
				providerId: 'github',
				repo: 'acme/widgets',
				prNumber: '42',
				reviewGate: { sourceEvent: 'checks', sourceAction: 'completed', headSha: 'sha-fix' },
			};
			const groupedBoardSync: QueuedRun = {
				...groupedBoardFollowUp,
				jobId: 'job-board-sync',
				reviewGate: {
					sourceEvent: 'pull-request',
					sourceAction: 'updated',
					headSha: 'sha-fix',
				},
			};
			renderSection(<QueuedRunsSection items={[groupedBoardFollowUp, groupedBoardSync]} />);

			fireEvent.click(within(cards()[0]).getByRole('button', { name: /Put back/i }));
			fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

			await waitFor(() =>
				expect(trpcClient.runs.putBack.mutate).toHaveBeenCalledWith({
					jobId: 'job-board-followup',
					projectId: groupedBoardFollowUp.projectId,
				}),
			);
		});

		it('includes Project on mobile cards when showProject is true', () => {
			renderSection(<QueuedRunsSection items={[githubItem]} showProject={true} />);
			const card = cards()[0];
			expect(within(card).getByText('Project:')).not.toBeNull();
			expect(within(card).getByText('Acme')).not.toBeNull();
		});

		it('omits Project from mobile cards when showProject is false', () => {
			renderSection(<QueuedRunsSection items={[githubItem]} showProject={false} />);
			const card = cards()[0];
			expect(within(card).queryByText('Project:')).toBeNull();
			expect(within(card).queryByText('Acme')).toBeNull();
		});
	});

	// Issue #421: a claimed board dispatch becomes a run in the Runs table while a
	// leftover sibling dispatch for the same card lingers in the queue. The section
	// hides the fresh board row when a running planning/implementation run shares
	// its backing work-item URL.
	describe('hides board rows duplicating an in-progress run (issue #421)', () => {
		const runningBoardRun = (overrides: Record<string, unknown> = {}) => ({
			phase: 'planning',
			workItemUrl: boardItem.workItemUrl,
			...overrides,
		});

		it('hides the board card when a running planning run shares its work-item URL', () => {
			const { container } = renderSection(
				<QueuedRunsSection items={[boardItem]} />,
				[project],
				[runningBoardRun()],
			);
			expect(screen.queryByTestId('queued-run-card')).toBeNull();
			expect(container.firstChild).toBeNull();
		});

		it('hides the board card when a running implementation run shares its URL', () => {
			renderSection(
				<QueuedRunsSection items={[boardItem]} />,
				[project],
				[runningBoardRun({ phase: 'implementation' })],
			);
			expect(screen.queryByTestId('queued-run-card')).toBeNull();
		});

		it('keeps the board card when the running run URL does not match', () => {
			renderSection(
				<QueuedRunsSection items={[boardItem]} />,
				[project],
				[runningBoardRun({ workItemUrl: 'https://github.com/acme/widgets/issues/99' })],
			);
			expect(cards()).toHaveLength(1);
			expect(within(cards()[0]).getByText('Fix the widget')).not.toBeNull();
		});

		it('keeps a board card that owns a runId even when the URL matches', () => {
			const deferredBoard: QueuedRun = { ...boardItem, runId: 'run-deferred' };
			renderSection(<QueuedRunsSection items={[deferredBoard]} />, [project], [runningBoardRun()]);
			expect(cards()).toHaveLength(1);
			expect(within(cards()[0]).getByRole('link', { name: 'View run' })).not.toBeNull();
		});

		it('keeps a non-board card and drops only the matching board card', () => {
			renderSection(
				<QueuedRunsSection items={[githubItem, boardItem]} />,
				[project],
				[runningBoardRun()],
			);
			expect(cards()).toHaveLength(1);
			expect(within(cards()[0]).getByText(/PR #42/)).not.toBeNull();
		});
	});

	// Issue #570: the server proved these board dispatches cannot become a run and
	// keeps them out of `items`, so the section's job is only to keep them
	// observable — a count that expands to the rows — without ever presenting them
	// as pending work.
	describe('board events that start no phase (issue #570)', () => {
		const noTriggerItem: QueuedRun = {
			...boardItem,
			jobId: 'job-no-trigger',
			state: 'prioritized',
			runsAt: undefined,
			boardOutcome: 'no-trigger',
			workItemTitle: "Phase 4/6: Run the control-plane host's worker",
			workItemUrl: 'https://github.com/SmartTechBrewery/swarm/issues/551',
		};

		it('reports them as a collapsed count, not as queued rows', () => {
			renderSection(<QueuedRunsSection items={[githubItem]} noTriggerItems={[noTriggerItem]} />);

			expect(cards()).toHaveLength(1);
			expect(within(cards()[0]).getByText(/PR #42/)).not.toBeNull();
			// The queue count covers the queue alone.
			expect(screen.getByText('(1)')).not.toBeNull();
			const group = screen.getByTestId('queued-no-trigger-group');
			expect(within(group).getByText('1 board event that starts no phase')).not.toBeNull();
			// Collapsed: the borrowed task title is not on screen until asked for.
			expect(screen.queryByTestId('queued-no-trigger-row')).toBeNull();
			expect(screen.queryByText(noTriggerItem.workItemTitle as string)).toBeNull();
		});

		it('expands to the underlying rows on click', () => {
			renderSection(<QueuedRunsSection items={[githubItem]} noTriggerItems={[noTriggerItem]} />);

			fireEvent.click(screen.getByRole('button', { name: /starts no phase/ }));

			const rows = screen.getAllByTestId('queued-no-trigger-row');
			expect(rows).toHaveLength(1);
			expect(within(rows[0]).getByText(noTriggerItem.workItemTitle as string)).not.toBeNull();
			expect(within(rows[0]).getByText('Issue: #551')).not.toBeNull();
			// Not pending work: no intervention offered on these rows.
			expect(within(rows[0]).queryByRole('button', { name: /Put back/i })).toBeNull();
		});

		it('stays visible when they are all that is left, so an accumulation cannot hide', () => {
			renderSection(
				<QueuedRunsSection
					items={[]}
					noTriggerItems={[noTriggerItem, { ...noTriggerItem, jobId: 'job-no-trigger-2' }]}
				/>,
			);

			expect(screen.queryByTestId('queued-run-card')).toBeNull();
			// No empty queue table/heading alongside it.
			expect(screen.queryByText('Task')).toBeNull();
			expect(screen.getByText('2 board events that start no phase')).not.toBeNull();
		});

		it('renders nothing at all when there is neither queued work nor such an event', () => {
			const { container } = renderSection(<QueuedRunsSection items={[]} noTriggerItems={[]} />);
			expect(container.firstChild).toBeNull();
		});
	});
});
