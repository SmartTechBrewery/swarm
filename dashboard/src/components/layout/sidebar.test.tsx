// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
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
	render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<Sidebar />
		</QueryClientProvider>,
	);
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
});
