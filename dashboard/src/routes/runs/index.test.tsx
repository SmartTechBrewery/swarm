// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runsListQueryOptions, runsQueuedQueryOptions } = vi.hoisted(() => ({
	runsListQueryOptions: vi.fn(),
	runsQueuedQueryOptions: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		runs: {
			list: { queryOptions: runsListQueryOptions },
			queued: { queryOptions: runsQueuedQueryOptions },
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
