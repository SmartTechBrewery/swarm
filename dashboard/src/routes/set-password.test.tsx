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

vi.mock('@/lib/auth.js', () => ({ redeemPasswordLink: vi.fn() }));
vi.mock('@/lib/use-current-user.js', () => ({ useCurrentUser: vi.fn() }));

import { redeemPasswordLink } from '@/lib/auth.js';
import { trpc } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { SetPasswordScreen } from './set-password.js';

const RESOLVED_ADMIN = {
	data: { id: '1', identifier: 'ada@example.com', displayName: 'Ada', instanceAdmin: true },
	isLoading: false,
	// biome-ignore lint/suspicious/noExplicitAny: a partial query result is enough for these branches.
} as any;

// Render the real SetPasswordScreen inside a minimal memory router + query client,
// as setup.test.tsx does; only the network call is mocked.
function renderSetPassword(token: string | undefined) {
	const rootRoute = createRootRoute({ component: () => <Outlet /> });
	const setPasswordRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: '/set-password',
		component: () => <SetPasswordScreen token={token} />,
	});
	const homeRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: '/',
		component: () => <div>home-screen</div>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([setPasswordRoute, homeRoute]),
		history: createMemoryHistory({ initialEntries: ['/set-password'] }),
	});
	const queryClient = new QueryClient();
	const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
	render(
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>,
	);
	return { invalidate };
}

// Synchronous on purpose: the caller awaits a findBy/waitFor straight after the
// click, so the submit handler's async state updates land inside it.
function fillAndSubmit(password: string, confirm: string) {
	fireEvent.change(screen.getByLabelText(/new password/i), { target: { value: password } });
	fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: confirm } });
	fireEvent.click(screen.getByRole('button', { name: /set password/i }));
}

describe('SetPasswordScreen', () => {
	beforeEach(() => {
		vi.mocked(redeemPasswordLink).mockReset();
		vi.mocked(useCurrentUser)
			.mockReset()
			// biome-ignore lint/suspicious/noExplicitAny: a partial query result is enough here.
			.mockReturnValue({ data: undefined, isLoading: false } as any);
	});

	it('explains where the link comes from when opened without a token', async () => {
		renderSetPassword(undefined);

		expect(await screen.findByText(/password link an installation administrator/i)).not.toBeNull();
		expect(screen.queryByLabelText(/new password/i)).toBeNull();
	});

	it('refuses mismatched passwords without calling the server', async () => {
		renderSetPassword('abc');
		await screen.findByLabelText(/new password/i);
		fillAndSubmit('hunter2', 'hunter3');

		expect((await screen.findByRole('alert')).textContent).toContain('do not match');
		expect(redeemPasswordLink).not.toHaveBeenCalled();
	});

	it('shows the ask-for-a-new-link copy when the link is refused', async () => {
		vi.mocked(redeemPasswordLink).mockResolvedValue({
			ok: false,
			error:
				'This link is invalid, expired, or already used. Ask an installation administrator for a new one.',
		});
		renderSetPassword('abc');
		await screen.findByLabelText(/new password/i);
		fillAndSubmit('hunter2', 'hunter2');

		expect((await screen.findByRole('alert')).textContent).toContain(
			'Ask an installation administrator for a new one',
		);
	});

	it('redeems the link, refreshes the session and enters the app on success', async () => {
		vi.mocked(redeemPasswordLink).mockResolvedValue({ ok: true });
		const { invalidate } = renderSetPassword('abc');
		await screen.findByLabelText(/new password/i);
		fillAndSubmit('hunter2', 'hunter2');

		await waitFor(() => expect(redeemPasswordLink).toHaveBeenCalledWith('abc', 'hunter2'));
		expect(await screen.findByText('home-screen')).not.toBeNull();
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: trpc.auth.me.queryOptions().queryKey,
		});
	});

	// Unlike /setup: the link is the action, so a signed-in viewer is not sent away.
	it('still shows the form to a signed-in viewer', async () => {
		vi.mocked(useCurrentUser).mockReturnValue(RESOLVED_ADMIN);
		renderSetPassword('abc');

		expect(await screen.findByLabelText(/new password/i)).not.toBeNull();
		expect(screen.queryByText('home-screen')).toBeNull();
	});
});
