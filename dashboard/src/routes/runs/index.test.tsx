// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runsListQueryOptions, runsQueuedQueryOptions, projectsListQueryFn } = vi.hoisted(() => ({
	runsListQueryOptions: vi.fn(),
	runsQueuedQueryOptions: vi.fn(),
	projectsListQueryFn: vi.fn(),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		runs: {
			list: { queryOptions: runsListQueryOptions },
			queued: { queryOptions: runsQueuedQueryOptions },
		},
		projects: {
			list: { queryOptions: () => ({ queryKey: ['projects.list'], queryFn: projectsListQueryFn }) },
		},
	},
	trpcClient: {},
}));
vi.mock('@/lib/use-current-user.js', () => ({ useCurrentUser: vi.fn() }));

import { useCurrentUser } from '@/lib/use-current-user.js';
import { RunsScreen, runsIndexRoute } from './index.js';

/** A react-query-shaped session result carrying just the `data` the gate reads. */
function signedInAs(instanceAdmin: boolean) {
	return {
		data: { id: '1', identifier: 'ada', displayName: 'Ada', instanceAdmin },
		// biome-ignore lint/suspicious/noExplicitAny: a partial query result is all the gate reads.
	} as any;
}

function renderScreen(ui: ReactElement) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	runsListQueryOptions.mockReset();
	runsQueuedQueryOptions.mockReset();
	projectsListQueryFn.mockReset();
	vi.mocked(useCurrentUser).mockReset();
});

describe('/runs route registration', () => {
	it('is mounted at /runs', () => {
		// `path` is only populated on the route object once a router initializes it,
		// so read the configured value straight off the options.
		expect((runsIndexRoute.options as { path?: string }).path).toBe('/runs');
	});

	it('mounts the gated screen, so a deep link with filters hits the same boundary', () => {
		// One component for every way in — a typed URL, a filtered deep link, an
		// in-app link — is what makes the boundary consistent (issue #647).
		expect((runsIndexRoute.options as { component?: unknown }).component).toBe(RunsScreen);
	});
});

describe('/runs is restricted to instance admins (issue #647)', () => {
	it('denies a non-admin and issues neither the runs nor the queue read', () => {
		vi.mocked(useCurrentUser).mockReturnValue(signedInAs(false));

		renderScreen(<RunsScreen />);

		expect(
			screen.getByText('This page is available to instance administrators only.'),
		).toBeDefined();
		expect(screen.queryByText('Runs History')).toBeNull();
		// The screen never mounted, so it never even built its query options.
		expect(runsListQueryOptions).not.toHaveBeenCalled();
		expect(runsQueuedQueryOptions).not.toHaveBeenCalled();
	});

	it('tells a denied non-admin where their runs are instead', () => {
		vi.mocked(useCurrentUser).mockReturnValue(signedInAs(false));

		renderScreen(<RunsScreen />);

		expect(screen.getByText(/installation-wide runs view/)).toBeDefined();
		expect(screen.getByText(/Open a project you are enrolled in/)).toBeDefined();
	});
});
