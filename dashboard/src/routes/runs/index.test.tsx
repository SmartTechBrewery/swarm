// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runsListQueryOptions, runsQueuedQueryOptions, runsStalledQueryOptions, stalledQueryFn } =
	vi.hoisted(() => ({
		runsListQueryOptions: vi.fn(),
		runsQueuedQueryOptions: vi.fn(),
		runsStalledQueryOptions: vi.fn(),
		stalledQueryFn: vi.fn(),
	}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		runs: {
			list: { queryOptions: runsListQueryOptions },
			queued: { queryOptions: runsQueuedQueryOptions },
			stalled: { queryOptions: runsStalledQueryOptions },
		},
	},
	trpcClient: {},
}));
vi.mock('@/lib/use-current-user.js', () => ({ useCurrentUser: vi.fn() }));
// The screen's own decisions are what this file covers, so its children are
// stubbed: each of them issues tRPC reads of its own (the Queued section reads
// `runs.list` for the running runs it annotates), which would otherwise be
// indistinguishable here from the reads the route itself issues.
vi.mock('@/components/runs/run-filters.js', () => ({ RunFilters: () => <div>filters</div> }));
vi.mock('@/components/runs/queued-runs-section.js', () => ({
	QueuedRunsSection: () => <div>queued section</div>,
}));
vi.mock('@/components/runs/stalled-items-section.js', () => ({
	StalledItemsSection: () => <div>stalled section</div>,
}));
vi.mock('@/components/runs/runs-table.js', () => ({ RunsTable: () => <div>runs table</div> }));
vi.mock('@/components/runs/empty-runs-state.js', () => ({
	EmptyRunsState: () => <div>no runs</div>,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@tanstack/react-router')>();
	return { ...actual, useNavigate: () => vi.fn() };
});

import { useCurrentUser } from '@/lib/use-current-user.js';
import { RunsRouteComponent, runsIndexRoute } from './index.js';

/** A react-query-shaped session result carrying just the `data` the screen reads. */
function signedInAs(instanceAdmin: boolean) {
	return {
		data: { id: '1', identifier: 'ada', displayName: 'Ada', instanceAdmin },
		// biome-ignore lint/suspicious/noExplicitAny: a partial query result is all the screen reads.
	} as any;
}

function renderScreen(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	runsListQueryOptions.mockReset();
	runsListQueryOptions.mockReturnValue({ queryKey: ['runs.list'], queryFn: async () => null });
	runsQueuedQueryOptions.mockReset();
	runsQueuedQueryOptions.mockReturnValue({ queryKey: ['runs.queued'], queryFn: async () => null });
	runsStalledQueryOptions.mockReset();
	stalledQueryFn.mockReset();
	stalledQueryFn.mockResolvedValue([]);
	runsStalledQueryOptions.mockReturnValue({ queryKey: ['runs.stalled'], queryFn: stalledQueryFn });
	vi.mocked(useCurrentUser).mockReset();
	// The route's search params come from the router the screen is mounted in;
	// these tests render the screen directly, so the read is stubbed.
	vi.spyOn(runsIndexRoute, 'useSearch').mockReturnValue({} as never);
});

describe('/runs route registration', () => {
	it('is mounted at /runs', () => {
		// `path` is only populated on the route object once a router initializes it,
		// so read the configured value straight off the options.
		expect((runsIndexRoute.options as { path?: string }).path).toBe('/runs');
	});

	it('mounts the screen itself, with no instance-admin gate in front of it', () => {
		// The route stopped rendering behind `InstanceAdminOnly` with issue #821 —
		// the list is bounded per reader server-side instead.
		expect((runsIndexRoute.options as { component?: unknown }).component).toBe(RunsRouteComponent);
	});
});

describe('/runs is open to every signed-in user (issue #821)', () => {
	it('renders the runs history for a non-admin and issues the list read', () => {
		vi.mocked(useCurrentUser).mockReturnValue(signedInAs(false));

		renderScreen(<RunsRouteComponent />);

		expect(screen.getByText('Runs History')).toBeDefined();
		expect(runsListQueryOptions).toHaveBeenCalled();
	});

	// `runs.queued` deliberately stayed instance-admin-only, so a member must not
	// render a section whose read they would only ever be denied.
	it('leaves the unscoped queue section to an instance admin', () => {
		vi.mocked(useCurrentUser).mockReturnValue(signedInAs(false));

		renderScreen(<RunsRouteComponent />);

		expect(screen.queryByText('queued section')).toBeNull();
	});

	it('still shows an instance admin the queue section', () => {
		vi.mocked(useCurrentUser).mockReturnValue(signedInAs(true));

		renderScreen(<RunsRouteComponent />);

		expect(screen.getByText('queued section')).toBeDefined();
	});

	// Once a project is chosen the queue read is project-scoped, which any member
	// of that project may make — so the section comes back for them too.
	it('shows a non-admin the queue section once they filter to a project', () => {
		vi.mocked(useCurrentUser).mockReturnValue(signedInAs(false));
		vi.mocked(runsIndexRoute.useSearch).mockReturnValue({ projectId: 'p1' } as never);

		renderScreen(<RunsRouteComponent />);

		expect(screen.getByText('queued section')).toBeDefined();
	});
});

// `runs.stalled` copied `runs.queued`'s authorization verbatim (issue #847), so
// the unscoped read is instance-admin-only and must not be issued by a member who
// has chosen no project — the section itself is always mounted, since it renders
// nothing at all when there is nothing stalled.
describe('the Stalled section (issue #847)', () => {
	it('does not issue the unscoped stalled read for a non-admin with no project chosen', () => {
		vi.mocked(useCurrentUser).mockReturnValue(signedInAs(false));

		renderScreen(<RunsRouteComponent />);

		expect(screen.getByText('stalled section')).toBeDefined();
		expect(stalledQueryFn).not.toHaveBeenCalled();
	});

	it('issues the unscoped stalled read for an instance admin', () => {
		vi.mocked(useCurrentUser).mockReturnValue(signedInAs(true));

		renderScreen(<RunsRouteComponent />);

		expect(stalledQueryFn).toHaveBeenCalled();
	});

	it('issues the project-scoped stalled read once a non-admin filters to a project', () => {
		vi.mocked(useCurrentUser).mockReturnValue(signedInAs(false));
		vi.mocked(runsIndexRoute.useSearch).mockReturnValue({ projectId: 'p1' } as never);

		renderScreen(<RunsRouteComponent />);

		expect(runsStalledQueryOptions).toHaveBeenCalledWith({ projectId: 'p1' });
		expect(stalledQueryFn).toHaveBeenCalled();
	});
});
