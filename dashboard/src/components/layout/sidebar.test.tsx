// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { navigate, pingQueryFn, projectsQueryFn } = vi.hoisted(() => ({
	navigate: vi.fn(),
	pingQueryFn: vi.fn(),
	projectsQueryFn: vi.fn(),
}));

// A `Link` renders as a plain anchor so its destination is assertable without a
// real router; the sidebar's own `useRouterState` selector just reads a pathname.
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		children,
		...rest
	}: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
		<a href={to} {...rest}>
			{children}
		</a>
	),
	useNavigate: () => navigate,
	useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
		select({ location: { pathname: '/projects' } }),
}));

vi.mock('@/lib/trpc.js', () => ({
	trpc: {
		ping: { ping: { queryOptions: () => ({ queryKey: ['ping'], queryFn: pingQueryFn }) } },
		projects: {
			list: { queryOptions: () => ({ queryKey: ['projects.list'], queryFn: projectsQueryFn }) },
		},
	},
}));

vi.mock('@/lib/auth.js', () => ({ logout: vi.fn() }));
vi.mock('@/lib/use-current-user.js', () => ({ useCurrentUser: vi.fn() }));
// The create dialog owns its own tRPC mutations and is not what these tests read.
vi.mock('@/components/projects/project-create-dialog.js', () => ({
	ProjectCreateDialog: () => null,
}));

import { useCurrentUser } from '@/lib/use-current-user.js';
import { Sidebar } from './sidebar.js';

function renderSidebar() {
	const { container } = render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<Sidebar />
		</QueryClientProvider>,
	);
	return container;
}

beforeEach(() => {
	pingQueryFn.mockResolvedValue({ ok: true });
	projectsQueryFn.mockResolvedValue([]);
	vi.mocked(useCurrentUser).mockReturnValue(
		// biome-ignore lint/suspicious/noExplicitAny: the sidebar reads only `data`.
		{ data: { id: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' } } as any,
	);
});

describe('Sidebar user block', () => {
	it('opens the profile from the name of the signed-in user (issue #659)', () => {
		renderSidebar();

		const link = screen.getByRole('link', { name: 'Ada Lovelace' });

		expect(link.getAttribute('href')).toBe('/profile');
		// The identifier stays the hover explanation it has always been.
		expect(link.getAttribute('title')).toBe('ada@example.com');
	});

	it('keeps Sign out beside the profile link', () => {
		renderSidebar();

		expect(screen.getByRole('button', { name: 'Sign out' })).toBeDefined();
	});

	it('keeps the account row out of the scrolling nav column (issue #665)', () => {
		const container = renderSidebar();

		// The sidebar is its own bounded, pinned column on desktop; without that the
		// column below has nothing to scroll within.
		expect(container.firstElementChild?.className).toContain('md:sticky');
		expect(container.firstElementChild?.className).toContain('md:h-screen');

		// The nav is what scrolls when the project list outgrows the viewport…
		const scroller = container.querySelector('.md\\:overflow-y-auto');
		expect(scroller?.querySelector('nav')).not.toBeNull();

		// …and the account controls sit outside it, so they cannot scroll away.
		expect(scroller?.contains(screen.getByRole('link', { name: 'Ada Lovelace' }))).toBe(false);
		expect(scroller?.contains(screen.getByRole('button', { name: 'Sign out' }))).toBe(false);
	});

	it('states the connection as a dot with no textual label (issue #665)', async () => {
		const container = renderSidebar();

		// Wait for the ping to resolve — a "Connected" label would have rendered by now.
		await waitFor(() => {
			expect(container.querySelector('[title="Connected"]')).not.toBeNull();
		});

		expect(screen.queryByText('Connected')).toBeNull();
		expect(screen.queryByText('Disconnected')).toBeNull();
		expect(screen.queryByText('Connecting…')).toBeNull();
	});
});
