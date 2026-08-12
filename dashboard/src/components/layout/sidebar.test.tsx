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

	it('leads the profile link with a profile icon, not the connection checkmark (issue #680)', async () => {
		renderSidebar();

		const link = screen.getByRole('link', { name: 'Ada Lovelace' });
		const icon = link.querySelector('svg');

		expect(icon?.getAttribute('class')).toContain('lucide-user');
		// Decorative: the visible name, not the icon, names the link.
		expect(icon?.getAttribute('aria-hidden')).toBe('true');

		// The connection status keeps its own icon, but no longer in front of the
		// name where it read as the account entry's leading checkmark.
		const status = await screen.findByRole('status', { name: 'Connected' });
		expect(link.contains(status)).toBe(false);
		expect(link.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

	it('states the connection as an accessible status with no textual label (issue #665)', async () => {
		renderSidebar();

		// The status is exposed to assistive tech via role + accessible name, not
		// by requiring a hover/focus to read a bare `title`.
		const status = await screen.findByRole('status', { name: 'Connected' });
		expect(status.querySelector('svg')?.getAttribute('class')).toContain('lucide-circle-check');

		expect(screen.queryByText('Connected')).toBeNull();
		expect(screen.queryByText('Disconnected')).toBeNull();
		expect(screen.queryByText('Connecting…')).toBeNull();
	});

	it('gives the disconnected state its own icon shape, not just a color change', async () => {
		pingQueryFn.mockRejectedValue(new Error('unreachable'));

		renderSidebar();

		const status = await screen.findByRole('status', { name: 'Disconnected' });
		const icon = status.querySelector('svg');
		expect(icon?.getAttribute('class')).toContain('lucide-circle-x');
		expect(icon?.getAttribute('class')).not.toContain('lucide-circle-check');
	});

	it('gives the pending/connecting state its own icon shape while the ping is in flight', () => {
		// Never resolves, so the query stays in its initial (pending) state.
		pingQueryFn.mockReturnValue(new Promise(() => {}));

		renderSidebar();

		const status = screen.getByRole('status', { name: 'Connecting…' });
		const icon = status.querySelector('svg');
		expect(icon?.getAttribute('class')).toContain('lucide-circle-dashed');
	});
});
