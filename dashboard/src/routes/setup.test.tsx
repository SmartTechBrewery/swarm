// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth.js', () => ({ completeSetup: vi.fn() }));
vi.mock('@/lib/use-current-user.js', () => ({ useCurrentUser: vi.fn() }));

import { completeSetup } from '@/lib/auth.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { SetupScreen } from './setup.js';

// biome-ignore lint/suspicious/noExplicitAny: a partial query result is enough for these branches.
const UNAUTHENTICATED = { data: undefined, isLoading: false } as any;
const RESOLVED_ADMIN = {
	data: { id: '1', identifier: 'ada@example.com', displayName: 'Ada', instanceAdmin: true },
	isLoading: false,
	// biome-ignore lint/suspicious/noExplicitAny: a partial query result is enough for these branches.
} as any;

// Render the real SetupScreen inside a minimal memory router + query client, as
// login.test.tsx does; only the network call is mocked.
function renderSetup(token: string | undefined) {
	const rootRoute = createRootRoute({ component: () => <Outlet /> });
	const setupRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: '/setup',
		component: () => <SetupScreen token={token} />,
	});
	const homeRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: '/',
		component: () => <div>home-screen</div>,
	});
	const loginRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: '/login',
		component: () => <div>login-screen</div>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([setupRoute, homeRoute, loginRoute]),
		history: createMemoryHistory({ initialEntries: ['/setup'] }),
	});
	render(
		<QueryClientProvider client={new QueryClient()}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
}

// Synchronous on purpose: the caller awaits a findBy/waitFor straight after the
// click, so the submit handler's async state updates land inside it.
function fillAndSubmit(password: string, confirm: string) {
	fireEvent.change(screen.getByLabelText(/e-mail/i), { target: { value: 'ada@example.com' } });
	fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: password } });
	fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: confirm } });
	fireEvent.click(screen.getByRole('button', { name: /create administrator/i }));
}

describe('SetupScreen', () => {
	beforeEach(() => {
		vi.mocked(completeSetup).mockReset();
		vi.mocked(useCurrentUser).mockReset().mockReturnValue(UNAUTHENTICATED);
	});

	it('explains where the link comes from when opened without a token', async () => {
		renderSetup(undefined);

		expect(await screen.findByText(/one-time setup link/i)).not.toBeNull();
		expect(screen.queryByLabelText(/e-mail/i)).toBeNull();
	});

	it('redirects a resolved user into the app', async () => {
		vi.mocked(useCurrentUser).mockReturnValue(RESOLVED_ADMIN);
		renderSetup('abc');

		expect(await screen.findByText('home-screen')).not.toBeNull();
		expect(completeSetup).not.toHaveBeenCalled();
	});

	it('refuses mismatched passwords without calling the server', async () => {
		renderSetup('abc');
		await screen.findByLabelText(/e-mail/i);
		fillAndSubmit('hunter2', 'hunter3');

		expect((await screen.findByRole('alert')).textContent).toContain('do not match');
		expect(completeSetup).not.toHaveBeenCalled();
	});

	it('submits the token and credentials and enters the app on success', async () => {
		vi.mocked(completeSetup).mockResolvedValue({ ok: true });
		renderSetup('abc');
		await screen.findByLabelText(/e-mail/i);
		fillAndSubmit('hunter2', 'hunter2');

		await waitFor(() =>
			expect(completeSetup).toHaveBeenCalledWith('abc', 'ada@example.com', 'hunter2'),
		);
		expect(await screen.findByText('home-screen')).not.toBeNull();
	});

	it('shows the server error and offers sign-in when already set up', async () => {
		vi.mocked(completeSetup).mockResolvedValue({
			ok: false,
			error: 'This installation already has a user. Sign in instead.',
			alreadySetUp: true,
		});
		renderSetup('abc');
		await screen.findByLabelText(/e-mail/i);
		fillAndSubmit('hunter2', 'hunter2');

		const alert = await screen.findByRole('alert');
		expect(alert.textContent).toContain('already has a user');
		expect(screen.getByRole('link', { name: /go to sign in/i })).not.toBeNull();
	});
});
